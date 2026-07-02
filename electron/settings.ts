import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_API_BASE_URL = 'https://hermes-os-production-e174.up.railway.app';

export type DesktopTheme = 'default' | 'warm' | 'dark' | 'sage' | 'mono';

export type DesktopSettings = {
  apiBaseUrl: string;
  apiToken: string;
  theme: DesktopTheme;
};

export type PublicDesktopSettings = {
  apiBaseUrl: string;
  hasApiToken: boolean;
  theme: DesktopTheme;
};

const DEFAULT_SETTINGS: DesktopSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  apiToken: '',
  theme: 'default',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeSettings(input: Partial<DesktopSettings> = {}): DesktopSettings {
  const apiBaseUrl = String(input.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).trim().replace(/\/+$/g, '');
  const theme = ['default', 'warm', 'dark', 'sage', 'mono'].includes(String(input.theme))
    ? input.theme as DesktopTheme
    : DEFAULT_SETTINGS.theme;
  return {
    apiBaseUrl: apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl,
    apiToken: String(input.apiToken || ''),
    theme,
  };
}

export function publicSettings(settings: DesktopSettings): PublicDesktopSettings {
  return {
    apiBaseUrl: settings.apiBaseUrl,
    hasApiToken: Boolean(settings.apiToken),
    theme: settings.theme,
  };
}

export function readSettings(): DesktopSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<DesktopSettings>;
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Partial<DesktopSettings>): DesktopSettings {
  const current = readSettings();
  const merged = normalizeSettings({
    ...current,
    ...next,
    apiToken: Object.prototype.hasOwnProperty.call(next, 'apiToken') ? String(next.apiToken || '') : current.apiToken,
  });
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}
