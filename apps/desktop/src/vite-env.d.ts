/// <reference types="vite/client" />

declare const __AGENT_CALENDAR_BUILD_ID__: string;

type HermesDesktopSettings = {
  apiBaseUrl: string;
  hasApiToken: boolean;
  hasSession?: boolean;
  theme: 'default' | 'warm' | 'dark' | 'sage' | 'mono';
  authProfile: HermesAuthProfile | null;
  session?: {
    signedIn: boolean;
    workspaceId: string | null;
    userId: string | null;
    role: string | null;
  };
  uiPreferences?: {
    notify: boolean;
    agentShare: boolean;
    weekStartMon: boolean;
  };
};

type HermesAuthProvider = 'authkit' | 'google' | 'password';

type HermesConnection = {
  readonly baseUrl: string;
  readonly credential: string;
};

type HermesDesktopReleasePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

type HermesDesktopReleaseStatus = {
  supported: boolean;
  phase: HermesDesktopReleasePhase;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
};

type HermesDesktopRecoveryStatus = {
  phase: 'none' | 'recovered' | 'halted';
  crashCount: number;
  reason: string | null;
  occurredAt: string | null;
  message: string;
};

type HermesAuthProfile = {
  provider: HermesAuthProvider;
  id: string;
  email: string;
  name: string;
  picture?: string;
  expiresAt?: string;
  updatedAt: string;
  workspaceId?: string;
  role?: string;
};

type HermesWidgetOwner = 'me' | 'agent' | 'hybrid' | 'weekend';

type HermesWidgetSnapshotPayload = {
  todayDate: string;
  tasks: Array<{
    id: string;
    title: string;
    date: string;
    time?: string;
    owner: HermesWidgetOwner;
    list: string;
    status: string;
    done: boolean;
    durationMinutes?: number;
    source?: 'task' | 'event';
  }>;
  runs: Array<{
    id: string;
    title: string;
    status: string;
    progress: number;
  }>;
  updatedAt: string;
};

interface HermesWidgetAction {
  id: string;
  type: 'toggleTask' | 'openDate' | 'openScreen' | 'openTask' | 'openRun';
  createdAt?: string;
  taskID?: string;
  date?: string;
  screen?: string;
  runID?: string;
  source?: 'task' | 'event';
  done?: boolean;
}

interface Window {
  hermesDesktop?: {
    getSettings(): Promise<HermesDesktopSettings>;
    saveSettings(settings: Partial<HermesDesktopSettings & { apiToken: string }>): Promise<HermesDesktopSettings>;
    loginWithAuthKit(): Promise<HermesDesktopSettings>;
    cancelAuthKitLogin(): Promise<{ ok: true }>;
    connectGoogleCalendar(): Promise<{
      ok: true;
      source: {
        id: string;
        provider: 'google';
        label: string;
        status: string;
        lastSyncedAt: string;
      };
      sync: {
        ok: boolean;
        error?: string;
      };
    }>;
    connectGoogleMail(): Promise<{
      ok: true;
      connection: {
        provider: 'google';
        status: string;
      };
    }>;
    loginWithProvider(provider: HermesAuthProvider): Promise<HermesDesktopSettings>;
    signUpWithPassword(payload: { email: string; password: string }): Promise<HermesDesktopSettings>;
    loginWithPassword(payload: { email: string; password: string }): Promise<HermesDesktopSettings>;
    logoutAuth(): Promise<HermesDesktopSettings>;
    getSessionStatus(): Promise<{
      signedIn: boolean;
      sessionId: string | null;
      userId: string | null;
      workspaceId: string | null;
      role: string | null;
      email: string | null;
      displayName: string | null;
      accessExpiresAt: string | null;
    }>;
    readWorkspaceSnapshot(): Promise<{
      savedAt: string;
      data: Record<string, unknown>;
    } | null>;
    saveWorkspaceSnapshot(request: {
      sessionId: string;
      generation: number;
      data: Record<string, unknown>;
    }): Promise<{
      savedAt: string;
      data: Record<string, unknown>;
    }>;
    getDesktopReleaseStatus(): Promise<HermesDesktopReleaseStatus>;
    checkDesktopRelease(): Promise<HermesDesktopReleaseStatus>;
    downloadDesktopRelease(): Promise<HermesDesktopReleaseStatus>;
    installDesktopRelease(): Promise<HermesDesktopReleaseStatus>;
    consumeDesktopRecoveryStatus(): Promise<HermesDesktopRecoveryStatus>;
    onDesktopReleaseStatus(callback: (status: HermesDesktopReleaseStatus) => void): () => void;
    onAuthSessionChanged(callback: (settings: HermesDesktopSettings) => void): () => void;
    onAuthLoginError(callback: (error: { message?: string }) => void): () => void;
    getHermesConnection(): Promise<HermesConnection>;
    getPendingDeepLink(): Promise<unknown>;
    onDeepLink(callback: (target: unknown) => void): () => void;
    saveWidgetSnapshot(snapshot: HermesWidgetSnapshotPayload): Promise<{ ok: boolean; path: string; changed: boolean }>;
    readWidgetActions(): Promise<HermesWidgetAction[]>;
    clearWidgetActions(ids: string[]): Promise<{ ok: boolean; cleared: number }>;
    onWidgetActionsAvailable(callback: () => void): () => void;
  };
}
