import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_API_BASE_URL = 'https://hermes-os-production-e174.up.railway.app';

export type DesktopTheme = 'default' | 'warm' | 'dark' | 'sage' | 'mono';
export type AuthProvider = 'google' | 'password';

export type DesktopAuthProfile = {
  provider: AuthProvider;
  id: string;
  email: string;
  name: string;
  picture?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  code?: string;
  expiresAt?: string;
  updatedAt: string;
};

export type PublicDesktopAuthProfile = Pick<DesktopAuthProfile, 'provider' | 'id' | 'email' | 'name' | 'picture' | 'expiresAt' | 'updatedAt'>;

export type DesktopSettings = {
  apiBaseUrl: string;
  apiToken: string;
  theme: DesktopTheme;
  auth: DesktopAuthProfile | null;
  uiPreferences: {
    notify: boolean;
    agentShare: boolean;
    weekStartMon: boolean;
  };
};

export type PublicDesktopSettings = {
  apiBaseUrl: string;
  hasApiToken: boolean;
  theme: DesktopTheme;
  authProfile: PublicDesktopAuthProfile | null;
  uiPreferences: DesktopSettings['uiPreferences'];
};

const DEFAULT_SETTINGS: DesktopSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  apiToken: '',
  theme: 'default',
  auth: null,
  uiPreferences: {
    notify: true,
    agentShare: true,
    weekStartMon: true,
  },
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeAuthProfile(input: unknown): DesktopAuthProfile | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const auth = input as Partial<DesktopAuthProfile>;
  const provider = auth.provider === 'google' || auth.provider === 'password' ? auth.provider : null;
  const id = String(auth.id || '');
  const email = String(auth.email || '');
  if (!provider || !id || !email) return null;
  return {
    provider,
    id,
    email,
    name: String(auth.name || email),
    picture: auth.picture ? String(auth.picture) : undefined,
    accessToken: auth.accessToken ? String(auth.accessToken) : undefined,
    refreshToken: auth.refreshToken ? String(auth.refreshToken) : undefined,
    idToken: auth.idToken ? String(auth.idToken) : undefined,
    code: auth.code ? String(auth.code) : undefined,
    expiresAt: auth.expiresAt ? String(auth.expiresAt) : undefined,
    updatedAt: auth.updatedAt ? String(auth.updatedAt) : new Date().toISOString(),
  };
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
    auth: normalizeAuthProfile(input.auth),
    uiPreferences: {
      notify: typeof input.uiPreferences?.notify === 'boolean' ? input.uiPreferences.notify : DEFAULT_SETTINGS.uiPreferences.notify,
      agentShare: typeof input.uiPreferences?.agentShare === 'boolean' ? input.uiPreferences.agentShare : DEFAULT_SETTINGS.uiPreferences.agentShare,
      weekStartMon: typeof input.uiPreferences?.weekStartMon === 'boolean' ? input.uiPreferences.weekStartMon : DEFAULT_SETTINGS.uiPreferences.weekStartMon,
    },
  };
}

export function publicSettings(settings: DesktopSettings): PublicDesktopSettings {
  const auth = normalizeAuthProfile(settings.auth);
  return {
    apiBaseUrl: settings.apiBaseUrl,
    hasApiToken: Boolean(settings.apiToken),
    theme: settings.theme,
    authProfile: auth ? {
      provider: auth.provider,
      id: auth.id,
      email: auth.email,
      name: auth.name,
      picture: auth.picture,
      expiresAt: auth.expiresAt,
      updatedAt: auth.updatedAt,
    } : null,
    uiPreferences: settings.uiPreferences,
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
    auth: Object.prototype.hasOwnProperty.call(next, 'auth') ? normalizeAuthProfile(next.auth) : current.auth,
  });
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}
