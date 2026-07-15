/// <reference types="vite/client" />

type HermesDesktopSettings = {
  apiBaseUrl: string;
  hasApiToken: boolean;
  theme: 'default' | 'warm' | 'dark' | 'sage' | 'mono';
  authProfile: HermesAuthProfile | null;
  uiPreferences?: {
    notify: boolean;
    agentShare: boolean;
    weekStartMon: boolean;
  };
};

type HermesAuthProvider = 'google' | 'password';

type HermesConnection = {
  readonly baseUrl: string;
  readonly credential: string;
};

type HermesAuthProfile = {
  provider: HermesAuthProvider;
  id: string;
  email: string;
  name: string;
  picture?: string;
  expiresAt?: string;
  updatedAt: string;
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
    loginWithProvider(provider: HermesAuthProvider): Promise<HermesDesktopSettings>;
    signUpWithPassword(payload: { email: string; password: string }): Promise<HermesDesktopSettings>;
    loginWithPassword(payload: { email: string; password: string }): Promise<HermesDesktopSettings>;
    logoutAuth(): Promise<HermesDesktopSettings>;
    getHermesConnection(): Promise<HermesConnection>;
    getPendingDeepLink(): Promise<unknown>;
    onDeepLink(callback: (target: unknown) => void): () => void;
    saveWidgetSnapshot(snapshot: HermesWidgetSnapshotPayload): Promise<{ ok: boolean; path: string; changed: boolean }>;
    readWidgetActions(): Promise<HermesWidgetAction[]>;
    clearWidgetActions(ids: string[]): Promise<{ ok: boolean; cleared: number }>;
    onWidgetActionsAvailable(callback: () => void): () => void;
  };
}
