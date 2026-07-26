import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from 'electron';

type AuthorizeIpc<Event> = (event: Event) => void;

export function installTrustedRendererNavigationGuard(
  webContents: Pick<WebContents, 'on'>,
  isTrustedUrl: (url: string) => boolean,
) {
  const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  };
  webContents.on('will-navigate', preventUntrustedNavigation);
  webContents.on('will-redirect', preventUntrustedNavigation);
}

export function guardTrustedIpcInvoke<Event, Args extends unknown[], Result>(
  authorize: AuthorizeIpc<Event>,
  handler: (event: Event, ...args: Args) => Result,
) {
  return (event: Event, ...args: Args): Result => {
    authorize(event);
    return handler(event, ...args);
  };
}

export function guardTrustedIpcEvent<Event, Args extends unknown[]>(
  authorize: AuthorizeIpc<Event>,
  listener: (event: Event, ...args: Args) => void,
) {
  return (event: Event, ...args: Args) => {
    try {
      authorize(event);
    } catch {
      return;
    }
    listener(event, ...args);
  };
}

export function registerTrustedIpcHandle<Args extends unknown[], Result>(
  ipc: Pick<IpcMain, 'handle'>,
  channel: string,
  authorize: AuthorizeIpc<IpcMainInvokeEvent>,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) {
  ipc.handle(channel, guardTrustedIpcInvoke(authorize, handler));
}

export type TrustedRendererIpcAuthorizer = (
  event: IpcMainInvokeEvent | IpcMainEvent,
) => void;
