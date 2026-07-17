const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const desktopRoot = path.resolve(__dirname, '..');
const executablePath = path.join(desktopRoot, 'release', 'mac-arm64', 'Agent Calendar.app', 'Contents', 'MacOS', 'Agent Calendar');
const userDataName = `Agent Calendar Deep Link Smoke ${process.pid}`;
const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const now = '2026-07-15T10:00:00.000Z';

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
    tasks: [],
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
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const sessionMatch = requestUrl.pathname.match(/^\/api\/agent-operations\/sessions\/([^/]+)$/);
    let payload = fallbackEnvelope();
    if (requestUrl.pathname === '/api/agent-operations') {
      payload = { ok: true, missions: [], tasks: [], sessions: [], reports: [], daemon: { running: true, lastRun: now, lastError: null } };
    } else if (sessionMatch) {
      payload = sessionEnvelope(decodeURIComponent(sessionMatch[1]));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock gateway did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
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
    ['Hermes 자동화', 'Hermes 자동화'],
    ['위젯', '위젯'],
  ];
  const verified = [];

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
  await window.locator('.settings-overlay footer').getByRole('button', { name: '완료' }).click();
  await window.locator('.settings-overlay').waitFor({ state: 'detached' });
  verified.push('설정');

  return verified;
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log(JSON.stringify({ ok: true, skipped: 'macOS packaged app required' }));
    return;
  }
  assert.equal(fs.existsSync(executablePath), true, 'run dist:mac before packaged deep-link smoke');
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
  try {
    electronApp = await electron.launch({
      executablePath,
      args: ['agent-calendar://sessions/session-cold-start'],
      env: { ...process.env, AGENT_CALENDAR_USER_DATA_NAME: userDataName },
    });
    const window = await electronApp.firstWindow();
    await window.locator('.task-session-panel').waitFor();
    await assert.doesNotReject(window.getByRole('dialog', { name: 'Task Session: Cold Launch Task Session' }).waitFor());
    assert.match(await window.locator('.task-session-event-text').textContent() || '', /Cold Launch deep link opened/);

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
    console.log(JSON.stringify({ ok: true, coldLaunch: true, runningApp: true, invalidUrlRejected: true, verifiedSurfaces }));
  } finally {
    if (electronApp) await electronApp.close();
    await closeServer(server);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
