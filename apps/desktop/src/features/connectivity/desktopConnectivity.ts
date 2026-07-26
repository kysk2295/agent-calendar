export type DesktopConnectivityStatus =
  | 'checking'
  | 'online'
  | 'offline'
  | 'reconnecting'
  | 'recovered';

export type DesktopConnectivityState = Readonly<{
  status: DesktopConnectivityStatus;
  lastSuccessfulAt: string | null;
  lastFailureAt: string | null;
  retryAttempt: number;
  failureMessage: string;
}>;

export type ConnectivityPresentation = Readonly<{
  title: string;
  detail: string;
  actionLabel: string;
}>;

export const INITIAL_DESKTOP_CONNECTIVITY: DesktopConnectivityState = {
  status: 'checking',
  lastSuccessfulAt: null,
  lastFailureAt: null,
  retryAttempt: 0,
  failureMessage: '',
};

export function markConnectivityOnline(
  current: DesktopConnectivityState,
  at: string,
): DesktopConnectivityState {
  const recovered = (
    current.status === 'offline'
    || current.status === 'reconnecting'
  ) && Boolean(current.lastSuccessfulAt);
  return {
    status: recovered ? 'recovered' : 'online',
    lastSuccessfulAt: at,
    lastFailureAt: current.lastFailureAt,
    retryAttempt: 0,
    failureMessage: '',
  };
}

export function markConnectivityOffline(
  current: DesktopConnectivityState,
  failure: Readonly<{ at: string; message: string }>,
): DesktopConnectivityState {
  const continuingFailure = current.status === 'offline' || current.status === 'reconnecting';
  return {
    status: 'offline',
    lastSuccessfulAt: current.lastSuccessfulAt,
    lastFailureAt: failure.at,
    retryAttempt: continuingFailure ? current.retryAttempt + 1 : 1,
    failureMessage: failure.message,
  };
}

export function beginConnectivityRetry(
  current: DesktopConnectivityState,
): DesktopConnectivityState {
  if (current.status !== 'offline') return current;
  return { ...current, status: 'reconnecting' };
}

export function settleRecoveredConnectivity(
  current: DesktopConnectivityState,
): DesktopConnectivityState {
  if (current.status !== 'recovered') return current;
  return { ...current, status: 'online' };
}

export function offlineRetryDelayMs(retryAttempt: number): number {
  const safeAttempt = Number.isFinite(retryAttempt)
    ? Math.max(0, Math.floor(retryAttempt))
    : 0;
  return Math.min(30_000, 5_000 * (2 ** safeAttempt));
}

export function connectivityPresentation(
  state: DesktopConnectivityState,
  formatTimestamp: (value: string) => string = (value) => value,
): ConnectivityPresentation {
  if (state.status === 'offline') {
    return {
      title: '연결 끊김',
      detail: state.lastSuccessfulAt
        ? `마지막 동기화 ${formatTimestamp(state.lastSuccessfulAt)} · 표시 중인 데이터는 유지됩니다.`
        : '아직 동기화된 데이터가 없습니다. 연결을 확인한 뒤 다시 시도하세요.',
      actionLabel: '재시도',
    };
  }
  if (state.status === 'reconnecting') {
    return {
      title: '다시 연결 중',
      detail: state.lastSuccessfulAt
        ? `마지막 동기화 ${formatTimestamp(state.lastSuccessfulAt)} · 표시 중인 데이터는 유지됩니다.`
        : 'Workspace 연결을 확인하고 있습니다.',
      actionLabel: '',
    };
  }
  if (state.status === 'recovered') {
    return {
      title: '다시 연결됨',
      detail: '최신 Workspace 상태로 동기화했습니다.',
      actionLabel: '',
    };
  }
  return {
    title: state.status === 'checking' ? '연결 확인 중' : '연결됨',
    detail: '',
    actionLabel: '',
  };
}
