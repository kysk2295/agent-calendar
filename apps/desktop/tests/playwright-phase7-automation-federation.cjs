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
const { defaultRunBin: runBin } = require('../../backend/app/lib/local-postgres-lifecycle');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');
const { createPhase1Runtime } = require('../../backend/app/lib/phase1-auth-routes');
const { resolvePostgresBinDir } = require('../../backend/app/lib/phase0-snapshot-restore');
const { issueSessionForVerifiedSubject } = require('../../backend/app/lib/workspace-auth-session');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const artifactDir = path.join(desktopRoot, 'test-results', 'phase7-automation-federation');
const evidencePath = path.join(
  repoRoot,
  'docs/operations/evidence/2026-07-25-phase7-automation-federation.json',
);
const LOCAL_ROLE = 'phase7e2e';
const DATABASE = 'phase7_e2e';
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 300_000);
const userDataNames = {
  a: `Agent Calendar Phase7 A ${process.pid}`,
  b: `Agent Calendar Phase7 B ${process.pid}`,
};
const shots = {
  setup: path.join(artifactDir, '00-runner-neutral-setup.png'),
  connected: path.join(artifactDir, '01-source-connected.png'),
  created: path.join(artifactDir, '02-created-and-receipt.png'),
  calendar: path.join(artifactDir, '03-calendar-occurrence.png'),
  isolated: path.join(artifactDir, '04-workspace-b-empty.png'),
  restarted: path.join(artifactDir, '05-workspace-a-restarted.png'),
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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-ete-'));
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
            id: `workos_phase7_${account}`,
            email: `phase7-${account}@example.com`,
            firstName: `Phase7-${account.toUpperCase()}`,
            lastName: 'Owner',
            emailVerified: true,
          },
        };
      },
    },
  };
}

function todayOccurrenceIso(hour = 1) {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    0,
    0,
  )).toISOString();
}

function createAutomationAdapter() {
  const scheduledAt = todayOccurrenceIso(1);
  const state = {
    items: [{
      externalId: 'existing-hermes-brief',
      name: '기존 Hermes 브리프',
      goal: '오늘 일정을 요약한다.',
      agentId: 'calendar',
      schedule: '0 10 * * *',
      status: 'active',
      enabled: true,
      revision: 'rev-existing-1',
      nextRunAt: scheduledAt,
    }],
    occurrences: [{
      externalOccurrenceId: `existing-hermes-brief:${scheduledAt}`,
      automationExternalId: 'existing-hermes-brief',
      scheduledAt,
      status: 'scheduled',
      revision: 'occ-existing-1',
    }],
    calls: [],
  };
  const capabilities = {
    list: true,
    create: true,
    update: true,
    pause: true,
    resume: true,
    run: true,
    delete: false,
    triggers: ['cron'],
    runHistory: true,
  };
  function mutation(operation, input) {
    state.calls.push({ operation, input });
    const externalId = input.externalId || `created-${state.items.length}`;
    const index = state.items.findIndex((item) => item.externalId === externalId);
    const current = index >= 0 ? state.items[index] : null;
    const enabled = operation === 'create'
      ? false
      : operation === 'pause'
        ? false
        : operation === 'resume'
          ? true
          : current?.enabled ?? false;
    const automation = {
      externalId,
      name: input.name || current?.name || '새 자동화',
      goal: input.goal ?? current?.goal ?? '',
      agentId: input.agentId ?? current?.agentId ?? 'default',
      schedule: input.schedule ?? current?.schedule ?? '',
      status: enabled ? 'active' : 'paused',
      enabled,
      revision: `rev-${operation}-${state.calls.length}`,
      nextRunAt: current?.nextRunAt || '',
    };
    if (index >= 0) state.items[index] = automation;
    else state.items.push(automation);
    let run = null;
    if (operation === 'run') {
      run = {
        externalOccurrenceId: `${externalId}:manual-${state.calls.length}`,
        automationExternalId: externalId,
        scheduledAt: todayOccurrenceIso(2),
        status: 'succeeded',
        revision: `run-${state.calls.length}`,
      };
      state.occurrences.push(run);
    }
    return { automation, run, sourceRevision: automation.revision };
  }
  return {
    state,
    async capabilities() {
      return capabilities;
    },
    async list() {
      state.calls.push({ operation: 'list' });
      return {
        items: state.items,
        occurrences: state.occurrences,
        cursor: 'phase7-cursor',
        sourceRevision: 'phase7-source-revision',
      };
    },
    async create(_source, input) {
      return mutation('create', input);
    },
    async update(_source, input) {
      return mutation('update', input);
    },
    async pause(_source, input) {
      return mutation('pause', input);
    },
    async resume(_source, input) {
      return mutation('resume', input);
    },
    async run(_source, input) {
      return mutation('run', input);
    },
  };
}

function phase7Env() {
  return {
    ...process.env,
    WORKSPACE_AUTH_MODE: 'production',
    AUTOMATION_FEDERATION_ENABLED: '1',
    AUTOMATION_WRITES_ENABLED: '1',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_EXTERNAL_ENABLED: '0',
  };
}

async function startHttpServer({ pool, authKit, adapter, fixedPort = null }) {
  const env = phase7Env();
  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_phase7', apiKeyConfigured: true },
    automationAdapters: { fake: adapter },
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
    await page.waitForTimeout(300);
    const pending = authState.lastStart();
    assert.equal(pending.account, account);
    await receiveAuthUrl(
      app,
      `agent-calendar://auth/callback?code=phase7-${account}&state=${encodeURIComponent(pending.state)}`,
    );
  }
  await page.waitForSelector('.nav-item', { timeout: 25_000 });
  return page;
}

async function sessionFor(pool, account) {
  return issueSessionForVerifiedSubject(pool, {
    provider: 'workos',
    providerSubject: `workos_phase7_${account}`,
  });
}

async function installRunner(pool, session, suffix) {
  await pool.query(
    `insert into runners (
       id, workspace_id, status, connection_state, capabilities, last_seen_at
     ) values ($1, $2, 'active', 'connected',
       '{"automationSources":["fake"]}'::jsonb, now())`,
    [`runner-${suffix}`, session.workspaceId],
  );
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
    slice: 'phase7-automation-federation',
    date: '2026-07-25',
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
    const adapter = createAutomationAdapter();
    http = await startHttpServer({ pool: pg.pool, authKit: authState.authKit, adapter });
    const fixedPort = Number(new URL(http.baseUrl).port);
    prepareUserData('a', http.baseUrl);
    prepareUserData('b', http.baseUrl);

    appA = await launchApp('a', http.baseUrl);
    let pageA = await login(appA, authState, 'a');
    const sessionA = await sessionFor(pg.pool, 'a');
    await installRunner(pg.pool, sessionA, 'a');
    await pageA.locator('.nav-item').filter({ hasText: '자동화' }).click();
    await pageA.getByRole('button', { name: '자동화 소스 연결' }).click();
    await pageA.getByLabel('연결할 Runner').selectOption('runner-a');
    const sourceNameInput = pageA.getByLabel('소스 이름');
    assert.equal(await sourceNameInput.getAttribute('placeholder'), '예: 내 Hermes Runner');
    assert.equal(await pageA.getByText('Mac mini', { exact: false }).count(), 0);
    await pageA.screenshot({ path: shots.setup, fullPage: true });
    await sourceNameInput.fill('Mac mini Hermes');
    await pageA.getByRole('button', { name: '연결하고 동기화' }).click();
    await pageA.getByText('Mac mini Hermes 연결됨').waitFor();
    await pageA.getByText('기존 Hermes 브리프').first().waitFor();
    await pageA.screenshot({ path: shots.connected, fullPage: true });

    await pageA.getByRole('button', { name: '새 자동화' }).click();
    await pageA.getByLabel('자동화 이름').fill('아침 요약');
    await pageA.getByLabel('자동화 목표').fill('오늘 할 일을 요약한다.');
    await pageA.getByLabel('담당 프로필').fill('calendar');
    await pageA.getByLabel('실행 일정').fill('0 8 * * *');
    await pageA.getByRole('button', { name: '자동화 만들기' }).click();
    await pageA.getByText('아침 요약').first().waitFor();
    await pageA.getByRole('button', { name: '아침 요약 자동화 열기' }).click();
    await pageA.getByLabel('자동화 목표').fill('오늘 일정과 할 일을 요약한다.');
    await pageA.getByRole('button', { name: '변경사항 저장' }).click();
    await pageA.getByText('출처에서 변경을 확인했습니다.').waitFor();
    await pageA.getByRole('button', { name: '다시 활성화' }).click();
    await pageA.getByText('자동화를 다시 활성화했습니다.').waitFor();
    await pageA.getByRole('button', { name: '일시정지' }).click();
    await pageA.getByText('자동화를 일시정지했습니다.').waitFor();
    await pageA.getByRole('button', { name: '다시 활성화' }).click();
    await pageA.getByText('자동화를 다시 활성화했습니다.').waitFor();
    await pageA.getByRole('button', { name: '지금 실행' }).click();
    await pageA.getByText('출처 확인 완료').waitFor();
    await pageA.screenshot({ path: shots.created, fullPage: true });

    await pageA.locator('.nav-item').filter({ hasText: '캘린더' }).click();
    await pageA.getByText('기존 Hermes 브리프').first().waitFor();
    assert.equal(
      await pageA.locator('.event-pill').filter({ hasText: '기존 Hermes 브리프' }).count(),
      1,
    );
    await pageA.screenshot({ path: shots.calendar, fullPage: true });
    await closeApp(appA);
    appA = null;

    appB = await launchApp('b', http.baseUrl);
    const pageB = await login(appB, authState, 'b');
    const sessionB = await sessionFor(pg.pool, 'b');
    await installRunner(pg.pool, sessionB, 'b');
    await pageB.locator('.nav-item').filter({ hasText: '자동화' }).click();
    await pageB.getByText('연결된 자동화가 없습니다.').waitFor();
    assert.equal(await pageB.getByText('기존 Hermes 브리프').count(), 0);
    await pageB.screenshot({ path: shots.isolated, fullPage: true });
    await closeApp(appB);
    appB = null;

    await http.close();
    http = await startHttpServer({
      pool: pg.pool,
      authKit: authState.authKit,
      adapter,
      fixedPort,
    });
    appA = await launchApp('a', http.baseUrl);
    pageA = await login(appA, authState, 'a');
    await pageA.locator('.nav-item').filter({ hasText: '자동화' }).click();
    await pageA.getByText('Mac mini Hermes 연결됨').waitFor();
    await pageA.getByText('아침 요약').first().waitFor();
    await pageA.getByText('출처 확인 완료').waitFor();
    await pageA.screenshot({ path: shots.restarted, fullPage: true });

    const counts = await pg.pool.query(
      `select
         (select count(*)::int from automation_sources where workspace_id = $1) as sources_a,
         (select count(*)::int from automation_sources where workspace_id = $2) as sources_b,
         (select count(*)::int from connected_automations where workspace_id = $1) as automations_a,
         (select count(*)::int from connected_automations where workspace_id = $2) as automations_b,
         (select count(*)::int from automation_occurrences where workspace_id = $1) as occurrences_a,
         (select count(*)::int from automation_occurrences where workspace_id = $2) as occurrences_b`,
      [sessionA.workspaceId, sessionB.workspaceId],
    );
    assert.deepEqual(counts.rows[0], {
      sources_a: 1,
      sources_b: 0,
      automations_a: 2,
      automations_b: 0,
      occurrences_a: 2,
      occurrences_b: 0,
    });
    assert.equal(adapter.state.calls.filter((call) => call.operation === 'create').length, 1);
    assert.equal(adapter.state.calls.filter((call) => call.operation === 'run').length, 1);

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
    evidence.counts = counts.rows[0];
    evidence.sourceCalls = adapter.state.calls.map((call) => call.operation);
    evidence.screenshotHashes = screenshotHashes;
    evidence.runnerDeviceNeutrality = {
      defaultSourceNamePlaceholder: '예: 내 Hermes Runner',
      hardcodedMacMiniCopyCount: 0,
      userSuppliedSourceNamePreserved: true,
    };
    evidence.restart = 'source, automations, receipts, and occurrences survived server and Desktop restart';
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
    for (const account of Object.keys(userDataNames)) {
      fs.rmSync(userDataPath(account), { recursive: true, force: true });
    }
    clearTimeout(hardTimeout);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
