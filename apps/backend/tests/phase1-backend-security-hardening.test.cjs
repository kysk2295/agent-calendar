'use strict';

/**
 * Hostile security-hardening suite for Phase 1 backend boundary.
 * These tests are expected to FAIL against the pre-hardening implementation (real RED).
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const {
  issueSessionForVerifiedSubject,
  refreshSession,
  authenticateAccessToken,
} = require('../app/lib/workspace-auth-session');
const { WorkspaceScopedProductService } = require('../app/lib/workspace-scoped-product-service');
const { resolvePostgresBinDir, EXPECTED_PERSISTED_TABLES } = require('../app/lib/phase0-snapshot-restore');
const {
  recordEmbeddingCacheKey,
  embedScheduleRecord,
  clearRecordEmbeddingCacheForTests,
} = require('../app/lib/schedule-assistant');

const LOCAL_ROLE = 'phase1hard';
const DATABASE = 'phase1_hardening';
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
  } catch { /* ignore */ }
}

async function withEphemeralPostgres(fn) {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw Object.assign(new Error('PG binaries missing'), { code: 'PG_BIN_MISSING' });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-hard-'));
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
    return await fn({ pool, binDir, dataDir, workDir });
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

async function bootstrapLegacyAndMigrate(pool) {
  const baseline = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^000[1-7]_.*\.sql$/i.test(f)).sort();
  for (const file of baseline) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  // Seed one row in each of the 16 Phase-0 persisted tables.
  await pool.query(`insert into agents (id, payload) values ('leg-agent', '{}'::jsonb)`);
  await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload)
    values ('leg-task', 't', 'open', '', '', '', '', '{}'::jsonb)`);
  await pool.query(`insert into calendar_events (id, task_id, title, starts_at, payload)
    values ('leg-event', 'leg-task', 'e', '2026-07-24 09:00', '{}'::jsonb)`);
  await pool.query(`insert into runs (id, goal, agent, model, status, wiki_path, payload)
    values ('leg-run', 'g', 'a', 'm', 'done', '', '{}'::jsonb)`);
  await pool.query(`insert into run_logs (run_id, line, payload) values ('leg-run', 'line', '{}'::jsonb)`);
  await pool.query(`insert into chat_messages (id, role, text, run_id, payload)
    values ('leg-chat', 'user', 'hi', 'leg-run', '{}'::jsonb)`);
  await pool.query(`insert into wiki_artifacts (id, run_id, path, status, payload)
    values ('leg-wiki-art', 'leg-run', 'p', 'ok', '{}'::jsonb)`);
  await pool.query(`insert into scheduler_jobs (id, name, agent, model, enabled, interval_minutes, payload)
    values ('leg-job', 'j', 'a', 'm', true, 60, '{}'::jsonb)`);
  await pool.query(`insert into state_meta (key, payload) values ('leg-meta', '{}'::jsonb)`);
  await pool.query(`insert into workboard_pages (id, title, payload) values ('leg-wb', 'w', '{}'::jsonb)`);
  await pool.query(`insert into documents (id, title, path, source, payload)
    values ('leg-doc', 'd', 'wiki/d.md', 'wiki', '{}'::jsonb)`);
  await pool.query(`insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt)
    values ('leg-chunk', 'wiki', 'leg-doc', 'leg-doc', 'wiki/d.md', 'd', 0, 'content', 'ex')`);
  await pool.query(`insert into agent_missions (id, status, agent_id, report_due_at, payload)
    values ('leg-mission', 'active', 'leg-agent', '', '{}'::jsonb)`);
  await pool.query(`insert into agent_sessions (id, mission_id, task_id, status, payload)
    values ('leg-session', 'leg-mission', 'leg-task', 'active', '{}'::jsonb)`);
  await pool.query(`insert into agent_session_events (id, session_id, sequence, kind, payload)
    values ('leg-sevt', 'leg-session', 1, 'checkpoint', '{}'::jsonb)`);
  await pool.query(`insert into agent_reports (id, mission_id, session_id, status, payload)
    values ('leg-report', 'leg-mission', 'leg-session', 'ready', '{}'::jsonb)`);

  const pre = {};
  for (const table of EXPECTED_PERSISTED_TABLES) {
    pre[table] = await count(pool, table);
  }
  assert.equal(Object.keys(pre).length, 16);

  await runMigrations({ pool });

  const post = {};
  for (const table of EXPECTED_PERSISTED_TABLES) {
    post[table] = await count(pool, table);
  }
  assert.deepEqual(post, pre, 'all 16 legacy tables must preserve row counts');
  return { pre, post };
}

async function seedTwoTenants(pool) {
  await pool.query(`insert into users (id, display_name, status) values
    ('user-a', 'A', 'active'), ('user-b', 'B', 'active') on conflict do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-a', 'A', 'active'), ('ws-b', 'B', 'active') on conflict do nothing`);
  await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
    ('mem-a', 'user-a', 'ws-a', 'owner', 'active'),
    ('mem-b', 'user-b', 'ws-b', 'owner', 'active') on conflict do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-a', 'user-a', 'test', 'subject-a'),
    ('id-b', 'user-b', 'test', 'subject-b') on conflict do nothing`);

  await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id) values
    ('task-a', 'Same', 'open', '', '', '', '', '{}'::jsonb, 'ws-a'),
    ('task-b', 'Same', 'open', '', '', '', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id) values
    ('event-a', 'task-a', 'Same', '2026-07-25 10:00', '{}'::jsonb, 'ws-a'),
    ('event-b', 'task-b', 'Same', '2026-07-25 10:00', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into runs (id, goal, agent, model, status, wiki_path, payload, workspace_id) values
    ('run-a', 'g', 'a', 'm', 'done', '', '{}'::jsonb, 'ws-a'),
    ('run-b', 'g', 'a', 'm', 'done', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into wiki_artifacts (id, run_id, path, status, payload, workspace_id) values
    ('wa-a', 'run-a', 'p', 'ok', '{}'::jsonb, 'ws-a'),
    ('wa-b', 'run-b', 'p', 'ok', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into documents (id, title, path, source, payload, workspace_id) values
    ('doc-a', 'Doc', 'wiki/a.md', 'wiki', '{}'::jsonb, 'ws-a'),
    ('doc-b', 'Doc', 'wiki/b.md', 'wiki', '{}'::jsonb, 'ws-b')`);
  // Fixed 256-d vectors for cosine distance tests (distinct per workspace content).
  const vecA = `[${Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  const vecB = `[${Array.from({ length: 256 }, (_, i) => (i === 1 ? 1 : 0)).join(',')}]`;
  await pool.query(
    `insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt, embedding_vector, workspace_id)
     values
     ('chunk-a', 'wiki', 'doc-a', 'doc-a', 'wiki/a.md', 'Doc', 0, 'alpha vector token A-ONLY', 'A-ONLY', $1::vector, 'ws-a'),
     ('chunk-b', 'wiki', 'doc-b', 'doc-b', 'wiki/b.md', 'Doc', 0, 'beta vector token B-ONLY', 'B-ONLY', $2::vector, 'ws-b')`,
    [vecA, vecB],
  );
  await pool.query(`insert into agent_missions (id, status, agent_id, report_due_at, payload, workspace_id) values
    ('mission-a', 'active', 'leg-agent', '', '{}'::jsonb, 'ws-a'),
    ('mission-b', 'active', 'leg-agent', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_sessions (id, mission_id, task_id, status, payload, workspace_id) values
    ('session-a', 'mission-a', 'task-a', 'active', '{}'::jsonb, 'ws-a'),
    ('session-b', 'mission-b', 'task-b', 'active', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id) values
    ('sevt-a', 'session-a', 1, 'checkpoint', '{"text":"A"}'::jsonb, 'ws-a'),
    ('sevt-b', 'session-b', 1, 'checkpoint', '{"text":"B"}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_reports (id, mission_id, session_id, status, payload, workspace_id) values
    ('rep-a', 'mission-a', 'session-a', 'ready', '{}'::jsonb, 'ws-a'),
    ('rep-b', 'mission-b', 'session-b', 'ready', '{}'::jsonb, 'ws-b')`);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function httpJson(baseUrl, method, urlPath, { token, body, headers } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json, text, headers: response.headers };
}

test('1) production runtime without trusted identity verifier rejects body-driven session issue', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    // No identityVerifier injected — production must reject even valid providerSubject.
    const runtime = createPhase1Runtime({ pool });
    const server = createRailwayGatewayServer({
      env: { WORKSPACE_AUTH_MODE: 'production' },
      phase1Runtime: runtime,
      gatewayStore: null,
      fetchImpl: async () => ({ ok: false }),
    });
    const baseUrl = await listen(server);
    try {
      // Attacker supplies only providerSubject/workspaceId — no trusted verifier.
      const res = await httpJson(baseUrl, 'POST', '/api/phase1/auth/session', {
        body: {
          provider: 'test',
          providerSubject: 'subject-a',
          workspaceId: 'ws-a',
        },
      });
      assert.notEqual(res.status, 200, 'must not issue session from untrusted HTTP body identity');
      assert.match(String(res.json.error || res.json.message || ''), /verifier|identity|untrusted|forbidden|required/i);
      assert.equal(res.json.accessToken, undefined);
      // Must not echo raw internal/DB errors
      assert.doesNotMatch(JSON.stringify(res.json), /relation |syntax error|stack|at Object\./i);

      // Body userId/role/providerSubject must never establish identity even if verifier exists later.
      const withForged = await httpJson(baseUrl, 'POST', '/api/phase1/auth/session', {
        body: {
          provider: 'test',
          providerSubject: 'subject-a',
          workspaceId: 'ws-a',
          userId: 'user-a',
          role: 'owner',
        },
      });
      assert.notEqual(withForged.status, 200);
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) {
        runtime.unifiedCalendar.stopBackgroundWorkers();
      }
      await close(server);
    }
  });
});

test('2) concurrent refresh of one token: at most one winner; replay revokes family; no usable tokens left', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    // Ensure unique access hash constraint exists (hardening migration expectation).
    const uniq = await pool.query(
      `select 1 from pg_constraint where conname = 'auth_sessions_access_token_hash_key'`,
    );
    assert.equal(uniq.rowCount, 1, 'access_token_hash must be UNIQUE');

    const session = await issueSessionForVerifiedSubject(pool, {
      provider: 'test',
      providerSubject: 'subject-a',
      workspaceId: 'ws-a',
    });
    const token = session.refreshToken;

    const results = await Promise.allSettled([
      refreshSession(pool, { refreshToken: token }),
      refreshSession(pool, { refreshToken: token }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // At most one rotation succeeds; the other is replay/contention.
    assert.ok(fulfilled.length <= 1, 'at most one concurrent refresh may succeed');
    assert.ok(rejected.length >= 1, 'at least one concurrent refresh must fail');
    if (fulfilled.length === 1) {
      // Loser must have revoked the family — no usable winner refresh remains.
      await assert.rejects(
        () => refreshSession(pool, { refreshToken: fulfilled[0].value.refreshToken }),
        /revoked|replay|invalid|contention/i,
      );
      // Winner access token must also be unusable after committed family/session revoke.
      await assert.rejects(
        () => authenticateAccessToken(pool, fulfilled[0].value.accessToken),
        /revoked|invalid|expired/i,
      );
    }
    await assert.rejects(
      () => refreshSession(pool, { refreshToken: token }),
      /revoked|replay|invalid|contention/i,
    );
  });
});

test('3) real text/event-stream SSE validates session ownership; foreign session cannot create waiters', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    const trustedVerifier = {
      async verify() {
        return { provider: 'test', providerSubject: 'subject-a' };
      },
    };
    const runtime = createPhase1Runtime({ pool, identityVerifier: trustedVerifier });
    const server = createRailwayGatewayServer({
      env: { WORKSPACE_AUTH_MODE: 'production' },
      phase1Runtime: runtime,
      gatewayStore: null,
      fetchImpl: async () => ({ ok: false }),
    });
    const baseUrl = await listen(server);
    try {
      const login = await httpJson(baseUrl, 'POST', '/api/phase1/auth/session', {
        body: { workspaceId: 'ws-a' },
      });
      // With verifier, session may succeed after fix; for RED without verifier this may fail.
      // Use internal issue for stream auth if login blocked.
      let token = login.json && login.json.accessToken;
      if (!token) {
        const issued = await issueSessionForVerifiedSubject(pool, {
          provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a',
        });
        token = issued.accessToken;
      }

      // Foreign session id must 404 and must not register waiters.
      const foreign = await fetch(`${baseUrl}/api/phase1/agent-work/session-b/stream`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
      });
      assert.equal(foreign.status, 404);
      const channelsBefore = runtime.sseHub.activeChannels();
      assert.equal(
        channelsBefore.some((k) => k.includes('session-b')),
        false,
        'foreign session must not create SSE waiters',
      );

      // Public publish route must be unavailable (users must not forge agent checkpoints).
      const httpPublish = await httpJson(baseUrl, 'POST', '/api/phase1/agent-work/session-a/publish', {
        token,
        body: { kind: 'checkpoint', text: 'forged' },
      });
      assert.ok(
        httpPublish.status === 404 || httpPublish.status === 405,
        `HTTP publish must be unavailable, got ${httpPublish.status}`,
      );

      // Own session stream must be text/event-stream with early connected frame.
      const controller = new AbortController();
      const streamPromise = fetch(`${baseUrl}/api/phase1/agent-work/session-a/stream?waitMs=10000`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
        signal: controller.signal,
      });

      // Wait until waiter is registered for this workspace channel.
      for (let i = 0; i < 50; i += 1) {
        const channels = runtime.sseHub.activeChannels();
        if (channels.some((k) => String(k).includes('session-a') && String(k).includes('ws-a'))) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      // Trusted producer path: injected internal hub (future RunnerControl), not HTTP publish.
      const auth = await authenticateAccessToken(pool, token);
      const delivered = runtime.sseHub.publish(auth.scope, 'agent-session:session-a', {
        kind: 'checkpoint',
        text: 'hello-sse',
      });
      assert.equal(delivered >= 1, true, 'internal hub must deliver to workspace-keyed waiter');

      const streamRes = await streamPromise;
      assert.equal(streamRes.status, 200, await streamRes.clone().text().catch(() => ''));
      assert.match(String(streamRes.headers.get('content-type') || ''), /text\/event-stream/i);
      const reader = streamRes.body.getReader();
      let chunk = '';
      for (let i = 0; i < 8; i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        chunk += new TextDecoder().decode(value || new Uint8Array());
        if (/data:/.test(chunk) && /hello-sse/.test(chunk)) break;
      }
      // Initial comment/connected frame before first event.
      assert.match(chunk, /^:.*connected/im);
      assert.match(chunk, /data:\s*/m);
      assert.match(chunk, /hello-sse/);
      controller.abort();
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
    }
  });
});

test('4) schedule-assistant embedding cache keys include workspaceId (real Calendar AI cache)', async () => {
  if (typeof clearRecordEmbeddingCacheForTests === 'function') {
    clearRecordEmbeddingCacheForTests();
  }
  const item = { id: 'item-1', updatedAt: '2026-07-24T00:00:00.000Z', title: 'Same' };
  const source = 'same source text for both workspaces';
  const keyA = recordEmbeddingCacheKey(item, source, { model: 'probe', workspaceId: 'ws-a' });
  const keyB = recordEmbeddingCacheKey(item, source, { model: 'probe', workspaceId: 'ws-b' });
  assert.notEqual(keyA, keyB, 'identical item/model/source must not collide across workspaces');
  assert.match(keyA, /ws-a/);
  assert.match(keyB, /ws-b/);

  // Missing workspaceId must fail closed (no silent global cache).
  assert.throws(
    () => recordEmbeddingCacheKey(item, source, { model: 'probe' }),
    /workspace/i,
  );

  const embA = await embedScheduleRecord(item, source, {
    model: 'probe',
    workspaceId: 'ws-a',
    embedText: async () => ({ embedding: [1, 0], model: 'probe', fallback: false }),
  });
  const embB = await embedScheduleRecord(item, source, {
    model: 'probe',
    workspaceId: 'ws-b',
    embedText: async () => ({ embedding: [0, 1], model: 'probe', fallback: false }),
  });
  assert.notDeepEqual(embA.embedding, embB.embedding);
});

test('5) wiki search uses workspace-scoped pgvector path', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);
    const sessA = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a',
    });
    const product = new WorkspaceScopedProductService({ pool, useAppRole: true });
    // Query vector close to vecA (axis 0)
    const queryVector = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));
    const results = await product.searchWikiVector(sessA.scope, queryVector, { limit: 5 });
    assert.equal(results.some((r) => r.id === 'chunk-a'), true);
    assert.equal(results.some((r) => r.id === 'chunk-b'), false);
    assert.equal(results.every((r) => r.workspaceId === 'ws-a'), true);
    assert.equal(typeof results[0].vectorDistance, 'number');
  });
});

test('6) RLS SELECT/INSERT/UPDATE/DELETE in clean separate transactions; victim rows unchanged', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    const workspaceTables = [
      'tasks', 'calendar_events', 'agents', 'runs', 'run_logs', 'chat_messages',
      'wiki_artifacts', 'scheduler_jobs', 'workboard_pages', 'documents', 'wiki_chunks',
      'agent_missions', 'agent_sessions', 'agent_session_events', 'agent_reports', 'state_meta',
    ];

    // SELECT foreign tasks under app role
    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        const seen = await client.query(`select id from tasks where id='task-b'`);
        assert.equal(seen.rowCount, 0);
        await client.query('rollback');
      } finally {
        client.release();
      }
    }

    // INSERT foreign workspace — separate tx
    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        await assert.rejects(
          () => client.query(
            `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id)
             values ('evil-ins', 'x', 'open', '', '', '', '', '{}'::jsonb, 'ws-b')`,
          ),
          /policy|row-level|check/i,
        );
        await client.query('rollback');
      } finally {
        client.release();
      }
    }

    // UPDATE foreign — 0 rows, victim unchanged
    {
      const before = await pool.query(`select title from tasks where id='task-b'`);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        const upd = await client.query(`update tasks set title='HACKED' where id='task-b'`);
        assert.equal(upd.rowCount, 0);
        await client.query('commit');
      } finally {
        client.release();
      }
      const after = await pool.query(`select title from tasks where id='task-b'`);
      assert.equal(after.rows[0].title, before.rows[0].title);
      assert.notEqual(after.rows[0].title, 'HACKED');
    }

    // DELETE foreign — 0 rows, victim remains
    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        const del = await client.query(`delete from tasks where id='task-b'`);
        assert.equal(del.rowCount, 0);
        await client.query('commit');
      } finally {
        client.release();
      }
      const still = await pool.query(`select 1 from tasks where id='task-b'`);
      assert.equal(still.rowCount, 1);
    }

    // Policy exists for every workspace-owned table
    for (const table of workspaceTables) {
      const pol = await pool.query(
        `select 1 from pg_policies where schemaname='public' and tablename=$1 and policyname=$2`,
        [table, `${table}_workspace_isolation`],
      );
      assert.equal(pol.rowCount, 1, `missing RLS policy on ${table}`);
    }
  });
});

test('7) same-workspace composite FKs fail closed; cross-workspace child inserts rejected', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    // Must not silently skip invalid FKs — constraints must exist.
    for (const name of [
      'wiki_artifacts_workspace_run_fkey',
      'agent_reports_workspace_mission_fkey',
      'wiki_chunks_workspace_document_fkey',
      'agent_sessions_workspace_mission_fkey',
      'agent_session_events_workspace_session_fkey',
      'run_logs_workspace_run_fkey',
    ]) {
      const c = await pool.query(`select 1 from pg_constraint where conname=$1`, [name]);
      assert.equal(c.rowCount, 1, `missing composite FK ${name}`);
    }

    // wiki_artifacts FK must use column-list SET NULL (run_id) only — not bare SET NULL.
    const fkDef = await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'wiki_artifacts_workspace_run_fkey'`,
    );
    assert.match(String(fkDef.rows[0].def), /set null \(run_id\)/i);

    await assert.rejects(
      () => pool.query(
        `insert into wiki_artifacts (id, run_id, path, status, payload, workspace_id)
         values ('wa-cross', 'run-b', 'p', 'ok', '{}'::jsonb, 'ws-a')`,
      ),
      /foreign key|violates/i,
    );
    await assert.rejects(
      () => pool.query(
        `insert into agent_reports (id, mission_id, session_id, status, payload, workspace_id)
         values ('rep-cross', 'mission-b', 'session-a', 'ready', '{}'::jsonb, 'ws-a')`,
      ),
      /foreign key|violates/i,
    );

    // Delete own run: artifact keeps workspace_id, nulls only run_id.
    await pool.query(
      `insert into wiki_artifacts (id, run_id, path, status, payload, workspace_id)
       values ('wa-del', 'run-a', 'p', 'ok', '{}'::jsonb, 'ws-a')`,
    );
    await pool.query(`delete from runs where id = 'run-a'`);
    const afterDel = await pool.query(
      `select workspace_id, run_id from wiki_artifacts where id = 'wa-del'`,
    );
    assert.equal(afterDel.rowCount, 1);
    assert.equal(afterDel.rows[0].workspace_id, 'ws-a');
    assert.equal(afterDel.rows[0].run_id, null);
  });
});

test('8) RLS FORCE on every workspace-owned table; SELECT cannot see foreign workspace rows', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    // Every one of the 16 migrated legacy tables still has all bootstrap rows on legacy workspace.
    for (const table of EXPECTED_PERSISTED_TABLES) {
      const legacyRows = await pool.query(
        `select count(*)::int as n from ${table} where workspace_id = 'legacy-personal-workspace'`,
      );
      assert.ok(
        Number(legacyRows.rows[0].n) >= 1,
        `${table} must have rows backfilled to legacy-personal-workspace`,
      );
      // No null workspace_id remains.
      const nulls = await pool.query(
        `select count(*)::int as n from ${table} where workspace_id is null`,
      );
      assert.equal(Number(nulls.rows[0].n), 0, `${table} has null workspace_id`);
    }

    const rlsTables = [
      'tasks', 'calendar_events', 'agents', 'runs', 'run_logs', 'chat_messages',
      'wiki_artifacts', 'scheduler_jobs', 'workboard_pages', 'documents', 'wiki_chunks',
      'agent_missions', 'agent_sessions', 'agent_session_events', 'agent_reports', 'state_meta',
      'auth_sessions', 'auth_refresh_tokens', 'audit_events', 'idempotency_keys',
    ];

    for (const table of rlsTables) {
      const flags = await pool.query(
        `select c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      assert.equal(flags.rowCount, 1, `missing table ${table}`);
      assert.equal(flags.rows[0].relrowsecurity, true, `${table} RLS not enabled`);
      assert.equal(flags.rows[0].relforcerowsecurity, true, `${table} FORCE RLS not set`);
    }

    // Seed foreign rows in auth/audit tables for isolation SELECT.
    await pool.query(
      `insert into auth_sessions (id, user_id, workspace_id, access_token_hash, refresh_family_id, expires_at)
       values
       ('sess-a', 'user-a', 'ws-a', 'hash-a', 'fam-a', now() + interval '1 hour'),
       ('sess-b', 'user-b', 'ws-b', 'hash-b', 'fam-b', now() + interval '1 hour')`,
    );
    await pool.query(
      `insert into auth_refresh_tokens (id, session_id, user_id, workspace_id, token_hash, family_id, expires_at)
       values
       ('rt-a', 'sess-a', 'user-a', 'ws-a', 'rthash-a', 'fam-a', now() + interval '1 day'),
       ('rt-b', 'sess-b', 'user-b', 'ws-b', 'rthash-b', 'fam-b', now() + interval '1 day')`,
    );
    await pool.query(
      `insert into audit_events (id, workspace_id, actor_user_id, action)
       values ('aud-a', 'ws-a', 'user-a', 'x'), ('aud-b', 'ws-b', 'user-b', 'x')`,
    );
    await pool.query(
      `insert into idempotency_keys (workspace_id, scope, idempotency_key)
       values ('ws-a', 's', 'k-a'), ('ws-b', 's', 'k-b')`,
    );

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role agent_calendar_app');
      await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
      await client.query(`select set_config('app.user_id', 'user-a', true)`);

      for (const table of rlsTables) {
        const leaked = await client.query(
          `select 1 from ${table} where workspace_id is distinct from 'ws-a' limit 1`,
        );
        assert.equal(
          leaked.rowCount,
          0,
          `app role under ws-a must not SELECT foreign workspace rows from ${table}`,
        );
      }
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

test('10) HTTP wiki vector route returns 400 for malformed vector; publish route gone', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: {
        async verify() {
          return { provider: 'test', providerSubject: 'subject-a' };
        },
      },
    });
    const server = createRailwayGatewayServer({
      env: { WORKSPACE_AUTH_MODE: 'production' },
      phase1Runtime: runtime,
      gatewayStore: null,
      fetchImpl: async () => ({ ok: false }),
    });
    const baseUrl = await listen(server);
    try {
      const login = await httpJson(baseUrl, 'POST', '/api/phase1/auth/session', {
        body: { workspaceId: 'ws-a' },
      });
      assert.equal(login.status, 200, JSON.stringify(login.json));
      const token = login.json.accessToken;

      const bad = await httpJson(
        baseUrl,
        'GET',
        '/api/phase1/wiki/search?mode=vector&vector=1,2,3',
        { token },
      );
      assert.equal(bad.status, 400, JSON.stringify(bad.json));
      assert.equal(bad.json.error, 'VECTOR_LENGTH_INVALID');
      assert.doesNotMatch(JSON.stringify(bad.json), /relation |syntax error|pgvector/i);

      const gone = await httpJson(baseUrl, 'POST', '/api/phase1/agent-work/session-a/publish', {
        token,
        body: { text: 'nope' },
      });
      assert.ok(gone.status === 404 || gone.status === 405);
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
    }
  });
});

test('9) refresh token cannot mismatch session/user/workspace/family; vector length must be 256', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await bootstrapLegacyAndMigrate(pool);
    await seedTwoTenants(pool);

    await pool.query(
      `insert into auth_sessions (id, user_id, workspace_id, access_token_hash, refresh_family_id, expires_at)
       values
       ('sess-a2', 'user-a', 'ws-a', 'hash-a2', 'fam-a2', now() + interval '1 hour'),
       ('sess-b2', 'user-b', 'ws-b', 'hash-b2', 'fam-b2', now() + interval '1 hour')`,
    );

    // Mismatched session/user/workspace/family combinations must fail composite FK.
    await assert.rejects(
      () => pool.query(
        `insert into auth_refresh_tokens (id, session_id, user_id, workspace_id, token_hash, family_id, expires_at)
         values ('rt-bad-1', 'sess-a2', 'user-b', 'ws-a', 'bad1', 'fam-a2', now() + interval '1 day')`,
      ),
      /foreign key|violates/i,
    );
    await assert.rejects(
      () => pool.query(
        `insert into auth_refresh_tokens (id, session_id, user_id, workspace_id, token_hash, family_id, expires_at)
         values ('rt-bad-2', 'sess-a2', 'user-a', 'ws-b', 'bad2', 'fam-a2', now() + interval '1 day')`,
      ),
      /foreign key|violates/i,
    );
    await assert.rejects(
      () => pool.query(
        `insert into auth_refresh_tokens (id, session_id, user_id, workspace_id, token_hash, family_id, expires_at)
         values ('rt-bad-3', 'sess-a2', 'user-a', 'ws-a', 'bad3', 'fam-b2', now() + interval '1 day')`,
      ),
      /foreign key|violates/i,
    );

    // Matching composite is allowed.
    await pool.query(
      `insert into auth_refresh_tokens (id, session_id, user_id, workspace_id, token_hash, family_id, expires_at)
       values ('rt-good', 'sess-a2', 'user-a', 'ws-a', 'good-hash', 'fam-a2', now() + interval '1 day')`,
    );

    const sessA = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a',
    });
    const product = new WorkspaceScopedProductService({ pool, useAppRole: true });

    await assert.rejects(
      () => product.searchWikiVector(sessA.scope, [1, 2, 3], { limit: 3 }),
      /vector.*256|VECTOR_LENGTH|invalid.*vector/i,
    );
    await assert.rejects(
      () => product.searchWikiVector(sessA.scope, Array.from({ length: 128 }, () => 0), { limit: 3 }),
      /vector.*256|VECTOR_LENGTH|invalid.*vector/i,
    );
    // Exact 256 is accepted (typed, not raw DB error).
    const ok = await product.searchWikiVector(
      sessA.scope,
      Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)),
      { limit: 3 },
    );
    assert.ok(Array.isArray(ok));
  });
});
