'use strict';

/**
 * Phase 4 third root audit — 3 uncovered required defects.
 * RED first, then GREEN.
 *
 * (1) Deterministic Google create event ID: base32hex [a-v0-9]{5,}, SHA-256(workspace/source/key)
 * (2) updateExternalEvent non-ETag provider failure → receipt status=failed before rethrow
 * (3) Failed old watch stop is retryable via worker path (error → stopped without new watch)
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { issueSessionForVerifiedSubject } = require('../app/lib/workspace-auth-session');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const {
  createFakeGoogleCalendarAdapter,
  deterministicGoogleEventId,
  isAllowedGoogleEventId,
} = require('../app/lib/google-calendar-adapter');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase4s3';
const DATABASE = 'phase4_s3';
const TEST_VAULT_KEY = Buffer.alloc(32, 11).toString('base64');
const GOOGLE_EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((e) => (e ? reject(e) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function runBin(binDir, name, args, options = {}) {
  return execFileSync(path.join(binDir, name), args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

async function waitForReady(binDir, socketDir, port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('PG not ready');
}

function stopCluster(binDir, dataDir) {
  try { runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 }); } catch { /* ignore */ }
}

async function withEphemeralPostgres(fn) {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw Object.assign(new Error('PG binaries missing'), { code: 'PG_BIN_MISSING' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-s3-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  let started = false;
  let pool = null;
  try {
    runBin(binDir, 'initdb', ['-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8'], { timeout: 60_000 });
    started = true;
    runBin(binDir, 'pg_ctl', [
      '-D', dataDir, '-l', path.join(workDir, 'postgres.log'),
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
      'start',
    ], { timeout: 30_000 });
    await waitForReady(binDir, socketDir, port);
    runBin(binDir, 'createdb', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE, DATABASE], { timeout: 15_000 });
    const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${encodeURIComponent(DATABASE)}?host=${encodeURIComponent(socketDir)}&port=${port}`;
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
    return await fn({ pool });
  } finally {
    if (pool) try { await pool.end(); } catch { /* ignore */ }
    if (started) stopCluster(binDir, dataDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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

function stopRuntime(runtime) {
  if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
  if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) {
    runtime.unifiedCalendar.stopBackgroundWorkers();
  }
}

test('1 hostile idempotency key yields Google-allowed base32hex event id (stable)', async () => {
  const hostile = 'wxyz_WXYZ-unicode-한글-punct!@#$%^&*()[]{}|;:\'",.<>?/\\ `~+\n\t';
  // Pure helper must always produce allowed format + stability
  assert.equal(typeof deterministicGoogleEventId, 'function', 'export deterministicGoogleEventId');
  const id1 = deterministicGoogleEventId({
    workspaceId: 'ws-a',
    sourceId: 'src-id',
    idempotencyKey: hostile,
  });
  const id2 = deterministicGoogleEventId({
    workspaceId: 'ws-a',
    sourceId: 'src-id',
    idempotencyKey: hostile,
  });
  assert.equal(id1, id2, 'same key same id');
  assert.match(String(id1), GOOGLE_EVENT_ID_RE);
  assert.ok(isAllowedGoogleEventId(id1));
  // Must not contain disallowed chars (w-z, underscore, unicode)
  assert.doesNotMatch(String(id1), /[w-zW-Z_]/);
  assert.doesNotMatch(String(id1), /[^a-v0-9]/);

  // Different material → different id
  const other = deterministicGoogleEventId({
    workspaceId: 'ws-a',
    sourceId: 'src-other',
    idempotencyKey: hostile,
  });
  assert.notEqual(id1, other);

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
      title: 'Hostile',
      startsAt: '2026-07-21T10:00:00.000Z',
      endsAt: '2026-07-21T11:00:00.000Z',
      idempotencyKey: hostile,
    });
    assert.ok(seenId, 'event id passed to provider');
    assert.match(String(seenId), GOOGLE_EVENT_ID_RE);
    assert.equal(seenId, id1, 'create path uses SHA-256 base32hex of workspace/source/key');
    // Second create same key must not invent a new id (receipt replay) — if it calls provider with id, same
    seenId = null;
    const again = await runtime.unifiedCalendar.createExternalEvent(scope, {
      sourceId: 'src-id',
      title: 'Hostile',
      startsAt: '2026-07-21T10:00:00.000Z',
      endsAt: '2026-07-21T11:00:00.000Z',
      idempotencyKey: hostile,
    });
    assert.ok(again.ok);
    stopRuntime(runtime);
  });
});

test('2 updateExternalEvent non-ETag provider failure persists receipt failed', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    const fake = createFakeGoogleCalendarAdapter();
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    // Seed an event then make update fail with a non-etag error
    const created = await fake.createEvent({
      credentialRef: grant.credentialRef,
      calendarId: 'primary',
      event: {
        summary: 'T',
        start: { dateTime: '2026-07-21T10:00:00.000Z' },
        end: { dateTime: '2026-07-21T11:00:00.000Z' },
      },
      idempotencyKey: 'seed-upd',
    });
    fake.updateEvent = async () => {
      const err = new Error('upstream 503');
      err.code = 'GOOGLE_UNAVAILABLE';
      err.statusHint = 503;
      throw err;
    };
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-u', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true)`,
      [grant.credentialRef],
    );
    await pool.query(
      `insert into calendar_provider_events (
         id, workspace_id, source_id, provider_event_id, title, status, all_day,
         starts_at, ends_at, timezone, etag, payload
       ) values (
         'pe1', 'ws-a', 'src-u', $1, 'T', 'confirmed', false,
         '2026-07-21T10:00:00.000Z', '2026-07-21T11:00:00.000Z', 'UTC', $2, '{}'::jsonb
       )`,
      [created.event.id, created.event.etag],
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    let threw = false;
    try {
      await runtime.unifiedCalendar.updateExternalEvent(scope, {
        sourceId: 'src-u',
        providerEventId: created.event.id,
        title: 'T2',
        startsAt: '2026-07-21T12:00:00.000Z',
        endsAt: '2026-07-21T13:00:00.000Z',
        ifMatch: created.event.etag,
        idempotencyKey: 'upd-fail-1',
      });
    } catch (e) {
      threw = true;
      assert.equal(e.code, 'GOOGLE_UNAVAILABLE');
    }
    assert.equal(threw, true, 'must rethrow provider error');
    const receipt = await pool.query(
      `select status, error_code, error_message from calendar_mutation_receipts
       where workspace_id = 'ws-a' and idempotency_key = 'upd-fail-1'`,
    );
    assert.equal(receipt.rowCount, 1);
    assert.equal(receipt.rows[0].status, 'failed', `expected failed, got ${receipt.rows[0].status}`);
    assert.equal(receipt.rows[0].error_code, 'GOOGLE_UNAVAILABLE');
    stopRuntime(runtime);
  });
});

test('3 failed old watch stop is retryable; fail-once then automatic stop', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    let stopCalls = 0;
    const fake = createFakeGoogleCalendarAdapter();
    const origStop = fake.stopChannel.bind(fake);
    fake.stopChannel = async (args) => {
      stopCalls += 1;
      if (stopCalls === 1) {
        const err = new Error('stop temporarily unavailable');
        err.code = 'GOOGLE_STOP_FAILED';
        throw err;
      }
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
    // Force near-expiry so renew creates new channel and tries to stop old (fails once)
    await pool.query(
      `update calendar_watches set expiration_at = now() + interval '30 minutes' where channel_id = $1`,
      [first.channelId],
    );
    const beforeWatches = await pool.query(
      `select count(*)::int as n from calendar_watches where workspace_id = 'ws-a'`,
    );
    await runtime.unifiedCalendar.renewExpiringWatches({ withinMs: 60 * 60_000 });
    const old = await pool.query(
      `select id, status, payload from calendar_watches where channel_id = $1`,
      [first.channelId],
    );
    assert.equal(old.rows[0].status, 'error', 'stop failure must leave error not stopped');
    assert.ok(
      old.rows[0].payload && (old.rows[0].payload.stopError || JSON.stringify(old.rows[0].payload).includes('STOP')),
      'stop error recorded',
    );
    const afterRenew = await pool.query(
      `select count(*)::int as n from calendar_watches where workspace_id = 'ws-a'`,
    );
    assert.ok(afterRenew.rows[0].n > beforeWatches.rows[0].n, 'new watch created');

    // Explicit stop-retry path must succeed without creating another new watch
    assert.equal(typeof runtime.unifiedCalendar.retryFailedWatchStops, 'function');
    const watchCountBeforeRetry = afterRenew.rows[0].n;
    const retry = await runtime.unifiedCalendar.retryFailedWatchStops({ limit: 10 });
    assert.ok(retry.stopped >= 1, JSON.stringify(retry));
    const oldAfter = await pool.query(
      `select status from calendar_watches where channel_id = $1`,
      [first.channelId],
    );
    assert.equal(oldAfter.rows[0].status, 'stopped');
    const finalCount = await pool.query(
      `select count(*)::int as n from calendar_watches where workspace_id = 'ws-a'`,
    );
    assert.equal(finalCount.rows[0].n, watchCountBeforeRetry, 'stop-retry must not create endless new watches');
    assert.ok(stopCalls >= 2, `expected fail-once then success, stopCalls=${stopCalls}`);

    // Background workers must wire stop-retry
    const src = fs.readFileSync(path.join(__dirname, '../app/lib/unified-calendar.js'), 'utf8');
    assert.match(src, /retryFailedWatchStops/);
    assert.match(src, /startBackgroundWorkers[\s\S]*retryFailedWatchStops|retryFailedWatchStops[\s\S]*startBackgroundWorkers/);

    stopRuntime(runtime);
  });
});

test('4 create then sync yields exactly one occurrence for provider event', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    Object.assign(process.env, envBase());
    const fake = createFakeGoogleCalendarAdapter();
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    runtime.unifiedCalendar.env = process.env;
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, selected
       ) values ('src-dup', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, true)`,
      [grant.credentialRef],
    );
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const key = 'create-sync-once';
    const created = await runtime.unifiedCalendar.createExternalEvent(scope, {
      sourceId: 'src-dup',
      title: 'Google external create',
      startsAt: '2026-07-24T10:00:00.000Z',
      endsAt: '2026-07-24T11:00:00.000Z',
      idempotencyKey: key,
    });
    assert.equal(created.ok, true);
    const peid = created.receipt.providerEventId || created.entry?.providerEventId;
    assert.ok(peid, JSON.stringify(created));

    // Simulate create-path occurrence with a forked (non-ISO Date) key that used to survive poorly.
    await pool.query(
      `insert into calendar_occurrences (
         id, workspace_id, source_id, provider_event_id, occurrence_key, title, all_day,
         starts_at, ends_at, timezone, status, writable, etag, entry_kind, payload
       ) values (
         'fork-occ', 'ws-a', 'src-dup', $1, $2, 'Google external create', false,
         '2026-07-24T10:00:00.000Z', '2026-07-24T11:00:00.000Z', 'UTC', 'confirmed', true, '', 'external', '{}'::jsonb
       ) on conflict do nothing`,
      [peid, `${peid}:LEGACY_FORK_KEY`],
    );

    await runtime.unifiedCalendar.syncSource(scope, 'src-dup', {
      full: true,
      rangeStart: '2026-07-01T00:00:00.000Z',
      rangeEnd: '2026-08-01T00:00:00.000Z',
    });

    const occs = await pool.query(
      `select occurrence_key, provider_event_id, title from calendar_occurrences
       where workspace_id = 'ws-a' and source_id = 'src-dup' and provider_event_id = $1`,
      [peid],
    );
    assert.equal(occs.rowCount, 1, `expected 1 occ after sync rebuild, got ${occs.rowCount}: ${JSON.stringify(occs.rows)}`);

    const unified = await runtime.unifiedCalendar.queryRange(scope, {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
    const matches = (unified.entries || []).filter((e) => e.providerEventId === peid);
    assert.equal(matches.length, 1, JSON.stringify(matches));

    // Replay create same key still one
    await runtime.unifiedCalendar.createExternalEvent(scope, {
      sourceId: 'src-dup',
      title: 'Google external create',
      startsAt: '2026-07-24T10:00:00.000Z',
      endsAt: '2026-07-24T11:00:00.000Z',
      idempotencyKey: key,
    });
    const afterReplay = await pool.query(
      `select count(*)::int as n from calendar_occurrences
       where workspace_id = 'ws-a' and source_id = 'src-dup' and provider_event_id = $1`,
      [peid],
    );
    assert.equal(afterReplay.rows[0].n, 1);

    stopRuntime(runtime);
  });
});
