import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiProxyServer } from './proxy.js';
import { publicSettings, readSettings, saveSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_APP_GROUP_ID = 'group.com.agents.calendar';
const WIDGET_SNAPSHOT_FILE = 'HermesWidgetSnapshot.json';
const WIDGET_ACTIONS_FILE = 'HermesWidgetActions.json';
let mainWindow: BrowserWindow | null = null;
let proxyBaseUrl = '';
let widgetActionPoller: NodeJS.Timeout | null = null;

function appIconPath() {
  if (process.env.VITE_DEV_SERVER_URL) return path.join(process.cwd(), 'public', 'agent-calendar-logo.png');
  return path.join(__dirname, '..', 'dist', 'agent-calendar-logo.png');
}

async function startProxy() {
  const server = createApiProxyServer({ getSettings: readSettings });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start Agent Calendar API proxy');
  proxyBaseUrl = `http://127.0.0.1:${address.port}`;
}

function createWindow() {
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

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  startWidgetActionBridge();
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
ipcMain.handle('proxy:get-base-url', () => proxyBaseUrl);
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
  await startProxy();
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
