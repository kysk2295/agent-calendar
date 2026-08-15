export type AgentCalendarSessionDeepLink = Readonly<{
  kind: 'session';
  sessionId: string;
}>;

export type AgentCalendarAuthCallbackDeepLink = Readonly<{
  kind: 'auth-callback';
  code: string;
  state: string;
}>;

export type AgentCalendarGoogleCallbackDeepLink = Readonly<{
  kind: 'google-calendar-callback';
  code: string;
  state: string;
}>;

export type AgentCalendarGoogleMailCallbackDeepLink = Readonly<{
  kind: 'google-mail-callback';
  code: string;
  state: string;
}>;

export type AgentCalendarDeepLink =
  | AgentCalendarSessionDeepLink
  | AgentCalendarAuthCallbackDeepLink
  | AgentCalendarGoogleCallbackDeepLink
  | AgentCalendarGoogleMailCallbackDeepLink;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const OAUTH_VALUE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

function hasDuplicateQueryKeys(search: string): boolean {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return false;
  const seen = new Set<string>();
  for (const part of raw.split('&')) {
    if (!part) continue;
    let key = '';
    try {
      key = decodeURIComponent(part.split('=')[0] || '');
    } catch {
      return true;
    }
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Parse work-session deep links: agent-calendar://sessions/<sessionId>
 * Strict: no credentials, port, query, hash, or extra path segments.
 */
export function parseAgentCalendarSessionDeepLink(value: unknown): AgentCalendarSessionDeepLink | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'agent-calendar:'
    || url.hostname !== 'sessions'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) return null;
  const sessionId = url.pathname.startsWith('/') ? url.pathname.slice(1) : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  if (sessionId.includes('/')) return null;
  return { kind: 'session', sessionId };
}

/**
 * Parse AuthKit callback: agent-calendar://auth/callback?code=...&state=...
 * Strict: exact host/path, only code+state, reject credentials/port/hash/duplicates/unknown params.
 */
export function parseAgentCalendarAuthCallbackDeepLink(value: unknown): AgentCalendarAuthCallbackDeepLink | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'agent-calendar:') return null;
  if (url.username || url.password || url.port || url.hash) return null;

  // Accept host "auth" with path "/callback" (agent-calendar://auth/callback)
  // or host empty with path "//auth/callback" depending on URL parser.
  const host = url.hostname;
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  const isAuthHost = host === 'auth' && (path === '/callback' || path === '/callback/');
  const isAuthPath = (!host || host === '') && (path === '/auth/callback' || path === '//auth/callback');
  if (!isAuthHost && !isAuthPath) return null;

  if (hasDuplicateQueryKeys(url.search)) return null;

  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2) return null;
  const keySet = new Set(keys);
  if (!keySet.has('code') || !keySet.has('state')) return null;

  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!OAUTH_VALUE_PATTERN.test(code) || !OAUTH_VALUE_PATTERN.test(state)) return null;
  return { kind: 'auth-callback', code, state };
}

export function parseAgentCalendarGoogleCallbackDeepLink(
  value: unknown,
): AgentCalendarGoogleCallbackDeepLink | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'agent-calendar:') return null;
  if (url.username || url.password || url.port || url.hash) return null;
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  if (
    url.hostname !== 'calendar'
    || (path !== '/google/callback' && path !== '/google/callback/')
  ) return null;
  if (hasDuplicateQueryKeys(url.search)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2) return null;
  const keySet = new Set(keys);
  if (!keySet.has('code') || !keySet.has('state')) return null;
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!OAUTH_VALUE_PATTERN.test(code) || !OAUTH_VALUE_PATTERN.test(state)) return null;
  return { kind: 'google-calendar-callback', code, state };
}

export function parseAgentCalendarGoogleMailCallbackDeepLink(
  value: unknown,
): AgentCalendarGoogleMailCallbackDeepLink | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'agent-calendar:') return null;
  if (url.username || url.password || url.port || url.hash) return null;
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  if (url.hostname !== 'mail' || (path !== '/google/callback' && path !== '/google/callback/')) return null;
  if (hasDuplicateQueryKeys(url.search)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2) return null;
  const keySet = new Set(keys);
  if (!keySet.has('code') || !keySet.has('state')) return null;
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!OAUTH_VALUE_PATTERN.test(code) || !OAUTH_VALUE_PATTERN.test(state)) return null;
  return { kind: 'google-mail-callback', code, state };
}

export function parseAgentCalendarDeepLink(value: unknown): AgentCalendarDeepLink | null {
  return parseAgentCalendarAuthCallbackDeepLink(value)
    || parseAgentCalendarGoogleCallbackDeepLink(value)
    || parseAgentCalendarGoogleMailCallbackDeepLink(value)
    || parseAgentCalendarSessionDeepLink(value);
}

export function findAgentCalendarDeepLink(values: readonly unknown[]): AgentCalendarDeepLink | null {
  for (const value of values) {
    const target = parseAgentCalendarDeepLink(value);
    if (target) return target;
  }
  return null;
}

export function findAgentCalendarAuthCallback(values: readonly unknown[]): AgentCalendarAuthCallbackDeepLink | null {
  for (const value of values) {
    const target = parseAgentCalendarAuthCallbackDeepLink(value);
    if (target) return target;
  }
  return null;
}

export {
  createDesktopGoogleCalendarOAuth,
  DesktopGoogleCalendarOAuthError,
  type DesktopGoogleCalendarOAuth,
  type DesktopGoogleCalendarOAuthOptions,
  type DesktopGoogleCalendarOAuthResult,
  type PublicGoogleCalendarSource,
} from './calendarOAuth.js';

export {
  createDesktopGoogleMailOAuth,
  DesktopGoogleMailOAuthError,
  type DesktopGoogleMailOAuth,
  type DesktopGoogleMailOAuthOptions,
  type DesktopGoogleMailOAuthResult,
  type GoogleMailOAuthCallback,
} from './mailOAuth.js';
