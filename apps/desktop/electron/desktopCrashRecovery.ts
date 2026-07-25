export type DesktopRecoveryPhase = 'none' | 'recovered' | 'halted';

export type DesktopRecoveryStatus = Readonly<{
  phase: DesktopRecoveryPhase;
  crashCount: number;
  reason: string | null;
  occurredAt: string | null;
  message: string;
}>;

export type RendererGoneDetails = Readonly<{
  reason: string;
  exitCode: number;
}>;

export type DesktopCrashRecoveryOptions = Readonly<{
  now?: () => number;
  windowMs?: number;
  maxAutomaticReloads?: number;
}>;

const KNOWN_REASONS = new Set([
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
]);

function emptyStatus(): DesktopRecoveryStatus {
  return {
    phase: 'none',
    crashCount: 0,
    reason: null,
    occurredAt: null,
    message: '',
  };
}

export function createDesktopCrashRecoveryController(options: DesktopCrashRecoveryOptions = {}) {
  const now = options.now || (() => Date.now());
  const windowMs = options.windowMs ?? 5 * 60_000;
  const maxAutomaticReloads = options.maxAutomaticReloads ?? 2;
  let crashTimes: number[] = [];
  let pendingStatus = emptyStatus();

  function record(details: RendererGoneDetails) {
    if (details.reason === 'clean-exit') {
      return { action: 'ignore' as const, status: emptyStatus() };
    }
    const timestamp = now();
    crashTimes = crashTimes.filter((value) => timestamp - value <= windowMs);
    crashTimes.push(timestamp);
    const reason = KNOWN_REASONS.has(details.reason) ? details.reason : 'abnormal-exit';
    const fallback = crashTimes.length > maxAutomaticReloads;
    pendingStatus = {
      phase: fallback ? 'halted' : 'recovered',
      crashCount: crashTimes.length,
      reason,
      occurredAt: new Date(timestamp).toISOString(),
      message: fallback
        ? '반복 충돌을 감지해 자동 재시작을 멈췄습니다.'
        : '예기치 않은 종료에서 복구했습니다. 마지막 동기화 보관본을 확인하세요.',
    };
    return {
      action: fallback ? 'fallback' as const : 'reload' as const,
      status: { ...pendingStatus },
    };
  }

  function consumeStatus(): DesktopRecoveryStatus {
    const current = { ...pendingStatus };
    pendingStatus = emptyStatus();
    return current;
  }

  return { record, consumeStatus };
}

export type DesktopCrashRecoveryController = ReturnType<typeof createDesktopCrashRecoveryController>;
