'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  LEGACY_PERSONAL_WORKSPACE_ID,
} = require('../app/lib/workspace-scope');
const {
  issueSessionForVerifiedSubject,
  refreshSession,
  authenticateAccessToken,
  logoutSession,
} = require('../app/lib/workspace-auth-session');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { WorkspaceScopedProductService } = require('../app/lib/workspace-scoped-product-service');
const { createWorkspaceScheduleCache } = require('../app/lib/workspace-schedule-cache');
const { createWorkspaceSseHub } = require('../app/lib/workspace-sse-hub');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');
const { isProductionWorkspaceAuth } = require('../app/lib/workspace-request-context');

const LOCAL_ROLE = 'phase1sec';
const DATABASE = 'phase1_security';
const MIGRATIONS_DIR = path.join(__dirname, '../app/db/migrations');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function runBin(binDir, name, args, options = {}) {
  return execFileSync(path.join(binDir, name), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

async function waitForReady(binDir, socketDir, port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('ephemeral PostgreSQL did not become ready');
}

function stopCluster(binDir, dataDir) {
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
  } catch {
    // ignore
  }
}

async function withEphemeralPostgres(fn) {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw Object.assign(new Error('PG binaries missing'), { code: 'PG_BIN_MISSING' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-sec-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  let started = false;
  let pool = null;
  try {
    runBin(binDir, 'initdb', ['-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8'], { timeout: 60_000 });
    started = true;
    runBin(binDir, 'pg_ctl', [
      '-D', dataDir, '-l', logFile,
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
      'start',
    ], { timeout: 30_000 });
    await waitForReady(binDir, socketDir, port);
    runBin(binDir, 'createdb', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE, DATABASE], { timeout: 15_000 });
    const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${encodeURIComponent(DATABASE)}?host=${encodeURIComponent(socketDir)}&port=${port}`;
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
    return await fn({ pool, binDir, workDir, dataDir, connectionString });
  } finally {
    if (pool) {
      try { await pool.end(); } catch { /* ignore */ }
    }
    if (started) stopCluster(binDir, dataDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function count(pool, table) {
  const r = await pool.query(`select count(*)::int as n from ${table}`);
  return Number(r.rows[0].n) || 0;
}

async function seedLegacyThenMigrate(pool) {
  const baseline = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^000[1-7]_.*\.sql$/i.test(f)).sort();
  for (const file of baseline) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload)
    values ('legacy-task-1', 'Shared title', 'open', 'OwnerLabel', '', '', '', '{}'::jsonb)`);
  await pool.query(`insert into calendar_events (id, task_id, title, starts_at, payload)
    values ('legacy-event-1', 'legacy-task-1', 'Shared title', '2026-07-24 09:00', '{}'::jsonb)`);
  await pool.query(`insert into agents (id, payload) values ('legacy-agent-1', '{}'::jsonb)`);
  await pool.query(`insert into documents (id, title, path, source, payload)
    values ('legacy-doc-1', 'Legacy Doc', 'wiki/legacy.md', 'wiki', '{}'::jsonb)`);
  await pool.query(`insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt, payload)
    values ('legacy-chunk-1', 'wiki', 'legacy-doc-1', 'legacy-doc-1', 'wiki/legacy.md', 'Legacy doc', 0, 'legacy secret alpha', 'legacy secret alpha', '{}'::jsonb)`).catch(async () => {
    // payload column may not exist on wiki_chunks
    await pool.query(`insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt)
      values ('legacy-chunk-1', 'wiki', 'legacy-doc-1', 'legacy-doc-1', 'wiki/legacy.md', 'Legacy doc', 0, 'legacy secret alpha', 'legacy secret alpha')`);
  });
  await pool.query(`insert into agent_missions (id, status, agent_id, report_due_at, payload)
    values ('legacy-mission-1', 'active', 'legacy-agent-1', '', '{}'::jsonb)`);
  await pool.query(`insert into agent_sessions (id, mission_id, task_id, status, payload)
    values ('legacy-session-1', 'legacy-mission-1', 'legacy-task-1', 'active', '{}'::jsonb)`);
  await pool.query(`insert into agent_session_events (id, session_id, sequence, kind, payload)
    values ('legacy-evt-1', 'legacy-session-1', 1, 'checkpoint', '{"text":"legacy only"}'::jsonb)`);

  const pre = {
    tasks: await count(pool, 'tasks'),
    calendar_events: await count(pool, 'calendar_events'),
    agents: await count(pool, 'agents'),
    documents: await count(pool, 'documents'),
    wiki_chunks: await count(pool, 'wiki_chunks'),
    agent_missions: await count(pool, 'agent_missions'),
    agent_sessions: await count(pool, 'agent_sessions'),
    agent_session_events: await count(pool, 'agent_session_events'),
  };

  await runMigrations({ pool });

  const post = {
    tasks: await count(pool, 'tasks'),
    calendar_events: await count(pool, 'calendar_events'),
    agents: await count(pool, 'agents'),
    documents: await count(pool, 'documents'),
    wiki_chunks: await count(pool, 'wiki_chunks'),
    agent_missions: await count(pool, 'agent_missions'),
    agent_sessions: await count(pool, 'agent_sessions'),
    agent_session_events: await count(pool, 'agent_session_events'),
  };
  return { pre, post };
}

async function seedTwoWorkspaces(pool) {
  await pool.query(`insert into users (id, display_name, status) values
    ('user-a', 'Alex', 'active'),
    ('user-b', 'Blair', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-a', 'Workspace A', 'active'),
    ('ws-b', 'Workspace B', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
    ('mem-a', 'user-a', 'ws-a', 'owner', 'active'),
    ('mem-b', 'user-b', 'ws-b', 'owner', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-a', 'user-a', 'test', 'subject-a'),
    ('id-b', 'user-b', 'test', 'subject-b')
    on conflict (id) do nothing`);

  await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id) values
    ('task-a', 'Colliding title', 'open', 'SameLabel', '', '', '', '{}'::jsonb, 'ws-a'),
    ('task-b', 'Colliding title', 'open', 'SameLabel', '', '', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id) values
    ('event-a', 'task-a', 'Colliding title', '2026-07-25 10:00', '{}'::jsonb, 'ws-a'),
    ('event-b', 'task-b', 'Colliding title', '2026-07-25 10:00', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into documents (id, title, path, source, payload, workspace_id) values
    ('doc-a', 'Secret Wiki', 'wiki/secret.md', 'wiki', '{}'::jsonb, 'ws-a'),
    ('doc-b', 'Secret Wiki', 'wiki/secret.md', 'wiki', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt, workspace_id) values
    ('chunk-a', 'wiki', 'doc-a', 'doc-a', 'wiki/secret.md', 'Secret Wiki', 0, 'alpha workspace unique token A-ONLY', 'A-ONLY', 'ws-a'),
    ('chunk-b', 'wiki', 'doc-b', 'doc-b', 'wiki/secret.md', 'Secret Wiki', 0, 'beta workspace unique token B-ONLY', 'B-ONLY', 'ws-b')`);
  await pool.query(`insert into agent_missions (id, status, agent_id, report_due_at, payload, workspace_id) values
    ('mission-a', 'active', 'legacy-agent-1', '', '{}'::jsonb, 'ws-a'),
    ('mission-b', 'active', 'legacy-agent-1', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_sessions (id, mission_id, task_id, status, payload, workspace_id) values
    ('session-a', 'mission-a', 'task-a', 'active', '{}'::jsonb, 'ws-a'),
    ('session-b', 'mission-b', 'task-b', 'active', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id) values
    ('evt-a', 'session-a', 1, 'checkpoint', '{"text":"A-SSE"}'::jsonb, 'ws-a'),
    ('evt-b', 'session-b', 1, 'checkpoint', '{"text":"B-SSE"}'::jsonb, 'ws-b')`);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function httpJson(baseUrl, method, urlPath, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json };
}

test('workspace auth mode helper defaults to legacy', () => {
  assert.equal(isProductionWorkspaceAuth({ WORKSPACE_AUTH_MODE: 'legacy' }), false);
  assert.equal(isProductionWorkspaceAuth({ WORKSPACE_AUTH_MODE: 'production' }), true);
  assert.equal(isProductionWorkspaceAuth({}), false);
});

test('Phase 1 security boundary on real PostgreSQL: ownership, RLS, sessions, routes, cache, SSE', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    const { pre, post } = await seedLegacyThenMigrate(pool);
    assert.deepEqual(post, pre, 'row counts preserved across 0008-0012');

    // Schema presence
    for (const table of ['auth_sessions', 'auth_refresh_tokens', 'audit_events', 'idempotency_keys']) {
      const exists = await pool.query(
        `select 1 from information_schema.tables where table_schema='public' and table_name=$1`,
        [table],
      );
      assert.equal(exists.rowCount, 1, `${table} must exist`);
    }
    const legacyTask = await pool.query(`select workspace_id from tasks where id='legacy-task-1'`);
    assert.equal(legacyTask.rows[0].workspace_id, LEGACY_PERSONAL_WORKSPACE_ID);

    await seedTwoWorkspaces(pool);

    // Sessions from verified provider subjects
    const sessionA = await issueSessionForVerifiedSubject(pool, {
      provider: 'test',
      providerSubject: 'subject-a',
      workspaceId: 'ws-a',
    });
    const sessionB = await issueSessionForVerifiedSubject(pool, {
      provider: 'test',
      providerSubject: 'subject-b',
      workspaceId: 'ws-b',
    });
    assert.equal(sessionA.workspaceId, 'ws-a');
    assert.equal(sessionB.workspaceId, 'ws-b');
    assert.equal(sessionA.role, 'owner');

    // Body workspace authority: subject-a cannot take ws-b
    await assert.rejects(
      () => issueSessionForVerifiedSubject(pool, {
        provider: 'test',
        providerSubject: 'subject-a',
        workspaceId: 'ws-b',
      }),
      /forbidden|membership|inactive/i,
    );

    // Access auth
    const authA = await authenticateAccessToken(pool, sessionA.accessToken);
    assert.equal(authA.scope.workspaceId, 'ws-a');

    // Refresh rotation + replay
    const rotated = await refreshSession(pool, { refreshToken: sessionA.refreshToken });
    assert.ok(rotated.accessToken);
    assert.notEqual(rotated.refreshToken, sessionA.refreshToken);
    await assert.rejects(
      () => refreshSession(pool, { refreshToken: sessionA.refreshToken }),
      /replay|revoked/i,
    );
    // After replay, family revoked — new refresh also fails
    await assert.rejects(
      () => refreshSession(pool, { refreshToken: rotated.refreshToken }),
      /revoked|invalid|forbidden/i,
    );

    // Fresh session for further tests
    const liveA = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a',
    });
    const liveB = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-b', workspaceId: 'ws-b',
    });

    const product = new WorkspaceScopedProductService({ pool, useAppRole: true });
    const tasksA = await product.listTasks(liveA.scope);
    assert.equal(tasksA.some((t) => t.id === 'task-a'), true);
    assert.equal(tasksA.some((t) => t.id === 'task-b'), false);
    assert.equal(await product.getTaskById(liveA.scope, 'task-b'), null);
    assert.equal((await product.getTaskById(liveA.scope, 'task-a')).id, 'task-a');

    const wikiA = await product.searchWiki(liveA.scope, 'A-ONLY');
    assert.equal(wikiA.some((r) => String(r.excerpt || r.title || '').includes('A-ONLY') || r.id === 'chunk-a'), true);
    const wikiCross = await product.searchWiki(liveA.scope, 'B-ONLY');
    assert.equal(wikiCross.some((r) => r.id === 'chunk-b'), false);

    const eventsA = await product.listAgentSessionEvents(liveA.scope, 'session-a');
    assert.equal(eventsA.some((e) => e.id === 'evt-a'), true);
    assert.equal((await product.listAgentSessionEvents(liveA.scope, 'session-b')).length, 0);

    // Direct SQL under non-BYPASSRLS app role
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role agent_calendar_app');
      await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
      await client.query(`select set_config('app.user_id', 'user-a', true)`);
      const seen = await client.query(`select id from tasks where id = 'task-b'`);
      assert.equal(seen.rowCount, 0, 'RLS must hide other workspace task by known id');
      const own = await client.query(`select id from tasks where id = 'task-a'`);
      assert.equal(own.rowCount, 1);
      await assert.rejects(
        () => client.query(
          `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id)
           values ('evil', 'x', 'open', '', '', '', '', '{}'::jsonb, 'ws-b')`,
        ),
        /policy|row-level|check/i,
      );
      await assert.rejects(
        () => client.query(`update tasks set title = 'hacked' where id = 'task-b'`),
      );
      await assert.rejects(
        () => client.query(`delete from tasks where id = 'task-b'`),
      );
      await client.query('rollback');
    } finally {
      client.release();
    }

    // Schedule cache isolation
    const cache = createWorkspaceScheduleCache();
    cache.set(liveA.scope, 'item-1', 'same-source', 'm', { workspaceId: 'ws-a', v: 1 });
    cache.set(liveB.scope, 'item-1', 'same-source', 'm', { workspaceId: 'ws-b', v: 2 });
    assert.equal(cache.get(liveA.scope, 'item-1', 'same-source', 'm').workspaceId, 'ws-a');
    assert.equal(cache.get(liveB.scope, 'item-1', 'same-source', 'm').workspaceId, 'ws-b');
    assert.notEqual(
      cache.buildKey(liveA.scope, 'item-1', 'same-source', 'm'),
      cache.buildKey(liveB.scope, 'item-1', 'same-source', 'm'),
    );

    // SSE hub isolation
    const hub = createWorkspaceSseHub();
    const waitB = hub.subscribe(liveB.scope, 'agent-session:session-a', { timeoutMs: 200 });
    const delivered = hub.publish(liveA.scope, 'agent-session:session-a', { text: 'secret-A' });
    assert.equal(delivered, 0, 'A publish must not wake B waiters on same channel name');
    const bPayload = await waitB;
    assert.equal(bPayload.timeout, true);

    const waitA = hub.subscribe(liveA.scope, 'agent-session:session-a', { timeoutMs: 2000 });
    const deliveredA = hub.publish(liveA.scope, 'agent-session:session-a', { text: 'hello-A' });
    assert.equal(deliveredA, 1);
    const aPayload = await waitA;
    assert.equal(aPayload.events[0].text, 'hello-A');

    // Logout / revoked access
    await logoutSession(pool, { accessToken: liveA.accessToken });
    await assert.rejects(
      () => authenticateAccessToken(pool, liveA.accessToken),
      /revoked|invalid/i,
    );

    // HTTP Phase 1 routes via gateway — identity only via trusted verifier Adapter.
    let verifySubject = 'subject-a';
    const runtime = createPhase1Runtime({
      pool,
      sseHub: hub,
      identityVerifier: {
        async verify() {
          return { provider: 'test', providerSubject: verifySubject };
        },
      },
    });
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        HERMES_REMOTE_AUTH_TOKEN: 'legacy-global-token',
      },
      phase1Runtime: runtime,
      gatewayStore: null,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      // Body providerSubject must not establish identity without verifier (verifier present returns Adapter subject).
      const loginA = await httpJson(baseUrl, 'POST', '/api/phase1/auth/session', {
        body: { workspaceId: 'ws-a' },
      });
      assert.equal(loginA.status, 200, JSON.stringify(loginA.json));
      const tokenA = loginA.json.accessToken;
      verifySubject = 'subject-b';
      const loginB = await httpJson(baseUrl, 'POST', '/api/phase1/auth/session', {
        body: { workspaceId: 'ws-b' },
      });
      const tokenB = loginB.json.accessToken;

      const listA = await httpJson(baseUrl, 'GET', '/api/phase1/tasks', { token: tokenA });
      assert.equal(listA.status, 200);
      assert.equal(listA.json.tasks.some((t) => t.id === 'task-a'), true);
      assert.equal(listA.json.tasks.some((t) => t.id === 'task-b'), false);

      const cross = await httpJson(baseUrl, 'GET', '/api/phase1/tasks/task-b', { token: tokenA });
      assert.equal(cross.status, 404);

      const wiki = await httpJson(baseUrl, 'GET', '/api/phase1/wiki/search?q=B-ONLY', { token: tokenA });
      assert.equal(wiki.status, 200);
      assert.equal((wiki.json.results || []).some((r) => r.id === 'chunk-b'), false);

      // Foreign agent session must 404 (no waiter creation / no empty leak).
      const sse = await httpJson(baseUrl, 'GET', '/api/phase1/agent-work/session-b/events', { token: tokenA });
      assert.equal(sse.status, 404);

      // Synthetic embed-probe is intentionally disabled (not Calendar AI cache evidence).
      const probe = await httpJson(baseUrl, 'POST', '/api/phase1/schedule/embed-probe', {
        token: tokenA,
        body: { itemId: 'item-1', source: 'same', model: 'm' },
      });
      assert.equal(probe.status, 410);

      // Production mode blocks legacy unscoped product path even with global bearer.
      const legacy = await httpJson(baseUrl, 'GET', '/api/tasks', {
        token: 'legacy-global-token',
      });
      assert.equal(legacy.status, 401);
      assert.equal(legacy.json.error, 'workspace_auth_required');
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) {
        runtime.unifiedCalendar.stopBackgroundWorkers();
      }
      await close(server);
    }
  });
});
