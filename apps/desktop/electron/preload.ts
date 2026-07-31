import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hermesDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  loginWithAuthKit: () => ipcRenderer.invoke('auth:authkit-login'),
  cancelAuthKitLogin: () => ipcRenderer.invoke('auth:authkit-cancel'),
  connectGoogleCalendar: () => ipcRenderer.invoke('calendar:google-connect'),
  // Legacy names kept but main process rejects production use.
  loginWithProvider: (provider: unknown) => ipcRenderer.invoke('auth:provider-login', provider),
  signUpWithPassword: (payload: unknown) => ipcRenderer.invoke('auth:password-signup', payload),
  loginWithPassword: (payload: unknown) => ipcRenderer.invoke('auth:password-login', payload),
  logoutAuth: () => ipcRenderer.invoke('auth:logout'),
  getSessionStatus: () => ipcRenderer.invoke('auth:session-status'),
  readWorkspaceSnapshot: () => ipcRenderer.invoke('workspace-snapshot:read'),
  saveWorkspaceSnapshot: (request: unknown) => ipcRenderer.invoke('workspace-snapshot:save', request),
  getDesktopReleaseStatus: () => ipcRenderer.invoke('desktop-release:status'),
  checkDesktopRelease: () => ipcRenderer.invoke('desktop-release:check'),
  downloadDesktopRelease: () => ipcRenderer.invoke('desktop-release:download'),
  installDesktopRelease: () => ipcRenderer.invoke('desktop-release:install'),
  consumeDesktopRecoveryStatus: () => ipcRenderer.invoke('desktop-recovery:consume'),
  onDesktopReleaseStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('desktop-release:status', handler);
    return () => ipcRenderer.removeListener('desktop-release:status', handler);
  },
  onAuthSessionChanged: (callback: (settings: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: unknown) => callback(settings);
    ipcRenderer.on('auth:session-changed', handler);
    return () => ipcRenderer.removeListener('auth:session-changed', handler);
  },
  onAuthLoginError: (callback: (error: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: unknown) => callback(error);
    ipcRenderer.on('auth:login-error', handler);
    return () => ipcRenderer.removeListener('auth:login-error', handler);
  },
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
