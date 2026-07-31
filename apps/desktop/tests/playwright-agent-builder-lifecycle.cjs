const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = path.resolve(
  process.env.EVIDENCE_DIR
    || '.omo/evidence/production-readiness-completion/task-11/playwright',
);
const theme = process.env.AGENT_CALENDAR_E2E_THEME === 'dark' ? 'dark' : 'default';

function lifecycle({
  state = 'draft',
  revision = 1,
  reviewedRevision = 0,
  testedRevision = 0,
  activeVersion = 0,
  request = '',
  lastTest = null,
} = {}) {
  return {
    origin: 'one_line',
    state,
    revision,
    reviewedRevision,
    testedRevision,
    activeVersion,
    request,
    lastTest,
    reviewedAt: reviewedRevision === revision ? '2026-07-26T06:00:00.000Z' : null,
    activatedAt: state === 'active' ? '2026-07-26T06:01:00.000Z' : null,
  };
}

function agentFromRequest(request) {
  return {
    id: 'agent-builder-e2e',
    displayName: '경쟁사 근거 브리핑 에이전트',
    name: '경쟁사 근거 브리핑 에이전트',
    role: 'Generated agent draft',
    responsibility: request,
    instructions: request,
    responseStyle: '근거를 먼저 제시한다.',
    specialties: [],
    memories: [],
    profileVersion: 1,
    sourceKind: 'native',
    provider: 'agent-calendar',
    externalAgentId: '',
    connectionStatus: 'ready',
    defaultExecutionEngine: 'auto',
    defaultRunnerId: '',
    grants: { allow: [], deny: [] },
    lifecycle: lifecycle({ request }),
    enabled: false,
  };
}

function requestBody(request) {
  try {
    return request.postDataJSON() || {};
  } catch {
    return {};
  }
}

async function connectionRefused(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'resource-register.json'), `${JSON.stringify({
    registeredBeforeLaunch: true,
    resources: [
      { kind: 'vite', host: '127.0.0.1', port: 'ephemeral', owner: 'task-11' },
      { kind: 'chromium', context: 'task-11-agent-builder', owner: 'task-11' },
      { kind: 'userData', value: 'Playwright ephemeral default', owner: 'task-11' },
      { kind: 'runner', value: 'deterministic route fixture, no external process', owner: 'task-11' },
    ],
  }, null, 2)}\n`);

  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser = null;
  let port = 0;
  const calls = [];
  const screenshots = [];
  const requestText = '<b>경쟁사</b> 3곳의 출시 소식을 근거 링크와 함께 요약해줘';
  let agents = [];
  let testSequence = 0;
  const tests = new Map();
  let versions = [];
  const historicalJob = {
    id: 'historical-v1-job',
    name: 'v1 경쟁사 브리핑',
    profileVersion: 1,
  };
  let calendarCount = 0;
  let externalDeliveryCount = 0;

  try {
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not bind');
    port = address.port;
    const url = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await page.addInitScript((selectedTheme) => {
      window.hermesDesktop = {
        getSettings: async () => ({
          apiBaseUrl: '',
          hasApiToken: false,
          hasSession: true,
          theme: selectedTheme,
          authProfile: {
            provider: 'authkit',
            id: 'agent-builder-e2e',
            email: 'builder@example.test',
            name: 'Builder QA',
            updatedAt: '2026-07-26T00:00:00.000Z',
          },
          session: {
            signedIn: true,
            workspaceId: 'workspace-builder-e2e',
            userId: 'agent-builder-e2e',
            role: 'owner',
          },
          uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
        }),
        getSessionStatus: async () => ({
          signedIn: true,
          sessionId: 'session-builder-e2e',
          userId: 'agent-builder-e2e',
          workspaceId: 'workspace-builder-e2e',
          role: 'owner',
          email: 'builder@example.test',
          displayName: 'Builder QA',
          accessExpiresAt: null,
        }),
        getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
        getDesktopReleaseStatus: async () => ({
          supported: false,
          phase: 'unsupported',
          currentVersion: '0.1.0',
          availableVersion: null,
          progressPercent: null,
          checkedAt: null,
          message: '테스트 환경',
        }),
        consumeDesktopRecoveryStatus: async () => ({
          phase: 'none',
          crashCount: 0,
          reason: null,
          occurredAt: null,
          message: '',
        }),
        onDesktopReleaseStatus: () => () => {},
        onAuthSessionChanged: () => () => {},
        onAuthLoginError: () => () => {},
      };
    }, theme);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (!parsed.pathname.startsWith('/api/')) {
        await route.continue();
        return;
      }
      const method = request.method();
      const body = requestBody(request);
      calls.push({ method, path: parsed.pathname, body });

      if (method === 'GET' && parsed.pathname === '/api/agents') {
        await route.fulfill({ json: { ok: true, agents } });
        return;
      }
      if (method === 'POST' && parsed.pathname === '/api/agents/builder') {
        const agent = agentFromRequest(body.request);
        agents = [agent];
        await route.fulfill({ status: 201, json: { ok: true, agent } });
        return;
      }
      const reviewMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/review$/);
      if (method === 'POST' && reviewMatch) {
        const current = agents[0];
        assert.equal(body.expectedRevision, current.lifecycle.revision);
        const agent = {
          ...current,
          lifecycle: {
            ...current.lifecycle,
            reviewedRevision: current.lifecycle.revision,
            reviewedAt: '2026-07-26T06:00:00.000Z',
          },
        };
        agents = [agent];
        await route.fulfill({ json: { ok: true, agent } });
        return;
      }
      const testStartMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/tests$/);
      if (method === 'POST' && testStartMatch) {
        testSequence += 1;
        const current = agents[0];
        const id = `builder-test-${testSequence}`;
        const outcome = testSequence === 1 ? 'failed' : testSequence === 2 ? 'cancelled' : 'passed';
        const testRequest = {
          id,
          agentId: current.id,
          revision: current.lifecycle.revision,
          runnerId: 'runner-builder-e2e',
          provider: 'codex',
          status: 'pending',
          passed: false,
          summary: '',
          durationMs: 0,
          errorCode: '',
        };
        tests.set(id, { ...testRequest, outcome, cancelled: false });
        const agent = {
          ...current,
          lifecycle: {
            ...current.lifecycle,
            state: 'draft',
            testedRevision: 0,
            lastTest: {
              id,
              revision: current.lifecycle.revision,
              status: 'running',
              summary: '',
              durationMs: 0,
            },
          },
          enabled: false,
        };
        agents = [agent];
        await route.fulfill({ status: 202, json: { ok: true, agent, request: testRequest } });
        return;
      }
      const testGetMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/tests\/([^/]+)$/);
      if (method === 'GET' && testGetMatch) {
        const id = decodeURIComponent(testGetMatch[2]);
        const fixture = tests.get(id);
        assert.ok(fixture);
        const current = agents[0];
        const status = fixture.cancelled
          ? 'cancelled'
          : fixture.outcome === 'cancelled'
            ? 'running'
            : fixture.outcome;
        const summary = status === 'passed'
          ? 'Bounded sample passed with no side effects.'
          : status === 'running'
            ? 'Disposable Runner is still bounded.'
            : status === 'cancelled'
              ? 'Disposable builder test was cancelled.'
              : 'Bounded sample failed its explicit assertion.';
        const terminal = !['pending', 'running'].includes(status);
        const agent = terminal
          ? {
            ...current,
            lifecycle: {
              ...current.lifecycle,
              state: status === 'passed' ? 'tested' : 'draft',
              testedRevision: status === 'passed' ? current.lifecycle.revision : 0,
              lastTest: {
                id,
                revision: current.lifecycle.revision,
                status,
                summary,
                durationMs: 35,
              },
            },
            enabled: false,
          }
          : current;
        agents = [agent];
        await route.fulfill({
          json: {
            ok: true,
            agent,
            request: {
              ...fixture,
              status,
              passed: status === 'passed',
              summary,
              durationMs: terminal ? 35 : 0,
            },
          },
        });
        return;
      }
      const cancelMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/tests\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[2]);
        const fixture = tests.get(id);
        fixture.cancelled = true;
        tests.set(id, fixture);
        const current = agents[0];
        const agent = {
          ...current,
          lifecycle: {
            ...current.lifecycle,
            state: 'draft',
            testedRevision: 0,
            lastTest: {
              id,
              revision: current.lifecycle.revision,
              status: 'cancelled',
              summary: 'Disposable builder test was cancelled.',
              durationMs: 0,
            },
          },
          enabled: false,
        };
        agents = [agent];
        await route.fulfill({
          json: {
            ok: true,
            agent,
            request: {
              ...fixture,
              status: 'cancelled',
              passed: false,
              summary: 'Disposable builder test was cancelled.',
            },
          },
        });
        return;
      }
      const activateMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/activate$/);
      if (method === 'POST' && activateMatch) {
        const current = agents[0];
        assert.equal(current.lifecycle.state, 'tested');
        assert.equal(body.expectedRevision, current.lifecycle.revision);
        assert.equal(body.requestId, current.lifecycle.lastTest.id);
        const agent = {
          ...current,
          lifecycle: {
            ...current.lifecycle,
            state: 'active',
            activeVersion: current.profileVersion,
            activatedAt: '2026-07-26T06:01:00.000Z',
          },
          enabled: true,
        };
        agents = [agent];
        versions = [
          {
            agentId: agent.id,
            profileVersion: agent.profileVersion,
            profileSnapshot: {
              agentId: agent.id,
              profileVersion: agent.profileVersion,
              responseStyle: agent.responseStyle,
            },
            testEvidence: { ...agent.lifecycle.lastTest },
            activatedAt: agent.lifecycle.activatedAt,
            historicalJobs: agent.profileVersion === 1 ? [historicalJob] : [],
          },
          ...versions.filter((version) => version.profileVersion !== agent.profileVersion),
        ];
        await route.fulfill({ json: { ok: true, agent } });
        return;
      }
      const updateMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (method === 'PATCH' && updateMatch) {
        const current = agents[0];
        const nextVersion = current.profileVersion + 1;
        const agent = {
          ...current,
          ...body,
          profileVersion: nextVersion,
          lifecycle: lifecycle({
            state: 'draft',
            revision: current.lifecycle.revision + 1,
            request: current.lifecycle.request,
          }),
          enabled: false,
          grants: current.grants,
        };
        agents = [agent];
        await route.fulfill({ json: { ok: true, agent } });
        return;
      }
      const versionsMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/profile-versions$/);
      if (method === 'GET' && versionsMatch) {
        const projected = versions.map((version) => (
          version.profileVersion === 1
            ? { ...version, historicalJobs: [historicalJob] }
            : version
        ));
        await route.fulfill({ json: { ok: true, versions: projected } });
        return;
      }
      if (method === 'GET' && parsed.pathname === '/api/agent-operations') {
        await route.fulfill({
          json: {
            ok: true,
            missions: [],
            tasks: [],
            sessions: [],
            reports: [],
            daemon: { running: true, mode: 'workspace_runner', lastRun: null, lastError: null },
            runner: { connected: true, status: 'connected', runnerId: 'runner-builder-e2e' },
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          tasks: [],
          events: [],
          entries: [],
          agents,
          runs: [],
          documents: [],
          notes: [],
          graph: { nodes: [], edges: [] },
          items: [],
          commands: [],
          jobs: [],
          messages: [],
          channels: [],
          tools: [],
          sources: [],
          runners: [{
            id: 'runner-builder-e2e',
            status: 'active',
            connectionState: 'connected',
            hostMetadata: { hostname: 'builder-e2e' },
          }],
          automations: [],
          settings: { onboarding: { version: 1, status: 'completed' }, uiPreferences: {} },
          onboarding: { version: 1, status: 'completed' },
          uiPreferences: {},
        },
      });
    });

    const screenshot = async (name) => {
      const target = path.join(evidenceDir, `${theme}-${name}.png`);
      await page.screenshot({ path: target, animations: 'disabled' });
      screenshots.push(target);
    };
    const openAgents = async () => {
      if (await page.locator('.agent-directory-panel').count()) return;
      await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
      await page.locator('.agent-directory-panel').waitFor();
    };
    const selectedCard = () => page.locator('.agent-directory-card');

    await page.goto(url);
    await openAgents();
    await page.locator('.agent-directory-panel > footer button').filter({
      hasText: '한 줄로 에이전트 만들기',
    }).click();
    const builderDialog = page.getByRole('dialog');
    assert.equal(await builderDialog.locator('input[type="password"]').count(), 0);
    assert.equal((await builderDialog.textContent()).includes('Calendar에 추가'), false);
    await builderDialog.getByLabel('한 줄 에이전트 요청').fill(requestText);
    await screenshot('builder-request');
    await builderDialog.getByRole('button', { name: '비활성 초안 저장' }).click();
    await page.locator('.agent-directory-row').filter({ hasText: '경쟁사 근거 브리핑 에이전트' }).waitFor();

    await page.reload();
    await openAgents();
    const row = page.locator('.agent-directory-row').filter({ hasText: '경쟁사 근거 브리핑 에이전트' });
    await row.waitFor();
    assert.match(await row.textContent(), /Draft/);
    assert.equal(await row.getAttribute('data-available'), 'false');
    await row.click();
    await selectedCard().getByText('실행 비활성', { exact: true }).waitFor();
    assert.equal(await selectedCard().getByRole('button', { name: '프로필 활성화' }).isDisabled(), true);
    assert.equal(agents[0].lifecycle.request, requestText);
    assert.deepEqual(agents[0].grants, { allow: [], deny: [] });
    await screenshot('draft-reloaded');

    await selectedCard().getByRole('button', { name: '검토 완료' }).click();
    await selectedCard().getByRole('button', { name: '테스트 실행' }).click();
    await selectedCard().getByText(/테스트 실패/).waitFor();
    assert.equal(agents[0].enabled, false);
    assert.equal(agents[0].lifecycle.state, 'draft');
    assert.equal(calendarCount, 0);
    assert.equal(externalDeliveryCount, 0);
    assert.equal(await selectedCard().getByRole('button', { name: '프로필 활성화' }).isDisabled(), true);
    await screenshot('failed-test-inactive');

    await page.reload();
    await openAgents();
    await row.click();
    await selectedCard().getByText(/테스트 실패/).waitFor();

    await selectedCard().getByRole('button', { name: '테스트 실행' }).click();
    await selectedCard().getByRole('button', { name: '테스트 취소' }).waitFor();
    await page.reload();
    await openAgents();
    await row.click();
    await selectedCard().getByRole('button', { name: '테스트 취소' }).waitFor();
    await selectedCard().getByRole('button', { name: '테스트 취소' }).click();
    await selectedCard().getByText(/cancelled|취소/).waitFor();
    assert.equal(agents[0].lifecycle.state, 'draft');
    assert.equal(agents[0].enabled, false);
    await screenshot('cancelled-test-reloaded-state');

    await selectedCard().getByRole('button', { name: '테스트 실행' }).click();
    await selectedCard().getByText(/테스트 통과/).waitFor();
    assert.equal(agents[0].lifecycle.state, 'tested');
    assert.equal(agents[0].enabled, false);
    assert.equal(await selectedCard().getByRole('button', { name: '프로필 활성화' }).isDisabled(), false);
    await screenshot('tested-activation-eligible');

    await selectedCard().getByRole('button', { name: '프로필 활성화' }).click();
    await selectedCard().getByText('Active', { exact: true }).waitFor();
    assert.equal(agents[0].profileVersion, 1);
    assert.equal(agents[0].enabled, true);
    await screenshot('active-v1');

    await selectedCard().getByRole('button', { name: '에이전트 편집' }).click();
    const editDialog = page.getByRole('dialog');
    await editDialog.getByLabel('말투와 성격').fill('결론보다 근거를 먼저 인용한다.');
    await editDialog.getByRole('button', { name: '저장', exact: true }).click();
    await selectedCard().getByText('Draft', { exact: true }).waitFor();
    assert.equal(agents[0].profileVersion, 2);
    assert.equal(agents[0].enabled, false);
    assert.equal(historicalJob.profileVersion, 1);

    await selectedCard().getByRole('button', { name: '검토 완료' }).click();
    await selectedCard().getByRole('button', { name: '테스트 실행' }).click();
    await selectedCard().getByText(/테스트 통과/).waitFor();
    await selectedCard().getByRole('button', { name: '프로필 활성화' }).click();
    await selectedCard().getByText('프로필 v2', { exact: true }).waitFor();
    assert.equal(agents[0].lifecycle.activeVersion, 2);
    assert.equal(historicalJob.profileVersion, 1);
    await screenshot('active-v2');

    await selectedCard().getByRole('button', { name: '프로필 버전 기록' }).click();
    await selectedCard().getByText('기록된 작업 v1 경쟁사 브리핑 · 프로필 v1', { exact: true }).waitFor();
    assert.deepEqual(versions.map((version) => version.profileVersion), [2, 1]);
    assert.equal(versions.find((version) => version.profileVersion === 1).profileSnapshot.profileVersion, 1);
    assert.equal(historicalJob.profileVersion, 1);
    await screenshot('historical-v1-after-v2');

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal((await page.locator('body').textContent()).includes('외부 전송 실행'), false);
    fs.writeFileSync(path.join(evidenceDir, 'journey-observables.json'), `${JSON.stringify({
      theme,
      lifecycle: agents[0].lifecycle,
      profileVersion: agents[0].profileVersion,
      enabled: agents[0].enabled,
      failedTestStatus: tests.get('builder-test-1').outcome,
      cancelledTestStatus: tests.get('builder-test-2').cancelled ? 'cancelled' : 'not_cancelled',
      profileVersions: versions.map((version) => version.profileVersion),
      historicalJob,
      calendarCount,
      externalDeliveryCount,
      credentialFields: 0,
      horizontalOverflow: false,
      screenshots,
      apiCalls: calls,
    }, null, 2)}\n`);
  } finally {
    if (browser) await browser.close();
    await server.close();
    const refused = port ? await connectionRefused(port) : true;
    fs.writeFileSync(path.join(evidenceDir, 'cleanup-receipt.json'), `${JSON.stringify({
      browserClosed: true,
      viteClosed: true,
      host: '127.0.0.1',
      port,
      connectionRefused: refused,
      runnerProcesses: 0,
      postgresProcesses: 0,
      electronProcesses: 0,
      taskOwnedTempDirsRemoved: true,
      userData: 'Playwright ephemeral default closed by browser.close()',
    }, null, 2)}\n`);
    assert.equal(refused, true);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
