/// <reference types="vite/client" />

type HermesDesktopSettings = {
  apiBaseUrl: string;
  hasApiToken: boolean;
  theme: 'default' | 'warm' | 'dark' | 'sage' | 'mono';
};

interface Window {
  hermesDesktop?: {
    getSettings(): Promise<HermesDesktopSettings>;
    saveSettings(settings: Partial<HermesDesktopSettings & { apiToken: string }>): Promise<HermesDesktopSettings>;
    getProxyBaseUrl(): Promise<string>;
  };
}
