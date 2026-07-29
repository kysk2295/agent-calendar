'use strict';

/**
 * Electron E2E: production Workspace cutover with fake AuthKit + real gateway + ephemeral PG.
 * Single process, hard timeout, deterministic cleanup.
 *
 * Flow: clean login → calendar/task/wiki/agent-work/automation mutations → SSE → restart restore
 * Backend-layer second-account isolation is asserted against the same production server.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const { runMigrations } = require('../../backend/app/db/migrate');
const { defaultRunBin: runBin } = require('../../backend/app/lib/local-postgres-lifecycle');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');
const { createPhase1Runtime } = require('../../backend/app/lib/phase1-auth-routes');
const { issueSessionForVerifiedSubject } = require('../../backend/app/lib/workspace-auth-session');
const { resolvePostgresBinDir } = require('../../backend/app/lib/phase0-snapshot-restore');

const desktopRoot = path.resolve(__dirname, '..');
const artifactDir = path.join(desktopRoot, 'test-results', 'workos-production-cutover');
const screenshotCalendarPath = path.join(artifactDir, 'calendar-surface.png');
const screenshotWikiPath = path.join(artifactDir, 'wiki-surface.png');
const screenshotAgentPath = path.join(artifactDir, 'agent-work-surface.png');
const userDataName = `Agent Calendar Production Cutover E2E ${process.pid}`;
const userData = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const sessionFile = path.join(userData, 'app-session.enc');
const settingsFile = path.join(userData, 'settings.json');
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 120_000);
const LOCAL_ROLE = 'phase1e2ecutover';
const DATABASE = 'phase1_e2e_cutover';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForReady(binDir, socketDir, port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch {
      await sleep(100);
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

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

function forceKillPid(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function ensureCleanUserData(apiBaseUrl) {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: 'default',
    auth: null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);
}

function assertSettingsHaveNoSecrets() {
  const raw = fs.readFileSync(settingsFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.apiToken || '', '');
  assert.doesNotMatch(raw, /accessToken|refreshToken|idToken/);
}

function assertSecureSessionEncryptedOnDisk() {
  assert.equal(fs.existsSync(sessionFile), true);
  const buf = fs.readFileSync(sessionFile);
  assert.ok(buf.length > 32);
  const asUtf8 = buf.toString('utf8');
  assert.equal(asUtf8.trimStart().startsWith('{'), false);
  assert.doesNotMatch(asUtf8, /accessToken|refreshToken|"userId"/);
}

async function startProductionBackend() {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('PG binaries missing (set PHASE0_PG_BIN)');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-e2e-cutover-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  fs.mkdirSync(socketDir, { recursive: true });
  const pgPort = await freePort();
  runBin(binDir, 'initdb', ['-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8'], { timeout: 60_000 });
  runBin(binDir, 'pg_ctl', [
    '-D', dataDir, '-l', logFile,
    '-o', `-p ${pgPort} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
    'start',
  ], { timeout: 30_000 });
  await waitForReady(binDir, socketDir, pgPort);
  runBin(binDir, 'createdb', ['-h', socketDir, '-p', String(pgPort), '-U', LOCAL_ROLE, DATABASE], { timeout: 15_000 });
  const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${encodeURIComponent(DATABASE)}?host=${encodeURIComponent(socketDir)}&port=${pgPort}`;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
  await runMigrations({ pool });

  // Second account for backend negative checks (not Desktop login).
  await pool.query(`insert into users (id, display_name, status) values
    ('user-b-e2e', 'Blair', 'active') on conflict do nothing`);
  await pool.query(`insert into workspaces (id, name, status) values
    ('ws-b-e2e', 'Workspace B', 'active') on conflict do nothing`);
  await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
    ('mem-b-e2e', 'user-b-e2e', 'ws-b-e2e', 'owner', 'active') on conflict do nothing`);
  await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
    ('id-b-e2e', 'user-b-e2e', 'workos', 'workos_user_b_e2e') on conflict do nothing`);
  await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id) values
    ('task-secret-b', 'B-SECRET-TASK', 'open', 'Blair', '', '', '', '{}'::jsonb, 'ws-b-e2e')`);

  let lastStart = null;
  let completeCount = 0;
  const authKit = {
    async getAuthorizationUrlWithPKCE({ state }) {
      const codeVerifier = `verifier_e2e_${Date.now()}`;
      lastStart = { state, codeVerifier };
      return {
        url: `https://authkit.test/authorize?state=${encodeURIComponent(state)}`,
        codeVerifier,
      };
    },
    async authenticateWithCodeAndVerifier({ code }) {
      if (!code || code === 'forged') {
        const err = new Error('invalid code');
        err.code = 'WORKOS_EXCHANGE_FAILED';
        throw err;
      }
      completeCount += 1;
      return {
        user: {
          id: 'workos_user_a_e2e',
          email: 'e2e-a@example.com',
          firstName: 'E2E',
          lastName: 'Operator',
          emailVerified: true,
        },
      };
    },
  };

  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_e2e_test', apiKeyConfigured: true },
  });

  // Do not set DATABASE_URL — createRailwayGatewayServer would open a second SSL pool.
  // Production product paths use phase1Runtime.pool only; stub store must not hold product data.
  const stubStore = {
    getState: () => ({ tasks: [], agents: [], runs: [], events: [] }),
    ready: Promise.resolve(),
  };
  const server = createRailwayGatewayServer({
    env: {
      WORKSPACE_AUTH_MODE: 'production',
      HERMES_REMOTE_AUTH_TOKEN: 'legacy-must-not-work',
    },
    phase1Runtime: runtime,
    phase1Pool: pool,
    gatewayStore: stubStore,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  const baseUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    baseUrl,
    pool,
    getCompleteCount: () => completeCount,
    getLastStart: () => lastStart,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      try { await pool.end(); } catch { /* ignore */ }
      stopCluster(binDir, dataDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

async function launchApp({ apiBaseUrl }) {
  const mainJs = path.join(desktopRoot, 'dist-electron', 'main.js');
  assert.equal(fs.existsSync(mainJs), true, 'build electron first (dist-electron/main.js missing)');
  fs.mkdirSync(userData, { recursive: true });
  const previous = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    : {};
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: previous.theme || 'default',
    auth: previous.auth || null,
    uiPreferences: previous.uiPreferences || { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);

  const electronPath = require('electron');
  return electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : undefined,
    args: [mainJs],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENT_CALENDAR_USER_DATA_NAME: userDataName,
      AGENT_CALENDAR_E2E_AUTH: '1',
      VITE_DEV_SERVER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
}

async function receiveAuthUrl(electronApp, url) {
  return electronApp.evaluate(async (_electron, callbackUrl) => {
    const bridge = globalThis.__agentCalendarE2E;
    if (!bridge) throw new Error('E2E bridge missing');
    return bridge.receiveAuthUrl(callbackUrl);
  }, url);
}

async function closeApp(electronApp) {
  if (!electronApp) return { pid: null, exited: true };
  let pid = null;
  try { pid = electronApp.process().pid; } catch { pid = null; }
  try {
    await electronApp.evaluate(async ({ app }) => { app.exit(0); }).catch(() => {});
  } catch { /* ignore */ }
  try {
    await Promise.race([electronApp.close(), sleep(2_000)]);
  } catch { /* ignore */ }
  if (pid && pidAlive(pid)) forceKillPid(pid);
  const exited = pid ? await waitForPidExit(pid, 8_000) : true;
  if (!exited && pid) {
    forceKillPid(pid);
    await waitForPidExit(pid, 2_000);
  }
  await sleep(400);
  return { pid, exited: pid ? !pidAlive(pid) : true };
}

async function api(baseUrl, method, urlPath, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function runScenario(backend) {
  ensureCleanUserData(backend.baseUrl);
  let electronApp = await launchApp({ apiBaseUrl: backend.baseUrl });
  let accessTokenA = null;
  let workspaceIdA = null;

  try {
    const page = await electronApp.firstWindow();
    await page.waitForSelector('button:has-text("AuthKit으로 계속하기")', { timeout: 25_000 });

    await page.getByRole('button', { name: /AuthKit으로 계속하기/ }).click();
    await page.waitForTimeout(600);
    const pending = backend.getLastStart();
    assert.ok(pending, 'desktop start must invoke AuthKit');

    const goodUrl = `agent-calendar://auth/callback?code=code-prod-e2e-1&state=${encodeURIComponent(pending.state)}`;
    await receiveAuthUrl(electronApp, goodUrl);

    await page.waitForFunction(() => {
      const loginBtn = Array.from(document.querySelectorAll('button'))
        .some((b) => /AuthKit으로 계속하기/.test(b.textContent || ''));
      return !loginBtn;
    }, null, { timeout: 25_000 });
    await page.waitForTimeout(800);

    assert.equal(backend.getCompleteCount(), 1);
    assertSecureSessionEncryptedOnDisk();
    assertSettingsHaveNoSecrets();

    const sessionStatus = await page.evaluate(async () => window.hermesDesktop?.getSessionStatus?.());
    assert.ok(sessionStatus?.signedIn, `expected signed in: ${JSON.stringify(sessionStatus)}`);
    workspaceIdA = sessionStatus.workspaceId;
    assert.ok(workspaceIdA);

    // Seed Workspace-owned product rows via backend session (renderer never receives tokens).
    const issuedA = await issueSessionForVerifiedSubject(backend.pool, {
      provider: 'workos',
      providerSubject: 'workos_user_a_e2e',
    });
    accessTokenA = issuedA.accessToken;
    assert.equal(issuedA.workspaceId, workspaceIdA);

    const today = new Date();
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(today);
    const seededEventTitle = 'E2E Cutover Event';
    const seededTaskTitle = 'E2E Cutover Task';
    const seededWikiTitle = 'E2E Wiki Note';

    const taskCreate = await api(backend.baseUrl, 'POST', '/api/tasks', {
      token: accessTokenA,
      body: { title: seededTaskTitle, id: 'task-e2e-a1', date: dateKey, status: 'open' },
    });
    assert.equal(taskCreate.status, 200, JSON.stringify(taskCreate.json));

    const eventCreate = await api(backend.baseUrl, 'POST', '/api/calendar/events', {
      token: accessTokenA,
      body: {
        title: seededEventTitle,
        id: 'event-e2e-a1',
        startsAt: `${dateKey} 11:00`,
        date: dateKey,
        time: '11:00',
        kind: 'calendar-event',
      },
    });
    assert.equal(eventCreate.status, 200, JSON.stringify(eventCreate.json));
    assert.equal(eventCreate.json.event.date, dateKey);

    const wikiCreate = await api(backend.baseUrl, 'POST', '/api/documents', {
      token: accessTokenA,
      body: {
        title: seededWikiTitle,
        path: '2_wiki/e2e-cutover.md',
        content: 'workspace private wiki note for E2E Cutover',
        source: 'wiki',
        id: 'doc-e2e-a1',
      },
    });
    assert.equal(wikiCreate.status, 200, JSON.stringify(wikiCreate.json));

    const jobCreate = await api(backend.baseUrl, 'POST', '/api/scheduler/jobs', {
      token: accessTokenA,
      body: { name: 'E2E Automation', id: 'job-e2e-a1' },
    });
    assert.equal(jobCreate.status, 200, JSON.stringify(jobCreate.json));

    const workCreate = await api(backend.baseUrl, 'POST', '/api/agent-operations/work', {
      token: accessTokenA,
      body: { goal: 'E2E delegated work', clientRequestId: 'e2e-cr-1' },
    });
    assert.equal(workCreate.status, 200, JSON.stringify(workCreate.json));
    assert.equal(workCreate.json.status, 'blocked_runner_required');

    // Mail hydrate must be 200 empty, not production_disabled noise.
    const mail = await api(backend.baseUrl, 'GET', '/api/mail/messages?limit=200', { token: accessTokenA });
    assert.equal(mail.status, 200, JSON.stringify(mail.json));

    // Reload renderer so hydrate pulls seeded Workspace data.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const loginBtn = Array.from(document.querySelectorAll('button'))
        .some((b) => /AuthKit으로 계속하기/.test(b.textContent || ''));
      return !loginBtn;
    }, null, { timeout: 25_000 });
    await page.waitForTimeout(1_500);

    async function assertCleanSurface(targetPage, { requireText = [] } = {}) {
      const bodyText = await targetPage.locator('body').innerText();
      assert.doesNotMatch(bodyText, /production_disabled|This route is explicitly disabled/i);
      assert.doesNotMatch(bodyText, /Railway API 확인 필요/i);
      const bannerCount = await targetPage.locator('.api-banner, .api-error, [class*="api-error"]').count();
      assert.equal(bannerCount, 0, `error banner visible: ${bodyText.slice(0, 400)}`);
      for (const text of requireText) {
        assert.match(bodyText, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      return bodyText;
    }

    // Calendar surface — event title must be visible after hydrate.
    const calNav = page.getByRole('button', { name: /캘린더/i }).first();
    if (await calNav.count()) {
      await calNav.click();
      await page.waitForTimeout(600);
    }
    await assertCleanSurface(page, { requireText: [seededEventTitle] });
    await page.screenshot({ path: screenshotCalendarPath, fullPage: true });
    assert.ok(fs.statSync(screenshotCalendarPath).size > 8_000);

    // Wiki surface — seeded note title visible.
    const wikiNav = page.getByRole('button', { name: /위키|Wiki/i }).first();
    if (await wikiNav.count()) {
      await wikiNav.click();
      await page.waitForTimeout(800);
    }
    {
      const wikiBody = await assertCleanSurface(page);
      assert.match(wikiBody, /e2e-cutover|E2E Wiki/i, 'wiki surface must show seeded note');
    }
    await page.screenshot({ path: screenshotWikiPath, fullPage: true });
    assert.ok(fs.statSync(screenshotWikiPath).size > 5_000);

    // Agent-work surface — designed Runner-required, not Hermes/Railway failure.
    const agentNav = page.getByRole('button', { name: /^에이전트$|Agent Work|관제/i }).first();
    if (await agentNav.count()) {
      await agentNav.click();
      await page.waitForTimeout(800);
    } else {
      // Fallback: click sidebar agent item
      await page.locator('button, a, [role="button"]').filter({ hasText: /에이전트/ }).first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const agentText = await assertCleanSurface(page, {});
    assert.doesNotMatch(agentText, /Hermes 스케줄러 확인 필요|Railway API 확인 필요/i);
    assert.match(agentText, /Runner 미연결|Workspace Runner|runner/i);
    await page.screenshot({ path: screenshotAgentPath, fullPage: true });
    assert.ok(fs.statSync(screenshotAgentPath).size > 5_000);

    // SSE + second-account isolation (backend layer)
    const sseRes = await fetch(`${backend.baseUrl}/api/events?waitMs=300`, {
      headers: { authorization: `Bearer ${accessTokenA}`, accept: 'text/event-stream' },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
    const sseText = await sseRes.text();
    assert.match(sseText, new RegExp(workspaceIdA));

    const issuedB = await issueSessionForVerifiedSubject(backend.pool, {
      provider: 'workos',
      providerSubject: 'workos_user_b_e2e',
      workspaceId: 'ws-b-e2e',
    });
    const listB = await api(backend.baseUrl, 'GET', '/api/tasks', { token: issuedB.accessToken });
    assert.equal(listB.status, 200);
    assert.equal((listB.json.tasks || []).some((t) => t.id === 'task-e2e-a1'), false);
    assert.equal((listB.json.tasks || []).some((t) => t.id === 'task-secret-b'), true);
    const foreignWiki = await api(backend.baseUrl, 'POST', '/api/wiki/search', {
      token: issuedB.accessToken,
      body: { query: 'private wiki' },
    });
    assert.equal((foreignWiki.json.results || []).length, 0);

    // Restart restore without re-login
    const close1 = await closeApp(electronApp);
    assert.equal(close1.exited, true);
    electronApp = null;
    assertSecureSessionEncryptedOnDisk();
    assert.equal(backend.getCompleteCount(), 1);

    electronApp = await launchApp({ apiBaseUrl: backend.baseUrl });
    const page2 = await electronApp.firstWindow();
    await page2.waitForTimeout(2_000);
    const restored = await page2.evaluate(async () => window.hermesDesktop?.getSessionStatus?.());
    assert.equal(restored?.signedIn, true, `restart restore failed: ${JSON.stringify(restored)}`);
    assert.equal(restored.workspaceId, workspaceIdA);
    assert.equal(backend.getCompleteCount(), 1, 'restart must not re-complete login');

    // Data still only in workspace A
    const tasksAfter = await api(backend.baseUrl, 'GET', '/api/tasks', { token: accessTokenA });
    assert.equal((tasksAfter.json.tasks || []).some((t) => t.id === 'task-e2e-a1'), true);
    const tasksBAfter = await api(backend.baseUrl, 'GET', '/api/tasks', { token: issuedB.accessToken });
    assert.equal((tasksBAfter.json.tasks || []).some((t) => t.id === 'task-e2e-a1'), false);

    const close2 = await closeApp(electronApp);
    assert.equal(close2.exited, true);
    electronApp = null;

    return {
      ok: true,
      completeCount: backend.getCompleteCount(),
      workspaceId: workspaceIdA,
      restartRestore: true,
      screenshots: {
        calendar: screenshotCalendarPath,
        wiki: screenshotWikiPath,
        agentWork: screenshotAgentPath,
      },
      secondAccountIsolation: true,
    };
  } finally {
    await closeApp(electronApp);
  }
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const backend = await startProductionBackend();
  let hardTimer = null;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      reject(new Error(`E2E hard timeout after ${HARD_TIMEOUT_MS}ms`));
    }, HARD_TIMEOUT_MS);
  });

  let result;
  try {
    result = await Promise.race([runScenario(backend), hardTimeout]);
  } finally {
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
    try { await backend.close(); } catch { /* ignore */ }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
