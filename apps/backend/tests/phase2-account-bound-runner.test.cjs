'use strict';

/**
 * Phase 2 account-bound Runner — hostile two-Workspace matrix on real PostgreSQL.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
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
  hashOpaque,
  BANNED_LAUNCH_ARGS,
  PROTOCOL_VERSION,
} = require('../app/lib/runner-control');
const {
  listProductionRoutes,
  matchProductionRoute,
  countRoutesByClass,
} = require('../app/lib/production-route-registry');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase2runner';
const DATABASE = 'phase2_runner';

function withEphemeralPostgres(fn) {
  return withSharedEphemeralPostgres({
    prefix: 'phase2-runner-',
    role: LOCAL_ROLE,
    database: DATABASE,
  }, fn);
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
  return { status: response.status, json };
}

async function seedUsers(pool) {
  await runMigrations({ pool });
  await pool.query(`insert into users (id, display_name, status) values
    ('user-a', 'Alex', 'active'),
    ('user-b', 'Blair', 'active'),
    ('user-member-a', 'MemberA', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-a', 'Workspace A', 'active'),
    ('ws-b', 'Workspace B', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into workspace_memberships (id, workspace_id, user_id, role, status) values
    ('m-a-owner', 'ws-a', 'user-a', 'owner', 'active'),
    ('m-a-member', 'ws-a', 'user-member-a', 'member', 'active'),
    ('m-b-owner', 'ws-b', 'user-b', 'owner', 'active')
    on conflict (id) do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-a', 'user-a', 'test', 'subject-a'),
    ('id-b', 'user-b', 'test', 'subject-b'),
    ('id-ma', 'user-member-a', 'test', 'subject-member-a')
    on conflict (id) do nothing`);
}

async function issueToken(pool, subject, workspaceId) {
  const session = await issueSessionForVerifiedSubject(pool, {
    provider: 'test',
    providerSubject: subject,
    workspaceId,
  });
  return session.accessToken;
}

function assertNoSecrets(payload) {
  const raw = JSON.stringify(payload);
  assert.doesNotMatch(raw, /"deviceCredential"/);
  assert.doesNotMatch(raw, /"claimToken"/);
  assert.doesNotMatch(raw, /"sessionToken"/);
  assert.doesNotMatch(raw, /"credential_hash"/);
  assert.doesNotMatch(raw, /"challenge_hash"/);
}

function deviceAuthHeaders({
  keys,
  runnerId,
  credential,
  method,
  path: urlPath,
  body,
  sessionId = '',
  cursor = '',
  timestampMs = Date.now(),
  nonce = crypto.randomBytes(12).toString('base64url'),
}) {
  const bodyHash = bodySha256(body);
  const transcript = canonicalDeviceTranscript({
    method,
    path: urlPath,
    bodyHash,
    timestampMs,
    nonce,
    runnerId,
    sessionId,
    cursor,
  });
  const signature = signEd25519(keys.privateKey, transcript);
  return {
    'x-runner-id': runnerId,
    'x-runner-timestamp': String(timestampMs),
    'x-runner-nonce': nonce,
    'x-runner-session': sessionId,
    'x-runner-cursor': cursor === '' || cursor == null ? '' : String(cursor),
    'x-runner-credential': credential,
    'x-runner-signature': signature,
  };
}

async function enrollDevice(baseUrl, { challengeId, challengeCode, keys, hostName = 'host-a' }) {
  const body = {
    challengeId,
    challengeCode,
    devicePublicKey: keys.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    hostName,
    hostOs: 'darwin 24',
    runnerVersion: '0.1.0-dev',
  };
  body.signature = signEd25519(keys.privateKey, canonicalEnrollTranscript(body));
  return httpJson(baseUrl, 'POST', '/api/runner/device/enroll', { body });
}

async function claimDevice(baseUrl, { runnerId, claimToken, keys, credentialPath }) {
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(12).toString('base64url');
  const body = { runnerId, claimToken, timestampMs, nonce };
  body.signature = signEd25519(keys.privateKey, [
    'claim-v1',
    `runnerId=${runnerId}`,
    `claimToken=${claimToken}`,
    `timestampMs=${timestampMs}`,
    `nonce=${nonce}`,
  ].join('\n'));
  return httpJson(baseUrl, 'POST', '/api/runner/device/claim', { body });
}

test('phase2 registry has user + device runner routes, no runner_future', () => {
  const routes = listProductionRoutes();
  assert.equal(routes.some((r) => r.class === 'runner_future'), false);
  assert.ok(matchProductionRoute('GET', '/api/runners'));
  assert.ok(matchProductionRoute('POST', '/api/runners/enrollments'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/enroll'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/claim'));
  assert.ok(matchProductionRoute('POST', '/api/runner/device/connect'));
  assert.ok(matchProductionRoute('POST', '/api/runners/r1/revoke'));
  for (const routePath of [
    '/api/runners/enrollments',
    '/api/runners/enrollments/enrollment-a/confirm',
    '/api/runners/enrollments/enrollment-a/reject',
    '/api/runners/runner-a/test',
    '/api/runners/runner-a/revoke',
  ]) {
    assert.equal(matchProductionRoute('POST', routePath).route.idempotent, true);
  }
  const counts = countRoutesByClass();
  assert.ok(counts.byClass.runner_device >= 7);
  assert.ok(counts.byClass.scoped_product >= 8);
});

test('client-v1 Runner enrollment retry replays once and isolates the same key by Workspace', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
    });
    const server = createRailwayGatewayServer({
      env: {
        WORKSPACE_AUTH_MODE: 'production',
        AGENT_CALENDAR_OBSERVABILITY_LOGS: '0',
        PORT: '0',
      },
      phase1Pool: pool,
      phase1Runtime: runtime,
    });
    const baseUrl = await listen(server);
    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const body = { controlPlaneBaseUrl: baseUrl };
      const contractHeaders = {
        'x-agent-calendar-contract': 'client-v1',
      };

      const missingKey = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body,
        headers: contractHeaders,
      });
      assert.equal(missingKey.status, 400);
      assert.equal(missingKey.json.error, 'client_idempotency_key_required');

      const retryHeaders = {
        ...contractHeaders,
        'idempotency-key': 'runner-enrollment-retry-1',
      };
      const firstA = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body,
        headers: retryHeaders,
      });
      const replayA = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body,
        headers: retryHeaders,
      });
      assert.equal(firstA.status, 200, JSON.stringify(firstA.json));
      assert.equal(replayA.status, 200, JSON.stringify(replayA.json));
      assert.deepEqual(replayA.json, firstA.json);
      assertNoSecrets(firstA.json);

      const rowsA = await pool.query(
        `select id, status
         from runner_enrollment_challenges
         where workspace_id = 'ws-a'`,
      );
      assert.equal(rowsA.rowCount, 1);
      assert.equal(rowsA.rows[0].status, 'issued');

      const conflictA = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body: { controlPlaneBaseUrl: 'https://different.invalid' },
        headers: retryHeaders,
      });
      assert.equal(conflictA.status, 409);
      assert.equal(conflictA.json.error, 'idempotency_key_conflict');

      const firstB = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenB,
        body,
        headers: retryHeaders,
      });
      assert.equal(firstB.status, 200, JSON.stringify(firstB.json));
      assert.equal(firstB.json.enrollment.workspaceId, 'ws-b');
      assert.notEqual(firstB.json.enrollment.id, firstA.json.enrollment.id);
      assertNoSecrets(firstB.json);

      const rowsB = await pool.query(
        `select count(*)::int as count
         from runner_enrollment_challenges
         where workspace_id = 'ws-b'`,
      );
      assert.equal(rowsB.rows[0].count, 1);

      const legacy = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenB,
        body,
      });
      assert.equal(legacy.status, 200);

      const mutationCases = [
        {
          methodName: 'confirmEnrollment',
          path: '/api/runners/enrollments/enrollment-replay/confirm',
        },
        {
          methodName: 'rejectEnrollment',
          path: '/api/runners/enrollments/enrollment-replay/reject',
        },
        {
          methodName: 'testConnection',
          path: '/api/runners/runner-replay/test',
        },
        {
          methodName: 'revokeRunner',
          path: '/api/runners/runner-replay/revoke',
        },
      ];
      const mutationCalls = Object.create(null);
      for (const entry of mutationCases) {
        mutationCalls[entry.methodName] = 0;
        runtime.runnerControl[entry.methodName] = async (_scope, id) => {
          mutationCalls[entry.methodName] += 1;
          return {
            ok: true,
            operation: entry.methodName,
            targetId: id,
          };
        };
      }
      for (const entry of mutationCases) {
        const headers = {
          ...contractHeaders,
          'idempotency-key': `runner-control-${entry.methodName}`,
        };
        const first = await httpJson(baseUrl, 'POST', entry.path, {
          token: tokenA,
          body: {},
          headers,
        });
        const replay = await httpJson(baseUrl, 'POST', entry.path, {
          token: tokenA,
          body: {},
          headers,
        });
        assert.equal(first.status, 200, JSON.stringify(first.json));
        assert.deepEqual(replay.json, first.json);
        assert.equal(mutationCalls[entry.methodName], 1);
        assertNoSecrets(first.json);
      }
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) {
        runtime.unifiedCalendar.stopBackgroundWorkers();
      }
      await close(server);
    }
  });
});

test('phase2 banned launch args list is non-empty', () => {
  assert.ok(BANNED_LAUNCH_ARGS.includes('--yolo'));
  assert.ok(BANNED_LAUNCH_ARGS.includes('--dangerously-skip-permissions'));
});

test('phase2 app-role cannot SELECT secret hash tables/columns', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    // Seed a challenge secret via superuser path used by migrations/owner.
    await pool.query(`
      insert into runner_enrollment_challenges
        (id, workspace_id, owner_user_id, human_code_display, protocol_version, status, expires_at)
      values ('ench_sec', 'ws-a', 'user-a', 'AAAA-BBBB-CCCC', 1, 'issued', now() + interval '1 hour')
    `);
    await pool.query(`
      insert into runner_enrollment_challenge_secrets (challenge_id, workspace_id, challenge_hash)
      values ('ench_sec', 'ws-a', 'deadbeef')
    `);
    await pool.query(`
      insert into runners (id, workspace_id, status, device_public_key, fingerprint_sha256, credential_version)
      values ('run_sec', 'ws-a', 'active', 'pk', 'fp', 1)
    `);
    await pool.query(`
      insert into runner_credential_secrets (runner_id, workspace_id, credential_hash, credential_version)
      values ('run_sec', 'ws-a', 'cafebabe', 1)
    `);
    await pool.query(`
      insert into runner_pending_claims (id, runner_id, workspace_id, status, expires_at)
      values ('claim_sec', 'run_sec', 'ws-a', 'pending', now() + interval '1 hour')
    `);
    await pool.query(`
      insert into runner_claim_secrets (claim_id, runner_id, workspace_id, claim_token_hash)
      values ('claim_sec', 'run_sec', 'ws-a', 'claimhash')
    `);
    await pool.query(`
      insert into runner_sessions (id, runner_id, workspace_id, protocol_version, cursor)
      values ('sess_sec', 'run_sec', 'ws-a', 1, 1)
    `);
    await pool.query(`
      insert into runner_session_secrets (session_id, runner_id, workspace_id, session_token_hash)
      values ('sess_sec', 'run_sec', 'ws-a', 'sesshash')
    `);

    // Public tables must not expose hash columns.
    for (const [tbl, col] of [
      ['runner_enrollment_challenges', 'challenge_hash'],
      ['runners', 'credential_hash'],
      ['runner_pending_claims', 'claim_token_hash'],
      ['runner_sessions', 'session_token_hash'],
    ]) {
      const cols = await pool.query(
        `select 1 from information_schema.columns
         where table_name = $1 and column_name = $2`,
        [tbl, col],
      );
      assert.equal(cols.rowCount, 0, `${tbl}.${col} must not exist on public table`);
    }

    // Confirm FORCE RLS + no SELECT privilege for app role on secret tables.
    for (const table of [
      'runner_enrollment_challenge_secrets',
      'runner_credential_secrets',
      'runner_claim_secrets',
      'runner_session_secrets',
      'runner_request_nonces',
    ]) {
      const rel = await pool.query(
        `select c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      assert.equal(rel.rowCount, 1, `${table} must exist`);
      assert.equal(rel.rows[0].relrowsecurity, true, `${table} must enable RLS`);
      assert.equal(rel.rows[0].relforcerowsecurity, true, `${table} must FORCE RLS`);

      const priv = await pool.query(
        `select has_table_privilege('agent_calendar_app', $1, 'SELECT') as can_select`,
        [table],
      );
      assert.equal(priv.rows[0].can_select, false, `agent_calendar_app must not have SELECT on ${table}`);
    }

    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local role agent_calendar_app`);
        await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
        await client.query(`select set_config('app.user_id', 'user-a', true)`);
        // Control rows readable under workspace isolation.
        const publicOk = await client.query(
          `select id from runner_enrollment_challenges where workspace_id = 'ws-a'`,
        );
        assert.ok(publicOk.rowCount >= 1);
        await client.query('rollback');
      } finally {
        try { await client.query('rollback'); } catch { /* ignore */ }
        client.release();
      }
    }

    const secretTables = [
      'runner_enrollment_challenge_secrets',
      'runner_credential_secrets',
      'runner_claim_secrets',
      'runner_session_secrets',
      'runner_request_nonces',
    ];
    for (const table of secretTables) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local role agent_calendar_app`);
        await client.query(`select set_config('app.workspace_id', 'ws-a', true)`);
        await client.query(`select set_config('app.user_id', 'user-a', true)`);
        let denied = false;
        let detail = '';
        try {
          const r = await client.query(`select * from ${table}`);
          detail = `rowCount=${r.rowCount}`;
          if (r.rowCount === 0) denied = true;
        } catch (error) {
          detail = String(error.message || error);
          denied = /permission denied|42501/i.test(detail);
        }
        assert.equal(denied, true, `app role must not read rows from ${table} (${detail})`);
        await client.query('rollback');
      } finally {
        try { await client.query('rollback'); } catch { /* ignore */ }
        client.release();
      }
    }
  });
});

test('phase2 hostile two-workspace runner matrix', async (t) => {
  await withEphemeralPostgres(async ({ pool }) => {
    await seedUsers(pool);
    const runtime = createPhase1Runtime({
      pool,
      identityVerifier: null,
      authKit: null,
      workosConfig: null,
    });
    assert.ok(runtime.runnerControl);

    const prevMode = process.env.WORKSPACE_AUTH_MODE;
    process.env.WORKSPACE_AUTH_MODE = 'production';
    const server = createRailwayGatewayServer({
      env: {
        ...process.env,
        WORKSPACE_AUTH_MODE: 'production',
        PORT: '0',
        HERMES_API_TOKEN: '',
      },
      phase1Pool: pool,
      phase1Runtime: runtime,
    });
    const baseUrl = await listen(server);

    try {
      const tokenA = await issueToken(pool, 'subject-a', 'ws-a');
      const tokenB = await issueToken(pool, 'subject-b', 'ws-b');
      const tokenMember = await issueToken(pool, 'subject-member-a', 'ws-a');

      // Logged-out cannot list or start
      const anonList = await httpJson(baseUrl, 'GET', '/api/runners');
      assert.equal(anonList.status, 401);
      const anonStart = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', { body: {} });
      assert.equal(anonStart.status, 401);

      // Member cannot start
      const memberStart = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenMember,
        body: {},
      });
      assert.equal(memberStart.status, 403);

      // Owner A starts enrollment
      const startA = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body: { controlPlaneBaseUrl: baseUrl, workspaceId: 'ws-b' }, // spoof ignored
      });
      assert.equal(startA.status, 200, JSON.stringify(startA.json));
      assert.equal(startA.json.enrollment.workspaceId, 'ws-a');
      assert.ok(startA.json.enrollment.humanCode);
      assert.ok(startA.json.enrollment.qrPayload);
      assertNoSecrets(startA.json);
      const enrollmentId = startA.json.enrollment.id;
      const codeA = startA.json.enrollment.humanCode;

      // Reissue replaces prior challenge
      const startA2 = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body: {},
      });
      assert.equal(startA2.status, 200);
      const oldPresent = await enrollDevice(baseUrl, {
        challengeId: enrollmentId,
        challengeCode: codeA,
        keys: generateEd25519Keypair(),
      });
      assert.ok(oldPresent.status === 401, 'replaced challenge must fail');

      const enrollmentId2 = startA2.json.enrollment.id;
      const codeA2 = startA2.json.enrollment.humanCode;
      const keysA = generateEd25519Keypair();

      // Wrong signature
      const badSigBody = {
        challengeId: enrollmentId2,
        challengeCode: codeA2,
        devicePublicKey: keysA.publicKey,
        protocolVersion: PROTOCOL_VERSION,
        hostName: 'host-a',
        hostOs: 'darwin',
        runnerVersion: '0.1.0-dev',
        signature: 'not-a-sig',
      };
      const badSig = await httpJson(baseUrl, 'POST', '/api/runner/device/enroll', { body: badSigBody });
      assert.equal(badSig.status, 401);

      // Protocol mismatch
      const badProto = {
        challengeId: enrollmentId2,
        challengeCode: codeA2,
        devicePublicKey: keysA.publicKey,
        protocolVersion: 999,
        hostName: 'host-a',
        hostOs: 'darwin',
        runnerVersion: '0.1.0-dev',
      };
      badProto.signature = signEd25519(keysA.privateKey, canonicalEnrollTranscript(badProto));
      const badProtoRes = await httpJson(baseUrl, 'POST', '/api/runner/device/enroll', { body: badProto });
      assert.equal(badProtoRes.status, 400);

      // Valid enroll → pending
      const enrollA = await enrollDevice(baseUrl, {
        challengeId: enrollmentId2,
        challengeCode: codeA2,
        keys: keysA,
        hostName: 'mac-a',
      });
      assert.equal(enrollA.status, 200, JSON.stringify(enrollA.json));
      assert.equal(enrollA.json.status, 'pending');
      assert.ok(enrollA.json.claimToken);
      assert.ok(enrollA.json.fingerprint);
      const runnerA = enrollA.json.runnerId;
      const claimTokenA = enrollA.json.claimToken;

      // Challenge replay
      const replay = await enrollDevice(baseUrl, {
        challengeId: enrollmentId2,
        challengeCode: codeA2,
        keys: generateEd25519Keypair(),
      });
      assert.equal(replay.status, 401);

      // B cannot list A's runners
      const listB = await httpJson(baseUrl, 'GET', '/api/runners', { token: tokenB });
      assert.equal(listB.status, 200);
      assert.equal(listB.json.runners.length, 0);
      assertNoSecrets(listB.json);

      // A lists pending runner (no secrets)
      const listA = await httpJson(baseUrl, 'GET', '/api/runners', { token: tokenA });
      assert.equal(listA.status, 200);
      assert.equal(listA.json.runners.length, 1);
      assert.equal(listA.json.runners[0].id, runnerA);
      assertNoSecrets(listA.json);

      // Claim before confirm denied
      const earlyClaim = await claimDevice(baseUrl, {
        runnerId: runnerA,
        claimToken: claimTokenA,
        keys: keysA,
      });
      assert.equal(earlyClaim.status, 403);

      // Member cannot confirm
      const memberConfirm = await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${enrollmentId2}/confirm`, {
        token: tokenMember,
        body: {},
      });
      assert.equal(memberConfirm.status, 403);

      // B cannot confirm A's enrollment
      const bConfirm = await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${enrollmentId2}/confirm`, {
        token: tokenB,
        body: {},
      });
      assert.ok(bConfirm.status === 403 || bConfirm.status === 404 || bConfirm.status === 401);

      // Owner A confirms
      const confirmA = await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${enrollmentId2}/confirm`, {
        token: tokenA,
        body: {},
      });
      assert.equal(confirmA.status, 200, JSON.stringify(confirmA.json));
      assertNoSecrets(confirmA.json);

      // Get enrollment shows fingerprint
      const getEnroll = await httpJson(baseUrl, 'GET', `/api/runners/enrollments/${enrollmentId2}`, {
        token: tokenA,
      });
      assert.equal(getEnroll.status, 200);
      assert.ok(getEnroll.json.pendingDevice?.fingerprint || getEnroll.json.runner);
      assertNoSecrets(getEnroll.json);

      // Claim credential
      const claimA = await claimDevice(baseUrl, {
        runnerId: runnerA,
        claimToken: claimTokenA,
        keys: keysA,
      });
      assert.equal(claimA.status, 200, JSON.stringify(claimA.json));
      assert.ok(claimA.json.deviceCredential);
      const credentialA = claimA.json.deviceCredential;

      // Claim replay
      const claimReplay = await claimDevice(baseUrl, {
        runnerId: runnerA,
        claimToken: claimTokenA,
        keys: keysA,
      });
      assert.equal(claimReplay.status, 401);

      // Connect
      const connectBody = { protocolVersion: PROTOCOL_VERSION, runnerId: runnerA };
      const connectHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/connect',
        body: connectBody,
      });
      const connectA = await httpJson(baseUrl, 'POST', '/api/runner/device/connect', {
        body: connectBody,
        headers: connectHeaders,
      });
      assert.equal(connectA.status, 200, JSON.stringify(connectA.json));
      assert.ok(connectA.json.sessionId);
      const sessionA = connectA.json.sessionId;
      const cursorA = connectA.json.cursor;

      // Capabilities with mixed availability
      const capsBody = {
        runnerId: runnerA,
        engines: {
          codex: { available: true, status: 'available', version: '0.1.0', authStatus: 'ok' },
          claude: { available: false, status: 'unavailable', version: null, authStatus: 'missing' },
          grok: { available: false, status: 'unavailable', version: null, authStatus: 'missing' },
          hermes: { available: true, status: 'available', version: '1.0.0', authStatus: 'ok' },
        },
      };
      const capsHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/capabilities',
        body: capsBody,
        sessionId: sessionA,
        cursor: cursorA,
      });
      const capsA = await httpJson(baseUrl, 'POST', '/api/runner/device/capabilities', {
        body: capsBody,
        headers: capsHeaders,
      });
      assert.equal(capsA.status, 200, JSON.stringify(capsA.json));

      // Banned args rejected
      const bannedBody = {
        runnerId: runnerA,
        engines: {
          codex: { available: true, launchArgs: ['--yolo'] },
        },
      };
      const bannedHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/capabilities',
        body: bannedBody,
        sessionId: sessionA,
        cursor: cursorA,
      });
      const banned = await httpJson(baseUrl, 'POST', '/api/runner/device/capabilities', {
        body: bannedBody,
        headers: bannedHeaders,
      });
      assert.equal(banned.status, 400);

      // Heartbeat
      const hbBody = { runnerId: runnerA, sessionId: sessionA, cursor: cursorA };
      const hbHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/heartbeat',
        body: hbBody,
        sessionId: sessionA,
        cursor: cursorA,
      });
      const hb = await httpJson(baseUrl, 'POST', '/api/runner/device/heartbeat', {
        body: hbBody,
        headers: hbHeaders,
      });
      assert.equal(hb.status, 200, JSON.stringify(hb.json));

      // Nonce replay
      const hbReplay = await httpJson(baseUrl, 'POST', '/api/runner/device/heartbeat', {
        body: hbBody,
        headers: hbHeaders,
      });
      assert.equal(hbReplay.status, 401);

      // Clock skew
      const skewBody = { runnerId: runnerA, sessionId: sessionA, cursor: cursorA };
      const skewHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/heartbeat',
        body: skewBody,
        sessionId: sessionA,
        cursor: cursorA,
        timestampMs: Date.now() - 10 * 60 * 1000,
      });
      const skew = await httpJson(baseUrl, 'POST', '/api/runner/device/heartbeat', {
        body: skewBody,
        headers: skewHeaders,
      });
      assert.equal(skew.status, 401);

      // Wrong body / signature
      const wrongBody = { runnerId: runnerA, sessionId: sessionA, cursor: cursorA, extra: 1 };
      const wrongHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/heartbeat',
        body: hbBody, // signed for different body
        sessionId: sessionA,
        cursor: cursorA,
      });
      const wrong = await httpJson(baseUrl, 'POST', '/api/runner/device/heartbeat', {
        body: wrongBody,
        headers: wrongHeaders,
      });
      assert.equal(wrong.status, 401);

      // Stale cursor
      const staleBody = { runnerId: runnerA, sessionId: sessionA, cursor: 0 };
      const staleHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/heartbeat',
        body: staleBody,
        sessionId: sessionA,
        cursor: 0,
      });
      const stale = await httpJson(baseUrl, 'POST', '/api/runner/device/heartbeat', {
        body: staleBody,
        headers: staleHeaders,
      });
      assert.equal(stale.status, 409);

      // Connection test by owner
      const testA = await httpJson(baseUrl, 'POST', `/api/runners/${runnerA}/test`, {
        token: tokenA,
        body: {},
      });
      assert.equal(testA.status, 200, JSON.stringify(testA.json));
      assert.equal(testA.json.test.passed, true);
      assertNoSecrets(testA.json);

      // B cannot test A's runner
      const testB = await httpJson(baseUrl, 'POST', `/api/runners/${runnerA}/test`, {
        token: tokenB,
        body: {},
      });
      assert.ok(testB.status === 404 || testB.status === 401 || testB.status === 403);

      // Foreign runner id with A's credential
      const foreignBody = { protocolVersion: PROTOCOL_VERSION, runnerId: 'run_foreign' };
      const foreignHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: 'run_foreign',
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/connect',
        body: foreignBody,
      });
      const foreign = await httpJson(baseUrl, 'POST', '/api/runner/device/connect', {
        body: foreignBody,
        headers: foreignHeaders,
      });
      assert.equal(foreign.status, 401);

      // Workspace B full journey (second runner same system)
      const startB = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenB,
        body: {},
      });
      assert.equal(startB.status, 200);
      const keysB = generateEd25519Keypair();
      const enrollB = await enrollDevice(baseUrl, {
        challengeId: startB.json.enrollment.id,
        challengeCode: startB.json.enrollment.humanCode,
        keys: keysB,
        hostName: 'mac-b',
      });
      assert.equal(enrollB.status, 200);
      await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${startB.json.enrollment.id}/confirm`, {
        token: tokenB,
        body: {},
      });
      const claimB = await claimDevice(baseUrl, {
        runnerId: enrollB.json.runnerId,
        claimToken: enrollB.json.claimToken,
        keys: keysB,
      });
      assert.equal(claimB.status, 200);

      // Same workspace second runner for A
      const startA3 = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body: {},
      });
      const keysA2 = generateEd25519Keypair();
      const enrollA2 = await enrollDevice(baseUrl, {
        challengeId: startA3.json.enrollment.id,
        challengeCode: startA3.json.enrollment.humanCode,
        keys: keysA2,
        hostName: 'mac-a-2',
      });
      assert.equal(enrollA2.status, 200);
      await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${startA3.json.enrollment.id}/confirm`, {
        token: tokenA,
        body: {},
      });
      const claimA2 = await claimDevice(baseUrl, {
        runnerId: enrollA2.json.runnerId,
        claimToken: enrollA2.json.claimToken,
        keys: keysA2,
      });
      assert.equal(claimA2.status, 200);
      const listA2 = await httpJson(baseUrl, 'GET', '/api/runners', { token: tokenA });
      assert.ok(listA2.json.runners.filter((r) => r.status === 'active').length >= 2);

      // Rotate — old credential rejected
      const rotateBody = { runnerId: runnerA };
      const rotateHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/rotate',
        body: rotateBody,
        sessionId: sessionA,
        cursor: cursorA,
      });
      const rotate = await httpJson(baseUrl, 'POST', '/api/runner/device/rotate', {
        body: rotateBody,
        headers: rotateHeaders,
      });
      assert.equal(rotate.status, 200, JSON.stringify(rotate.json));
      assert.ok(rotate.json.deviceCredential);
      const newCred = rotate.json.deviceCredential;

      const oldConnectBody = { protocolVersion: PROTOCOL_VERSION, runnerId: runnerA };
      const oldConnectHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: credentialA,
        method: 'POST',
        path: '/api/runner/device/connect',
        body: oldConnectBody,
      });
      const oldConnect = await httpJson(baseUrl, 'POST', '/api/runner/device/connect', {
        body: oldConnectBody,
        headers: oldConnectHeaders,
      });
      assert.equal(oldConnect.status, 401);

      // Reconnect with new credential
      const reBody = { protocolVersion: PROTOCOL_VERSION, runnerId: runnerA };
      const reHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: newCred,
        method: 'POST',
        path: '/api/runner/device/connect',
        body: reBody,
      });
      const reconnect = await httpJson(baseUrl, 'POST', '/api/runner/device/connect', {
        body: reBody,
        headers: reHeaders,
      });
      assert.equal(reconnect.status, 200, JSON.stringify(reconnect.json));

      // Owner revoke
      const revoke = await httpJson(baseUrl, 'POST', `/api/runners/${runnerA}/revoke`, {
        token: tokenA,
        body: {},
      });
      assert.equal(revoke.status, 200);
      assert.equal(revoke.json.runner.status, 'revoked');
      assertNoSecrets(revoke.json);

      const afterRevokeBody = { protocolVersion: PROTOCOL_VERSION, runnerId: runnerA };
      const afterRevokeHeaders = deviceAuthHeaders({
        keys: keysA,
        runnerId: runnerA,
        credential: newCred,
        method: 'POST',
        path: '/api/runner/device/connect',
        body: afterRevokeBody,
      });
      const afterRevoke = await httpJson(baseUrl, 'POST', '/api/runner/device/connect', {
        body: afterRevokeBody,
        headers: afterRevokeHeaders,
      });
      assert.equal(afterRevoke.status, 401);

      // Reject path for a new enrollment
      const startReject = await httpJson(baseUrl, 'POST', '/api/runners/enrollments', {
        token: tokenA,
        body: {},
      });
      const keysReject = generateEd25519Keypair();
      const enrollReject = await enrollDevice(baseUrl, {
        challengeId: startReject.json.enrollment.id,
        challengeCode: startReject.json.enrollment.humanCode,
        keys: keysReject,
      });
      assert.equal(enrollReject.status, 200);
      const rejectRes = await httpJson(baseUrl, 'POST', `/api/runners/enrollments/${startReject.json.enrollment.id}/reject`, {
        token: tokenA,
        body: {},
      });
      assert.equal(rejectRes.status, 200);
      assert.equal(rejectRes.json.runner.status, 'rejected');
      const claimReject = await claimDevice(baseUrl, {
        runnerId: enrollReject.json.runnerId,
        claimToken: enrollReject.json.claimToken,
        keys: keysReject,
      });
      assert.equal(claimReject.status, 401);

      // Audit rows present
      const audits = await pool.query(
        `select action from audit_events where workspace_id = 'ws-a' and action like 'runner.%'`,
      );
      const actions = audits.rows.map((r) => r.action);
      assert.ok(actions.includes('runner.enrollment.start'));
      assert.ok(actions.includes('runner.enrollment.confirm'));
      assert.ok(actions.includes('runner.revoke'));
      assert.ok(actions.includes('runner.enrollment.reject'));

      // Release manifest honest status
      const manifest = await httpJson(baseUrl, 'GET', '/api/runners/release-manifest', { token: tokenA });
      assert.equal(manifest.status, 200);
      assert.ok(['local_development', 'verified_signed', 'unavailable'].includes(manifest.json.artifact.status));

      // Unknown runner path fail-closed
      const unknown = await httpJson(baseUrl, 'POST', '/api/runner/device/hack', { body: {} });
      assert.equal(unknown.status, 404);
    } finally {
      if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
      if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) {
        runtime.unifiedCalendar.stopBackgroundWorkers();
      }
      await close(server);
      if (prevMode === undefined) delete process.env.WORKSPACE_AUTH_MODE;
      else process.env.WORKSPACE_AUTH_MODE = prevMode;
    }
  });
});
