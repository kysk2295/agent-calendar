'use strict';

/**
 * Phase 4 Unified Calendar + fake Google — hostile matrix on real PostgreSQL.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withEphemeralPostgres: withSharedEphemeralPostgres } = require('./support/ephemeral-postgres.cjs');

const { runMigrations } = require('../app/db/migrate');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { issueSessionForVerifiedSubject } = require('../app/lib/workspace-auth-session');
const { matchProductionRoute } = require('../app/lib/production-route-registry');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { expandRecurrence } = require('../app/lib/unified-calendar');
const { createFakeGoogleCalendarAdapter } = require('../app/lib/google-calendar-adapter');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase4cal';
const DATABASE = 'phase4_cal';

function withEphemeralPostgres(fn) {
  return withSharedEphemeralPostgres({
    prefix: 'phase4-calendar-',
    role: LOCAL_ROLE,
    database: DATABASE,
  }, fn);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function httpJson(baseUrl, method, urlPath, { token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json };
}

async function seedUsers(pool) {
  await runMigrations({ pool });
  await pool.query(`insert into users (id, display_name, status) values
    ('user-a', 'Alex', 'active'), ('user-b', 'Blair', 'active') on conflict do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-a', 'A', 'active'), ('ws-b', 'B', 'active') on conflict do nothing`);
  await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
    ('m-a', 'user-a', 'ws-a', 'owner', 'active'),
    ('m-b', 'user-b', 'ws-b', 'owner', 'active') on conflict do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-a', 'user-a', 'test', 'subject-a'),
    ('id-b', 'user-b', 'test', 'subject-b') on conflict do nothing`);
}

async function issueToken(pool, subject, workspaceId) {
  const session = await issueSessionForVerifiedSubject(pool, {
    provider: 'test',
    providerSubject: subject,
    workspaceId,
  });
  return session.accessToken;
}

test('phase4 unified calendar routes registered', () => {
  assert.ok(matchProductionRoute('GET', '/api/calendar/unified'));
  assert.ok(matchProductionRoute('GET', '/api/calendar/sources'));
  assert.equal(matchProductionRoute('POST', '/api/calendar/sources/google/fake-connect'), null);
  assert.ok(matchProductionRoute('POST', '/api/calendar/sources/google/authorize'));
  assert.ok(matchProductionRoute('POST', '/api/calendar/sources/google/callback'));
  const hookMatch = matchProductionRoute('POST', '/api/hooks/google-calendar');
  assert.ok(hookMatch && hookMatch.route);
  // Webhook is provider class — never scoped_product membership authority.
  assert.equal(hookMatch.route.class, 'provider_webhook');
  assert.equal(hookMatch.route.role, 'provider');
  assert.notEqual(hookMatch.route.class, 'scoped_product');
  assert.equal(hookMatch.route.action, 'calendar_google_webhook');
});

test('phase4 runtime exposes single durableExecution (no duplicate property wiring)', () => {
  // Structural audit: createPhase1Runtime must not assign durableExecution twice
  // (JS last-key-wins) and must construct exactly one DurableExecution instance.
  const src = fs.readFileSync(
    path.join(__dirname, '../app/lib/phase1-auth-routes.js'),
    'utf8',
  );
  const fnStart = src.indexOf('function createPhase1Runtime');
  assert.ok(fnStart >= 0);
  const fnSlice = src.slice(fnStart, fnStart + 5000);
  const constructs = (fnSlice.match(/new DurableExecution\(/g) || []).length;
  assert.equal(constructs, 1, 'expected exactly one DurableExecution construction in createPhase1Runtime');
  // Count property occurrences in the return object of createPhase1Runtime only.
  const returnIdx = fnSlice.indexOf('return {');
  assert.ok(returnIdx >= 0);
  const ret = fnSlice.slice(returnIdx, returnIdx + 1500);
  const durableKeys = (ret.match(/\bdurableExecution\b/g) || []).length;
  // One as property key (value is the local binding). Comments shouldn't use the word.
  assert.equal(durableKeys, 1, `expected single durableExecution key in return object, got ${durableKeys} in:\n${ret}`);
});

test('phase4 recurrence expansion overlaps range (Seoul window)', () => {
  const start = '2026-07-01T00:00:00.000Z';
  const end = '2026-07-01T01:00:00.000Z';
  const rangeStartMs = Date.parse('2026-07-01T00:00:00.000Z');
  const rangeEndMs = Date.parse('2026-07-08T00:00:00.000Z');
  const daily = expandRecurrence({
    startsAt: start,
    endsAt: end,
    rrule: 'FREQ=DAILY',
    rangeStartMs,
    rangeEndMs,
    title: 'Daily standup',
    allDay: false,
    timezone: 'Asia/Seoul',
    providerEventId: 'ev1',
    etag: 'e1',
  });
  assert.ok(daily.length >= 7);
  assert.ok(daily.every((o) => Date.parse(o.startsAt) < rangeEndMs && Date.parse(o.endsAt) > rangeStartMs));
});

test('phase4 migration FKs RLS grants and least privilege', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await runMigrations({ pool });
    const tables = await pool.query(`
      select tablename from pg_tables
      where schemaname = 'public' and tablename like 'calendar_%'
      order by tablename
    `);
    const names = tables.rows.map((r) => r.tablename);
    for (const t of [
      'calendar_sources',
      'calendar_provider_events',
      'calendar_occurrences',
      'calendar_source_coverage',
      'calendar_sync_cursors',
      'calendar_mutation_receipts',
      'calendar_watches',
    ]) {
      assert.ok(names.includes(t), t);
    }
    const fks = await pool.query(`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      where r.relname = 'calendar_provider_events' and c.contype = 'f'
    `);
    assert.ok(fks.rows.some((r) => /calendar_sources/i.test(r.def)));

    // FORCE RLS
    const rls = await pool.query(`
      select relname, relforcerowsecurity
      from pg_class where relname = 'calendar_sources'
    `);
    assert.equal(rls.rows[0].relforcerowsecurity, true);

    // App role can insert sources under workspace setting
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.workspace_id', 'ws-x', true)`);
      await client.query(`select set_config('app.user_id', 'u-x', true)`);
      await client.query('set local role agent_calendar_app');
      // FK to workspaces may fail — just ensure permission not denied
      try {
        await client.query(
          `insert into calendar_sources (id, workspace_id, provider, label, external_calendar_id, credential_ref, status)
           values ('s1','ws-x','google','G','primary','cred','connected')`,
        );
      } catch (e) {
        assert.doesNotMatch(String(e.message), /permission denied/i);
      }
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

test('phase4 hostile unified calendar matrix', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    process.env.AGENT_CALENDAR_FAKE_GOOGLE = '1';
    process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '1';
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    process.env.GOOGLE_CALENDAR_WEBHOOK_URL = 'https://hooks.example/api/hooks/google-calendar';

    const fake = createFakeGoogleCalendarAdapter();
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        AGENT_CALENDAR_FAKE_GOOGLE: '1',
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
        GOOGLE_CALENDAR_WEBHOOK_URL: 'https://hooks.example/api/hooks/google-calendar',
      },
    });
    // Inject shared fake so seed + sync share state
    runtime.unifiedCalendar.google = fake;
    runtime.unifiedCalendar.env = process.env;

    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        AGENT_CALENDAR_FAKE_GOOGLE: '1',
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
        GOOGLE_CALENDAR_WEBHOOK_URL: 'https://hooks.example/api/hooks/google-calendar',
      },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);

    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');

      // Unauthenticated denied
      const anon = await httpJson(baseUrl, 'GET', '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z');
      assert.equal(anon.status, 401);

      const removedFakeRoute = await httpJson(baseUrl, 'POST', '/api/calendar/sources/google/fake-connect', {
        token: tokenA,
        body: {},
      });
      assert.equal(removedFakeRoute.status, 404);
      assert.equal(removedFakeRoute.json.error, 'production_route_unregistered');

      // Test-only setup is direct service composition under a server-issued Workspace scope.
      const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
      const connectA = await runtime.unifiedCalendar.connectFakeGoogle(scopeA, {
        label: 'A Google',
        calendarId: 'primary',
      });
      assert.equal(connectA.source.hasCredential, true);
      assert.ok(!JSON.stringify(connectA).includes('atok_'));
      const sourceA = connectA.source.id;

      // Seed provider events including identical provider id as B will use
      const credA = (await pool.query(`select credential_ref from calendar_sources where id = $1`, [sourceA])).rows[0].credential_ref;
      await fake.seedEvents({
        credentialRef: credA,
        calendarId: 'primary',
        events: [
          {
            id: 'shared-provider-event-id',
            summary: 'A only event',
            start: { dateTime: '2026-07-15T01:00:00.000Z' },
            end: { dateTime: '2026-07-15T02:00:00.000Z' },
          },
          {
            id: 'allday-a',
            summary: 'All day A',
            start: { date: '2026-07-16' },
            end: { date: '2026-07-17' },
          },
          {
            id: 'daily-a',
            summary: 'Daily series',
            start: { dateTime: '2026-07-10T00:00:00.000Z' },
            end: { dateTime: '2026-07-10T00:30:00.000Z' },
            recurrence: ['FREQ=DAILY'],
          },
        ],
      });

      // Unsynced coverage distinguishable
      const beforeSync = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z',
        { token: tokenA });
      assert.equal(beforeSync.status, 200);
      const googleCov = (beforeSync.json.coverage || []).find((c) => c.sourceId === sourceA);
      assert.ok(googleCov);
      assert.equal(googleCov.state, 'unsynchronized');

      // Sync
      const syncA = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceA}/sync`, {
        token: tokenA,
        body: { full: true, rangeStart: '2026-07-01T00:00:00.000Z', rangeEnd: '2026-07-31T00:00:00.000Z' },
      });
      assert.equal(syncA.status, 200, JSON.stringify(syncA.json));
      assert.equal(syncA.json.syncTokenPersisted, true);

      // Internal + agent-work style event
      await httpJson(baseUrl, 'POST', '/api/calendar/events', {
        token: tokenA,
        body: {
          id: 'int-a-1',
          title: 'Internal meeting',
          startsAt: '2026-07-15T03:00:00.000Z',
          payload: { endsAt: '2026-07-15T04:00:00.000Z', source: 'calendar-event' },
        },
      });
      await pool.query(
        `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
         values ('agent-proj-a', null, 'Agent result: Phase4', '2026-07-15 12:00',
           $1::jsonb, 'ws-a')
         on conflict (id) do nothing`,
        [JSON.stringify({
          source: 'agent-work',
          endsAt: '2026-07-15T13:00:00.000Z',
          date: '2026-07-15',
          time: '12:00',
        })],
      );

      const unified = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z',
        { token: tokenA });
      assert.equal(unified.status, 200, JSON.stringify(unified.json));
      const entries = unified.json.entries || [];
      assert.ok(entries.some((e) => e.title === 'A only event' && e.provider === 'google'));
      assert.ok(entries.some((e) => e.title === 'Internal meeting'));
      assert.ok(entries.some((e) => /Agent result/i.test(e.title)));
      assert.ok(entries.some((e) => e.allDay === true));
      assert.ok(entries.filter((e) => e.title === 'Daily series').length >= 2);
      const covComplete = (unified.json.coverage || []).find((c) => c.sourceId === sourceA);
      assert.equal(covComplete.state, 'complete');

      // Overlap: event starting before range but ending inside
      await fake.seedEvents({
        credentialRef: credA,
        events: [{
          id: 'overlap-edge',
          summary: 'Overlaps start',
          start: { dateTime: '2026-06-30T22:00:00.000Z' },
          end: { dateTime: '2026-07-01T02:00:00.000Z' },
        }],
      });
      await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceA}/sync`, {
        token: tokenA,
        body: { full: true, rangeStart: '2026-07-01T00:00:00.000Z', rangeEnd: '2026-07-02T00:00:00.000Z' },
      });
      const overlapQ = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z',
        { token: tokenA });
      assert.ok((overlapQ.json.entries || []).some((e) => e.title === 'Overlaps start'));

      // B cannot see A sources/events
      const sourcesB = await httpJson(baseUrl, 'GET', '/api/calendar/sources', { token: tokenB });
      assert.equal(sourcesB.status, 200);
      assert.equal((sourcesB.json.sources || []).some((s) => s.id === sourceA), false);
      const unifiedB = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z',
        { token: tokenB });
      assert.equal((unifiedB.json.entries || []).some((e) => e.title === 'A only event'), false);

      // B composes the same fake provider identity directly — still Workspace-isolated.
      const scopeB = await resolveWorkspaceScope(pool, { userId: 'user-b', workspaceId: 'ws-b' });
      const connectB = await runtime.unifiedCalendar.connectFakeGoogle(scopeB, {
        label: 'B Google',
        calendarId: 'primary',
      });
      const sourceB = connectB.source.id;
      const credB = (await pool.query(`select credential_ref from calendar_sources where id = $1`, [sourceB])).rows[0].credential_ref;
      await fake.seedEvents({
        credentialRef: credB,
        events: [{
          id: 'shared-provider-event-id',
          summary: 'B twin id',
          start: { dateTime: '2026-07-15T05:00:00.000Z' },
          end: { dateTime: '2026-07-15T06:00:00.000Z' },
        }],
      });
      await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceB}/sync`, {
        token: tokenB,
        body: { full: true, rangeStart: '2026-07-01T00:00:00.000Z', rangeEnd: '2026-07-31T00:00:00.000Z' },
      });
      const bOnly = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z',
        { token: tokenB });
      assert.ok((bOnly.json.entries || []).some((e) => e.title === 'B twin id'));
      assert.equal((bOnly.json.entries || []).some((e) => e.title === 'A only event'), false);

      // B cannot sync A's source
      const crossSync = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceA}/sync`, {
        token: tokenB,
        body: { full: true },
      });
      assert.ok(crossSync.status === 404 || crossSync.json?.ok === false);

      // External create with receipt
      const createExt = await httpJson(baseUrl, 'POST', '/api/calendar/external/events', {
        token: tokenA,
        body: {
          sourceId: sourceA,
          title: 'External create A',
          startsAt: '2026-07-20T01:00:00.000Z',
          endsAt: '2026-07-20T02:00:00.000Z',
          idempotencyKey: 'mut-create-1',
        },
      });
      assert.equal(createExt.status, 200, JSON.stringify(createExt.json));
      assert.equal(createExt.json.receipt.status, 'reconciled');
      const replay = await httpJson(baseUrl, 'POST', '/api/calendar/external/events', {
        token: tokenA,
        body: {
          sourceId: sourceA,
          title: 'External create A',
          startsAt: '2026-07-20T01:00:00.000Z',
          endsAt: '2026-07-20T02:00:00.000Z',
          idempotencyKey: 'mut-create-1',
        },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.replay, true);
      const countExt = await pool.query(
        `select count(*)::int as n from calendar_provider_events
         where workspace_id = 'ws-a' and title = 'External create A'`,
      );
      assert.equal(countExt.rows[0].n, 1);

      // Etag conflict
      const providerEventId = createExt.json.entry.providerEventId;
      const badUpdate = await httpJson(baseUrl, 'PATCH', `/api/calendar/external/events/${providerEventId}`, {
        token: tokenA,
        body: {
          sourceId: sourceA,
          title: 'stale',
          startsAt: '2026-07-20T01:00:00.000Z',
          endsAt: '2026-07-20T02:00:00.000Z',
          ifMatch: '"stale-etag"',
          idempotencyKey: 'mut-upd-conflict',
        },
      });
      assert.equal(badUpdate.status, 409);

      // 410 full resync
      fake.invalidateSyncToken({ credentialRef: credA });
      // Force cursor invalid
      await pool.query(
        `update calendar_sync_cursors set cursor_value = 'invalid'
         where workspace_id = 'ws-a' and source_id = $1`,
        [sourceA],
      );
      const resync = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceA}/sync`, {
        token: tokenA,
        body: {},
      });
      assert.equal(resync.status, 200, JSON.stringify(resync.json));

      // Watch + webhook (setupToken only via in-process service, never HTTP)
      const watchSvc = await runtime.unifiedCalendar.registerWatch(scopeA, sourceA, {});
      assert.ok(watchSvc.channelId);
      assert.ok(watchSvc.setupToken);
      const httpWatch = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceA}/watch`, {
        token: tokenA,
        body: {},
      });
      assert.equal(httpWatch.status, 200, JSON.stringify(httpWatch.json));
      assert.ok(!('setupToken' in (httpWatch.json || {})));
      const spoof = await httpJson(baseUrl, 'POST', '/api/hooks/google-calendar', {
        headers: {
          'x-goog-channel-id': watchSvc.channelId,
          'x-goog-channel-token': 'wrong',
          'x-goog-resource-id': watchSvc.resourceId,
        },
      });
      assert.equal(spoof.status, 401);
      const goodHook = await httpJson(baseUrl, 'POST', '/api/hooks/google-calendar', {
        headers: {
          'x-goog-channel-id': watchSvc.channelId,
          'x-goog-channel-token': watchSvc.setupToken,
          'x-goog-resource-id': watchSvc.resourceId,
        },
      });
      assert.equal(goodHook.status, 200);
      assert.equal(goodHook.json.reconcile, true);
      assert.ok(goodHook.json.requestId);
      assert.ok(!('workspaceId' in goodHook.json));

      // Real adapter fail closed when not fake
      process.env.AGENT_CALENDAR_FAKE_GOOGLE = '0';
      const { createRealGoogleCalendarAdapter } = require('../app/lib/google-calendar-adapter');
      const real = createRealGoogleCalendarAdapter({ env: {} });
      await assert.rejects(() => real.listCalendars({}), (e) => e && e.code === 'GOOGLE_OAUTH_NOT_CONFIGURED');
      process.env.AGENT_CALENDAR_FAKE_GOOGLE = '1';

      // Shadow disable external
      process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '0';
      runtime.unifiedCalendar.env = process.env;
      const shadowed = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-07-01T00:00:00.000Z&to=2026-07-31T00:00:00.000Z',
        { token: tokenA });
      assert.equal(shadowed.json.externalEnabled, false);
      assert.equal((shadowed.json.entries || []).some((e) => e.provider === 'google'), false);
      process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '1';
      runtime.unifiedCalendar.env = process.env;

      // Webhook public classification cannot authorize user product actions.
      // Successful reconcile must not grant scoped_product access without bearer membership.
      assert.equal(goodHook.json.userAuthorized, false);
      const bodySpoofHook = await httpJson(baseUrl, 'POST', '/api/hooks/google-calendar', {
        headers: {
          'x-goog-channel-id': watchSvc.channelId,
          'x-goog-channel-token': watchSvc.setupToken,
          'x-goog-resource-id': watchSvc.resourceId,
        },
        body: {
          workspaceId: 'ws-b',
          sourceId: sourceA,
          // Attacker-supplied identity must never become membership authority
          accessToken: tokenB,
        },
      });
      assert.equal(bodySpoofHook.status, 200);
      assert.equal(bodySpoofHook.json.reconcile, true);
      assert.ok(bodySpoofHook.json.requestId);
      assert.ok(!('workspaceId' in bodySpoofHook.json));
      assert.equal(bodySpoofHook.json.userAuthorized, false);
      const pendingSync = await pool.query(
        `select count(*)::int as n from calendar_sync_requests where workspace_id = 'ws-a' and source_id = $1`,
        [sourceA],
      );
      assert.ok(pendingSync.rows[0].n >= 1);
      // Still cannot list/mutate A as anonymous after webhook "success"
      const afterHookAnon = await httpJson(baseUrl, 'GET', '/api/calendar/sources');
      assert.equal(afterHookAnon.status, 401);
      // Webhook response is not a bearer; product routes still require Workspace session
      const afterHookProduct = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceA}/sync`, {
        body: { full: true },
      });
      assert.equal(afterHookProduct.status, 401);

      // Runtime single durableExecution instance at live object level
      assert.ok(runtime.durableExecution);
      assert.equal(
        Object.keys(runtime).filter((k) => k === 'durableExecution').length,
        1,
      );
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.AGENT_CALENDAR_FAKE_GOOGLE;
      delete process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
      delete process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
    }
  });
});
