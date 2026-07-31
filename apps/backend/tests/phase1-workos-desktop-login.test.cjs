'use strict';

/**
 * Phase 1 WorkOS AuthKit + Desktop login — hostile integration suite.
 * RED → GREEN on ephemeral PostgreSQL (migrations through 0015).
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

const { runMigrations } = require('../app/db/migrate');
const { createPhase1Runtime, handlePhase1Request } = require('../app/lib/phase1-auth-routes');

function stopRuntimeWorkers(runtime) {
  if (!runtime) return;
  if (runtime.durableExecution) runtime.durableExecution.stopBackgroundWorkers();
  if (runtime.unifiedCalendar && runtime.unifiedCalendar.stopBackgroundWorkers) runtime.unifiedCalendar.stopBackgroundWorkers();
}

const { authenticateAccessToken } = require('../app/lib/workspace-auth-session');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');
const {
  DESKTOP_LOGIN_REDIRECT_URI,
  hashDesktopLoginSecret,
} = require('../app/lib/desktop-login-service');

const LOCAL_ROLE = 'phase1workos';
const DATABASE = 'phase1_workos_login';
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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-workos-'));
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

function createFakeAuthKit({ usersByCode = new Map(), failCodes = new Set() } = {}) {
  const started = [];
  return {
    kind: 'fake',
    started,
    async getAuthorizationUrlWithPKCE({
      clientId,
      redirectUri,
      provider,
      state,
      screenHint,
      prompt,
      providerQueryParams,
    }) {
      assert.equal(provider, 'authkit');
      assert.equal(redirectUri, DESKTOP_LOGIN_REDIRECT_URI);
      assert.ok(clientId);
      const codeVerifier = `verifier_${crypto.randomBytes(16).toString('hex')}`;
      const providerState = `sdk_${crypto.randomBytes(24).toString('base64url')}`;
      started.push({
        clientId,
        redirectUri,
        provider,
        requestedState: state,
        providerState,
        screenHint,
        prompt,
        providerQueryParams,
        codeVerifier,
      });
      return {
        url: `https://authkit.test/authorize?state=${encodeURIComponent(providerState)}&client_id=${encodeURIComponent(clientId)}`,
        state: providerState,
        codeVerifier,
      };
    },
    async authenticateWithCodeAndVerifier({ clientId, code, codeVerifier }) {
      assert.ok(clientId);
      assert.ok(codeVerifier);
      if (failCodes.has(code)) {
        const error = new Error('workos_exchange_failed');
        error.code = 'WORKOS_EXCHANGE_FAILED';
        throw error;
      }
      const user = usersByCode.get(code);
      if (!user) {
        const error = new Error('unknown_code');
        error.code = 'WORKOS_UNKNOWN_CODE';
        throw error;
      }
      return {
        user: {
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified !== false,
          firstName: user.firstName || null,
          lastName: user.lastName || null,
        },
        // WorkOS tokens must never leak into app session responses.
        accessToken: 'workos-access-must-not-leak',
        refreshToken: 'workos-refresh-must-not-leak',
      };
    },
  };
}

function createConfiguredRuntime(pool, authKit) {
  return createPhase1Runtime({
    pool,
    authKit,
    workosConfig: {
      clientId: 'client_test_desktop',
      apiKeyConfigured: true,
    },
  });
}

function createUnconfiguredRuntime(pool) {
  return createPhase1Runtime({
    pool,
    authKit: null,
    workosConfig: null,
  });
}

async function withPhase1Server(runtime, fn) {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      await handlePhase1Request(req, res, requestUrl, runtime);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ baseUrl });
  } finally {
    stopRuntimeWorkers(runtime);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function dispatch(baseUrl, { method, path: pathname, body, headers = {} }) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { raw };
  }
  return { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body: json, raw };
}

test('migration 0015 creates durable one-use desktop login transactions table', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await runMigrations({ pool });
    const cols = await pool.query(`
      select column_name from information_schema.columns
      where table_name = 'desktop_login_transactions'
      order by column_name
    `);
    const names = cols.rows.map((r) => r.column_name);
    for (const required of [
      'id', 'state_hash', 'verifier_hash', 'redirect_uri', 'status', 'expires_at', 'created_at',
    ]) {
      assert.ok(names.includes(required), `missing column ${required}`);
    }
    assert.equal(names.includes('authorization_code'), false, 'must not store authorization codes');
    assert.equal(names.includes('code'), false, 'must not store authorization codes');
  });
});

test('desktop start/complete bootstrap + isolation matrix on real PostgreSQL', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    await runMigrations({ pool });

    const usersByCode = new Map([
      ['code-alice-1', { id: 'workos_user_alice', email: 'alice@example.com', firstName: 'Alice' }],
      ['code-alice-2', { id: 'workos_user_alice', email: 'alice@example.com', firstName: 'Alice' }],
      ['code-bob-1', { id: 'workos_user_bob', email: 'bob@example.com', firstName: 'Bob' }],
    ]);
    const authKit = createFakeAuthKit({ usersByCode });
    const runtime = createConfiguredRuntime(pool, authKit);

    await withPhase1Server(runtime, async ({ baseUrl }) => {
      // Missing WorkOS config fails closed 503.
      const unconfigured = createUnconfiguredRuntime(pool);
      await withPhase1Server(unconfigured, async ({ baseUrl: bareUrl }) => {
        const missing = await dispatch(bareUrl, {
          method: 'POST',
          path: '/api/phase1/auth/desktop/start',
          body: {},
        });
        assert.equal(missing.statusCode, 503);
        assert.equal(missing.body.ok, false);
        assert.match(String(missing.body.error), /workos|authkit|config/i);
        assert.doesNotMatch(JSON.stringify(missing.body), /api[_-]?key|secret|sk_/i);
      });

      // Start desktop login.
      const startA = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: { screenHint: 'sign-in' },
      });
      assert.equal(startA.statusCode, 200, JSON.stringify(startA.body));
      assert.equal(startA.body.ok, true);
      assert.ok(startA.body.authorizationUrl);
      assert.ok(startA.body.state);
      assert.ok(startA.body.codeVerifier);
      assert.ok(startA.body.transactionId);
      assert.equal(startA.body.redirectUri, DESKTOP_LOGIN_REDIRECT_URI);
      assert.equal(new URL(startA.body.authorizationUrl).searchParams.get('state'), startA.body.state);
      assert.equal(startA.body.state, authKit.started[0].providerState);
      assert.notEqual(startA.body.state, authKit.started[0].requestedState);

      const row = await pool.query(
        `select * from desktop_login_transactions where id = $1`,
        [startA.body.transactionId],
      );
      assert.equal(row.rowCount, 1);
      assert.equal(row.rows[0].status, 'pending');
      assert.equal(row.rows[0].state_hash, hashDesktopLoginSecret(startA.body.state));
      assert.equal(row.rows[0].verifier_hash, hashDesktopLoginSecret(startA.body.codeVerifier));
      assert.equal(row.rows[0].redirect_uri, DESKTOP_LOGIN_REDIRECT_URI);
      // Plaintext secrets must not be stored.
      assert.doesNotMatch(JSON.stringify(row.rows[0]), new RegExp(startA.body.state));
      assert.doesNotMatch(JSON.stringify(row.rows[0]), new RegExp(startA.body.codeVerifier));

      // Body identity is not trusted: forged providerSubject must not become session identity.
      const forgedIdentity = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-1',
          state: startA.body.state,
          codeVerifier: startA.body.codeVerifier,
          providerSubject: 'workos_user_bob',
          email: 'attacker@evil.test',
          userId: 'user-forged',
          workspaceId: 'ws-forged',
        },
      });
      assert.equal(forgedIdentity.statusCode, 200, JSON.stringify(forgedIdentity.body));
      assert.equal(forgedIdentity.body.ok, true);
      assert.ok(forgedIdentity.body.accessToken);
      assert.ok(forgedIdentity.body.refreshToken);
      assert.equal(forgedIdentity.body.user.email, 'alice@example.com');
      assert.ok(!Object.prototype.hasOwnProperty.call(forgedIdentity.body, 'workosAccessToken'));
      assert.doesNotMatch(JSON.stringify(forgedIdentity.body), /workos-access-must-not-leak/);
      assert.doesNotMatch(JSON.stringify(forgedIdentity.body), /workos-refresh-must-not-leak/);

      // Clean bootstrap: one personal workspace + owner membership.
      const memberships = await pool.query(
        `select m.*, w.name as workspace_name
         from workspace_memberships m
         join workspaces w on w.id = m.workspace_id
         join auth_identities ai on ai.user_id = m.user_id
         where ai.provider = 'workos' and ai.provider_subject = 'workos_user_alice'`,
      );
      assert.equal(memberships.rowCount, 1);
      assert.equal(memberships.rows[0].role, 'owner');
      assert.equal(memberships.rows[0].status, 'active');
      assert.equal(forgedIdentity.body.workspaceId, memberships.rows[0].workspace_id);

      const scopeAuth = await authenticateAccessToken(pool, forgedIdentity.body.accessToken);
      assert.equal(scopeAuth.scope.workspaceId, forgedIdentity.body.workspaceId);
      assert.equal(scopeAuth.scope.role, 'owner');

      // Replay of same complete is rejected.
      const replay = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-1',
          state: startA.body.state,
          codeVerifier: startA.body.codeVerifier,
        },
      });
      assert.ok(replay.statusCode === 401 || replay.statusCode === 409, JSON.stringify(replay.body));
      assert.equal(replay.body.ok, false);

      // Repeat login reuses same user + workspace (no second personal workspace).
      const startA2 = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      assert.equal(startA2.statusCode, 200);
      const completeA2 = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-2',
          state: startA2.body.state,
          codeVerifier: startA2.body.codeVerifier,
        },
      });
      assert.equal(completeA2.statusCode, 200, JSON.stringify(completeA2.body));
      assert.equal(completeA2.body.userId, forgedIdentity.body.userId);
      assert.equal(completeA2.body.workspaceId, forgedIdentity.body.workspaceId);
      const aliceWsCount = await pool.query(
        `select count(*)::int as n from workspace_memberships where user_id = $1 and status = 'active'`,
        [completeA2.body.userId],
      );
      assert.equal(aliceWsCount.rows[0].n, 1);

      // Bob is isolated.
      const startB = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      const completeB = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-bob-1',
          state: startB.body.state,
          codeVerifier: startB.body.codeVerifier,
        },
      });
      assert.equal(completeB.statusCode, 200, JSON.stringify(completeB.body));
      assert.notEqual(completeB.body.userId, completeA2.body.userId);
      assert.notEqual(completeB.body.workspaceId, completeA2.body.workspaceId);

      // Seed task in Alice workspace; Bob must not read via Phase 1 tasks.
      await pool.query(
        `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id)
         values ('task-alice-only', 'Alice secret', 'open', 'A', '', '', '', '{}'::jsonb, $1)`,
        [completeA2.body.workspaceId],
      );
      const bobTasks = await dispatch(baseUrl, {
        method: 'GET',
        path: '/api/phase1/tasks',
        headers: { authorization: `Bearer ${completeB.body.accessToken}` },
      });
      assert.equal(bobTasks.statusCode, 200);
      const bobIds = (bobTasks.body.tasks || []).map((t) => t.id);
      assert.equal(bobIds.includes('task-alice-only'), false);

      const aliceTasks = await dispatch(baseUrl, {
        method: 'GET',
        path: '/api/phase1/tasks',
        headers: { authorization: `Bearer ${completeA2.body.accessToken}` },
      });
      assert.equal(aliceTasks.statusCode, 200);
      assert.ok((aliceTasks.body.tasks || []).some((t) => t.id === 'task-alice-only'));

      // Forged state rejected.
      const startForge = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      const forgedState = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-2',
          state: 'forged-state-value',
          codeVerifier: startForge.body.codeVerifier,
        },
      });
      assert.ok(forgedState.statusCode === 401 || forgedState.statusCode === 400, JSON.stringify(forgedState.body));
      assert.equal(forgedState.body.ok, false);

      // Verifier mismatch rejected.
      const startVer = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      const badVer = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-2',
          state: startVer.body.state,
          codeVerifier: 'wrong-verifier-value',
        },
      });
      assert.ok(badVer.statusCode === 401 || badVer.statusCode === 400, JSON.stringify(badVer.body));
      assert.equal(badVer.body.ok, false);

      // Expired transaction rejected.
      const startExp = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      await pool.query(
        `update desktop_login_transactions set expires_at = now() - interval '1 minute' where id = $1`,
        [startExp.body.transactionId],
      );
      const expired = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-2',
          state: startExp.body.state,
          codeVerifier: startExp.body.codeVerifier,
        },
      });
      assert.ok(expired.statusCode === 401 || expired.statusCode === 400, JSON.stringify(expired.body));
      assert.equal(expired.body.ok, false);

      // Concurrent completion: only one winner.
      const startConc = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      const bodyConc = {
        code: 'code-alice-2',
        state: startConc.body.state,
        codeVerifier: startConc.body.codeVerifier,
      };
      const [c1, c2] = await Promise.all([
        dispatch(baseUrl, { method: 'POST', path: '/api/phase1/auth/desktop/complete', body: bodyConc }),
        dispatch(baseUrl, { method: 'POST', path: '/api/phase1/auth/desktop/complete', body: bodyConc }),
      ]);
      const statuses = [c1.statusCode, c2.statusCode].sort();
      const winners = [c1, c2].filter((r) => r.statusCode === 200 && r.body && r.body.ok && r.body.accessToken);
      const losers = [c1, c2].filter((r) => !(r.statusCode === 200 && r.body && r.body.ok && r.body.accessToken));
      assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify({ statuses, c1: c1.body, c2: c2.body })}`);
      assert.equal(losers.length, 1);

      // Exchange failure does not issue session.
      const failAuthKit = createFakeAuthKit({
        usersByCode,
        failCodes: new Set(['code-fail']),
      });
      const failRuntime = createConfiguredRuntime(pool, failAuthKit);
      await withPhase1Server(failRuntime, async ({ baseUrl: failUrl }) => {
        const startFail = await dispatch(failUrl, {
          method: 'POST',
          path: '/api/phase1/auth/desktop/start',
          body: {},
        });
        const failComplete = await dispatch(failUrl, {
          method: 'POST',
          path: '/api/phase1/auth/desktop/complete',
          body: {
            code: 'code-fail',
            state: startFail.body.state,
            codeVerifier: startFail.body.codeVerifier,
          },
        });
        assert.ok(failComplete.statusCode >= 400, JSON.stringify(failComplete.body));
        assert.equal(failComplete.body.ok, false);
        assert.equal(failComplete.body.accessToken, undefined);
      });

      // Multi-membership selection path: cannot auto-bind forged workspace.
      const multiUserId = completeA2.body.userId;
      await pool.query(
        `insert into workspaces (id, name, status) values ('ws-extra-alice', 'Extra', 'active')
         on conflict (id) do nothing`,
      );
      await pool.query(
        `insert into workspace_memberships (id, user_id, workspace_id, role, status)
         values ('mem-extra-alice', $1, 'ws-extra-alice', 'member', 'active')
         on conflict (id) do nothing`,
        [multiUserId],
      );
      const startMulti = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/start',
        body: {},
      });
      const multiComplete = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/complete',
        body: {
          code: 'code-alice-2',
          state: startMulti.body.state,
          codeVerifier: startMulti.body.codeVerifier,
          workspaceId: 'ws-extra-alice',
        },
      });
      assert.equal(multiComplete.statusCode, 200, JSON.stringify(multiComplete.body));
      assert.equal(multiComplete.body.needsWorkspaceSelection, true);
      assert.ok(multiComplete.body.selectionToken);
      assert.ok(Array.isArray(multiComplete.body.workspaces));
      assert.equal(multiComplete.body.accessToken, undefined);
      const choiceIds = multiComplete.body.workspaces.map((w) => w.id).sort();
      assert.deepEqual(choiceIds, [completeA2.body.workspaceId, 'ws-extra-alice'].sort());

      // Forged selection workspace rejected.
      const badSelect = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/select-workspace',
        body: {
          selectionToken: multiComplete.body.selectionToken,
          workspaceId: 'ws-not-mine',
        },
      });
      assert.ok(badSelect.statusCode === 401 || badSelect.statusCode === 403 || badSelect.statusCode === 400);
      assert.equal(badSelect.body.ok, false);

      const goodSelect = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/select-workspace',
        body: {
          selectionToken: multiComplete.body.selectionToken,
          workspaceId: completeA2.body.workspaceId,
        },
      });
      assert.equal(goodSelect.statusCode, 200, JSON.stringify(goodSelect.body));
      assert.equal(goodSelect.body.workspaceId, completeA2.body.workspaceId);
      assert.ok(goodSelect.body.accessToken);

      // Selection token one-use.
      const selectReplay = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/desktop/select-workspace',
        body: {
          selectionToken: multiComplete.body.selectionToken,
          workspaceId: completeA2.body.workspaceId,
        },
      });
      assert.ok(selectReplay.statusCode >= 400);
      assert.equal(selectReplay.body.ok, false);

      // Public /session still requires trusted verifier (not Desktop public login).
      const publicSession = await dispatch(baseUrl, {
        method: 'POST',
        path: '/api/phase1/auth/session',
        body: { providerSubject: 'workos_user_alice', provider: 'workos' },
      });
      assert.ok(publicSession.statusCode === 503 || publicSession.statusCode === 401);
      assert.equal(publicSession.body.ok, false);
    });
  });
});

test('desktop login helper hashes are deterministic and redirect is fixed', () => {
  assert.equal(DESKTOP_LOGIN_REDIRECT_URI, 'agent-calendar://auth/callback');
  assert.equal(hashDesktopLoginSecret('abc'), hashDesktopLoginSecret('abc'));
  assert.notEqual(hashDesktopLoginSecret('abc'), hashDesktopLoginSecret('abd'));
});
