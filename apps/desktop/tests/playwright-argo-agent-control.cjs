const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = process.env.EVIDENCE_DIR
  || path.resolve('apps/desktop/test-results/argo-agent-control');

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function publicAgent(input, id) {
  const sourceKind = input.sourceKind === 'connected' ? 'connected' : 'native';
  return {
    id,
    displayName: input.displayName,
    name: input.displayName,
    role: input.role || '',
    responsibility: input.responsibility || '',
    instructions: input.instructions || '',
    specialties: input.specialties || [],
    sourceKind,
    provider: sourceKind === 'connected' ? input.provider : 'agent-calendar',
    externalAgentId: sourceKind === 'connected' ? input.externalAgentId : '',
    connectionStatus: sourceKind === 'connected' ? 'linked' : 'ready',
    defaultExecutionEngine: input.defaultExecutionEngine || 'auto',
    enabled: true,
  };
}

async function main() {
  const { server, url } = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const theme = process.env.AGENT_CALENDAR_E2E_THEME === 'dark' ? 'dark' : 'default';
  const calls = [];
  let agents = [
    publicAgent({
      displayName: '리서치 파트너',
      role: '시장 리서처',
      responsibility: '시장 변화를 조사한다.',
      specialties: ['시장 조사', '출처 검증'],
      sourceKind: 'native',
      defaultExecutionEngine: 'auto',
    }, 'agent-native-qa'),
    publicAgent({
      displayName: 'Hermes 분석가',
      role: '데이터 분석가',
      responsibility: 'Runner에서 분석한다.',
      specialties: ['데이터 분석'],
      sourceKind: 'connected',
      provider: 'hermes',
      externalAgentId: 'analyst',
      defaultExecutionEngine: 'claude',
    }, 'agent-hermes-qa'),
  ];
  let createdMission = null;

  await page.addInitScript((selectedTheme) => {
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        hasSession: true,
        theme: selectedTheme,
        authProfile: {
          provider: 'authkit',
          id: 'argo-agent-control-qa',
          email: 'qa@example.test',
          name: 'Agent Control QA',
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
        session: {
          signedIn: true,
          workspaceId: 'workspace-agent-control-qa',
          userId: 'argo-agent-control-qa',
          role: 'owner',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getSessionStatus: async () => ({
        signedIn: true,
        sessionId: 'session-agent-control-qa',
        userId: 'argo-agent-control-qa',
        workspaceId: 'workspace-agent-control-qa',
        role: 'owner',
        email: 'qa@example.test',
        displayName: 'Agent Control QA',
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
    const body = request.postDataJSON?.() || {};
    calls.push({ method, path: parsed.pathname, body });

    if (method === 'GET' && parsed.pathname === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents } });
      return;
    }
    if (method === 'POST' && parsed.pathname === '/api/agents') {
      const id = body.sourceKind === 'connected' ? 'agent-connected-new' : 'agent-native-new';
      const agent = publicAgent(body, id);
      agents = [agent, ...agents.filter((item) => item.id !== id)];
      await route.fulfill({ json: { ok: true, agent, agents } });
      return;
    }
    const agentPatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (method === 'PATCH' && agentPatch) {
      const id = decodeURIComponent(agentPatch[1]);
      const current = agents.find((agent) => agent.id === id);
      const agent = publicAgent({ ...current, ...body }, id);
      agents = agents.map((item) => item.id === id ? agent : item);
      await route.fulfill({ json: { ok: true, agent } });
      return;
    }
    if (method === 'GET' && parsed.pathname === '/api/agent-operations') {
      await route.fulfill({
        json: {
          ok: true,
          missions: createdMission ? [createdMission] : [],
          tasks: [],
          sessions: [],
          reports: [],
          daemon: { running: true, mode: 'workspace_runner', lastRun: null, lastError: null },
          runner: { connected: true, status: 'connected', runnerId: 'runner-qa' },
        },
      });
      return;
    }
    if (method === 'POST' && parsed.pathname === '/api/agent-operations/work') {
      createdMission = {
        id: 'mission-connected-agent-qa',
        templateId: 'general-agent-work',
        title: body.title,
        objective: body.objective,
        agentId: body.agentId,
        executionEngine: body.executionEngine,
        deliverable: body.deliverable,
        status: 'active',
        timezone: 'Asia/Seoul',
        sources: [],
        reportSchedule: { weekday: 0, hour: 0, minute: 0 },
        policy: { maxRunsPerWeek: 0, maxRuntimeMinutesPerWeek: 0, forbiddenActions: [] },
        budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: '' },
        missionThreadId: 'conversation-connected-agent-qa',
        planSummary: '',
        plannedAt: '',
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      };
      const work = {
        ...createdMission,
        assignmentReason: `explicit:${body.agentId}`,
        workConversationId: createdMission.missionThreadId,
        revisionCounter: 0,
      };
      const conversation = {
        id: createdMission.missionThreadId,
        missionId: createdMission.id,
        type: 'mission-thread',
        title: createdMission.title,
        status: 'planning',
        pendingInstructions: [],
        executionEngine: body.executionEngine,
        deliverable: body.deliverable,
        createdAt: createdMission.createdAt,
        updatedAt: createdMission.updatedAt,
      };
      const message = {
        id: 'message-connected-agent-qa',
        sessionId: conversation.id,
        sequence: 1,
        kind: 'user_message',
        text: body.initialMessage,
        metadata: { deliveryStatus: 'accepted', applicationMode: 'mission_context' },
        createdAt: createdMission.createdAt,
      };
      await route.fulfill({ status: 201, json: { ok: true, work, conversation, message, idempotentReplay: false } });
      return;
    }
    const conversationMatch = parsed.pathname.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
    if (method === 'GET' && conversationMatch && createdMission) {
      await route.fulfill({
        json: {
          ok: true,
          work: {
            ...createdMission,
            assignmentReason: `explicit:${createdMission.agentId}`,
            workConversationId: createdMission.missionThreadId,
            revisionCounter: 0,
          },
          conversation: {
            id: createdMission.missionThreadId,
            missionId: createdMission.id,
            type: 'mission-thread',
            title: createdMission.title,
            status: 'planning',
            pendingInstructions: [],
            executionEngine: createdMission.executionEngine,
            deliverable: createdMission.deliverable,
            createdAt: createdMission.createdAt,
            updatedAt: createdMission.updatedAt,
          },
          checkpoints: [{
            id: 'message-connected-agent-qa',
            sessionId: createdMission.missionThreadId,
            sequence: 1,
            kind: 'user_message',
            text: createdMission.objective,
            metadata: { deliveryStatus: 'accepted', applicationMode: 'mission_context' },
            createdAt: createdMission.createdAt,
          }],
          nextCursor: null,
        },
      });
      return;
    }
    if (method === 'POST' && /\/api\/agent-operations\/work\/[^/]+\/live$/.test(parsed.pathname)) {
      const stream = [
        `event: accepted\ndata: ${JSON.stringify({ delivery: { status: 'accepted', applicationMode: 'mission_context' } })}\n`,
        `event: done\ndata: ${JSON.stringify({ idempotentReplay: false })}\n`,
      ].join('\n');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: stream });
      return;
    }
    if (method === 'GET' && parsed.pathname === '/api/settings') {
      await route.fulfill({ json: { ok: true, onboarding: { version: 1, status: 'completed' }, uiPreferences: {} } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        entries: [],
        agents: [],
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
        runners: [],
        automations: [],
        settings: { onboarding: { version: 1, status: 'completed' }, uiPreferences: {} },
        onboarding: { version: 1, status: 'completed' },
        uiPreferences: {},
      },
    });
  });

  try {
    await page.goto(url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.locator('.agent-directory-panel').waitFor();
    assert.equal(await page.getByText('내 에이전트', { exact: true }).count(), 1);
    assert.equal(await page.getByText('연결된 에이전트', { exact: true }).count(), 1);
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, `${theme}-control-home.png`), animations: 'disabled' });

    await page.locator('.agent-directory-panel > footer button').filter({ hasText: '에이전트 만들기' }).click();
    const nativeDialog = page.getByRole('dialog');
    await nativeDialog.getByLabel('이름').fill('문서 편집자');
    await nativeDialog.getByLabel('역할').fill('시니어 에디터');
    await nativeDialog.getByLabel('책임').fill('결과 문서를 읽기 쉽게 다듬는다.');
    await nativeDialog.getByLabel('작업 지침').fill('근거를 바꾸지 않는다.');
    await nativeDialog.getByLabel('전문 분야').fill('편집, 사실 확인');
    await page.screenshot({ path: path.join(evidenceDir, `${theme}-create-agent.png`), animations: 'disabled' });
    await nativeDialog.getByRole('button', { name: '만들기', exact: true }).click();
    await page.locator('.agent-directory-row').filter({ hasText: '문서 편집자' }).waitFor();
    const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/agents' && call.body.sourceKind === 'native');
    assert.ok(createCall);
    assert.equal(createCall.body.provider, 'agent-calendar');
    assert.deepEqual(createCall.body.specialties, ['편집', '사실 확인']);

    await page.locator('.agent-directory-panel > footer button').filter({ hasText: '외부 에이전트 연결' }).click();
    const connectDialog = page.getByRole('dialog');
    await connectDialog.getByLabel('이름').fill('Hermes 경쟁 분석가');
    await connectDialog.getByLabel('역할').fill('경쟁 분석가');
    await connectDialog.getByLabel('제공자').selectOption('hermes');
    await connectDialog.getByLabel('외부 에이전트 ID').fill('competitor-researcher');
    await connectDialog.getByLabel('책임').fill('경쟁사 변화를 지속적으로 추적한다.');
    await page.screenshot({ path: path.join(evidenceDir, `${theme}-connect-agent.png`), animations: 'disabled' });
    await connectDialog.getByRole('button', { name: '연결', exact: true }).click();
    await page.locator('.agent-directory-row').filter({ hasText: 'Hermes 경쟁 분석가' }).waitFor();
    const connectCall = calls.find((call) => call.method === 'POST' && call.path === '/api/agents' && call.body.sourceKind === 'connected');
    assert.ok(connectCall);
    assert.equal(connectCall.body.provider, 'hermes');
    assert.equal(connectCall.body.externalAgentId, 'competitor-researcher');
    assert.equal(JSON.stringify(connectCall.body).includes('secret'), false);

    await page.locator('.agent-directory-row').filter({ hasText: '문서 편집자' }).click();
    await page.getByRole('button', { name: '에이전트 편집' }).click();
    const editDialog = page.getByRole('dialog');
    await editDialog.getByLabel('책임').fill('결과 문서의 구조와 문장을 최종 검토한다.');
    await editDialog.getByRole('button', { name: '저장', exact: true }).click();
    const updateCall = calls.find((call) => call.method === 'PATCH' && call.path === '/api/agents/agent-native-new');
    assert.ok(updateCall);
    assert.equal(updateCall.body.responsibility, '결과 문서의 구조와 문장을 최종 검토한다.');

    await page.locator('.agent-directory-row').filter({ hasText: 'Hermes 경쟁 분석가' }).click();
    await page.getByLabel('에이전트에게 작업 지시').fill('경쟁사 3곳을 조사해서 비교표로 정리해줘');
    await page.getByRole('button', { name: '위임', exact: true }).click();
    const workCall = calls.find((call) => call.method === 'POST' && call.path === '/api/agent-operations/work');
    assert.ok(workCall);
    assert.equal(workCall.body.agentId, 'agent-connected-new');
    await page.locator('.agent-work-conversation').waitFor();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(evidenceDir, `${theme}-work-conversation.png`), animations: 'disabled' });
    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(desktopOverflow, false);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: path.join(evidenceDir, `${theme}-mobile-work-conversation.png`), animations: 'disabled' });
    assert.equal(await page.locator('.agent-directory-panel:visible').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
