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
const artifactDir = path.join(desktopRoot, 'test-results', 'phase6-calendar-ai');
const evidencePath = path.join(repoRoot, 'docs/operations/evidence/2026-07-24-phase6-calendar-ai.json');
const LOCAL_ROLE = 'phase6e2e';
const DATABASE = 'phase6_e2e';
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 300_000);
const userDataNames = {
  a: `Agent Calendar Phase6 A ${process.pid}`,
  b: `Agent Calendar Phase6 B ${process.pid}`,
};
const shots = {
  action: path.join(artifactDir, '01-workspace-a-action.png'),
  memory: path.join(artifactDir, '02-workspace-a-memory.png'),
  isolated: path.join(artifactDir, '03-workspace-b-isolated.png'),
  restarted: path.join(artifactDir, '04-workspace-a-restarted.png'),
  forgotten: path.join(artifactDir, '05-workspace-a-forgotten.png'),
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
    return;
  }
}

async function startPostgres() {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('Postgres binaries missing');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-ete-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  runBin(binDir, 'initdb', [
    '-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8',
  ], { timeout: 60_000 });
  runBin(binDir, 'pg_ctl', [
    '-D', dataDir,
    '-l', path.join(workDir, 'postgres.log'),
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
  return { binDir, workDir, dataDir, pool };
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
            id: `workos_phase6_${account}`,
            email: `phase6-${account}@example.com`,
            firstName: `Phase6-${account.toUpperCase()}`,
            lastName: 'Owner',
            emailVerified: true,
          },
        };
      },
    },
  };
}

function phase6Env() {
  return {
    ...process.env,
    WORKSPACE_AUTH_MODE: 'production',
    CALENDAR_AI_V2_ENABLED: '1',
    CALENDAR_AI_ACTIONS_ENABLED: '1',
    CALENDAR_AI_CLOUD_MODEL_ENABLED: '1',
    KNOWLEDGE_V2_ENABLED: '0',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_EXTERNAL_ENABLED: '0',
  };
}

async function startHttpServer({ pool, authKit, fixedPort = null }) {
  const env = phase6Env();
  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_phase6', apiKeyConfigured: true },
    calendarAiModelAdapter: {
      async complete(input) {
        const context = input.context || {};
        const memory = Array.isArray(context.memories) && context.memories.length
          ? ` 기억 반영: ${context.memories.map((item) => item.value).join(', ')}`
          : '';
        return {
          text: `자연 대화 응답: ${input.messages.at(-1).content}${memory}`,
          provider: 'fake-calendar-ai',
          model: 'fake-ete-1',
        };
      },
    },
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
      runtime.unifiedCalendar.stopBackgroundWorkers();
      const closing = new Promise((resolve) => server.close(() => resolve()));
      const timer = setTimeout(() => server.closeAllConnections?.(), 500);
      await closing;
      clearTimeout(timer);
    },
  };
}

function userDataPath(account) {
  return path.join(os.homedir(), 'Library', 'Application Support', userDataNames[account]);
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

async function closeApp(app) {
  if (!app) return;
  let pid = null;
  try {
    pid = app.process().pid;
  } catch {
    pid = null;
  }
  await Promise.race([
    app.evaluate(async ({ app: electronApp }) => electronApp.exit(0)).catch(() => {}),
    sleep(1_000),
  ]);
  await Promise.race([app.close().catch(() => {}), sleep(2_000)]);
  if (pid) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  await sleep(500);
  if (pid) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
  }
  await sleep(200);
}

async function login(app, authState, account) {
  const page = await app.firstWindow();
  await page.waitForFunction(() => (
    Boolean(document.querySelector('.nav-item'))
    || Array.from(document.querySelectorAll('button'))
      .some((button) => /AuthKit으로 계속하기|Google 또는 이메일로 계속하기/.test(button.textContent || '') || button.getAttribute('data-testid') === 'login-authkit-continue')
  ), null, { timeout: 25_000 });
  const loginButton = page.getByRole('button', { name: /AuthKit으로 계속하기|Google 또는 이메일로 계속하기/ });
  if (await loginButton.count()) {
    authState.select(account);
    await loginButton.click();
    await page.waitForTimeout(300);
    const pending = authState.lastStart();
    assert.equal(pending.account, account);
    await receiveAuthUrl(
      app,
      `agent-calendar://auth/callback?code=phase6-${account}&state=${encodeURIComponent(pending.state)}`,
    );
  }
  await page.waitForSelector('.nav-item', { timeout: 25_000 });
  return page;
}

async function openCalendarAi(page) {
  const button = page.locator('.chat-fab');
  if (!await page.locator('.chat').count()) await button.click();
  await page.waitForSelector('.chat textarea', { timeout: 10_000 });
}

async function sendChat(page, message, expected) {
  const before = await page.locator('.message').count();
  await page.locator('.chat textarea').fill(message);
  await page.locator('.chat footer button', { hasText: '전송' }).click();
  await page.waitForFunction(
    ({ count, pattern }) => {
      const messages = Array.from(document.querySelectorAll('.message'));
      return messages.length >= count + 2
        && new RegExp(pattern).test(messages.at(-1)?.textContent || '');
    },
    { count: before, pattern: expected },
    { timeout: 30_000 },
  );
}

async function sessionFor(pool, account) {
  return issueSessionForVerifiedSubject(pool, {
    provider: 'workos',
    providerSubject: `workos_phase6_${account}`,
  });
}

async function httpJson(baseUrl, method, pathname, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { 'content-type': 'application/json' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
  };
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
  const hardTimeout = setTimeout(() => {
    if (pg) stopCluster(pg.binDir, pg.dataDir);
    process.exit(2);
  }, HARD_TIMEOUT_MS);
  const evidence = {
    schemaVersion: 1,
    slice: 'phase6-calendar-ai',
    date: '2026-07-24',
    status: 'running',
  };

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

    appA = await launchApp('a', http.baseUrl);
    let pageA = await login(appA, authState, 'a');
    await openCalendarAi(pageA);
    await sendChat(pageA, '오늘 기분이 조금 복잡해', '자연 대화 응답');
    await sendChat(pageA, '집중 업무는 오전에 하는 걸 선호한다고 기억해줘', '개인 기억에 저장');
    await pageA.locator('.calendar-ai-memory-toggle').click();
    await pageA.waitForSelector('.calendar-ai-memory-row');
    assert.match(
      await pageA.locator('.calendar-ai-memory-row input').inputValue(),
      /집중 업무/,
    );
    await pageA.screenshot({ path: shots.memory, fullPage: true });
    await pageA.locator('.calendar-ai-memory-toggle').click();

    await sendChat(pageA, '내일 오전 10시에 팀 회의 일정을 만들어줘', '승인 전 초안');
    const createCard = pageA.locator('.calendar-ai-action').last();
    await createCard.waitFor();
    await pageA.screenshot({ path: shots.action, fullPage: true });
    await createCard.getByRole('button', { name: '승인하고 실행' }).click();
    await createCard.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
    await pageA.waitForFunction(() => (
      Array.from(document.querySelectorAll('.calendar-ai-action'))
        .some((card) => /실행 완료/.test(card.textContent || ''))
    ), null, { timeout: 30_000 });

    await sendChat(pageA, '경쟁사 세 곳 조사를 에이전트에게 위임해줘', '승인 전 초안');
    const workCard = pageA.locator('.calendar-ai-action').last();
    await workCard.getByRole('button', { name: '승인하고 실행' }).click();
    await pageA.waitForFunction(() => (
      Array.from(document.querySelectorAll('.calendar-ai-action'))
        .some((card) => /에이전트에게 위임/.test(card.textContent || '') && /실행 완료/.test(card.textContent || ''))
    ), null, { timeout: 30_000 });

    const sessionA = await sessionFor(pg.pool, 'a');
    const conversationA = await httpJson(http.baseUrl, 'GET', '/api/calendar-ai/conversations', {
      token: sessionA.accessToken,
    });
    assert.equal(conversationA.status, 200);
    const conversationAId = conversationA.json.conversations[0].id;
    await closeApp(appA);
    appA = null;

    appB = await launchApp('b', http.baseUrl);
    const pageB = await login(appB, authState, 'b');
    await openCalendarAi(pageB);
    await sendChat(pageB, '내일 일정 모두 알려줘', '내일 일정은 없습니다');
    await pageB.locator('.calendar-ai-memory-toggle').click();
    assert.equal(await pageB.locator('.calendar-ai-memory-row').count(), 0);
    await pageB.screenshot({ path: shots.isolated, fullPage: true });
    const sessionB = await sessionFor(pg.pool, 'b');
    const crossConversation = await httpJson(
      http.baseUrl,
      'GET',
      `/api/calendar-ai/conversations/${encodeURIComponent(conversationAId)}`,
      { token: sessionB.accessToken },
    );
    assert.equal(crossConversation.status, 404);
    await closeApp(appB);
    appB = null;

    await http.close();
    http = await startHttpServer({
      pool: pg.pool,
      authKit: authState.authKit,
      fixedPort,
    });
    appA = await launchApp('a', http.baseUrl);
    pageA = await login(appA, authState, 'a');
    await openCalendarAi(pageA);
    await pageA.waitForFunction(() => (
      /팀 회의/.test(document.body.innerText)
      && /에이전트에게 위임/.test(document.body.innerText)
    ), null, { timeout: 30_000 });
    await pageA.screenshot({ path: shots.restarted, fullPage: true });
    await pageA.locator('.calendar-ai-memory-toggle').click();
    const memoryRow = pageA.locator('.calendar-ai-memory-row[data-status="active"]').first();
    await memoryRow.getByRole('button', { name: '잊기' }).click();
    await pageA.waitForSelector('.calendar-ai-memory-row[data-status="forgotten"]');
    await pageA.screenshot({ path: shots.forgotten, fullPage: true });

    const counts = await pg.pool.query(
      `select
         (select count(*)::int from calendar_ai_conversations where workspace_id = $1) as conversations_a,
         (select count(*)::int from calendar_ai_conversations where workspace_id = $2) as conversations_b,
         (select count(*)::int from calendar_events where workspace_id = $1 and title = '팀 회의') as events_a,
         (select count(*)::int from calendar_events where workspace_id = $2 and title = '팀 회의') as events_b,
         (select count(*)::int from execution_jobs where workspace_id = $1) as jobs_a,
         (select count(*)::int from execution_jobs where workspace_id = $2) as jobs_b,
         (select count(*)::int from calendar_ai_memories where workspace_id = $1 and status = 'forgotten') as forgotten_a`,
      [sessionA.workspaceId, sessionB.workspaceId],
    );
    assert.deepEqual(counts.rows[0], {
      conversations_a: 1,
      conversations_b: 1,
      events_a: 1,
      events_b: 0,
      jobs_a: 1,
      jobs_b: 0,
      forgotten_a: 1,
    });

    for (const filePath of Object.values(shots)) {
      assert.ok(fs.existsSync(filePath));
      assert.ok(fs.statSync(filePath).size > 5_000);
    }
    const screenshotHashes = Object.fromEntries(
      Object.entries(shots).map(([name, filePath]) => [name, fileHash(filePath)]),
    );
    assert.ok(new Set(Object.values(screenshotHashes)).size >= 4);
    evidence.status = 'verified';
    evidence.durationMs = Date.now() - startedAt;
    evidence.workspaces = { a: sessionA.workspaceId, b: sessionB.workspaceId };
    evidence.crossConversationStatus = crossConversation.status;
    evidence.counts = counts.rows[0];
    evidence.screenshotHashes = screenshotHashes;
    evidence.restart = 'conversation, action receipts, and memory survived server and Desktop restart';
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await closeApp(appA).catch(() => {});
    await closeApp(appB).catch(() => {});
    if (http) {
      await Promise.race([
        http.close().catch(() => {}),
        sleep(2_000),
      ]);
    }
    if (pg) {
      await Promise.race([
        pg.pool.end().catch(() => {}),
        sleep(2_000),
      ]);
      stopCluster(pg.binDir, pg.dataDir);
      fs.rmSync(pg.workDir, { recursive: true, force: true });
    }
    clearTimeout(hardTimeout);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
