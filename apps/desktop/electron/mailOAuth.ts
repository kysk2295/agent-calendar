import { randomUUID } from 'node:crypto';

import {
  CLIENT_IDEMPOTENCY_KEY_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  clientV1JsonHeaders,
} from './clientContract.js';

export type GoogleMailOAuthCallback = Readonly<{
  kind: 'google-mail-callback';
  code: string;
  state: string;
}>;

export type DesktopGoogleMailOAuthResult = Readonly<{
  ok: true;
  connection: Readonly<{ provider: 'google'; status: string }>;
}>;

export type DesktopGoogleMailOAuthOptions = Readonly<{
  apiBaseUrl: () => string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  createRequestId?: () => string;
  timeoutMs?: number;
}>;

type JsonRecord = Record<string, unknown>;
type PendingAttempt = {
  state: string;
  timer: NodeJS.Timeout;
  resolve: (result: DesktopGoogleMailOAuthResult) => void;
  reject: (error: Error) => void;
};

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

export class DesktopGoogleMailOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'DesktopGoogleMailOAuthError';
    this.code = code;
    this.status = status;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function responseError(status: number, payload: JsonRecord): DesktopGoogleMailOAuthError {
  const code = stringValue(payload.error) || `HTTP_${status}`;
  if (
    status === 503
    || ['GOOGLE_OAUTH_NOT_CONFIGURED', 'GOOGLE_VAULT_KEY_REQUIRED', 'EXTERNAL_CALENDAR_DISABLED'].includes(code)
  ) {
    return new DesktopGoogleMailOAuthError(
      'Google 메일 연결을 사용할 수 없습니다. 관리자 설정을 확인하세요.',
      code,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new DesktopGoogleMailOAuthError(
      'Google 메일 연결을 계속하려면 다시 로그인하세요.',
      code,
      status,
    );
  }
  return new DesktopGoogleMailOAuthError(`Google 메일 연결에 실패했습니다 (${code}).`, code, status);
}

function validAuthorizationUrl(value: string): boolean {
  if (!value || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}

export function createDesktopGoogleMailOAuth(options: DesktopGoogleMailOAuthOptions) {
  const fetchImpl = options.fetchImpl || fetch;
  const createRequestId = options.createRequestId || randomUUID;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let pending: PendingAttempt | null = null;

  const request = async (
    path: string,
    init: RequestInit = {},
    policy: Readonly<{ idempotent?: boolean }> = {},
  ): Promise<JsonRecord> => {
    const token = await options.getAccessToken();
    if (!token) throw new DesktopGoogleMailOAuthError('Google 메일 연결을 계속하려면 로그인이 필요합니다.', 'AUTH_REQUIRED', 401);
    const base = options.apiBaseUrl().replace(/\/+$/g, '');
    if (!base || !URL.canParse(base)) {
      throw new DesktopGoogleMailOAuthError('Agent Calendar 서버 주소가 올바르지 않습니다.', 'API_BASE_URL_INVALID', 500);
    }
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(clientV1JsonHeaders({ authorization: `Bearer ${token}` }));
    if (method !== 'GET') {
      const requestId = createRequestId();
      headers.set(CLIENT_REQUEST_ID_HEADER, requestId);
      if (policy.idempotent) headers.set(CLIENT_IDEMPOTENCY_KEY_HEADER, requestId);
    }
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const response = await fetchImpl(`${base}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok || payload.ok === false) throw responseError(response.status, payload);
    return payload;
  };

  function cancel(message = 'Google 메일 연결이 취소되었습니다.') {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(new DesktopGoogleMailOAuthError(message, 'OAUTH_CANCELLED', 499));
  }

  async function begin(): Promise<DesktopGoogleMailOAuthResult> {
    cancel('이전 Google 메일 연결 시도가 취소되었습니다.');
    const payload = await request('/api/mail/google/authorize', { method: 'POST', body: '{}' });
    const state = stringValue(payload.state);
    const authorizationUrl = stringValue(payload.authorizationUrl || payload.url);
    if (!state.startsWith('mail.') || !validAuthorizationUrl(authorizationUrl)) {
      throw new DesktopGoogleMailOAuthError('Google 메일 연결 시작 응답이 올바르지 않습니다.', 'GOOGLE_OAUTH_START_INVALID', 502);
    }
    return new Promise<DesktopGoogleMailOAuthResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.state !== state) return;
        pending = null;
        reject(new DesktopGoogleMailOAuthError('Google 메일 연결 시간이 초과되었습니다.', 'GOOGLE_OAUTH_TIMEOUT', 408));
      }, timeoutMs);
      pending = { state, timer, resolve, reject };
      void options.openExternal(authorizationUrl).catch((error) => {
        if (pending?.state !== state) return;
        const current = pending;
        pending = null;
        clearTimeout(timer);
        current.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async function handleCallback(callback: GoogleMailOAuthCallback): Promise<DesktopGoogleMailOAuthResult> {
    if (!pending) {
      throw new DesktopGoogleMailOAuthError('진행 중인 Google 메일 연결이 없습니다.', 'GOOGLE_OAUTH_NOT_PENDING', 400);
    }
    if (callback.state !== pending.state) {
      throw new DesktopGoogleMailOAuthError('Google 메일 연결 state 검증에 실패했습니다.', 'GOOGLE_OAUTH_STATE_MISMATCH', 400);
    }
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    try {
      const completed = await request('/api/mail/google/callback', {
        method: 'POST',
        body: JSON.stringify({ code: callback.code, state: callback.state }),
      }, { idempotent: true });
      const connection = objectValue(completed.connection);
      if (stringValue(connection.provider) !== 'google') {
        throw new DesktopGoogleMailOAuthError('Google 메일 연결 응답이 올바르지 않습니다.', 'GOOGLE_MAIL_CONNECTION_INVALID', 502);
      }
      const result: DesktopGoogleMailOAuthResult = {
        ok: true,
        connection: { provider: 'google', status: stringValue(connection.status) || 'connected' },
      };
      current.resolve(result);
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      current.reject(failure);
      throw failure;
    }
  }

  async function disconnect(): Promise<DesktopGoogleMailOAuthResult> {
    const completed = await request('/api/mail/google/disconnect', {
      method: 'POST',
      body: '{}',
    }, { idempotent: true });
    const connection = objectValue(completed.connection);
    if (stringValue(connection.provider) !== 'google' || stringValue(connection.status) !== 'disconnected') {
      throw new DesktopGoogleMailOAuthError(
        'Google 메일 연결 해제 응답이 올바르지 않습니다.',
        'GOOGLE_MAIL_DISCONNECT_INVALID',
        502,
      );
    }
    return {
      ok: true,
      connection: { provider: 'google', status: 'disconnected' },
    };
  }

  return {
    begin,
    cancel,
    disconnect,
    getPendingState: () => pending?.state || null,
    handleCallback,
  };
}

export type DesktopGoogleMailOAuth = ReturnType<typeof createDesktopGoogleMailOAuth>;
