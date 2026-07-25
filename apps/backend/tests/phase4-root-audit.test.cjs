'use strict';

/**
 * Phase 4 root audit A–G — RED first, then GREEN against Unified Calendar + Google adapter.
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
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { issueSessionForVerifiedSubject } = require('../app/lib/workspace-auth-session');
const { matchProductionRoute } = require('../app/lib/production-route-registry');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { createFakeGoogleCalendarAdapter, createRealGoogleCalendarAdapter } = require('../app/lib/google-calendar-adapter');
const { createDbCredentialVault, requireVaultKey } = require('../app/lib/credential-vault');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const TEST_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');

const LOCAL_ROLE = 'phase4root';
const DATABASE = 'phase4_root';

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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-root-'));
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
    return await fn({ pool, connectionString });
  } finally {
    if (pool) try { await pool.end(); } catch { /* ignore */ }
    if (started) stopCluster(binDir, dataDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
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

// ── A: Coverage truth ───────────────────────────────────────────────

test('A coverage: July sync must not claim complete for August query', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    process.env.AGENT_CALENDAR_FAKE_GOOGLE = '1';
    process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '1';
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const fake = createFakeGoogleCalendarAdapter();
    const runtime = createPhase1Runtime({
      pool,
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        AGENT_CALENDAR_FAKE_GOOGLE: '1',
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
      },
    });
    runtime.unifiedCalendar.google = fake;
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        AGENT_CALENDAR_FAKE_GOOGLE: '1',
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
      },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
      const connect = await runtime.unifiedCalendar.connectFakeGoogle(scopeA, {
        label: 'G', calendarId: 'primary', seedDemo: false,
      });
      const sourceId = connect.source.id;
      const cred = (await pool.query(`select credential_ref from calendar_sources where id = $1`, [sourceId])).rows[0].credential_ref;
      await fake.seedEvents({
        credentialRef: cred,
        events: [{
          id: 'july-only',
          summary: 'July only',
          start: { dateTime: '2026-07-15T10:00:00.000Z' },
          end: { dateTime: '2026-07-15T11:00:00.000Z' },
        }],
      });
      const sync = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceId}/sync`, {
        token: tokenA,
        body: {
          full: true,
          rangeStart: '2026-07-01T00:00:00.000Z',
          rangeEnd: '2026-08-01T00:00:00.000Z',
        },
      });
      assert.equal(sync.status, 200, JSON.stringify(sync.json));

      const august = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z',
        { token: tokenA });
      assert.equal(august.status, 200, JSON.stringify(august.json));
      const gCov = (august.json.coverage || []).find((c) => c.sourceId === sourceId);
      assert.ok(gCov, 'google coverage required');
      assert.notEqual(gCov.state, 'complete', `August must not be complete: ${JSON.stringify(gCov)}`);
      assert.ok(['unsynchronized', 'incomplete'].includes(gCov.state), gCov.state);
      if (gCov.coveredIntervals) {
        assert.ok(Array.isArray(gCov.coveredIntervals));
      }

      // Separate internal vs agent_work coverage
      await pool.query(
        `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
         values ('int1', null, 'Internal', '2026-08-10 12:00', $1::jsonb, 'ws-a'),
                ('ag1', null, 'Agent result', '2026-08-10 13:00', $2::jsonb, 'ws-a')
         on conflict do nothing`,
        [
          JSON.stringify({ endsAt: '2026-08-10T13:00:00.000Z', source: 'calendar-event' }),
          JSON.stringify({ endsAt: '2026-08-10T14:00:00.000Z', source: 'agent-work' }),
        ],
      );
      const mixed = await httpJson(baseUrl, 'GET',
        '/api/calendar/unified?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z',
        { token: tokenA });
      const internalCov = (mixed.json.coverage || []).find((c) => c.sourceId === 'internal' && c.sourceKind === 'internal');
      const agentCov = (mixed.json.coverage || []).find((c) => c.sourceId === 'agent_work' || c.sourceKind === 'agent_work');
      assert.ok(internalCov, 'internal coverage statement required');
      assert.ok(agentCov, 'agent_work coverage statement required');
      assert.equal(internalCov.eventCount, 1);
      assert.equal(agentCov.eventCount, 1);
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.AGENT_CALENDAR_FAKE_GOOGLE;
      delete process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED;
    }
  });
});

test('A page limit: >50 pages with nextPageToken must reject and not mark complete', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.AGENT_CALENDAR_FAKE_GOOGLE = '1';
    process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '1';
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const fake = createFakeGoogleCalendarAdapter();
    // Force tiny pages and many events so page count exceeds 50
    const grant = await fake.createGrant({ workspaceId: 'ws-a' });
    const events = [];
    for (let i = 0; i < 120; i += 1) {
      events.push({
        id: `ev-${i}`,
        summary: `E${i}`,
        start: { dateTime: `2026-07-01T${String(i % 20).padStart(2, '0')}:00:00.000Z` },
        end: { dateTime: `2026-07-01T${String(i % 20).padStart(2, '0')}:30:00.000Z` },
      });
    }
    // Override page size to 1 so 120 pages needed
    const g = fake._debugGrant?.(grant.credentialRef) || null;
    // seed via public API
    await fake.seedEvents({ credentialRef: grant.credentialRef, events });
    // monkey-patch listEvents pageSize via grants map internals if available
    if (typeof fake.setPageSize === 'function') {
      fake.setPageSize(grant.credentialRef, 1);
    } else {
      // direct internal access for test
      const grants = fake._grants || null;
    }

    const runtime = createPhase1Runtime({
      pool,
      env: {
        AGENT_CALENDAR_FAKE_GOOGLE: '1',
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
        WORKSPACE_AUTH_MODE: 'production',
      },
    });
    // Use adapter with pageSize 1
    const tiny = createFakeGoogleCalendarAdapter({ pageSize: 1 });
    const g2 = await tiny.createGrant({ workspaceId: 'ws-a' });
    await tiny.seedEvents({
      credentialRef: g2.credentialRef,
      events: Array.from({ length: 55 }, (_, i) => ({
        id: `p${i}`,
        summary: `P${i}`,
        start: { dateTime: '2026-07-10T12:00:00.000Z' },
        end: { dateTime: '2026-07-10T12:30:00.000Z' },
      })),
    });
    runtime.unifiedCalendar.google = tiny;

    // Manually insert source bound to tiny grant
    await pool.query(
      `insert into calendar_sources (
         id, workspace_id, provider, source_kind, label, external_calendar_id,
         credential_ref, status, writable, timezone, selected
       ) values ('src-pages', 'ws-a', 'google', 'external_calendar', 'G', 'primary', $1, 'connected', true, 'UTC', true)`,
      [g2.credentialRef],
    );

    const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        AGENT_CALENDAR_FAKE_GOOGLE: '1',
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
      },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const sync = await httpJson(baseUrl, 'POST', '/api/calendar/sources/src-pages/sync', {
        token: tokenA,
        body: { full: true, rangeStart: '2026-07-01T00:00:00.000Z', rangeEnd: '2026-08-01T00:00:00.000Z' },
      });
      assert.ok(sync.status >= 400, `expected reject, got ${sync.status} ${JSON.stringify(sync.json)}`);
      assert.match(String(sync.json.error || sync.json.message || ''), /PAGE_LIMIT|page/i);
      const cov = await pool.query(
        `select state from calendar_source_coverage where source_id = 'src-pages' and workspace_id = 'ws-a'`,
      );
      assert.ok(!cov.rows.some((r) => r.state === 'complete'), 'must not mark complete after page exhaustion');
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
    }
  });
});

// ── B: Real adapter with vault + fetch ──────────────────────────────

test('B real adapter listEvents via vault + fetch (mocked)', async () => {
  const calls = [];
  const vault = {
    async getTokens(credentialRef) {
      assert.equal(credentialRef, 'cred_ref_1');
      return {
        accessToken: 'ya29.access',
        refreshToken: '1//refresh',
        accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
    async putTokens() { /* rotation */ },
  };
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    if (String(url).includes('/calendar/v3/calendars/primary/events')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: 'g1',
            summary: 'Real event',
            status: 'confirmed',
            start: { dateTime: '2026-07-15T15:00:00-04:00', timeZone: 'America/New_York' },
            end: { dateTime: '2026-07-15T16:00:00-04:00', timeZone: 'America/New_York' },
            etag: '"e1"',
          }],
          nextSyncToken: 'sync_abc',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const real = createRealGoogleCalendarAdapter({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example/oauth/google/callback',
    },
    fetchImpl,
    credentialVault: vault,
  });
  const listed = await real.listEvents({
    credentialRef: 'cred_ref_1',
    calendarId: 'primary',
    timeMin: '2026-07-01T00:00:00.000Z',
    timeMax: '2026-08-01T00:00:00.000Z',
    singleEvents: true,
    showDeleted: true,
  });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].summary, 'Real event');
  assert.ok(calls.some((c) => /singleEvents=true/.test(c.url) || (c.url.includes('events') && c.url.includes('singleEvents'))));
  assert.ok(calls[0].headers.authorization === 'Bearer ya29.access' || calls[0].headers.Authorization === 'Bearer ya29.access');
});

test('B real adapter fails closed without vault/oauth', async () => {
  const real = createRealGoogleCalendarAdapter({ env: {}, fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(
    () => real.listEvents({ credentialRef: 'x' }),
    (e) => e && (e.code === 'GOOGLE_OAUTH_NOT_CONFIGURED' || e.code === 'GOOGLE_CREDENTIAL_VAULT_REQUIRED'),
  );
});

test('B real adapter does not retry 409 conflict', async () => {
  let hits = 0;
  const vault = {
    async getTokens() {
      return { accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 1e7).toISOString() };
    },
    async putTokens() {},
  };
  const fetchImpl = async () => {
    hits += 1;
    return { ok: false, status: 409, json: async () => ({ error: { code: 409, message: 'conflict' } }) };
  };
  const real = createRealGoogleCalendarAdapter({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example/cb',
    },
    fetchImpl,
    credentialVault: vault,
  });
  await assert.rejects(() => real.updateEvent({
    credentialRef: 'c',
    calendarId: 'primary',
    eventId: 'e1',
    event: { summary: 'x' },
    ifMatch: '"old"',
  }), (e) => e && (e.status === 409 || e.statusHint === 409 || e.code));
  assert.equal(hits, 1, 'must not retry 4xx conflict');
});

// ── C: OAuth start/finalize ─────────────────────────────────────────

test('C OAuth authorize start and finalize routes registered', () => {
  const start = matchProductionRoute('POST', '/api/calendar/sources/google/authorize');
  const fin = matchProductionRoute('POST', '/api/calendar/sources/google/callback');
  assert.ok(start && start.route, 'authorize start route');
  assert.ok(fin && fin.route, 'callback finalize route');
  assert.equal(start.route.class, 'scoped_product');
  assert.equal(fin.route.class, 'scoped_product');
});

test('C OAuth finalize ignores body workspace authority', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example/oauth/google/callback';
    process.env.GOOGLE_CREDENTIAL_ENCRYPTION_KEY = TEST_VAULT_KEY;
    process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '1';
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    delete process.env.AGENT_CALENDAR_FAKE_GOOGLE;

    const vault = createDbCredentialVault(pool, process.env);
    const fetchImpl = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'ya29.x',
            refresh_token: '1//y',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        };
      }
      if (String(url).includes('/users/me/calendarList')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ id: 'primary', summary: 'Primary', accessRole: 'owner' }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const runtime = createPhase1Runtime({
      pool,
      env: process.env,
    });
    runtime.unifiedCalendar.credentialVault = vault;
    runtime.unifiedCalendar.env = process.env;
    runtime.unifiedCalendar.google = createRealGoogleCalendarAdapter({
      env: process.env,
      fetchImpl,
      credentialVault: vault,
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
      const start = await httpJson(baseUrl, 'POST', '/api/calendar/sources/google/authorize', {
        token: tokenA,
        body: {},
      });
      assert.equal(start.status, 200, JSON.stringify(start.json));
      assert.ok(start.json.authorizationUrl || start.json.url);
      assert.ok(start.json.state);
      assert.ok(!JSON.stringify(start.json).includes('code_verifier') || start.json.codeVerifier === undefined);

      // Attacker tries to finalize into workspace B via body — must bind to session workspace A
      const fin = await httpJson(baseUrl, 'POST', '/api/calendar/sources/google/callback', {
        token: tokenA,
        body: {
          code: 'auth-code-1',
          state: start.json.state,
          workspaceId: 'ws-b',
        },
      });
      assert.equal(fin.status, 200, JSON.stringify(fin.json));
      assert.equal(fin.json.workspaceId, 'ws-a');
      assert.ok(fin.json.source && fin.json.source.id);
      assert.ok(fin.json.source.hasCredential);
      assert.ok(!JSON.stringify(fin.json).includes('ya29'));
      assert.ok(!JSON.stringify(fin.json).includes('1//y'));
      const bSources = await httpJson(baseUrl, 'GET', '/api/calendar/sources', {
        token: await issueToken(pool, 'subject-b', 'ws-b'),
      });
      assert.equal((bSources.json.sources || []).length, 0);
      // Ciphertext in vault is not plaintext
      const vaultRow = await pool.query(
        `select access_token_enc, refresh_token_enc from calendar_credential_vault
         where workspace_id = 'ws-a' limit 1`,
      );
      assert.ok(vaultRow.rowCount);
      assert.ok(String(vaultRow.rows[0].access_token_enc).startsWith('v1:'));
      assert.notEqual(vaultRow.rows[0].access_token_enc, 'ya29.x');
      assert.notEqual(vaultRow.rows[0].refresh_token_enc, '1//y');
      const oauthRow = await pool.query(
        `select code_verifier_enc from calendar_oauth_states where workspace_id = 'ws-a' limit 1`,
      );
      assert.ok(String(oauthRow.rows[0].code_verifier_enc).startsWith('v1:'));
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
      delete process.env.GOOGLE_CREDENTIAL_ENCRYPTION_KEY;
    }
  });
});

test('Vault: fail closed without encryption key; app role cannot read vault', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    // RED-style: no key → putTokens must reject
    const noKey = createDbCredentialVault(pool, {});
    await assert.rejects(
      () => noKey.putTokens('cred_x', { accessToken: 'plain', refreshToken: 'r', workspaceId: 'ws-a' }),
      (e) => e && e.code === 'GOOGLE_VAULT_KEY_REQUIRED',
    );
    await assert.throws(() => requireVaultKey({}), (e) => e && e.code === 'GOOGLE_VAULT_KEY_REQUIRED');

    process.env.GOOGLE_CREDENTIAL_ENCRYPTION_KEY = TEST_VAULT_KEY;
    const vault = createDbCredentialVault(pool, process.env);
    await vault.putTokens('cred_enc', {
      accessToken: 'ya29.secret-token',
      refreshToken: '1//refresh-secret',
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      workspaceId: 'ws-a',
    }, { workspaceId: 'ws-a' });
    const stored = await pool.query(
      `select access_token_enc, refresh_token_enc from calendar_credential_vault where credential_ref = 'cred_enc'`,
    );
    assert.ok(stored.rows[0].access_token_enc.startsWith('v1:'));
    assert.ok(!stored.rows[0].access_token_enc.includes('ya29'));
    assert.ok(!stored.rows[0].refresh_token_enc.includes('refresh-secret'));
    const opened = await vault.getTokens('cred_enc');
    assert.equal(opened.accessToken, 'ya29.secret-token');

    // App role must not have SELECT privilege on vault (service-only).
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
      await client.query(`select set_config('app.user_id', 'user-a', true)`);
      await client.query('set local role agent_calendar_app');
      let denied = false;
      try {
        await client.query(`select access_token_enc from calendar_credential_vault`);
      } catch (e) {
        denied = /permission denied/i.test(String(e.message || e));
      }
      assert.equal(denied, true, 'agent_calendar_app must not SELECT vault ciphertext');
      await client.query('rollback');
    } finally {
      client.release();
      delete process.env.GOOGLE_CREDENTIAL_ENCRYPTION_KEY;
    }
  });
});

// ── D: Webhook durable outbox ───────────────────────────────────────

test('D webhook records durable sync request before 200; drain performs sync', async () => {
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
      env: process.env,
    });
    runtime.unifiedCalendar.google = fake;
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
      const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
      const connect = await runtime.unifiedCalendar.connectFakeGoogle(scopeA, { seedDemo: false });
      const sourceId = connect.source.id;
      const watch = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceId}/watch`, {
        token: tokenA,
        body: {},
      });
      assert.equal(watch.status, 200, JSON.stringify(watch.json));
      assert.ok(!('setupToken' in (watch.json || {})), 'setupToken must not be public');
      // setup token only available via service for tests
      const tokenRow = await pool.query(
        `select token_digest from calendar_watches where channel_id = $1`,
        [watch.json.channelId],
      );
      assert.ok(tokenRow.rowCount);

      // Need actual token for header — use registerWatch return for tests via service
      const watchSvc = await runtime.unifiedCalendar.registerWatch(scopeA, sourceId, {});
      const hook = await httpJson(baseUrl, 'POST', '/api/hooks/google-calendar', {
        headers: {
          'x-goog-channel-id': watchSvc.channelId,
          'x-goog-channel-token': watchSvc.setupToken,
          'x-goog-resource-id': watchSvc.resourceId,
        },
        body: { workspaceId: 'ws-b' },
      });
      assert.equal(hook.status, 200, JSON.stringify(hook.json));
      assert.equal(hook.json.reconcile, true);
      assert.ok(!('workspaceId' in hook.json), 'public webhook must not return workspaceId');
      const pending = await pool.query(
        `select * from calendar_sync_requests where workspace_id = 'ws-a' and source_id = $1 and status = 'pending'`,
        [sourceId],
      );
      assert.ok(pending.rowCount >= 1, 'durable sync request required');

      const drained = await runtime.unifiedCalendar.drainSyncRequests({ limit: 10 });
      assert.ok(drained.processed >= 1);
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
    }
  });
});

// ── E: DELETE + receipt lock + revoke ───────────────────────────────

test('E external delete route and If-Match required', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    process.env.AGENT_CALENDAR_FAKE_GOOGLE = '1';
    process.env.UNIFIED_CALENDAR_EXTERNAL_ENABLED = '1';
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const fake = createFakeGoogleCalendarAdapter();
    const runtime = createPhase1Runtime({ pool, env: process.env });
    runtime.unifiedCalendar.google = fake;
    const server = createRailwayGatewayServer({
      env: process.env,
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      assert.ok(matchProductionRoute('DELETE', '/api/calendar/external/events/x'));
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
      const connect = await runtime.unifiedCalendar.connectFakeGoogle(scopeA, { seedDemo: false });
      const sourceId = connect.source.id;
      const created = await httpJson(baseUrl, 'POST', '/api/calendar/external/events', {
        token: tokenA,
        body: {
          sourceId,
          title: 'To delete',
          startsAt: '2026-07-20T10:00:00.000Z',
          endsAt: '2026-07-20T11:00:00.000Z',
          idempotencyKey: 'del-create-1',
        },
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const providerEventId = created.json.entry.providerEventId;
      const etag = created.json.entry.etag;
      const noMatch = await httpJson(baseUrl, 'DELETE', `/api/calendar/external/events/${providerEventId}`, {
        token: tokenA,
        body: { sourceId },
      });
      assert.equal(noMatch.status, 400);
      const del = await httpJson(baseUrl, 'DELETE', `/api/calendar/external/events/${providerEventId}`, {
        token: tokenA,
        body: { sourceId, ifMatch: etag, idempotencyKey: 'del-1' },
      });
      assert.equal(del.status, 200, JSON.stringify(del.json));
      assert.equal(del.json.receipt.status, 'reconciled');
      const replay = await httpJson(baseUrl, 'DELETE', `/api/calendar/external/events/${providerEventId}`, {
        token: tokenA,
        body: { sourceId, ifMatch: etag, idempotencyKey: 'del-1' },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.replay, true);

      const disc = await httpJson(baseUrl, 'POST', `/api/calendar/sources/${sourceId}/disconnect`, {
        token: tokenA,
        body: {},
      });
      assert.equal(disc.status, 200);
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
    }
  });
});

// ── F: DST / singleEvents ───────────────────────────────────────────

test('F singleEvents preserves America/New_York wall clock across DST', async () => {
  const fake = createFakeGoogleCalendarAdapter({ pageSize: 50 });
  const grant = await fake.createGrant({ workspaceId: 'ws' });
  // Weekly series that crosses US spring DST 2026-03-08
  await fake.seedEvents({
    credentialRef: grant.credentialRef,
    events: [{
      id: 'weekly-ny',
      summary: 'Weekly NY',
      start: { dateTime: '2026-03-01T10:00:00-05:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-03-01T11:00:00-05:00', timeZone: 'America/New_York' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
    }],
  });
  const listed = await fake.listEvents({
    credentialRef: grant.credentialRef,
    calendarId: 'primary',
    timeMin: '2026-03-01T00:00:00.000Z',
    timeMax: '2026-03-31T00:00:00.000Z',
    singleEvents: true,
  });
  const instances = (listed.items || []).filter((i) => /Weekly NY/.test(i.summary || '') || i.recurringEventId === 'weekly-ny' || i.id === 'weekly-ny' || String(i.id).startsWith('weekly-ny'));
  // Prefer expanded instances
  const expanded = listed.items.filter((i) => i.originalStartTime || i.recurringEventId || (i.start && i.start.dateTime));
  assert.ok(expanded.length >= 3, `expected expanded instances, got ${expanded.length}`);
  // Each local hour should be 10:00 America/New_York
  for (const inst of expanded.slice(0, 4)) {
    const dt = inst.start.dateTime || inst.start;
    // Extract hour in America/New_York
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(dt));
    assert.equal(String(Number(hour)), '10', `local wall clock must stay 10:00 NY, got ${hour} for ${dt}`);
  }
});

test('F migration 0020 tables exist', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await runMigrations({ pool });
    for (const t of ['calendar_sync_requests', 'calendar_oauth_states', 'calendar_credential_vault']) {
      const r = await pool.query(`select to_regclass($1) as reg`, [`public.${t}`]);
      assert.ok(r.rows[0].reg, t);
    }
  });
});
