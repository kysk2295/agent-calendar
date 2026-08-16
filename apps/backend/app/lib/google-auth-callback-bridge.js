'use strict';

/**
 * Google is configured with a web client, so consent returns to an https redirect URI on this
 * gateway. The Desktop app can only receive the authorization code through its own deep link,
 * and its parser accepts exactly `agent-calendar://auth/callback?code=...&state=...` with two
 * parameters and nothing else.
 *
 * This bridge is that single hop. It never takes the destination from the request, so it
 * cannot be used as an open redirect, and it refuses anything the Desktop parser would reject
 * rather than bouncing a value the app will silently drop.
 *
 * The code stays useless on its own: it is exchanged later by
 * POST /api/phase1/auth/desktop/complete using the PKCE verifier the app kept.
 */

const CALLBACK_PATH = '/api/auth/google/callback';
const AUTH_DEEP_LINK_BASE = 'agent-calendar://auth/callback';
const CALENDAR_DEEP_LINK_BASE = 'agent-calendar://calendar/google/callback';
const MAIL_DEEP_LINK_BASE = 'agent-calendar://mail/google/callback';
/** Mirrors the separate code/state patterns in apps/desktop/electron/deepLink.ts. */
const OAUTH_CODE = /^[A-Za-z0-9._~\/-]{1,512}$/;
const OAUTH_STATE = /^[A-Za-z0-9._~-]{1,512}$/;

function isGoogleAuthCallbackPath(pathname = '') {
  return pathname === CALLBACK_PATH;
}

function singleValue(params, key) {
  const all = params.getAll(key);
  return all.length === 1 ? all[0] : '';
}

/**
 * @param {URLSearchParams} params
 * @returns {{ ok: true, location: string } | { ok: false, status: number, error: string }}
 */
function resolveGoogleAuthCallback(params) {
  const reject = (error) => ({ ok: false, status: 400, error });

  const error = singleValue(params, 'error');
  if (error) return reject(OAUTH_STATE.test(error) ? error : 'invalid_request');

  if (params.getAll('code').length > 1 || params.getAll('state').length > 1) {
    return reject('duplicate_parameter');
  }
  const code = singleValue(params, 'code');
  const state = singleValue(params, 'state');
  if (!OAUTH_CODE.test(code) || !OAUTH_STATE.test(state)) return reject('invalid_request');

  const destination = state.startsWith('calendar.')
    ? CALENDAR_DEEP_LINK_BASE
    : state.startsWith('mail.')
      ? MAIL_DEEP_LINK_BASE
      : AUTH_DEEP_LINK_BASE;
  const location = new URL(destination);
  location.searchParams.set('code', code);
  location.searchParams.set('state', state);
  return { ok: true, location: location.toString() };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page(title, detail) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6">`
    + `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>`
    + `<p style="color:#555">${escapeHtml(detail)}</p></body></html>`;
}

/**
 * Writes the browser response for Google's redirect. Returns true when handled.
 */
function handleGoogleAuthCallback(req, res, requestUrl) {
  if (!isGoogleAuthCallbackPath(requestUrl.pathname || '')) return false;
  if ((req.method || 'GET') !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/html; charset=utf-8', allow: 'GET' });
    res.end(page('지원하지 않는 요청입니다', '이 주소는 Google 로그인 완료 시에만 사용됩니다.'));
    return true;
  }

  const resolved = resolveGoogleAuthCallback(requestUrl.searchParams);
  if (!resolved.ok) {
    res.writeHead(resolved.status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(page(
      '로그인을 완료하지 못했습니다',
      resolved.error === 'access_denied'
        ? 'Google 로그인이 취소되었습니다. Agent Calendar에서 다시 시도해 주세요.'
        : '로그인 응답이 올바르지 않습니다. Agent Calendar에서 다시 시도해 주세요.',
    ));
    return true;
  }

  res.writeHead(302, {
    location: resolved.location,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(page('Agent Calendar로 돌아갑니다', '앱이 열리지 않으면 이 창을 닫고 앱에서 다시 시도해 주세요.'));
  return true;
}

module.exports = {
  CALLBACK_PATH,
  handleGoogleAuthCallback,
  isGoogleAuthCallbackPath,
  resolveGoogleAuthCallback,
};
