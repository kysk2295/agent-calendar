'use strict';

/**
 * Google Calendar adapter interface.
 * Fake: deterministic in-memory store for tests/ETE.
 * Real: fetch-based production path with injectable credentialVault; fails closed without OAuth/vault.
 */

const crypto = require('node:crypto');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function digestToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** Google Calendar custom event IDs: base32hex alphabet, length 5–1024. */
const GOOGLE_EVENT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';
const GOOGLE_EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;

function isAllowedGoogleEventId(id) {
  return typeof id === 'string' && GOOGLE_EVENT_ID_RE.test(id);
}

/**
 * Deterministic Google-compatible event id from workspace/source/idempotency key.
 * SHA-256 → base32hex (lowercase a-v0-9). Always length >= 5.
 * Authority for fencing remains DB/advisory locks; this is defense-in-depth for provider id.
 */
function deterministicGoogleEventId({
  workspaceId = '',
  sourceId = '',
  idempotencyKey = '',
  length = 32,
} = {}) {
  const material = `${String(workspaceId)}\n${String(sourceId)}\n${String(idempotencyKey)}`;
  const hash = crypto.createHash('sha256').update(material, 'utf8').digest();
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += GOOGLE_EVENT_ID_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += GOOGLE_EVENT_ID_ALPHABET[(value << (5 - bits)) & 31];
  }
  const target = Math.min(1024, Math.max(5, Number(length) || 32));
  // SHA-256 yields 256 bits → 52 base32hex chars; pad if ever short.
  while (output.length < target) {
    output += GOOGLE_EVENT_ID_ALPHABET[0];
  }
  return output.slice(0, target);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Expand simple RRULE weekly/daily into instances with timezone wall-clock preservation via Temporal-less Intl offset walk. */
function expandSeriesLocal({
  startDateTime,
  endDateTime,
  timeZone = 'UTC',
  rrule,
  rangeStartMs,
  rangeEndMs,
  max = 400,
}) {
  const freq = /FREQ=WEEKLY/i.test(rrule || '') ? 'WEEKLY' : /FREQ=DAILY/i.test(rrule || '') ? 'DAILY' : null;
  if (!freq) return [];
  const countMatch = /COUNT=(\d+)/i.exec(rrule || '');
  const count = countMatch ? Number(countMatch[1]) : 52;
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  const durationMs = end.getTime() - start.getTime();
  // Extract local wall components in the event timezone.
  const partsOf = (d) => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const map = Object.fromEntries(fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour === '24' ? '0' : map.hour),
      minute: Number(map.minute),
      second: Number(map.second),
    };
  };
  // Find UTC instant for a local wall time in zone via binary search.
  const utcForLocal = (y, m, d, h, mi, s) => {
    let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
    let hi = Date.UTC(y, m - 1, d + 1, 23, 59, 59);
    const target = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    for (let i = 0; i < 40; i += 1) {
      const mid = Math.floor((lo + hi) / 2);
      const p = partsOf(new Date(mid));
      const cur = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
      if (cur === target) return mid;
      if (cur < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo;
  };

  const base = partsOf(start);
  const out = [];
  let y = base.year;
  let m = base.month;
  let d = base.day;
  for (let n = 0; n < count && out.length < max; n += 1) {
    const startMs = utcForLocal(y, m, d, base.hour, base.minute, base.second);
    const endMs = startMs + durationMs;
    if (startMs < rangeEndMs && endMs > rangeStartMs) {
      out.push({
        startMs,
        endMs,
        startDateTime: new Date(startMs).toISOString().replace(/Z$/, '') + (timeZone === 'UTC' ? 'Z' : ''),
        // Keep RFC3339 with offset computed from actual instant
        start: { dateTime: new Date(startMs).toISOString(), timeZone },
        end: { dateTime: new Date(endMs).toISOString(), timeZone },
      });
    }
    // Advance local calendar day/week
    const step = freq === 'WEEKLY' ? 7 : 1;
    const dt = new Date(Date.UTC(y, m - 1, d + step));
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
    // Stop if well past range
    if (Date.UTC(y, m - 1, d) > rangeEndMs + 14 * 86400000) break;
  }
  return out;
}

function createFakeGoogleCalendarAdapter({ clock = () => Date.now(), pageSize = 50 } = {}) {
  /** @type {Map<string, any>} */
  const grants = new Map();
  /** @type {Map<string, any>} */
  const watches = new Map();

  function grant(credentialRef) {
    if (!grants.has(credentialRef)) {
      grants.set(credentialRef, {
        accessToken: `atok_${credentialRef}`,
        refreshToken: `rtok_${credentialRef}`,
        calendars: [{ id: 'primary', summary: 'Fake Primary', timeZone: 'Asia/Seoul', accessRole: 'owner' }],
        eventsByCal: new Map([['primary', []]]),
        syncTokens: new Map(),
        pageSize,
        revoked: false,
      });
    }
    return grants.get(credentialRef);
  }

  return {
    id: 'fake-google',
    setPageSize(credentialRef, size) {
      grant(credentialRef).pageSize = size;
    },
    async createGrant({ workspaceId, email = 'user@example.com' } = {}) {
      const credentialRef = `cred_fake_${workspaceId}_${crypto.randomBytes(4).toString('hex')}`;
      grant(credentialRef);
      return { ok: true, credentialRef, email };
    },
    async listCalendars({ credentialRef }) {
      const g = grant(credentialRef);
      return { ok: true, calendars: g.calendars.map((c) => ({ ...c })) };
    },
    async listMailMessages() {
      return { ok: true, messages: [] };
    },
    async seedEvents({ credentialRef, calendarId = 'primary', events = [] }) {
      const g = grant(credentialRef);
      const list = g.eventsByCal.get(calendarId) || [];
      for (const e of events) {
        list.push({
          id: e.id || newId('gev'),
          status: e.status || 'confirmed',
          summary: e.summary || e.title || 'Event',
          start: e.start,
          end: e.end,
          etag: e.etag || `"etag_${crypto.randomBytes(3).toString('hex')}"`,
          recurringEventId: e.recurringEventId || '',
          recurrence: e.recurrence || null,
          updated: new Date(clock()).toISOString(),
        });
      }
      g.eventsByCal.set(calendarId, list);
      return { ok: true, count: list.length };
    },
    async listEvents({
      credentialRef,
      calendarId = 'primary',
      syncToken = '',
      pageToken = '',
      timeMin = '',
      timeMax = '',
      showDeleted = true,
      singleEvents = false,
    } = {}) {
      const g = grant(credentialRef);
      if (g.revoked) {
        const err = new Error('revoked');
        err.code = 'GOOGLE_AUTH_REVOKED';
        err.statusHint = 401;
        throw err;
      }
      if (syncToken && (timeMin || timeMax)) {
        const err = new Error('syncToken cannot be combined with timeMin/timeMax');
        err.code = 'GOOGLE_INVALID_SYNC_PARAMS';
        err.statusHint = 400;
        throw err;
      }
      if (syncToken && syncToken === 'invalid') {
        const err = new Error('Gone');
        err.code = 'GOOGLE_SYNC_TOKEN_INVALID';
        err.status = 410;
        err.statusHint = 410;
        throw err;
      }

      let items = [...(g.eventsByCal.get(calendarId) || [])];
      if (!showDeleted) items = items.filter((e) => e.status !== 'cancelled');

      if (singleEvents) {
        const rangeStartMs = timeMin ? Date.parse(timeMin) : clock() - 30 * 86400000;
        const rangeEndMs = timeMax ? Date.parse(timeMax) : clock() + 60 * 86400000;
        const expanded = [];
        for (const e of items) {
          const rrule = Array.isArray(e.recurrence) ? e.recurrence.join(';') : (e.recurrence || '');
          if (rrule && /FREQ=/i.test(rrule)) {
            const startDt = e.start?.dateTime || e.start?.date;
            const endDt = e.end?.dateTime || e.end?.date;
            const tz = e.start?.timeZone || e.end?.timeZone || 'UTC';
            const occs = expandSeriesLocal({
              startDateTime: startDt,
              endDateTime: endDt,
              timeZone: tz,
              rrule,
              rangeStartMs,
              rangeEndMs,
            });
            for (const o of occs) {
              expanded.push({
                id: `${e.id}_${o.startMs}`,
                status: e.status,
                summary: e.summary,
                start: o.start,
                end: o.end,
                etag: e.etag,
                recurringEventId: e.id,
                originalStartTime: o.start,
                updated: e.updated,
              });
            }
          } else {
            expanded.push(e);
          }
        }
        items = expanded;
      }

      if (timeMin || timeMax) {
        const minMs = timeMin ? Date.parse(timeMin) : -Infinity;
        const maxMs = timeMax ? Date.parse(timeMax) : Infinity;
        items = items.filter((e) => {
          const s = Date.parse(e.start?.dateTime || e.start?.date || e.startsAt || 0);
          const en = Date.parse(e.end?.dateTime || e.end?.date || e.endsAt || s);
          return s < maxMs && en > minMs;
        });
      }

      const size = g.pageSize || pageSize || 50;
      let start = 0;
      if (pageToken) {
        const n = Number(String(pageToken).replace('page_', ''));
        start = Number.isFinite(n) ? n : 0;
      }
      const slice = items.slice(start, start + size);
      const nextStart = start + size;
      const hasMore = nextStart < items.length;
      const nextSyncToken = hasMore ? '' : `sync_${calendarId}_${items.length}_${clock()}`;
      if (nextSyncToken) g.syncTokens.set(calendarId, nextSyncToken);
      return {
        ok: true,
        items: slice,
        nextPageToken: hasMore ? `page_${nextStart}` : '',
        nextSyncToken: hasMore ? undefined : nextSyncToken,
      };
    },
    async createEvent({ credentialRef, calendarId = 'primary', event, idempotencyKey = '' } = {}) {
      const g = grant(credentialRef);
      const list = g.eventsByCal.get(calendarId) || [];
      if (idempotencyKey) {
        const existing = list.find((e) => e.clientIdempotencyKey === idempotencyKey);
        if (existing) return { ok: true, event: { ...existing }, replay: true };
      }
      let id = event && event.id;
      if (!isAllowedGoogleEventId(id) && idempotencyKey) {
        // Prefer caller-supplied allowed id; otherwise derive if workspace/source provided.
        const derived = event && event.workspaceId != null
          ? deterministicGoogleEventId({
            workspaceId: event.workspaceId,
            sourceId: event.sourceId || '',
            idempotencyKey,
          })
          : null;
        id = isAllowedGoogleEventId(derived) ? derived : null;
      }
      if (!isAllowedGoogleEventId(id)) {
        // Last resort: random allowed base32hex (not from raw key slug — wxyz would be illegal).
        id = deterministicGoogleEventId({
          workspaceId: 'local',
          sourceId: 'fake',
          idempotencyKey: idempotencyKey || newId('gev'),
        });
      }
      const created = {
        id,
        status: 'confirmed',
        summary: event.summary || event.title || 'Untitled',
        start: event.start,
        end: event.end,
        etag: `"etag_${crypto.randomBytes(3).toString('hex')}"`,
        clientIdempotencyKey: idempotencyKey || '',
        updated: new Date(clock()).toISOString(),
      };
      list.push(created);
      g.eventsByCal.set(calendarId, list);
      return { ok: true, event: created, replay: false };
    },
    async updateEvent({ credentialRef, calendarId = 'primary', eventId, event, ifMatch = '' } = {}) {
      const g = grant(credentialRef);
      const list = g.eventsByCal.get(calendarId) || [];
      const idx = list.findIndex((e) => e.id === eventId);
      if (idx < 0) {
        const err = new Error('not found');
        err.code = 'GOOGLE_NOT_FOUND';
        err.statusHint = 404;
        throw err;
      }
      const current = list[idx];
      if (ifMatch && current.etag && ifMatch !== current.etag) {
        const err = new Error('etag mismatch');
        err.code = 'GOOGLE_ETAG_CONFLICT';
        err.statusHint = 409;
        throw err;
      }
      const updated = {
        ...current,
        summary: event.summary != null ? event.summary : current.summary,
        start: event.start || current.start,
        end: event.end || current.end,
        etag: `"etag_${crypto.randomBytes(3).toString('hex')}"`,
        updated: new Date(clock()).toISOString(),
      };
      list[idx] = updated;
      return { ok: true, event: updated };
    },
    async deleteEvent({ credentialRef, calendarId = 'primary', eventId, ifMatch = '' } = {}) {
      const g = grant(credentialRef);
      const list = g.eventsByCal.get(calendarId) || [];
      const idx = list.findIndex((e) => e.id === eventId);
      if (idx < 0) {
        const err = new Error('not found');
        err.code = 'GOOGLE_NOT_FOUND';
        err.statusHint = 404;
        throw err;
      }
      if (ifMatch && list[idx].etag && ifMatch !== list[idx].etag) {
        const err = new Error('etag mismatch');
        err.code = 'GOOGLE_ETAG_CONFLICT';
        err.statusHint = 409;
        throw err;
      }
      list[idx] = { ...list[idx], status: 'cancelled', updated: new Date(clock()).toISOString() };
      return { ok: true, deleted: true };
    },
    async watch({ credentialRef, calendarId = 'primary', channelId, token, address }) {
      grant(credentialRef);
      const resourceId = `res_${crypto.randomBytes(4).toString('hex')}`;
      const expiration = new Date(clock() + 7 * 86400000).toISOString();
      watches.set(channelId, {
        credentialRef, calendarId, channelId, token, resourceId, address, expiration,
      });
      return { ok: true, channelId, resourceId, expiration };
    },
    async stopChannel({ channelId }) {
      watches.delete(channelId);
      return { ok: true };
    },
    async revoke({ credentialRef }) {
      const g = grant(credentialRef);
      g.revoked = true;
      return { ok: true };
    },
    invalidateSyncToken({ credentialRef, calendarId = 'primary' }) {
      grant(credentialRef).syncTokens.set(calendarId, 'invalid');
    },
  };
}

function createRealGoogleCalendarAdapter({
  env = process.env,
  fetchImpl = fetch,
  credentialVault = null,
  clock = () => Date.now(),
  maxRetries = 3,
  totalTimeoutMs = 30_000,
} = {}) {
  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.GOOGLE_OAUTH_REDIRECT_URI || env.GOOGLE_REDIRECT_URI || '').trim();

  function assertConfigured() {
    if (!clientId || !clientSecret || !redirectUri) {
      const err = new Error('Google OAuth is not configured');
      err.code = 'GOOGLE_OAUTH_NOT_CONFIGURED';
      err.statusHint = 503;
      throw err;
    }
  }

  function assertVault() {
    if (!credentialVault || typeof credentialVault.getTokens !== 'function') {
      const err = new Error('Vault-backed access token required');
      err.code = 'GOOGLE_CREDENTIAL_VAULT_REQUIRED';
      err.statusHint = 503;
      throw err;
    }
  }

  async function fetchWithRetry(url, options = {}, { retryOn = [429, 500, 502, 503, 504] } = {}) {
    const started = clock();
    let attempt = 0;
    let lastErr;
    while (attempt <= maxRetries) {
      if (clock() - started > totalTimeoutMs) {
        const err = new Error('google request timeout');
        err.code = 'GOOGLE_TIMEOUT';
        err.statusHint = 504;
        throw err;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(url, options);
        if (res.ok) return res;
        const status = res.status;
        // Never retry 4xx except we only allow 429 in retryOn.
        if (!retryOn.includes(status) || (status < 500 && status !== 429)) {
          const json = await res.json().catch(() => ({}));
          const isEtag = status === 409 || status === 412;
          const err = new Error(json.error?.message || json.error || `google_http_${status}`);
          err.code = isEtag ? 'GOOGLE_ETAG_CONFLICT' : status === 401 ? 'GOOGLE_AUTH_FAILED' : 'GOOGLE_HTTP_ERROR';
          err.status = status;
          err.statusHint = isEtag ? 409 : status >= 500 ? 502 : status;
          throw err;
        }
        lastErr = new Error(`retryable_${status}`);
        lastErr.status = status;
      } catch (error) {
        if (error && error.statusHint && error.statusHint < 500 && error.status !== 429) throw error;
        lastErr = error;
      }
      attempt += 1;
      const backoff = Math.min(4000, 200 * (2 ** attempt)) + Math.floor(Math.random() * 50);
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoff);
    }
    const err = lastErr || new Error('google_request_failed');
    err.code = err.code || 'GOOGLE_RETRY_EXHAUSTED';
    err.statusHint = err.statusHint || 502;
    throw err;
  }

  async function resolveAccessToken(credentialRef) {
    assertVault();
    let tokens = await credentialVault.getTokens(credentialRef);
    if (!tokens || !tokens.accessToken) {
      const err = new Error('Vault-backed access token required');
      err.code = 'GOOGLE_CREDENTIAL_VAULT_REQUIRED';
      err.statusHint = 503;
      throw err;
    }
    const exp = tokens.accessExpiresAt ? Date.parse(tokens.accessExpiresAt) : 0;
    if (exp && exp < clock() + 30_000 && tokens.refreshToken) {
      assertConfigured();
      const res = await fetchWithRetry(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: tokens.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      }, { retryOn: [429, 500, 502, 503, 504] });
      const json = await res.json();
      tokens = {
        accessToken: json.access_token,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: new Date(clock() + (Number(json.expires_in) || 3600) * 1000).toISOString(),
      };
      if (typeof credentialVault.putTokens === 'function') {
        await credentialVault.putTokens(credentialRef, tokens);
      }
    }
    return tokens.accessToken;
  }

  async function authedJson(pathUrl, { credentialRef, method = 'GET', headers = {}, body } = {}) {
    const access = await resolveAccessToken(credentialRef);
    const res = await fetchWithRetry(pathUrl, {
      method,
      headers: {
        authorization: `Bearer ${access}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  return {
    id: 'real-google',
    fetchImpl,
    credentialVault,
    getAuthorizationUrl({ state, codeChallenge, purpose = 'calendar' }) {
      assertConfigured();
      const scope = purpose === 'mail'
        ? 'https://www.googleapis.com/auth/gmail.readonly'
        : 'https://www.googleapis.com/auth/calendar';
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', scope);
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('state', state);
      if (codeChallenge) {
        u.searchParams.set('code_challenge', codeChallenge);
        u.searchParams.set('code_challenge_method', 'S256');
      }
      return u.toString();
    },
    async exchangeCode({ code, codeVerifier }) {
      assertConfigured();
      const res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code || ''),
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }).toString(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(json.error || 'token_exchange_failed');
        err.code = 'GOOGLE_TOKEN_EXCHANGE_FAILED';
        err.statusHint = 502;
        throw err;
      }
      const credentialRef = `cred_google_${crypto.randomBytes(8).toString('hex')}`;
      return {
        ok: true,
        credentialRef,
        _vault: {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          expiresIn: json.expires_in,
          accessExpiresAt: new Date(clock() + (Number(json.expires_in) || 3600) * 1000).toISOString(),
        },
      };
    },
    async listCalendars({ credentialRef }) {
      assertConfigured();
      assertVault();
      const json = await authedJson(`${GOOGLE_CALENDAR_API}/users/me/calendarList`, { credentialRef });
      return { ok: true, calendars: json.items || [] };
    },
    async listMailMessages({ credentialRef, limit = 25 } = {}) {
      assertConfigured();
      assertVault();
      const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 25));
      const listUrl = new URL(`${GOOGLE_GMAIL_API}/users/me/messages`);
      listUrl.searchParams.set('maxResults', String(boundedLimit));
      listUrl.searchParams.set('q', 'in:inbox');
      const listed = await authedJson(listUrl.toString(), { credentialRef });
      const references = Array.isArray(listed.messages) ? listed.messages.slice(0, boundedLimit) : [];
      const messages = await Promise.all(references.map(async (reference) => {
        const detailUrl = new URL(`${GOOGLE_GMAIL_API}/users/me/messages/${encodeURIComponent(reference.id)}`);
        detailUrl.searchParams.set('format', 'metadata');
        for (const header of ['From', 'Subject', 'Date']) detailUrl.searchParams.append('metadataHeaders', header);
        const message = await authedJson(detailUrl.toString(), { credentialRef });
        const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
        const header = (name) => String(headers.find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value || '');
        const receivedMs = Number(message.internalDate) || Date.parse(header('Date'));
        return {
          id: String(message.id || reference.id || ''),
          threadId: String(message.threadId || reference.threadId || ''),
          from: header('From'),
          subject: header('Subject') || '(제목 없음)',
          snippet: String(message.snippet || ''),
          receivedAt: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : '',
          unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
        };
      }));
      return { ok: true, messages };
    },
    async listEvents({
      credentialRef,
      calendarId = 'primary',
      syncToken = '',
      pageToken = '',
      timeMin = '',
      timeMax = '',
      showDeleted = true,
      singleEvents = true,
    } = {}) {
      assertConfigured();
      assertVault();
      if (syncToken && (timeMin || timeMax)) {
        const err = new Error('syncToken cannot be combined with timeMin/timeMax');
        err.code = 'GOOGLE_INVALID_SYNC_PARAMS';
        err.statusHint = 400;
        throw err;
      }
      const u = new URL(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
      // singleEvents is a consistent allowed parameter for both full and incremental syncToken requests.
      u.searchParams.set('singleEvents', singleEvents !== false ? 'true' : 'false');
      if (syncToken) {
        u.searchParams.set('syncToken', syncToken);
      } else {
        if (timeMin) u.searchParams.set('timeMin', timeMin);
        if (timeMax) u.searchParams.set('timeMax', timeMax);
      }
      if (showDeleted) u.searchParams.set('showDeleted', 'true');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const access = await resolveAccessToken(credentialRef);
      const res = await fetchWithRetry(u.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${access}` },
      });
      if (res.status === 410) {
        const err = new Error('Gone');
        err.code = 'GOOGLE_SYNC_TOKEN_INVALID';
        err.status = 410;
        err.statusHint = 410;
        throw err;
      }
      const json = await res.json();
      return {
        ok: true,
        items: json.items || [],
        nextPageToken: json.nextPageToken || '',
        nextSyncToken: json.nextSyncToken,
      };
    },
    async createEvent({ credentialRef, calendarId = 'primary', event, idempotencyKey = '' } = {}) {
      assertConfigured();
      assertVault();
      const body = { ...(event || {}) };
      // Defense-in-depth: only set id when already Google-allowed base32hex (caller derives via SHA-256).
      if (body.id && !isAllowedGoogleEventId(body.id)) {
        delete body.id;
      }
      if (idempotencyKey && !body.id && event && event.workspaceId != null) {
        const derived = deterministicGoogleEventId({
          workspaceId: event.workspaceId,
          sourceId: event.sourceId || '',
          idempotencyKey,
        });
        if (isAllowedGoogleEventId(derived)) body.id = derived;
      }
      const json = await authedJson(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        { credentialRef, method: 'POST', body },
      );
      return { ok: true, event: json, replay: false };
    },
    async updateEvent({ credentialRef, calendarId = 'primary', eventId, event, ifMatch = '' } = {}) {
      assertConfigured();
      assertVault();
      const access = await resolveAccessToken(credentialRef);
      const headers = { authorization: `Bearer ${access}`, 'content-type': 'application/json' };
      if (ifMatch) headers['If-Match'] = ifMatch;
      const res = await fetchWithRetry(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'PATCH', headers, body: JSON.stringify(event) },
        { retryOn: [429, 500, 502, 503, 504] },
      );
      const json = await res.json();
      return { ok: true, event: json };
    },
    async deleteEvent({ credentialRef, calendarId = 'primary', eventId, ifMatch = '' } = {}) {
      assertConfigured();
      assertVault();
      const access = await resolveAccessToken(credentialRef);
      const headers = { authorization: `Bearer ${access}` };
      if (ifMatch) headers['If-Match'] = ifMatch;
      await fetchWithRetry(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE', headers },
        { retryOn: [429, 500, 502, 503, 504] },
      );
      return { ok: true, deleted: true };
    },
    async watch({ credentialRef, calendarId = 'primary', channelId, token, address }) {
      assertConfigured();
      assertVault();
      const json = await authedJson(
        `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
        {
          credentialRef,
          method: 'POST',
          body: {
            id: channelId,
            type: 'web_hook',
            address,
            token,
          },
        },
      );
      return {
        ok: true,
        channelId: json.id || channelId,
        resourceId: json.resourceId || '',
        expiration: json.expiration
          ? new Date(Number(json.expiration)).toISOString()
          : new Date(clock() + 7 * 86400000).toISOString(),
      };
    },
    async stopChannel({ credentialRef, channelId, resourceId }) {
      assertConfigured();
      assertVault();
      await authedJson(`${GOOGLE_CALENDAR_API}/channels/stop`, {
        credentialRef,
        method: 'POST',
        body: { id: channelId, resourceId },
      });
      return { ok: true };
    },
    async revoke({ credentialRef }) {
      assertVault();
      const tokens = await credentialVault.getTokens(credentialRef);
      if (tokens?.refreshToken || tokens?.accessToken) {
        const res = await fetchWithRetry(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokens.refreshToken || tokens.accessToken }).toString(),
        }, { retryOn: [429, 500, 502, 503, 504] });
        if (!res.ok && res.status !== 200) {
          const err = new Error('revoke failed');
          err.code = 'GOOGLE_REVOKE_FAILED';
          err.statusHint = 502;
          throw err;
        }
      }
      // Only delete vault credentials after successful revoke.
      if (typeof credentialVault.revoke === 'function') await credentialVault.revoke(credentialRef);
      return { ok: true };
    },
  };
}

function resolveGoogleCalendarAdapter({ env = process.env, fake = null, credentialVault = null, fetchImpl = fetch } = {}) {
  if (fake) return fake;
  if (env.AGENT_CALENDAR_FAKE_GOOGLE === '1' || env.UNIFIED_CALENDAR_FAKE_GOOGLE === '1') {
    return createFakeGoogleCalendarAdapter();
  }
  return createRealGoogleCalendarAdapter({ env, credentialVault, fetchImpl });
}

module.exports = {
  createFakeGoogleCalendarAdapter,
  createRealGoogleCalendarAdapter,
  resolveGoogleCalendarAdapter,
  digestToken,
  deterministicGoogleEventId,
  isAllowedGoogleEventId,
  expandSeriesLocal,
  GOOGLE_CALENDAR_API,
  GOOGLE_GMAIL_API,
  GOOGLE_EVENT_ID_RE,
};
