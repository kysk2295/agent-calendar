'use strict';

/**
 * Phase 4 second root audit (findings 1–11) — RED first, then GREEN.
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
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { createFakeGoogleCalendarAdapter, createRealGoogleCalendarAdapter } = require('../app/lib/google-calendar-adapter');
const { createDbCredentialVault, resolveVaultKeyBytes } = require('../app/lib/credential-vault');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase4s2';
const DATABASE = 'phase4_s2';
const TEST_VAULT_KEY = Buffer.alloc(32, 9).toString('base64');

function withEphemeralPostgres(fn) {
  return withSharedEphemeralPostgres({
    prefix: 'phase4-second-audit-',
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
    ('user-a', 'Alex', 'active'), ('user-a2', 'Alex2', 'active'), ('user-b', 'Blair', 'active')
    on conflict do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-a', 'A', 'active'), ('ws-b', 'B', 'active') on conflict do nothing`);
  await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
    ('m-a', 'user-a', 'ws-a', 'owner', 'active'),
    ('m-a2', 'user-a2', 'ws-a', 'owner', 'active'),
    ('m-b', 'user-b', 'ws-b', 'owner', 'active') on conflict do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-a', 'user-a', 'test', 'subject-a'),
    ('id-a2', 'user-a2', 'test', 'subject-a2'),
    ('id-b', 'user-b', 'test', 'subject-b') on conflict do nothing`);
}

async function issueToken(pool, subject, workspaceId) {
  return (await issueSessionForVerifiedSubject(pool, {
    provider: 'test',
    providerSubject: subject,
    workspaceId,
  })).accessToken;
}

function envBase() {
  return {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_FAKE_GOOGLE: '1',
    UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
    GOOGLE_CALENDAR_WEBHOOK_URL: 'https://hooks.example/api/hooks/google-calendar',
    GOOGLE_CREDENTIAL_ENCRYPTION_KEY: TEST_VAULT_KEY,
  };
}

test('1 UnifiedCalendar has start/stop background workers controlled by env', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/lib/unified-calendar.js'), 'utf8');
  assert.match(src, /startBackgroundWorkers/);
  assert.match(src, /stopBackgroundWorkers/);
  assert.match(src, /UNIFIED_CALENDAR_BACKGROUND_WORKERS|CALENDAR_SYNC_BACKGROUND/);
  const phase1 = fs.readFileSync(path.join(__dirname, '../app/lib/phase1-auth-routes.js'), 'utf8');
  assert.match(phase1, /unifiedCalendar\.startBackgroundWorkers/);
  assert.match(phase1, /UNIFIED_CALENDAR_BACKGROUND_WORKERS|CALENDAR_SYNC_BACKGROUND/);
});

test('2 concurrent drain claims once; stale running reclaimed', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    let listCalls = 0;
    const fake = createFakeGoogleCalendarAdapter();
    const origList = fake.listEvents.bind(fake);
    fake.listEvents = async (...args) => {
      listCalls += 1;
      await new Promise((r) => setTimeout(r, 80));
      return origList(...args);
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    runtime.unifiedCalendar.env = process.env;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-d', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true)`,
      [grant.credentialRef],
    );
    await pool.query(
      `insert into calendar_sync_requests (id, workspace_id, source_id, reason, status, next_attempt_at)
       values ('req-1', 'ws-a', 'src-d', 'webhook', 'pending', now())`,
    );
    const [a, b] = await Promise.all([
      runtime.unifiedCalendar.drainSyncRequests({ limit: 5 }),
      runtime.unifiedCalendar.drainSyncRequests({ limit: 5 }),
    ]);
    assert.equal((a.processed || 0) + (b.processed || 0), 1, `exactly one process: ${JSON.stringify({ a, b })}`);
    assert.equal(listCalls, 1, `provider list once, got ${listCalls}`);

    // Stale running recovery
    await pool.query(
      `insert into calendar_sync_requests (
         id, workspace_id, source_id, reason, status, next_attempt_at, claimed_at, lease_expires_at, attempt_count
       ) values ('req-stale', 'ws-a', 'src-d', 'webhook', 'running', now() - interval '1 hour',
                 now() - interval '1 hour', now() - interval '1 minute', 1)`,
    );
    listCalls = 0;
    const recovered = await runtime.unifiedCalendar.drainSyncRequests({ limit: 5 });
    assert.ok(recovered.processed >= 1 || recovered.reclaimed >= 1, JSON.stringify(recovered));
    if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
    if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('3 webhook idempotency: same message number enqueues one request', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    const fake = createFakeGoogleCalendarAdapter();
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    runtime.unifiedCalendar.env = process.env;
    const server = createRailwayGatewayServer({
      env: process.env,
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
      const connect = await runtime.unifiedCalendar.connectFakeGoogle(scope, { seedDemo: false });
      const sourceId = connect.source.id;
      const watch = await runtime.unifiedCalendar.registerWatch(scope, sourceId, {});
      const headers = {
        'x-goog-channel-id': watch.channelId,
        'x-goog-channel-token': watch.setupToken,
        'x-goog-resource-id': watch.resourceId,
        'x-goog-message-number': '42',
      };
      const h1 = await httpJson(baseUrl, 'POST', '/api/hooks/google-calendar', { headers });
      const h2 = await httpJson(baseUrl, 'POST', '/api/hooks/google-calendar', { headers });
      assert.equal(h1.status, 200);
      assert.equal(h2.status, 200);
      const rows = await pool.query(
        `select count(*)::int as n from calendar_sync_requests
         where workspace_id = 'ws-a' and source_id = $1 and idempotency_key <> ''`,
        [sourceId],
      );
      assert.equal(rows.rows[0].n, 1, 'one idempotent sync request');
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
    }
  });
});

test('4 watch renew creates new channel before stopping old', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    const events = [];
    const fake = createFakeGoogleCalendarAdapter();
    const origWatch = fake.watch.bind(fake);
    const origStop = fake.stopChannel.bind(fake);
    fake.watch = async (args) => {
      events.push({ op: 'watch', id: args.channelId });
      return origWatch(args);
    };
    fake.stopChannel = async (args) => {
      events.push({ op: 'stop', id: args.channelId });
      return origStop(args);
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    runtime.unifiedCalendar.env = process.env;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-w', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true)`,
      [grant.credentialRef],
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const first = await runtime.unifiedCalendar.registerWatch(scope, 'src-w', {});
    // Force near-expiry
    await pool.query(
      `update calendar_watches set expiration_at = now() + interval '30 minutes' where channel_id = $1`,
      [first.channelId],
    );
    events.length = 0;
    const renewed = await runtime.unifiedCalendar.renewExpiringWatches({ withinMs: 60 * 60_000 });
    assert.ok(renewed.renewed >= 1, JSON.stringify(renewed));
    const watchIdx = events.findIndex((e) => e.op === 'watch');
    const stopIdx = events.findIndex((e) => e.op === 'stop');
    assert.ok(watchIdx >= 0 && stopIdx >= 0, JSON.stringify(events));
    assert.ok(watchIdx < stopIdx, `new watch before stop: ${JSON.stringify(events)}`);
    const old = await pool.query(`select status from calendar_watches where channel_id = $1`, [first.channelId]);
    assert.equal(old.rows[0].status, 'stopped');
    if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
    if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('5 concurrent same idempotency key calls provider once; readonly reject', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    let creates = 0;
    const fake = createFakeGoogleCalendarAdapter();
    const orig = fake.createEvent.bind(fake);
    fake.createEvent = async (args) => {
      creates += 1;
      await new Promise((r) => setTimeout(r, 50));
      return orig(args);
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-m', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true),
                ('src-ro', 'ws-a', 'google', 'external_calendar', 'RO', 'primary2', $1, 'connected', false, true)`,
      [grant.credentialRef],
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const body = {
      sourceId: 'src-m',
      title: 'Once',
      startsAt: '2026-07-20T10:00:00.000Z',
      endsAt: '2026-07-20T11:00:00.000Z',
      idempotencyKey: 'same-key-1',
    };
    const [r1, r2] = await Promise.all([
      runtime.unifiedCalendar.createExternalEvent(scope, body),
      runtime.unifiedCalendar.createExternalEvent(scope, body),
    ]);
    assert.ok(r1.ok && r2.ok);
    assert.equal(creates, 1, `provider create once, got ${creates}`);
    await assert.rejects(
      () => runtime.unifiedCalendar.updateExternalEvent(scope, {
        sourceId: 'src-ro', providerEventId: 'x', title: 'nope',
        startsAt: '2026-07-20T10:00:00.000Z', endsAt: '2026-07-20T11:00:00.000Z', ifMatch: '"e"',
      }),
      (e) => e && (e.code === 'SOURCE_READ_ONLY' || /read.?only/i.test(e.message)),
    );
    if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
    if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('6 disconnect keeps local truth on provider revoke failure', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    const fake = createFakeGoogleCalendarAdapter();
    fake.revoke = async () => {
      const err = new Error('revoke failed');
      err.code = 'GOOGLE_REVOKE_FAILED';
      err.statusHint = 502;
      throw err;
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-rev', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true)`,
      [grant.credentialRef],
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    await assert.rejects(
      () => runtime.unifiedCalendar.disconnectSource(scope, 'src-rev'),
      (e) => e && e.code === 'GOOGLE_REVOKE_FAILED',
    );
    const row = await pool.query(`select status, credential_ref, last_error_code from calendar_sources where id = 'src-rev'`);
    assert.equal(row.rows[0].status, 'error');
    assert.equal(row.rows[0].credential_ref, grant.credentialRef);
    assert.equal(row.rows[0].last_error_code, 'GOOGLE_REVOKE_FAILED');
    if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
    if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('7 real adapter maps 412 to etag conflict; singleEvents with syncToken', async () => {
  const urls = [];
  const vault = {
    async getTokens() {
      return { accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 1e7).toISOString() };
    },
    async putTokens() {},
  };
  const fetchImpl = async (url, opts = {}) => {
    urls.push(String(url));
    if (String(url).includes('/events/') && (opts.method === 'PATCH' || opts.method === 'DELETE')) {
      return { ok: false, status: 412, json: async () => ({ error: { code: 412, message: 'Precondition Failed' } }) };
    }
    if (String(url).includes('/events?') || String(url).includes('/events')) {
      return {
        ok: true, status: 200,
        json: async () => ({ items: [], nextSyncToken: 's1' }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const real = createRealGoogleCalendarAdapter({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example/cb',
    },
    fetchImpl,
    credentialVault: vault,
  });
  await assert.rejects(
    () => real.updateEvent({
      credentialRef: 'c1', calendarId: 'primary', eventId: 'e1',
      event: { summary: 'x' }, ifMatch: '"old"',
    }),
    (e) => e && e.code === 'GOOGLE_ETAG_CONFLICT' && (e.status === 412 || e.statusHint === 409 || e.statusHint === 412),
  );
  await real.listEvents({
    credentialRef: 'c1', calendarId: 'primary', syncToken: 'tok', singleEvents: true,
  });
  assert.ok(urls.some((u) => u.includes('syncToken=tok') && u.includes('singleEvents=true')), urls.join('\n'));
});

test('8 OAuth finalize requires same user_id; app role cannot DML oauth/sync tables', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    delete process.env.AGENT_CALENDAR_FAKE_GOOGLE;
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example/oauth/google/callback';
    const vault = createDbCredentialVault(pool, process.env);
    const fetchImpl = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'ya29.x', refresh_token: '1//y', expires_in: 3600 }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.credentialVault = vault;
    runtime.unifiedCalendar.env = process.env;
    runtime.unifiedCalendar.google = createRealGoogleCalendarAdapter({
      env: process.env, fetchImpl, credentialVault: vault,
    });
    const server = createRailwayGatewayServer({
      env: process.env,
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl,
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const tokenA2 = await issueToken(pool, 'subject-a2', 'ws-a');
      const start = await httpJson(baseUrl, 'POST', '/api/calendar/sources/google/authorize', {
        token: tokenA, body: {},
      });
      assert.equal(start.status, 200, JSON.stringify(start.json));
      // Other owner in same workspace cannot finalize A's state
      const hijack = await httpJson(baseUrl, 'POST', '/api/calendar/sources/google/callback', {
        token: tokenA2,
        body: { code: 'code', state: start.json.state },
      });
      assert.ok(hijack.status >= 400, JSON.stringify(hijack.json));
      assert.match(String(hijack.json.error || ''), /OAUTH_STATE|FORBIDDEN|UNKNOWN/i);

      // App role cannot touch service-owned oauth/sync tables.
      // Use savepoints so the first denial does not abort the whole txn before the second check.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
        await client.query(`select set_config('app.user_id', 'user-a', true)`);
        await client.query('set local role agent_calendar_app');
        let deniedOauth = false;
        let deniedSync = false;
        await client.query('savepoint sp_oauth');
        try {
          await client.query(`select 1 from calendar_oauth_states`);
        } catch (e) {
          deniedOauth = /permission denied/i.test(String(e.message));
          await client.query('rollback to savepoint sp_oauth');
        }
        await client.query('savepoint sp_sync');
        try {
          await client.query(`select 1 from calendar_sync_requests`);
        } catch (e) {
          deniedSync = /permission denied/i.test(String(e.message));
          await client.query('rollback to savepoint sp_sync');
        }
        assert.equal(deniedOauth, true);
        assert.equal(deniedSync, true);
        await client.query('rollback');
      } finally {
        client.release();
      }
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
      delete process.env.AGENT_CALENDAR_FAKE_GOOGLE;
    }
  });
});

test('9 coverage merges adjacent complete intervals', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    const fake = createFakeGoogleCalendarAdapter();
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected, last_synced_at
       ) values ('src-c', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true, now())`,
      [grant.credentialRef],
    );
    await pool.query(
      `insert into calendar_source_coverage (
         id, workspace_id, source_id, range_start, range_end, state, event_count, synced_at, message
       ) values
       ('c1', 'ws-a', 'src-c', '2026-07-01T00:00:00Z', '2026-07-15T00:00:00Z', 'complete', 1, now(), 'a'),
       ('c2', 'ws-a', 'src-c', '2026-07-15T00:00:00Z', '2026-08-01T00:00:00Z', 'complete', 1, now(), 'b')`,
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const q = await runtime.unifiedCalendar.queryRange(scope, {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
    const cov = (q.coverage || []).find((c) => c.sourceId === 'src-c');
    assert.ok(cov);
    assert.equal(cov.state, 'complete', JSON.stringify(cov));
    if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
    if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('10 vault key rejects weak passphrases', () => {
  assert.equal(resolveVaultKeyBytes({ GOOGLE_CREDENTIAL_ENCRYPTION_KEY: 'short' }), null);
  assert.equal(resolveVaultKeyBytes({ GOOGLE_CREDENTIAL_ENCRYPTION_KEY: 'not-base64-or-hex-passphrase!!' }), null);
  assert.ok(resolveVaultKeyBytes({ GOOGLE_CREDENTIAL_ENCRYPTION_KEY: TEST_VAULT_KEY }));
  assert.ok(resolveVaultKeyBytes({ GOOGLE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('hex') }));
});

test('11 createEvent receives deterministic id from idempotency key', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    let seenId = null;
    const fake = createFakeGoogleCalendarAdapter();
    const orig = fake.createEvent.bind(fake);
    fake.createEvent = async (args) => {
      seenId = args.event && args.event.id;
      return orig(args);
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-id', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true)`,
      [grant.credentialRef],
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    await runtime.unifiedCalendar.createExternalEvent(scope, {
      sourceId: 'src-id',
      title: 'Det',
      startsAt: '2026-07-21T10:00:00.000Z',
      endsAt: '2026-07-21T11:00:00.000Z',
      idempotencyKey: 'idem-abc-123',
    });
    assert.ok(seenId, 'event id passed to provider');
    // Google-allowed base32hex only (not raw key slug).
    assert.match(String(seenId), /^[a-v0-9]{5,1024}$/);
    const { deterministicGoogleEventId } = require('../app/lib/google-calendar-adapter');
    assert.equal(
      seenId,
      deterministicGoogleEventId({
        workspaceId: 'ws-a',
        sourceId: 'src-id',
        idempotencyKey: 'idem-abc-123',
      }),
    );
    if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
    if (runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('0021 migration columns exist', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await runMigrations({ pool });
    const cols = await pool.query(
      `select column_name from information_schema.columns
       where table_name = 'calendar_sync_requests'
         and column_name in ('idempotency_key', 'lease_expires_at', 'claimed_at')`,
    );
    assert.equal(cols.rowCount, 3);
  });
});
