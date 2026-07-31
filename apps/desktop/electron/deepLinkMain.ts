import { app, ipcMain, type BrowserWindow } from 'electron';

import {
  findAgentCalendarDeepLink,
  parseAgentCalendarDeepLink,
  type AgentCalendarDeepLink,
} from './deepLink.js';
import {
  guardTrustedIpcEvent,
  registerTrustedIpcHandle,
  type TrustedRendererIpcAuthorizer,
} from './rendererTrust.js';

const DEEP_LINK_EVENT = 'app:deep-link';
const DEEP_LINK_PENDING = 'app:deep-link:get-pending';
const DEEP_LINK_ACKNOWLEDGE = 'app:deep-link:ack';

export type AgentCalendarDeepLinkMain = Readonly<{
  attachWindow: (window: BrowserWindow) => void;
  receiveRawUrl: (rawUrl: string) => AgentCalendarDeepLink | Promise<unknown> | null;
  getPending: () => AgentCalendarDeepLink | null;
}>;

export type DeepLinkMainOptions = {
  authorizeRenderer: TrustedRendererIpcAuthorizer;
  onAuthCallback?: (
    target: Extract<AgentCalendarDeepLink, { kind: 'auth-callback' }>,
  ) => void | Promise<unknown>;
  onGoogleCalendarCallback?: (
    target: Extract<AgentCalendarDeepLink, { kind: 'google-calendar-callback' }>,
  ) => void | Promise<unknown>;
  onSessionDeepLink?: (target: Extract<AgentCalendarDeepLink, { kind: 'session' }>) => void;
};

export function createAgentCalendarDeepLinkMain(
  argv: readonly string[],
  options: DeepLinkMainOptions,
): AgentCalendarDeepLinkMain {
  let activeWindow: BrowserWindow | null = null;
  let pending: AgentCalendarDeepLink | null = findAgentCalendarDeepLink(argv);
  const ignoreRejected = (value: AgentCalendarDeepLink | Promise<unknown> | null) => {
    if (value instanceof Promise) void value.catch(() => undefined);
  };

  const deliverSession = (target: Extract<AgentCalendarDeepLink, { kind: 'session' }>) => {
    options.onSessionDeepLink?.(target);
    pending = target;
    if (!activeWindow || activeWindow.isDestroyed() || activeWindow.webContents.isLoadingMainFrame()) return;
    activeWindow.webContents.send(DEEP_LINK_EVENT, target);
    activeWindow.show();
    activeWindow.focus();
  };

  const receive = (rawUrl: string) => {
    const target = parseAgentCalendarDeepLink(rawUrl);
    if (!target) return null;
    if (target.kind === 'auth-callback') {
      // Auth callbacks are handled in main — never forward tokens/code to renderer.
      const result = options.onAuthCallback?.(target);
      return result === undefined ? target : result;
    }
    if (target.kind === 'google-calendar-callback') {
      const result = options.onGoogleCalendarCallback?.(target);
      return result === undefined ? target : result;
    }
    deliverSession(target);
    return target;
  };

  app.on('open-url', (event, rawUrl) => {
    event.preventDefault();
    // Keep diagnostics free of OAuth secrets — log shape only.
    try {
      const host = new URL(String(rawUrl || '')).hostname || '';
      // eslint-disable-next-line no-console
      console.log('[deep-link] open-url', host || 'unknown');
    } catch {
      // eslint-disable-next-line no-console
      console.log('[deep-link] open-url unparseable');
    }
    ignoreRejected(receive(rawUrl));
  });

  // Second-instance argv path (Windows/Linux + macOS multi-instance attempts).
  app.on('second-instance', (_event, secondArgv) => {
    const found = findAgentCalendarDeepLink(secondArgv);
    // eslint-disable-next-line no-console
    console.log('[deep-link] second-instance', found ? found.kind : 'none');
    if (!found) return;
    if (found.kind === 'auth-callback') {
      const result = options.onAuthCallback?.(found);
      if (result instanceof Promise) void result.catch(() => undefined);
      return;
    }
    if (found.kind === 'google-calendar-callback') {
      const result = options.onGoogleCalendarCallback?.(found);
      if (result instanceof Promise) void result.catch(() => undefined);
      return;
    }
    deliverSession(found);
    if (activeWindow && !activeWindow.isDestroyed()) {
      activeWindow.show();
      activeWindow.focus();
    }
  });

  registerTrustedIpcHandle(ipcMain, DEEP_LINK_PENDING, options.authorizeRenderer, () => {
    // Only session deep links are returned to the renderer.
    if (pending && pending.kind === 'session') {
      const target = pending;
      pending = null;
      return target;
    }
    // Never expose auth-callback to renderer.
    if (
      pending
      && (
        pending.kind === 'auth-callback'
        || pending.kind === 'google-calendar-callback'
      )
    ) {
      pending = null;
      return null;
    }
    return null;
  });
  ipcMain.on(DEEP_LINK_ACKNOWLEDGE, guardTrustedIpcEvent(options.authorizeRenderer, (_event, sessionId: unknown) => {
    if (typeof sessionId === 'string' && pending?.kind === 'session' && pending.sessionId === sessionId) {
      pending = null;
    }
  }));

  return {
    attachWindow(window) {
      activeWindow = window;
      window.once('closed', () => {
        if (activeWindow === window) activeWindow = null;
      });
    },
    receiveRawUrl: receive,
    getPending: () => pending,
  };
}
