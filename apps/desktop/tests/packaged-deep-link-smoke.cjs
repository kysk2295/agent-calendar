const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const desktopRoot = path.resolve(__dirname, '..');
const packagedAppPath = process.env.AGENT_CALENDAR_PACKAGED_APP_PATH
  ? path.resolve(process.env.AGENT_CALENDAR_PACKAGED_APP_PATH)
  : path.join(desktopRoot, 'release', 'mac-arm64', 'Agent Calendar.app');
const executablePath = path.join(packagedAppPath, 'Contents', 'MacOS', 'Agent Calendar');
const userDataName = `Agent Calendar Deep Link Smoke ${process.pid}`;
const testSecureStorageKey = randomBytes(32).toString('base64url');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-packaged-smoke-'));
const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const widgetGroupPath = path.join(
  os.homedir(),
  'Library',
  'Group Containers',
  'group.com.agents.calendar',
);
const widgetSnapshotPath = path.join(widgetGroupPath, 'HermesWidgetSnapshot.json');
const widgetActionsPath = path.join(widgetGroupPath, 'HermesWidgetActions.json');
const evidencePath = process.env.AGENT_CALENDAR_PACKAGED_SMOKE_EVIDENCE
  ? path.resolve(process.env.AGENT_CALENDAR_PACKAGED_SMOKE_EVIDENCE)
  : '';
const screenshotDirectory = evidencePath
  ? path.join(path.dirname(evidencePath), 'packaged-screenshots')
  : '';
const now = '2026-07-15T10:00:00.000Z';
const gatewayCalls = [];
let authTransaction = null;
const widgetFileBackups = new Map(
  [widgetSnapshotPath, widgetActionsPath].map((filePath) => [
    filePath,
    fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  ]),
);
const widgetTask = {
  id: 'widget-toggle-task',
  title: 'Packaged widget toggle task',
  date: '2026-07-15',
  status: 'Planned',
  owner: 'Me',
  category: '기본함',
  project: '기본함',
  done: false,
};

function sessionEnvelope(sessionId) {
  const suffix = sessionId === 'session-cold-start' ? 'Cold Launch' : 'Running App';
  return {
    ok: true,
    session: {
      id: sessionId,
      missionId: 'mission-deep-link',
      taskId: `task-${sessionId}`,
      type: 'task',
      title: `${suffix} Task Session`,
      status: 'running',
      pendingInstructions: [],
      createdAt: now,
      updatedAt: now,
      events: [{
        id: `event-${sessionId}`,
        sessionId,
        sequence: 1,
        kind: 'progress',
        text: `${suffix} deep link opened`,
        metadata: {},
        createdAt: now,
      }],
    },
  };
}

function fallbackEnvelope() {
  return {
    ok: true,
    tasks: [widgetTask],
    events: [],
    agents: [],
    runs: [],
    documents: [],
    notes: [],
    commands: [],
    jobs: [],
    messages: [],
    channels: [],
    tools: [],
    graph: { nodes: [], edges: [] },
    settings: { uiPreferences: {} },
    uiPreferences: {},
  };
}

async function listenMockGateway() {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    gatewayCalls.push({ method: request.method || 'GET', path: requestUrl.pathname });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let requestBody = {};
    try {
      requestBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      requestBody = {};
    }
    const sessionMatch = requestUrl.pathname.match(/^\/api\/agent-operations\/sessions\/([^/]+)$/);
    let payload = fallbackEnvelope();
    if (
      request.method === 'POST'
      && requestUrl.pathname === '/api/phase1/auth/desktop/start'
    ) {
      authTransaction = {
        state: `packaged-smoke-state-${process.pid}`,
        codeVerifier: `packaged-smoke-verifier-${process.pid}`,
      };
      payload = {
        ok: true,
        authorizationUrl: `https://authkit.test/authorize?state=${authTransaction.state}`,
        state: authTransaction.state,
        codeVerifier: authTransaction.codeVerifier,
        transactionId: `packaged-smoke-login-${process.pid}`,
        redirectUri: 'agent-calendar://auth/callback',
      };
    } else if (
      request.method === 'POST'
      && requestUrl.pathname === '/api/phase1/auth/desktop/complete'
    ) {
      assert.equal(requestBody.state, authTransaction?.state);
      assert.equal(requestBody.codeVerifier, authTransaction?.codeVerifier);
      payload = {
        ok: true,
        sessionId: 'packaged-smoke-session',
        userId: 'packaged-smoke-user',
        workspaceId: 'packaged-smoke-workspace',
        role: 'owner',
        accessToken: 'packaged-smoke-access',
        refreshToken: 'packaged-smoke-refresh',
        accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        user: {
          id: 'packaged-smoke-user',
          email: 'smoke@example.invalid',
          displayName: 'Packaged Smoke',
        },
      };
    } else if (requestUrl.pathname === '/api/agent-operations') {
      payload = { ok: true, missions: [], tasks: [], sessions: [], reports: [], daemon: { running: true, lastRun: now, lastError: null } };
    } else if (sessionMatch) {
      payload = sessionEnvelope(decodeURIComponent(sessionMatch[1]));
    } else if (
      request.method === 'PATCH'
      && requestUrl.pathname === '/api/tasks/widget-toggle-task'
    ) {
      payload = { ok: true, task: { ...widgetTask, done: true, status: 'Done' } };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock gateway did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function writeEvidence(evidence) {
  if (evidencePath) {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
    });
  }
  console.log(JSON.stringify(evidence));
}

async function captureScreenshot(window, name, screenshots) {
  if (!screenshotDirectory) return;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const screenshotPath = path.join(screenshotDirectory, name);
  await window.screenshot({ path: screenshotPath, fullPage: true });
  screenshots.push({
    name,
    sha256: createHash('sha256').update(fs.readFileSync(screenshotPath)).digest('hex'),
  });
}

function restoreWidgetFiles() {
  for (const [filePath, previous] of widgetFileBackups) {
    if (previous) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, previous);
    } else {
      fs.rmSync(filePath, { force: true });
    }
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function verifyPackagedSurfaces(window) {
  const surfaces = [
    ['캘린더', '캘린더'],
    ['오늘', '오늘'],
    ['다음 7일', '다음 7일'],
    ['기본함', '기본함'],
    ['메일함', '메일함'],
    ['칸반 보드', '칸반 보드'],
    ['주간 회고', '주간 회고'],
    ['위키', '위키'],
    ['일기', '일기'],
    ['에이전트', '에이전트', '.agent-control-room'],
  ];
  const verified = [];
  const secondaryNavigation = window.locator('details.nav-more');
  if (!(await secondaryNavigation.evaluate((element) => element.open))) {
    await secondaryNavigation.locator('summary').click();
  }

  for (const [navigationLabel, heading, contentSelector] of surfaces) {
    await window.locator('.nav-item').filter({ hasText: navigationLabel }).first().click();
    if (contentSelector) {
      await window.locator(contentSelector).waitFor();
    } else {
      await window.locator('.screen-heading strong').filter({ hasText: heading }).waitFor();
    }
    verified.push(heading);
  }

  await window.locator('.sidebar-search').click();
  await window.locator('.screen-heading strong').filter({ hasText: '검색' }).waitFor();
  verified.push('검색');

  await window.getByRole('button', { name: '캘린더 AI 열기' }).click();
  await window.locator('.chat').waitFor();
  await window.getByRole('button', { name: '캘린더 AI 닫기' }).click();
  await window.locator('.chat').waitFor({ state: 'detached' });
  verified.push('캘린더 AI');

  await window.locator('.profile').click();
  await window.locator('.settings-overlay').waitFor();
  await window.getByRole('button', { name: '설정 닫기' }).click();
  await window.locator('.settings-overlay').waitFor({ state: 'detached' });
  verified.push('설정');

  return verified;
}

async function main() {
  if (process.platform !== 'darwin') {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    writeEvidence({ ok: false, skipped: 'macOS packaged app required' });
    return;
  }
  if (!fs.existsSync(executablePath)) {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    assert.fail('run dist:mac before packaged deep-link smoke');
  }
  const { server, baseUrl } = await listenMockGateway();
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'settings.json'), `${JSON.stringify({
    apiBaseUrl: baseUrl,
    apiToken: '',
    theme: 'default',
    auth: { provider: 'password', id: 'deep-link-smoke', email: 'smoke@example.invalid', name: 'Deep Link Smoke', updatedAt: now },
    uiPreferences: { notify: false, agentShare: false, weekStartMon: true },
  }, null, 2)}\n`);

  let electronApp;
  const screenshots = [];
  try {
    electronApp = await electron.launch({
      executablePath,
      args: ['agent-calendar://sessions/session-cold-start'],
      env: {
        ...process.env,
        AGENT_CALENDAR_USER_DATA_NAME: userDataName,
        AGENT_CALENDAR_E2E_AUTH: '1',
        AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE: '1',
        AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY: testSecureStorageKey,
        AGENT_CALENDAR_E2E_SECURE_STORAGE_PID: String(process.pid),
      },
    });
    const window = await electronApp.firstWindow();
    await window.locator('.app-root').waitFor();
    const secureStorageReceipt = await electronApp.evaluate(() => {
      const bridge = globalThis.__agentCalendarE2E;
      if (!bridge) throw new Error('packaged auth E2E bridge is missing');
      return bridge.getSecureStorageReceipt();
    });
    assert.deepEqual(secureStorageReceipt, {
      backend: 'qa-aes-256-gcm',
      nativeSafeStorageCallCount: 0,
      nativeSafeStorageCalls: { availability: 0, encrypt: 0, decrypt: 0 },
    });
    const coldLaunchArgumentPresent = await electronApp.evaluate(
      () => process.argv.includes('agent-calendar://sessions/session-cold-start'),
    );
    assert.equal(
      coldLaunchArgumentPresent,
      true,
      'packaged process did not retain the cold-launch deep-link argument',
    );
    await window.evaluate(async (gatewayUrl) => {
      const settings = await window.hermesDesktop?.getSettings();
      await window.hermesDesktop?.saveSettings({
        apiBaseUrl: gatewayUrl,
        theme: settings?.theme || 'default',
        uiPreferences: settings?.uiPreferences || {
          notify: false,
          agentShare: false,
          weekStartMon: true,
        },
      });
    }, baseUrl);
    const loginButton = window.getByRole('button', { name: /AuthKit으로 계속하기/ });
    if (await loginButton.count()) {
      await loginButton.click();
      await waitFor(() => authTransaction !== null, 'packaged AuthKit start did not reach the gateway');
      await electronApp.evaluate(async (_electron, state) => {
        const bridge = globalThis.__agentCalendarE2E;
        if (!bridge) throw new Error('packaged auth E2E bridge is missing');
        return bridge.receiveAuthUrl(
          `agent-calendar://auth/callback?code=packaged-smoke-code&state=${state}`,
        );
      }, authTransaction.state);
    }
    await window.locator('.task-session-panel').waitFor();
    await assert.doesNotReject(window.getByRole('dialog', { name: 'Task Session: Cold Launch Task Session' }).waitFor());
    assert.match(await window.locator('.task-session-event-text').textContent() || '', /Cold Launch deep link opened/);
    await captureScreenshot(window, 'cold-launch.png', screenshots);

    await window.getByRole('button', { name: 'Task Session 닫기' }).click();
    await window.locator('.task-session-panel').waitFor({ state: 'detached' });
    await electronApp.evaluate(({ app }, rawUrl) => {
      app.emit('open-url', { preventDefault() {} }, rawUrl);
    }, 'agent-calendar://sessions/session-running');
    await assert.doesNotReject(window.getByRole('dialog', { name: 'Task Session: Running App Task Session' }).waitFor());
    assert.match(await window.locator('.task-session-event-text').textContent() || '', /Running App deep link opened/);

    await window.getByRole('button', { name: 'Task Session 닫기' }).click();
    await electronApp.evaluate(({ app }, rawUrl) => {
      app.emit('open-url', { preventDefault() {} }, rawUrl);
    }, 'https://attacker.example/sessions/session-running');
    await window.waitForTimeout(250);
    assert.equal(await window.locator('.task-session-panel').count(), 0);
    const verifiedSurfaces = await verifyPackagedSurfaces(window);
    await captureScreenshot(window, 'packaged-surfaces.png', screenshots);
    await waitFor(
      () => fs.existsSync(widgetSnapshotPath),
      'packaged app did not hydrate the widget snapshot',
    );
    const snapshot = JSON.parse(fs.readFileSync(widgetSnapshotPath, 'utf8'));
    assert.equal(snapshot.tasks.some((task) => task.id === widgetTask.id), true);
    const toggledSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) => (
        task.id === widgetTask.id ? { ...task, done: true, status: 'Done' } : task
      )),
      updatedAt: now,
    };
    fs.writeFileSync(widgetSnapshotPath, `${JSON.stringify(toggledSnapshot)}\n`);
    fs.writeFileSync(widgetActionsPath, `${JSON.stringify([{
      id: 'packaged-widget-toggle',
      type: 'toggleTask',
      taskID: widgetTask.id,
      source: 'task',
      done: true,
      createdAt: now,
    }])}\n`);
    await waitFor(
      () => gatewayCalls.some((call) => (
        call.method === 'PATCH' && call.path === '/api/tasks/widget-toggle-task'
      )),
      'packaged app did not persist the shared widget toggle',
    );
    await captureScreenshot(window, 'widget-toggle.png', screenshots);
    const evidence = {
      ok: true,
      productionRendererBooted: true,
      coldLaunchDeepLink: true,
      runningAppDeepLink: true,
      invalidUrlRejected: true,
      widgetSnapshotHydrated: true,
      widgetTogglePersisted: true,
      secureStorage: secureStorageReceipt,
      verifiedSurfaces,
      screenshots,
      cleanup: { userDataRemoved: false },
    };
    await electronApp.close();
    electronApp = undefined;
    fs.rmSync(userDataPath, { recursive: true, force: true });
    restoreWidgetFiles();
    fs.rmSync(smokeRoot, { recursive: true, force: true });
    evidence.cleanup.userDataRemoved = !fs.existsSync(userDataPath) && !fs.existsSync(smokeRoot);
    writeEvidence(evidence);
  } finally {
    if (electronApp) await electronApp.close();
    await closeServer(server);
    fs.rmSync(userDataPath, { recursive: true, force: true });
    restoreWidgetFiles();
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
