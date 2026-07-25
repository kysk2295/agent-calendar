'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const { runMigrations } = require('../../backend/app/db/migrate');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');
const { createPhase1Runtime } = require('../../backend/app/lib/phase1-auth-routes');
const { resolvePostgresBinDir } = require('../../backend/app/lib/phase0-snapshot-restore');
const { issueSessionForVerifiedSubject } = require('../../backend/app/lib/workspace-auth-session');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const artifactDir = path.join(desktopRoot, 'test-results', 'phase5-knowledge-v2');
const evidencePath = path.join(repoRoot, 'docs/operations/evidence/2026-07-24-phase5-knowledge-v2.json');
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 300_000);
const LOCAL_ROLE = 'phase5e2e';
const DATABASE = 'phase5_e2e';
const KNOWLEDGE_KEY = '8a174bf6e2a5f7cf733bfa4ecefc145b2df58bf9645358529ed251758224094e';
const userDataNames = {
  a: `Agent Calendar Phase5 A ${process.pid}`,
  b: `Agent Calendar Phase5 B ${process.pid}`,
};
const shots = {
  workspaceA: path.join(artifactDir, '01-workspace-a-answer.png'),
  workspaceB: path.join(artifactDir, '02-workspace-b-isolated.png'),
  revoked: path.join(artifactDir, '03-workspace-a-revoked.png'),
  restarted: path.join(artifactDir, '04-workspace-a-restarted.png'),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
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

async function waitForPostgres(binDir, socketDir, port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      runBin(binDir, 'pg_isready', [
        '-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE,
      ], { timeout: 2_000 });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('Postgres did not become ready');
}

function stopCluster(binDir, dataDir) {
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
  } catch {
    // Best-effort cleanup for an isolated test cluster.
  }
}

async function startPostgres() {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('Postgres binaries missing');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-ete-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  runBin(binDir, 'initdb', [
    '-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8',
  ], { timeout: 60_000 });
  runBin(binDir, 'pg_ctl', [
    '-D', dataDir,
    '-l', logFile,
    '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
    'start',
  ], { timeout: 30_000 });
  await waitForPostgres(binDir, socketDir, port);
  runBin(binDir, 'createdb', [
    '-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE, DATABASE,
  ], { timeout: 15_000 });
  const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${DATABASE}?host=${encodeURIComponent(socketDir)}&port=${port}`;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
  await runMigrations({ pool });
  return { binDir, workDir, dataDir, pool, connectionString };
}

function createAuthKitState() {
  let account = 'a';
  let lastStart = null;
  return {
    select(next) {
      account = next;
    },
    lastStart() {
      return lastStart;
    },
    authKit: {
      async getAuthorizationUrlWithPKCE({ state }) {
        lastStart = { state, account, codeVerifier: `v_${account}_${Date.now()}` };
        return {
          url: `https://authkit.test/authorize?state=${state}`,
          codeVerifier: lastStart.codeVerifier,
        };
      },
      async authenticateWithCodeAndVerifier() {
        return {
          user: {
            id: `workos_phase5_${account}`,
            email: `phase5-${account}@example.com`,
            firstName: `Phase5-${account.toUpperCase()}`,
            lastName: 'Owner',
            emailVerified: true,
          },
        };
      },
    },
  };
}

function phase5Env() {
  return {
    ...process.env,
    WORKSPACE_AUTH_MODE: 'production',
    KNOWLEDGE_V2_ENABLED: '1',
    KNOWLEDGE_ENCRYPTION_KEY: KNOWLEDGE_KEY,
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
  };
}

async function startHttpServer({ pool, authKit, fixedPort = null }) {
  const env = phase5Env();
  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_phase5', apiKeyConfigured: true },
    env,
  });
  const server = createRailwayGatewayServer({
    env,
    phase1Runtime: runtime,
    phase1Pool: pool,
    gatewayStore: { getState: () => ({ tasks: [], events: [] }), ready: Promise.resolve() },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const baseUrl = await new Promise((resolve) => {
    const onListen = () => resolve(`http://127.0.0.1:${server.address().port}`);
    if (fixedPort) server.listen(fixedPort, '127.0.0.1', onListen);
    else server.listen(0, '127.0.0.1', onListen);
  });
  return {
    baseUrl,
    runtime,
    async close() {
      runtime.durableExecution.stopBackgroundWorkers();
      const closing = new Promise((resolve) => server.close(() => resolve()));
      const forceTimer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, 500);
      await closing;
      clearTimeout(forceTimer);
    },
  };
}

function userDataPath(account) {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    userDataNames[account],
  );
}

function prepareUserData(account, apiBaseUrl) {
  const userData = userDataPath(account);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: 'default',
    auth: null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);
  return userData;
}

function updateApiBase(account, apiBaseUrl) {
  const settingsPath = path.join(userDataPath(account), 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    ...settings,
    apiBaseUrl,
    apiToken: '',
  }, null, 2)}\n`);
}

async function launchApp(account, apiBaseUrl) {
  updateApiBase(account, apiBaseUrl);
  const mainJs = path.join(desktopRoot, 'dist-electron', 'main.js');
  assert.ok(fs.existsSync(mainJs), 'build desktop first');
  const electronPath = require('electron');
  return electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : undefined,
    args: [mainJs],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENT_CALENDAR_USER_DATA_NAME: userDataNames[account],
      AGENT_CALENDAR_E2E_AUTH: '1',
      VITE_DEV_SERVER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
}

async function receiveAuthUrl(app, url) {
  return app.evaluate(async (_electron, callbackUrl) => {
    const bridge = globalThis.__agentCalendarE2E;
    if (!bridge) throw new Error('E2E bridge missing');
    return bridge.receiveAuthUrl(callbackUrl);
  }, url);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closeApp(app) {
  if (!app) return;
  let pid = null;
  try {
    pid = app.process().pid;
  } catch {
    // Process may already be closed.
  }
  try {
    await app.evaluate(async ({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  } catch {
    // Process may already be closed.
  }
  try {
    await Promise.race([app.close(), sleep(2_000)]);
  } catch {
    // Best-effort close.
  }
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Best-effort cleanup.
    }
    await sleep(300);
  }
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best-effort cleanup.
    }
  }
  await sleep(350);
}

async function login(app, authState, account) {
  const page = await app.firstWindow();
  await page.waitForFunction(() => (
    Boolean(document.querySelector('.nav-item'))
    || Array.from(document.querySelectorAll('button'))
      .some((button) => /AuthKit으로 계속하기/.test(button.textContent || ''))
  ), null, { timeout: 25_000 });
  const loginButton = page.getByRole('button', { name: /AuthKit으로 계속하기/ });
  if (await loginButton.count()) {
    authState.select(account);
    await loginButton.click();
    await page.waitForTimeout(350);
    const pending = authState.lastStart();
    assert.equal(pending.account, account);
    await receiveAuthUrl(
      app,
      `agent-calendar://auth/callback?code=phase5-${account}&state=${encodeURIComponent(pending.state)}`,
    );
    await page.waitForFunction(
      () => !Array.from(document.querySelectorAll('button'))
        .some((button) => /AuthKit으로 계속하기/.test(button.textContent || '')),
      null,
      { timeout: 25_000 },
    );
  }
  await page.waitForSelector('.nav-item', { timeout: 25_000 }).catch(async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(`Desktop navigation did not render after login: ${body.slice(0, 1200)}`);
  });
  const wikiNav = page.locator('.nav-item', { hasText: '위키' }).first();
  if (!await wikiNav.isVisible()) await page.locator('.nav-more > summary').click();
  await wikiNav.click();
  await page.waitForSelector('[data-testid="knowledge-source-panel"]', { timeout: 25_000 });
  return page;
}

async function sessionFor(pool, account) {
  const session = await issueSessionForVerifiedSubject(pool, {
    provider: 'workos',
    providerSubject: `workos_phase5_${account}`,
  });
  return {
    token: session.accessToken,
    workspaceId: session.workspaceId,
  };
}

async function httpJson(baseUrl, method, pathname, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

async function uploadKnowledge(page, filePath, expectedMarker) {
  await page.locator('.knowledge-cloud-consent input').check();
  await page.locator('.knowledge-file-add input').setInputFiles(filePath);
  await page.waitForFunction(
    (marker) => {
      const panel = document.querySelector('[data-testid="knowledge-source-panel"]');
      return panel && /shared\.md/.test(panel.textContent || '')
        && /사용 가능/.test(panel.textContent || '')
        && new RegExp(marker).test(document.body.innerText) === false;
    },
    expectedMarker,
    { timeout: 30_000 },
  );
}

async function askWiki(page, question, expected) {
  const input = page.locator('.askbar input');
  await input.fill(question);
  await page.locator('.askbar > button').click();
  await page.waitForFunction(
    (pattern) => {
      const answer = document.querySelector('.wiki-answer');
      return answer && new RegExp(pattern, 'i').test(answer.textContent || '');
    },
    expected,
    { timeout: 30_000 },
  );
  return page.locator('.wiki-answer').innerText();
}

function fileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  const startedAt = Date.now();
  let pg = null;
  let http = null;
  let appA = null;
  let appB = null;
  let hardTimeout = null;
  const results = {
    schemaVersion: 1,
    slice: 'phase5-knowledge-v2',
    date: '2026-07-24',
    status: 'running',
  };

  hardTimeout = setTimeout(() => {
    if (pg) stopCluster(pg.binDir, pg.dataDir);
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    for (const shot of Object.values(shots)) fs.rmSync(shot, { force: true });
    execFileSync('npm', ['run', 'build'], {
      cwd: desktopRoot,
      stdio: 'inherit',
      timeout: 180_000,
    });
    pg = await startPostgres();
    const authState = createAuthKitState();
    http = await startHttpServer({ pool: pg.pool, authKit: authState.authKit });
    const fixedPort = Number(new URL(http.baseUrl).port);
    prepareUserData('a', http.baseUrl);
    prepareUserData('b', http.baseUrl);

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-files-'));
    const fixtureA = path.join(fixtureRoot, 'a');
    const fixtureB = path.join(fixtureRoot, 'b');
    fs.mkdirSync(fixtureA);
    fs.mkdirSync(fixtureB);
    const fileA = path.join(fixtureA, 'shared.md');
    const fileB = path.join(fixtureB, 'shared.md');
    fs.writeFileSync(fileA, '# Workspace A\nalpha-only launch checklist for account A\n');
    fs.writeFileSync(fileB, '# Workspace B\nbeta-only operations checklist for account B\n');

    appA = await launchApp('a', http.baseUrl);
    let pageA = await login(appA, authState, 'a');
    await uploadKnowledge(pageA, fileA, 'alpha-only');
    const answerA = await askWiki(pageA, 'alpha-only', 'alpha-only');
    assert.doesNotMatch(answerA, /beta-only/);
    assert.ok(await pageA.locator('.wiki-answer-sources button').count() >= 1);
    await pageA.screenshot({ path: shots.workspaceA, fullPage: true });
    const sessionA = await sessionFor(pg.pool, 'a');
    const apiAnswerA = await httpJson(http.baseUrl, 'POST', '/api/knowledge/ask', {
      token: sessionA.token,
      body: { question: 'alpha-only', requestId: 'ete-a-evidence' },
    });
    assert.equal(apiAnswerA.status, 200, JSON.stringify(apiAnswerA.json));
    const evidenceA = apiAnswerA.json.citations?.[0]?.handle;
    const sourceAId = apiAnswerA.json.citations?.[0]?.sourceId;
    assert.ok(evidenceA);
    assert.ok(sourceAId);
    await closeApp(appA);
    appA = null;

    appB = await launchApp('b', http.baseUrl);
    const pageB = await login(appB, authState, 'b');
    await uploadKnowledge(pageB, fileB, 'beta-only');
    const answerB = await askWiki(pageB, 'beta-only', 'beta-only');
    assert.doesNotMatch(answerB, /alpha-only/);
    await pageB.screenshot({ path: shots.workspaceB, fullPage: true });
    const sessionB = await sessionFor(pg.pool, 'b');
    const crossEvidence = await httpJson(
      http.baseUrl,
      'GET',
      `/api/knowledge/evidence/${encodeURIComponent(evidenceA)}`,
      { token: sessionB.token },
    );
    assert.ok(crossEvidence.status === 403 || crossEvidence.status === 404);
    const alphaFromB = await httpJson(http.baseUrl, 'POST', '/api/knowledge/ask', {
      token: sessionB.token,
      body: { question: 'alpha-only', requestId: 'ete-b-alpha-probe' },
    });
    assert.equal(alphaFromB.status, 200);
    assert.ok(
      (alphaFromB.json.citations || []).every((citation) => citation.sourceId !== sourceAId),
    );
    assert.doesNotMatch(JSON.stringify(alphaFromB.json), /launch checklist for account A/i);
    await closeApp(appB);
    appB = null;

    appA = await launchApp('a', http.baseUrl);
    pageA = await login(appA, authState, 'a');
    const sourceCard = pageA.locator('.knowledge-source-list article', { hasText: 'shared.md' }).first();
    await sourceCard.getByRole('button', { name: '연결 해제' }).click();
    await pageA.waitForFunction(() => {
      const panel = document.querySelector('[data-testid="knowledge-source-panel"]');
      return panel && /연결 해제됨/.test(panel.textContent || '');
    }, null, { timeout: 20_000 });
    await pageA.locator('.wiki-answer-dismiss').click().catch(() => {});
    const revokedAnswer = await askWiki(pageA, 'alpha-only', 'No workspace knowledge|답을 찾지 못');
    assert.doesNotMatch(revokedAnswer, /launch checklist/);
    await pageA.screenshot({ path: shots.revoked, fullPage: true });
    await closeApp(appA);
    appA = null;

    await http.close();
    http = await startHttpServer({
      pool: pg.pool,
      authKit: authState.authKit,
      fixedPort,
    });
    appA = await launchApp('a', http.baseUrl);
    pageA = await login(appA, authState, 'a');
    await pageA.waitForFunction(() => {
      const panel = document.querySelector('[data-testid="knowledge-source-panel"]');
      return panel && /shared\.md/.test(panel.textContent || '') && /연결 해제됨/.test(panel.textContent || '');
    }, null, { timeout: 30_000 });
    await pageA.screenshot({ path: shots.restarted, fullPage: true });

    const sourcesA = await httpJson(http.baseUrl, 'GET', '/api/knowledge/sources', { token: sessionA.token });
    const sourcesB = await httpJson(http.baseUrl, 'GET', '/api/knowledge/sources', { token: sessionB.token });
    assert.equal(sourcesA.status, 200);
    assert.equal(sourcesB.status, 200);
    assert.equal(sourcesA.json.sources.length, 1);
    assert.equal(sourcesB.json.sources.length, 1);
    assert.equal(sourcesA.json.sources[0].status, 'revoked');
    assert.equal(sourcesB.json.sources[0].status, 'ready');
    assert.notEqual(sourcesA.json.sources[0].workspaceId, sourcesB.json.sources[0].workspaceId);

    for (const filePath of Object.values(shots)) {
      assert.ok(fs.existsSync(filePath));
      assert.ok(fs.statSync(filePath).size > 5_000);
    }
    const screenshotHashes = Object.fromEntries(
      Object.entries(shots).map(([name, filePath]) => [name, fileHash(filePath)]),
    );
    assert.ok(new Set(Object.values(screenshotHashes)).size >= 3);

    const plaintext = await pg.pool.query(
      `select
         (select count(*)::int from knowledge_chunks
          where content like '%alpha-only%' or excerpt like '%alpha-only%') as chunk_plain,
         (select count(*)::int from knowledge_evidence_handles
          where excerpt like '%alpha-only%') as evidence_plain,
         (select count(*)::int from knowledge_answer_cache
          where answer like '%alpha-only%') as cache_plain`,
    );
    assert.deepEqual(plaintext.rows[0], {
      chunk_plain: 0,
      evidence_plain: 0,
      cache_plain: 0,
    });

    results.status = 'verified';
    results.durationMs = Date.now() - startedAt;
    results.workspaces = {
      a: sessionA.workspaceId,
      b: sessionB.workspaceId,
    };
    results.crossEvidenceStatus = crossEvidence.status;
    results.screenshotHashes = screenshotHashes;
    results.restart = 'revoked source remained visible and inactive';
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await closeApp(appA).catch(() => {});
    await closeApp(appB).catch(() => {});
    if (http) await http.close().catch(() => {});
    if (pg) {
      await pg.pool.end().catch(() => {});
      stopCluster(pg.binDir, pg.dataDir);
      fs.rmSync(pg.workDir, { recursive: true, force: true });
    }
    clearTimeout(hardTimeout);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
