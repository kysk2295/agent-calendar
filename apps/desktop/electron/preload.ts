import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hermesDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  loginWithProvider: (provider: unknown) => ipcRenderer.invoke('auth:provider-login', provider),
  signUpWithPassword: (payload: unknown) => ipcRenderer.invoke('auth:password-signup', payload),
  loginWithPassword: (payload: unknown) => ipcRenderer.invoke('auth:password-login', payload),
  logoutAuth: () => ipcRenderer.invoke('auth:logout'),
  getHermesConnection: () => ipcRenderer.invoke('hermes:get-connection'),
  getPendingDeepLink: () => ipcRenderer.invoke('app:deep-link:get-pending'),
  onDeepLink: (callback: (target: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: unknown) => {
      callback(target);
      if (typeof target === 'object' && target !== null && 'sessionId' in target && typeof target.sessionId === 'string') {
        ipcRenderer.send('app:deep-link:ack', target.sessionId);
      }
    };
    ipcRenderer.on('app:deep-link', handler);
    return () => ipcRenderer.removeListener('app:deep-link', handler);
  },
  saveWidgetSnapshot: (snapshot: unknown) => ipcRenderer.invoke('widget:snapshot-save', snapshot),
  readWidgetActions: () => ipcRenderer.invoke('widget:actions-read'),
  clearWidgetActions: (ids: unknown) => ipcRenderer.invoke('widget:actions-clear', ids),
  onWidgetActionsAvailable: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('widget:actions-available', handler);
    return () => ipcRenderer.removeListener('widget:actions-available', handler);
  },
});
