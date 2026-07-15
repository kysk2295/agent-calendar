import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginWithPassword, signUpWithPassword, startProviderLogin, type AuthProvider } from './auth.js';
import { createApiProxyServer, isTrustedProxyRendererUrl } from './proxy.js';
import { migrateLegacyUserDataFiles, publicSettings, readSettings, saveSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Agent Calendar';
const WIDGET_APP_GROUP_ID = 'group.com.agents.calendar';
const WIDGET_SNAPSHOT_FILE = 'HermesWidgetSnapshot.json';
const WIDGET_ACTIONS_FILE = 'HermesWidgetActions.json';

class UntrustedProxyRendererError extends Error {
  constructor() {
    super('Untrusted renderer cannot access the Agent Calendar API proxy');
    this.name = 'UntrustedProxyRendererError';
  }
}

let mainWindow: BrowserWindow | null = null;
let widgetOverlayWindow: BrowserWindow | null = null;
let proxyBaseUrl = '';
const proxyCredential = randomBytes(32).toString('base64url');
let widgetActionPoller: NodeJS.Timeout | null = null;

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), process.env.AGENT_CALENDAR_USER_DATA_NAME || APP_NAME));

function loadLocalRuntimeEnv() {
  const loaded = new Set<string>();
  const candidateDirs = Array.from(new Set([
    app.getPath('userData'),
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../../..'),
    app.getAppPath(),
    path.join(app.getAppPath(), 'apps', 'desktop'),
  ]));
  for (const dir of candidateDirs) {
    for (const filename of ['.env.local', '.env']) {
      try {
        const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
        raw.split(/\r?\n/g).forEach((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return;
          const separator = trimmed.indexOf('=');
          if (separator < 1) return;
          const key = trimmed.slice(0, separator).trim();
          const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
          if (key && value && !process.env[key]) {
            process.env[key] = value;
            loaded.add(key);
          }
        });
      } catch {
        // Local env files are optional runtime configuration.
      }
    }
  }
  return [...loaded].sort();
}

function logLifecycle(message: string, details: Record<string, unknown> = {}) {
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'main.log'),
      `${new Date().toISOString()} ${message} ${JSON.stringify(details)}\n`,
      'utf8',
    );
  } catch {
    // Logging must never make the desktop app less stable.
  }
}

process.on('uncaughtException', (error) => {
  logLifecycle('uncaughtException', { message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logLifecycle('unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason) });
});

function appIconPath() {
  if (process.env.VITE_DEV_SERVER_URL) return path.join(process.cwd(), 'public', 'agent-calendar-logo.png');
  return path.join(__dirname, '..', 'dist', 'agent-calendar-logo.png');
}

function packagedRendererIndexPath() {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

async function startProxy() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const server = createApiProxyServer({
    allowedDevOrigin: devServerUrl ? new URL(devServerUrl).origin : undefined,
    credential: proxyCredential,
    getSettings: readSettings,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start Agent Calendar API proxy');
  proxyBaseUrl = `http://127.0.0.1:${address.port}`;
  logLifecycle('proxy-started', { proxyBaseUrl });
}

function shouldCreateWidgetOverlay() {
  return process.env.HERMES_WIDGET_OVERLAY === '1';
}

function createWindow() {
  logLifecycle('create-window');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 824,
    minWidth: 980,
    minHeight: 700,
    title: 'Agent Calendar',
    icon: appIconPath(),
    backgroundColor: '#EAE5DA',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    logLifecycle('main-window-closed');
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLifecycle('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.reload();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logLifecycle('did-fail-load', { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (/401|unauthorized|failed|error/i.test(message)) {
      logLifecycle('renderer-console', { level, message, line, sourceId });
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(packagedRendererIndexPath());
  }
  startWidgetActionBridge();
  if (shouldCreateWidgetOverlay()) createWidgetOverlayWindow();
}

function overlayUrl(devServerUrl: string) {
  const url = new URL(devServerUrl);
  url.searchParams.set('overlay', 'widgets');
  return url.toString();
}

function widgetOverlayBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(760, Math.max(520, workArea.width - 48));
  const height = Math.min(372, Math.max(300, workArea.height - 48));
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
  };
}

function createWidgetOverlayWindow() {
  if (widgetOverlayWindow && !widgetOverlayWindow.isDestroyed()) return;
  const bounds = widgetOverlayBounds();
  widgetOverlayWindow = new BrowserWindow({
    ...bounds,
    title: 'Agent Calendar Widgets Overlay',
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    trafficLightPosition: { x: 0, y: 0 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  widgetOverlayWindow.setAlwaysOnTop(true, 'floating');
  widgetOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  widgetOverlayWindow.once('ready-to-show', () => {
    widgetOverlayWindow?.showInactive();
  });
  widgetOverlayWindow.on('closed', () => {
    widgetOverlayWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void widgetOverlayWindow.loadURL(overlayUrl(devServerUrl));
  } else {
    void widgetOverlayWindow.loadFile(packagedRendererIndexPath(), { query: { overlay: 'widgets' } });
  }
}

function widgetGroupDir() {
  return path.join(os.homedir(), 'Library', 'Group Containers', WIDGET_APP_GROUP_ID);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readWidgetActions() {
  const actionsPath = path.join(widgetGroupDir(), WIDGET_ACTIONS_FILE);
  const raw = await readFile(actionsPath, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw || '[]') as unknown;
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

function startWidgetActionBridge() {
  if (widgetActionPoller) return;
  widgetActionPoller = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const actions = await readWidgetActions().catch(() => []);
    if (actions.length > 0) mainWindow.webContents.send('widget:actions-available');
  }, 1000);
}

ipcMain.handle('settings:get', () => publicSettings(readSettings()));
ipcMain.handle('settings:save', (_event, settings: unknown) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return publicSettings(readSettings());
  return publicSettings(saveSettings(settings));
});
ipcMain.handle('auth:provider-login', async (_event, provider: unknown) => {
  if (provider !== 'google') throw new Error('지원하지 않는 로그인 제공자입니다.');
  const profile = await startProviderLogin(provider as AuthProvider);
  return publicSettings(saveSettings({ auth: profile }));
});
ipcMain.handle('auth:password-signup', async (_event, payload: unknown) => {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const profile = await signUpWithPassword(body.email, body.password);
  return publicSettings(saveSettings({ auth: profile }));
});
ipcMain.handle('auth:password-login', async (_event, payload: unknown) => {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const profile = await loginWithPassword(body.email, body.password);
  return publicSettings(saveSettings({ auth: profile }));
});
ipcMain.handle('auth:logout', () => publicSettings(saveSettings({ auth: null })));
ipcMain.handle('hermes:get-connection', (event) => {
  const senderFrame = event.senderFrame;
  if (!senderFrame) throw new UntrustedProxyRendererError();
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const trusted = isTrustedProxyRendererUrl(senderFrame.url, {
    allowedDevOrigin: devServerUrl ? new URL(devServerUrl).origin : undefined,
    packagedIndexPath: packagedRendererIndexPath(),
  });
  if (!trusted) throw new UntrustedProxyRendererError();
  return { baseUrl: proxyBaseUrl, credential: proxyCredential };
});
ipcMain.handle('widget:snapshot-save', async (_event, snapshot: unknown) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Invalid Agent Calendar widget snapshot');
  }
  const groupDir = widgetGroupDir();
  await mkdir(groupDir, { recursive: true });
  const snapshotPath = path.join(groupDir, WIDGET_SNAPSHOT_FILE);
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  const previous = await readFile(snapshotPath, 'utf8').catch(() => '');
  if (previous !== body) await writeFile(snapshotPath, body, 'utf8');
  return { ok: true, path: snapshotPath, changed: previous !== body };
});
ipcMain.handle('widget:actions-read', async () => readWidgetActions());
ipcMain.handle('widget:actions-clear', async (_event, ids: unknown) => {
  if (!Array.isArray(ids)) return { ok: false, cleared: 0 };
  const idSet = new Set(ids.map((id) => String(id)).filter(Boolean));
  const groupDir = widgetGroupDir();
  await mkdir(groupDir, { recursive: true });
  const actionsPath = path.join(groupDir, WIDGET_ACTIONS_FILE);
  const actions = await readWidgetActions();
  const remaining = actions.filter((action) => !idSet.has(String(action.id || '')));
  await writeFile(actionsPath, `${JSON.stringify(remaining, null, 2)}\n`, 'utf8');
  return { ok: true, cleared: actions.length - remaining.length };
});

app.whenReady().then(async () => {
  migrateLegacyUserDataFiles(path.join(app.getPath('appData'), 'agents-calendar-desktop'), app.getPath('userData'));
  logLifecycle('app-ready', { userData: app.getPath('userData') });
  const loadedEnvKeys = loadLocalRuntimeEnv();
  if (loadedEnvKeys.length) logLifecycle('runtime-env-loaded', { keys: loadedEnvKeys });
  await startProxy();
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath());
  createWindow();
  app.on('activate', () => {
    logLifecycle('activate', { windowCount: BrowserWindow.getAllWindows().length });
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  logLifecycle('window-all-closed', { platform: process.platform });
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  logLifecycle('before-quit');
});

app.on('will-quit', () => {
  logLifecycle('will-quit');
});
