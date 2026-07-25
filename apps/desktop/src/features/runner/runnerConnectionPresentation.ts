/**
 * Pure presentation rules for Runner connection/readiness UI.
 * Disconnected must never look like calendar-ready production success.
 */

export type ConnectionPresentationRunner = {
  status?: string | null;
  connectionState?: string | null;
  lastTestOk?: boolean | null;
  lastTestMessage?: string | null;
};

export function normalizeConnectionState(runner: ConnectionPresentationRunner | null | undefined): string {
  const raw = String(runner?.connectionState || 'disconnected').toLowerCase();
  if (raw === 'connected' || raw === 'reconnecting' || raw === 'revoked') return raw;
  return 'disconnected';
}

/** Live readiness: connected transport + last connection test passed. */
export function isRunnerCurrentlyReady(runner: ConnectionPresentationRunner | null | undefined): boolean {
  if (!runner) return false;
  if (String(runner.status || '').toLowerCase() === 'revoked') return false;
  return normalizeConnectionState(runner) === 'connected' && runner.lastTestOk === true;
}

export function shouldShowReadyCard(
  step: string,
  runner: ConnectionPresentationRunner | null | undefined,
): boolean {
  return step === 'ready' && isRunnerCurrentlyReady(runner);
}

export function shouldShowReconnectRequired(runner: ConnectionPresentationRunner | null | undefined): boolean {
  if (!runner) return false;
  if (String(runner.status || '').toLowerCase() === 'revoked') return false;
  if (String(runner.status || '').toLowerCase() !== 'active') return false;
  return normalizeConnectionState(runner) !== 'connected';
}

/**
 * Connection-test copy:
 * - current_pass only while connected
 * - historical_pass when last test passed but currently not connected
 * - never style a disconnected surface as live readiness
 */
export function connectionTestPresentation(
  runner: ConnectionPresentationRunner | null | undefined,
  localMessage = '',
): { kind: 'current_pass' | 'historical_pass' | 'current_fail' | 'none'; text: string } {
  const connected = normalizeConnectionState(runner) === 'connected';
  const lastOk = runner?.lastTestOk === true;
  const lastMessage = String(runner?.lastTestMessage || localMessage || '').trim();

  if (connected && (lastOk || /passed|통과/i.test(localMessage))) {
    return {
      kind: 'current_pass',
      text: lastMessage || localMessage || 'Runner 연결 테스트를 통과했습니다.',
    };
  }

  if (!connected && lastOk) {
    return {
      kind: 'historical_pass',
      text: '마지막 연결 테스트는 통과했지만 현재는 연결되지 않았습니다. 다시 연결이 필요합니다.',
    };
  }

  if (connected && localMessage && !lastOk) {
    return { kind: 'current_fail', text: localMessage };
  }

  if (localMessage && connected) {
    return { kind: 'current_fail', text: localMessage };
  }

  return { kind: 'none', text: '' };
}

export const RECONNECT_REQUIRED_COPY = '다시 연결 필요';
export const RECONNECT_REQUIRED_DETAIL =
  'Runner 호스트 데몬이 연결되어 있지 않습니다. 동일 자격 증명으로 호스트에서 다시 연결한 뒤 연결 테스트를 실행하세요.';
