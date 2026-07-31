import { shell } from 'electron';
import { randomBytes } from 'node:crypto';

import type { AgentCalendarAuthCallbackDeepLink } from './deepLink.js';
import type { AppSessionTokens, SecureSessionManager } from './secureSession.js';
import { clientV1JsonHeaders } from './clientContract.js';
import { desktopLoginStartFailureMessage } from './loginFailure.js';

export type DesktopAuthKitOptions = {
  apiBaseUrl: () => string;
  fetchImpl?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  sessionManager: SecureSessionManager;
  now?: () => number;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}


/**
 * Production Desktop login via backend WorkOS AuthKit start/complete.
 * Direct Google OAuth, password files, and local JWT decode paths are disabled.
 */
export function createDesktopAuthKitLogin(options: DesktopAuthKitOptions) {
  const fetchImpl = options.fetchImpl || fetch;
  const openExternal = options.openExternal || ((url: string) => shell.openExternal(url).then(() => undefined));
  const now = options.now || (() => Date.now());
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  let completion: {
    state: string;
    codeVerifier: string;
    transactionId: string;
    timer: NodeJS.Timeout;
    resolve: (session: AppSessionTokens) => void;
    reject: (error: Error) => void;
  } | null = null;

  async function beginAuthKitLogin(): Promise<AppSessionTokens> {
    const base = options.apiBaseUrl().replace(/\/+$/g, '');
    if (!base) throw new Error('API base URL이 필요합니다.');
    const response = await fetchImpl(`${base}/api/phase1/auth/desktop/start`, {
      method: 'POST',
      headers: clientV1JsonHeaders(),
      body: JSON.stringify({ screenHint: 'sign-in' }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !payload.ok) {
      throw new Error(desktopLoginStartFailureMessage(response.status, stringValue(payload.error)));
    }
    const authorizationUrl = stringValue(payload.authorizationUrl);
    const state = stringValue(payload.state);
    const codeVerifier = stringValue(payload.codeVerifier);
    const transactionId = stringValue(payload.transactionId);
    if (!authorizationUrl || !state || !codeVerifier) {
      throw new Error('로그인 시작 응답이 올바르지 않습니다.');
    }

    if (completion) {
      clearTimeout(completion.timer);
      completion.reject(new Error('이전 로그인 시도가 취소되었습니다.'));
      completion = null;
    }

    return new Promise<AppSessionTokens>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (completion && completion.state === state) {
          completion = null;
          reject(new Error('로그인 시간이 초과되었습니다.'));
        }
      }, timeoutMs);
      completion = { state, codeVerifier, transactionId, timer, resolve, reject };
      void openExternal(authorizationUrl).catch((error) => {
        clearTimeout(timer);
        if (completion && completion.state === state) {
          completion = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  function hasPendingLogin() {
    return completion !== null;
  }

  async function completeWithCallback(callback: AgentCalendarAuthCallbackDeepLink): Promise<AppSessionTokens> {
    if (!completion) {
      const error = new Error('진행 중인 로그인이 없습니다.');
      (error as Error & { code?: string }).code = 'AUTH_NO_PENDING_LOGIN';
      throw error;
    }
    if (callback.state !== completion.state) {
      // Stale deep link from an older browser tab / other Electron instance.
      // Do not abort the current wait — user may still complete the matching flow.
      const error = new Error('로그인 state 검증에 실패했습니다.');
      (error as Error & { code?: string }).code = 'AUTH_STATE_MISMATCH_STALE';
      throw error;
    }
    const { codeVerifier, state, timer, resolve, reject } = completion;
    // One-use local pending slot before network complete (client-side replay protection).
    completion = null;
    clearTimeout(timer);

    try {
      const base = options.apiBaseUrl().replace(/\/+$/g, '');
      const response = await fetchImpl(`${base}/api/phase1/auth/desktop/complete`, {
        method: 'POST',
        headers: clientV1JsonHeaders(),
        body: JSON.stringify({
          code: callback.code,
          state,
          codeVerifier,
        }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || !payload.ok) {
        throw new Error(`로그인 완료에 실패했습니다 (${stringValue(payload.error) || response.status}).`);
      }
      if (payload.needsWorkspaceSelection) {
        throw new Error('여러 작업공간이 있습니다. 이 버전은 단일 작업공간만 지원합니다.');
      }
      const session: AppSessionTokens = {
        accessToken: stringValue(payload.accessToken),
        refreshToken: stringValue(payload.refreshToken),
        accessExpiresAt: stringValue(payload.accessExpiresAt),
        refreshExpiresAt: stringValue(payload.refreshExpiresAt) || undefined,
        sessionId: stringValue(payload.sessionId),
        userId: stringValue(payload.userId),
        workspaceId: stringValue(payload.workspaceId),
        role: stringValue(payload.role) || 'owner',
        user: payload.user && typeof payload.user === 'object'
          ? {
              id: stringValue((payload.user as Record<string, unknown>).id) || stringValue(payload.userId),
              email: stringValue((payload.user as Record<string, unknown>).email) || null,
              displayName: stringValue((payload.user as Record<string, unknown>).displayName) || null,
            }
          : { id: stringValue(payload.userId), email: null, displayName: null },
        updatedAt: new Date(now()).toISOString(),
      };
      if (!session.accessToken || !session.refreshToken) {
        throw new Error('세션 토큰이 비어 있습니다.');
      }
      const saved = options.sessionManager.save(session);
      resolve(saved);
      return saved;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      reject(err);
      throw err;
    }
  }

  function handleAuthDeepLink(callback: AgentCalendarAuthCallbackDeepLink) {
    return completeWithCallback(callback);
  }

  function cancelLogin(message = '로그인이 취소되었습니다.') {
    if (completion) {
      clearTimeout(completion.timer);
      completion.reject(new Error(message));
      completion = null;
    }
  }

  return {
    beginAuthKitLogin,
    handleAuthDeepLink,
    cancelLogin,
    hasPendingLogin,
  };
}

export type DesktopAuthKitLogin = ReturnType<typeof createDesktopAuthKitLogin>;

/** Production path: direct Google OAuth disabled. */
export async function startProviderLogin(): Promise<never> {
  throw new Error('직접 Google OAuth는 비활성화되었습니다. AuthKit으로 로그인하세요.');
}

/** Production path: local password auth disabled. */
export async function signUpWithPassword(): Promise<never> {
  throw new Error('로컬 비밀번호 가입은 비활성화되었습니다. AuthKit으로 로그인하세요.');
}

/** Production path: local password auth disabled. */
export async function loginWithPassword(): Promise<never> {
  throw new Error('로컬 비밀번호 로그인은 비활성화되었습니다. AuthKit으로 로그인하세요.');
}

export type AuthProvider = 'authkit' | 'google' | 'password';

export function randomLoginNonce(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}
