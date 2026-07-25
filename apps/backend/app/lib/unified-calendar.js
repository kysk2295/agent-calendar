'use strict';

/**
 * Unified Calendar service: exact range queries + Google source sync/mutation.
 * App-role Workspace RLS for user paths; never stores provider tokens.
 */

const crypto = require('node:crypto');
const { assertWorkspaceScope, resolveWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const {
  createFakeGoogleCalendarAdapter,
  createRealGoogleCalendarAdapter,
  digestToken,
  deterministicGoogleEventId,
  isAllowedGoogleEventId,
} = require('./google-calendar-adapter');
const { createDbCredentialVault, requireVaultKey } = require('./credential-vault');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function reject(code, message, statusHint = 400) {
  const err = new Error(message || code);
  err.code = code;
  err.statusHint = statusHint;
  throw err;
}

function externalEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.UNIFIED_CALENDAR_EXTERNAL_ENABLED ?? '1'));
}

function parseInstant(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Stable occurrence_key for create + sync rebuild.
 * Always `${providerEventId}:${ISO-8601 startsAt}` so create-then-sync never forks keys
 * when node-pg returns Date objects for timestamptz columns.
 */
function canonicalOccurrenceKey(providerEventId, startsAt) {
  const id = String(providerEventId || '');
  const ms = parseInstant(startsAt);
  const iso = ms == null ? String(startsAt || '') : toIso(ms);
  return `${id}:${iso}`;
}

function googleEventToBounds(item) {
  const start = item.start || {};
  const end = item.end || {};
  const allDay = Boolean(start.date && !start.dateTime);
  let startsAt;
  let endsAt;
  if (allDay) {
    startsAt = `${start.date}T00:00:00.000Z`;
    const endDate = end.date || start.date;
    // Google all-day end is exclusive; store exclusive end at 00:00 UTC of end date.
    endsAt = `${endDate}T00:00:00.000Z`;
  } else {
    startsAt = start.dateTime || item.startsAt || new Date().toISOString();
    endsAt = end.dateTime || item.endsAt || startsAt;
  }
  return { allDay, startsAt, endsAt, timezone: start.timeZone || end.timeZone || 'UTC' };
}

/**
 * Expand a simple RRULE:FREQ=DAILY|WEEKLY for a bounded window.
 * Smallest correct expansion for Phase 4 tests (not full RFC 5545).
 */
function expandRecurrence({
  startsAt,
  endsAt,
  rrule,
  rangeStartMs,
  rangeEndMs,
  title,
  allDay,
  timezone,
  providerEventId,
  etag,
}) {
  if (!rrule) {
    const s = parseInstant(startsAt);
    const e = parseInstant(endsAt) || s;
    if (s == null || e == null) return [];
    if (s < rangeEndMs && e > rangeStartMs) {
      const sIso = toIso(s);
      const eIso = toIso(e);
      return [{
        occurrenceKey: canonicalOccurrenceKey(providerEventId, sIso),
        startsAt: sIso,
        endsAt: eIso,
        title,
        allDay,
        timezone,
        etag,
      }];
    }
    return [];
  }
  const freq = /FREQ=WEEKLY/i.test(rrule) ? 'WEEKLY' : /FREQ=DAILY/i.test(rrule) ? 'DAILY' : null;
  if (!freq) {
    const s = parseInstant(startsAt);
    const e = parseInstant(endsAt) || s;
    if (s != null && e != null && s < rangeEndMs && e > rangeStartMs) {
      const sIso = toIso(s);
      const eIso = toIso(e);
      return [{
        occurrenceKey: canonicalOccurrenceKey(providerEventId, sIso),
        startsAt: sIso,
        endsAt: eIso,
        title,
        allDay,
        timezone,
        etag,
      }];
    }
    return [];
  }
  const stepMs = freq === 'WEEKLY' ? 7 * 86400000 : 86400000;
  const duration = Math.max(0, (parseInstant(endsAt) || 0) - (parseInstant(startsAt) || 0));
  let cursor = parseInstant(startsAt);
  if (cursor == null) return [];
  // Walk forward from series start into range
  while (cursor + duration < rangeStartMs) cursor += stepMs;
  const out = [];
  let guard = 0;
  while (cursor < rangeEndMs && guard < 400) {
    const occEnd = cursor + duration;
    if (cursor < rangeEndMs && occEnd > rangeStartMs) {
      const sIso = toIso(cursor);
      out.push({
        occurrenceKey: canonicalOccurrenceKey(providerEventId, sIso),
        startsAt: sIso,
        endsAt: toIso(occEnd),
        title,
        allDay,
        timezone,
        etag,
      });
    }
    cursor += stepMs;
    guard += 1;
  }
  return out;
}

class UnifiedCalendar {
  constructor({
    pool,
    env = process.env,
    googleAdapter = null,
    credentialVault = null,
    fetchImpl = fetch,
    clock = () => Date.now(),
  } = {}) {
    if (!pool) throw new Error('UnifiedCalendar requires pool');
    this.pool = pool;
    this.env = env;
    this.clock = clock;
    // Production/default vault encrypts at rest and fails closed without key.
    // Tests may inject a memory vault. Fake Google mode may omit vault until OAuth finalize.
    this.credentialVault = credentialVault || (
      env.AGENT_CALENDAR_FAKE_GOOGLE === '1' || env.UNIFIED_CALENDAR_FAKE_GOOGLE === '1'
        ? null
        : createDbCredentialVault(pool, env)
    );
    this.google = googleAdapter || (
      env.AGENT_CALENDAR_FAKE_GOOGLE === '1' || env.UNIFIED_CALENDAR_FAKE_GOOGLE === '1'
        ? createFakeGoogleCalendarAdapter({ clock })
        : createRealGoogleCalendarAdapter({
          env,
          credentialVault: this.credentialVault,
          fetchImpl,
          clock,
        })
    );
    this._workerTimers = [];
  }

  // Background drain/renew/stop-retry is gated by UNIFIED_CALENDAR_BACKGROUND_WORKERS (or CALENDAR_SYNC_BACKGROUND_WORKERS).
  startBackgroundWorkers({
    drainIntervalMs = 5_000,
    watchIntervalMs = 60_000,
    stopRetryIntervalMs = 15_000,
  } = {}) {
    this.stopBackgroundWorkers();
    const drain = setInterval(() => {
      this.drainSyncRequests({ limit: 20 }).catch(() => {});
    }, drainIntervalMs);
    const watch = setInterval(() => {
      this.renewExpiringWatches({ withinMs: 2 * 60 * 60_000 }).catch(() => {});
    }, watchIntervalMs);
    // Retry provider stopChannel for watches left in status=error after failed stop (no new watches).
    const stopRetry = setInterval(() => {
      this.retryFailedWatchStops({ limit: 20 }).catch(() => {});
    }, stopRetryIntervalMs);
    if (typeof drain.unref === 'function') drain.unref();
    if (typeof watch.unref === 'function') watch.unref();
    if (typeof stopRetry.unref === 'function') stopRetry.unref();
    this._workerTimers = [drain, watch, stopRetry];
    return { ok: true, timers: this._workerTimers.length };
  }

  stopBackgroundWorkers() {
    for (const t of this._workerTimers || []) {
      try { clearInterval(t); } catch { /* ignore */ }
    }
    this._workerTimers = [];
    return { ok: true };
  }

  async listSources(scope) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select * from calendar_sources
         where workspace_id = $1
         order by provider, label, id`,
        [valid.workspaceId],
      );
      return {
        ok: true,
        workspaceId: valid.workspaceId,
        externalEnabled: externalEnabled(this.env),
        sources: result.rows.map((r) => this.#publicSource(r)),
      };
    });
  }

  async connectFakeGoogle(scope, {
    label = 'Google Calendar',
    calendarId = 'primary',
    seedDemo = true,
  } = {}) {
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    assertWorkspaceScope(scope);
    const grant = await this.google.createGrant({ workspaceId: scope.workspaceId });
    // Seed deterministic timed / all-day / recurring demo events for ETE and local QA.
    // Tokens never leave the adapter; only credential_ref is persisted.
    if (seedDemo !== false && typeof this.google.seedEvents === 'function') {
      const day = new Date();
      const y = day.getUTCFullYear();
      const mo = day.getUTCMonth();
      const da = day.getUTCDate();
      const m = String(mo + 1).padStart(2, '0');
      const d = String(da).padStart(2, '0');
      const today = `${y}-${m}-${d}`;
      const tomorrowDate = new Date(Date.UTC(y, mo, da + 1));
      const tomorrow = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getUTCDate()).padStart(2, '0')}`;
      const timedStart = new Date(Date.UTC(y, mo, da, 1, 0, 0)).toISOString();
      const timedEnd = new Date(Date.UTC(y, mo, da, 2, 0, 0)).toISOString();
      const dailyStart = new Date(Date.UTC(y, mo, da - 1, 0, 0, 0)).toISOString();
      const dailyEnd = new Date(Date.UTC(y, mo, da - 1, 0, 30, 0)).toISOString();
      await this.google.seedEvents({
        credentialRef: grant.credentialRef,
        calendarId,
        events: [
          {
            id: 'fake-timed-demo',
            summary: 'Google timed meeting',
            start: { dateTime: timedStart, timeZone: 'Asia/Seoul' },
            end: { dateTime: timedEnd, timeZone: 'Asia/Seoul' },
          },
          {
            id: 'fake-allday-demo',
            summary: 'Google all-day focus',
            start: { date: today },
            // Google all-day end is exclusive.
            end: { date: tomorrow },
          },
          {
            id: 'fake-daily-demo',
            summary: 'Google daily standup',
            start: { dateTime: dailyStart, timeZone: 'Asia/Seoul' },
            end: { dateTime: dailyEnd, timeZone: 'Asia/Seoul' },
            recurrence: ['FREQ=DAILY'],
          },
        ],
      });
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const sourceId = newId('csrc');
      await client.query(
        `insert into calendar_sources (
           id, workspace_id, provider, source_kind, label, external_calendar_id,
           credential_ref, status, writable, timezone, selected, shadow_only
         ) values ($1,$2,'google','external_calendar',$3,$4,$5,'connected', true, 'Asia/Seoul', true, false)`,
        [sourceId, valid.workspaceId, label, calendarId, grant.credentialRef],
      );
      // Never persist grant tokens — only opaque credential_ref.
      return {
        ok: true,
        source: this.#publicSource({
          id: sourceId,
          workspace_id: valid.workspaceId,
          provider: 'google',
          source_kind: 'external_calendar',
          label,
          external_calendar_id: calendarId,
          credential_ref: grant.credentialRef,
          status: 'connected',
          writable: true,
          timezone: 'Asia/Seoul',
          selected: true,
          shadow_only: false,
          last_synced_at: null,
          last_error_code: '',
          last_error_message: '',
        }),
      };
    });
  }

  async disconnectSource(scope, sourceId) {
    assertWorkspaceScope(scope);
    const id = String(sourceId || '');
    // Load source under app role (projection tables are RLS-protected).
    const loaded = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const src = await client.query(
        `select * from calendar_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, id],
      );
      if (!src.rowCount) return null;
      const watches = await client.query(
        `select * from calendar_watches where workspace_id = $1 and source_id = $2 and status = 'active'`,
        [valid.workspaceId, id],
      );
      return { source: src.rows[0], watches: watches.rows, workspaceId: valid.workspaceId };
    });
    if (!loaded) return null;
    const { source, watches, workspaceId } = loaded;
    // Provider stop/revoke outside the app-role txn so error status can commit.
    try {
      for (const w of watches) {
        if (typeof this.google.stopChannel === 'function') {
          // eslint-disable-next-line no-await-in-loop
          await this.google.stopChannel({
            credentialRef: source.credential_ref,
            channelId: w.channel_id,
            resourceId: w.resource_id,
          });
        }
      }
      if (source.credential_ref && typeof this.google.revoke === 'function') {
        await this.google.revoke({ credentialRef: source.credential_ref });
      }
    } catch (error) {
      await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        await client.query(
          `update calendar_sources
           set status = 'error',
               last_error_code = $3,
               last_error_message = $4,
               updated_at = now()
           where workspace_id = $1 and id = $2`,
          [
            valid.workspaceId,
            id,
            error.code || 'DISCONNECT_PROVIDER_FAILED',
            String(error.message || error).slice(0, 300),
          ],
        );
      });
      throw error;
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      await client.query(
        `delete from calendar_watches where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, id],
      );
      await client.query(
        `delete from calendar_occurrences where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, id],
      );
      await client.query(
        `delete from calendar_provider_events where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, id],
      );
      await client.query(
        `delete from calendar_sync_cursors where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, id],
      );
      await client.query(
        `delete from calendar_source_coverage where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, id],
      );
      await client.query(
        `update calendar_sources
         set status = 'disconnected', credential_ref = '', last_error_code = '', last_error_message = '', updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, id],
      );
      return { ok: true, sourceId: id, status: 'disconnected', workspaceId };
    });
  }

  /**
   * Initial or incremental sync. Persists nextSyncToken only after all pages commit.
   */
  async syncSource(scope, sourceId, { full = false, rangeStart = null, rangeEnd = null } = {}) {
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const srcRes = await client.query(
        `select * from calendar_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!srcRes.rowCount) return null;
      const source = srcRes.rows[0];
      if (source.provider !== 'google') reject('SOURCE_NOT_GOOGLE', 'only google sync in phase4', 400);
      if (!source.credential_ref) reject('SOURCE_NO_CREDENTIAL', 'source has no credential_ref', 400);

      await client.query(
        `update calendar_sources set status = 'syncing', updated_at = now() where id = $1 and workspace_id = $2`,
        [source.id, valid.workspaceId],
      );

      let syncToken = '';
      if (!full) {
        const cur = await client.query(
          `select cursor_value from calendar_sync_cursors
           where workspace_id = $1 and source_id = $2 and cursor_kind = 'sync_token'`,
          [valid.workspaceId, source.id],
        );
        syncToken = cur.rowCount ? cur.rows[0].cursor_value : '';
      } else {
        await client.query(
          `delete from calendar_provider_events where workspace_id = $1 and source_id = $2`,
          [valid.workspaceId, source.id],
        );
        await client.query(
          `delete from calendar_occurrences where workspace_id = $1 and source_id = $2`,
          [valid.workspaceId, source.id],
        );
        await client.query(
          `delete from calendar_sync_cursors where workspace_id = $1 and source_id = $2`,
          [valid.workspaceId, source.id],
        );
      }

      const nowIso = new Date(this.clock()).toISOString();
      const defaultStart = rangeStart || toIso(this.clock() - 30 * 86400000);
      const defaultEnd = rangeEnd || toIso(this.clock() + 60 * 86400000);
      let pageToken = '';
      let pages = 0;
      let total = 0;
      let finalSyncToken = '';
      const allItems = [];

      try {
        do {
          pages += 1;
          // eslint-disable-next-line no-await-in-loop
          const page = await this.google.listEvents({
            credentialRef: source.credential_ref,
            calendarId: source.external_calendar_id || 'primary',
            syncToken: syncToken || undefined,
            pageToken: pageToken || undefined,
            // Initial full window uses timeMin/timeMax only when no syncToken.
            timeMin: syncToken ? undefined : defaultStart,
            timeMax: syncToken ? undefined : defaultEnd,
            showDeleted: true,
            singleEvents: true,
          });
          allItems.push(...(page.items || []));
          pageToken = page.nextPageToken || '';
          if (page.nextSyncToken) finalSyncToken = page.nextSyncToken;
          if (pages >= 50 && pageToken) {
            reject('SYNC_PAGE_LIMIT', 'sync exceeded 50 pages; abort without marking complete', 503);
          }
        } while (pageToken && pages < 50);
      } catch (error) {
        if (error && error.code === 'SYNC_PAGE_LIMIT') {
          await client.query(
            `update calendar_sources
             set status = 'error', last_error_code = 'SYNC_PAGE_LIMIT', last_error_message = $3, updated_at = now()
             where id = $1 and workspace_id = $2`,
            [source.id, valid.workspaceId, String(error.message || '').slice(0, 300)],
          );
          throw error;
        }
        if (error && (error.status === 410 || error.code === 'GOOGLE_SYNC_TOKEN_INVALID')) {
          // Clear projection and full resync once.
          await client.query(
            `delete from calendar_provider_events where workspace_id = $1 and source_id = $2`,
            [valid.workspaceId, source.id],
          );
          await client.query(
            `delete from calendar_occurrences where workspace_id = $1 and source_id = $2`,
            [valid.workspaceId, source.id],
          );
          await client.query(
            `delete from calendar_sync_cursors where workspace_id = $1 and source_id = $2`,
            [valid.workspaceId, source.id],
          );
          let pageToken2 = '';
          let pages2 = 0;
          do {
            pages2 += 1;
            // eslint-disable-next-line no-await-in-loop
            const page = await this.google.listEvents({
              credentialRef: source.credential_ref,
              calendarId: source.external_calendar_id || 'primary',
              timeMin: defaultStart,
              timeMax: defaultEnd,
              pageToken: pageToken2 || undefined,
              showDeleted: true,
              singleEvents: true,
            });
            allItems.push(...(page.items || []));
            pageToken2 = page.nextPageToken || '';
            if (page.nextSyncToken) finalSyncToken = page.nextSyncToken;
            if (pages2 >= 50 && pageToken2) {
              reject('SYNC_PAGE_LIMIT', 'sync exceeded 50 pages; abort without marking complete', 503);
            }
          } while (pageToken2 && pages2 < 50);
        } else {
          await client.query(
            `update calendar_sources
             set status = 'error', last_error_code = $3, last_error_message = $4, updated_at = now()
             where id = $1 and workspace_id = $2`,
            [source.id, valid.workspaceId, error.code || 'SYNC_FAILED', String(error.message || error).slice(0, 300)],
          );
          throw error;
        }
      }

      // Commit pages only after full fetch: write events then sync token.
      for (const item of allItems) {
        const bounds = googleEventToBounds(item);
        const deleted = item.status === 'cancelled' || item.status === 'deleted';
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `insert into calendar_provider_events (
             id, workspace_id, source_id, provider_event_id, title, status, all_day,
             starts_at, ends_at, timezone, recurrence_rule, recurring_event_id, etag,
             payload, deleted, updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13,$14::jsonb,$15, now())
           on conflict (workspace_id, source_id, provider_event_id) do update set
             title = excluded.title,
             status = excluded.status,
             all_day = excluded.all_day,
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             timezone = excluded.timezone,
             recurrence_rule = excluded.recurrence_rule,
             etag = excluded.etag,
             payload = excluded.payload,
             deleted = excluded.deleted,
             updated_at = now()`,
          [
            newId('cpe'),
            valid.workspaceId,
            source.id,
            item.id,
            item.summary || 'Event',
            deleted ? 'cancelled' : (item.status || 'confirmed'),
            bounds.allDay,
            bounds.startsAt,
            bounds.endsAt,
            bounds.timezone,
            Array.isArray(item.recurrence) ? item.recurrence.join(';') : (item.recurrence || ''),
            item.recurringEventId || '',
            item.etag || '',
            JSON.stringify(item),
            deleted,
          ],
        );
        total += 1;
      }

      // Rebuild occurrences for query window from provider events (single source of truth).
      // Delete whole source projection first so create-then-sync cannot leave forked keys.
      await client.query(
        `delete from calendar_occurrences where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, source.id],
      );
      const stored = await client.query(
        `select * from calendar_provider_events
         where workspace_id = $1 and source_id = $2 and deleted = false`,
        [valid.workspaceId, source.id],
      );
      const rangeStartMs = parseInstant(defaultStart);
      const rangeEndMs = parseInstant(defaultEnd);
      // Deduplicate provider rows by provider_event_id (defensive if upsert races).
      const byProviderId = new Map();
      for (const row of stored.rows) {
        byProviderId.set(String(row.provider_event_id), row);
      }
      for (const row of byProviderId.values()) {
        const rrule = row.recurrence_rule || '';
        const occs = expandRecurrence({
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          rrule,
          rangeStartMs,
          rangeEndMs,
          title: row.title,
          allDay: row.all_day,
          timezone: row.timezone,
          providerEventId: row.provider_event_id,
          etag: row.etag,
        });
        // Non-recurring: at most one occurrence per provider event in the rebuild set.
        const seenKeys = new Set();
        for (const occ of occs) {
          if (seenKeys.has(occ.occurrenceKey)) continue;
          seenKeys.add(occ.occurrenceKey);
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `insert into calendar_occurrences (
               id, workspace_id, source_id, provider_event_id, occurrence_key, title, all_day,
               starts_at, ends_at, timezone, status, writable, etag, entry_kind, payload
             ) values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13,'external',$14::jsonb)
             on conflict (workspace_id, source_id, occurrence_key) do update set
               title = excluded.title,
               starts_at = excluded.starts_at,
               ends_at = excluded.ends_at,
               etag = excluded.etag,
               provider_event_id = excluded.provider_event_id,
               updated_at = now()`,
            [
              newId('cocc'),
              valid.workspaceId,
              source.id,
              row.provider_event_id,
              occ.occurrenceKey,
              occ.title,
              occ.allDay,
              occ.startsAt,
              occ.endsAt,
              occ.timezone,
              row.status,
              source.writable,
              occ.etag,
              JSON.stringify({ providerEventId: row.provider_event_id }),
            ],
          );
        }
      }

      if (finalSyncToken) {
        await client.query(
          `insert into calendar_sync_cursors (
             id, workspace_id, source_id, cursor_kind, cursor_value, page_complete, updated_at
           ) values ($1,$2,$3,'sync_token',$4, true, now())
           on conflict (workspace_id, source_id, cursor_kind) do update set
             cursor_value = excluded.cursor_value,
             page_complete = true,
             updated_at = now()`,
          [newId('ccur'), valid.workspaceId, source.id, finalSyncToken],
        );
      }

      await client.query(
        `insert into calendar_source_coverage (
           id, workspace_id, source_id, range_start, range_end, state, event_count, synced_at, message, updated_at
         ) values ($1,$2,$3,$4::timestamptz,$5::timestamptz,'complete',$6, now(), 'sync complete', now())
         on conflict (workspace_id, source_id, range_start, range_end) do update set
           state = 'complete',
           event_count = excluded.event_count,
           synced_at = now(),
           message = 'sync complete',
           updated_at = now()`,
        [newId('ccov'), valid.workspaceId, source.id, defaultStart, defaultEnd, total],
      );

      await client.query(
        `update calendar_sources
         set status = 'connected', last_synced_at = now(), last_error_code = '', last_error_message = '', updated_at = now()
         where id = $1 and workspace_id = $2`,
        [source.id, valid.workspaceId],
      );

      return {
        ok: true,
        sourceId: source.id,
        pages,
        eventCount: total,
        syncTokenPersisted: Boolean(finalSyncToken),
        syncedAt: nowIso,
      };
    });
  }

  /**
   * Exact unified range query with overlap semantics + coverage statements.
   */
  async queryRange(scope, { from, to, sourceIds = null } = {}) {
    const fromMs = parseInstant(from);
    const toMs = parseInstant(to);
    if (fromMs == null || toMs == null || toMs <= fromMs) {
      reject('INVALID_RANGE', 'from/to required and to must be after from', 400);
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const entries = [];
      const coverage = [];

      // Internal calendar_events — load by workspace then filter overlap in JS
      // (payload end fields vary; avoids aborting the app-role transaction on cast errors).
      const internal = await client.query(
        `select id, title, starts_at, payload, workspace_id
         from calendar_events
         where workspace_id = $1
         order by starts_at asc, id asc`,
        [valid.workspaceId],
      );

      for (const row of internal.rows) {
        const p = typeof row.payload === 'object' && row.payload && !Array.isArray(row.payload)
          ? row.payload
          : (typeof row.payload === 'string' ? (() => { try { return JSON.parse(row.payload); } catch { return {}; } })() : {});
        const sourceKind = p.source === 'agent-work' ? 'agent_work' : 'internal';
        const s = parseInstant(row.starts_at);
        const e = parseInstant(p.endsAt || p.ends_at || p.end) || (s != null ? s + 3600000 : null);
        if (s == null || e == null || !(s < toMs && e > fromMs)) continue;
        entries.push({
          id: `internal:${row.id}`,
          entryId: row.id,
          sourceId: sourceKind === 'agent_work' ? 'agent_work' : 'internal',
          sourceKind,
          provider: sourceKind === 'agent_work' ? 'agent_work' : 'internal',
          sourceLabel: sourceKind === 'agent_work' ? 'Agent Work' : 'Internal',
          providerEventId: row.id,
          title: row.title || p.title || '',
          allDay: Boolean(p.allDay || p.all_day),
          startsAt: toIso(s),
          endsAt: toIso(e),
          timezone: p.timezone || p.timeZone || 'UTC',
          recurrenceId: p.recurrenceId || '',
          writable: sourceKind !== 'agent_work',
          etag: p.etag || '',
          version: p.version || '',
          freshness: p.updatedAt || null,
          status: p.status || 'confirmed',
          lifecycleStatus: sourceKind === 'agent_work' ? (p.lifecycleStatus || p.status || 'scheduled') : '',
        });
      }

      const internalCount = entries.filter((e) => e.sourceKind === 'internal').length;
      const agentCount = entries.filter((e) => e.sourceKind === 'agent_work').length;
      coverage.push({
        sourceId: 'internal',
        sourceKind: 'internal',
        state: 'complete',
        rangeStart: toIso(fromMs),
        rangeEnd: toIso(toMs),
        message: 'internal calendar_events projection',
        eventCount: internalCount,
      });
      coverage.push({
        sourceId: 'agent_work',
        sourceKind: 'agent_work',
        state: 'complete',
        rangeStart: toIso(fromMs),
        rangeEnd: toIso(toMs),
        message: 'agent_work calendar projection',
        eventCount: agentCount,
      });

      if (externalEnabled(this.env)) {
        const sources = await client.query(
          `select * from calendar_sources
           where workspace_id = $1 and selected = true and status in ('connected','syncing','error')`,
          [valid.workspaceId],
        );
        for (const source of sources.rows) {
          if (sourceIds && Array.isArray(sourceIds) && !sourceIds.includes(source.id)) continue;
          // Load all coverage rows for containment evaluation (not just latest by synced_at).
          const cov = await client.query(
            `select * from calendar_source_coverage
             where workspace_id = $1 and source_id = $2
             order by range_start asc`,
            [valid.workspaceId, source.id],
          );
          let state = 'unsynchronized';
          let message = 'source not yet synchronized';
          let eventCount = 0;
          const coveredIntervals = [];
          const queryStart = fromMs;
          const queryEnd = toMs;
          if (cov.rowCount) {
            const completeIntervals = [];
            for (const row of cov.rows) {
              const rs = parseInstant(row.range_start);
              const re = parseInstant(row.range_end);
              if (rs == null || re == null) continue;
              coveredIntervals.push({
                rangeStart: toIso(rs),
                rangeEnd: toIso(re),
                state: row.state,
                eventCount: row.event_count,
              });
              if (row.state === 'complete') completeIntervals.push({ start: rs, end: re, eventCount: row.event_count });
            }
            // Merge adjacent/overlapping complete intervals, then test containment.
            completeIntervals.sort((a, b) => a.start - b.start || a.end - b.end);
            const merged = [];
            for (const iv of completeIntervals) {
              if (!merged.length || iv.start > merged[merged.length - 1].end) {
                merged.push({ ...iv });
              } else {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
                merged[merged.length - 1].eventCount += iv.eventCount;
              }
            }
            const full = merged.find((iv) => iv.start <= queryStart && iv.end >= queryEnd);
            if (full) {
              state = 'complete';
              message = 'sync complete (merged coverage)';
              eventCount = full.eventCount;
            } else {
              const partial = merged.find((iv) => iv.start < queryEnd && iv.end > queryStart)
                || completeIntervals.find((iv) => iv.start < queryEnd && iv.end > queryStart);
              if (partial) {
                state = 'incomplete';
                message = 'requested range not fully covered by synced intervals';
                eventCount = partial.eventCount || 0;
              } else {
                state = 'unsynchronized';
                message = 'no coverage for requested range';
              }
            }
          } else if (!source.last_synced_at) {
            state = 'unsynchronized';
          }

          coverage.push({
            sourceId: source.id,
            sourceKind: source.source_kind,
            provider: source.provider,
            label: source.label,
            state,
            rangeStart: toIso(fromMs),
            rangeEnd: toIso(toMs),
            message,
            eventCount,
            coveredIntervals,
            lastSyncedAt: source.last_synced_at,
          });

          if (state === 'unsynchronized') continue;

          const occ = await client.query(
            `select * from calendar_occurrences
             where workspace_id = $1 and source_id = $2
               and starts_at < $4::timestamptz
               and ends_at > $3::timestamptz
             order by starts_at asc, id asc`,
            [valid.workspaceId, source.id, toIso(fromMs), toIso(toMs)],
          );
          for (const row of occ.rows) {
            entries.push({
              id: `external:${source.id}:${row.occurrence_key}`,
              entryId: row.id,
              sourceId: source.id,
              sourceKind: 'external_calendar',
              provider: source.provider,
              sourceLabel: source.label,
              providerEventId: row.provider_event_id,
              title: row.title,
              allDay: row.all_day,
              startsAt: new Date(row.starts_at).toISOString(),
              endsAt: new Date(row.ends_at).toISOString(),
              timezone: row.timezone,
              recurrenceId: row.occurrence_key,
              writable: Boolean(row.writable),
              etag: row.etag,
              version: row.etag,
              freshness: source.last_synced_at,
              status: row.status,
            });
          }
        }
      }

      const automationSources = await client.query(
        `select *
         from automation_sources
         where workspace_id = $1
         order by display_name asc, id asc`,
        [valid.workspaceId],
      );
      for (const source of automationSources.rows) {
        if (sourceIds && Array.isArray(sourceIds) && !sourceIds.includes(source.id)) continue;
        const stale = source.stale_after && new Date(source.stale_after).getTime() < this.clock();
        const state = !source.last_synced_at
          ? 'unsynchronized'
          : stale || source.status !== 'connected'
            ? 'stale'
            : 'complete';
        const occurrenceRows = state === 'unsynchronized'
          ? { rows: [] }
          : await client.query(
            `select o.*, a.name, a.goal, a.agent_id, a.schedule
             from automation_occurrences o
             join connected_automations a
               on a.workspace_id = o.workspace_id and a.id = o.automation_id
             where o.workspace_id = $1
               and o.source_id = $2
               and o.scheduled_at < $4::timestamptz
               and coalesce(o.finished_at, o.scheduled_at + interval '30 minutes') > $3::timestamptz
             order by o.scheduled_at asc, o.id asc`,
            [valid.workspaceId, source.id, toIso(fromMs), toIso(toMs)],
          );
        coverage.push({
          sourceId: source.id,
          sourceKind: 'automation',
          provider: source.adapter_kind,
          label: source.display_name,
          state,
          rangeStart: toIso(fromMs),
          rangeEnd: toIso(toMs),
          message: state === 'complete'
            ? 'source-owned automation synchronization complete'
            : state === 'stale'
              ? 'automation source projection is stale'
              : 'automation source not yet synchronized',
          eventCount: occurrenceRows.rows.length,
          lastSyncedAt: source.last_synced_at,
        });
        for (const row of occurrenceRows.rows) {
          const startsAt = new Date(row.scheduled_at);
          const endsAt = row.finished_at
            ? new Date(row.finished_at)
            : new Date(startsAt.getTime() + 30 * 60 * 1000);
          entries.push({
            id: `automation:${source.id}:${row.external_occurrence_id}`,
            entryId: row.id,
            sourceId: source.id,
            sourceKind: 'automation',
            provider: source.adapter_kind,
            sourceLabel: source.display_name,
            providerEventId: row.external_occurrence_id,
            automationId: row.automation_id,
            title: row.name,
            allDay: false,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            timezone: 'UTC',
            recurrenceId: row.external_occurrence_id,
            writable: false,
            etag: row.source_revision,
            version: row.source_revision,
            freshness: row.last_synced_at,
            status: row.status,
          });
        }
      }

      entries.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)) || String(a.id).localeCompare(String(b.id)));

      return {
        ok: true,
        workspaceId: valid.workspaceId,
        from: toIso(fromMs),
        to: toIso(toMs),
        externalEnabled: externalEnabled(this.env),
        entries,
        coverage,
      };
    });
  }

  async createExternalEvent(scope, {
    sourceId,
    title,
    startsAt,
    endsAt,
    allDay = false,
    timezone = 'UTC',
    idempotencyKey = '',
  } = {}) {
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    const key = String(idempotencyKey || newId('mut'));
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      // Per-workspace/key advisory xact lock before any provider call.
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [valid.workspaceId, key],
      );
      const existing = await client.query(
        `select * from calendar_mutation_receipts
         where workspace_id = $1 and idempotency_key = $2 for update`,
        [valid.workspaceId, key],
      );
      if (existing.rowCount && existing.rows[0].status === 'reconciled') {
        return {
          ok: true,
          replay: true,
          receipt: this.#publicReceipt(existing.rows[0]),
        };
      }
      if (existing.rowCount && (existing.rows[0].status === 'pending' || existing.rows[0].status === 'submitted')) {
        return { ok: true, replay: true, inProgress: true, receipt: this.#publicReceipt(existing.rows[0]) };
      }

      const src = await client.query(
        `select * from calendar_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) reject('SOURCE_NOT_FOUND', 'source not found', 404);
      const source = src.rows[0];
      if (!source.writable) reject('SOURCE_READ_ONLY', 'source not writable', 403);

      const receiptId = newId('cmr');
      const inserted = await client.query(
        `insert into calendar_mutation_receipts (
           id, workspace_id, source_id, idempotency_key, operation, status, request_payload
         ) values ($1,$2,$3,$4,'create','submitted',$5::jsonb)
         on conflict (workspace_id, idempotency_key) do nothing
         returning id`,
        [receiptId, valid.workspaceId, source.id, key, JSON.stringify({ title, startsAt, endsAt, allDay })],
      );
      if (!inserted.rowCount) {
        const again = await client.query(
          `select * from calendar_mutation_receipts where workspace_id = $1 and idempotency_key = $2`,
          [valid.workspaceId, key],
        );
        if (again.rowCount && again.rows[0].status === 'reconciled') {
          return { ok: true, replay: true, receipt: this.#publicReceipt(again.rows[0]) };
        }
        if (again.rowCount) {
          return { ok: true, replay: true, inProgress: true, receipt: this.#publicReceipt(again.rows[0]) };
        }
      }

      const start = allDay
        ? { date: String(startsAt).slice(0, 10) }
        : { dateTime: startsAt, timeZone: timezone };
      const end = allDay
        ? { date: String(endsAt).slice(0, 10) }
        : { dateTime: endsAt, timeZone: timezone };
      // Google custom ids: lowercase base32hex [a-v0-9], length >= 5, SHA-256(workspace/source/key).
      const googleEventId = deterministicGoogleEventId({
        workspaceId: valid.workspaceId,
        sourceId: source.id,
        idempotencyKey: key,
      });
      if (!isAllowedGoogleEventId(googleEventId)) {
        reject('GOOGLE_EVENT_ID_INVALID', 'derived event id is not Google-allowed base32hex', 500);
      }

      let providerEvent;
      try {
        const created = await this.google.createEvent({
          credentialRef: source.credential_ref,
          calendarId: source.external_calendar_id || 'primary',
          event: {
            summary: title,
            start,
            end,
            id: googleEventId,
          },
          idempotencyKey: key,
        });
        providerEvent = created.event;
      } catch (error) {
        await client.query(
          `update calendar_mutation_receipts
           set status = 'failed', error_code = $3, error_message = $4, updated_at = now()
           where workspace_id = $1 and idempotency_key = $2`,
          [valid.workspaceId, key, error.code || 'MUTATION_FAILED', String(error.message || error).slice(0, 300)],
        );
        throw error;
      }

      // Reconcile into local projection before success.
      const bounds = googleEventToBounds(providerEvent);
      await client.query(
        `insert into calendar_provider_events (
           id, workspace_id, source_id, provider_event_id, title, status, all_day,
           starts_at, ends_at, timezone, etag, payload, deleted
         ) values ($1,$2,$3,$4,$5,'confirmed',$6,$7::timestamptz,$8::timestamptz,$9,$10,$11::jsonb,false)
         on conflict (workspace_id, source_id, provider_event_id) do update set
           title = excluded.title, etag = excluded.etag, updated_at = now()`,
        [
          newId('cpe'),
          valid.workspaceId,
          source.id,
          providerEvent.id,
          providerEvent.summary || title,
          bounds.allDay,
          bounds.startsAt,
          bounds.endsAt,
          bounds.timezone,
          providerEvent.etag || '',
          JSON.stringify(providerEvent),
        ],
      );
      // Canonical key + replace any prior rows for this provider event (create then sync must stay unique).
      const startIso = (() => {
        const ms = parseInstant(bounds.startsAt);
        return ms == null ? String(bounds.startsAt) : toIso(ms);
      })();
      const endIso = (() => {
        const ms = parseInstant(bounds.endsAt);
        return ms == null ? String(bounds.endsAt) : toIso(ms);
      })();
      const occKey = canonicalOccurrenceKey(providerEvent.id, startIso);
      await client.query(
        `delete from calendar_occurrences
         where workspace_id = $1 and source_id = $2 and provider_event_id = $3`,
        [valid.workspaceId, source.id, providerEvent.id],
      );
      await client.query(
        `insert into calendar_occurrences (
           id, workspace_id, source_id, provider_event_id, occurrence_key, title, all_day,
           starts_at, ends_at, timezone, status, writable, etag, entry_kind, payload
         ) values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,'confirmed',true,$11,'external','{}'::jsonb)
         on conflict (workspace_id, source_id, occurrence_key) do update set
           title = excluded.title,
           starts_at = excluded.starts_at,
           ends_at = excluded.ends_at,
           etag = excluded.etag,
           provider_event_id = excluded.provider_event_id,
           updated_at = now()`,
        [
          newId('cocc'),
          valid.workspaceId,
          source.id,
          providerEvent.id,
          occKey,
          providerEvent.summary || title,
          bounds.allDay,
          startIso,
          endIso,
          bounds.timezone,
          providerEvent.etag || '',
        ],
      );

      await client.query(
        `update calendar_mutation_receipts
         set status = 'reconciled',
             provider_event_id = $3,
             etag = $4,
             response_payload = $5::jsonb,
             updated_at = now()
         where workspace_id = $1 and idempotency_key = $2`,
        [valid.workspaceId, key, providerEvent.id, providerEvent.etag || '', JSON.stringify(providerEvent)],
      );

      const receipt = await client.query(
        `select * from calendar_mutation_receipts where workspace_id = $1 and idempotency_key = $2`,
        [valid.workspaceId, key],
      );

      return {
        ok: true,
        replay: false,
        receipt: this.#publicReceipt(receipt.rows[0]),
        entry: {
          id: `external:${source.id}:${occKey}`,
          providerEventId: providerEvent.id,
          etag: providerEvent.etag,
          title: providerEvent.summary || title,
          startsAt: bounds.startsAt,
          endsAt: bounds.endsAt,
        },
      };
    });
  }

  async updateExternalEvent(scope, {
    sourceId,
    providerEventId,
    title,
    startsAt,
    endsAt,
    ifMatch = '',
    idempotencyKey = '',
  } = {}) {
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    if (!ifMatch) reject('IF_MATCH_REQUIRED', 'If-Match etag required for update', 400);
    const key = String(idempotencyKey || newId('mut'));

    // Phase 1: claim receipt under advisory lock (committed so later failure can be recorded).
    const claimed = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [valid.workspaceId, key],
      );
      const existing = await client.query(
        `select * from calendar_mutation_receipts where workspace_id = $1 and idempotency_key = $2 for update`,
        [valid.workspaceId, key],
      );
      if (existing.rowCount && existing.rows[0].status === 'reconciled') {
        return { kind: 'replay', value: { ok: true, replay: true, receipt: this.#publicReceipt(existing.rows[0]) } };
      }
      if (existing.rowCount && (existing.rows[0].status === 'pending' || existing.rows[0].status === 'submitted')) {
        return {
          kind: 'replay',
          value: { ok: true, replay: true, inProgress: true, receipt: this.#publicReceipt(existing.rows[0]) },
        };
      }
      if (existing.rowCount && (existing.rows[0].status === 'failed' || existing.rows[0].status === 'conflict')) {
        // Allow retry after a recorded failure by reclaiming as submitted.
        await client.query(
          `update calendar_mutation_receipts
           set status = 'submitted', error_code = null, error_message = null,
               request_payload = $3::jsonb, updated_at = now()
           where workspace_id = $1 and idempotency_key = $2`,
          [valid.workspaceId, key, JSON.stringify({ providerEventId, title, startsAt, endsAt, ifMatch })],
        );
      } else {
        await client.query(
          `insert into calendar_mutation_receipts (
             id, workspace_id, source_id, idempotency_key, operation, status, request_payload
           ) values ($1,$2,$3,$4,'update','submitted',$5::jsonb)
           on conflict (workspace_id, idempotency_key) do nothing`,
          [newId('cmr'), valid.workspaceId, String(sourceId || ''), key, JSON.stringify({ providerEventId, title, startsAt, endsAt, ifMatch })],
        );
      }
      const src = await client.query(
        `select * from calendar_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) reject('SOURCE_NOT_FOUND', 'source not found', 404);
      const source = src.rows[0];
      if (!source.writable) reject('SOURCE_READ_ONLY', 'source not writable', 403);
      // Ensure receipt source_id is bound after insert with possibly empty sourceId.
      await client.query(
        `update calendar_mutation_receipts set source_id = $3, updated_at = now()
         where workspace_id = $1 and idempotency_key = $2`,
        [valid.workspaceId, key, source.id],
      );
      return {
        kind: 'claimed',
        source: {
          id: source.id,
          credential_ref: source.credential_ref,
          external_calendar_id: source.external_calendar_id,
        },
        workspaceId: valid.workspaceId,
      };
    });
    if (claimed.kind === 'replay') return claimed.value;

    // Phase 2: provider call outside claim txn (so failure can be durably recorded).
    let updated;
    try {
      updated = await this.google.updateEvent({
        credentialRef: claimed.source.credential_ref,
        calendarId: claimed.source.external_calendar_id || 'primary',
        eventId: providerEventId,
        event: {
          summary: title,
          start: { dateTime: startsAt },
          end: { dateTime: endsAt },
        },
        ifMatch,
      });
    } catch (error) {
      // Persist failed/conflict receipt BEFORE rethrow (survives claim commit).
      const isEtag = error && error.code === 'GOOGLE_ETAG_CONFLICT';
      await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        await client.query(
          `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
          [valid.workspaceId, key],
        );
        await client.query(
          `update calendar_mutation_receipts
           set status = $3,
               error_code = $4,
               error_message = $5,
               updated_at = now()
           where workspace_id = $1 and idempotency_key = $2`,
          [
            valid.workspaceId,
            key,
            isEtag ? 'conflict' : 'failed',
            isEtag ? 'GOOGLE_ETAG_CONFLICT' : (error.code || 'MUTATION_FAILED'),
            String(error.message || error).slice(0, 300),
          ],
        );
      });
      if (isEtag) reject('GOOGLE_ETAG_CONFLICT', 'provider etag conflict', 409);
      throw error;
    }

    // Phase 3: reconcile local projection + receipt.
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [valid.workspaceId, key],
      );
      const bounds = googleEventToBounds(updated.event);
      await client.query(
        `update calendar_provider_events
         set title = $4, starts_at = $5::timestamptz, ends_at = $6::timestamptz, etag = $7, payload = $8::jsonb, updated_at = now()
         where workspace_id = $1 and source_id = $2 and provider_event_id = $3`,
        [
          valid.workspaceId,
          claimed.source.id,
          providerEventId,
          updated.event.summary || title,
          bounds.startsAt,
          bounds.endsAt,
          updated.event.etag || '',
          JSON.stringify(updated.event),
        ],
      );
      await client.query(
        `update calendar_occurrences
         set title = $4, starts_at = $5::timestamptz, ends_at = $6::timestamptz, etag = $7, updated_at = now()
         where workspace_id = $1 and source_id = $2 and provider_event_id = $3`,
        [
          valid.workspaceId,
          claimed.source.id,
          providerEventId,
          updated.event.summary || title,
          bounds.startsAt,
          bounds.endsAt,
          updated.event.etag || '',
        ],
      );
      await client.query(
        `update calendar_mutation_receipts
         set status = 'reconciled',
             provider_event_id = $3,
             etag = $4,
             response_payload = $5::jsonb,
             error_code = null,
             error_message = null,
             updated_at = now()
         where workspace_id = $1 and idempotency_key = $2`,
        [
          valid.workspaceId,
          key,
          providerEventId,
          updated.event.etag || '',
          JSON.stringify(updated.event),
        ],
      );
      return { ok: true, replay: false, event: updated.event };
    });
  }

  async handleGoogleWebhook(headers = {}) {
    const channelId = headers['x-goog-channel-id'] || headers['X-Goog-Channel-ID'] || '';
    const resourceId = headers['x-goog-resource-id'] || headers['X-Goog-Resource-ID'] || '';
    const channelToken = headers['x-goog-channel-token'] || headers['X-Goog-Channel-Token'] || '';
    if (!channelId) reject('WATCH_CHANNEL_REQUIRED', 'channel id required', 400);

    // Resolve watch from DB (never trust body workspace/source).
    const watch = await this.pool.query(
      `select * from calendar_watches where channel_id = $1 limit 1`,
      [String(channelId)],
    );
    if (!watch.rowCount) reject('WATCH_UNKNOWN_CHANNEL', 'unknown channel', 404);
    const row = watch.rows[0];
    if (row.token_digest && digestToken(channelToken) !== row.token_digest) {
      reject('WATCH_TOKEN_MISMATCH', 'invalid channel token', 401);
    }
    if (resourceId && row.resource_id && resourceId !== row.resource_id) {
      reject('WATCH_RESOURCE_MISMATCH', 'resource mismatch', 401);
    }
    if (row.expiration_at && Date.parse(row.expiration_at) <= this.clock()) {
      reject('WATCH_EXPIRED', 'watch expired', 410);
    }

    // Durable sync request must be recorded before 200 (idempotent by channel+message number).
    const messageNumber = headers['x-goog-message-number'] || headers['X-Goog-Message-Number'] || '';
    const idempotencyKey = messageNumber
      ? `${row.channel_id}:${messageNumber}`
      : '';
    const reqId = newId('csync');
    let requestId = reqId;
    let replay = false;
    if (idempotencyKey) {
      const inserted = await this.pool.query(
        `insert into calendar_sync_requests (
           id, workspace_id, source_id, reason, status, channel_id, resource_id, next_attempt_at, idempotency_key
         ) values ($1,$2,$3,'webhook','pending',$4,$5, now(), $6)
         on conflict (workspace_id, idempotency_key) where (idempotency_key <> '') do nothing
         returning id`,
        [reqId, row.workspace_id, row.source_id, row.channel_id, row.resource_id || '', idempotencyKey],
      );
      if (inserted.rowCount) {
        requestId = inserted.rows[0].id;
      } else {
        replay = true;
        const existing = await this.pool.query(
          `select id from calendar_sync_requests
           where workspace_id = $1 and idempotency_key = $2
           limit 1`,
          [row.workspace_id, idempotencyKey],
        );
        if (existing.rowCount) requestId = existing.rows[0].id;
      }
    } else {
      await this.pool.query(
        `insert into calendar_sync_requests (
           id, workspace_id, source_id, reason, status, channel_id, resource_id, next_attempt_at, idempotency_key
         ) values ($1,$2,$3,'webhook','pending',$4,$5, now(), '')`,
        [reqId, row.workspace_id, row.source_id, row.channel_id, row.resource_id || ''],
      );
    }

    return {
      ok: true,
      reconcile: true,
      requestId,
      replay,
    };
  }

  async drainSyncRequests({ limit = 20, leaseMs = 60_000 } = {}) {
    const client = await this.pool.connect();
    let processed = 0;
    let claimed = 0;
    let reclaimed = 0;
    let rows = [];
    try {
      await client.query('begin');
      // Reclaim stale running leases first.
      const reclaimedRows = await client.query(
        `update calendar_sync_requests
         set status = 'pending', next_attempt_at = now(), updated_at = now()
         where status = 'running'
           and lease_expires_at is not null
           and lease_expires_at < now()
         returning id`,
      );
      reclaimed = reclaimedRows.rowCount;
      // Atomically claim pending rows as running (UPDATE...RETURNING + SKIP LOCKED).
      const claimedRows = await client.query(
        `with cte as (
           select id from calendar_sync_requests
           where status = 'pending' and next_attempt_at <= now()
           order by created_at asc
           limit $1
           for update skip locked
         )
         update calendar_sync_requests r
         set status = 'running',
             attempt_count = attempt_count + 1,
             claimed_at = now(),
             lease_expires_at = now() + ($2 || ' milliseconds')::interval,
             updated_at = now()
         from cte
         where r.id = cte.id
         returning r.*`,
        [limit, String(leaseMs)],
      );
      rows = claimedRows.rows;
      claimed = rows.length;
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* ignore */ }
      client.release();
      throw error;
    }
    client.release();

    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const owner = await this.pool.query(
          `select user_id from workspace_memberships
           where workspace_id = $1 and status = 'active'
           order by case when role = 'owner' then 0 else 1 end, created_at asc
           limit 1`,
          [row.workspace_id],
        );
        if (!owner.rowCount) throw Object.assign(new Error('no membership'), { code: 'NO_MEMBERSHIP' });
        // eslint-disable-next-line no-await-in-loop
        const scope = await resolveWorkspaceScope(this.pool, {
          userId: owner.rows[0].user_id,
          workspaceId: row.workspace_id,
        });
        // eslint-disable-next-line no-await-in-loop
        await this.syncSource(scope, row.source_id, { full: false });
        // eslint-disable-next-line no-await-in-loop
        await this.pool.query(
          `update calendar_sync_requests set status = 'done', lease_expires_at = null, updated_at = now() where id = $1`,
          [row.id],
        );
        processed += 1;
      } catch (error) {
        const attempts = (row.attempt_count || 0);
        const dead = attempts >= 8;
        // eslint-disable-next-line no-await-in-loop
        await this.pool.query(
          `update calendar_sync_requests
           set status = $2,
               error_code = $3,
               error_message = $4,
               next_attempt_at = now() + ($5 || ' seconds')::interval,
               lease_expires_at = null,
               updated_at = now()
           where id = $1`,
          [
            row.id,
            dead ? 'dead' : 'pending',
            error.code || 'SYNC_FAILED',
            String(error.message || error).slice(0, 300),
            String(Math.min(300, 5 * (2 ** attempts))),
          ],
        );
      }
    }
    return { ok: true, processed, claimed, reclaimed };
  }

  async registerWatch(scope, sourceId, _ignoredBody = {}) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const src = await client.query(
        `select * from calendar_sources where workspace_id = $1 and id = $2`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) return null;
      const source = src.rows[0];
      const address = String(
        this.env.GOOGLE_CALENDAR_WEBHOOK_URL
        || this.env.UNIFIED_CALENDAR_WEBHOOK_URL
        || '',
      ).trim();
      if (!address || !/^https:\/\//i.test(address)) {
        reject('WEBHOOK_URL_REQUIRED', 'GOOGLE_CALENDAR_WEBHOOK_URL must be configured HTTPS URL', 503);
      }
      // Load previous active watches but do NOT stop yet — create new channel first (no gap).
      const prev = await client.query(
        `select * from calendar_watches where workspace_id = $1 and source_id = $2 and status = 'active'`,
        [valid.workspaceId, source.id],
      );
      const channelId = newId('chan');
      const token = crypto.randomBytes(16).toString('hex');
      const watched = await this.google.watch({
        credentialRef: source.credential_ref,
        calendarId: source.external_calendar_id || 'primary',
        channelId,
        token,
        address,
      });
      await client.query(
        `insert into calendar_watches (
           id, workspace_id, source_id, channel_id, resource_id, token_digest, expiration_at, address, status
         ) values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,'active')`,
        [
          newId('cwat'),
          valid.workspaceId,
          source.id,
          watched.channelId,
          watched.resourceId || '',
          digestToken(token),
          watched.expiration || null,
          address,
        ],
      );
      // After new channel is persisted, stop old channels.
      for (const w of prev.rows) {
        try {
          if (typeof this.google.stopChannel === 'function') {
            // eslint-disable-next-line no-await-in-loop
            await this.google.stopChannel({
              credentialRef: source.credential_ref,
              channelId: w.channel_id,
              resourceId: w.resource_id,
            });
            // eslint-disable-next-line no-await-in-loop
            await client.query(
              `update calendar_watches set status = 'stopped', updated_at = now() where id = $1`,
              [w.id],
            );
          }
        } catch (error) {
          // Do not silently mark stopped on provider failure — leave active + record error for retry.
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `update calendar_watches
             set status = 'error',
                 payload = coalesce(payload, '{}'::jsonb) || $2::jsonb,
                 updated_at = now()
             where id = $1`,
            [w.id, JSON.stringify({
              stopError: error.code || 'STOP_FAILED',
              stopMessage: String(error.message || error).slice(0, 200),
            })],
          );
        }
      }
      return {
        ok: true,
        channelId: watched.channelId,
        resourceId: watched.resourceId,
        expiration: watched.expiration,
        setupToken: token,
      };
    });
  }

  async renewExpiringWatches({ withinMs = 2 * 60 * 60_000 } = {}) {
    const cutoff = new Date(this.clock() + withinMs).toISOString();
    const due = await this.pool.query(
      `select w.*, s.credential_ref, s.external_calendar_id, s.workspace_id as ws
       from calendar_watches w
       inner join calendar_sources s on s.id = w.source_id and s.workspace_id = w.workspace_id
       where w.status = 'active'
         and w.expiration_at is not null
         and w.expiration_at <= $1::timestamptz`,
      [cutoff],
    );
    let renewed = 0;
    for (const row of due.rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const owner = await this.pool.query(
          `select user_id from workspace_memberships
           where workspace_id = $1 and status = 'active'
           order by case when role = 'owner' then 0 else 1 end, created_at asc limit 1`,
          [row.workspace_id],
        );
        if (!owner.rowCount) continue;
        // eslint-disable-next-line no-await-in-loop
        const scope = await resolveWorkspaceScope(this.pool, {
          userId: owner.rows[0].user_id,
          workspaceId: row.workspace_id,
        });
        // eslint-disable-next-line no-await-in-loop
        await this.registerWatch(scope, row.source_id, {});
        renewed += 1;
      } catch { /* next */ }
    }
    return { ok: true, renewed, scanned: due.rowCount };
  }

  /**
   * Retry provider stopChannel for watches left in status=error after a failed stop.
   * Does NOT create new watch channels — only stops the old channel and marks stopped.
   */
  async retryFailedWatchStops({ limit = 20 } = {}) {
    const due = await this.pool.query(
      `select w.id, w.workspace_id, w.source_id, w.channel_id, w.resource_id, w.payload,
              s.credential_ref
       from calendar_watches w
       inner join calendar_sources s
         on s.id = w.source_id and s.workspace_id = w.workspace_id
       where w.status = 'error'
         and (
           (w.payload ? 'stopError')
           or (w.payload->>'stopError') is not null
         )
       order by w.updated_at asc nulls first
       limit $1`,
      [limit],
    );
    let stopped = 0;
    let failed = 0;
    for (const row of due.rows) {
      if (!row.credential_ref || typeof this.google.stopChannel !== 'function') {
        failed += 1;
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.google.stopChannel({
          credentialRef: row.credential_ref,
          channelId: row.channel_id,
          resourceId: row.resource_id,
        });
        // eslint-disable-next-line no-await-in-loop
        await this.pool.query(
          `update calendar_watches
           set status = 'stopped',
               payload = coalesce(payload, '{}'::jsonb) || $2::jsonb,
               updated_at = now()
           where id = $1 and status = 'error'`,
          [row.id, JSON.stringify({ stopRetriedAt: new Date(this.clock()).toISOString(), stopOk: true })],
        );
        stopped += 1;
      } catch (error) {
        failed += 1;
        // eslint-disable-next-line no-await-in-loop
        await this.pool.query(
          `update calendar_watches
           set payload = coalesce(payload, '{}'::jsonb) || $2::jsonb,
               updated_at = now()
           where id = $1 and status = 'error'`,
          [row.id, JSON.stringify({
            stopError: error.code || 'STOP_FAILED',
            stopMessage: String(error.message || error).slice(0, 200),
            stopRetryAt: new Date(this.clock()).toISOString(),
          })],
        );
      }
    }
    return { ok: true, scanned: due.rowCount, stopped, failed };
  }

  async startGoogleAuthorize(scope) {
    assertWorkspaceScope(scope);
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    if (typeof this.google.getAuthorizationUrl !== 'function') {
      reject('GOOGLE_OAUTH_NOT_CONFIGURED', 'google oauth not configured', 503);
    }
    // Fail closed: production OAuth requires encryption key (or injected external vault).
    if (!this.credentialVault) {
      this.credentialVault = createDbCredentialVault(this.pool, this.env);
    }
    requireVaultKey(this.env);
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const expiresAt = new Date(this.clock() + 10 * 60_000).toISOString();
    const sealedVerifier = this.credentialVault.sealSecret
      ? this.credentialVault.sealSecret(codeVerifier)
      : (() => { reject('GOOGLE_VAULT_KEY_REQUIRED', 'vault cannot seal oauth verifier', 503); })();
    // Service-owned oauth_states table: use owner pool after scope validation (not app-role DML).
    assertWorkspaceScope(scope);
    const valid = scope;
    await this.pool.query(
      `insert into calendar_oauth_states (
         id, workspace_id, user_id, state, code_verifier_digest, code_verifier_enc, redirect_uri, expires_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
      [
        newId('oauth'),
        valid.workspaceId,
        valid.userId,
        state,
        digestToken(codeVerifier),
        sealedVerifier,
        String(this.env.GOOGLE_OAUTH_REDIRECT_URI || ''),
        expiresAt,
      ],
    );
    const url = this.google.getAuthorizationUrl({ state, codeChallenge });
    return {
      ok: true,
      workspaceId: valid.workspaceId,
      state,
      authorizationUrl: url,
      url,
      expiresAt,
    };
  }

  async finalizeGoogleOAuth(scope, { code, state } = {}) {
    assertWorkspaceScope(scope);
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    if (!this.credentialVault) {
      this.credentialVault = createDbCredentialVault(this.pool, this.env);
    }
    requireVaultKey(this.env);
    const valid = scope;
    // Bind workspace + state + user_id (same user who started authorize).
    const svc = await this.pool.connect();
    let row;
    let exchanged;
    try {
      await svc.query('begin');
      const st = await svc.query(
        `select * from calendar_oauth_states
         where workspace_id = $1 and state = $2 and user_id = $3
         for update`,
        [valid.workspaceId, String(state || ''), valid.userId],
      );
      if (!st.rowCount) reject('OAUTH_STATE_UNKNOWN', 'unknown oauth state for this user', 400);
      row = st.rows[0];
      if (row.consumed_at) reject('OAUTH_STATE_CONSUMED', 'oauth state already used', 400);
      if (Date.parse(row.expires_at) <= this.clock()) reject('OAUTH_STATE_EXPIRED', 'oauth state expired', 400);
      const codeVerifier = this.credentialVault.openSecret
        ? this.credentialVault.openSecret(row.code_verifier_enc)
        : reject('GOOGLE_VAULT_KEY_REQUIRED', 'vault cannot open oauth verifier', 503);
      exchanged = await this.google.exchangeCode({ code, codeVerifier });
      await this.credentialVault.putTokens(exchanged.credentialRef, {
        accessToken: exchanged._vault.accessToken,
        refreshToken: exchanged._vault.refreshToken,
        accessExpiresAt: exchanged._vault.accessExpiresAt,
        workspaceId: valid.workspaceId,
      }, { workspaceId: valid.workspaceId, provider: 'google' });
      await svc.query(
        `update calendar_oauth_states set consumed_at = now() where id = $1 and user_id = $2`,
        [row.id, valid.userId],
      );
      await svc.query('commit');
    } catch (error) {
      try { await svc.query('rollback'); } catch { /* ignore */ }
      throw error;
    } finally {
      svc.release();
    }
    const sourceId = newId('csrc');
    // Source row uses app-role RLS for workspace-owned product table.
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, v) => {
      await client.query(
        `insert into calendar_sources (
           id, workspace_id, provider, source_kind, label, external_calendar_id,
           credential_ref, status, writable, timezone, selected
         ) values ($1,$2,'google','external_calendar','Google Calendar','primary',$3,'connected', true, 'UTC', true)`,
        [sourceId, v.workspaceId, exchanged.credentialRef],
      );
      return {
        ok: true,
        workspaceId: valid.workspaceId,
        source: this.#publicSource({
          id: sourceId,
          workspace_id: valid.workspaceId,
          provider: 'google',
          source_kind: 'external_calendar',
          label: 'Google Calendar',
          external_calendar_id: 'primary',
          credential_ref: exchanged.credentialRef,
          status: 'connected',
          writable: true,
          timezone: 'UTC',
          selected: true,
          shadow_only: false,
          last_synced_at: null,
          last_error_code: '',
          last_error_message: '',
        }),
      };
    });
  }

  async deleteExternalEvent(scope, {
    sourceId,
    providerEventId,
    ifMatch = '',
    idempotencyKey = '',
  } = {}) {
    if (!externalEnabled(this.env)) reject('EXTERNAL_CALENDAR_DISABLED', 'external calendar disabled', 403);
    if (!ifMatch) reject('IF_MATCH_REQUIRED', 'If-Match etag required for delete', 400);
    const key = String(idempotencyKey || newId('mut'));
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [valid.workspaceId, key],
      );
      const existing = await client.query(
        `select * from calendar_mutation_receipts where workspace_id = $1 and idempotency_key = $2 for update`,
        [valid.workspaceId, key],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.status === 'reconciled') return { ok: true, replay: true, receipt: this.#publicReceipt(row) };
        if (row.status === 'pending' || row.status === 'submitted') {
          return { ok: true, replay: true, inProgress: true, receipt: this.#publicReceipt(row) };
        }
      }
      const src = await client.query(
        `select * from calendar_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) reject('SOURCE_NOT_FOUND', 'source not found', 404);
      const source = src.rows[0];
      if (!source.writable) reject('SOURCE_READ_ONLY', 'source not writable', 403);
      const receiptId = newId('cmr');
      await client.query(
        `insert into calendar_mutation_receipts (
           id, workspace_id, source_id, idempotency_key, operation, status, request_payload
         ) values ($1,$2,$3,$4,'delete','submitted',$5::jsonb)
         on conflict (workspace_id, idempotency_key) do nothing`,
        [receiptId, valid.workspaceId, source.id, key, JSON.stringify({ providerEventId, ifMatch })],
      );
      try {
        await this.google.deleteEvent({
          credentialRef: source.credential_ref,
          calendarId: source.external_calendar_id || 'primary',
          eventId: providerEventId,
          ifMatch,
        });
        await client.query(
          `update calendar_provider_events
           set deleted = true, status = 'cancelled', updated_at = now()
           where workspace_id = $1 and source_id = $2 and provider_event_id = $3`,
          [valid.workspaceId, source.id, providerEventId],
        );
        await client.query(
          `delete from calendar_occurrences
           where workspace_id = $1 and source_id = $2 and provider_event_id = $3`,
          [valid.workspaceId, source.id, providerEventId],
        );
        await client.query(
          `update calendar_mutation_receipts
           set status = 'reconciled', provider_event_id = $3, etag = $4, updated_at = now()
           where workspace_id = $1 and idempotency_key = $2`,
          [valid.workspaceId, key, providerEventId, ifMatch],
        );
        const receipt = await client.query(
          `select * from calendar_mutation_receipts where workspace_id = $1 and idempotency_key = $2`,
          [valid.workspaceId, key],
        );
        return { ok: true, replay: false, receipt: this.#publicReceipt(receipt.rows[0]) };
      } catch (error) {
        if (error && error.code === 'GOOGLE_ETAG_CONFLICT') {
          await client.query(
            `update calendar_mutation_receipts
             set status = 'conflict', error_code = 'GOOGLE_ETAG_CONFLICT', error_message = $3, updated_at = now()
             where workspace_id = $1 and idempotency_key = $2`,
            [valid.workspaceId, key, String(error.message || 'etag conflict')],
          );
          reject('GOOGLE_ETAG_CONFLICT', 'provider etag conflict', 409);
        }
        await client.query(
          `update calendar_mutation_receipts
           set status = 'failed', error_code = $3, error_message = $4, updated_at = now()
           where workspace_id = $1 and idempotency_key = $2`,
          [valid.workspaceId, key, error.code || 'MUTATION_FAILED', String(error.message || error).slice(0, 300)],
        );
        throw error;
      }
    });
  }

  #publicSource(row) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      provider: row.provider,
      sourceKind: row.source_kind,
      label: row.label,
      externalCalendarId: row.external_calendar_id,
      // Never expose credential_ref content as a secret; only presence/status.
      hasCredential: Boolean(row.credential_ref),
      status: row.status,
      writable: Boolean(row.writable),
      timezone: row.timezone,
      selected: Boolean(row.selected),
      shadowOnly: Boolean(row.shadow_only),
      lastSyncedAt: row.last_synced_at,
      lastErrorCode: row.last_error_code || '',
      lastErrorMessage: row.last_error_message || '',
    };
  }

  #publicReceipt(row) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceId: row.source_id,
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      status: row.status,
      providerEventId: row.provider_event_id,
      etag: row.etag,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }
}

module.exports = {
  UnifiedCalendar,
  expandRecurrence,
  googleEventToBounds,
  externalEnabled,
  createDbCredentialVault, // re-export encrypted vault factory
};
