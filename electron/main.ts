import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiProxyServer } from './proxy.js';
import { publicSettings, readSettings, saveSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let proxyBaseUrl = '';

async function startProxy() {
  const server = createApiProxyServer({ getSettings: readSettings });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start Hermes API proxy');
  proxyBaseUrl = `http://127.0.0.1:${address.port}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 824,
    minWidth: 980,
    minHeight: 700,
    title: 'Hermes Tasks',
    backgroundColor: '#EAE5DA',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
}

ipcMain.handle('settings:get', () => publicSettings(readSettings()));
ipcMain.handle('settings:save', (_event, settings: unknown) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return publicSettings(readSettings());
  return publicSettings(saveSettings(settings));
});
ipcMain.handle('proxy:get-base-url', () => proxyBaseUrl);

app.whenReady().then(async () => {
  await startProxy();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
