import electron from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clientV1JsonHeaders } from './clientContract.js';

const { app, safeStorage } = electron as typeof electron & {
  app: typeof electron.app;
  safeStorage: typeof electron.safeStorage;
};

export type AppSessionTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt?: string;
  sessionId: string;
  userId: string;
  workspaceId: string;
  role: string;
  user?: {
    id?: string;
    email?: string | null;
    displayName?: string | null;
  };
  updatedAt: string;
};

export type PublicSessionStatus = {
  signedIn: boolean;
  sessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  role: string | null;
  email: string | null;
  displayName: string | null;
  accessExpiresAt: string | null;
};

export type SecureSessionStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => Buffer;
  decryptString: (buffer: Buffer) => string;
};

export type SecureSessionOptions = {
  userDataPath?: string;
  storage?: SecureSessionStorage;
  now?: () => number;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: () => string;
  refreshPath?: string;
  onCleared?: () => void;
};

const SESSION_FILE = 'app-session.enc';
const REFRESH_SKEW_MS = 60_000;

function defaultStorage(): SecureSessionStorage {
  return {
    isEncryptionAvailable: () => {
      try {
        return Boolean(safeStorage?.isEncryptionAvailable?.());
      } catch {
        return false;
      }
    },
    encryptString: (plain: string) => safeStorage.encryptString(plain),
    decryptString: (buffer: Buffer) => safeStorage.decryptString(buffer),
  };
}

function sessionPath(userDataPath: string) {
  return path.join(userDataPath, SESSION_FILE);
}

function publicFromSession(session: AppSessionTokens | null): PublicSessionStatus {
  if (!session) {
    return {
      signedIn: false,
      sessionId: null,
      userId: null,
      workspaceId: null,
      role: null,
      email: null,
      displayName: null,
      accessExpiresAt: null,
    };
  }
  return {
    signedIn: true,
    sessionId: session.sessionId,
    userId: session.userId,
    workspaceId: session.workspaceId,
    role: session.role,
    email: session.user?.email || null,
    displayName: session.user?.displayName || null,
    accessExpiresAt: session.accessExpiresAt,
  };
}

function normalizeSession(input: unknown): AppSessionTokens | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Partial<AppSessionTokens>;
  if (!value.accessToken || !value.refreshToken || !value.sessionId || !value.userId || !value.workspaceId) {
    return null;
  }
  return {
    accessToken: String(value.accessToken),
    refreshToken: String(value.refreshToken),
    accessExpiresAt: String(value.accessExpiresAt || ''),
    refreshExpiresAt: value.refreshExpiresAt ? String(value.refreshExpiresAt) : undefined,
    sessionId: String(value.sessionId),
    userId: String(value.userId),
    workspaceId: String(value.workspaceId),
    role: String(value.role || 'member'),
    user: value.user
      ? {
          id: value.user.id ? String(value.user.id) : undefined,
          email: value.user.email == null ? null : String(value.user.email),
          displayName: value.user.displayName == null ? null : String(value.user.displayName),
        }
      : undefined,
    updatedAt: String(value.updatedAt || new Date().toISOString()),
  };
}

/**
 * Atomic 0600 encrypted session file store. Never writes tokens to settings.json.
 */
export function createSecureSessionManager(options: SecureSessionOptions = {}) {
  const storage = options.storage || defaultStorage();
  const now = options.now || (() => Date.now());
  const fetchImpl = options.fetchImpl || fetch;
  const refreshPath = options.refreshPath || '/api/phase1/auth/refresh';
  const getUserDataPath = () => options.userDataPath || app.getPath('userData');
  const getApiBaseUrl = () => (options.apiBaseUrl ? options.apiBaseUrl() : '').replace(/\/+$/g, '');

  let memory: AppSessionTokens | null = null;
  let refreshInFlight: Promise<AppSessionTokens | null> | null = null;

  function readFromDisk(): AppSessionTokens | null {
    if (!storage.isEncryptionAvailable()) return null;
    const file = sessionPath(getUserDataPath());
    try {
      if (!fs.existsSync(file)) return null;
      const encrypted = fs.readFileSync(file);
      const plain = storage.decryptString(encrypted);
      return normalizeSession(JSON.parse(plain));
    } catch {
      return null;
    }
  }

  function writeAtomic(session: AppSessionTokens | null) {
    const dir = getUserDataPath();
    fs.mkdirSync(dir, { recursive: true });
    const target = sessionPath(dir);
    if (!session) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // ignore
      }
      memory = null;
      try {
        options.onCleared?.();
      } catch {
      }
      return;
    }
    if (!storage.isEncryptionAvailable()) {
      throw new Error('Secure session storage is unavailable on this host');
    }
    const payload = `${JSON.stringify(session)}\n`;
    const encrypted = storage.encryptString(payload);
    const tmp = path.join(dir, `.${SESSION_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // best effort on platforms that ignore mode
    }
    memory = session;
  }

  function load(): AppSessionTokens | null {
    if (memory) return memory;
    memory = readFromDisk();
    return memory;
  }

  function save(session: AppSessionTokens) {
    const normalized = normalizeSession({
      ...session,
      updatedAt: new Date(now()).toISOString(),
    });
    if (!normalized) throw new Error('Invalid app session payload');
    writeAtomic(normalized);
    return normalized;
  }

  function clear() {
    writeAtomic(null);
  }

  function getPublicStatus(): PublicSessionStatus {
    return publicFromSession(load());
  }

  function accessTokenNeedsRefresh(session: AppSessionTokens | null): boolean {
    if (!session?.accessToken || !session.accessExpiresAt) return Boolean(session?.refreshToken);
    const expires = Date.parse(session.accessExpiresAt);
    if (!Number.isFinite(expires)) return true;
    return expires - REFRESH_SKEW_MS <= now();
  }

  async function refreshSession(): Promise<AppSessionTokens | null> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const current = load();
      if (!current?.refreshToken) return null;
      const base = getApiBaseUrl();
      if (!base) throw new Error('API base URL is required to refresh session');
      const response = await fetchImpl(`${base}${refreshPath}`, {
        method: 'POST',
        headers: clientV1JsonHeaders(),
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || !payload.ok) {
        const errorCode = String(payload.error || payload.code || '').toLowerCase();
        const definitiveInvalidation = [400, 401, 403].includes(response.status)
          || [
            'invalid_refresh_token',
            'refresh_token_expired',
            'session_revoked',
            'invalid_session',
          ].includes(errorCode);
        if (definitiveInvalidation && response.status !== 429) {
          clear();
          return null;
        }
        throw new Error(`Session refresh temporarily unavailable (${response.status || 'unknown'})`);
      }
      const next = save({
        accessToken: String(payload.accessToken || ''),
        refreshToken: String(payload.refreshToken || current.refreshToken),
        accessExpiresAt: String(payload.accessExpiresAt || ''),
        refreshExpiresAt: payload.refreshExpiresAt ? String(payload.refreshExpiresAt) : current.refreshExpiresAt,
        sessionId: String(payload.sessionId || current.sessionId),
        userId: current.userId,
        workspaceId: String(payload.workspaceId || current.workspaceId),
        role: current.role,
        user: current.user,
        updatedAt: new Date(now()).toISOString(),
      });
      return next;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getAccessToken(optionsInner: { forceRefresh?: boolean } = {}): Promise<string | null> {
    let session = load();
    if (!session) return null;
    if (optionsInner.forceRefresh || accessTokenNeedsRefresh(session)) {
      session = await refreshSession();
    }
    return session?.accessToken || null;
  }

  async function logoutRemote(): Promise<void> {
    const session = load();
    const base = getApiBaseUrl();
    if (session?.accessToken && base) {
      try {
        await fetchImpl(`${base}/api/phase1/auth/logout`, {
          method: 'POST',
          headers: clientV1JsonHeaders({
            authorization: `Bearer ${session.accessToken}`,
          }),
          body: '{}',
        });
      } catch {
        // Best-effort revoke; always clear local store.
      }
    }
    clear();
  }

  return {
    load,
    save,
    clear,
    getPublicStatus,
    getAccessToken,
    refreshSession,
    logoutRemote,
    accessTokenNeedsRefresh,
  };
}

export type SecureSessionManager = ReturnType<typeof createSecureSessionManager>;

/**
 * Scrub legacy plaintext auth secrets from settings.json without deleting user files.
 * Leaves unread auth-users.json if present. Forces re-login by clearing auth tokens
 * and apiToken from the settings document.
 */
export function scrubLegacyPlaintextAuthSettings(settingsFilePath: string): {
  scrubbed: boolean;
  hadSecrets: boolean;
} {
  try {
    if (!fs.existsSync(settingsFilePath)) {
      return { scrubbed: false, hadSecrets: false };
    }
    const raw = fs.readFileSync(settingsFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let hadSecrets = false;
    if (parsed.apiToken) {
      hadSecrets = true;
      parsed.apiToken = '';
    }
    if (parsed.auth && typeof parsed.auth === 'object' && parsed.auth) {
      const auth = parsed.auth as Record<string, unknown>;
      // Only treat provider/app token fields as secrets. A public AuthKit profile
      // (id/email/name only) must survive restart and must not wipe the secure session.
      if (auth.accessToken || auth.refreshToken || auth.idToken || auth.code) {
        hadSecrets = true;
        // Drop entire legacy auth profile that carried plaintext tokens — force re-login.
        parsed.auth = null;
      }
    }
    if (!hadSecrets) return { scrubbed: false, hadSecrets: false };
    const tmp = `${settingsFilePath}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, settingsFilePath);
    return { scrubbed: true, hadSecrets: true };
  } catch {
    return { scrubbed: false, hadSecrets: false };
  }
}
