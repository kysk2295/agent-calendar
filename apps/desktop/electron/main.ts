import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, screen, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopAuthKitLogin } from './auth.js';
import { createDesktopGoogleCalendarOAuth } from './calendarOAuth.js';
import {
  createDesktopCrashRecoveryController,
  type RendererGoneDetails,
} from './desktopCrashRecovery.js';
import {
  createDesktopReleaseManager,
  type DesktopReleaseStatus,
  type DesktopUpdaterAdapter,
} from './desktopRelease.js';
import { DesktopReleaseFixtureUpdater } from './desktopReleaseFixture.js';
import { createAgentCalendarDeepLinkMain } from './deepLinkMain.js';
import { createApiProxyServer, isTrustedProxyRendererUrl } from './proxy.js';
import {
  installTrustedRendererNavigationGuard,
  registerTrustedIpcHandle,
  type TrustedRendererIpcAuthorizer,
} from './rendererTrust.js';
import {
  createSecureSessionManager,
  scrubLegacyPlaintextAuthSettings,
  type AppSessionTokens,
} from './secureSession.js';
import {
  migrateLegacyUserDataFiles,
  publicSettings,
  readSettings,
  saveSettings,
  settingsFilePath,
  type DesktopAuthProfile,
} from './settings.js';
import { createWorkspaceSnapshotStore } from './workspaceSnapshot.js';
import { createWorkspaceSnapshotWriteGate } from './workspaceSnapshotWriteGate.js';
import { createQaTestSecureStorage } from './qaTestSecureStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
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
let releaseInitialCheckTimer: NodeJS.Timeout | null = null;
let releasePeriodicCheckTimer: NodeJS.Timeout | null = null;

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), process.env.AGENT_CALENDAR_USER_DATA_NAME || APP_NAME));

// Single instance so second-instance can deliver auth/session deep links.
const allowMultipleTestInstances = process.env.AGENT_CALENDAR_E2E_AUTH === '1'
  && process.env.AGENT_CALENDAR_E2E_ALLOW_MULTIPLE_INSTANCES === '1';
const gotLock = allowMultipleTestInstances || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const secureStorage = createQaTestSecureStorage({ nativeStorage: safeStorage });
const workspaceSnapshotStore = createWorkspaceSnapshotStore({ storage: secureStorage.storage });
const workspaceSnapshotWriteGate = createWorkspaceSnapshotWriteGate();
const desktopCrashRecovery = createDesktopCrashRecoveryController();
const e2eReleaseMode = process.env.AGENT_CALENDAR_E2E_RELEASE === '1';
const desktopUpdater: DesktopUpdaterAdapter = e2eReleaseMode
  ? new DesktopReleaseFixtureUpdater()
  : autoUpdater;
const desktopPackageVersion = (() => {
  if (app.isPackaged) return app.getVersion();
  try {
    const packageDocument = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof packageDocument.version === 'string' ? packageDocument.version : app.getVersion();
  } catch {
    return app.getVersion();
  }
})();
const desktopReleaseManager = createDesktopReleaseManager({
  updater: desktopUpdater,
  currentVersion: desktopPackageVersion,
  supported: app.isPackaged || e2eReleaseMode,
  onStatus: (status) => publishDesktopReleaseStatus(status),
});
const sessionManager = createSecureSessionManager({
  storage: secureStorage.storage,
  apiBaseUrl: () => readSettings().apiBaseUrl,
  onCleared: () => {
    workspaceSnapshotWriteGate.reset();
    workspaceSnapshotStore.clear();
  },
});

const e2eAuthMode = process.env.AGENT_CALENDAR_E2E_AUTH === '1';
const liveKeychainReceiptMode = process.env.AGENT_CALENDAR_LIVE_KEYCHAIN_RECEIPT === '1';
const authKitLogin = createDesktopAuthKitLogin({
  apiBaseUrl: () => readSettings().apiBaseUrl,
  sessionManager,
  openExternal: e2eAuthMode
    ? async () => undefined
    : (url) => shell.openExternal(url).then(() => undefined),
});
const googleCalendarOAuth = createDesktopGoogleCalendarOAuth({
  apiBaseUrl: () => readSettings().apiBaseUrl,
  getAccessToken: () => sessionManager.getAccessToken(),
  openExternal: e2eAuthMode
    ? async () => undefined
    : (url) => shell.openExternal(url).then(() => undefined),
});

function profileFromSession(session: AppSessionTokens): DesktopAuthProfile {
  return {
    provider: 'authkit',
    id: session.userId,
    email: session.user?.email || session.userId,
    name: session.user?.displayName || session.user?.email || 'Agent Calendar',
    expiresAt: session.accessExpiresAt,
    updatedAt: session.updatedAt,
    workspaceId: session.workspaceId,
    role: session.role,
  };
}

function publishSettings() {
  const status = sessionManager.getPublicStatus();
  const settings = readSettings();
  return publicSettings(settings, status);
}

function notifyAuthChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:session-changed', publishSettings());
  }
}

function publishDesktopReleaseStatus(status: DesktopReleaseStatus) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-release:status', status);
  }
}

function isTrustedRendererUrl(url: string) {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  return isTrustedProxyRendererUrl(url, {
    allowedDevOrigin: devServerUrl ? new URL(devServerUrl).origin : undefined,
    packagedIndexPath: packagedRendererIndexPath(),
  });
}

const requireTrustedRenderer: TrustedRendererIpcAuthorizer = (event) => {
  const senderFrame = event.senderFrame;
  if (!senderFrame) throw new UntrustedProxyRendererError();
  if (!isTrustedRendererUrl(senderFrame.url)) throw new UntrustedProxyRendererError();
};

async function handleAuthCallbackDeepLink(target: { kind: 'auth-callback'; code: string; state: string }) {
  try {
    const session = await authKitLogin.handleAuthDeepLink(target);
    saveSettings({ auth: profileFromSession(session) });
    notifyAuthChanged();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return { ok: true as const, workspaceId: session.workspaceId };
  } catch (error) {
    logLifecycle('auth-callback-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:login-error', {
        message: error instanceof Error ? error.message : String(error),
      });
      mainWindow.show();
      mainWindow.focus();
    }
    throw error;
  }
}

async function handleGoogleCalendarCallbackDeepLink(target: {
  kind: 'google-calendar-callback';
  code: string;
  state: string;
}) {
  try {
    const result = await googleCalendarOAuth.handleCallback(target);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return result;
  } catch (error) {
    logLifecycle('google-calendar-callback-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    throw error;
  }
}

const deepLinks = createAgentCalendarDeepLinkMain(process.argv, {
  authorizeRenderer: requireTrustedRenderer,
  onAuthCallback: (target) => handleAuthCallbackDeepLink(target),
  onGoogleCalendarCallback: (target) => handleGoogleCalendarCallbackDeepLink(target),
});

if (e2eAuthMode) {
  // Test harness only: allow Playwright to simulate open-url / second-instance callbacks.
  (globalThis as { __agentCalendarE2E?: {
    receiveAuthUrl: (url: string) => Promise<unknown> | unknown;
    simulateRendererGone: (details?: RendererGoneDetails) => unknown;
    getSecureStorageReceipt: () => unknown;
  } }).__agentCalendarE2E = {
    receiveAuthUrl: (url: string) => deepLinks.receiveRawUrl(url),
    getSecureStorageReceipt: () => secureStorage.getReceipt(),
    simulateRendererGone: (details = { reason: 'crashed', exitCode: 1 }) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('Desktop window is unavailable');
      }
      return handleRendererGone(mainWindow, details);
    },
  };
}

if (liveKeychainReceiptMode) {
  (globalThis as { __agentCalendarLiveKeychain?: {
    getSecureStorageReceipt: () => unknown;
    saveFixture: () => { sessionId: string; workspaceId: string; snapshotSaved: boolean };
  } }).__agentCalendarLiveKeychain = {
    getSecureStorageReceipt: () => secureStorage.getReceipt(),
    saveFixture: () => {
      const session = sessionManager.save({
        accessToken: 'live-keychain-fixture-access',
        refreshToken: 'live-keychain-fixture-refresh',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
        refreshExpiresAt: '2099-01-02T00:00:00.000Z',
        sessionId: 'live-keychain-fixture-session',
        userId: 'live-keychain-fixture-user',
        workspaceId: 'live-keychain-fixture-workspace',
        role: 'owner',
        user: { id: 'live-keychain-fixture-user', email: null, displayName: 'Live Keychain Fixture' },
        updatedAt: '2026-07-26T00:00:00.000Z',
      });
      workspaceSnapshotStore.save({
        userId: session.userId,
        workspaceId: session.workspaceId,
      }, {
        privateTitle: 'Live Keychain Workspace Snapshot',
      });
      return {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        snapshotSaved: true,
      };
    },
  };
}

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

function packagedCrashRecoveryPath() {
  return path.join(__dirname, '..', 'dist', 'crash-recovery.html');
}

function syncNativeTheme() {
  nativeTheme.themeSource = readSettings().theme === 'dark' ? 'dark' : 'light';
}

function scheduleDesktopReleaseChecks() {
  if (!desktopReleaseManager.getStatus().supported || e2eReleaseMode || releaseInitialCheckTimer) return;
  const check = () => {
    void desktopReleaseManager.check().catch(() => {
      logLifecycle('desktop-release-check-failed');
    });
  };
  releaseInitialCheckTimer = setTimeout(check, 30_000);
  releasePeriodicCheckTimer = setInterval(check, 6 * 60 * 60_000);
}

function handleRendererGone(desktopWindow: BrowserWindow, details: RendererGoneDetails) {
  logLifecycle('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
  const decision = desktopCrashRecovery.record(details);
  if (decision.action === 'ignore' || desktopWindow.isDestroyed()) return decision;
  if (decision.action === 'reload') {
    void desktopWindow.reload();
    return decision;
  }
  const darkRecovery = readSettings().theme === 'dark';
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    const recoveryUrl = new URL('/crash-recovery.html', devServerUrl);
    if (darkRecovery) recoveryUrl.hash = 'dark';
    void desktopWindow.loadURL(recoveryUrl.toString());
  } else {
    void desktopWindow.loadFile(
      packagedCrashRecoveryPath(),
      darkRecovery ? { hash: 'dark' } : undefined,
    );
  }
  return decision;
}

async function startProxy() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const server = createApiProxyServer({
    allowedDevOrigin: devServerUrl ? new URL(devServerUrl).origin : undefined,
    credential: proxyCredential,
    getSettings: () => {
      const settings = readSettings();
      return { apiBaseUrl: settings.apiBaseUrl };
    },
    getAccessToken: () => sessionManager.getAccessToken(),
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
  syncNativeTheme();
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
  deepLinks.attachWindow(mainWindow);
  installTrustedRendererNavigationGuard(mainWindow.webContents, isTrustedRendererUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const desktopWindow = mainWindow;
  desktopWindow.webContents.on('did-finish-load', () => {
    desktopWindow.webContents.setZoomFactor(1);
  });

  mainWindow.on('closed', () => {
    logLifecycle('main-window-closed');
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    handleRendererGone(desktopWindow, details);
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
  scheduleDesktopReleaseChecks();
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
  installTrustedRendererNavigationGuard(widgetOverlayWindow.webContents, isTrustedRendererUrl);
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

registerTrustedIpcHandle(ipcMain, 'settings:get', requireTrustedRenderer, () => publishSettings());
registerTrustedIpcHandle(ipcMain, 'settings:save', requireTrustedRenderer, (_event, settings: unknown) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return publishSettings();
  // Strip any attempt to write apiToken / secrets from renderer.
  const body = { ...(settings as Record<string, unknown>) };
  delete body.apiToken;
  delete body.accessToken;
  delete body.refreshToken;
  saveSettings(body);
  syncNativeTheme();
  return publishSettings();
});
registerTrustedIpcHandle(ipcMain, 'auth:authkit-login', requireTrustedRenderer, async () => {
  const session = await authKitLogin.beginAuthKitLogin();
  saveSettings({ auth: profileFromSession(session) });
  return publishSettings();
});
registerTrustedIpcHandle(ipcMain, 'calendar:google-connect', requireTrustedRenderer, () => googleCalendarOAuth.begin());
// Legacy IPC names: disabled for production (AuthKit only).
registerTrustedIpcHandle(ipcMain, 'auth:provider-login', requireTrustedRenderer, async () => {
  throw new Error('직접 Google OAuth는 비활성화되었습니다. AuthKit으로 로그인하세요.');
});
registerTrustedIpcHandle(ipcMain, 'auth:password-signup', requireTrustedRenderer, async () => {
  throw new Error('로컬 비밀번호 가입은 비활성화되었습니다. AuthKit으로 로그인하세요.');
});
registerTrustedIpcHandle(ipcMain, 'auth:password-login', requireTrustedRenderer, async () => {
  throw new Error('로컬 비밀번호 로그인은 비활성화되었습니다. AuthKit으로 로그인하세요.');
});
registerTrustedIpcHandle(ipcMain, 'auth:logout', requireTrustedRenderer, async () => {
  googleCalendarOAuth.cancel('로그아웃되어 Google Calendar 연결이 취소되었습니다.');
  await sessionManager.logoutRemote();
  saveSettings({ auth: null });
  return publishSettings();
});
registerTrustedIpcHandle(ipcMain, 'auth:session-status', requireTrustedRenderer, () => sessionManager.getPublicStatus());
registerTrustedIpcHandle(ipcMain, 'hermes:get-connection', requireTrustedRenderer, () => {
  return { baseUrl: proxyBaseUrl, credential: proxyCredential };
});
registerTrustedIpcHandle(ipcMain, 'desktop-release:status', requireTrustedRenderer, () => {
  return desktopReleaseManager.getStatus();
});
registerTrustedIpcHandle(ipcMain, 'desktop-release:check', requireTrustedRenderer, async () => {
  await desktopReleaseManager.check();
  return desktopReleaseManager.getStatus();
});
registerTrustedIpcHandle(ipcMain, 'desktop-release:download', requireTrustedRenderer, async () => {
  await desktopReleaseManager.download();
  return desktopReleaseManager.getStatus();
});
registerTrustedIpcHandle(ipcMain, 'desktop-release:install', requireTrustedRenderer, async () => {
  await desktopReleaseManager.install();
  return desktopReleaseManager.getStatus();
});
registerTrustedIpcHandle(ipcMain, 'desktop-recovery:consume', requireTrustedRenderer, () => {
  return desktopCrashRecovery.consumeStatus();
});
registerTrustedIpcHandle(ipcMain, 'workspace-snapshot:read', requireTrustedRenderer, () => {
  const status = sessionManager.getPublicStatus();
  if (!status.signedIn || !status.userId || !status.workspaceId) return null;
  return workspaceSnapshotStore.read({
    userId: status.userId,
    workspaceId: status.workspaceId,
  });
});
registerTrustedIpcHandle(ipcMain, 'workspace-snapshot:save', requireTrustedRenderer, (_event, request: unknown) => {
  const status = sessionManager.getPublicStatus();
  if (!status.signedIn || !status.sessionId || !status.userId || !status.workspaceId) {
    throw new Error('Signed-in Workspace session is required');
  }
  if (!isRecord(request) || !isRecord(request.data)) {
    throw new Error('Workspace snapshot write claim and data are required');
  }
  const claim = {
    sessionId: typeof request.sessionId === 'string' ? request.sessionId : '',
    generation: typeof request.generation === 'number' ? request.generation : 0,
  };
  if (!workspaceSnapshotWriteGate.authorize(status.sessionId, claim)) {
    throw new Error('Stale or cross-session Workspace snapshot write rejected');
  }
  return workspaceSnapshotStore.save({
    userId: status.userId,
    workspaceId: status.workspaceId,
  }, request.data);
});
registerTrustedIpcHandle(ipcMain, 'widget:snapshot-save', requireTrustedRenderer, async (_event, snapshot: unknown) => {
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
registerTrustedIpcHandle(ipcMain, 'widget:actions-read', requireTrustedRenderer, async () => readWidgetActions());
registerTrustedIpcHandle(ipcMain, 'widget:actions-clear', requireTrustedRenderer, async (_event, ids: unknown) => {
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
  // Scrub only when settings still hold legacy plaintext secrets. Public AuthKit profiles
  // must not clear the secure session store (restart restore depends on this).
  const scrub = scrubLegacyPlaintextAuthSettings(settingsFilePath());
  if (scrub.hadSecrets) {
    logLifecycle('legacy-auth-scrubbed', { hadSecrets: true, scrubbed: scrub.scrubbed });
    sessionManager.clear();
    saveSettings({ auth: null, apiToken: '' });
  }

  // Register custom protocol for packaged + dev AuthKit callbacks.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('agent-calendar', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('agent-calendar');
  }

  logLifecycle('app-ready', { userData: app.getPath('userData') });
  const loadedEnvKeys = loadLocalRuntimeEnv();
  if (loadedEnvKeys.length) logLifecycle('runtime-env-loaded', { keys: loadedEnvKeys });

  // Restore session from secure store (refresh if needed) without exposing tokens.
  try {
    const restored = await sessionManager.getAccessToken();
    if (restored) {
      const status = sessionManager.getPublicStatus();
      const existing = sessionManager.load();
      if (existing) {
        saveSettings({ auth: profileFromSession(existing) });
      }
      logLifecycle('session-restored', {
        workspaceId: status.workspaceId,
        userId: status.userId,
      });
    } else if (readSettings().auth) {
      saveSettings({ auth: null });
    }
  } catch (error) {
    logLifecycle('session-restore-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    const existing = sessionManager.load();
    if (existing) {
      saveSettings({ auth: profileFromSession(existing) });
      logLifecycle('session-restore-deferred-offline', {
        workspaceId: existing.workspaceId,
        userId: existing.userId,
      });
    } else {
      saveSettings({ auth: null });
    }
  }

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
  if (releaseInitialCheckTimer) clearTimeout(releaseInitialCheckTimer);
  if (releasePeriodicCheckTimer) clearInterval(releasePeriodicCheckTimer);
  releaseInitialCheckTimer = null;
  releasePeriodicCheckTimer = null;
});

app.on('will-quit', () => {
  logLifecycle('will-quit');
});
