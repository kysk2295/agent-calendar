export type GoogleCalendarOAuthCallback = Readonly<{
  kind: 'google-calendar-callback';
  code: string;
  state: string;
}>;

export type PublicGoogleCalendarSource = Readonly<{
  id: string;
  provider: 'google';
  label: string;
  status: string;
  lastSyncedAt: string;
}>;

export type DesktopGoogleCalendarOAuthResult = Readonly<{
  ok: true;
  source: PublicGoogleCalendarSource;
  sync: Readonly<{
    ok: boolean;
    error?: string;
  }>;
}>;

export type DesktopGoogleCalendarOAuthOptions = Readonly<{
  apiBaseUrl: () => string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  timeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

type PendingAttempt = {
  state: string;
  timer: NodeJS.Timeout;
  resolve: (result: DesktopGoogleCalendarOAuthResult) => void;
  reject: (error: Error) => void;
};

export class DesktopGoogleCalendarOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'DesktopGoogleCalendarOAuthError';
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

function publicSource(value: unknown): PublicGoogleCalendarSource {
  const source = objectValue(value);
  const id = stringValue(source.id);
  const provider = stringValue(source.provider);
  if (!id || provider !== 'google') {
    throw new DesktopGoogleCalendarOAuthError(
      'Google Calendar 연결 응답이 올바르지 않습니다.',
      'GOOGLE_CALENDAR_SOURCE_INVALID',
      502,
    );
  }
  return {
    id,
    provider: 'google',
    label: stringValue(source.label) || 'Google Calendar',
    status: stringValue(source.status) || 'connected',
    lastSyncedAt: stringValue(source.lastSyncedAt || source.last_synced_at),
  };
}

function responseError(status: number, payload: JsonRecord): DesktopGoogleCalendarOAuthError {
  const code = stringValue(payload.error) || `HTTP_${status}`;
  if (
    status === 503
    || [
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'GOOGLE_VAULT_KEY_REQUIRED',
      'EXTERNAL_CALENDAR_DISABLED',
    ].includes(code)
  ) {
    return new DesktopGoogleCalendarOAuthError(
      'Google Calendar 연결을 사용할 수 없습니다. 관리자 설정을 확인하세요.',
      code,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new DesktopGoogleCalendarOAuthError(
      'Google Calendar 연결을 계속하려면 다시 로그인하세요.',
      code,
      status,
    );
  }
  return new DesktopGoogleCalendarOAuthError(
    `Google Calendar 연결에 실패했습니다 (${code}).`,
    code,
    status,
  );
}

function validAuthorizationUrl(value: string): boolean {
  if (!value || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}

export function createDesktopGoogleCalendarOAuth(
  options: DesktopGoogleCalendarOAuthOptions,
) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let pending: PendingAttempt | null = null;

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<JsonRecord> => {
    const token = await options.getAccessToken();
    if (!token) {
      throw new DesktopGoogleCalendarOAuthError(
        'Google Calendar 연결을 계속하려면 로그인이 필요합니다.',
        'AUTH_REQUIRED',
        401,
      );
    }
    const base = options.apiBaseUrl().replace(/\/+$/g, '');
    if (!base || !URL.canParse(base)) {
      throw new DesktopGoogleCalendarOAuthError(
        'Agent Calendar 서버 주소가 올바르지 않습니다.',
        'API_BASE_URL_INVALID',
        500,
      );
    }
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok || payload.ok === false) throw responseError(response.status, payload);
    return payload;
  };

  function cancel(message = 'Google Calendar 연결이 취소되었습니다.') {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(new DesktopGoogleCalendarOAuthError(message, 'OAUTH_CANCELLED', 499));
  }

  async function begin(): Promise<DesktopGoogleCalendarOAuthResult> {
    cancel('이전 Google Calendar 연결 시도가 취소되었습니다.');
    const payload = await request('/api/calendar/sources/google/authorize', {
      method: 'POST',
      body: '{}',
    });
    const state = stringValue(payload.state);
    const authorizationUrl = stringValue(payload.authorizationUrl || payload.url);
    if (!state || !validAuthorizationUrl(authorizationUrl)) {
      throw new DesktopGoogleCalendarOAuthError(
        'Google Calendar 연결 시작 응답이 올바르지 않습니다.',
        'GOOGLE_OAUTH_START_INVALID',
        502,
      );
    }

    return new Promise<DesktopGoogleCalendarOAuthResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.state !== state) return;
        pending = null;
        reject(new DesktopGoogleCalendarOAuthError(
          'Google Calendar 연결 시간이 초과되었습니다.',
          'GOOGLE_OAUTH_TIMEOUT',
          408,
        ));
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

  async function handleCallback(
    callback: GoogleCalendarOAuthCallback,
  ): Promise<DesktopGoogleCalendarOAuthResult> {
    if (!pending) {
      throw new DesktopGoogleCalendarOAuthError(
        '진행 중인 Google Calendar 연결이 없습니다.',
        'GOOGLE_OAUTH_NOT_PENDING',
        400,
      );
    }
    if (callback.state !== pending.state) {
      throw new DesktopGoogleCalendarOAuthError(
        'Google Calendar 연결 state 검증에 실패했습니다.',
        'GOOGLE_OAUTH_STATE_MISMATCH',
        400,
      );
    }

    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    try {
      const completed = await request('/api/calendar/sources/google/callback', {
        method: 'POST',
        body: JSON.stringify({
          code: callback.code,
          state: callback.state,
        }),
      });
      const connectedSource = publicSource(completed.source);
      let sync: DesktopGoogleCalendarOAuthResult['sync'] = { ok: true };
      try {
        await request(`/api/calendar/sources/${encodeURIComponent(connectedSource.id)}/sync`, {
          method: 'POST',
          body: JSON.stringify({ full: false }),
        });
      } catch (error) {
        sync = {
          ok: false,
          error: error instanceof Error ? error.message : '첫 동기화 실패',
        };
      }
      const listed = await request('/api/calendar/sources');
      const sources = Array.isArray(listed.sources) ? listed.sources : [];
      const latest = sources
        .filter((source) => stringValue(objectValue(source).provider) === 'google')
        .map(publicSource)
        .find((source) => source.id === connectedSource.id)
        || connectedSource;
      const result: DesktopGoogleCalendarOAuthResult = {
        ok: true,
        source: latest,
        sync,
      };
      current.resolve(result);
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      current.reject(failure);
      throw failure;
    }
  }

  return {
    begin,
    handleCallback,
    cancel,
    getPendingState: () => pending?.state || null,
  };
}

export type DesktopGoogleCalendarOAuth = ReturnType<
  typeof createDesktopGoogleCalendarOAuth
>;
