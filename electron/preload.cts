import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hermesDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  getProxyBaseUrl: () => ipcRenderer.invoke('proxy:get-base-url'),
  saveWidgetSnapshot: (snapshot: unknown) => ipcRenderer.invoke('widget:snapshot-save', snapshot),
});
