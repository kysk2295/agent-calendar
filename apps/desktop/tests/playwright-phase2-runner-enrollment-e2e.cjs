'use strict';

/**
 * Phase 2 E2E: fake AuthKit + production backend/PG + real apps/runner + Electron.
 * Single process, hard timeout, cleanup Electron/Runner/PG.
 *
 * Journey: login → Runner Setup → challenge/QR (decoded) → local runner enroll → pending fingerprint
 * → confirm → claim → connect/capabilities → test → disconnect (Disconnected) → reconnect (Connected)
 * → credential rotate (old denied) → revoke (Revoked UI) → calendar-first.
 */

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

const { runMigrations } = require('../../backend/app/db/migrate');
const { createRailwayGatewayServer } = require('../../backend/app/railway-gateway-server');
const { createPhase1Runtime } = require('../../backend/app/lib/phase1-auth-routes');
const { resolvePostgresBinDir } = require('../../backend/app/lib/phase0-snapshot-restore');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const runnerBin = path.join(repoRoot, 'apps/runner/bin/agent-calendar-runner.js');
const artifactDir = path.join(desktopRoot, 'test-results', 'phase2-runner-enrollment');
const userDataName = `Agent Calendar Phase2 Runner E2E ${process.pid}`;
const userData = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const sessionFile = path.join(userData, 'app-session.enc');
const settingsFile = path.join(userData, 'settings.json');
const HARD_TIMEOUT_MS = Number(process.env.AGENT_CALENDAR_E2E_TIMEOUT_MS || 180_000);
const LOCAL_ROLE = 'phase2e2erunner';
const DATABASE = 'phase2_e2e_runner';

const screenshots = {
  authBoundaries: path.join(artifactDir, 'auth-boundaries.png'),
  setupCode: path.join(artifactDir, 'setup-code-qr.png'),
  qrElement: path.join(artifactDir, 'qr-element.png'),
  fingerprint: path.join(artifactDir, 'pending-fingerprint.png'),
  capabilities: path.join(artifactDir, 'capabilities-ready.png'),
  disconnected: path.join(artifactDir, 'disconnected.png'),
  reconnected: path.join(artifactDir, 'reconnected.png'),
  rotated: path.join(artifactDir, 'rotated-reconnected.png'),
  revoked: path.join(artifactDir, 'revoked-setup.png'),
  calendarAfterRevoke: path.join(artifactDir, 'revoked-calendar.png'),
};

function decodeQrPngFile(pngPath) {
  const buf = fs.readFileSync(pngPath);
  const png = PNG.sync.read(buf);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded) {
    throw new Error(`jsQR failed to decode PNG ${pngPath} (${png.width}x${png.height})`);
  }
  return decoded.data;
}

function readRunnerState(stateDir) {
  const statePath = path.join(stateDir, 'state.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeRunnerState(stateDir, state) {
  fs.writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

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
      await sleep(100);
    }
  }
  throw new Error('ephemeral PostgreSQL did not become ready');
}

function stopCluster(binDir, dataDir) {
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
  } catch { /* ignore */ }
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

function forceKillPid(pid) {
  if (!pidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

async function waitForPidExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

function ensureCleanUserData(apiBaseUrl) {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: 'default',
    auth: null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2)}\n`);
}

async function startProductionBackend() {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('PG binaries missing');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-e2e-runner-'));
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

  let lastStart = null;
  let completeCount = 0;
  const authKit = {
    async getAuthorizationUrlWithPKCE({ state }) {
      const codeVerifier = `verifier_phase2_${Date.now()}`;
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
          id: 'workos_user_phase2',
          email: 'phase2-owner@example.com',
          firstName: 'Phase2',
          lastName: 'Owner',
          emailVerified: true,
        },
      };
    },
  };

  const runtime = createPhase1Runtime({
    pool,
    authKit,
    workosConfig: { clientId: 'client_phase2_e2e', apiKeyConfigured: true },
  });

  const stubStore = {
    getState: () => ({ tasks: [], agents: [], runs: [], events: [] }),
    ready: Promise.resolve(),
  };
  const server = createRailwayGatewayServer({
    env: {
      WORKSPACE_AUTH_MODE: 'production',
      HERMES_REMOTE_AUTH_TOKEN: 'legacy-must-not-work',
      RUNNER_RELEASE_STATUS: 'local_development',
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
  assert.equal(fs.existsSync(mainJs), true, 'build electron first');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify({
    apiBaseUrl,
    apiToken: '',
    theme: 'default',
    auth: null,
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
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
  if (!electronApp) return;
  let pid = null;
  try { pid = electronApp.process().pid; } catch { pid = null; }
  try {
    await electronApp.evaluate(async ({ app }) => { app.exit(0); }).catch(() => {});
  } catch { /* ignore */ }
  try {
    await Promise.race([electronApp.close(), sleep(2_000)]);
  } catch { /* ignore */ }
  if (pid && pidAlive(pid)) forceKillPid(pid);
  if (pid) await waitForPidExit(pid, 8_000);
  await sleep(300);
}

function startRunnerDaemon({ baseUrl, stateDir, challengeId, code }) {
  const probe = {
    engines: {
      codex: { available: true, status: 'available', version: '0.40.0', authStatus: 'ok', message: 'injected available' },
      claude: { installed: true, available: true, status: 'available', version: '1.0.0', authStatus: 'missing', message: 'injected installed without auth' },
      grok: { available: false, status: 'unavailable', version: null, authStatus: 'missing', message: 'injected unavailable' },
      hermes: { available: true, status: 'available', version: '1.2.0', authStatus: 'ok', message: 'injected available' },
    },
  };
  const child = spawn(process.execPath, [
    runnerBin,
    'daemon',
    '--base-url', baseUrl,
    '--state-dir', stateDir,
    '--challenge-id', challengeId,
    '--code', code,
    '--once',
    '--timeout-ms', '90000',
  ], {
    env: {
      ...process.env,
      AGENT_CALENDAR_RUNNER_PROBE_JSON: JSON.stringify(probe),
      AGENT_CALENDAR_RUNNER_HOME: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (chunk) => {
    String(chunk).split('\n').filter(Boolean).forEach((line) => lines.push(line));
  });
  child.stderr.on('data', (chunk) => {
    String(chunk).split('\n').filter(Boolean).forEach((line) => lines.push(`ERR ${line}`));
  });
  return {
    child,
    lines,
    pid: child.pid,
    async waitForPhase(phase, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (lines.some((l) => l.includes(`"phase":"${phase}"`) || l.includes(`"phase": "${phase}"`))) {
          return true;
        }
        if (child.exitCode != null && child.exitCode !== 0) {
          throw new Error(`runner exited ${child.exitCode}: ${lines.join('\n')}`);
        }
        await sleep(200);
      }
      throw new Error(`runner phase ${phase} timeout. lines=${lines.join(' | ')}`);
    },
    kill() {
      if (child.pid && pidAlive(child.pid)) forceKillPid(child.pid);
    },
  };
}

function runRunnerCommand(args, { stateDir, env = {}, timeoutMs = 20_000 } = {}) {
  const result = spawn(process.execPath, [runnerBin, ...args], {
    env: {
      ...process.env,
      AGENT_CALENDAR_RUNNER_HOME: stateDir,
      AGENT_CALENDAR_RUNNER_PROBE_JSON: JSON.stringify({
        engines: {
          codex: { available: true, status: 'available', version: '0.40.0', authStatus: 'ok', message: 'injected' },
          claude: { installed: true, available: true, status: 'available', version: '1.0.0', authStatus: 'missing', message: 'injected installed without auth' },
          grok: { available: false, status: 'unavailable', version: null, authStatus: 'missing', message: 'injected' },
          hermes: { available: true, status: 'available', version: '1.2.0', authStatus: 'ok', message: 'injected' },
        },
      }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  result.stdout.on('data', (c) => { stdout += String(c); });
  result.stderr.on('data', (c) => { stderr += String(c); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      forceKillPid(result.pid);
      reject(new Error(`runner command timeout: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    result.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`runner exit ${code}: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
}

async function runScenario(backend) {
  ensureCleanUserData(backend.baseUrl);
  const runnerStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-runner-state-'));
  let electronApp = await launchApp({ apiBaseUrl: backend.baseUrl });
  let runnerHandle = null;

  try {
    const page = await electronApp.firstWindow();
    await page.waitForSelector('button:has-text("AuthKit으로 계속하기")', { timeout: 25_000 });
    await page.getByRole('button', { name: /AuthKit으로 계속하기/ }).click();
    await page.waitForTimeout(600);
    const pending = backend.getLastStart();
    assert.ok(pending, 'desktop start must invoke AuthKit');
    await receiveAuthUrl(
      electronApp,
      `agent-calendar://auth/callback?code=code-phase2-e2e&state=${encodeURIComponent(pending.state)}`,
    );
    await page.waitForFunction(() => {
      return !Array.from(document.querySelectorAll('button'))
        .some((b) => /AuthKit으로 계속하기/.test(b.textContent || ''));
    }, null, { timeout: 25_000 });
    await page.waitForTimeout(800);
    assert.equal(backend.getCompleteCount(), 1);

    // Follow the clean-account guide: choose Runner, then open its setup surface.
    const guide = page.getByTestId('onboarding-guide');
    await guide.waitFor({ state: 'visible', timeout: 20_000 });
    await guide.getByRole('button', { name: /Runner와 실행 엔진/ }).click();
    const authBoundaries = guide.getByTestId('onboarding-auth-boundaries');
    await authBoundaries.waitFor({ state: 'visible', timeout: 10_000 });
    const authBoundaryCopy = await authBoundaries.innerText();
    assert.match(authBoundaryCopy, /작업공간 로그인/);
    assert.match(authBoundaryCopy, /캘린더 OAuth/);
    assert.match(authBoundaryCopy, /실행 엔진 인증/);
    assert.match(authBoundaryCopy, /자격 증명은 사용자 소유 Runner에만 남습니다/);
    await page.screenshot({ path: screenshots.authBoundaries, fullPage: true });
    await guide.getByRole('button', { name: 'Runner 연결', exact: true }).click();
    await page.waitForSelector('[data-testid="runner-setup"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="runner-workspace-label"]', { timeout: 10_000 });

    // Login wall already passed; install step
    await page.getByTestId('runner-begin-setup').click();
    await page.waitForSelector('[data-testid="runner-step-install"]', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="runner-manifest"]', { timeout: 10_000 });
    const manifestStatus = await page.getAttribute('[data-testid="runner-manifest"]', 'data-status');
    assert.ok(['local_development', 'verified_signed', 'unavailable'].includes(manifestStatus));

    // Issue challenge
    await page.getByTestId('runner-issue-challenge').click();
    await page.waitForSelector('[data-testid="runner-human-code"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="runner-qr"]', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="runner-qr"]');
      return el && el.querySelector('svg') && el.querySelector('svg').children.length > 0;
    }, null, { timeout: 10_000 });

    const humanCode = (await page.textContent('[data-testid="runner-human-code"]')).trim();
    const qrPayload = await page.getAttribute('[data-testid="runner-qr"]', 'data-qr-payload');
    assert.ok(humanCode.match(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/), `code=${humanCode}`);
    assert.ok(qrPayload && qrPayload.includes(humanCode));
    const qrJson = JSON.parse(qrPayload);
    assert.equal(qrJson.kind, 'agent-calendar-runner-enroll');
    assert.ok(qrJson.challengeId);

    // Capture QR element PNG and decode with jsQR — must equal qrPayload exactly.
    await page.locator('[data-testid="runner-qr"]').screenshot({ path: screenshots.qrElement });
    const decodedFromPng = decodeQrPngFile(screenshots.qrElement);
    assert.equal(decodedFromPng, qrPayload, 'rendered QR PNG must decode exactly to enrollment qrPayload');
    await page.screenshot({ path: screenshots.setupCode, fullPage: true });

    assert.equal(await page.locator('.api-banner').count(), 0);
    assert.equal(await page.locator('.api-error').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes('production_disabled'), false);

    runnerHandle = startRunnerDaemon({
      baseUrl: backend.baseUrl,
      stateDir: runnerStateDir,
      challengeId: qrJson.challengeId,
      code: humanCode,
    });
    await runnerHandle.waitForPhase('pending', 45_000);

    await page.waitForSelector('[data-testid="runner-fingerprint"]', { timeout: 45_000 });
    const fingerprint = (await page.textContent('[data-testid="runner-fingerprint"]')).trim();
    assert.ok(fingerprint.length > 20);
    await page.screenshot({ path: screenshots.fingerprint, fullPage: true });

    await page.getByTestId('runner-confirm').click();
    await runnerHandle.waitForPhase('claimed', 45_000);
    await runnerHandle.waitForPhase('connected', 30_000);
    await runnerHandle.waitForPhase('capabilities', 30_000);

    await page.waitForSelector('[data-testid="runner-engines"]', { timeout: 45_000 });
    await page.waitForSelector('[data-testid="runner-engines"] [data-engine="codex"][data-available="true"][data-auth-state="authenticated"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="runner-engines"] [data-engine="claude"][data-available="false"][data-auth-state="auth_required"]', { timeout: 10_000 });
    const engineCopy = await page.getByTestId('runner-engines').innerText();
    assert.match(engineCopy, /Runner 인증 확인됨/);
    assert.match(engineCopy, /Runner에서 로그인하세요/);

    await page.getByTestId('runner-connection-test').click();
    await page.waitForSelector('[data-testid="runner-test-message"][data-passed="true"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="runner-step-ready"]', { timeout: 15_000 });
    await page.screenshot({ path: screenshots.capabilities, fullPage: true });

    // Explicit disconnect via real runner CLI, then assert Disconnected on Setup UI.
    if (runnerHandle) runnerHandle.kill();
    await runRunnerCommand(
      ['connect', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    await runRunnerCommand(
      ['disconnect', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    if (await page.getByTestId('runner-refresh-state').count()) {
      await page.getByTestId('runner-refresh-state').click();
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="runner-connection-state"]');
      return el && el.getAttribute('data-state') === 'disconnected';
    }, null, { timeout: 20_000 });
    assert.equal(await page.getAttribute('[data-testid="runner-connection-state"]', 'data-state'), 'disconnected');
    assert.match(await page.textContent('[data-testid="runner-connection-label"]') || '', /^Disconnected$/i);
    await page.waitForSelector('[data-testid="runner-reconnect-required"]', { timeout: 10_000 });
    const disconnectedBody = await page.locator('body').innerText();
    assert.match(disconnectedBody, /다시 연결 필요/);
    assert.doesNotMatch(disconnectedBody, /준비 완료/);
    assert.doesNotMatch(disconnectedBody, /Runner가 Workspace에 연결되었습니다/);
    // No live green readiness: historical copy only if present
    assert.equal(await page.locator('[data-testid="runner-step-ready"]').count(), 0);
    assert.equal(await page.locator('[data-testid="runner-test-message"][data-kind="current_pass"]').count(), 0);
    assert.equal(await page.locator('[data-testid="runner-test-message"][data-passed="true"]').count(), 0);
    const historical = page.locator('[data-testid="runner-test-message"][data-kind="historical_pass"]');
    if (await historical.count()) {
      assert.match(await historical.innerText(), /마지막 연결 테스트는 통과했지만 현재는 연결되지 않았습니다/);
    }
    await page.screenshot({ path: screenshots.disconnected, fullPage: true });

    // Reconnect same credential → Connected
    const reconnectOut = await runRunnerCommand(
      ['connect', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    assert.match(reconnectOut, /"ok":\s*true|"connectionState":\s*"connected"/);
    await runRunnerCommand(
      ['capabilities', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    await runRunnerCommand(
      ['heartbeat', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    if (await page.getByTestId('runner-refresh-state').count()) {
      await page.getByTestId('runner-refresh-state').click();
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="runner-connection-state"]');
      return el && el.getAttribute('data-state') === 'connected';
    }, null, { timeout: 20_000 });
    assert.equal(await page.getAttribute('[data-testid="runner-connection-state"]', 'data-state'), 'connected');
    assert.match(await page.textContent('[data-testid="runner-connection-label"]') || '', /^Connected$/i);
    // Re-run connection test after reconnect so ready card is valid again.
    await page.getByTestId('runner-connection-test').click();
    await page.waitForSelector('[data-testid="runner-step-ready"]', { timeout: 20_000 });
    assert.equal(await page.locator('[data-testid="runner-reconnect-required"]').count(), 0);
    const reconnectedBody = await page.locator('body').innerText();
    assert.match(reconnectedBody, /준비 완료/);
    assert.match(reconnectedBody, /Runner가 Workspace에 연결되었습니다/);
    await page.screenshot({ path: screenshots.reconnected, fullPage: true });

    // Device credential rotation
    const stateBeforeRotate = readRunnerState(runnerStateDir);
    const oldCredential = stateBeforeRotate.deviceCredential;
    assert.ok(oldCredential, 'device credential required before rotate');
    const rotateOut = await runRunnerCommand(
      ['rotate', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    assert.match(rotateOut, /"ok":\s*true/);
    const stateAfterRotate = readRunnerState(runnerStateDir);
    const newCredential = stateAfterRotate.deviceCredential;
    assert.ok(newCredential);
    assert.notEqual(newCredential, oldCredential);

    writeRunnerState(runnerStateDir, {
      ...stateAfterRotate,
      deviceCredential: oldCredential,
      sessionId: '',
      cursor: '',
    });
    let oldDenied = false;
    try {
      await runRunnerCommand(
        ['connect', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
        { stateDir: runnerStateDir, timeoutMs: 12_000 },
      );
    } catch {
      oldDenied = true;
    }
    assert.equal(oldDenied, true, 'old credential must be rejected after rotate');

    writeRunnerState(runnerStateDir, {
      ...stateAfterRotate,
      deviceCredential: newCredential,
      sessionId: '',
      cursor: '',
    });
    await runRunnerCommand(
      ['connect', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    await runRunnerCommand(
      ['heartbeat', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    await runRunnerCommand(
      ['capabilities', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
      { stateDir: runnerStateDir },
    );
    if (await page.getByTestId('runner-refresh-state').count()) {
      await page.getByTestId('runner-refresh-state').click();
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="runner-connection-state"]');
      return el && el.getAttribute('data-state') === 'connected';
    }, null, { timeout: 20_000 });
    assert.match(await page.textContent('[data-testid="runner-connection-label"]') || '', /^Connected$/i);
    await page.getByTestId('runner-connection-test').click();
    await page.waitForSelector('[data-testid="runner-step-ready"]', { timeout: 20_000 });
    assert.equal(await page.locator('[data-testid="runner-reconnect-required"]').count(), 0);
    assert.match(await page.locator('body').innerText(), /준비 완료/);
    await page.screenshot({ path: screenshots.rotated, fullPage: true });

    // Revoke — stay on Runner Setup for Revoked UI
    await page.getByTestId('runner-revoke').click();
    await page.waitForSelector('[data-testid="runner-step-revoked"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="runner-revoked-banner"]', { timeout: 10_000 });
    assert.equal(await page.getAttribute('[data-testid="runner-connection-state"]', 'data-state'), 'revoked');
    assert.match(await page.textContent('[data-testid="runner-connection-label"]') || '', /Revoked/i);
    await page.screenshot({ path: screenshots.revoked, fullPage: true });

    let revokedDenied = false;
    try {
      await runRunnerCommand(
        ['connect', '--base-url', backend.baseUrl, '--state-dir', runnerStateDir],
        { stateDir: runnerStateDir, timeoutMs: 10_000 },
      );
    } catch {
      revokedDenied = true;
    }
    assert.equal(revokedDenied, true, 'credential must be rejected after owner revoke');

    await page.getByTestId('runner-return-calendar-after-revoke').click();
    await page.waitForSelector('.screen-heading strong:has-text("캘린더")', { timeout: 15_000 });
    assert.equal(await page.locator('.api-banner').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes('production_disabled'), false);
    await page.screenshot({ path: screenshots.calendarAfterRevoke, fullPage: true });

    for (const [name, filePath] of Object.entries(screenshots)) {
      assert.equal(fs.existsSync(filePath), true, `missing screenshot ${name}`);
      assert.ok(fs.statSync(filePath).size > 500, `screenshot too small ${name}`);
    }

    return {
      ok: true,
      humanCode,
      fingerprint,
      qrDecoded: decodedFromPng,
      rotation: { oldDenied, newCredentialPresent: Boolean(newCredential) },
      revokeDenied: revokedDenied,
    };
  } finally {
    if (runnerHandle) runnerHandle.kill();
    await closeApp(electronApp);
    fs.rmSync(runnerStateDir, { recursive: true, force: true });
  }
}

async function main() {
  const started = Date.now();
  let backend = null;
  const hardTimer = setTimeout(() => {
    console.error('HARD_TIMEOUT');
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  try {
    // Always rebuild renderer for UI/QR corrections in this gap-fix slice.
    execFileSync('npm', ['run', 'build'], { cwd: desktopRoot, stdio: 'inherit', timeout: 180_000 });

    backend = await startProductionBackend();
    const result = await runScenario(backend);
    console.log(JSON.stringify({
      ok: true,
      durationMs: Date.now() - started,
      screenshots: Object.keys(screenshots),
      humanCode: result.humanCode,
      fingerprintPrefix: result.fingerprint.slice(0, 24),
      qrDecodedMatchesPayload: result.qrDecoded != null,
      rotation: result.rotation,
      revokeDenied: result.revokeDenied,
      artifactDir,
    }, null, 2));
  } finally {
    clearTimeout(hardTimer);
    if (backend) await backend.close();
    // Cleanup user data
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
