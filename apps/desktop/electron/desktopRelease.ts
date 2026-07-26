export type DesktopReleasePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export type DesktopReleaseStatus = Readonly<{
  supported: boolean;
  phase: DesktopReleasePhase;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
}>;

export type DesktopUpdaterAdapter = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: { version?: string }) => void): unknown;
  on(event: 'update-not-available', listener: (info: { version?: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent?: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version?: string }) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

export type DesktopReleaseManagerOptions = Readonly<{
  updater: DesktopUpdaterAdapter;
  currentVersion: string;
  supported: boolean;
  now?: () => number;
  onStatus?: (status: DesktopReleaseStatus) => void;
}>;

function safeVersion(value: unknown): string | null {
  const version = typeof value === 'string' ? value.trim() : '';
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : null;
}

function initialStatus(currentVersion: string, supported: boolean): DesktopReleaseStatus {
  return {
    supported,
    phase: supported ? 'idle' : 'unsupported',
    currentVersion,
    availableVersion: null,
    progressPercent: null,
    checkedAt: null,
    message: supported
      ? '새 버전을 직접 확인할 수 있습니다.'
      : '업데이트 확인은 설치된 Desktop 앱에서 사용할 수 있습니다.',
  };
}

export function createDesktopReleaseManager(options: DesktopReleaseManagerOptions) {
  const { updater } = options;
  const now = options.now || (() => Date.now());
  let status = initialStatus(options.currentVersion, options.supported);
  let checkInFlight: Promise<void> | null = null;
  let downloadInFlight: Promise<void> | null = null;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;

  function publish(patch: Partial<DesktopReleaseStatus>) {
    status = { ...status, ...patch };
    options.onStatus?.({ ...status });
  }

  updater.on('checking-for-update', () => {
    publish({
      phase: 'checking',
      progressPercent: null,
      message: '새 버전을 확인하고 있습니다.',
    });
  });
  updater.on('update-available', (info) => {
    const version = safeVersion(info.version);
    publish({
      phase: 'available',
      availableVersion: version,
      progressPercent: null,
      checkedAt: new Date(now()).toISOString(),
      message: version ? `새 버전 ${version}을 사용할 수 있습니다.` : '새 버전을 사용할 수 있습니다.',
    });
  });
  updater.on('update-not-available', () => {
    publish({
      phase: 'up-to-date',
      availableVersion: null,
      progressPercent: null,
      checkedAt: new Date(now()).toISOString(),
      message: '현재 최신 버전을 사용하고 있습니다.',
    });
  });
  updater.on('download-progress', (progress) => {
    const percent = Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, Math.round(Number(progress.percent))))
      : 0;
    publish({
      phase: 'downloading',
      progressPercent: percent,
      message: `업데이트를 다운로드하고 있습니다. ${percent}%`,
    });
  });
  updater.on('update-downloaded', (info) => {
    const version = safeVersion(info.version) || status.availableVersion;
    publish({
      phase: 'ready',
      availableVersion: version,
      progressPercent: 100,
      message: '업데이트 설치 준비가 끝났습니다.',
    });
  });
  updater.on('error', () => {
    publish({
      phase: 'error',
      progressPercent: null,
      checkedAt: new Date(now()).toISOString(),
      message: '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도하세요.',
    });
  });

  function requireSupported() {
    if (!options.supported) {
      throw new Error('업데이트는 packaged Desktop 앱에서만 지원합니다.');
    }
  }

  function getStatus(): DesktopReleaseStatus {
    return { ...status };
  }

  function check(): Promise<void> {
    try {
      requireSupported();
    } catch (error) {
      return Promise.reject(error);
    }
    if (checkInFlight) return checkInFlight;
    if (downloadInFlight || status.phase === 'installing') {
      return Promise.reject(new Error('다른 업데이트 작업이 진행 중입니다.'));
    }
    const operation = updater.checkForUpdates()
      .then(() => undefined)
      .catch((error) => {
        publish({
          phase: 'error',
          progressPercent: null,
          checkedAt: new Date(now()).toISOString(),
          message: '업데이트를 확인하지 못했습니다. 잠시 후 다시 시도하세요.',
        });
        void error;
        throw new Error('업데이트를 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
      })
      .finally(() => {
        if (checkInFlight === operation) checkInFlight = null;
      });
    checkInFlight = operation;
    return operation;
  }

  function download(): Promise<void> {
    try {
      requireSupported();
    } catch (error) {
      return Promise.reject(error);
    }
    if (downloadInFlight) return downloadInFlight;
    if (status.phase !== 'available') {
      return Promise.reject(new Error('다운로드 가능한 업데이트가 없습니다.'));
    }
    publish({
      phase: 'downloading',
      progressPercent: 0,
      message: '업데이트 다운로드를 시작합니다.',
    });
    const operation = updater.downloadUpdate()
      .then(() => undefined)
      .catch((error) => {
        publish({
          phase: 'error',
          progressPercent: null,
          message: '업데이트 다운로드에 실패했습니다. 다시 시도하세요.',
        });
        void error;
        throw new Error('업데이트 다운로드에 실패했습니다. 다시 시도하세요.');
      })
      .finally(() => {
        if (downloadInFlight === operation) downloadInFlight = null;
      });
    downloadInFlight = operation;
    return operation;
  }

  function install(): Promise<void> {
    try {
      requireSupported();
    } catch (error) {
      return Promise.reject(error);
    }
    if (status.phase !== 'ready') {
      return Promise.reject(new Error('설치 준비가 끝난 업데이트가 없습니다.'));
    }
    publish({
      phase: 'installing',
      message: '업데이트를 설치하고 Agent Calendar를 다시 엽니다.',
    });
    updater.quitAndInstall(false, true);
    return Promise.resolve();
  }

  return { getStatus, check, download, install };
}

export type DesktopReleaseManager = ReturnType<typeof createDesktopReleaseManager>;
