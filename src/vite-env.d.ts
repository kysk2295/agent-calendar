/// <reference types="vite/client" />

type HermesDesktopSettings = {
  apiBaseUrl: string;
  hasApiToken: boolean;
  theme: 'default' | 'warm' | 'dark' | 'sage' | 'mono';
  uiPreferences?: {
    notify: boolean;
    agentShare: boolean;
    weekStartMon: boolean;
  };
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
  }>;
  runs: Array<{
    id: string;
    title: string;
    status: string;
    progress: number;
  }>;
  updatedAt: string;
};

interface Window {
  hermesDesktop?: {
    getSettings(): Promise<HermesDesktopSettings>;
    saveSettings(settings: Partial<HermesDesktopSettings & { apiToken: string }>): Promise<HermesDesktopSettings>;
    getProxyBaseUrl(): Promise<string>;
    saveWidgetSnapshot(snapshot: HermesWidgetSnapshotPayload): Promise<{ ok: boolean; path: string; changed: boolean }>;
  };
}
