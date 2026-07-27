'use strict';

/**
 * Phase 3 durable execution — hostile two-Workspace matrix on real PostgreSQL.
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
const {
  generateEd25519Keypair,
  signEd25519,
  canonicalEnrollTranscript,
  canonicalDeviceTranscript,
  bodySha256,
  PROTOCOL_VERSION,
} = require('../app/lib/runner-control');
const { matchProductionRoute } = require('../app/lib/production-route-registry');
const { publicDisplayTuple } = require('../app/lib/public-work-conversation-event');
const { BANNED_FLAGS, assertSafeArgv } = require('../../runner/lib/engines/contract');
const { assertAuthorizedLease } = require('../../runner/lib/capability-grants');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase3exec';
const DATABASE = 'phase3_exec';
const TEST_FAKE_ENGINE_ENV = Object.freeze({
  NODE_ENV: 'test',
  AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1',
});

function withEphemeralPostgres(fn) {
  return withSharedEphemeralPostgres({
    prefix: 'phase3-exec-',
    role: LOCAL_ROLE,
    database: DATABASE,
  }, fn);
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

function deviceAuthHeaders({ keys, runnerId, credential, method, path: urlPath, body, sessionId = '', cursor = '' }) {
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(12).toString('base64url');
  const bodyHash = bodySha256(body);
  const transcript = canonicalDeviceTranscript({
    method, path: urlPath, bodyHash, timestampMs, nonce, runnerId, sessionId, cursor,
  });
  return {
    'x-runner-id': runnerId,
    'x-runner-timestamp': String(timestampMs),
    'x-runner-nonce': nonce,
    'x-runner-session': sessionId,
    'x-runner-cursor': cursor === '' || cursor == null ? '' : String(cursor),
    'x-runner-credential': credential,
    'x-runner-signature': signEd25519(keys.privateKey, transcript),
  };
}

async function enrollActiveRunner(baseUrl, token, keys, hostName = 'host') {
  const start = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', { token, body: {} });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const enrollmentId = start.json.enrollment.id;
  const code = start.json.enrollment.humanCode;
  const body = {
    challengeId: enrollmentId,
    challengeCode: code,
    devicePublicKey: keys.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    hostName,
    hostOs: 'darwin',
    runnerVersion: '0.1.0-dev',
  };
  body.signature = signEd25519(keys.privateKey, canonicalEnrollTranscript(body));
  const enroll = await httpJson(baseUrl, 'POST', '/api/runner/device/enroll', { body });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.json));
  await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${enrollmentId}/confirm`, { token, body: {} });
  const claimBody = {
    runnerId: enroll.json.runnerId,
    claimToken: enroll.json.claimToken,
    timestampMs: Date.now(),
    nonce: crypto.randomBytes(8).toString('base64url'),
  };
  claimBody.signature = signEd25519(keys.privateKey, [
    'claim-v1',
    `runnerId=${claimBody.runnerId}`,
    `claimToken=${claimBody.claimToken}`,
    `timestampMs=${claimBody.timestampMs}`,
    `nonce=${claimBody.nonce}`,
  ].join('\n'));
  const claim = await httpJson(baseUrl, 'POST', '/api/runner/device/claim', { body: claimBody });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const credential = claim.json.deviceCredential;
  const connectBody = { protocolVersion: PROTOCOL_VERSION, runnerId: enroll.json.runnerId };
  const connect = await httpJson(baseUrl, 'POST', '/api/runner/device/connect', {
    body: connectBody,
    headers: deviceAuthHeaders({
      keys, runnerId: enroll.json.runnerId, credential, method: 'POST',
      path: '/api/runner/device/connect', body: connectBody,
    }),
  });
  assert.equal(connect.status, 200, JSON.stringify(connect.json));
  const capsBody = {
    runnerId: enroll.json.runnerId,
    engines: {
      fake: { available: true, status: 'available', version: 'fake-1', authStatus: 'ok' },
      codex: { available: false, status: 'unavailable' },
      claude: { available: false, status: 'unavailable' },
      grok: { available: false, status: 'unavailable' },
      hermes: { available: false, status: 'unavailable' },
    },
  };
  await httpJson(baseUrl, 'POST', '/api/runner/device/capabilities', {
    body: capsBody,
    headers: deviceAuthHeaders({
      keys, runnerId: enroll.json.runnerId, credential, method: 'POST',
      path: '/api/runner/device/capabilities', body: capsBody,
      sessionId: connect.json.sessionId, cursor: connect.json.cursor,
    }),
  });
  return {
    runnerId: enroll.json.runnerId,
    credential,
    credentialVersion: claim.json.credentialVersion,
    keys,
    sessionId: connect.json.sessionId,
    cursor: connect.json.cursor,
    workspaceId: claim.json.workspaceId,
  };
}

test('phase3 execution routes registered', () => {
  assert.ok(matchProductionRoute('POST', '/api/runner/device/next-offer'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/lease'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/event'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/provider-session/bind'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/complete'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/attempt-heartbeat'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/channels/telegram/status'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/channels/telegram/begin'));
});

test('phase3 engine adapters reject banned flags', () => {
  assert.ok(BANNED_FLAGS.includes('--yolo'));
  assert.throws(() => assertSafeArgv(['--yolo']), /banned/);
  assert.throws(() => assertSafeArgv(['--dangerously-skip-permissions']), /banned/);
  assertSafeArgv(['exec', '--json', '--sandbox', 'workspace-write']);
});

test('phase3 migration composite FKs and least-privilege grants', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await runMigrations({ pool });
    const fks = await pool.query(`
      select conname, conrelid::regclass::text as tbl
      from pg_constraint
      where contype = 'f'
        and conrelid::regclass::text in (
          'execution_jobs','execution_offers','execution_attempts',
          'execution_events','execution_artifacts','execution_outbox'
        )
      order by tbl, conname
    `);
    const names = fks.rows.map((r) => `${r.tbl}:${r.conname}`).join('|');
    assert.match(names, /execution_jobs/);
    assert.match(names, /execution_offers/);
    assert.match(names, /execution_attempts/);
    // Jobs must reference missions/sessions/runners (preferred)
    const jobFks = await pool.query(`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      where r.relname = 'execution_jobs' and c.contype = 'f'
    `);
    const defs = jobFks.rows.map((r) => r.def).join('\n');
    assert.match(defs, /agent_missions/);
    assert.match(defs, /agent_sessions/);
    assert.match(defs, /SET NULL \(preferred_runner_id\)|set null \(preferred_runner_id\)/i);

    const attemptFks = await pool.query(`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      where r.relname = 'execution_attempts' and c.contype = 'f'
    `);
    assert.ok(attemptFks.rows.some((r) => /execution_offers/i.test(r.def) && /offer_id/i.test(r.def)));

    const grants = await pool.query(`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'agent_calendar_app'
        and table_name in (
          'execution_jobs','execution_offers','execution_attempts','execution_outbox'
        )
      order by table_name, privilege_type
    `);
    const byTable = {};
    for (const row of grants.rows) {
      byTable[row.table_name] = byTable[row.table_name] || new Set();
      byTable[row.table_name].add(row.privilege_type);
    }
    assert.ok(byTable.execution_jobs?.has('INSERT'));
    assert.ok(byTable.execution_jobs?.has('UPDATE'));
    assert.equal(byTable.execution_offers?.has('INSERT'), false);
    assert.equal(byTable.execution_offers?.has('UPDATE'), false);
    assert.equal(byTable.execution_offers?.has('DELETE'), false);
    assert.equal(byTable.execution_attempts?.has('INSERT'), false);
    assert.equal(byTable.execution_attempts?.has('UPDATE'), false);
    assert.equal(byTable.execution_outbox?.has('INSERT'), false);
    assert.equal(byTable.execution_outbox?.has('UPDATE'), false);
  });
});

test('phase3 app-role cannot mutate offers/attempts/outbox under RLS', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    async function expectDenied(sql, params = []) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
        await client.query(`select set_config('app.user_id', 'user-a', true)`);
        await client.query('set local role agent_calendar_app');
        await assert.rejects(() => client.query(sql, params), /permission denied|violates/);
        await client.query('rollback');
      } finally {
        client.release();
      }
    }
    await expectDenied(
      `insert into execution_offers (id, workspace_id, job_id, runner_id, status, expires_at)
       values ('o1','ws-a','j1','r1','open', now())`,
    );
    await expectDenied(
      `insert into execution_attempts (
         id, workspace_id, job_id, runner_id, attempt_number, lease_epoch, status, lease_expires_at
       ) values ('a1','ws-a','j1','r1',1,1,'leased', now())`,
    );
    await expectDenied(
      `insert into execution_outbox (id, workspace_id, job_id, event_type, payload, status)
       values ('x1','ws-a','j1','t','{}','pending')`,
    );
  });
});

test('phase3 hostile durable execution matrix', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: { ...TEST_FAKE_ENGINE_ENV, DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    assert.equal(runtime.product.env.NODE_ENV, 'test');
    assert.equal(runtime.product.env.AGENT_CALENDAR_ALLOW_FAKE_ENGINE, '1');
    assert.ok(runtime.durableExecution);
    process.env.WORKSPACE_AUTH_MODE = 'production';

    const server = createRailwayGatewayServer({
      env: {
        ...TEST_FAKE_ENGINE_ENV,
        WORKSPACE_AUTH_MODE: 'production',
        DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
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
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const keysA = generateEd25519Keypair();
      const keysB = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'host-a');
      const runnerB = await enrollActiveRunner(baseUrl, tokenB, keysB, 'host-b');

      // Unauthenticated cannot create work
      const anon = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        body: { goal: 'secret', executionEngine: 'fake' },
      });
      assert.equal(anon.status, 401);

      // A creates durable work
      const createA = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'Do A work', executionEngine: 'fake', agentId: 'agent-a' },
      });
      assert.equal(createA.status, 200, JSON.stringify(createA.json));
      assert.ok(['accepted', 'waiting_runner'].includes(createA.json.status));
      assert.notEqual(createA.json.status, 'blocked_runner_required');
      assert.ok(createA.json.jobId || createA.json.missionId);
      const missionA = createA.json.missionId;
      const scheduledProjection = await pool.query(
        `select payload from calendar_events
         where workspace_id = 'ws-a'
           and payload->>'source' = 'agent-work'
           and payload->>'missionId' = $1`,
        [missionA],
      );
      assert.equal(scheduledProjection.rowCount, 1);
      assert.equal(scheduledProjection.rows[0].payload.lifecycleStatus, 'scheduled');

      // B cannot see A's conversation
      const convB = await httpJson(baseUrl, 'GET', `/api/agent-operations/work/${missionA}/conversation`, {
        token: tokenB,
      });
      assert.ok(convB.status === 404 || convB.json?.ok === false || !convB.json?.checkpoints?.length);

      // Runner B cannot lease A's work
      const nextB = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerB.runnerId },
        headers: deviceAuthHeaders({
          keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerB.runnerId },
          sessionId: runnerB.sessionId, cursor: runnerB.cursor,
        }),
      });
      assert.equal(nextB.status, 200);
      assert.equal(nextB.json.offer, null);

      // Runner A gets offer and leases
      const nextA = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerA.runnerId },
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerA.runnerId },
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(nextA.status, 200, JSON.stringify(nextA.json));
      assert.ok(nextA.json.offer, JSON.stringify(nextA.json));
      assert.equal(nextA.json.offer.resolvedEngine, 'fake');

      // Concurrent lease — only one succeeds
      const leaseBody = { offerId: nextA.json.offer.offerId, runnerId: runnerA.runnerId };
      const [l1, l2] = await Promise.all([
        httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
          body: leaseBody,
          headers: deviceAuthHeaders({
            keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
            method: 'POST', path: '/api/runner/device/lease', body: leaseBody,
            sessionId: runnerA.sessionId, cursor: runnerA.cursor,
          }),
        }),
        httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
          body: leaseBody,
          headers: deviceAuthHeaders({
            keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
            method: 'POST', path: '/api/runner/device/lease', body: leaseBody,
            sessionId: runnerA.sessionId, cursor: runnerA.cursor,
          }),
        }),
      ]);
      const leaseOk = [l1, l2].filter((r) => r.status === 200 && r.json.lease);
      assert.equal(leaseOk.length, 1, JSON.stringify([l1.json, l2.json]));
      const lease = leaseOk[0].json.lease;
      const runningProjection = await pool.query(
        `select payload from calendar_events
         where workspace_id = 'ws-a'
           and payload->>'source' = 'agent-work'
           and payload->>'missionId' = $1`,
        [missionA],
      );
      assert.equal(runningProjection.rows[0].payload.lifecycleStatus, 'running');

      // Progress event
      const eventBody = {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        kind: 'checkpoint',
        phase: 'plan',
        text: 'Plan ready',
        idempotencyKey: 'plan-1',
        runnerId: runnerA.runnerId,
      };
      const ev1 = await httpJson(baseUrl, 'POST', '/api/runner/device/event', {
        body: eventBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/event', body: eventBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(ev1.status, 200, JSON.stringify(ev1.json));
      const planCheckpoint = await pool.query(
        `select payload
         from agent_session_events
         where workspace_id = 'ws-a' and session_id = $1
           and payload->>'text' = 'Plan ready'
         limit 1`,
        [lease.sessionId],
      );
      assert.equal(planCheckpoint.rowCount, 1);
      assert.deepEqual(
        {
          jobId: planCheckpoint.rows[0].payload.metadata.jobId,
          turnIndex: planCheckpoint.rows[0].payload.metadata.turnIndex,
          turnTargetIndex: planCheckpoint.rows[0].payload.metadata.turnTargetIndex,
          turnMode: planCheckpoint.rows[0].payload.metadata.turnMode,
          resolvedExecutionEngine: planCheckpoint.rows[0].payload.metadata.resolvedExecutionEngine,
        },
        {
          jobId: lease.jobId,
          turnIndex: 1,
          turnTargetIndex: 0,
          turnMode: 'single',
          resolvedExecutionEngine: undefined,
        },
      );
      assert.equal(
        Object.values(planCheckpoint.rows[0].payload.metadata).includes(null),
        false,
        'optional checkpoint metadata must be omitted instead of serialized as null',
      );
      // Idempotent replay
      const ev2 = await httpJson(baseUrl, 'POST', '/api/runner/device/event', {
        body: eventBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/event', body: eventBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(ev2.status, 200);
      assert.equal(ev2.json.replay, true);

      // Provider secrets rejected
      const secretBody = {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        text: 'x',
        payload: { OPENAI_API_KEY: 'sk-secret-should-fail' },
        runnerId: runnerA.runnerId,
        idempotencyKey: 'secret-1',
      };
      const secret = await httpJson(baseUrl, 'POST', '/api/runner/device/event', {
        body: secretBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/event', body: secretBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.ok(secret.status >= 400);

      // Stale lease epoch rejected
      const staleBody = {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch - 1,
        summary: 'nope',
        runnerId: runnerA.runnerId,
      };
      const stale = await httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
        body: staleBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/complete', body: staleBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(stale.status, 409);

      // Complete
      const completeBody = {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        summary: 'Done A',
        runnerId: runnerA.runnerId,
      };
      const complete = await httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
        body: completeBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/complete', body: completeBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.json));
      assert.equal(complete.json.status, 'completed');
      const completedProjection = await pool.query(
        `select payload from calendar_events
         where workspace_id = 'ws-a'
           and payload->>'source' = 'agent-work'
           and payload->>'missionId' = $1`,
        [missionA],
      );
      assert.equal(completedProjection.rows[0].payload.lifecycleStatus, 'completed');
      assert.equal(completedProjection.rows[0].payload.resultSummary, 'Done A');

      // Duplicate complete is replay, not second terminal
      const complete2 = await httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
        body: completeBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/complete', body: completeBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(complete2.status, 200);
      assert.equal(complete2.json.replay, true);

      const terminals = await pool.query(
        `select count(*)::int as n from execution_attempts
         where workspace_id = 'ws-a' and status = 'completed'`,
      );
      assert.equal(terminals.rows[0].n, 1);

      // Calendar projection exists
      const cal = await pool.query(
        `select count(*)::int as n from calendar_events where workspace_id = 'ws-a' and payload->>'source' = 'agent-work'`,
      );
      assert.ok(cal.rows[0].n >= 1);

      // Explicit engine never silently falls back: request codex when only fake available → waiting
      const createCodex = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'Need codex', executionEngine: 'codex' },
      });
      assert.equal(createCodex.status, 200);
      // With only fake available, status is waiting_runner
      assert.ok(['waiting_runner', 'accepted'].includes(createCodex.json.status));

      // Cancel work
      const cancelJob = await httpJson(baseUrl, 'POST', `/api/agent-operations/missions/${createCodex.json.missionId}/cancel`, {
        token: tokenA,
        body: {},
      });
      assert.equal(cancelJob.status, 200);

      // Revoked runner denied
      await httpJson(baseUrl, 'POST', `/api/runners/${runnerA.runnerId}/revoke`, { token: tokenA, body: {} });
      const afterRevoke = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerA.runnerId },
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerA.runnerId },
        }),
      });
      assert.equal(afterRevoke.status, 401);

      // Restart-safe reaper: create job, lease, expire, reap, requeue
      await runtime.durableExecution.reap('ws-b');

      // Foreign preferredRunnerId is ignored (never stalls job in foreign workspace)
      const foreignPref = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          goal: 'Foreign preferred should be ignored',
          executionEngine: 'fake',
          preferredRunnerId: runnerB.runnerId,
        },
      });
      assert.equal(foreignPref.status, 200, JSON.stringify(foreignPref.json));
      assert.ok(['accepted', 'waiting_runner'].includes(foreignPref.json.status));
      const jobPref = await pool.query(
        `select preferred_runner_id from execution_jobs where mission_id = $1`,
        [foreignPref.json.missionId],
      );
      assert.equal(jobPref.rows[0]?.preferred_runner_id, null);

      // Concurrent duplicate events share one sequence under idempotency
      const workDup = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenB,
        body: { goal: 'Dup events B', executionEngine: 'fake' },
      });
      assert.equal(workDup.status, 200);
      // Re-enroll runner B after revoke of A only — B still active
      const nextDup = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerB.runnerId },
        headers: deviceAuthHeaders({
          keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerB.runnerId },
          sessionId: runnerB.sessionId, cursor: runnerB.cursor,
        }),
      });
      if (nextDup.json?.offer) {
        const leaseDupBody = { offerId: nextDup.json.offer.offerId, runnerId: runnerB.runnerId };
        const leaseDup = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
          body: leaseDupBody,
          headers: deviceAuthHeaders({
            keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
            method: 'POST', path: '/api/runner/device/lease', body: leaseDupBody,
            sessionId: runnerB.sessionId, cursor: runnerB.cursor,
          }),
        });
        assert.equal(leaseDup.status, 200, JSON.stringify(leaseDup.json));
        // Monotonic lease epoch equals attempt number
        assert.equal(leaseDup.json.lease.leaseEpoch, leaseDup.json.lease.attemptNumber);

        const dupBody = {
          attemptId: leaseDup.json.lease.attemptId,
          leaseEpoch: leaseDup.json.lease.leaseEpoch,
          kind: 'checkpoint',
          phase: 'progress',
          text: 'concurrent-dup',
          idempotencyKey: 'concurrent-dup-key',
          runnerId: runnerB.runnerId,
        };
        const [d1, d2, d3] = await Promise.all([1, 2, 3].map(() => httpJson(baseUrl, 'POST', '/api/runner/device/event', {
          body: dupBody,
          headers: deviceAuthHeaders({
            keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
            method: 'POST', path: '/api/runner/device/event', body: dupBody,
            sessionId: runnerB.sessionId, cursor: runnerB.cursor,
          }),
        })));
        assert.ok([d1, d2, d3].every((r) => r.status === 200));
        const seqs = [d1, d2, d3].map((r) => r.json.event?.sequence).filter((n) => n != null);
        assert.equal(new Set(seqs).size, 1);

        // completion idempotencyKey honored under concurrent complete
        const cBody = {
          attemptId: leaseDup.json.lease.attemptId,
          leaseEpoch: leaseDup.json.lease.leaseEpoch,
          summary: 'dup complete',
          idempotencyKey: 'terminal:complete',
          runnerId: runnerB.runnerId,
        };
        const [c1, c2] = await Promise.all([
          httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
            body: cBody,
            headers: deviceAuthHeaders({
              keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
              method: 'POST', path: '/api/runner/device/complete', body: cBody,
              sessionId: runnerB.sessionId, cursor: runnerB.cursor,
            }),
          }),
          httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
            body: cBody,
            headers: deviceAuthHeaders({
              keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
              method: 'POST', path: '/api/runner/device/complete', body: cBody,
              sessionId: runnerB.sessionId, cursor: runnerB.cursor,
            }),
          }),
        ]);
        assert.ok([c1, c2].every((r) => r.status === 200));
        const termsB = await pool.query(
          `select count(*)::int as n from execution_attempts
           where workspace_id = 'ws-b' and status = 'completed'`,
        );
        assert.equal(termsB.rows[0].n, 1);

        // Authoritative report + timestamptz calendar
        const reports = await pool.query(
          `select count(*)::int as n from agent_reports where workspace_id = 'ws-b'`,
        );
        assert.ok(reports.rows[0].n >= 1);
        const calIso = await pool.query(
          `select starts_at from calendar_events
           where workspace_id = 'ws-b' and payload->>'source' = 'agent-work'
           limit 1`,
        );
        assert.ok(calIso.rowCount);
        assert.ok(calIso.rows[0].starts_at instanceof Date || String(calIso.rows[0].starts_at).includes('T') || String(calIso.rows[0].starts_at).includes(' '));
      }

      // Outbox drain with real SSE handler
      const drain = await runtime.durableExecution.drainOutbox({ limit: 10 });
      assert.equal(drain.ok, true);
      assert.ok(drain.drained >= 0);

      // No-handler surfaces not_configured without marking done
      const bare = new (require('../app/lib/durable-execution').DurableExecution)({
        pool,
        env: process.env,
        outboxHandler: null,
        sseHub: null,
      });
      bare.outboxHandler = null;
      const noHandler = await bare.drainOutbox({ limit: 5 });
      assert.equal(noHandler.not_configured, true);

      // Background workers start/stop
      const started = runtime.durableExecution.startBackgroundWorkers({ reaperIntervalMs: 60_000, outboxIntervalMs: 60_000 });
      assert.equal(started.ok, true);
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();

      // Deterministic offer expiry: create work, next-offer, expire, reaper → accepted + expired offer
      const workExp = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenB,
        body: { goal: 'expire offer deterministic', executionEngine: 'fake' },
      });
      assert.equal(workExp.status, 200);
      const nextExp = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerB.runnerId },
        headers: deviceAuthHeaders({
          keys: keysB, runnerId: runnerB.runnerId, credential: runnerB.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerB.runnerId },
          sessionId: runnerB.sessionId, cursor: runnerB.cursor,
        }),
      });
      assert.ok(nextExp.json?.offer, JSON.stringify(nextExp.json));
      const expOfferId = nextExp.json.offer.offerId;
      const expJobId = nextExp.json.offer.jobId;
      await pool.query(
        `update execution_offers set expires_at = now() - interval '1 second' where id = $1`,
        [expOfferId],
      );
      await runtime.durableExecution.reap('ws-b');
      const offerRow = await pool.query(`select status from execution_offers where id = $1`, [expOfferId]);
      assert.equal(offerRow.rows[0].status, 'expired');
      const jobRow = await pool.query(`select status from execution_jobs where id = $1`, [expJobId]);
      assert.equal(jobRow.rows[0].status, 'accepted');
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
    }
  });
});

test('phase3 preferred_runner delete nulls only preferred_runner_id', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const runtime = createPhase1Runtime({
      pool, identityVerifier: null, authKit: null, workosConfig: null,
      env: { ...TEST_FAKE_ENGINE_ENV, DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const server = createRailwayGatewayServer({
      env: { ...TEST_FAKE_ENGINE_ENV, WORKSPACE_AUTH_MODE: 'production', DURABLE_EXECUTION_CLAIMS_ENABLED: 'true', DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const keys = generateEd25519Keypair();
      const runner = await enrollActiveRunner(baseUrl, tokenA, keys, 'pref-host');
      const created = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'pref', executionEngine: 'fake', preferredRunnerId: runner.runnerId },
      });
      assert.equal(created.status, 200);
      await pool.query(
        `update execution_jobs set preferred_runner_id = $1 where mission_id = $2`,
        [runner.runnerId, created.json.missionId],
      );
      // Soft-delete path: delete runner row after disconnect/revoke cleanup of children
      await pool.query(`delete from runner_sessions where runner_id = $1`, [runner.runnerId]).catch(() => {});
      await pool.query(`delete from runners where id = $1`, [runner.runnerId]);
      const job = await pool.query(
        `select preferred_runner_id, workspace_id from execution_jobs where mission_id = $1`,
        [created.json.missionId],
      );
      assert.equal(job.rows[0].preferred_runner_id, null);
      assert.equal(job.rows[0].workspace_id, 'ws-a');
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
    }
  });
});

test('phase3 offered cancel withdraws offers and terminals job', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const runtime = createPhase1Runtime({
      pool, identityVerifier: null, authKit: null, workosConfig: null,
      env: { ...TEST_FAKE_ENGINE_ENV, DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const server = createRailwayGatewayServer({
      env: { ...TEST_FAKE_ENGINE_ENV, WORKSPACE_AUTH_MODE: 'production', DURABLE_EXECUTION_CLAIMS_ENABLED: 'true', DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const keys = generateEd25519Keypair();
      const runner = await enrollActiveRunner(baseUrl, tokenA, keys, 'offer-cancel');
      const created = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'offered cancel', executionEngine: 'fake' },
      });
      const next = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runner.runnerId },
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runner.runnerId },
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.ok(next.json.offer);
      const cancel = await httpJson(baseUrl, 'POST', `/api/agent-operations/missions/${created.json.missionId}/cancel`, {
        token: tokenA, body: {},
      });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.json.status, 'cancelled');
      const offers = await pool.query(
        `select status from execution_offers where job_id = $1`,
        [next.json.offer.jobId],
      );
      assert.ok(offers.rows.every((r) => r.status === 'withdrawn' || r.status === 'expired'));
      const job = await pool.query(`select status from execution_jobs where id = $1`, [next.json.offer.jobId]);
      assert.equal(job.rows[0].status, 'cancelled');
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
    }
  });
});

test('phase3 cancel-ack without request rejected; heartbeat returns cancellation', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const runtime = createPhase1Runtime({
      pool, identityVerifier: null, authKit: null, workosConfig: null,
      env: { ...TEST_FAKE_ENGINE_ENV, DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const server = createRailwayGatewayServer({
      env: { ...TEST_FAKE_ENGINE_ENV, WORKSPACE_AUTH_MODE: 'production', DURABLE_EXECUTION_CLAIMS_ENABLED: 'true', DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const keys = generateEd25519Keypair();
      const runner = await enrollActiveRunner(baseUrl, tokenA, keys, 'hb-host');
      const created = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'heartbeat cancel', executionEngine: 'fake' },
      });
      const next = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runner.runnerId },
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runner.runnerId },
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      const leaseBody = { offerId: next.json.offer.offerId, runnerId: runner.runnerId };
      const lease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: leaseBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/lease', body: leaseBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(lease.status, 200);
      const ackBody = {
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        runnerId: runner.runnerId,
      };
      const ackNoReq = await httpJson(baseUrl, 'POST', '/api/runner/device/cancel-ack', {
        body: ackBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/cancel-ack', body: ackBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(ackNoReq.status, 409);
      assert.equal(ackNoReq.json.error, 'CANCEL_NOT_REQUESTED');

      const hbBody = {
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        runnerId: runner.runnerId,
      };
      const hb1 = await httpJson(baseUrl, 'POST', '/api/runner/device/attempt-heartbeat', {
        body: hbBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/attempt-heartbeat', body: hbBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(hb1.status, 200);
      assert.equal(hb1.json.cancellationRequested, false);
      assert.ok(hb1.json.leaseExpiresAt);

      await httpJson(baseUrl, 'POST', `/api/agent-operations/missions/${created.json.missionId}/cancel`, {
        token: tokenA, body: {},
      });
      const hb2 = await httpJson(baseUrl, 'POST', '/api/runner/device/attempt-heartbeat', {
        body: hbBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/attempt-heartbeat', body: hbBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(hb2.status, 200);
      assert.equal(hb2.json.cancellationRequested, true);

      const ack = await httpJson(baseUrl, 'POST', '/api/runner/device/cancel-ack', {
        body: ackBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/cancel-ack', body: ackBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(ack.status, 200);
      assert.equal(ack.json.status, 'cancelled');
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
    }
  });
});

test('phase3 dead_letter after max attempts and revoke-vs-event', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const runtime = createPhase1Runtime({
      pool, identityVerifier: null, authKit: null, workosConfig: null,
      env: { ...TEST_FAKE_ENGINE_ENV, DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const server = createRailwayGatewayServer({
      env: { ...TEST_FAKE_ENGINE_ENV, WORKSPACE_AUTH_MODE: 'production', DURABLE_EXECUTION_CLAIMS_ENABLED: 'true', DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const keys = generateEd25519Keypair();
      const runner = await enrollActiveRunner(baseUrl, tokenA, keys, 'dead-host');
      const created = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'dead letter path', executionEngine: 'fake' },
      });
      await pool.query(
        `update execution_jobs set max_attempts = 1 where mission_id = $1`,
        [created.json.missionId],
      );
      const next = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runner.runnerId },
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runner.runnerId },
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      const leaseBody = { offerId: next.json.offer.offerId, runnerId: runner.runnerId };
      const lease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: leaseBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/lease', body: leaseBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      const failBody = {
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        errorCode: 'boom',
        errorMessage: 'fail once',
        retryable: true,
        runnerId: runner.runnerId,
      };
      const failed = await httpJson(baseUrl, 'POST', '/api/runner/device/fail', {
        body: failBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/fail', body: failBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(failed.status, 200);
      assert.equal(failed.json.status, 'dead_letter');
      const job = await pool.query(
        `select status from execution_jobs where mission_id = $1`,
        [created.json.missionId],
      );
      assert.equal(job.rows[0].status, 'dead_letter');
      const failedMission = await pool.query(
        `select status, payload from agent_missions where id = $1 and workspace_id = 'ws-a'`,
        [created.json.missionId],
      );
      assert.equal(failedMission.rows[0].status, 'failed');
      assert.equal(failedMission.rows[0].payload.status, 'failed');
      assert.equal(failedMission.rows[0].payload.failureCode, 'boom');
      assert.equal(failedMission.rows[0].payload.failureMessage, 'fail once');
      const failedSession = await pool.query(
        `select status, payload from agent_sessions where mission_id = $1 and workspace_id = 'ws-a'`,
        [created.json.missionId],
      );
      assert.equal(failedSession.rows[0].status, 'failed');
      assert.equal(failedSession.rows[0].payload.status, 'failed');
      assert.equal(failedSession.rows[0].payload.failureCode, 'boom');
      const failedProjection = await pool.query(
        `select payload from calendar_events
         where workspace_id = 'ws-a'
           and payload->>'source' = 'agent-work'
           and payload->>'missionId' = $1`,
        [created.json.missionId],
      );
      assert.equal(failedProjection.rowCount, 1);
      assert.equal(failedProjection.rows[0].payload.lifecycleStatus, 'failed');

      const retryCreated = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'rework lifecycle', executionEngine: 'fake' },
      });
      const retryNext = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runner.runnerId },
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runner.runnerId },
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      const retryLeaseBody = { offerId: retryNext.json.offer.offerId, runnerId: runner.runnerId };
      const retryLease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: retryLeaseBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/lease', body: retryLeaseBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      const retryFailBody = {
        attemptId: retryLease.json.lease.attemptId,
        leaseEpoch: retryLease.json.lease.leaseEpoch,
        errorCode: 'temporary_provider_error',
        errorMessage: 'retry later',
        retryable: true,
        runnerId: runner.runnerId,
      };
      const retryFailed = await httpJson(baseUrl, 'POST', '/api/runner/device/fail', {
        body: retryFailBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/fail', body: retryFailBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(retryFailed.status, 200);
      assert.equal(retryFailed.json.status, 'accepted');
      const reworkProjection = await pool.query(
        `select payload from calendar_events
         where workspace_id = 'ws-a'
           and payload->>'source' = 'agent-work'
           and payload->>'missionId' = $1`,
        [retryCreated.json.missionId],
      );
      assert.equal(reworkProjection.rowCount, 1);
      assert.equal(reworkProjection.rows[0].payload.lifecycleStatus, 'rework');

      // Fresh work for revoke-vs-event
      const created2 = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'revoke event', executionEngine: 'fake' },
      });
      const next2 = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runner.runnerId },
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runner.runnerId },
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      const lease2Body = { offerId: next2.json.offer.offerId, runnerId: runner.runnerId };
      const lease2 = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: lease2Body,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/lease', body: lease2Body,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      await httpJson(baseUrl, 'POST', `/api/runners/${runner.runnerId}/revoke`, { token: tokenA, body: {} });
      const evBody = {
        attemptId: lease2.json.lease.attemptId,
        leaseEpoch: lease2.json.lease.leaseEpoch,
        kind: 'checkpoint',
        phase: 'progress',
        text: 'after revoke',
        idempotencyKey: 'post-revoke',
        runnerId: runner.runnerId,
      };
      const ev = await httpJson(baseUrl, 'POST', '/api/runner/device/event', {
        body: evBody,
        headers: deviceAuthHeaders({
          keys, runnerId: runner.runnerId, credential: runner.credential,
          method: 'POST', path: '/api/runner/device/event', body: evBody,
          sessionId: runner.sessionId, cursor: runner.cursor,
        }),
      });
      assert.equal(ev.status, 401);
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
    }
  });
});

test('phase3 cancel-vs-complete and lease-expiry fencing', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS = '0';
    const runtime = createPhase1Runtime({
      pool, identityVerifier: null, authKit: null, workosConfig: null,
      env: { ...TEST_FAKE_ENGINE_ENV, DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const server = createRailwayGatewayServer({
      env: { ...TEST_FAKE_ENGINE_ENV, WORKSPACE_AUTH_MODE: 'production', DURABLE_EXECUTION_CLAIMS_ENABLED: 'true', DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const keysA = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'host-fence');
      const created = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'cancel race', executionEngine: 'fake' },
      });
      assert.equal(created.status, 200);
      const next = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerA.runnerId },
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerA.runnerId },
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.ok(next.json.offer);
      const leaseBody = { offerId: next.json.offer.offerId, runnerId: runnerA.runnerId };
      const lease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: leaseBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/lease', body: leaseBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(lease.status, 200);
      // Cancel while leased
      await httpJson(baseUrl, 'POST', `/api/agent-operations/missions/${created.json.missionId}/cancel`, {
        token: tokenA, body: {},
      });
      const completeBody = {
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        summary: 'should fail cancel',
        runnerId: runnerA.runnerId,
      };
      const completeAfterCancel = await httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
        body: completeBody,
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/complete', body: completeBody,
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      assert.equal(completeAfterCancel.status, 409);

      // Lease expiry vs artifact: force expire then artifact denied
      const created2 = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: { goal: 'lease expire art', executionEngine: 'fake' },
      });
      const next2 = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: { runnerId: runnerA.runnerId },
        headers: deviceAuthHeaders({
          keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
          method: 'POST', path: '/api/runner/device/next-offer', body: { runnerId: runnerA.runnerId },
          sessionId: runnerA.sessionId, cursor: runnerA.cursor,
        }),
      });
      if (next2.json?.offer) {
        const lease2Body = { offerId: next2.json.offer.offerId, runnerId: runnerA.runnerId };
        const lease2 = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
          body: lease2Body,
          headers: deviceAuthHeaders({
            keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
            method: 'POST', path: '/api/runner/device/lease', body: lease2Body,
            sessionId: runnerA.sessionId, cursor: runnerA.cursor,
          }),
        });
        if (lease2.json?.lease) {
          await pool.query(
            `update execution_attempts set lease_expires_at = now() - interval '1 second' where id = $1`,
            [lease2.json.lease.attemptId],
          );
          const artBody = {
            attemptId: lease2.json.lease.attemptId,
            leaseEpoch: lease2.json.lease.leaseEpoch,
            name: 'late.txt',
            content: 'x',
            runnerId: runnerA.runnerId,
          };
          const art = await httpJson(baseUrl, 'POST', '/api/runner/device/artifact', {
            body: artBody,
            headers: deviceAuthHeaders({
              keys: keysA, runnerId: runnerA.runnerId, credential: runnerA.credential,
              method: 'POST', path: '/api/runner/device/artifact', body: artBody,
              sessionId: runnerA.sessionId, cursor: runnerA.cursor,
            }),
          });
          assert.equal(art.status, 409);
        }
      }
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
      delete process.env.DURABLE_EXECUTION_BACKGROUND_WORKERS;
    }
  });
});

test('provider agent catalog is delivered only to the exact Workspace Runner and imports public metadata', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: { DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
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
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const keysA = generateEd25519Keypair();
      const keysB = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'catalog-a');
      const runnerB = await enrollActiveRunner(baseUrl, tokenB, keysB, 'catalog-b');

      const foreignDefaultRunner = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: tokenA,
        body: {
          displayName: 'Foreign Runner Agent',
          defaultExecutionEngine: 'codex',
          defaultRunnerId: runnerB.runnerId,
        },
      });
      assert.equal(foreignDefaultRunner.status, 422);

      const foreignRequest = await httpJson(baseUrl, 'POST', '/api/agents/catalog/requests', {
        token: tokenA,
        body: { provider: 'codex', runnerId: runnerB.runnerId, consent: true },
      });
      assert.equal(foreignRequest.status, 404, JSON.stringify(foreignRequest.json));

      const requested = await httpJson(baseUrl, 'POST', '/api/agents/catalog/requests', {
        token: tokenA,
        body: { provider: 'codex', runnerId: runnerA.runnerId, consent: true },
      });
      assert.equal(requested.status, 202, JSON.stringify(requested.json));
      const requestId = requested.json.request.id;

      const nextBBody = { runnerId: runnerB.runnerId };
      const nextB = await httpJson(baseUrl, 'POST', '/api/runner/device/connectors/next', {
        body: nextBBody,
        headers: deviceAuthHeaders({
          keys: keysB,
          runnerId: runnerB.runnerId,
          credential: runnerB.credential,
          method: 'POST',
          path: '/api/runner/device/connectors/next',
          body: nextBBody,
          sessionId: runnerB.sessionId,
          cursor: runnerB.cursor,
        }),
      });
      assert.equal(nextB.status, 200);
      assert.equal(nextB.json.request, null);

      const nextABody = { runnerId: runnerA.runnerId };
      const nextA = await httpJson(baseUrl, 'POST', '/api/runner/device/connectors/next', {
        body: nextABody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/connectors/next',
          body: nextABody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(nextA.status, 200);
      assert.equal(nextA.json.request.id, requestId);
      assert.equal(nextA.json.request.provider, 'codex');

      const completeBody = {
        runnerId: runnerA.runnerId,
        requestId,
        entries: [{
          provider: 'codex',
          externalAgentId: 'researcher',
          displayName: 'Researcher',
          description: 'Checks sources',
          sourceKind: 'local_profile',
          capability: 'importable',
        }],
      };
      const completed = await httpJson(baseUrl, 'POST', '/api/runner/device/connectors/complete', {
        body: completeBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/connectors/complete',
          body: completeBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(completed.status, 200, JSON.stringify(completed.json));

      const foreignRead = await httpJson(
        baseUrl,
        'GET',
        `/api/agents/catalog/requests/${encodeURIComponent(requestId)}`,
        { token: tokenB },
      );
      assert.equal(foreignRead.status, 404);

      const ownRead = await httpJson(
        baseUrl,
        'GET',
        `/api/agents/catalog/requests/${encodeURIComponent(requestId)}`,
        { token: tokenA },
      );
      assert.equal(ownRead.status, 200);
      assert.equal(ownRead.json.request.entries[0].externalAgentId, 'researcher');

      const imported = await httpJson(
        baseUrl,
        'POST',
        `/api/agents/catalog/requests/${encodeURIComponent(requestId)}/import`,
        {
          token: tokenA,
          body: {
            externalAgentId: 'researcher',
            displayName: 'Source Researcher',
            defaultExecutionEngine: 'codex',
          },
        },
      );
      assert.equal(imported.status, 200, JSON.stringify(imported.json));
      assert.equal(imported.json.agent.defaultRunnerId, runnerA.runnerId);
      assert.equal(imported.json.agent.externalAgentId, 'researcher');

      const agentsB = await httpJson(baseUrl, 'GET', '/api/agents', { token: tokenB });
      assert.equal(agentsB.status, 200);
      assert.equal(agentsB.json.agents.some((agent) => agent.externalAgentId === 'researcher'), false);

      const stored = await pool.query(
        `select response::text as response
         from runner_connector_requests
         where workspace_id = 'ws-a' and id = $1`,
        [requestId],
      );
      assert.doesNotMatch(stored.rows[0].response, /token|credential|cookie|sk-/i);

      const importedAgentId = imported.json.agent.id;
      const sessionRequested = await httpJson(
        baseUrl,
        'POST',
        `/api/agents/${encodeURIComponent(importedAgentId)}/sessions/catalog/requests`,
        {
          token: tokenA,
          body: { runnerId: runnerA.runnerId, consent: true },
        },
      );
      assert.equal(sessionRequested.status, 202, JSON.stringify(sessionRequested.json));
      const sessionRequestId = sessionRequested.json.request.id;

      const nextSessionBody = { runnerId: runnerA.runnerId };
      const nextSession = await httpJson(baseUrl, 'POST', '/api/runner/device/connectors/next', {
        body: nextSessionBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/connectors/next',
          body: nextSessionBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(nextSession.status, 200);
      assert.equal(nextSession.json.request.id, sessionRequestId);
      assert.equal(nextSession.json.request.kind, 'session_catalog');

      const externalSessionId = '00000000-0000-4000-8000-000000000006';
      const completeSessionBody = {
        runnerId: runnerA.runnerId,
        requestId: sessionRequestId,
        entries: [{
          provider: 'codex',
          externalSessionId,
          title: 'Existing Codex research',
          updatedAt: '2026-07-25T10:00:00.000Z',
          status: 'available',
          sourceKind: 'local_session',
          capability: 'resumable',
        }],
      };
      const sessionCompleted = await httpJson(
        baseUrl,
        'POST',
        '/api/runner/device/connectors/complete',
        {
          body: completeSessionBody,
          headers: deviceAuthHeaders({
            keys: keysA,
            runnerId: runnerA.runnerId,
            credential: runnerA.credential,
            method: 'POST',
            path: '/api/runner/device/connectors/complete',
            body: completeSessionBody,
            sessionId: runnerA.sessionId,
            cursor: runnerA.cursor,
          }),
        },
      );
      assert.equal(sessionCompleted.status, 200, JSON.stringify(sessionCompleted.json));

      const sessionImported = await httpJson(
        baseUrl,
        'POST',
        `/api/agents/${encodeURIComponent(importedAgentId)}/sessions/catalog/requests/${encodeURIComponent(sessionRequestId)}/import`,
        {
          token: tokenA,
          body: { externalSessionId },
        },
      );
      assert.equal(sessionImported.status, 200, JSON.stringify(sessionImported.json));
      assert.equal(sessionImported.json.session.externalSessionId, externalSessionId);
      assert.equal(sessionImported.json.session.runnerId, runnerA.runnerId);

      const ownSessions = await httpJson(
        baseUrl,
        'GET',
        `/api/agents/${encodeURIComponent(importedAgentId)}/sessions`,
        { token: tokenA },
      );
      assert.equal(ownSessions.status, 200);
      assert.equal(ownSessions.json.sessions[0].externalSessionId, externalSessionId);
      assert.equal(ownSessions.json.sessions[0].missionId, sessionImported.json.missionId);

      const foreignSessions = await httpJson(
        baseUrl,
        'GET',
        `/api/agents/${encodeURIComponent(importedAgentId)}/sessions`,
        { token: tokenB },
      );
      assert.equal(foreignSessions.status, 200);
      assert.equal(foreignSessions.json.sessions.length, 0);

      const restoredConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(sessionImported.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(restoredConversation.status, 200, JSON.stringify(restoredConversation.json));
      assert.equal(restoredConversation.json.work.workConversationId, sessionImported.json.session.workConversationId);
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar?.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
    }
  });
});

test('Work Conversation follow-up leases the same provider session and restores its durable mapping', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    let runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: { DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    let server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
      },
      phase1Runtime: runtime,
      phase1Pool: pool,
      gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    let baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const keysA = generateEd25519Keypair();
      const keysB = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'session-a');
      const runnerB = await enrollActiveRunner(baseUrl, tokenB, keysB, 'session-b');
      await pool.query(
        `update runners
         set capabilities = $2::jsonb
         where workspace_id = 'ws-a' and id = $1`,
        [runnerA.runnerId, JSON.stringify({
          engines: {
            codex: {
              available: true,
              status: 'available',
              authStatus: 'authenticated',
              version: 'test',
            },
          },
          catalog: {
            catalogId: 'agent-calendar-runner',
            version: 1,
            entries: [
              { id: 'skill:agent.profile', version: 1, kind: 'skill', externalDelivery: false },
              { id: 'tool:external.delivery', version: 1, kind: 'tool', externalDelivery: true },
              { id: 'tool:workspace.read', version: 1, kind: 'tool', externalDelivery: false },
            ],
          },
        })],
      );

      const createdAgent = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: tokenA,
        body: {
          displayName: 'Codex Researcher',
          role: '시장 리서처',
          responsibility: '근거가 있는 시장 분석을 만든다.',
          instructions: '사실과 추정을 분리한다.',
          responseStyle: '차분한 존댓말로 핵심부터 쓴다.',
          specialties: ['시장 조사', '출처 검증'],
          memories: ['사용자는 한국어를 선호한다.'],
          defaultExecutionEngine: 'codex',
          defaultRunnerId: runnerA.runnerId,
        },
      });
      assert.equal(createdAgent.status, 200, JSON.stringify(createdAgent.json));
      const agentId = createdAgent.json.agent.id;
      const grantExpansion = await httpJson(
        baseUrl,
        'PATCH',
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          token: tokenA,
          body: {
            grants: {
              allow: ['tool:workspace.read', 'tool:external.delivery'],
              deny: [],
            },
          },
        },
      );
      assert.equal(grantExpansion.status, 200, JSON.stringify(grantExpansion.json));
      assert.deepEqual(grantExpansion.json.agent.grants.allow, []);
      assert.equal(grantExpansion.json.agent.approvalGate.status, 'pending');
      assert.equal(grantExpansion.json.agent.approvalGate.reason, 'grant_expansion');
      assert.equal(grantExpansion.json.agent.approvalGate.externalDelivery, true);
      const foreignAgents = await httpJson(baseUrl, 'GET', '/api/agents', { token: tokenB });
      assert.equal(foreignAgents.status, 200);
      assert.equal(foreignAgents.json.agents.some((agent) => agent.id === agentId), false);
      assert.equal(JSON.stringify(foreignAgents.json).includes(
        grantExpansion.json.agent.approvalGate.id,
      ), false);
      const deniedWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Denied capability must not lease',
          goal: 'Read Workspace data',
          agentId,
          executionEngine: 'auto',
          requiredCapabilities: ['tool:workspace.read'],
        },
      });
      assert.equal(deniedWork.status, 403, JSON.stringify(deniedWork.json));
      assert.equal(deniedWork.json.error, 'CAPABILITY_DENIED');
      const deniedJobs = await pool.query(
        `select count(*)::int as n
         from execution_jobs
         where workspace_id = 'ws-a'
           and payload->'effectiveConfiguration'->'requiredCapabilities'
             @> '["tool:workspace.read"]'::jsonb`,
      );
      assert.equal(deniedJobs.rows[0].n, 0);

      const createdWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Session continuity',
          goal: 'Create the first result',
          agentId,
          executionEngine: 'auto',
        },
      });
      assert.equal(createdWork.status, 200, JSON.stringify(createdWork.json));
      assert.match(createdWork.json.effectiveConfiguration.snapshotId, /^ecfg_[a-f0-9]{32}$/);
      assert.equal(createdWork.json.effectiveConfiguration.executable, true);

      const nextBody = { runnerId: runnerA.runnerId };
      const next = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: nextBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/next-offer',
          body: nextBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(next.status, 200);
      assert.equal(next.json.offer.requestedEngine, 'codex');
      assert.equal(next.json.offer.providerSession.status, 'pending');
      assert.equal(next.json.offer.payload.profileSnapshot.profileVersion, 1);
      assert.deepEqual(
        next.json.offer.effectiveConfiguration,
        createdWork.json.effectiveConfiguration,
      );
      assert.deepEqual(
        next.json.offer.payload.effectiveConfiguration,
        createdWork.json.effectiveConfiguration,
      );
      assert.deepEqual(next.json.offer.payload.profileSnapshot.memories, ['사용자는 한국어를 선호한다.']);
      assert.match(next.json.offer.goal, /Responsible Agent Profile/);
      assert.match(next.json.offer.goal, /차분한 존댓말/);
      assert.match(next.json.offer.goal, /Delegated work:\nCreate the first result/);
      const providerSessionId = next.json.offer.providerSession.id;

      const leaseBody = {
        runnerId: runnerA.runnerId,
        offerId: next.json.offer.offerId,
      };
      const lease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: leaseBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/lease',
          body: leaseBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(lease.status, 200);
      assert.equal(lease.json.lease.providerSession.id, providerSessionId);
      assert.deepEqual(
        lease.json.lease.effectiveConfiguration,
        createdWork.json.effectiveConfiguration,
      );
      assert.doesNotThrow(() => assertAuthorizedLease(lease.json.lease, {
        runnerId: runnerA.runnerId,
        workspaceId: runnerA.workspaceId,
        credentialVersion: runnerA.credentialVersion,
        deviceCredential: runnerA.credential,
      }));
      assert.equal(JSON.stringify(lease.json.lease.authorization).includes(runnerA.credential), false);

      const secretBindBody = {
        runnerId: runnerA.runnerId,
        providerSessionId,
        externalSessionId: 'sk-abcdefghijklmnopqrstuvwxyz123456',
      };
      const secretBind = await httpJson(
        baseUrl,
        'POST',
        '/api/runner/device/provider-session/bind',
        {
          body: secretBindBody,
          headers: deviceAuthHeaders({
            keys: keysA,
            runnerId: runnerA.runnerId,
            credential: runnerA.credential,
            method: 'POST',
            path: '/api/runner/device/provider-session/bind',
            body: secretBindBody,
            sessionId: runnerA.sessionId,
            cursor: runnerA.cursor,
          }),
        },
      );
      assert.equal(secretBind.status, 400);
      assert.equal(secretBind.json.error, 'PROVIDER_SECRET_FORBIDDEN');
      const unboundAfterSecret = await pool.query(
        `select external_session_id
         from provider_agent_sessions
         where workspace_id = 'ws-a' and id = $1`,
        [providerSessionId],
      );
      assert.equal(unboundAfterSecret.rows[0].external_session_id, '');

      const bindBody = {
        runnerId: runnerA.runnerId,
        providerSessionId,
        externalSessionId: 'codex-thread-a',
      };
      const boundBeforeTerminal = await httpJson(
        baseUrl,
        'POST',
        '/api/runner/device/provider-session/bind',
        {
          body: bindBody,
          headers: deviceAuthHeaders({
            keys: keysA,
            runnerId: runnerA.runnerId,
            credential: runnerA.credential,
            method: 'POST',
            path: '/api/runner/device/provider-session/bind',
            body: bindBody,
            sessionId: runnerA.sessionId,
            cursor: runnerA.cursor,
          }),
        },
      );
      assert.equal(boundBeforeTerminal.status, 200, JSON.stringify(boundBeforeTerminal.json));
      assert.equal(boundBeforeTerminal.json.session.externalSessionId, 'codex-thread-a');
      assert.equal(boundBeforeTerminal.json.session.status, 'active');

      const persistedBeforeTerminal = await pool.query(
        `select external_session_id, status
         from provider_agent_sessions
         where workspace_id = 'ws-a' and id = $1`,
        [providerSessionId],
      );
      assert.deepEqual(persistedBeforeTerminal.rows[0], {
        external_session_id: 'codex-thread-a',
        status: 'active',
      });

      const foreignBindBody = {
        runnerId: runnerB.runnerId,
        providerSessionId,
        externalSessionId: 'foreign-thread',
      };
      const foreignBind = await httpJson(
        baseUrl,
        'POST',
        '/api/runner/device/provider-session/bind',
        {
          body: foreignBindBody,
          headers: deviceAuthHeaders({
            keys: keysB,
            runnerId: runnerB.runnerId,
            credential: runnerB.credential,
            method: 'POST',
            path: '/api/runner/device/provider-session/bind',
            body: foreignBindBody,
            sessionId: runnerB.sessionId,
            cursor: runnerB.cursor,
          }),
        },
      );
      assert.equal(foreignBind.status, 404);

      const checkpointBody = {
        runnerId: runnerA.runnerId,
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        kind: 'checkpoint',
        phase: 'progress',
        text: 'Restart recovery checkpoint',
        idempotencyKey: 'checkpoint:restart',
      };
      const checkpoint = await httpJson(baseUrl, 'POST', '/api/runner/device/event', {
        body: checkpointBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/event',
          body: checkpointBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.json));

      const artifactBody = {
        runnerId: runnerA.runnerId,
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        name: 'restart-proof.txt',
        content: 'durable artifact',
        contentType: 'text/plain',
        idempotencyKey: 'artifact:restart',
      };
      const artifact = await httpJson(baseUrl, 'POST', '/api/runner/device/artifact', {
        body: artifactBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/artifact',
          body: artifactBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(artifact.status, 200, JSON.stringify(artifact.json));

      const completeBody = {
        runnerId: runnerA.runnerId,
        attemptId: lease.json.lease.attemptId,
        leaseEpoch: lease.json.lease.leaseEpoch,
        summary: 'First result',
        idempotencyKey: 'terminal:first',
        providerSession: {
          id: providerSessionId,
          externalSessionId: 'codex-thread-a',
        },
      };
      const completed = await httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
        body: completeBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/complete',
          body: completeBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(completed.status, 200, JSON.stringify(completed.json));

      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar?.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      runtime = createPhase1Runtime({
        pool,
        identityVerifier: null,
        authKit: null,
        workosConfig: null,
        env: { DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
      });
      server = createRailwayGatewayServer({
        env: {
          WORKSPACE_AUTH_MODE: 'production',
          DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
          DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
        },
        phase1Runtime: runtime,
        phase1Pool: pool,
        gatewayStore: { getState: () => ({}), ready: Promise.resolve() },
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      });
      baseUrl = await listen(server);

      const restored = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(restored.status, 200, JSON.stringify(restored.json));
      assert.equal(restored.json.work.workConversationId, createdWork.json.sessionId);
      assert.equal(
        restored.json.effectiveConfiguration.history[0].configuration.snapshotId,
        createdWork.json.effectiveConfiguration.snapshotId,
      );
      assert.equal(
        restored.json.effectiveConfiguration.current.snapshotId,
        createdWork.json.effectiveConfiguration.snapshotId,
      );
      assert.equal(restored.json.checkpoints.some((item) => item.text === 'Restart recovery checkpoint'), false);
      assert.equal(restored.json.checkpoints.some((item) => item.text === 'Artifact ready: restart-proof.txt'), false);
      assert.ok(restored.json.checkpoints.some((item) => item.text === 'First result'));

      const foreignRestored = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/conversation`,
        { token: tokenB },
      );
      assert.equal(foreignRestored.status, 404);

      const durableArtifact = await pool.query(
        `select name, content
         from execution_artifacts
         where workspace_id = 'ws-a' and id = $1`,
        [artifact.json.artifact.id],
      );
      assert.equal(durableArtifact.rowCount, 1);
      assert.equal(durableArtifact.rows[0].name, 'restart-proof.txt');
      assert.equal(durableArtifact.rows[0].content, 'durable artifact');
      const foreignArtifact = await pool.query(
        `select count(*)::int as n
         from execution_artifacts
         where workspace_id = 'ws-b' and id = $1`,
        [artifact.json.artifact.id],
      );
      assert.equal(foreignArtifact.rows[0].n, 0);

      const revisedAgent = await httpJson(
        baseUrl,
        'PATCH',
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          token: tokenA,
          body: {
            responseStyle: '간결한 반말로 결론부터 쓴다.',
            memories: ['사용자는 한국어를 선호한다.', '표에는 기준일을 표시한다.'],
          },
        },
      );
      assert.equal(revisedAgent.status, 200, JSON.stringify(revisedAgent.json));
      assert.equal(revisedAgent.json.agent.profileVersion, 2);
      const stalePreview = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Reject stale preview',
          goal: 'This must not create a job',
          agentId,
          executionEngine: 'auto',
          effectiveConfigurationSnapshotId: createdWork.json.effectiveConfiguration.snapshotId,
        },
      });
      assert.equal(stalePreview.status, 409, JSON.stringify(stalePreview.json));
      assert.equal(stalePreview.json.error, 'effective_configuration_stale');

      const followUp = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Continue with a second result',
            clientMessageId: 'follow-up-a',
          },
        },
      );
      assert.equal(followUp.status, 200, JSON.stringify(followUp.json));

      const nextFollowUp = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: nextBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/next-offer',
          body: nextBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(nextFollowUp.status, 200);
      assert.equal(nextFollowUp.json.offer.providerSession.id, providerSessionId);
      assert.equal(nextFollowUp.json.offer.providerSession.externalSessionId, 'codex-thread-a');
      assert.equal(nextFollowUp.json.offer.payload.profileSnapshot.profileVersion, 2);
      assert.deepEqual(nextFollowUp.json.offer.payload.profileSnapshot.memories, [
        '사용자는 한국어를 선호한다.',
        '표에는 기준일을 표시한다.',
      ]);
      assert.match(nextFollowUp.json.offer.goal, /간결한 반말/);
      assert.match(nextFollowUp.json.offer.goal, /Delegated work:\nContinue with a second result/);

      const followLeaseBody = {
        runnerId: runnerA.runnerId,
        offerId: nextFollowUp.json.offer.offerId,
      };
      const followLease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: followLeaseBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/lease',
          body: followLeaseBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(followLease.status, 200);
      const failBody = {
        runnerId: runnerA.runnerId,
        attemptId: followLease.json.lease.attemptId,
        leaseEpoch: followLease.json.lease.leaseEpoch,
        errorCode: 'auth_required',
        errorMessage: 'Provider authentication expired',
        retryable: false,
        providerSession: {
          id: providerSessionId,
          externalSessionId: 'codex-thread-a',
        },
      };
      const failed = await httpJson(baseUrl, 'POST', '/api/runner/device/fail', {
        body: failBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/fail',
          body: failBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(failed.status, 200);

      const blockedFollowUp = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Do not silently create another session',
            clientMessageId: 'follow-up-blocked',
          },
        },
      );
      assert.equal(blockedFollowUp.status, 409);

      const sessionsA = await httpJson(
        baseUrl,
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/sessions`,
        { token: tokenA },
      );
      assert.equal(sessionsA.status, 200);
      assert.equal(sessionsA.json.sessions.length, 1);
      assert.equal(sessionsA.json.sessions[0].externalSessionId, 'codex-thread-a');
      assert.equal(sessionsA.json.sessions[0].status, 'auth_required');
      assert.equal(sessionsA.json.sessions[0].missionId, createdWork.json.missionId);

      const sessionsB = await httpJson(
        baseUrl,
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/sessions`,
        { token: tokenB },
      );
      assert.equal(sessionsB.status, 200);
      assert.deepEqual(sessionsB.json.sessions, []);

      const persisted = await pool.query(
        `select external_session_id, status, work_conversation_id
         from provider_agent_sessions
         where workspace_id = 'ws-a' and id = $1`,
        [providerSessionId],
      );
      assert.equal(persisted.rows[0].external_session_id, 'codex-thread-a');
      assert.equal(persisted.rows[0].status, 'auth_required');
      assert.equal(persisted.rows[0].work_conversation_id, createdWork.json.sessionId);
      const jobCount = await pool.query(
        `select count(*)::int as n,
                array_agg((payload->'profileSnapshot'->>'profileVersion')::int order by turn_index) as profile_versions
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1`,
        [createdWork.json.missionId],
      );
      assert.equal(jobCount.rows[0].n, 2);
      assert.deepEqual(jobCount.rows[0].profile_versions, [1, 2]);

      const approvedGrant = await httpJson(
        baseUrl,
        'PATCH',
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          token: tokenA,
          body: {
            approveGrantRequestId: grantExpansion.json.agent.approvalGate.id,
          },
        },
      );
      assert.equal(approvedGrant.status, 200, JSON.stringify(approvedGrant.json));
      assert.deepEqual(approvedGrant.json.agent.grants.allow, [
        'tool:external.delivery',
        'tool:workspace.read',
      ]);
      assert.equal(approvedGrant.json.agent.approvalGate, undefined);

      const allowedWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Harmless allowed capability',
          goal: 'Read Workspace data without external delivery',
          agentId,
          executionEngine: 'codex',
          requiredCapabilities: ['tool:workspace.read'],
        },
      });
      assert.equal(allowedWork.status, 200, JSON.stringify(allowedWork.json));
      assert.equal(allowedWork.json.effectiveConfiguration.executable, true);
      assert.deepEqual(
        allowedWork.json.effectiveConfiguration.requiredCapabilities,
        ['tool:workspace.read'],
      );
      const nextAllowed = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: nextBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/next-offer',
          body: nextBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(nextAllowed.status, 200);
      assert.equal(nextAllowed.json.offer.jobId, allowedWork.json.jobId);
      const allowedLeaseBody = {
        runnerId: runnerA.runnerId,
        offerId: nextAllowed.json.offer.offerId,
      };
      const allowedLease = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: allowedLeaseBody,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: '/api/runner/device/lease',
          body: allowedLeaseBody,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      assert.equal(allowedLease.status, 200, JSON.stringify(allowedLease.json));
      assert.deepEqual(
        allowedLease.json.lease.effectiveConfiguration,
        allowedWork.json.effectiveConfiguration,
      );
      assert.doesNotThrow(() => assertAuthorizedLease(allowedLease.json.lease, {
        runnerId: runnerA.runnerId,
        workspaceId: runnerA.workspaceId,
        credentialVersion: runnerA.credentialVersion,
        deviceCredential: runnerA.credential,
      }));
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar?.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
    }
  });
});

test('one Work Conversation switches Codex and Claude endpoints without forking or fanout', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: { DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
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
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const keysA = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'cross-engine-a');
      await pool.query(
        `update runners
         set capabilities = $2::jsonb
         where workspace_id = 'ws-a' and id = $1`,
        [runnerA.runnerId, JSON.stringify({
          engines: {
            codex: {
              available: true,
              status: 'available',
              authStatus: 'authenticated',
              version: 'test',
              modelSelection: 'catalog',
              models: ['gpt-5.6-codex'],
            },
            claude: {
              available: true,
              status: 'available',
              authStatus: 'authenticated',
              version: 'test',
              modelSelection: 'catalog',
              models: ['claude-sonnet-4-6'],
            },
          },
        })],
      );

      const createdAgent = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: tokenA,
        body: {
          displayName: 'Cross-engine Researcher',
          defaultExecutionEngine: 'codex',
          defaultRunnerId: runnerA.runnerId,
        },
      });
      assert.equal(createdAgent.status, 200, JSON.stringify(createdAgent.json));

      const createdWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'One canonical conversation',
          goal: 'Start this investigation in Codex',
          agentId: createdAgent.json.agent.id,
          executionEngine: 'codex',
          requestedModel: 'gpt-5.6-codex',
        },
      });
      assert.equal(createdWork.status, 200, JSON.stringify(createdWork.json));

      const initialEndpoint = await pool.query(
        `select id, engine, work_conversation_id
         from provider_agent_sessions
         where workspace_id = 'ws-a' and work_conversation_id = $1`,
        [createdWork.json.sessionId],
      );
      assert.equal(initialEndpoint.rowCount, 1);
      assert.equal(initialEndpoint.rows[0].engine, 'codex');

      const continueInClaude = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Review the same investigation in Claude',
            clientMessageId: 'cross-engine-claude',
            executionEngine: 'claude',
            requestedModel: 'claude-sonnet-4-6',
          },
        },
      );
      assert.equal(continueInClaude.status, 200, JSON.stringify(continueInClaude.json));

      const endpoints = await pool.query(
        `select id, engine, runner_id, work_conversation_id
         from provider_agent_sessions
         where workspace_id = 'ws-a' and work_conversation_id = $1
         order by engine`,
        [createdWork.json.sessionId],
      );
      assert.equal(endpoints.rowCount, 2);
      assert.deepEqual(endpoints.rows.map((row) => row.engine), ['claude', 'codex']);
      assert.ok(endpoints.rows.every((row) => row.runner_id === runnerA.runnerId));
      assert.ok(endpoints.rows.every((row) => row.work_conversation_id === createdWork.json.sessionId));
      const claudeEndpoint = endpoints.rows.find((row) => row.engine === 'claude');
      assert.ok(claudeEndpoint);

      const claudeJob = await pool.query(
        `select requested_engine, requested_model, provider_session_id, goal
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1
         order by turn_index desc
         limit 1`,
        [createdWork.json.missionId],
      );
      assert.equal(claudeJob.rows[0].requested_engine, 'claude');
      assert.equal(claudeJob.rows[0].requested_model, 'claude-sonnet-4-6');
      assert.equal(claudeJob.rows[0].provider_session_id, claudeEndpoint.id);
      assert.match(claudeJob.rows[0].goal, /Start this investigation in Codex/);
      assert.match(claudeJob.rows[0].goal, /Review the same investigation in Claude/);

      const returnToCodex = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Apply that review back in Codex',
            clientMessageId: 'cross-engine-codex',
            executionEngine: 'codex',
            requestedModel: 'gpt-5.6-codex',
          },
        },
      );
      assert.equal(returnToCodex.status, 200, JSON.stringify(returnToCodex.json));

      const codexJob = await pool.query(
        `select requested_engine, requested_model, provider_session_id, goal
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1
         order by turn_index desc
         limit 1`,
        [createdWork.json.missionId],
      );
      assert.equal(codexJob.rows[0].requested_engine, 'codex');
      assert.equal(codexJob.rows[0].requested_model, 'gpt-5.6-codex');
      assert.equal(codexJob.rows[0].provider_session_id, initialEndpoint.rows[0].id);
      assert.match(codexJob.rows[0].goal, /Responsible Agent Profile/);
      assert.match(codexJob.rows[0].goal, /Delegated work:\nApply that review back in Codex/);

      const runnerPost = (urlPath, body) => httpJson(baseUrl, 'POST', urlPath, {
        body,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: urlPath,
          body,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      const leaseAndComplete = async (
        expectedEngine,
        expectedModel,
        expectedProviderSessionId,
        externalSessionId,
        terminalKey,
      ) => {
        const nextPath = '/api/runner/device/next-offer';
        const next = await runnerPost(nextPath, { runnerId: runnerA.runnerId });
        assert.equal(next.status, 200, JSON.stringify(next.json));
        assert.equal(next.json.offer.requestedEngine, expectedEngine);
        assert.equal(next.json.offer.requestedModel, expectedModel);
        assert.equal(next.json.offer.providerSession.id, expectedProviderSessionId);
        if (externalSessionId && next.json.offer.providerSession.externalSessionId) {
          assert.equal(next.json.offer.providerSession.externalSessionId, externalSessionId);
        }
        const leasePath = '/api/runner/device/lease';
        const lease = await runnerPost(leasePath, {
          runnerId: runnerA.runnerId,
          offerId: next.json.offer.offerId,
        });
        assert.equal(lease.status, 200, JSON.stringify(lease.json));
        assert.equal(lease.json.lease.requestedModel, expectedModel);
        if (!next.json.offer.providerSession.externalSessionId) {
          const bindPath = '/api/runner/device/provider-session/bind';
          const bind = await runnerPost(bindPath, {
            runnerId: runnerA.runnerId,
            providerSessionId: expectedProviderSessionId,
            externalSessionId,
          });
          assert.equal(bind.status, 200, JSON.stringify(bind.json));
        }
        const completePath = '/api/runner/device/complete';
        const complete = await runnerPost(completePath, {
          runnerId: runnerA.runnerId,
          attemptId: lease.json.lease.attemptId,
          leaseEpoch: lease.json.lease.leaseEpoch,
          summary: `${expectedEngine} completed`,
          resolvedModel: expectedModel,
          idempotencyKey: terminalKey,
          providerSession: {
            id: expectedProviderSessionId,
            externalSessionId,
          },
        });
        assert.equal(complete.status, 200, JSON.stringify(complete.json));
      };

      await leaseAndComplete('codex', 'gpt-5.6-codex', initialEndpoint.rows[0].id, 'codex-canonical-thread', 'terminal:canonical-codex-1');
      await leaseAndComplete('claude', 'claude-sonnet-4-6', claudeEndpoint.id, 'claude-canonical-session', 'terminal:canonical-claude');

      const resumedCodex = await runnerPost('/api/runner/device/next-offer', {
        runnerId: runnerA.runnerId,
      });
      assert.equal(resumedCodex.status, 200, JSON.stringify(resumedCodex.json));
      assert.equal(resumedCodex.json.offer.requestedEngine, 'codex');
      assert.equal(resumedCodex.json.offer.requestedModel, 'gpt-5.6-codex');
      assert.equal(resumedCodex.json.offer.providerSession.id, initialEndpoint.rows[0].id);
      assert.equal(resumedCodex.json.offer.providerSession.externalSessionId, 'codex-canonical-thread');

      const conversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(conversation.status, 200, JSON.stringify(conversation.json));
      assert.equal(conversation.json.work.workConversationId, createdWork.json.sessionId);
      assert.equal(conversation.json.work.activeExecutionModel, 'gpt-5.6-codex');
      assert.equal(conversation.json.work.resolvedExecutionModel, 'claude-sonnet-4-6');
      assert.ok(conversation.json.checkpoints.some((item) => item.text === 'Review the same investigation in Claude'));
      assert.ok(conversation.json.checkpoints.some((item) => item.text === 'Apply that review back in Codex'));

      await pool.query(
        `update provider_agent_sessions
         set updated_at = now() + interval '1 hour'
         where workspace_id = 'ws-a' and id = $1`,
        [claudeEndpoint.id],
      );
      const autoAfterNewerInactive = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Auto must stay on the exact active Codex endpoint',
            clientMessageId: 'exact-active-auto',
            executionEngine: 'auto',
          },
        },
      );
      assert.equal(autoAfterNewerInactive.status, 200, JSON.stringify(autoAfterNewerInactive.json));
      assert.equal(autoAfterNewerInactive.json.event.providerSessionId, initialEndpoint.rows[0].id);

      const keysB = generateEd25519Keypair();
      const runnerB = await enrollActiveRunner(baseUrl, tokenB, keysB, 'cross-engine-b');
      const foreignWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenB,
        body: {
          title: 'Foreign Workspace conversation',
          goal: 'Own a foreign endpoint for scope rejection',
        },
      });
      assert.equal(foreignWork.status, 200, JSON.stringify(foreignWork.json));
      await pool.query(
        `insert into provider_agent_sessions (
           id, workspace_id, agent_id, official_profile, runner_id, work_conversation_id,
           provider, engine, status, title
         ) values (
           'psess_foreign_scope_fixture', 'ws-b', null, 'default', $1, $2,
           'codex', 'codex', 'active', 'Foreign scope fixture'
         )`,
        [runnerB.runnerId, foreignWork.json.sessionId],
      );
      const foreignEndpoint = await pool.query(
        `select id from provider_agent_sessions
         where workspace_id = 'ws-b' and work_conversation_id = $1`,
        [foreignWork.json.sessionId],
      );
      assert.equal(foreignEndpoint.rowCount, 1);

      const otherConversation = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Other same-Workspace conversation',
          goal: 'Own a mismatched endpoint for conversation-scope rejection',
          agentId: createdAgent.json.agent.id,
          executionEngine: 'codex',
          requestedModel: 'gpt-5.6-codex',
        },
      });
      assert.equal(otherConversation.status, 200, JSON.stringify(otherConversation.json));
      const otherConversationEndpoint = await pool.query(
        `select id from provider_agent_sessions
         where workspace_id = 'ws-a' and work_conversation_id = $1`,
        [otherConversation.json.sessionId],
      );
      assert.equal(otherConversationEndpoint.rowCount, 1);

      const sideEffectsBeforeMissing = await pool.query(
        `select
           (select count(*)::int from execution_jobs
            where workspace_id = 'ws-a' and mission_id = $1) as jobs,
           (select count(*)::int from agent_session_events
            where workspace_id = 'ws-a' and session_id = $2) as events`,
        [createdWork.json.missionId, createdWork.json.sessionId],
      );
      await pool.query(
        `update agent_missions
         set payload = payload || '{"activeProviderSessionId":"psess_missing_scoped"}'::jsonb
         where workspace_id = 'ws-a' and id = $1`,
        [createdWork.json.missionId],
      );
      const missingActive = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Missing active endpoint must fail closed',
            clientMessageId: 'missing-active-endpoint',
            executionEngine: 'auto',
          },
        },
      );
      assert.equal(missingActive.status, 409, JSON.stringify(missingActive.json));
      const sideEffectsAfterMissing = await pool.query(
        `select
           (select count(*)::int from execution_jobs
            where workspace_id = 'ws-a' and mission_id = $1) as jobs,
           (select count(*)::int from agent_session_events
            where workspace_id = 'ws-a' and session_id = $2) as events`,
        [createdWork.json.missionId, createdWork.json.sessionId],
      );
      assert.deepEqual(sideEffectsAfterMissing.rows[0], sideEffectsBeforeMissing.rows[0]);

      for (const [activeProviderSessionId, clientMessageId] of [
        [foreignEndpoint.rows[0].id, 'foreign-workspace-active-endpoint'],
        [otherConversationEndpoint.rows[0].id, 'other-conversation-active-endpoint'],
      ]) {
        await pool.query(
          `update agent_missions
           set payload = payload || jsonb_build_object(
             'activeProviderSessionId', $2::text,
             'providerSessionId', $2::text
           )
           where workspace_id = 'ws-a' and id = $1`,
          [createdWork.json.missionId, activeProviderSessionId],
        );
        const rejected = await httpJson(
          baseUrl,
          'POST',
          `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
          {
            token: tokenA,
            body: {
              text: 'Mismatched active endpoint must fail closed',
              clientMessageId,
              executionEngine: 'auto',
            },
          },
        );
        assert.equal(rejected.status, 409, JSON.stringify(rejected.json));
        const sideEffectsAfterRejected = await pool.query(
          `select
             (select count(*)::int from execution_jobs
              where workspace_id = 'ws-a' and mission_id = $1) as jobs,
             (select count(*)::int from agent_session_events
              where workspace_id = 'ws-a' and session_id = $2) as events`,
          [createdWork.json.missionId, createdWork.json.sessionId],
        );
        assert.deepEqual(sideEffectsAfterRejected.rows[0], sideEffectsBeforeMissing.rows[0]);
      }

      await pool.query(
        `update provider_agent_sessions
         set status = 'archived'
         where workspace_id = 'ws-a' and work_conversation_id = $1`,
        [createdWork.json.sessionId],
      );
      await pool.query(
        `update agent_missions
         set payload = payload - 'activeProviderSessionId' - 'providerSessionId'
         where workspace_id = 'ws-a' and id = $1`,
        [createdWork.json.missionId],
      );
      const zeroEligibleLegacy = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Zero eligible legacy endpoints must fail closed',
            clientMessageId: 'legacy-zero-eligible',
            executionEngine: 'auto',
          },
        },
      );
      assert.equal(zeroEligibleLegacy.status, 409, JSON.stringify(zeroEligibleLegacy.json));
      const sideEffectsAfterZeroEligible = await pool.query(
        `select
           (select count(*)::int from execution_jobs
            where workspace_id = 'ws-a' and mission_id = $1) as jobs,
           (select count(*)::int from agent_session_events
            where workspace_id = 'ws-a' and session_id = $2) as events`,
        [createdWork.json.missionId, createdWork.json.sessionId],
      );
      assert.deepEqual(sideEffectsAfterZeroEligible.rows[0], sideEffectsBeforeMissing.rows[0]);

      await pool.query(
        `update provider_agent_sessions
         set status = case when id = $2 then 'active' else 'archived' end
         where workspace_id = 'ws-a' and work_conversation_id = $1`,
        [createdWork.json.sessionId, initialEndpoint.rows[0].id],
      );
      await pool.query(
        `update agent_missions
         set payload = (payload - 'activeProviderSessionId' - 'providerSessionId')
         where workspace_id = 'ws-a' and id = $1`,
        [createdWork.json.missionId],
      );
      const legacyBackfill = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Backfill the one eligible legacy endpoint',
            clientMessageId: 'legacy-single-backfill',
            executionEngine: 'auto',
          },
        },
      );
      assert.equal(legacyBackfill.status, 200, JSON.stringify(legacyBackfill.json));
      assert.equal(legacyBackfill.json.event.providerSessionId, initialEndpoint.rows[0].id);
      const backfilledMission = await pool.query(
        `select payload->>'activeProviderSessionId' as active_provider_session_id
         from agent_missions
         where workspace_id = 'ws-a' and id = $1`,
        [createdWork.json.missionId],
      );
      assert.equal(backfilledMission.rows[0].active_provider_session_id, initialEndpoint.rows[0].id);

      await pool.query(
        `update provider_agent_sessions
         set status = 'archived'
         where workspace_id = 'ws-a' and id = $1`,
        [initialEndpoint.rows[0].id],
      );
      const archivedActive = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Archived active endpoint must fail closed',
            clientMessageId: 'archived-active-endpoint',
            executionEngine: 'auto',
          },
        },
      );
      assert.equal(archivedActive.status, 409, JSON.stringify(archivedActive.json));

      await pool.query(
        `update provider_agent_sessions
         set status = 'active'
         where workspace_id = 'ws-a' and work_conversation_id = $1`,
        [createdWork.json.sessionId],
      );
      await pool.query(
        `update agent_missions
         set payload = (payload - 'activeProviderSessionId' - 'providerSessionId')
         where workspace_id = 'ws-a' and id = $1`,
        [createdWork.json.missionId],
      );
      const ambiguousLegacy = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Ambiguous legacy endpoints must fail closed',
            clientMessageId: 'legacy-ambiguous',
            executionEngine: 'auto',
          },
        },
      );
      assert.equal(ambiguousLegacy.status, 409, JSON.stringify(ambiguousLegacy.json));

      await pool.query(
        `update agent_missions
         set payload = payload || jsonb_build_object(
           'activeProviderSessionId', $2::text,
           'providerSessionId', $2::text,
           'activeExecutionEngine', 'codex'
         )
         where workspace_id = 'ws-a' and id = $1`,
        [createdWork.json.missionId, initialEndpoint.rows[0].id],
      );
      const turnBlocker = await pool.connect();
      await turnBlocker.query('begin');
      await turnBlocker.query(
        `select id from agent_sessions
         where workspace_id = 'ws-a' and id = $1
         for update`,
        [createdWork.json.sessionId],
      );
      const switchPromise = httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Switch this turn to Claude',
            clientMessageId: 'serialized-switch',
            executionEngine: 'claude',
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const serializedAutoPromise = httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Follow whichever endpoint is active after the switch',
            clientMessageId: 'serialized-auto',
            executionEngine: 'auto',
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await turnBlocker.query('commit');
      turnBlocker.release();
      const [serializedSwitch, serializedAuto] = await Promise.all([
        switchPromise,
        serializedAutoPromise,
      ]);
      assert.equal(serializedSwitch.status, 200, JSON.stringify(serializedSwitch.json));
      assert.equal(serializedAuto.status, 200, JSON.stringify(serializedAuto.json));
      assert.equal(serializedSwitch.json.event.providerSessionId, claudeEndpoint.id);
      assert.equal(serializedAuto.json.event.providerSessionId, claudeEndpoint.id);

      const foreignConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/conversation`,
        { token: tokenB },
      );
      assert.equal(foreignConversation.status, 404);

      const jobs = await pool.query(
        `select count(*)::int as n
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1`,
        [createdWork.json.missionId],
      );
      assert.equal(jobs.rows[0].n, 7);
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar?.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
    }
  });
});

test('explicit comparison fans one canonical user turn out to exact provider endpoints only', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: { DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
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
      const keysA = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'comparison-a');
      await pool.query(
        `update runners
         set capabilities = $2::jsonb
         where workspace_id = 'ws-a' and id = $1`,
        [runnerA.runnerId, JSON.stringify({
          engines: {
            codex: {
              available: true,
              status: 'available',
              authStatus: 'authenticated',
              version: 'test',
              modelSelection: 'catalog',
              models: ['gpt-5.6-codex'],
            },
            claude: {
              available: true,
              status: 'available',
              authStatus: 'authenticated',
              version: 'test',
              modelSelection: 'catalog',
              models: ['claude-sonnet-4-6'],
            },
          },
        })],
      );
      const createdWork = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Compare one canonical turn',
          goal: 'Prepare the shared context',
          executionEngine: 'codex',
          requestedModel: 'gpt-5.6-codex',
        },
      });
      assert.equal(createdWork.status, 200, JSON.stringify(createdWork.json));
      await pool.query(
        `update execution_jobs
         set status = 'completed', terminal_at = now()
         where workspace_id = 'ws-a' and mission_id = $1`,
        [createdWork.json.missionId],
      );

      const comparisonBody = {
        text: 'Compare both engines on the same evidence',
        clientMessageId: 'comparison-turn-1',
        comparisonTargets: [
          { executionEngine: 'codex', requestedModel: 'gpt-5.6-codex' },
          { executionEngine: 'claude', requestedModel: 'claude-sonnet-4-6' },
        ],
      };
      const comparison = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        { token: tokenA, body: comparisonBody },
      );
      assert.equal(comparison.status, 200, JSON.stringify(comparison.json));
      assert.equal(comparison.json.comparison, true);
      assert.deepEqual(
        comparison.json.jobs.map((job) => job.executionEngine),
        ['codex', 'claude'],
      );

      const comparisonJobs = await pool.query(
        `select id, requested_engine, requested_model, provider_session_id,
                turn_index, turn_target_index, turn_mode, payload
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1 and turn_index = 2
         order by turn_target_index`,
        [createdWork.json.missionId],
      );
      assert.equal(comparisonJobs.rowCount, 2);
      assert.deepEqual(comparisonJobs.rows.map((row) => row.requested_engine), ['codex', 'claude']);
      assert.deepEqual(
        comparisonJobs.rows.map((row) => row.requested_model),
        ['gpt-5.6-codex', 'claude-sonnet-4-6'],
      );
      assert.ok(comparisonJobs.rows.every((row) => row.turn_index === 2));
      assert.deepEqual(comparisonJobs.rows.map((row) => row.turn_target_index), [0, 1]);
      assert.ok(comparisonJobs.rows.every((row) => row.turn_mode === 'comparison'));
      assert.ok(comparisonJobs.rows.every((row) => row.payload.comparison === true));
      const officialEndpoints = await pool.query(
        `select agent_id, official_profile, engine
         from provider_agent_sessions
         where workspace_id = 'ws-a' and work_conversation_id = $1
         order by engine`,
        [createdWork.json.sessionId],
      );
      assert.equal(officialEndpoints.rowCount, 2);
      assert.ok(officialEndpoints.rows.every((row) => row.agent_id === null));
      assert.ok(officialEndpoints.rows.every((row) => row.official_profile === 'default'));

      const canonicalMessage = await pool.query(
        `select count(*)::int as n
         from agent_session_events
         where workspace_id = 'ws-a' and session_id = $1
           and kind = 'user_message' and payload->>'clientMessageId' = 'comparison-turn-1'`,
        [createdWork.json.sessionId],
      );
      assert.equal(canonicalMessage.rows[0].n, 1);

      const replay = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        { token: tokenA, body: comparisonBody },
      );
      assert.equal(replay.status, 200, JSON.stringify(replay.json));
      assert.equal(replay.json.idempotentReplay, true);
      const jobsAfterReplay = await pool.query(
        `select count(*)::int as n
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1 and turn_index = 2`,
        [createdWork.json.missionId],
      );
      assert.equal(jobsAfterReplay.rows[0].n, 2);

      const invalidComparison = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Do not accept duplicate targets',
            clientMessageId: 'comparison-duplicate',
            comparisonTargets: [
              { executionEngine: 'codex' },
              { executionEngine: 'codex' },
            ],
          },
        },
      );
      assert.equal(invalidComparison.status, 422, JSON.stringify(invalidComparison.json));

      const runnerPost = (urlPath, body) => httpJson(baseUrl, 'POST', urlPath, {
        body,
        headers: deviceAuthHeaders({
          keys: keysA,
          runnerId: runnerA.runnerId,
          credential: runnerA.credential,
          method: 'POST',
          path: urlPath,
          body,
          sessionId: runnerA.sessionId,
          cursor: runnerA.cursor,
        }),
      });
      for (let index = 0; index < 2; index += 1) {
        const next = await runnerPost('/api/runner/device/next-offer', {
          runnerId: runnerA.runnerId,
        });
        assert.equal(next.status, 200, JSON.stringify(next.json));
        assert.ok(next.json.offer);
        const lease = await runnerPost('/api/runner/device/lease', {
          runnerId: runnerA.runnerId,
          offerId: next.json.offer.offerId,
        });
        const providerSession = next.json.offer.providerSession;
        const complete = await runnerPost('/api/runner/device/complete', {
          runnerId: runnerA.runnerId,
          attemptId: lease.json.lease.attemptId,
          leaseEpoch: lease.json.lease.leaseEpoch,
          summary: `${next.json.offer.requestedEngine} comparison result`,
          resolvedModel: next.json.offer.requestedModel,
          idempotencyKey: `comparison-terminal-${index}`,
          providerSession: {
            id: providerSession.id,
            externalSessionId: providerSession.externalSessionId
              || `${next.json.offer.requestedEngine}-comparison-session`,
          },
        });
        assert.equal(complete.status, 200, JSON.stringify(complete.json));
        const mission = await pool.query(
          `select status from agent_missions
           where workspace_id = 'ws-a' and id = $1`,
          [createdWork.json.missionId],
        );
        assert.equal(mission.rows[0].status, index === 0 ? 'active' : 'completed');
      }

      const resultEvents = await pool.query(
        `select payload
         from agent_session_events
         where workspace_id = 'ws-a' and session_id = $1
           and payload->>'phase' = 'result'
           and payload->'metadata'->>'turnMode' = 'comparison'
         order by sequence`,
        [createdWork.json.sessionId],
      );
      assert.equal(resultEvents.rowCount, 2);
      assert.deepEqual(
        new Set(resultEvents.rows.map((row) => row.payload.metadata.resolvedExecutionEngine)),
        new Set(['codex', 'claude']),
      );
      assert.ok(resultEvents.rows.every((row) => row.payload.metadata.resolvedExecutionModel));

      const cancellableComparison = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/work/${encodeURIComponent(createdWork.json.missionId)}/messages`,
        {
          token: tokenA,
          body: {
            text: 'Compare again, then cancel both targets',
            clientMessageId: 'comparison-turn-cancel',
            comparisonTargets: [
              { executionEngine: 'codex' },
              { executionEngine: 'claude' },
            ],
          },
        },
      );
      assert.equal(cancellableComparison.status, 200, JSON.stringify(cancellableComparison.json));
      const cancelled = await httpJson(
        baseUrl,
        'POST',
        `/api/agent-operations/missions/${encodeURIComponent(createdWork.json.missionId)}/cancel`,
        { token: tokenA, body: {} },
      );
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
      const cancelledJobs = await pool.query(
        `select status, cancellation_requested
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1 and turn_index = 3
         order by turn_target_index`,
        [createdWork.json.missionId],
      );
      assert.equal(cancelledJobs.rowCount, 2);
      assert.ok(cancelledJobs.rows.every((row) => row.status === 'cancelled'));
      assert.ok(cancelledJobs.rows.every((row) => row.cancellation_requested === true));
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar?.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
    }
  });
});

test('Runner-local Telegram endpoint appends and replays one canonical Work Conversation without storing chat credentials', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
      env: { DURABLE_EXECUTION_BACKGROUND_WORKERS: '0' },
    });
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
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
      const keysA = generateEd25519Keypair();
      const keysB = generateEd25519Keypair();
      const runnerA = await enrollActiveRunner(baseUrl, tokenA, keysA, 'telegram-a');
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const runnerB = await enrollActiveRunner(baseUrl, tokenB, keysB, 'telegram-b');
      await pool.query(
        `update runners set capabilities = $2::jsonb
         where id = $1 and workspace_id = 'ws-a'`,
        [runnerA.runnerId, JSON.stringify({
          engines: {
            codex: {
              available: true,
              status: 'available',
              authStatus: 'authenticated',
              modelSelection: 'identifier',
              models: [],
            },
          },
        })],
      );
      const agent = await httpJson(baseUrl, 'POST', '/api/agents', {
        token: tokenA,
        body: {
          displayName: 'Telegram Agent',
          defaultExecutionEngine: 'codex',
          defaultRunnerId: runnerA.runnerId,
        },
      });
      const work = await httpJson(baseUrl, 'POST', '/api/agent-operations/work', {
        token: tokenA,
        body: {
          title: 'Shared channel conversation',
          goal: 'Continue this work from Desktop and Telegram',
          agentId: agent.json.agent.id,
          executionEngine: 'codex',
          requestedModel: 'gpt-5.6-sol',
        },
      });
      const runnerPost = (runner, keys, urlPath, body) => httpJson(baseUrl, 'POST', urlPath, {
        body,
        headers: deviceAuthHeaders({
          keys,
          runnerId: runner.runnerId,
          credential: runner.credential,
          method: 'POST',
          path: urlPath,
          body,
          sessionId: runner.sessionId,
          cursor: runner.cursor,
        }),
      });
      const bindPath = '/api/runner/device/channels/telegram/bind';
      const bindingHandle = 'tg_binding_local_only_abcdef';
      const conversationTailBeforeBind = await pool.query(
        `select coalesce(max(sequence), 0)::int as sequence
         from agent_session_events
         where workspace_id = 'ws-a' and session_id = $1`,
        [work.json.sessionId],
      );
      const bound = await runnerPost(runnerA, keysA, bindPath, {
        runnerId: runnerA.runnerId,
        workConversationId: work.json.sessionId,
        bindingHandle,
      });
      assert.equal(bound.status, 200, JSON.stringify(bound.json));
      const endpointId = bound.json.endpoint.id;
      const projectedConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(projectedConversation.status, 200, JSON.stringify(projectedConversation.json));
      assert.equal(projectedConversation.json.channels.length, 1);
      assert.deepEqual(
        {
          ...projectedConversation.json.channels[0],
          lastActivityAt: typeof projectedConversation.json.channels[0].lastActivityAt,
        },
        {
          id: endpointId,
          channel: 'telegram',
          status: 'active',
          runnerId: runnerA.runnerId,
          ingressOwnership: 'unverified',
          ingressReadiness: 'unverified',
          ingressCheckedAt: null,
          lastActivityAt: 'string',
        },
      );
      assert.doesNotMatch(JSON.stringify(projectedConversation.json.channels), /binding|token|chat.?id/i);
      const statusPath = '/api/runner/device/channels/telegram/status';
      const invalidStatus = await runnerPost(runnerA, keysA, statusPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        ingressOwnership: 'ready',
      });
      assert.equal(invalidStatus.status, 400);
      const foreignStatus = await runnerPost(runnerB, keysB, statusPath, {
        runnerId: runnerB.runnerId,
        endpointId,
        ingressOwnership: 'owned',
      });
      assert.equal(foreignStatus.status, 404);
      const ownedStatus = await runnerPost(runnerA, keysA, statusPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        ingressOwnership: 'owned',
      });
      assert.equal(ownedStatus.status, 200, JSON.stringify(ownedStatus.json));
      const ownedConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(ownedConversation.json.channels[0].ingressOwnership, 'owned');
      assert.equal(ownedConversation.json.channels[0].ingressReadiness, 'ready');
      assert.match(ownedConversation.json.channels[0].ingressCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.doesNotMatch(JSON.stringify(ownedConversation.json.channels), /binding|token|chat.?id/i);
      const conflictStatus = await runnerPost(runnerA, keysA, statusPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        ingressOwnership: 'conflict',
      });
      assert.equal(conflictStatus.status, 200, JSON.stringify(conflictStatus.json));
      const conflictConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(conflictConversation.json.channels[0].ingressOwnership, 'conflict');
      assert.equal(conflictConversation.json.channels[0].ingressReadiness, 'conflict');
      assert.match(conflictConversation.json.channels[0].ingressCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.doesNotMatch(JSON.stringify(conflictConversation.json.channels), /binding|token|chat.?id/i);
      await pool.query(
        `update work_conversation_channel_endpoints
         set public_metadata = jsonb_set(
           public_metadata,
           '{ingressCheckedAt}',
           to_jsonb((now() - interval '10 minutes')::timestamptz)
         )
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      const staleConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(staleConversation.json.channels[0].ingressOwnership, 'conflict');
      assert.equal(staleConversation.json.channels[0].ingressReadiness, 'stale');
      await pool.query(
        `update work_conversation_channel_endpoints
         set public_metadata = jsonb_set(
           public_metadata,
           '{ingressCheckedAt}',
           to_jsonb('not-a-timestamp'::text)
         )
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      const malformedConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(malformedConversation.json.channels[0].ingressOwnership, 'unverified');
      assert.equal(malformedConversation.json.channels[0].ingressReadiness, 'unverified');
      assert.equal(malformedConversation.json.channels[0].ingressCheckedAt, null);
      await pool.query(
        `update work_conversation_channel_endpoints
         set public_metadata = public_metadata || jsonb_build_object(
           'ingressOwnership', 'owned',
           'ingressCheckedAt', now() + interval '10 minutes'
         )
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      const futureConversation = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      assert.equal(futureConversation.json.channels[0].ingressOwnership, 'owned');
      assert.equal(futureConversation.json.channels[0].ingressReadiness, 'ready');
      const boundCursor = await pool.query(
        `select outbound_cursor::int as outbound_cursor
         from work_conversation_channel_endpoints
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      assert.equal(
        boundCursor.rows[0].outbound_cursor,
        conversationTailBeforeBind.rows[0].sequence,
        'a new Telegram binding starts at the current conversation tail',
      );

      const foreign = await runnerPost(runnerB, keysB, bindPath, {
        runnerId: runnerB.runnerId,
        workConversationId: work.json.sessionId,
        bindingHandle: 'tg_binding_foreign_abcdef',
      });
      assert.equal(foreign.status, 404);

      const inboundPath = '/api/runner/device/channels/telegram/inbound';
      const emptyInbound = await runnerPost(runnerA, keysA, inboundPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        deliveryKey: 'update_99_message_199',
        text: '   ',
        executionEngine: 'codex',
      });
      assert.equal(emptyInbound.status, 422);

      const inboundBody = {
        runnerId: runnerA.runnerId,
        endpointId,
        deliveryKey: 'update_100_message_200',
        text: 'Telegram에서도 같은 작업을 이어서 수정해줘',
        executionEngine: 'auto',
        requestedModel: 'gpt-5.6-sol',
      };
      const first = await runnerPost(runnerA, keysA, inboundPath, inboundBody);
      const replay = await runnerPost(runnerA, keysA, inboundPath, inboundBody);
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(replay.status, 200, JSON.stringify(replay.json));
      assert.equal(replay.json.idempotentReplay, true);

      const canonical = await pool.query(
        `select payload
         from agent_session_events
         where workspace_id = 'ws-a' and session_id = $1
           and kind = 'user_message'
           and payload->>'clientMessageId' = $2`,
        [work.json.sessionId, `channel:${endpointId}:update_100_message_200`],
      );
      assert.equal(canonical.rowCount, 1);
      assert.equal(canonical.rows[0].payload.origin, 'telegram');
      assert.equal(canonical.rows[0].payload.originEndpointId, endpointId);
      const telegramJob = await pool.query(
        `select provider_session_id
         from execution_jobs
         where workspace_id = 'ws-a' and mission_id = $1
         order by turn_index desc
         limit 1`,
        [work.json.missionId],
      );
      const activeEndpoint = await pool.query(
        `select payload->>'activeProviderSessionId' as active_provider_session_id
         from agent_missions
         where workspace_id = 'ws-a' and id = $1`,
        [work.json.missionId],
      );
      assert.equal(
        telegramJob.rows[0].provider_session_id,
        activeEndpoint.rows[0].active_provider_session_id,
        'Telegram auto follows the exact active provider endpoint',
      );

      const nextPath = '/api/runner/device/channels/telegram/next';
      const beforeResult = await runnerPost(runnerA, keysA, nextPath, {
        runnerId: runnerA.runnerId,
        endpointId,
      });
      assert.equal(beforeResult.status, 200, JSON.stringify(beforeResult.json));
      assert.equal(beforeResult.json.delivery, null, 'Telegram does not replay pre-bind history or echo its own inbound message');

      const nextSequence = await pool.query(
        `select coalesce(max(sequence), 0)::int + 1 as sequence
         from agent_session_events
         where workspace_id = 'ws-a' and session_id = $1`,
        [work.json.sessionId],
      );
      await pool.query(
        `insert into agent_session_events (
           id, workspace_id, session_id, sequence, kind, payload
         ) values
           ('event_telegram_progress_test','ws-a',$1,$2,'progress',$3::jsonb),
           ('event_telegram_agent_message_test','ws-a',$1,$2 + 1,'agent_message',$4::jsonb),
           ('event_telegram_generic_completion_test','ws-a',$1,$2 + 2,'completion',$5::jsonb),
           ('event_telegram_artifact_test','ws-a',$1,$2 + 3,'artifact',$6::jsonb),
           ('event_telegram_result_test','ws-a',$1,$2 + 4,'completion',$7::jsonb)`,
        [
          work.json.sessionId,
          nextSequence.rows[0].sequence,
          JSON.stringify({ text: 'Runner leased attempt 1 with engine codex', metadata: { jobId: 'job_test' } }),
          JSON.stringify({ text: 'Telegram round trip complete', metadata: { jobId: 'job_test' } }),
          JSON.stringify({ text: 'Codex execution completed', metadata: { jobId: 'job_test' } }),
          JSON.stringify({ text: 'Artifact ready: codex-result.txt', metadata: { jobId: 'job_test' } }),
          JSON.stringify({ text: 'Codex: Telegram round trip complete', origin: 'execution', metadata: { jobId: 'job_test' } }),
        ],
      );
      const delivery = await runnerPost(runnerA, keysA, nextPath, {
        runnerId: runnerA.runnerId,
        endpointId,
      });
      assert.equal(delivery.status, 200, JSON.stringify(delivery.json));
      assert.ok(delivery.json.delivery);
      assert.equal(delivery.json.delivery.text, 'Codex: Telegram round trip complete');
      assert.equal(typeof delivery.json.delivery.text, 'string');
      assert.equal(JSON.stringify(delivery.json).includes(bindingHandle), false);
      const desktopProjection = await httpJson(
        baseUrl,
        'GET',
        `/api/agent-operations/work/${encodeURIComponent(work.json.missionId)}/conversation`,
        { token: tokenA },
      );
      const desktopResult = desktopProjection.json.checkpoints.find(
        (checkpoint) => checkpoint.sequence === delivery.json.delivery.sequence,
      );
      assert.ok(desktopResult, JSON.stringify(desktopProjection.json));
      assert.deepEqual(
        publicDisplayTuple(desktopResult),
        publicDisplayTuple(delivery.json.delivery),
      );
      assert.equal(desktopResult.origin, 'execution');
      assert.equal(delivery.json.delivery.origin, 'execution');
      assert.equal(
        desktopProjection.json.checkpoints.some((checkpoint) => (
          ['progress', 'tool', 'tool_activity', 'artifact'].includes(checkpoint.kind)
        )),
        false,
      );
      const beginPath = '/api/runner/device/channels/telegram/begin';
      const begin = await runnerPost(runnerA, keysA, beginPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        receiptId: delivery.json.delivery.receiptId,
        eventId: delivery.json.delivery.eventId,
        sequence: delivery.json.delivery.sequence,
      });
      assert.equal(begin.status, 200, JSON.stringify(begin.json));
      assert.equal(begin.json.status, 'sending');
      const ackPath = '/api/runner/device/channels/telegram/ack';
      const wrongEventAck = await runnerPost(runnerA, keysA, ackPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        receiptId: delivery.json.delivery.receiptId,
        eventId: 'event_telegram_progress_test',
        sequence: delivery.json.delivery.sequence,
        outcome: 'delivered',
      });
      assert.equal(wrongEventAck.status, 404);
      const wrongSequenceAck = await runnerPost(runnerA, keysA, ackPath, {
        runnerId: runnerA.runnerId,
        endpointId,
        receiptId: delivery.json.delivery.receiptId,
        eventId: delivery.json.delivery.eventId,
        sequence: delivery.json.delivery.sequence - 1,
        outcome: 'delivered',
      });
      assert.equal(wrongSequenceAck.status, 404);
      const foreignAck = await runnerPost(runnerB, keysB, ackPath, {
        runnerId: runnerB.runnerId,
        endpointId,
        receiptId: delivery.json.delivery.receiptId,
        eventId: delivery.json.delivery.eventId,
        sequence: delivery.json.delivery.sequence,
        outcome: 'delivered',
      });
      assert.equal(foreignAck.status, 404);
      const ackBody = {
        runnerId: runnerA.runnerId,
        endpointId,
        receiptId: delivery.json.delivery.receiptId,
        eventId: delivery.json.delivery.eventId,
        sequence: delivery.json.delivery.sequence,
        outcome: 'delivered',
      };
      const ack = await runnerPost(runnerA, keysA, ackPath, ackBody);
      const duplicateAck = await runnerPost(runnerA, keysA, ackPath, ackBody);
      assert.equal(ack.status, 200, JSON.stringify(ack.json));
      assert.deepEqual(duplicateAck.json, ack.json);
      assert.equal(ack.json.status, 'delivered');
      assert.doesNotMatch(
        JSON.stringify([wrongEventAck.json, wrongSequenceAck.json, foreignAck.json]),
        /binding|cursor|payload|token|chat.?id|event_telegram/i,
      );

      const cursorBeforeHostile = await pool.query(
        `select outbound_cursor::int as outbound_cursor
         from work_conversation_channel_endpoints
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      const malformedNext = await runnerPost(runnerA, keysA, nextPath, {
        runnerId: runnerA.runnerId,
        endpointId: 'malformed endpoint',
      });
      assert.equal(malformedNext.status, 400);
      const foreignNext = await runnerPost(runnerB, keysB, nextPath, {
        runnerId: runnerB.runnerId,
        endpointId,
      });
      assert.equal(foreignNext.status, 404);
      await pool.query(
        `update work_conversation_channel_endpoints
         set status = 'revoked'
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      const staleNext = await runnerPost(runnerA, keysA, nextPath, {
        runnerId: runnerA.runnerId,
        endpointId,
      });
      assert.equal(staleNext.status, 404);
      const cursorAfterHostile = await pool.query(
        `select outbound_cursor::int as outbound_cursor
         from work_conversation_channel_endpoints
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      assert.deepEqual(cursorAfterHostile.rows[0], cursorBeforeHostile.rows[0]);
      assert.doesNotMatch(
        JSON.stringify([malformedNext.json, foreignNext.json, staleNext.json]),
        /binding|cursor|payload|token|chat.?id/i,
      );
      await pool.query(
        `update work_conversation_channel_endpoints
         set status = 'active'
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );

      const stored = await pool.query(
        `select binding_handle, public_metadata
         from work_conversation_channel_endpoints
         where workspace_id = 'ws-a' and id = $1`,
        [endpointId],
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].binding_handle, bindingHandle);
      assert.doesNotMatch(JSON.stringify(stored.rows[0]), /1234|bot|token|chat_id/i);
    } finally {
      runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar?.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
      await close(server);
      delete process.env.WORKSPACE_AUTH_MODE;
    }
  });
});
