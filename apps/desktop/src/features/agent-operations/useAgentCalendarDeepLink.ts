import { useEffect, useRef } from 'react';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function sessionIdFromTarget(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('sessionId' in value)) return '';
  if (value.kind !== 'session' || typeof value.sessionId !== 'string') return '';
  return SESSION_ID_PATTERN.test(value.sessionId) ? value.sessionId : '';
}

export function useAgentCalendarDeepLink(enabled: boolean, onOpenSession: (sessionId: string) => void): void {
  const enabledRef = useRef(enabled);
  const onOpenSessionRef = useRef(onOpenSession);
  const pendingSessionIdRef = useRef('');
  enabledRef.current = enabled;
  onOpenSessionRef.current = onOpenSession;

  useEffect(() => {
    if (!enabled || !pendingSessionIdRef.current) return;
    const sessionId = pendingSessionIdRef.current;
    pendingSessionIdRef.current = '';
    onOpenSessionRef.current(sessionId);
  }, [enabled]);

  useEffect(() => {
    const desktop = window.hermesDesktop;
    if (!desktop?.getPendingDeepLink || !desktop.onDeepLink) return undefined;
    const accept = (target: unknown) => {
      const sessionId = sessionIdFromTarget(target);
      if (!sessionId) return;
      if (enabledRef.current) onOpenSessionRef.current(sessionId);
      else pendingSessionIdRef.current = sessionId;
    };
    const dispose = desktop.onDeepLink(accept);
    void desktop.getPendingDeepLink().then(accept, (reason: unknown) => {
      if (!(reason instanceof Error)) throw reason;
    });
    return dispose;
  }, []);
}
