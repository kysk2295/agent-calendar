'use strict';

/**
 * Phase 1 full Gateway Workspace cutover — hostile production-mode suite.
 * Requires real ephemeral PostgreSQL (migrations through 0016).
 */

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
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const {
  issueSessionForVerifiedSubject,
  authenticateAccessToken,
} = require('../app/lib/workspace-auth-session');
const {
  assertDesktopInventoryCovered,
  countRoutesByClass,
  listProductionRoutes,
  matchProductionRoute,
  allowsLegacyProductFallthrough,
  DESKTOP_API_PATHS,
} = require('../app/lib/production-route-registry');
const { buildPublicGatewayStatus } = require('../app/lib/production-gateway-dispatch');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase1cutover';
const DATABASE = 'phase1_full_cutover';
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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-cutover-'));
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
  return { status: response.status, json, headers: response.headers };
}

async function seedTwoWorkspaces(pool) {
  await runMigrations({ pool });

  await pool.query(`insert into users (id, display_name, status) values
    ('user-a', 'Alex', 'active'),
    ('user-b', 'Blair', 'active'),
    ('user-member-a', 'MemberA', 'active'),
    ('user-empty', 'Empty Workspace Owner', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-a', 'Workspace A', 'active'),
    ('ws-b', 'Workspace B', 'active'),
    ('ws-empty', 'Empty Workspace', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
    ('mem-a', 'user-a', 'ws-a', 'owner', 'active'),
    ('mem-b', 'user-b', 'ws-b', 'owner', 'active'),
    ('mem-member-a', 'user-member-a', 'ws-a', 'member', 'active'),
    ('mem-empty', 'user-empty', 'ws-empty', 'owner', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-a', 'user-a', 'test', 'subject-a'),
    ('id-b', 'user-b', 'test', 'subject-b'),
    ('id-member-a', 'user-member-a', 'test', 'subject-member-a'),
    ('id-empty', 'user-empty', 'test', 'subject-empty')
    on conflict (id) do nothing`);

  await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id) values
    ('task-a', 'Colliding title', 'open', 'SameLabel', '', '', '', '{}'::jsonb, 'ws-a'),
    ('task-b', 'Colliding title', 'open', 'SameLabel', '', '', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id) values
    ('event-a', 'task-a', 'Colliding title', '2026-07-25 10:00', '{"date":"2026-07-25","time":"10:00","endTime":"11:00"}'::jsonb, 'ws-a'),
    ('event-b', 'task-b', 'Colliding title', '2026-07-25 10:00', '{"date":"2026-07-25","time":"10:00","endTime":"11:00"}'::jsonb, 'ws-b')`);
  await pool.query(`insert into documents (id, title, path, source, payload, workspace_id) values
    ('doc-a', 'Secret Wiki', 'wiki/secret.md', 'wiki', '{}'::jsonb, 'ws-a'),
    ('doc-b', 'Secret Wiki', 'wiki/secret.md', 'wiki', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt, workspace_id) values
    ('chunk-a', 'wiki', 'doc-a', 'doc-a', 'wiki/secret.md', 'Secret Wiki', 0, 'alpha workspace unique token A-ONLY', 'A-ONLY', 'ws-a'),
    ('chunk-b', 'wiki', 'doc-b', 'doc-b', 'wiki/secret.md', 'Secret Wiki', 0, 'beta workspace unique token B-ONLY', 'B-ONLY', 'ws-b')`);
  await pool.query(`insert into agents (id, payload, workspace_id) values
    ('agent-a', '{"name":"Agent A"}'::jsonb, 'ws-a'),
    ('agent-b', '{"name":"Agent B"}'::jsonb, 'ws-b')`);
  await pool.query(`insert into scheduler_jobs (id, name, agent, model, enabled, interval_minutes, payload, workspace_id) values
    ('job-a', 'Job A', '', '', true, 60, '{}'::jsonb, 'ws-a'),
    ('job-b', 'Job B', '', '', true, 60, '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_missions (id, status, agent_id, report_due_at, payload, workspace_id) values
    ('mission-a', 'active', 'agent-a', '', '{}'::jsonb, 'ws-a'),
    ('mission-b', 'active', 'agent-b', '', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_sessions (id, mission_id, task_id, status, payload, workspace_id) values
    ('session-a', 'mission-a', 'task-a', 'active', '{}'::jsonb, 'ws-a'),
    ('session-b', 'mission-b', 'task-b', 'active', '{}'::jsonb, 'ws-b')`);
  await pool.query(`insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id) values
    ('evt-a', 'session-a', 1, 'checkpoint', '{"text":"checkpoint-A"}'::jsonb, 'ws-a'),
    ('evt-b', 'session-b', 1, 'checkpoint', '{"text":"checkpoint-B"}'::jsonb, 'ws-b')`);
}

test('route registry covers Desktop inventory and never allows legacy product fallthrough', () => {
  assert.equal(allowsLegacyProductFallthrough(), false);
  assertDesktopInventoryCovered();
  const counts = countRoutesByClass();
  assert.ok(counts.total >= DESKTOP_API_PATHS.length, `registry total ${counts.total}`);
  assert.ok(counts.byClass.scoped_product >= 20);
  assert.ok(counts.byClass.production_disabled >= 5);
  assert.ok(matchProductionRoute('GET', '/api/tasks'));
  assert.equal(matchProductionRoute('GET', '/api/totally-new-unregistered-path'), null);
  const status = buildPublicGatewayStatus();
  assert.equal(status.mode, 'production');
  assert.equal(status.tasks, undefined);
  assert.equal(status.agents, undefined);
  assert.equal(status.pendingJobs, undefined);
  // Machine inventory dump for evidence
  const summary = {
    total: counts.total,
    byClass: counts.byClass,
    desktopPaths: DESKTOP_API_PATHS.length,
    disabled: listProductionRoutes().filter((r) => r.class === 'production_disabled').map((r) => `${r.method} ${r.pathPattern}`),
  };
  assert.ok(summary.disabled.length > 0);
});

test('production cutover: hostile multi-Workspace matrix on real Postgres', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedTwoWorkspaces(pool);

    const issuedA = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a',
    });
    const issuedB = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-b', workspaceId: 'ws-b',
    });
    const issuedMember = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-member-a', workspaceId: 'ws-a',
    });
    const issuedEmpty = await issueSessionForVerifiedSubject(pool, {
      provider: 'test', providerSubject: 'subject-empty', workspaceId: 'ws-empty',
    });

    // Track whether global store is touched (must stay null / unused for product).
    let globalStoreMutations = 0;
    const fakeStore = {
      getState() {
        globalStoreMutations += 1;
        return { tasks: [{ id: 'global-leak' }], agents: [], runs: [] };
      },
      createTask() { globalStoreMutations += 1; return { id: 'global' }; },
      pool,
    };

    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: {
        async verify(_req, body) {
          const subject = body && body._testSubject;
          if (!subject) return null;
          return { provider: 'test', providerSubject: subject };
        },
      },
    });
    runtime.scheduleIngestCompletion = async () => JSON.stringify({
      drafts: [{
        kind: 'event',
        title: '검토할 새 일정',
        date: '2026-07-25',
        start: '10:15',
        end: '10:45',
        location: null,
        notes: '원문: 7월 25일 10시 15분 일정',
        confidence: 'high',
      }],
      warnings: [],
    });

    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        HERMES_REMOTE_AUTH_TOKEN: 'legacy-global-token',
      },
      phase1Runtime: runtime,
      gatewayStore: fakeStore,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);

    try {
      // 1) Anonymous representative product reads always fail closed instead of
      // hydrating the legacy gatewayFallback state or synthetic Hermes roster.
      for (const productPath of ['/api/tasks', '/api/agents', '/api/state']) {
        const anon = await httpJson(baseUrl, 'GET', productPath, {
          headers: { accept: 'application/vnd.agent-calendar.client-v1+json' },
        });
        assert.equal(anon.status, 401, productPath);
        assert.equal(anon.json.error, 'workspace_auth_required', productPath);
        assert.equal(anon.json.gatewayFallback, undefined, productPath);
      }

      // 2) Legacy global Bearer must not work in production
      const legacy = await httpJson(baseUrl, 'GET', '/api/tasks', { token: 'legacy-global-token' });
      assert.equal(legacy.status, 401);
      assert.equal(legacy.json.error, 'workspace_auth_required');

      // 3) gateway-status anonymous: infra only, no tenant data
      const gs = await httpJson(baseUrl, 'GET', '/api/gateway-status');
      assert.equal(gs.status, 200);
      assert.equal(gs.json.mode, 'production');
      assert.equal(gs.json.tasks, undefined);
      assert.equal(gs.json.agents, undefined);
      const gsText = JSON.stringify(gs.json);
      assert.equal(gsText.includes('task-a'), false);
      assert.equal(gsText.includes('ws-a'), false);

      // 4) Unregistered path fail-closed
      const unreg = await httpJson(baseUrl, 'GET', '/api/not-in-registry-xyz', {
        token: issuedA.accessToken,
      });
      assert.equal(unreg.status, 404);
      assert.equal(unreg.json.error, 'production_route_unregistered');

      // 5) Scoped list isolation
      const listA = await httpJson(baseUrl, 'GET', '/api/tasks', { token: issuedA.accessToken });
      assert.equal(listA.status, 200, JSON.stringify(listA.json));
      assert.equal(listA.json.tasks.some((t) => t.id === 'task-a'), true);
      assert.equal(listA.json.tasks.some((t) => t.id === 'task-b'), false);
      assert.equal(listA.json.tasks.some((t) => t.id === 'global-leak'), false);

      const listB = await httpJson(baseUrl, 'GET', '/api/tasks', { token: issuedB.accessToken });
      assert.equal(listB.json.tasks.some((t) => t.id === 'task-b'), true);
      assert.equal(listB.json.tasks.some((t) => t.id === 'task-a'), false);

      // The client-v1 Desktop hydration path succeeds for a newly-created Workspace
      // that has no agents yet. Production must not invent a global Hermes roster.
      const emptyAgents = await httpJson(baseUrl, 'GET', '/api/agents', {
        token: issuedEmpty.accessToken,
        headers: { accept: 'application/vnd.agent-calendar.client-v1+json' },
      });
      assert.equal(emptyAgents.status, 200, JSON.stringify(emptyAgents.json));
      assert.equal(emptyAgents.headers.get('x-agent-calendar-contract'), 'client-v1');
      assert.deepEqual(emptyAgents.json.agents, []);
      assert.equal(emptyAgents.json.gatewayFallback, undefined);

      const emptyState = await httpJson(baseUrl, 'GET', '/api/state', {
        token: issuedEmpty.accessToken,
        headers: { accept: 'application/vnd.agent-calendar.client-v1+json' },
      });
      assert.equal(emptyState.status, 200, JSON.stringify(emptyState.json));
      assert.equal(emptyState.headers.get('x-agent-calendar-contract'), 'client-v1');
      assert.equal(emptyState.json.workspaceId, 'ws-empty');
      assert.deepEqual(emptyState.json.agents, []);
      assert.equal(emptyState.json.gatewayFallback, undefined);

      // 6) Direct ID guess foreign → opaque 404
      const cross = await httpJson(baseUrl, 'GET', '/api/tasks/task-b', { token: issuedA.accessToken });
      // Desktop path is list/patch by id — patch foreign
      const crossPatch = await httpJson(baseUrl, 'PATCH', '/api/tasks/task-b', {
        token: issuedA.accessToken,
        body: { title: 'hacked', workspaceId: 'ws-b' },
      });
      assert.equal(crossPatch.status, 404);

      // Release gate: a production-auth HTTP write belongs only to the token's Workspace.
      // The hostile body scope also proves that caller-provided Workspace IDs are not authority.
      const created = await httpJson(baseUrl, 'POST', '/api/tasks', {
        token: issuedA.accessToken,
        body: {
          title: 'Workspace A production isolation marker',
          workspaceId: 'ws-b',
          id: 'task-production-isolation-a',
        },
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      assert.equal(created.json.task.workspaceId, 'ws-a');
      const persistedMarker = await pool.query(
        `select workspace_id from tasks where id = 'task-production-isolation-a'`,
      );
      assert.equal(persistedMarker.rows[0].workspace_id, 'ws-a');

      const listAAfterWrite = await httpJson(baseUrl, 'GET', '/api/tasks', {
        token: issuedA.accessToken,
      });
      assert.equal(listAAfterWrite.status, 200, JSON.stringify(listAAfterWrite.json));
      assert.equal(
        listAAfterWrite.json.tasks.some((task) => task.id === 'task-production-isolation-a'),
        true,
      );

      const listBAfterAWrite = await httpJson(baseUrl, 'GET', '/api/tasks', {
        token: issuedB.accessToken,
      });
      assert.equal(listBAfterAWrite.status, 200, JSON.stringify(listBAfterAWrite.json));
      assert.equal(
        listBAfterAWrite.json.tasks.some((task) => task.id === 'task-production-isolation-a'),
        false,
      );
      assert.equal(
        JSON.stringify(listBAfterAWrite.json).includes('Workspace A production isolation marker'),
        false,
      );

      // Header spoof workspaceId must not rebind
      const headerSpoof = await httpJson(baseUrl, 'GET', '/api/calendar/events', {
        token: issuedA.accessToken,
        headers: { 'x-workspace-id': 'ws-b', 'workspace-id': 'ws-b' },
      });
      assert.equal(headerSpoof.status, 200);
      assert.equal(headerSpoof.json.events.some((e) => e.id === 'event-b'), false);
      assert.equal(headerSpoof.json.events.some((e) => e.id === 'event-a'), true);

      // Schedule ingest is review-only, uses the authenticated Workspace, and never persists.
      const beforeIngest = await pool.query(
        `select
           (select count(*)::int from calendar_events) as events,
           (select count(*)::int from tasks) as tasks`,
      );
      const anonymousIngestForm = new FormData();
      anonymousIngestForm.append('text', '7월 25일 10시 15분 일정 등록해줘');
      const anonymousIngestResponse = await fetch(`${baseUrl}/api/assistant/ingest`, {
        method: 'POST',
        body: anonymousIngestForm,
      });
      assert.equal(anonymousIngestResponse.status, 401);
      assert.equal((await anonymousIngestResponse.json()).error, 'workspace_auth_required');
      const ingestForm = new FormData();
      ingestForm.append('text', '7월 25일 10시 15분 일정 등록해줘');
      ingestForm.append('workspaceId', 'ws-b');
      const ingestResponse = await fetch(`${baseUrl}/api/assistant/ingest`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issuedA.accessToken}`,
          accept: 'application/vnd.agent-calendar.client-v1+json',
        },
        body: ingestForm,
      });
      const ingest = await ingestResponse.json();
      assert.equal(ingestResponse.status, 200, JSON.stringify(ingest));
      assert.equal(ingest.workspaceId, 'ws-a');
      assert.equal(ingest.drafts[0].title, '검토할 새 일정');
      assert.equal(
        ingest.conflicts.some((entry) => entry.existing.id === 'event-a'),
        true,
        JSON.stringify(ingest),
      );
      assert.equal(JSON.stringify(ingest).includes('event-b'), false);
      assert.equal(JSON.stringify(ingest).includes('ws-b'), false);
      const afterIngest = await pool.query(
        `select
           (select count(*)::int from calendar_events) as events,
           (select count(*)::int from tasks) as tasks`,
      );
      assert.deepEqual(afterIngest.rows[0], beforeIngest.rows[0]);

      // 7) Wiki search isolation
      const wikiA = await httpJson(baseUrl, 'POST', '/api/wiki/search', {
        token: issuedA.accessToken,
        body: { query: 'B-ONLY' },
      });
      assert.equal(wikiA.status, 200);
      assert.equal((wikiA.json.results || []).some((r) => String(r.excerpt || r.content || '').includes('B-ONLY')), false);

      // 8) Calendar mutation + state aggregate
      const cal = await httpJson(baseUrl, 'POST', '/api/calendar/events', {
        token: issuedA.accessToken,
        body: { title: 'Cutover event', startsAt: '2026-07-26 09:00', id: 'event-new-a' },
      });
      assert.equal(cal.status, 200, JSON.stringify(cal.json));
      const stateA = await httpJson(baseUrl, 'GET', '/api/state', { token: issuedA.accessToken });
      assert.equal(stateA.status, 200);
      assert.equal(stateA.json.workspaceId, 'ws-a');
      assert.equal((stateA.json.events || stateA.json.calendarEvents || []).some((e) => e.id === 'event-new-a'), true);
      assert.equal((stateA.json.tasks || []).some((t) => t.id === 'task-b'), false);

      // 9) Agent work snapshot + conversation isolation
      const opsA = await httpJson(baseUrl, 'GET', '/api/agent-operations', { token: issuedA.accessToken });
      assert.equal(opsA.status, 200);
      assert.equal((opsA.json.missions || []).some((m) => m.id === 'mission-b'), false);
      assert.equal((opsA.json.missions || []).some((m) => m.id === 'mission-a'), true);

      const convForeign = await httpJson(
        baseUrl, 'GET', '/api/agent-operations/work/mission-b/conversation',
        { token: issuedA.accessToken },
      );
      assert.equal(convForeign.status, 404);

      const work = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: issuedA.accessToken,
        body: { goal: 'Do something', clientRequestId: 'cr-1' },
        headers: { 'idempotency-key': 'work-create-1' },
      });
      assert.equal(work.status, 200, JSON.stringify(work.json));
      // Phase 3: durable accept queues work as waiting_runner (not a fake terminal blocked_runner_required).
      assert.ok(
        ['waiting_runner', 'accepted', 'blocked_runner_required'].includes(work.json.status),
        JSON.stringify(work.json),
      );
      assert.equal(work.json.workspaceId, 'ws-a');

      // 10) Scheduler isolation + owner mutation
      const jobsA = await httpJson(baseUrl, 'GET', '/api/scheduler/jobs', { token: issuedA.accessToken });
      assert.equal(jobsA.json.jobs.some((j) => j.id === 'job-a'), true);
      assert.equal(jobsA.json.jobs.some((j) => j.id === 'job-b'), false);

      // Member cannot create scheduler jobs (owner-only)
      const memberJob = await httpJson(baseUrl, 'POST', '/api/scheduler/jobs', {
        token: issuedMember.accessToken,
        body: { name: 'Nope' },
      });
      assert.equal(memberJob.status, 403);

      // Member can create tasks
      const memberTask = await httpJson(baseUrl, 'POST', '/api/tasks', {
        token: issuedMember.accessToken,
        body: { title: 'Member task', id: 'task-member-a' },
      });
      assert.equal(memberTask.status, 200, JSON.stringify(memberTask.json));

      // Owner can create agent; member cannot
      const memberAgent = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: issuedMember.accessToken,
        body: { name: 'Bad' },
      });
      assert.equal(memberAgent.status, 403);

      // Owner can create a native agent and connect a Runner-owned external agent.
      // Credentials are never accepted into the Workspace agent record.
      const nativeAgent = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: issuedA.accessToken,
        body: {
          id: 'agent-native-a',
          displayName: 'Workspace A Researcher',
          role: 'researcher',
          responsibility: 'Research Workspace A only',
          instructions: 'Cite sources',
          specialties: ['research', 'citations'],
          sourceKind: 'native',
          apiKey: 'must-not-store',
        },
      });
      assert.equal(nativeAgent.status, 200, JSON.stringify(nativeAgent.json));
      assert.equal(nativeAgent.json.agent.sourceKind, 'native');
      assert.equal(nativeAgent.json.agent.apiKey, undefined);

      const connectedAgent = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: issuedA.accessToken,
        body: {
          id: 'agent-connected-a',
          displayName: 'Hermes Researcher',
          role: 'researcher',
          sourceKind: 'connected',
          provider: 'hermes',
          externalAgentId: 'researcher',
          token: 'must-not-store',
        },
      });
      assert.equal(connectedAgent.status, 200, JSON.stringify(connectedAgent.json));
      assert.equal(connectedAgent.json.agent.provider, 'hermes');
      assert.equal(connectedAgent.json.agent.externalAgentId, 'researcher');
      assert.equal(connectedAgent.json.agent.token, undefined);

      const duplicateConnected = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: issuedA.accessToken,
        body: {
          id: 'agent-connected-a-duplicate',
          displayName: 'Duplicate Hermes Researcher',
          sourceKind: 'connected',
          provider: 'hermes',
          externalAgentId: 'researcher',
        },
      });
      assert.equal(duplicateConnected.status, 409, JSON.stringify(duplicateConnected.json));
      assert.equal(duplicateConnected.json.error, 'agent_source_conflict');

      const agentsA = await httpJson(baseUrl, 'GET', '/api/agents', { token: issuedA.accessToken });
      const agentsB = await httpJson(baseUrl, 'GET', '/api/agents', { token: issuedB.accessToken });
      assert.equal(agentsA.json.agents.some((agent) => agent.id === 'agent-connected-a'), true);
      assert.equal(agentsB.json.agents.some((agent) => agent.id === 'agent-connected-a'), false);
      assert.equal(JSON.stringify(agentsA.json).includes('must-not-store'), false);

      const connectedAgentWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: issuedA.accessToken,
        body: {
          goal: 'Use the connected Hermes researcher',
          title: 'Connected agent work',
          agentId: 'agent-connected-a',
          executionEngine: 'auto',
          clientRequestId: 'connected-agent-work-a',
        },
        headers: { 'idempotency-key': 'connected-agent-work-a' },
      });
      assert.equal(connectedAgentWork.status, 200, JSON.stringify(connectedAgentWork.json));
      assert.equal(connectedAgentWork.json.work.agentId, 'agent-connected-a');
      const connectedWorkForeign = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(connectedAgentWork.json.work.id)}/conversation`,
        { token: issuedB.accessToken },
      );
      assert.equal(connectedWorkForeign.status, 404);

      // 11) Settings scrub tokens + workspace scoped
      const settings = await httpJson(baseUrl, 'POST', '/api/settings', {
        token: issuedA.accessToken,
        body: {
          uiPreferences: { theme: 'dark' },
          workspaceLabel: 'Workspace A',
          apiToken: 'should-not-store',
          refreshToken: 'nope',
        },
      });
      assert.equal(settings.status, 200);
      assert.equal(settings.json.uiPreferences.theme, 'dark');
      assert.equal(settings.json.apiToken, undefined);
      const onboardingSettings = await httpJson(baseUrl, 'POST', '/api/settings', {
        token: issuedA.accessToken,
        body: {
          onboarding: {
            version: 1,
            status: 'dismissed',
            dismissedAt: '2026-07-25T00:00:00.000Z',
          },
        },
      });
      assert.equal(onboardingSettings.status, 200);
      assert.equal(onboardingSettings.json.workspaceLabel, 'Workspace A');
      assert.equal(onboardingSettings.json.uiPreferences.theme, 'dark');
      assert.equal(onboardingSettings.json.onboarding.status, 'dismissed');
      const settingsB = await httpJson(baseUrl, 'GET', '/api/settings', { token: issuedB.accessToken });
      assert.notEqual(settingsB.json.uiPreferences?.theme, 'dark');
      assert.equal(settingsB.json.onboarding, undefined);

      // 12) Mail list is a scoped hydrate-safe empty mailbox (not a red production_disabled banner)
      const mail = await httpJson(baseUrl, 'GET', '/api/mail/messages', { token: issuedA.accessToken });
      assert.equal(mail.status, 200, JSON.stringify(mail.json));
      assert.deepEqual(mail.json.items || [], []);
      assert.equal(mail.json.workspaceId, 'ws-a');
      // Mail mutations remain production_disabled
      const mailWrite = await httpJson(baseUrl, 'POST', '/api/mail/sync', { token: issuedA.accessToken, body: {} });
      assert.equal(mailWrite.status, 403);
      assert.equal(mailWrite.json.error, 'production_disabled');

      // 13) Cross-workspace idempotency keys independent + conflict on payload reuse
      const idemp1 = await httpJson(baseUrl, 'POST', '/api/tasks', {
        token: issuedA.accessToken,
        body: { title: 'Idem A', id: 'task-idemp-a' },
        headers: { 'idempotency-key': 'shared-key-name' },
      });
      assert.equal(idemp1.status, 200);
      const idemp1Replay = await httpJson(baseUrl, 'POST', '/api/tasks', {
        token: issuedA.accessToken,
        body: { title: 'Idem A', id: 'task-idemp-a' },
        headers: { 'idempotency-key': 'shared-key-name' },
      });
      assert.equal(idemp1Replay.status, 200);
      assert.equal(idemp1Replay.json.task.id, 'task-idemp-a');

      const idempConflict = await httpJson(baseUrl, 'POST', '/api/tasks', {
        token: issuedA.accessToken,
        body: { title: 'Different payload', id: 'task-other' },
        headers: { 'idempotency-key': 'shared-key-name' },
      });
      assert.equal(idempConflict.status, 409);
      assert.equal(idempConflict.json.error, 'idempotency_key_conflict');

      // Same key name in B is independent
      const idempB = await httpJson(baseUrl, 'POST', '/api/tasks', {
        token: issuedB.accessToken,
        body: { title: 'Idem B', id: 'task-idemp-b' },
        headers: { 'idempotency-key': 'shared-key-name' },
      });
      assert.equal(idempB.status, 200, JSON.stringify(idempB.json));
      assert.equal(idempB.json.task.workspaceId, 'ws-b');

      // Concurrent duplicate same key
      const concurrentBody = { title: 'Concurrent', id: 'task-concurrent-a' };
      const [c1, c2] = await Promise.all([
        httpJson(baseUrl, 'POST', '/api/tasks', {
          token: issuedA.accessToken,
          body: concurrentBody,
          headers: { 'idempotency-key': 'concurrent-key-1' },
        }),
        httpJson(baseUrl, 'POST', '/api/tasks', {
          token: issuedA.accessToken,
          body: concurrentBody,
          headers: { 'idempotency-key': 'concurrent-key-1' },
        }),
      ]);
      assert.ok([c1.status, c2.status].every((s) => s === 200 || s === 409));
      const okResponses = [c1, c2].filter((r) => r.status === 200);
      assert.ok(okResponses.length >= 1);
      const countConcurrent = await pool.query(
        `select count(*)::int as n from tasks where id = 'task-concurrent-a'`,
      );
      assert.equal(countConcurrent.rows[0].n, 1);

      // 14) Chat messages scoped
      const chat = await httpJson(baseUrl, 'POST', '/api/assistant/ask', {
        token: issuedA.accessToken,
        body: { question: 'What is on my calendar?', view: 'calendar' },
      });
      assert.equal(chat.status, 200);
      assert.equal(chat.json.workspaceId, 'ws-a');
      const msgsB = await httpJson(baseUrl, 'GET', '/api/chat/messages', { token: issuedB.accessToken });
      assert.equal((msgsB.json.messages || []).some((m) => String(m.text || '').includes('What is on my calendar')), false);

      // 15) SSE workspace events (short timeout)
      const eventsRes = await fetch(`${baseUrl}/api/events?waitMs=200`, {
        headers: { authorization: `Bearer ${issuedA.accessToken}`, accept: 'text/event-stream' },
      });
      assert.equal(eventsRes.status, 200);
      assert.match(eventsRes.headers.get('content-type') || '', /text\/event-stream/);
      const eventsText = await eventsRes.text();
      assert.match(eventsText, /ws-a|workspace/);

      // Global store must not have been used for product paths
      assert.equal(globalStoreMutations, 0, 'production must not touch injected global gatewayStore');

      // Foreign task still intact in B
      const taskB = await pool.query(`select title from tasks where id = 'task-b'`);
      assert.equal(taskB.rows[0].title, 'Colliding title');
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) {
        runtime.unifiedCalendar.stopBackgroundWorkers();
      }
      await close(server);
    }
  });
});

test('legacy mode still allows unscoped fallthrough path composition', async () => {
  // Smoke: maybeHandlePhase1 returns false for product paths in legacy → gateway continues.
  const { maybeHandlePhase1OrBlockLegacy } = require('../app/lib/phase1-auth-routes');
  const { isProductionWorkspaceAuth } = require('../app/lib/workspace-request-context');
  assert.equal(isProductionWorkspaceAuth({ WORKSPACE_AUTH_MODE: 'legacy' }), false);
  const req = { method: 'GET', headers: {} };
  const res = {
    writeHead() {},
    end() {},
  };
  const handled = await maybeHandlePhase1OrBlockLegacy(
    req,
    res,
    new URL('http://localhost/api/tasks'),
    { env: { WORKSPACE_AUTH_MODE: 'legacy' }, runtime: null },
  );
  assert.equal(handled, false);
});
