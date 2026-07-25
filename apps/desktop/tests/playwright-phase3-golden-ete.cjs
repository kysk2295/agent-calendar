'use strict';

/**
 * Phase 3 golden ETE — UI-only journey (no acceptWork / issueSession journey-driving).
 * injected test AuthKit + production-mode dispatch + ephemeral PG + real apps/runner + Electron.
 * Fake Engine only as Engine adapter inside real Runner protocol.
 * This harness is product ETE evidence, never live WorkOS production release evidence.
 */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const { runMigrations } = require('../../backend/app/db/migrate');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');
const {
  createCleanAccountEteEvidence,
} = require('../../backend/app/lib/clean-account-ete-release-evidence');
const { createPhase1Runtime } = require('../../backend/app/lib/phase1-auth-routes');
const { resolvePostgresBinDir } = require('../../backend/app/lib/phase0-snapshot-restore');
const { RunnerClient } = require('../../runner/lib/client');
const { runConnectorOnce } = require('../../runner/lib/connector-loop');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const runnerBin = path.join(repoRoot, 'apps/runner/bin/agent-calendar-runner.js');
const selectedEngine = String(process.env.AGENT_CALENDAR_E2E_LIVE_ENGINE || 'fake').toLowerCase();
assert.ok(['fake', 'codex', 'claude', 'grok', 'hermes'].includes(selectedEngine), 'unsupported E2E engine');
const useFakeEngine = selectedEngine === 'fake';
const expectedErrorCode = String(process.env.AGENT_CALENDAR_E2E_EXPECT_ERROR || '').toLowerCase();
const expectFailure = Boolean(expectedErrorCode);
const twoAccountMode = process.env.AGENT_CALENDAR_E2E_TWO_ACCOUNT === '1';
const releaseEvidencePath = String(
  process.env.AGENT_CALENDAR_E2E_RELEASE_EVIDENCE_PATH || '',
).trim();
const releaseBindingJson = String(
  process.env.AGENT_CALENDAR_E2E_RELEASE_BINDING_JSON || '',
).trim();
assert.match(expectedErrorCode, expectFailure ? /^[a-z0-9_]{1,80}$/ : /^$/, 'invalid expected E2E error code');
assert.ok(!expectFailure || !useFakeEngine, 'failure E2E requires a live Engine');
assert.ok(!twoAccountMode || !expectFailure, 'two-account E2E requires a successful Engine path');
assert.ok(!releaseEvidencePath || !twoAccountMode, 'release evidence requires the single-account ETE');
assert.ok(
  !releaseEvidencePath || (!useFakeEngine && !expectFailure),
  'release evidence requires a successful live Engine ETE',
);
assert.equal(
  releaseEvidencePath,
  '',
  'local injected AuthKit ETE cannot write production release evidence',
);
const expectedEngineLabel = selectedEngine === 'fake'
  ? 'Fake'
  : `${selectedEngine.slice(0, 1).toUpperCase()}${selectedEngine.slice(1)}`;
const expectedResultMarker = {
  fake: 'Completed fake execution',
  codex: 'Codex execution completed',
  claude: 'Claude execution completed',
  grok: 'Grok batch execution completed',
  hermes: 'Hermes safe-profile execution completed',
}[selectedEngine];
const artifactDir = path.join(
  desktopRoot,
  'test-results',
  useFakeEngine
    ? (twoAccountMode ? 'phase3-two-account-isolation-ete' : 'phase3-golden-ete')
    : `phase3-golden-ete-${selectedEngine}${expectFailure ? '-failure' : ''}`,
);
function createDesktopContext(label = '') {
  const suffix = label ? ` ${label}` : '';
  const name = `Agent Calendar Phase3 Golden ETE ${selectedEngine}${suffix} ${process.pid}`;
  const dataPath = path.join(os.homedir(), 'Library', 'Application Support', name);
  return {
    label,
    userDataName: name,
    userData: dataPath,
    settingsFile: path.join(dataPath, 'settings.json'),
  };
}
const defaultDesktopContext = createDesktopContext();
const userDataName = defaultDesktopContext.userDataName;
const userData = defaultDesktopContext.userData;
const settingsFile = defaultDesktopContext.settingsFile;
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 300_000);
const LOCAL_ROLE = 'phase3e2e';
const DATABASE = 'phase3_e2e';
const WORK_GOAL = useFakeEngine
  ? 'Phase3 golden delegated work from Desktop UI'
  : expectFailure
    ? `Live ${expectedEngineLabel} failure ETE: reply exactly ENGINE_OK. Do not use tools or modify files.`
    : `Live ${expectedEngineLabel} ETE: reply exactly ENGINE_OK. Do not use tools or modify files.`;

const shots = {
  queued: path.join(artifactDir, 'queued-waiting.png'),
  live: path.join(artifactDir, 'live-checkpoint.png'),
  completed: path.join(artifactDir, expectFailure ? 'failed-result.png' : 'completed-result.png'),
  calendar: path.join(artifactDir, expectFailure ? 'calendar-no-projection.png' : 'calendar-projection.png'),
  rehydrated: path.join(artifactDir, 'restart-rehydrated.png'),
};
const providerSessionShots = {
  continued: path.join(artifactDir, 'provider-session-continued.png'),
  rehydrated: path.join(artifactDir, 'provider-session-rehydrated.png'),
};
const TWO_ACCOUNT_GOALS = Object.freeze({
  a: 'Workspace A private delegated result',
  b: 'Workspace B private delegated result',
});
const TWO_ACCOUNT_INFERENCE = Object.freeze({
  a: {
    calendar: 'calendar-a-private-marker',
    wiki: 'wiki-a-private-marker',
  },
  b: {
    calendar: 'calendar-b-private-marker',
    wiki: 'wiki-b-private-marker',
  },
});
const twoAccountShots = Object.freeze({
  aCompleted: path.join(artifactDir, '01-workspace-a-completed.png'),
  aCalendar: path.join(artifactDir, '02-workspace-a-calendar.png'),
  aInference: path.join(artifactDir, '03-workspace-a-inference.png'),
  bIsolated: path.join(artifactDir, '04-workspace-b-clean.png'),
  bCalendar: path.join(artifactDir, '05-workspace-b-calendar.png'),
  bInference: path.join(artifactDir, '06-workspace-b-inference.png'),
  aRehydrated: path.join(artifactDir, '07-workspace-a-rehydrated.png'),
});
const twoAccountProviderShots = Object.freeze({
  aContinued: path.join(artifactDir, '08-workspace-a-provider-session.png'),
  bContinued: path.join(artifactDir, '09-workspace-b-provider-session.png'),
  aRehydrated: path.join(artifactDir, '10-workspace-a-provider-rehydrated.png'),
  bRehydrated: path.join(artifactDir, '11-workspace-b-provider-rehydrated.png'),
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function releaseBinding() {
  if (!releaseEvidencePath) {
    assert.equal(releaseBindingJson, '', 'release binding requires an evidence output path');
    return null;
  }
  assert.ok(releaseBindingJson, 'release evidence binding is required');
  try {
    return JSON.parse(releaseBindingJson);
  } catch {
    throw new Error('release evidence binding must be valid JSON');
  }
}

function writeReleaseEvidence(report, binding) {
  if (!releaseEvidencePath || !binding) return false;
  const evidence = createCleanAccountEteEvidence({
    report,
    binding,
    capturedAt: new Date().toISOString(),
  });
  const outputPath = path.resolve(releaseEvidencePath);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, outputPath);
  fs.chmodSync(outputPath, 0o600);
  return true;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((e) => (e ? reject(e) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function runBin(binDir, name, args, options = {}) {
  return execFileSync(path.join(binDir, name), args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

async function waitForReady(binDir, socketDir, port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch { await sleep(100); }
  }
  throw new Error('PG not ready');
}

function stopCluster(binDir, dataDir) {
  try { runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 }); } catch { /* ignore */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function forceKillPid(pid) {
  if (!pid || !pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function ensureCleanUserData(apiBaseUrl, context = defaultDesktopContext) {
  fs.rmSync(context.userData, { recursive: true, force: true });
  fs.mkdirSync(context.userData, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(context.settingsFile, `${JSON.stringify({
    apiBaseUrl, apiToken: '', theme: 'default', auth: null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);
}

function writeSettings(apiBaseUrl, context = defaultDesktopContext) {
  const previous = fs.existsSync(context.settingsFile)
    ? JSON.parse(fs.readFileSync(context.settingsFile, 'utf8'))
    : {};
  fs.writeFileSync(context.settingsFile, `${JSON.stringify({
    ...previous,
    apiBaseUrl,
    apiToken: '',
  }, null, 2)}\n`);
}

async function startPostgres() {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('PG binaries missing');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-ete-'));
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
  return { binDir, workDir, dataDir, socketDir, pool, connectionString };
}

function createAuthKitState() {
  let lastStart = null;
  let completeCount = 0;
  const completedSubjects = [];
  return {
    getLastStart: () => lastStart,
    getCompleteCount: () => completeCount,
    getCompletedSubjects: () => [...completedSubjects],
    authKit: {
      async getAuthorizationUrlWithPKCE({ state }) {
        lastStart = { state, codeVerifier: `v_${Date.now()}` };
        return { url: `https://authkit.test/authorize?state=${state}`, codeVerifier: lastStart.codeVerifier };
      },
      async authenticateWithCodeAndVerifier({ code }) {
        if (!code) throw Object.assign(new Error('bad'), { code: 'WORKOS_EXCHANGE_FAILED' });
        const identity = String(code) === 'p3-b'
          ? {
            id: 'workos_phase3_b',
            email: 'phase3-b@example.com',
            firstName: 'Phase3',
            lastName: 'Owner B',
          }
          : {
            id: 'workos_phase3_a',
            email: 'phase3-a@example.com',
            firstName: 'Phase3',
            lastName: 'Owner A',
          };
        completeCount += 1;
        completedSubjects.push(identity.id);
        return {
          user: {
            ...identity,
            emailVerified: true,
          },
        };
      },
    },
  };
}

async function startHttpServer({ pool, authKit, fixedPort = null }) {
  const runtimeEnv = {
    ...process.env,
    WORKSPACE_AUTH_MODE: 'production',
    DURABLE_EXECUTION_CLAIMS_ENABLED: 'true',
    AGENT_CALENDAR_ALLOW_FAKE_ENGINE: useFakeEngine ? '1' : '0',
    KNOWLEDGE_V2_ENABLED: '1',
    KNOWLEDGE_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
  };
  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_phase3', apiKeyConfigured: true },
    env: runtimeEnv,
  });
  const server = createRailwayGatewayServer({
    env: runtimeEnv,
    phase1Runtime: runtime,
    phase1Pool: pool,
    gatewayStore: { getState: () => ({ tasks: [], events: [] }), ready: Promise.resolve() },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const baseUrl = await new Promise((resolve) => {
    const host = '127.0.0.1';
    if (fixedPort) {
      server.listen(fixedPort, host, () => resolve(`http://${host}:${fixedPort}`));
    } else {
      server.listen(0, host, () => resolve(`http://${host}:${server.address().port}`));
    }
  });
  return {
    server,
    runtime,
    baseUrl,
    async close() {
      await new Promise((r) => server.close(() => r()));
    },
  };
}

async function launchApp(apiBaseUrl, context = defaultDesktopContext) {
  const mainJs = path.join(desktopRoot, 'dist-electron', 'main.js');
  assert.ok(fs.existsSync(mainJs), 'build desktop first');
  writeSettings(apiBaseUrl, context);
  const electronPath = require('electron');
  return electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : undefined,
    args: [mainJs],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENT_CALENDAR_USER_DATA_NAME: context.userDataName,
      AGENT_CALENDAR_E2E_AUTH: '1',
      AGENT_CALENDAR_E2E_ALLOW_MULTIPLE_INSTANCES: '1',
      VITE_DEV_SERVER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
}

async function receiveAuthUrl(app, url) {
  return app.evaluate(async (_e, callbackUrl) => {
    const bridge = globalThis.__agentCalendarE2E;
    if (!bridge) throw new Error('E2E bridge missing');
    return bridge.receiveAuthUrl(callbackUrl);
  }, url);
}

async function closeApp(app) {
  if (!app) return;
  let pid = null;
  try { pid = app.process().pid; } catch { /* ignore */ }
  try { await app.evaluate(async ({ app: a }) => a.exit(0)).catch(() => {}); } catch { /* ignore */ }
  try { await Promise.race([app.close(), sleep(2000)]); } catch { /* ignore */ }
  if (pid && pidAlive(pid)) forceKillPid(pid);
  await sleep(400);
}

function runRunner(args, { stateDir, env = {} } = {}) {
  const runnerEnv = {
    ...process.env,
    AGENT_CALENDAR_RUNNER_HOME: stateDir,
    ...env,
  };
  if (useFakeEngine) {
    runnerEnv.AGENT_CALENDAR_ALLOW_FAKE_ENGINE = '1';
    runnerEnv.AGENT_CALENDAR_FAKE_ENGINE_STEP_MS = '2000';
    runnerEnv.AGENT_CALENDAR_RUNNER_PROBE_JSON = JSON.stringify({
      engines: {
        fake: { available: true, status: 'available', version: 'fake-1', authStatus: 'ok' },
        codex: { available: false, status: 'unavailable' },
        claude: { available: false, status: 'unavailable' },
        grok: { available: false, status: 'unavailable' },
        hermes: { available: false, status: 'unavailable' },
      },
    });
  } else {
    delete runnerEnv.AGENT_CALENDAR_ALLOW_FAKE_ENGINE;
    delete runnerEnv.AGENT_CALENDAR_FAKE_ENGINE_STEP_MS;
    delete runnerEnv.AGENT_CALENDAR_RUNNER_PROBE_JSON;
  }
  const result = spawn(process.execPath, [runnerBin, ...args], {
    env: runnerEnv,
    cwd: stateDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  result.stdout.on('data', (c) => { stdout += String(c); });
  result.stderr.on('data', (c) => { stderr += String(c); });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      forceKillPid(result.pid);
      reject(new Error(`runner timeout: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, useFakeEngine ? 120_000 : 240_000);
    result.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(`runner exit ${code}: ${args.join(' ')}\n${stdout}\n${stderr}`));
    });
  });
  return { pid: result.pid, done, getOutput: () => stdout + stderr };
}

async function runConnectorEventually(baseUrl, stateDir) {
  const client = new RunnerClient({ baseUrl, stateDir });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await runConnectorOnce(client);
    if (result.requestId) return result;
    await sleep(100);
  }
  throw new Error('Runner connector request was not delivered');
}

async function waitBody(page, re, timeoutMs = 45_000) {
  await page.waitForFunction((pattern) => {
    const text = document.body ? document.body.innerText : '';
    return new RegExp(pattern, 'i').test(text);
  }, re.source || re, { timeout: timeoutMs });
}

async function loginAccount({ app, page, authState, code, expectedCount, expectedEmail }) {
  await page.waitForSelector('button:has-text("AuthKit으로 계속하기")', { timeout: 25_000 });
  await page.getByRole('button', { name: /AuthKit으로 계속하기/ }).click();
  await page.waitForTimeout(500);
  const pending = authState.getLastStart();
  assert.ok(pending);
  await receiveAuthUrl(
    app,
    `agent-calendar://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(pending.state)}`,
  );
  await page.waitForSelector('[data-testid="open-settings"]', { timeout: 25_000 });
  assert.equal(authState.getCompleteCount(), expectedCount);
  await page.getByTestId('open-settings').click();
  await page.waitForSelector('.settings-overlay', { timeout: 10_000 });
  assert.match(await page.locator('.settings-sidebar-account').innerText(), new RegExp(expectedEmail, 'i'));
  await page.getByRole('button', { name: '설정 닫기' }).click();
}

async function enrollAccountRunner({
  page,
  baseUrl,
  runnerStateDir,
  forbiddenFingerprint = '',
}) {
  const guide = page.getByTestId('onboarding-guide');
  await guide.waitFor({ state: 'visible', timeout: 20_000 });
  await guide.getByRole('button', { name: /Runner와 실행 엔진/ }).click();
  await guide.getByRole('button', { name: 'Runner 연결', exact: true }).click();
  await page.waitForSelector('[data-testid="runner-setup"]', { timeout: 15_000 });
  if (forbiddenFingerprint) {
    assert.ok(!(await page.locator('body').innerText()).includes(forbiddenFingerprint));
  }
  assert.equal(
    await page.locator('[data-testid="runner-list"] li').count(),
    0,
    'a clean Workspace must not list another account Runner',
  );
  await page.getByTestId('runner-begin-setup').click();
  await page.getByTestId('runner-issue-challenge').click();
  await page.waitForSelector('[data-testid="runner-human-code"]', { timeout: 15_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="runner-qr"]');
    return el && el.getAttribute('data-qr-payload');
  }, null, { timeout: 10_000 });
  const qrPayload = await page.getAttribute('[data-testid="runner-qr"]', 'data-qr-payload');
  const qr = JSON.parse(qrPayload);
  const humanCode = (await page.textContent('[data-testid="runner-human-code"]')).trim();

  await runRunner([
    'enroll', '--base-url', baseUrl, '--state-dir', runnerStateDir,
    '--challenge-id', qr.challengeId, '--code', humanCode,
  ], { stateDir: runnerStateDir }).done;

  await page.waitForSelector('[data-testid="runner-fingerprint"]', { timeout: 45_000 });
  const fingerprint = (await page.textContent('[data-testid="runner-fingerprint"]') || '').trim();
  assert.ok(fingerprint);
  if (forbiddenFingerprint) assert.notEqual(fingerprint, forbiddenFingerprint);
  await page.getByTestId('runner-confirm').click();
  await runRunner([
    'claim-wait', '--base-url', baseUrl, '--state-dir', runnerStateDir, '--timeout-ms', '60000',
  ], { stateDir: runnerStateDir }).done;
  await runRunner(['connect', '--base-url', baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;
  await runRunner(['capabilities', '--base-url', baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;
  return fingerprint;
}

async function openAgentControl(page) {
  await page.getByRole('button', { name: /에이전트/ }).first().click();
  await page.waitForSelector('[data-testid="agent-runner-live"]', { timeout: 20_000 });
}

async function runAccountWork({
  page,
  baseUrl,
  runnerStateDir,
  goal,
  forbiddenGoal,
  completedScreenshot,
  calendarScreenshot,
}) {
  await openAgentControl(page);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="agent-runner-live"]');
    return el
      && el.getAttribute('data-runner-connected') === 'true'
      && /Runner 연결됨/.test(el.textContent || '');
  }, null, { timeout: 60_000 });
  assert.ok(!(await page.locator('body').innerText()).includes(forbiddenGoal));

  const composer = page.getByLabel('에이전트에게 작업 지시');
  await composer.waitFor({ timeout: 15_000 });
  await composer.fill(goal);
  const advanced = page.locator('summary:has-text("고급 설정")');
  if (!useFakeEngine && await advanced.count()) {
    await advanced.click();
    const engineSelect = page.getByLabel('실행 엔진');
    if (await engineSelect.count()) await engineSelect.selectOption(selectedEngine);
  }
  await page.getByRole('button', { name: '위임' }).click();
  await page.waitForFunction((expectedGoal) => {
    const text = document.body ? document.body.innerText : '';
    return text.includes(expectedGoal) && /Work accepted|accepted|waiting_runner/i.test(text);
  }, goal, { timeout: 45_000 });

  const workOut = await runRunner([
    'work-once', '--base-url', baseUrl, '--state-dir', runnerStateDir,
  ], { stateDir: runnerStateDir }).done;
  assert.match(workOut, /completed/i);
  await page.waitForFunction((resultMarker) => {
    const text = document.querySelector('.agent-work-timeline')?.textContent || '';
    return text.includes(String(resultMarker));
  }, expectedResultMarker, { timeout: 90_000 });
  await page.waitForSelector('[data-testid="agent-work-resolved-engine"]', { timeout: 15_000 });
  assert.equal(
    (await page.textContent('[data-testid="agent-work-resolved-engine"]') || '').trim(),
    expectedEngineLabel,
  );
  const completedBody = await page.locator('body').innerText();
  assert.ok(completedBody.includes(goal));
  assert.ok(!completedBody.includes(forbiddenGoal));
  await page.screenshot({ path: completedScreenshot, fullPage: true });

  await page.getByRole('button', { name: /캘린더/ }).first().click();
  await page.waitForFunction((expectedGoal) => {
    const text = document.body ? document.body.innerText : '';
    return text.includes('Agent work:') && text.includes(expectedGoal) && text.includes('완료');
  }, goal, { timeout: 45_000 });
  const calendarBody = await page.locator('body').innerText();
  assert.ok(calendarBody.includes(goal));
  assert.ok(!calendarBody.includes(forbiddenGoal));
  await page.screenshot({ path: calendarScreenshot, fullPage: true });
}

async function runRunnerWorkEventually(baseUrl, runnerStateDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = await runRunner([
      'work-once', '--base-url', baseUrl, '--state-dir', runnerStateDir,
    ], { stateDir: runnerStateDir }).done;
    if (/completed/i.test(output)) return output;
    assert.match(output, /idle/i);
    await sleep(200);
  }
  throw new Error('Workspace inference job was not offered to the expected Runner');
}

async function runAccountInference({
  page,
  baseUrl,
  runnerStateDir,
  calendarMarker,
  wikiMarker,
  forbiddenCalendarMarker,
  forbiddenWikiMarker,
  knowledgeFile,
  screenshot,
}) {
  if (!await page.getByRole('button', { name: '캘린더 AI 열기' }).count()) {
    await page.getByRole('button', { name: /캘린더/ }).first().click();
  }
  await page.getByRole('button', { name: '캘린더 AI 열기' }).click();
  await page.waitForSelector('.chat textarea', { timeout: 10_000 });
  const beforeMessages = await page.locator('.message').count();
  await page.locator('.chat textarea').fill(`${calendarMarker}로 짧게 인사해줘`);
  await page.locator('.chat footer button', { hasText: '전송' }).click();
  await runRunnerWorkEventually(baseUrl, runnerStateDir);
  await page.waitForFunction(
    ({ count, marker }) => {
      const messages = Array.from(document.querySelectorAll('.message'));
      return messages.length >= count + 2
        && (messages.at(-1)?.textContent || '').includes(marker);
    },
    { count: beforeMessages, marker: calendarMarker },
    { timeout: 45_000 },
  );
  const calendarText = await page.locator('.chat').innerText();
  assert.ok(calendarText.includes(calendarMarker));
  assert.ok(!calendarText.includes(forbiddenCalendarMarker));
  await page.getByRole('button', { name: '캘린더 AI 닫기' }).last().click();

  const wikiNav = page.locator('.nav-item', { hasText: '위키' }).first();
  if (!await wikiNav.isVisible()) await page.locator('.nav-more > summary').click();
  await wikiNav.click();
  await page.waitForSelector('[data-testid="knowledge-source-panel"]', { timeout: 20_000 });
  await page.locator('.knowledge-cloud-consent input').check();
  await page.locator('.knowledge-file-add input').setInputFiles(knowledgeFile);
  const fileName = path.basename(knowledgeFile);
  await page.waitForFunction(
    (name) => {
      const panel = document.querySelector('[data-testid="knowledge-source-panel"]');
      return panel && (panel.textContent || '').includes(name) && /사용 가능/.test(panel.textContent || '');
    },
    fileName,
    { timeout: 30_000 },
  );
  await page.locator('.askbar input').fill(wikiMarker);
  await page.locator('.askbar > button').click();
  await runRunnerWorkEventually(baseUrl, runnerStateDir);
  await page.waitForFunction(
    (marker) => {
      const answer = document.querySelector('.wiki-answer');
      return answer && (answer.textContent || '').includes(marker);
    },
    wikiMarker,
    { timeout: 45_000 },
  );
  const wikiText = await page.locator('.wiki-answer').innerText();
  assert.ok(wikiText.includes(wikiMarker));
  assert.ok(!wikiText.includes(forbiddenWikiMarker));
  await page.screenshot({ path: screenshot, fullPage: true });
}

async function workspaceForSubject(pool, providerSubject) {
  const result = await pool.query(
    `select m.workspace_id
     from auth_identities ai
     join workspace_memberships m on m.user_id = ai.user_id and m.status = 'active'
     where ai.provider = 'workos' and ai.provider_subject = $1`,
    [providerSubject],
  );
  assert.equal(result.rowCount, 1, `one Workspace expected for ${providerSubject}`);
  return result.rows[0].workspace_id;
}

async function runTwoAccountIsolation({ pool, baseUrl, authState }) {
  const contextA = createDesktopContext('Account A');
  const contextB = createDesktopContext('Account B');
  const runnerA = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-runner-a-'));
  const runnerB = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-runner-b-'));
  const knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-inference-'));
  const knowledgeA = path.join(knowledgeRoot, 'workspace-a.md');
  const knowledgeB = path.join(knowledgeRoot, 'workspace-b.md');
  fs.writeFileSync(knowledgeA, `# Workspace A\n${TWO_ACCOUNT_INFERENCE.a.wiki}\n`);
  fs.writeFileSync(knowledgeB, `# Workspace B\n${TWO_ACCOUNT_INFERENCE.b.wiki}\n`);
  let app = null;
  let providerJourneyA = null;
  let providerJourneyB = null;
  const started = Date.now();
  try {
    ensureCleanUserData(baseUrl, contextA);
    ensureCleanUserData(baseUrl, contextB);

    app = await launchApp(baseUrl, contextA);
    let page = await app.firstWindow();
    await loginAccount({
      app,
      page,
      authState,
      code: 'p3-a',
      expectedCount: 1,
      expectedEmail: 'phase3-a@example.com',
    });
    const fingerprintA = await enrollAccountRunner({
      page,
      baseUrl,
      runnerStateDir: runnerA,
    });
    await runAccountWork({
      page,
      baseUrl,
      runnerStateDir: runnerA,
      goal: TWO_ACCOUNT_GOALS.a,
      forbiddenGoal: TWO_ACCOUNT_GOALS.b,
      completedScreenshot: twoAccountShots.aCompleted,
      calendarScreenshot: twoAccountShots.aCalendar,
    });
    if (!useFakeEngine && selectedEngine === 'codex') {
      providerJourneyA = await runLiveProviderSessionJourney({
        page,
        baseUrl,
        runnerStateDir: runnerA,
        pool,
        continuedScreenshot: twoAccountProviderShots.aContinued,
      });
    }
    await runAccountInference({
      page,
      baseUrl,
      runnerStateDir: runnerA,
      calendarMarker: TWO_ACCOUNT_INFERENCE.a.calendar,
      wikiMarker: TWO_ACCOUNT_INFERENCE.a.wiki,
      forbiddenCalendarMarker: TWO_ACCOUNT_INFERENCE.b.calendar,
      forbiddenWikiMarker: TWO_ACCOUNT_INFERENCE.b.wiki,
      knowledgeFile: knowledgeA,
      screenshot: twoAccountShots.aInference,
    });
    await closeApp(app);
    app = null;

    app = await launchApp(baseUrl, contextB);
    page = await app.firstWindow();
    await loginAccount({
      app,
      page,
      authState,
      code: 'p3-b',
      expectedCount: 2,
      expectedEmail: 'phase3-b@example.com',
    });
    assert.ok(!(await page.locator('body').innerText()).includes(TWO_ACCOUNT_GOALS.a));
    const fingerprintB = await enrollAccountRunner({
      page,
      baseUrl,
      runnerStateDir: runnerB,
      forbiddenFingerprint: fingerprintA,
    });
    assert.notEqual(fingerprintB, fingerprintA);
    await openAgentControl(page);
    const cleanBText = await page.locator('body').innerText();
    assert.ok(!cleanBText.includes(TWO_ACCOUNT_GOALS.a));
    assert.ok(!cleanBText.includes(fingerprintA));
    await page.screenshot({ path: twoAccountShots.bIsolated, fullPage: true });
    await runAccountWork({
      page,
      baseUrl,
      runnerStateDir: runnerB,
      goal: TWO_ACCOUNT_GOALS.b,
      forbiddenGoal: TWO_ACCOUNT_GOALS.a,
      completedScreenshot: path.join(artifactDir, '04b-workspace-b-completed.png'),
      calendarScreenshot: twoAccountShots.bCalendar,
    });
    if (!useFakeEngine && selectedEngine === 'codex') {
      providerJourneyB = await runLiveProviderSessionJourney({
        page,
        baseUrl,
        runnerStateDir: runnerB,
        pool,
        continuedScreenshot: twoAccountProviderShots.bContinued,
      });
    }
    await runAccountInference({
      page,
      baseUrl,
      runnerStateDir: runnerB,
      calendarMarker: TWO_ACCOUNT_INFERENCE.b.calendar,
      wikiMarker: TWO_ACCOUNT_INFERENCE.b.wiki,
      forbiddenCalendarMarker: TWO_ACCOUNT_INFERENCE.a.calendar,
      forbiddenWikiMarker: TWO_ACCOUNT_INFERENCE.a.wiki,
      knowledgeFile: knowledgeB,
      screenshot: twoAccountShots.bInference,
    });
    await closeApp(app);
    app = null;

    if (providerJourneyB) {
      await runRunner(['connect', '--base-url', baseUrl, '--state-dir', runnerB], { stateDir: runnerB }).done;
      app = await launchApp(baseUrl, contextB);
      page = await app.firstWindow();
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('button:has-text("AuthKit으로 계속하기")').count(), 0);
      await openAgentControl(page);
      await verifyLiveProviderSessionRehydrated(
        page,
        providerJourneyB,
        twoAccountProviderShots.bRehydrated,
      );
      await closeApp(app);
      app = null;
    }

    await runRunner(['connect', '--base-url', baseUrl, '--state-dir', runnerA], { stateDir: runnerA }).done;
    app = await launchApp(baseUrl, contextA);
    page = await app.firstWindow();
    await page.waitForTimeout(1500);
    assert.equal(
      await page.locator('button:has-text("AuthKit으로 계속하기")').count(),
      0,
      'Account A secure session must restore without another login',
    );
    await openAgentControl(page);
    const restored = page.getByText(TWO_ACCOUNT_GOALS.a, { exact: true }).first();
    await restored.waitFor({ state: 'visible', timeout: 30_000 });
    await restored.click();
    await page.waitForFunction(({ goal, marker }) => {
      const text = document.querySelector('.agent-work-timeline')?.textContent || '';
      return text.includes(marker)
        && (document.body?.innerText || '').includes(goal);
    }, { goal: TWO_ACCOUNT_GOALS.a, marker: expectedResultMarker }, { timeout: 30_000 });
    const restoredBody = await page.locator('body').innerText();
    assert.ok(restoredBody.includes(TWO_ACCOUNT_GOALS.a));
    assert.ok(!restoredBody.includes(TWO_ACCOUNT_GOALS.b));
    assert.ok(!restoredBody.includes(fingerprintB));
    await page.screenshot({ path: twoAccountShots.aRehydrated, fullPage: true });
    if (providerJourneyA) {
      await verifyLiveProviderSessionRehydrated(
        page,
        providerJourneyA,
        twoAccountProviderShots.aRehydrated,
      );
    }

    const idleA = await runRunner([
      'work-once', '--base-url', baseUrl, '--state-dir', runnerA,
    ], { stateDir: runnerA }).done;
    const idleB = await runRunner([
      'work-once', '--base-url', baseUrl, '--state-dir', runnerB,
    ], { stateDir: runnerB }).done;
    assert.match(idleA, /idle/i);
    assert.match(idleB, /idle/i);

    const workspaceA = await workspaceForSubject(pool, 'workos_phase3_a');
    const workspaceB = await workspaceForSubject(pool, 'workos_phase3_b');
    assert.notEqual(workspaceA, workspaceB);
    const ownership = await pool.query(
      `select w.id as workspace_id,
              (select count(*)::int from runners r where r.workspace_id = w.id) as runners,
              (select count(*)::int from execution_jobs j where j.workspace_id = w.id and j.status = 'completed') as jobs,
              (select count(*)::int from calendar_events e
                 where e.workspace_id = w.id and e.payload->>'source' = 'agent-work') as events
       from workspaces w where w.id = any($1::text[]) order by w.id`,
      [[workspaceA, workspaceB]],
    );
    assert.equal(ownership.rowCount, 2);
    const expectedJobsPerWorkspace = providerJourneyA && providerJourneyB ? 4 : 3;
    const expectedEventsPerWorkspace = providerJourneyA && providerJourneyB ? 2 : 1;
    for (const row of ownership.rows) {
      assert.equal(row.runners, 1);
      assert.equal(row.jobs, expectedJobsPerWorkspace);
      assert.equal(row.events, expectedEventsPerWorkspace);
    }
    const crossTitles = await pool.query(
      `select workspace_id, title from calendar_events
       where workspace_id = any($1::text[]) and payload->>'source' = 'agent-work'`,
      [[workspaceA, workspaceB]],
    );
    assert.equal(crossTitles.rowCount, expectedEventsPerWorkspace * 2);
    assert.equal(
      crossTitles.rows.some((row) => row.workspace_id === workspaceA && row.title.includes(TWO_ACCOUNT_GOALS.b)),
      false,
    );
    assert.equal(
      crossTitles.rows.some((row) => row.workspace_id === workspaceB && row.title.includes(TWO_ACCOUNT_GOALS.a)),
      false,
    );
    const inferenceOwnership = await pool.query(
      `select j.workspace_id, count(*)::int as jobs,
              bool_and(r.workspace_id = j.workspace_id) as exact_runner
       from execution_jobs j
       join execution_attempts a
         on a.workspace_id = j.workspace_id and a.job_id = j.id and a.status = 'completed'
       join runners r on r.id = a.runner_id
       where j.workspace_id = any($1::text[])
         and j.payload->>'kind' = 'workspace_inference'
       group by j.workspace_id
       order by j.workspace_id`,
      [[workspaceA, workspaceB]],
    );
    assert.equal(inferenceOwnership.rowCount, 2);
    for (const row of inferenceOwnership.rows) {
      assert.equal(row.jobs, 2);
      assert.equal(row.exact_runner, true);
    }
    const crossInference = await pool.query(
      `select workspace_id, payload::text as payload
       from agent_missions
       where workspace_id = any($1::text[])
         and payload->>'systemKind' = 'workspace_inference'`,
      [[workspaceA, workspaceB]],
    );
    assert.equal(crossInference.rows.some((row) => (
      row.workspace_id === workspaceA
      && (
        row.payload.includes(TWO_ACCOUNT_INFERENCE.b.calendar)
        || row.payload.includes(TWO_ACCOUNT_INFERENCE.b.wiki)
      )
    )), false);
    assert.equal(crossInference.rows.some((row) => (
      row.workspace_id === workspaceB
      && (
        row.payload.includes(TWO_ACCOUNT_INFERENCE.a.calendar)
        || row.payload.includes(TWO_ACCOUNT_INFERENCE.a.wiki)
      )
    )), false);

    if (providerJourneyA && providerJourneyB) {
      assert.notEqual(providerJourneyA.workspaceId, providerJourneyB.workspaceId);
      assert.notEqual(providerJourneyA.providerSessionId, providerJourneyB.providerSessionId);
      const providerOwnership = await pool.query(
        `select workspace_id, count(*)::int as sessions,
                bool_and(external_agent_id <> '') as has_agent_reference,
                bool_and(external_session_id <> '') as has_session_reference
         from provider_agent_sessions
         where workspace_id = any($1::text[])
         group by workspace_id
         order by workspace_id`,
        [[providerJourneyA.workspaceId, providerJourneyB.workspaceId]],
      );
      assert.equal(providerOwnership.rowCount, 2);
      for (const row of providerOwnership.rows) {
        assert.equal(row.sessions, 1);
        assert.equal(row.has_agent_reference, true);
        assert.equal(row.has_session_reference, true);
      }
    }

    const hashes = {};
    const evidenceShots = providerJourneyA && providerJourneyB
      ? {
        ...twoAccountShots,
        providerAContinued: twoAccountProviderShots.aContinued,
        providerBContinued: twoAccountProviderShots.bContinued,
        providerARehydrated: twoAccountProviderShots.aRehydrated,
        providerBRehydrated: twoAccountProviderShots.bRehydrated,
      }
      : twoAccountShots;
    for (const [name, file] of Object.entries(evidenceShots)) {
      assert.ok(fs.existsSync(file), `missing ${name}`);
      assert.ok(fs.statSync(file).size > 800, `too small ${name}`);
      hashes[name] = sha256File(file);
    }
    assert.equal(new Set(Object.values(hashes)).size, Object.keys(evidenceShots).length);
    return {
      ok: true,
      mode: 'two-account-isolation',
      durationMs: Date.now() - started,
      loginCompletions: authState.getCompleteCount(),
      subjects: authState.getCompletedSubjects(),
      workspaces: 2,
      runnersPerWorkspace: 1,
      completedJobsPerWorkspace: expectedJobsPerWorkspace,
      completedInferenceJobsPerWorkspace: 2,
      calendarEventsPerWorkspace: expectedEventsPerWorkspace,
      accountARestoredWithoutLogin: true,
      accountBRestoredWithoutLogin: Boolean(providerJourneyB),
      providerAgentImportedPerWorkspace: Boolean(providerJourneyA && providerJourneyB),
      providerSessionContinuedPerWorkspace: Boolean(providerJourneyA && providerJourneyB),
      providerSessionRestoredPerWorkspace: Boolean(providerJourneyA && providerJourneyB),
      screenshotHashes: hashes,
      artifactDir,
    };
  } finally {
    await closeApp(app);
    fs.rmSync(contextA.userData, { recursive: true, force: true });
    fs.rmSync(contextB.userData, { recursive: true, force: true });
    fs.rmSync(runnerA, { recursive: true, force: true });
    fs.rmSync(runnerB, { recursive: true, force: true });
    fs.rmSync(knowledgeRoot, { recursive: true, force: true });
  }
}

async function runLiveProviderSessionJourney({
  page,
  baseUrl,
  runnerStateDir,
  pool,
  continuedScreenshot = providerSessionShots.continued,
}) {
  const runnerState = JSON.parse(fs.readFileSync(path.join(runnerStateDir, 'state.json'), 'utf8'));
  const workspaceId = String(runnerState.workspaceId || '');
  assert.ok(workspaceId);
  await runRunner(['connect', '--base-url', baseUrl, '--state-dir', runnerStateDir], {
    stateDir: runnerStateDir,
  }).done;
  if (!await page.getByRole('button', { name: 'Runner에서 가져오기' }).count()) {
    await openAgentControl(page);
  }
  const initialMapping = await pool.query(
    `select external_session_id
     from provider_agent_sessions
     where workspace_id = $1 and provider = 'codex' and external_session_id <> ''
     order by created_at desc
     limit 1`,
    [workspaceId],
  );
  const alreadyConnectedSessionId = initialMapping.rows[0]?.external_session_id || '';

  await page.getByRole('button', { name: 'Runner에서 가져오기' }).click();
  const agentDialog = page.getByRole('dialog', { name: 'Runner에서 에이전트 가져오기' });
  await agentDialog.waitFor({ state: 'visible', timeout: 15_000 });
  await agentDialog.locator('select').first().selectOption('codex');
  await agentDialog.locator('.agent-catalog-consent input').check();
  await agentDialog.getByRole('button', { name: '에이전트 찾기' }).click();
  const agentConnector = await runConnectorEventually(baseUrl, runnerStateDir);
  assert.equal(agentConnector.ok, true);
  const agentResults = agentDialog.locator('.agent-catalog-results article');
  await agentResults.first().waitFor({ state: 'visible', timeout: 20_000 });
  const importedAgentName = (await agentResults.first().locator('strong').innerText()).trim();
  await agentResults.first().getByRole('button', { name: '가져오기' }).click();
  await agentDialog.waitFor({ state: 'hidden', timeout: 20_000 });

  const connectedSection = page.locator('.agent-directory-panel nav section').filter({ hasText: '연결된 에이전트' });
  const importedAgentButton = connectedSection.getByRole('button').filter({ hasText: importedAgentName }).first();
  await importedAgentButton.waitFor({ state: 'visible', timeout: 20_000 });
  await importedAgentButton.click();
  await page.getByRole('button', { name: '기존 세션' }).click();

  const sessionDialog = page.getByRole('dialog', { name: '기존 provider 세션 가져오기' });
  await sessionDialog.waitFor({ state: 'visible', timeout: 15_000 });
  await sessionDialog.locator('.agent-catalog-consent input').check();
  await sessionDialog.getByRole('button', { name: '기존 세션 찾기' }).click();
  const sessionConnector = await runConnectorEventually(baseUrl, runnerStateDir);
  assert.equal(sessionConnector.ok, true);
  const sessionResults = sessionDialog.locator('.agent-catalog-results article');
  await sessionResults.first().waitFor({ state: 'visible', timeout: 20_000 });
  const sessionCount = await sessionResults.count();
  let selectedIndex = -1;
  let importedExternalSessionId = '';
  for (let index = 0; index < sessionCount; index += 1) {
    const candidate = (await sessionResults.nth(index).locator('small').innerText()).trim();
    if (candidate && candidate !== alreadyConnectedSessionId) {
      selectedIndex = index;
      importedExternalSessionId = candidate;
      break;
    }
  }
  assert.ok(selectedIndex >= 0, 'a second resumable Codex session is required for import ETE');
  await sessionResults.nth(selectedIndex).getByRole('button', { name: '연결' }).click();
  await sessionDialog.waitFor({ state: 'hidden', timeout: 20_000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('.agent-work-timeline')?.textContent || '';
    return text.includes('기존 provider 세션을 연결했습니다');
  }, null, { timeout: 20_000 });

  const importedAgent = await pool.query(
    `select id
     from agents
     where workspace_id = $1
       and payload->>'sourceKind' = 'connected'
       and payload->>'provider' = 'codex'
       and payload->>'displayName' = $2
     limit 1`,
    [workspaceId, importedAgentName],
  );
  assert.equal(importedAgent.rowCount, 1);
  const mappingBefore = await pool.query(
    `select id, external_session_id, work_conversation_id
     from provider_agent_sessions
     where workspace_id = $1 and agent_id = $2 and external_session_id = $3
     limit 1`,
    [workspaceId, importedAgent.rows[0].id, importedExternalSessionId],
  );
  assert.equal(mappingBefore.rowCount, 1);
  const providerSessionId = mappingBefore.rows[0].id;

  const continuityMarker = 'PROVIDER_SESSION_CONTINUITY_OK';
  const workComposer = page.locator('.agent-work-composer');
  await workComposer.locator('textarea').fill(`${continuityMarker}만 답해줘. 도구를 쓰거나 파일을 수정하지 마.`);
  await workComposer.getByRole('button', { name: '보내기' }).click();
  const continued = await runRunner([
    'work-once', '--base-url', baseUrl, '--state-dir', runnerStateDir,
  ], { stateDir: runnerStateDir }).done;
  assert.match(continued, /completed/i);
  await page.waitForFunction((marker) => {
    const text = document.querySelector('.agent-work-timeline')?.textContent || '';
    return text.includes(marker) && text.includes('Artifact ready: codex-result.txt');
  }, continuityMarker, { timeout: 120_000 });

  const mappingAfter = await pool.query(
    `select ps.external_session_id, j.provider_session_id
     from provider_agent_sessions ps
     join execution_jobs j
       on j.workspace_id = ps.workspace_id and j.provider_session_id = ps.id
     where ps.id = $1
     order by j.created_at desc
     limit 1`,
    [providerSessionId],
  );
  assert.equal(mappingAfter.rowCount, 1);
  assert.equal(mappingAfter.rows[0].external_session_id, importedExternalSessionId);
  assert.equal(mappingAfter.rows[0].provider_session_id, providerSessionId);

  const renameButton = page.getByRole('button', { name: '이름 변경' }).first();
  await renameButton.click();
  const renameInput = page.getByLabel('세션 이름');
  await renameInput.fill('Live Codex continuity');
  await renameInput.press('Enter');
  const sessionSearch = page.getByLabel('세션 검색');
  await sessionSearch.fill('Live Codex');
  await page.getByText('Live Codex continuity', { exact: true }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: continuedScreenshot, fullPage: true });

  return {
    importedAgentName,
    importedAgentId: importedAgent.rows[0].id,
    providerSessionId,
    externalSessionId: importedExternalSessionId,
    workConversationId: mappingBefore.rows[0].work_conversation_id,
    title: 'Live Codex continuity',
    continuityMarker,
    workspaceId,
  };
}

async function verifyLiveProviderSessionRehydrated(
  page,
  journey,
  screenshot = providerSessionShots.rehydrated,
) {
  const back = page.getByRole('button', { name: /관제 홈/ }).first();
  if (await back.count()) await back.click();
  const connectedSection = page.locator('.agent-directory-panel nav section').filter({ hasText: '연결된 에이전트' });
  const importedAgentButton = connectedSection.getByRole('button').filter({ hasText: journey.importedAgentName }).first();
  await importedAgentButton.waitFor({ state: 'visible', timeout: 20_000 });
  await importedAgentButton.click();
  const sessionSearch = page.getByLabel('세션 검색');
  await sessionSearch.fill('Live Codex');
  const sessionRow = page.locator('.agent-session-row').filter({ hasText: journey.title }).first();
  await sessionRow.waitFor({ state: 'visible', timeout: 20_000 });
  await sessionRow.locator('.agent-session-open').click();
  await page.waitForFunction((marker) => {
    const text = document.querySelector('.agent-work-timeline')?.textContent || '';
    return text.includes(marker) && text.includes('Artifact ready: codex-result.txt');
  }, journey.continuityMarker, { timeout: 30_000 });
  await page.screenshot({ path: screenshot, fullPage: true });

  await sessionRow.getByRole('button', { name: '보관' }).click();
  await page.getByText(journey.title, { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
  await page.getByLabel('보관된 세션 포함').check();
  const archived = page.locator('.agent-session-row').filter({ hasText: journey.title }).first();
  await archived.waitFor({ state: 'visible', timeout: 20_000 });
  assert.match(await archived.innerText(), /보관됨/);
  await page.getByRole('button', { name: '새 세션' }).click();
  await page.getByLabel('에이전트에게 작업 지시').waitFor({ state: 'visible', timeout: 20_000 });
}

async function main() {
  const started = Date.now();
  const evidenceBinding = releaseBinding();
  const hard = setTimeout(() => { console.error('HARD_TIMEOUT'); process.exit(2); }, HARD_TIMEOUT_MS);
  let pg = null;
  let http = null;
  let electronApp = null;
  let authState = null;
  let providerJourney = null;
  const runnerStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-runner-'));
  let fixedPort = null;

  try {
    execFileSync('npm', ['run', 'build'], { cwd: desktopRoot, stdio: 'inherit', timeout: 180_000 });
    pg = await startPostgres();
    authState = createAuthKitState();
    http = await startHttpServer({ pool: pg.pool, authKit: authState.authKit });
    fixedPort = Number(new URL(http.baseUrl).port);
    if (twoAccountMode) {
      const report = await runTwoAccountIsolation({
        pool: pg.pool,
        baseUrl: http.baseUrl,
        authState,
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    ensureCleanUserData(http.baseUrl);

    electronApp = await launchApp(http.baseUrl);
    let page = await electronApp.firstWindow();

    // 1) Login
    await page.waitForSelector('button:has-text("AuthKit으로 계속하기")', { timeout: 25_000 });
    await page.getByRole('button', { name: /AuthKit으로 계속하기/ }).click();
    await page.waitForTimeout(500);
    const pending = authState.getLastStart();
    assert.ok(pending);
    await receiveAuthUrl(electronApp, `agent-calendar://auth/callback?code=p3&state=${encodeURIComponent(pending.state)}`);
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some((b) => /AuthKit으로 계속하기/.test(b.textContent || '')), null, { timeout: 25_000 });
    assert.equal(authState.getCompleteCount(), 1);

    // 2) Follow the clean-account guide into Runner Setup, then enroll → confirm → connect/capabilities.
    const guide = page.getByTestId('onboarding-guide');
    await guide.waitFor({ state: 'visible', timeout: 20_000 });
    await guide.getByRole('button', { name: /Runner와 실행 엔진/ }).click();
    await guide.getByRole('button', { name: 'Runner 연결', exact: true }).click();
    await page.waitForSelector('[data-testid="runner-setup"]', { timeout: 15_000 });
    await page.getByTestId('runner-begin-setup').click();
    await page.getByTestId('runner-issue-challenge').click();
    await page.waitForSelector('[data-testid="runner-human-code"]', { timeout: 15_000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="runner-qr"]');
      return el && el.getAttribute('data-qr-payload');
    }, null, { timeout: 10_000 });
    const qrPayload = await page.getAttribute('[data-testid="runner-qr"]', 'data-qr-payload');
    const qr = JSON.parse(qrPayload);
    const humanCode = (await page.textContent('[data-testid="runner-human-code"]')).trim();

    const enroll = runRunner([
      'enroll', '--base-url', http.baseUrl, '--state-dir', runnerStateDir,
      '--challenge-id', qr.challengeId, '--code', humanCode,
    ], { stateDir: runnerStateDir });
    await enroll.done;

    await page.waitForSelector('[data-testid="runner-fingerprint"]', { timeout: 45_000 });
    await page.getByTestId('runner-confirm').click();
    await runRunner(['claim-wait', '--base-url', http.baseUrl, '--state-dir', runnerStateDir, '--timeout-ms', '60000'], { stateDir: runnerStateDir }).done;
    await runRunner(['connect', '--base-url', http.baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;
    await runRunner(['capabilities', '--base-url', http.baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;

    // 3) Agent Operations must show Runner connected (product poll/refresh on open — no hardcoded 미연결)
    await page.getByRole('button', { name: /에이전트/ }).first().click();
    await page.waitForSelector('[data-testid="agent-runner-live"]', { timeout: 20_000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="agent-runner-live"]');
      return el
        && el.getAttribute('data-runner-connected') === 'true'
        && /Runner 연결됨/.test(el.textContent || '');
    }, null, { timeout: 60_000 });
    assert.equal(await page.getAttribute('[data-testid="agent-runner-live"]', 'data-runner-connected'), 'true');
    assert.match(await page.textContent('[data-testid="agent-runner-live"]') || '', /Runner 연결됨/);

    // 4) REAL backend HTTP restart against same PG/base URL AFTER runner ready, BEFORE work lease
    // Accept work after restart so lease happens post-restart (proves durable recover).
    // User asked: restart after work accepted but before lease — so:
    // Create work first, then restart, then work-once.

    // Create Delegated Work exclusively via Desktop composer + 위임.
    const composer = page.getByLabel('에이전트에게 작업 지시');
    await composer.waitFor({ timeout: 15_000 });
    await composer.fill(WORK_GOAL);
    // Default regression uses Automatic/Fake; live mode explicitly selects the requested Engine.
    const advanced = page.locator('summary:has-text("고급 설정")');
    if (await advanced.count()) {
      await advanced.click().catch(() => {});
      const engineSelect = page.getByLabel('실행 엔진');
      if (await engineSelect.count()) {
        await engineSelect.selectOption(useFakeEngine ? 'auto' : selectedEngine);
      }
    }
    await page.getByRole('button', { name: '위임' }).click();

    // Selected Work Conversation must open with accepted/waiting_runner checkpoint
    await page.waitForFunction((goal) => {
      const text = document.body ? document.body.innerText : '';
      return text.includes(goal)
        && (/Work accepted|accepted|waiting_runner|대기|queued/i.test(text));
    }, WORK_GOAL, { timeout: 45_000 });
    const queuedText = await page.locator('body').innerText();
    assert.match(queuedText, /Work accepted|accepted|waiting_runner/i);
    assert.doesNotMatch(queuedText, /production_disabled|blocked_runner_required/);
    await page.screenshot({ path: shots.queued, fullPage: true });

    // 5) Backend restart while work accepted, before lease
    await http.close();
    http = await startHttpServer({
      pool: pg.pool,
      authKit: authState.authKit,
      fixedPort,
    });
    assert.equal(http.baseUrl, `http://127.0.0.1:${fixedPort}`);
    // Reap any stale offers after restart
    await http.runtime.durableExecution.reap();

    // Desktop should still be usable against same URL (session intact)
    await page.waitForTimeout(1000);
    // Re-open conversation via back + board if needed
    const back = page.getByRole('button', { name: /뒤로|목록|관제/ }).first();
    if (await back.count()) await back.click().catch(() => {});
    await page.waitForTimeout(500);
    // Click mission card if present
    const missionCard = page.locator(`text=${WORK_GOAL}`).first();
    if (await missionCard.count()) await missionCard.click().catch(() => {});

    // Reconnect runner after backend restart
    await runRunner(['connect', '--base-url', http.baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;
    await runRunner(['capabilities', '--base-url', http.baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;

    // 6) Start work-once asynchronously; capture live plan/progress before completion
    const workOnce = runRunner([
      'work-once', '--base-url', http.baseUrl, '--state-dir', runnerStateDir,
    ], { stateDir: runnerStateDir });

    // Stream Engines expose Plan/Progress. Grok and Hermes are batch-only, so their
    // persisted Engine checkpoint is the only honest pre-result live evidence.
    await page.waitForFunction((engine) => {
      const text = document.body ? document.body.innerText : '';
      if (engine === 'hermes') return /Hermes:|Hermes safe profile/i.test(text);
      if (engine === 'grok') return /Grok:|Grok CLI/i.test(text);
      return /Plan:|Progress:/i.test(text);
    }, selectedEngine, { timeout: 90_000 });
    const liveText = await page.locator('body').innerText();
    assert.match(
      liveText,
      selectedEngine === 'hermes'
        ? /Hermes:|Hermes safe profile/i
        : selectedEngine === 'grok'
          ? /Grok:|Grok CLI/i
          : /Plan:|Progress:/i,
    );
    assert.doesNotMatch(liveText, /Completed fake execution/i);
    await page.screenshot({ path: shots.live, fullPage: true });

    const execOut = await workOnce.done;
    if (expectFailure) {
      assert.match(execOut, /"failed"\s*:\s*true/i);
      assert.match(execOut, new RegExp(expectedErrorCode, 'i'));
      await page.waitForFunction((errorCode) => {
        const text = document.querySelector('.agent-work-timeline')?.textContent || '';
        return text.includes(String(errorCode));
      }, expectedErrorCode, { timeout: 90_000 });
      await page.waitForSelector('.agent-work-status-badge[data-status="failed"]', { timeout: 30_000 });
    } else {
      assert.match(execOut, /completed|ok|idle/i);
      await page.waitForFunction((resultMarker) => {
        const text = document.querySelector('.agent-work-timeline')?.textContent || '';
        return text.includes(String(resultMarker));
      }, expectedResultMarker, { timeout: 90_000 });
      assert.ok((await page.locator('.agent-work-timeline').innerText()).includes(expectedResultMarker));
    }

    // 7) Await the truthful terminal UI in the same selected conversation.
    const completedText = await page.locator('body').innerText();
    if (expectFailure) {
      assert.match(completedText, /재시도 필요/);
      assert.match(completedText, new RegExp(expectedErrorCode, 'i'));
    }
    // Execution Engine contract: requested stays 자동 선택; actual resolved engine is visible.
    await page.waitForSelector('[data-testid="agent-work-resolved-engine"]', { timeout: 15_000 });
    const resolvedLabel = (await page.textContent('[data-testid="agent-work-resolved-engine"]') || '').trim();
    assert.notEqual(resolvedLabel, '확인 불가');
    assert.match(resolvedLabel, new RegExp(expectedEngineLabel, 'i'));
    if (useFakeEngine) {
      assert.match(completedText, /요청 방식[\s\S]*자동 선택/);
    } else {
      assert.match(completedText, new RegExp(`요청 방식[\\s\\S]*${expectedEngineLabel}`, 'i'));
    }
    assert.match(completedText, new RegExp(`실제 실행[\\s\\S]*${expectedEngineLabel}`, 'i'));
    await page.screenshot({ path: shots.completed, fullPage: true });

    if (!useFakeEngine && !expectFailure && selectedEngine === 'codex') {
      providerJourney = await runLiveProviderSessionJourney({
        page,
        baseUrl: http.baseUrl,
        runnerStateDir,
        pool: pg.pool,
      });
    }
    const expectedCompletedAttempts = expectFailure ? 0 : (providerJourney ? 2 : 1);

    // Assert DB terminals only as result verification (not journey-driving)
    const completedAttempts = await pg.pool.query(
      `select count(*)::int as n from execution_attempts where status = 'completed'`,
    );
    const failedAttempts = await pg.pool.query(
      `select count(*)::int as n from execution_attempts where status = 'failed'`,
    );
    assert.equal(completedAttempts.rows[0].n, expectedCompletedAttempts);
    assert.equal(failedAttempts.rows[0].n, expectFailure ? 1 : 0);
    if (expectFailure) {
      const failedJob = await pg.pool.query(
        `select status, last_error_code from execution_jobs limit 1`,
      );
      assert.equal(failedJob.rows[0].status, 'failed');
      assert.equal(failedJob.rows[0].last_error_code, expectedErrorCode);
    }

    // 8) Calendar UI keeps the same agent-work projection and exposes its terminal lifecycle.
    await page.getByRole('button', { name: /캘린더/ }).first().click();
    await page.waitForFunction(({ goal, terminalLabel }) => {
      const text = document.body ? document.body.innerText : '';
      return text.includes('Agent work:')
        && text.includes(goal.slice(0, 24))
        && text.includes(terminalLabel);
    }, {
      goal: WORK_GOAL,
      terminalLabel: expectFailure ? '실패' : '완료',
    }, { timeout: 45_000 });
    const calText = await page.locator('body').innerText();
    if (expectFailure) {
      assert.match(calText, /Agent work:/i);
      assert.match(calText, /실패/);
    } else {
      assert.match(calText, /Agent work:/i);
      assert.match(calText, /완료/);
    }
    assert.ok(calText.includes(WORK_GOAL.slice(0, 24)));
    assert.equal(await page.locator('.api-banner').count(), 0);
    await page.screenshot({ path: shots.calendar, fullPage: true });

    // 9) Desktop restart after terminal state — completeCount stays 1, no login wall.
    await closeApp(electronApp);
    electronApp = await launchApp(http.baseUrl);
    page = await electronApp.firstWindow();
    await page.waitForTimeout(2000);
    const loginCount = await page.locator('button:has-text("AuthKit으로 계속하기")').count();
    assert.equal(loginCount, 0, 'login wall must not appear after Desktop restart');
    assert.equal(authState.getCompleteCount(), 1, 'completeCount must remain exactly 1');

    await page.getByRole('button', { name: /에이전트/ }).first().click();
    await page.waitForTimeout(1500);
    // Open existing work through UI
    const restored = page.locator(`text=${WORK_GOAL}`).first();
    if (await restored.count()) {
      await restored.click();
      await page.waitForTimeout(1000);
    }
    await page.waitForFunction((terminalMarker) => {
      const text = document.body ? document.body.innerText : '';
      return terminalMarker
        ? text.includes(String(terminalMarker))
        : /Work accepted|Plan:|Progress:|Completed|Artifact ready/i.test(text);
    }, expectFailure ? expectedErrorCode : '', { timeout: 30_000 });
    if (expectFailure) {
      await page.waitForSelector('.agent-work-status-badge[data-status="failed"]', { timeout: 20_000 });
      assert.match(await page.locator('.agent-work-timeline').innerText(), new RegExp(expectedErrorCode, 'i'));
    }
    await page.waitForFunction((engineLabel) => {
      const el = document.querySelector('[data-testid="agent-work-resolved-engine"]');
      return el && String(el.textContent || '').toLowerCase().includes(String(engineLabel).toLowerCase());
    }, expectedEngineLabel, { timeout: 20_000 });
    const rehydratedResolved = (await page.textContent('[data-testid="agent-work-resolved-engine"]') || '').trim();
    assert.equal(rehydratedResolved, expectedEngineLabel);
    assert.doesNotMatch(await page.locator('body').innerText(), /실제 실행\s*확인 불가/);
    await page.screenshot({ path: shots.rehydrated, fullPage: true });
    if (providerJourney) {
      await verifyLiveProviderSessionRehydrated(page, providerJourney);
    }

    // 10) After reconnect, no terminal replay or duplicate Calendar projection.
    await runRunner(['connect', '--base-url', http.baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;
    const idle = await runRunner(['work-once', '--base-url', http.baseUrl, '--state-dir', runnerStateDir], { stateDir: runnerStateDir }).done;
    assert.ok(/idle|ok|completed/i.test(idle));
    const completedAttempts2 = await pg.pool.query(
      `select count(*)::int as n from execution_attempts where status = 'completed'`,
    );
    const failedAttempts2 = await pg.pool.query(
      `select count(*)::int as n from execution_attempts where status = 'failed'`,
    );
    assert.equal(completedAttempts2.rows[0].n, expectedCompletedAttempts, 'completed attempt count is stable');
    assert.equal(failedAttempts2.rows[0].n, expectFailure ? 1 : 0, 'failed attempt count is stable');
    const calCount = await pg.pool.query(
      `select count(*)::int as n from calendar_events where payload->>'source' = 'agent-work'`,
    );
    assert.equal(calCount.rows[0].n, providerJourney ? 2 : 1, 'Calendar projection count matches work turns');

    // Screenshot uniqueness + state-specific text
    const hashes = {};
    const evidenceShots = providerJourney
      ? {
        ...shots,
        providerSessionContinued: providerSessionShots.continued,
        providerSessionRehydrated: providerSessionShots.rehydrated,
      }
      : shots;
    for (const [name, file] of Object.entries(evidenceShots)) {
      assert.ok(fs.existsSync(file), `missing ${name}`);
      assert.ok(fs.statSync(file).size > 800, `too small ${name}`);
      hashes[name] = sha256File(file);
    }
    const unique = new Set(Object.values(hashes));
    assert.equal(unique.size, Object.keys(evidenceShots).length, `screenshots must be unique hashes: ${JSON.stringify(hashes)}`);

    // State-specific visible assertions already enforced via waiters; re-check files aren't byte-identical empty shells
    assert.notEqual(hashes.queued, hashes.live);
    assert.notEqual(hashes.live, hashes.completed);
    assert.notEqual(hashes.completed, hashes.calendar);

    const report = {
      ok: true,
      mode: 'single-account',
      selectedEngine,
      identityProvider: 'workos_authkit_test_adapter',
      identityProviderLive: false,
      authAdapterInjected: true,
      durationMs: Date.now() - started,
      backendRestart: true,
      desktopRestart: true,
      runnerEnrolled: true,
      engineAuthenticated: true,
      delegatedWorkCompleted: !expectFailure,
      realtimeCheckpointObserved: true,
      calendarResultVisible: !expectFailure,
      runnerReconnected: true,
      sessionRestoredWithoutLogin: true,
      providerAgentImported: Boolean(providerJourney),
      providerSessionImported: Boolean(providerJourney),
      providerSessionContinued: Boolean(providerJourney),
      providerSessionRestored: Boolean(providerJourney),
      providerSessionArchived: Boolean(providerJourney),
      completeCount: authState.getCompleteCount(),
      expectedErrorCode: expectedErrorCode || null,
      completedAttempts: completedAttempts2.rows[0].n,
      failedAttempts: failedAttempts2.rows[0].n,
      calendarEvents: calCount.rows[0].n,
      screenshotHashes: hashes,
      artifactDir,
      userOwnedRunnerHost: useFakeEngine
        ? 'not exercised; local Fake Engine golden ETE is deterministic product proof'
        : `not exercised; ${expectedEngineLabel} live ETE ran on the current non-production host`,
    };
    const releaseEvidenceWritten = writeReleaseEvidence(report, evidenceBinding);
    console.log(JSON.stringify({ ...report, releaseEvidenceWritten }, null, 2));
  } finally {
    clearTimeout(hard);
    await closeApp(electronApp);
    if (http) await http.close();
    if (pg) {
      try { await pg.pool.end(); } catch { /* ignore */ }
      stopCluster(pg.binDir, pg.dataDir);
      fs.rmSync(pg.workDir, { recursive: true, force: true });
    }
    fs.rmSync(runnerStateDir, { recursive: true, force: true });
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
