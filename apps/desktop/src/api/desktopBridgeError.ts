/**
 * Electron wraps a rejected ipcRenderer.invoke in its own transport text, so a message
 * written for the user arrives as
 * `Error invoking remote method 'auth:authkit-login': Error: <message>`.
 * The transport is not the user's problem; only the message is.
 */
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const NESTED_ERROR_PREFIX = /^(?:Error|TypeError|RangeError):\s*/;

export function desktopBridgeErrorMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  let message = raw.trim();
  if (!message) return fallback;
  message = message.replace(IPC_INVOKE_PREFIX, '').trim();
  while (NESTED_ERROR_PREFIX.test(message)) {
    message = message.replace(NESTED_ERROR_PREFIX, '').trim();
  }
  return message || fallback;
}
