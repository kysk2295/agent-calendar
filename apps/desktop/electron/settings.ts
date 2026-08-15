import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDesktopSignedIn } from './sessionTruth.js';

export const DEFAULT_API_BASE_URL = 'https://hermes-os-production-e174.up.railway.app';

export type DesktopTheme = 'default' | 'warm' | 'dark' | 'sage' | 'mono';
export type AuthProvider = 'authkit' | 'google' | 'password';

export type DesktopAuthProfile = {
  provider: AuthProvider;
  id: string;
  email: string;
  name: string;
  picture?: string;
  expiresAt?: string;
  updatedAt: string;
  workspaceId?: string;
  role?: string;
};

export type PublicDesktopAuthProfile = Pick<DesktopAuthProfile, 'provider' | 'id' | 'email' | 'name' | 'picture' | 'expiresAt' | 'updatedAt' | 'workspaceId' | 'role'>;

export type DesktopSettings = {
  apiBaseUrl: string;
  /** Main-process only. Never returned to the renderer or sent to Railway. */
  wikiVaultPath: string;
  /** @deprecated Production authenticated routes use secure session tokens, not apiToken. */
  apiToken: string;
  theme: DesktopTheme;
  /** Public profile only — never store access/refresh tokens here. */
  auth: DesktopAuthProfile | null;
  uiPreferences: {
    notify: boolean;
    agentShare: boolean;
    weekStartMon: boolean;
  };
};

export type PublicDesktopSettings = {
  apiBaseUrl: string;
  hasWikiVault: boolean;
  hasApiToken: boolean;
  hasSession: boolean;
  theme: DesktopTheme;
  authProfile: PublicDesktopAuthProfile | null;
  session: {
    signedIn: boolean;
    workspaceId: string | null;
    userId: string | null;
    role: string | null;
  };
  uiPreferences: DesktopSettings['uiPreferences'];
};

const DEFAULT_SETTINGS: DesktopSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  wikiVaultPath: '',
  apiToken: '',
  theme: 'default',
  auth: null,
  uiPreferences: {
    notify: true,
    agentShare: true,
    weekStartMon: true,
  },
};
const LEGACY_USER_DATA_FILES = ['settings.json', 'auth-users.json'] as const;

export function migrateLegacyUserDataFiles(legacyDir: string, currentDir: string) {
  fs.mkdirSync(currentDir, { recursive: true });
  for (const filename of LEGACY_USER_DATA_FILES) {
    try {
      fs.copyFileSync(
        path.join(legacyDir, filename),
        path.join(currentDir, filename),
        fs.constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EEXIST')) continue;
      throw error;
    }
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeAuthProfile(input: unknown): DesktopAuthProfile | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const auth = input as Partial<DesktopAuthProfile> & {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    code?: string;
  };
  const provider = auth.provider === 'authkit' || auth.provider === 'google' || auth.provider === 'password'
    ? auth.provider
    : null;
  const id = String(auth.id || '');
  const email = String(auth.email || '');
  if (!provider || !id) return null;
  // Never keep provider tokens in settings — strip if present in legacy files.
  void auth.accessToken;
  void auth.refreshToken;
  void auth.idToken;
  void auth.code;
  return {
    provider,
    id,
    email: email || id,
    name: String(auth.name || email || id),
    picture: auth.picture ? String(auth.picture) : undefined,
    expiresAt: auth.expiresAt ? String(auth.expiresAt) : undefined,
    updatedAt: auth.updatedAt ? String(auth.updatedAt) : new Date().toISOString(),
    workspaceId: auth.workspaceId ? String(auth.workspaceId) : undefined,
    role: auth.role ? String(auth.role) : undefined,
  };
}

function normalizeSettings(input: Partial<DesktopSettings> = {}): DesktopSettings {
  const apiBaseUrl = String(input.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).trim().replace(/\/+$/g, '');
  const theme = ['default', 'warm', 'dark', 'sage', 'mono'].includes(String(input.theme))
    ? input.theme as DesktopTheme
    : DEFAULT_SETTINGS.theme;
  return {
    apiBaseUrl: apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl,
    wikiVaultPath: path.isAbsolute(String(input.wikiVaultPath || '').trim())
      ? path.normalize(String(input.wikiVaultPath).trim())
      : '',
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

export function publicSettings(
  settings: DesktopSettings,
  sessionStatus?: { signedIn?: boolean; workspaceId?: string | null; userId?: string | null; role?: string | null },
): PublicDesktopSettings {
  const auth = normalizeAuthProfile(settings.auth);
  const signedIn = resolveDesktopSignedIn(Boolean(auth), sessionStatus);
  return {
    apiBaseUrl: settings.apiBaseUrl,
    hasWikiVault: Boolean(settings.wikiVaultPath),
    hasApiToken: false, // production path does not expose/use settings apiToken
    hasSession: signedIn,
    theme: settings.theme,
    authProfile: auth ? {
      provider: auth.provider,
      id: auth.id,
      email: auth.email,
      name: auth.name,
      picture: auth.picture,
      expiresAt: auth.expiresAt,
      updatedAt: auth.updatedAt,
      workspaceId: auth.workspaceId,
      role: auth.role,
    } : null,
    session: {
      signedIn,
      workspaceId: sessionStatus?.workspaceId ?? auth?.workspaceId ?? null,
      userId: sessionStatus?.userId ?? auth?.id ?? null,
      role: sessionStatus?.role ?? auth?.role ?? null,
    },
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
  // Never persist new apiToken values for production auth; keep empty.
  const merged = normalizeSettings({
    ...current,
    ...next,
    apiToken: '',
    auth: Object.prototype.hasOwnProperty.call(next, 'auth') ? normalizeAuthProfile(next.auth) : current.auth,
  });
  // Ensure public profile never writes token fields even if callers pass them.
  if (merged.auth) {
    merged.auth = normalizeAuthProfile(merged.auth);
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const disk = {
    apiBaseUrl: merged.apiBaseUrl,
    wikiVaultPath: merged.wikiVaultPath,
    apiToken: '',
    theme: merged.theme,
    auth: merged.auth,
    uiPreferences: merged.uiPreferences,
  };
  fs.writeFileSync(settingsPath(), `${JSON.stringify(disk, null, 2)}\n`, 'utf8');
  return merged;
}

export function settingsFilePath() {
  return settingsPath();
}
