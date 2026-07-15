import { app, ipcMain, type BrowserWindow } from 'electron';

import { findAgentCalendarDeepLink, parseAgentCalendarDeepLink, type AgentCalendarDeepLink } from './deepLink.js';

const DEEP_LINK_EVENT = 'app:deep-link';
const DEEP_LINK_PENDING = 'app:deep-link:get-pending';
const DEEP_LINK_ACKNOWLEDGE = 'app:deep-link:ack';

export type AgentCalendarDeepLinkMain = Readonly<{
  attachWindow: (window: BrowserWindow) => void;
}>;

export function createAgentCalendarDeepLinkMain(argv: readonly string[] = process.argv): AgentCalendarDeepLinkMain {
  let activeWindow: BrowserWindow | null = null;
  let pending: AgentCalendarDeepLink | null = findAgentCalendarDeepLink(argv);

  const receive = (rawUrl: string) => {
    const target = parseAgentCalendarDeepLink(rawUrl);
    if (!target) return;
    pending = target;
    if (!activeWindow || activeWindow.isDestroyed() || activeWindow.webContents.isLoadingMainFrame()) return;
    activeWindow.webContents.send(DEEP_LINK_EVENT, target);
    activeWindow.show();
    activeWindow.focus();
  };

  app.on('open-url', (event, rawUrl) => {
    event.preventDefault();
    receive(rawUrl);
  });
  ipcMain.handle(DEEP_LINK_PENDING, () => {
    const target = pending;
    pending = null;
    return target;
  });
  ipcMain.on(DEEP_LINK_ACKNOWLEDGE, (_event, sessionId: unknown) => {
    if (typeof sessionId === 'string' && pending?.sessionId === sessionId) pending = null;
  });

  return {
    attachWindow(window) {
      activeWindow = window;
      window.once('closed', () => {
        if (activeWindow === window) activeWindow = null;
      });
    },
  };
}
