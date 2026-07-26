const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fixtureTheme = process.env.AGENT_CALENDAR_E2E_THEME === 'dark' ? 'dark' : 'default';
  await page.addInitScript((theme) => {
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        hasSession: true,
        theme,
        authProfile: {
          provider: 'authkit',
          id: 'engine-selection-qa',
          email: 'engine-selection@example.test',
          name: 'Engine Selection QA',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        session: {
          signedIn: true,
          workspaceId: 'workspace-engine-selection-qa',
          userId: 'engine-selection-qa',
          role: 'owner',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getSessionStatus: async () => ({
        signedIn: true,
        sessionId: 'session-engine-selection-qa',
        userId: 'engine-selection-qa',
        workspaceId: 'workspace-engine-selection-qa',
        role: 'owner',
        email: 'engine-selection@example.test',
        displayName: 'Engine Selection QA',
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
  }, fixtureTheme);
  let createdBody = null;
  const liveBodies = [];
  let failNextOperationRefresh = false;
  let operationState = {
    ok: true,
    missions: [],
    tasks: [],
    sessions: [],
    reports: [],
    daemon: { running: true, lastRun: null, lastError: null },
  };
  const createdMissions = new Map();

  function workPayload(mission) {
    return {
      id: mission.id,
      templateId: mission.templateId,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      agentId: mission.agentId,
      assignmentReason: `explicit:${mission.agentId}`,
      executionEngine: mission.executionEngine,
      activeExecutionEngine: mission.activeExecutionEngine || mission.executionEngine,
      activeExecutionModel: mission.activeExecutionModel || mission.requestedModel || '',
      resolvedExecutionModel: mission.resolvedExecutionModel || '',
      deliverable: mission.deliverable,
      missionThreadId: mission.missionThreadId,
      workConversationId: mission.missionThreadId,
      revisionCounter: 0,
      pendingRevisionId: '',
      currentResultReportId: '',
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    };
  }

  function conversationPayload(mission) {
    const work = workPayload(mission);
    const conversation = { id: mission.missionThreadId, missionId: mission.id, taskId: '', type: 'mission-thread', title: mission.title, status: 'draft', pendingInstructions: [], executionEngine: mission.executionEngine, deliverable: mission.deliverable, createdAt: mission.createdAt, updatedAt: mission.updatedAt };
    return {
      ok: true,
      work,
      conversation,
      channels: mission.channels || [],
      checkpoints: mission.checkpoints || [
        { id: `initial-${mission.id}`, sessionId: mission.missionThreadId, sequence: 1, kind: 'user_message', text: mission.objective, metadata: {}, createdAt: mission.createdAt },
        { id: `answer-${mission.id}`, sessionId: mission.missionThreadId, sequence: 2, kind: 'agent_message', text: '요청을 확인했습니다. 같은 작업 대화에서 조사와 문서 정리를 이어가겠습니다.', metadata: { executionEngine: mission.executionEngine }, createdAt: '2026-07-13T00:00:30.000Z' },
      ],
      nextCursor: null,
    };
  }

  await page.route('**/*', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && path === '/api/agent-operations') {
      if (failNextOperationRefresh) {
        failNextOperationRefresh = false;
        await route.fulfill({ status: 503, json: { error: 'refresh unavailable' } });
        return;
      }
      await route.fulfill({ json: operationState });
      return;
    }
    if (request.method() === 'GET' && path === '/api/agents') {
      await route.fulfill({
        json: {
          ok: true,
          agents: [{
            id: 'bizconsultant',
            displayName: 'Business Consultant',
            status: 'ready',
            model: 'Recommended',
            role: '시장 조사',
            provider: 'Mac mini Hermes',
            trustLevel: '개인 승인',
            allowedTaskClasses: ['research', 'analysis', 'report'],
          }],
        },
      });
      return;
    }
    if (request.method() === 'GET' && path === '/api/runners') {
      await route.fulfill({
        json: {
          ok: true,
          runners: [{
            id: 'runner-engine-selection-qa',
            workspaceId: 'workspace-engine-selection-qa',
            status: 'active',
            connectionState: 'connected',
            hostMetadata: { hostName: 'QA Runner' },
            capabilities: {
              engines: {
                codex: {
                  available: true,
                  status: 'available',
                  authStatus: 'authenticated',
                  models: ['gpt-5.6-sol'],
                  defaultModel: 'gpt-5.6-sol',
                  modelSelection: 'identifier',
                },
                claude: {
                  available: true,
                  status: 'available',
                  authStatus: 'authenticated',
                  models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
                  defaultModel: 'claude-sonnet-4-6',
                  modelSelection: 'catalog',
                },
              },
            },
          }],
        },
      });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/work') {
      createdBody = request.postDataJSON();
      const mission = {
        id: createdBody.title === '새로고침 실패 작업' ? 'mission-refresh-failure' : 'mission-document',
        templateId: createdBody.templateId,
        title: createdBody.title,
        objective: createdBody.objective,
        agentId: createdBody.agentId,
        executionEngine: createdBody.executionEngine,
        requestedModel: createdBody.requestedModel,
        activeExecutionModel: createdBody.requestedModel,
        resolvedExecutionModel: createdBody.requestedModel,
        deliverable: createdBody.deliverable,
        status: 'draft',
        timezone: 'Asia/Seoul',
        sources: ['wiki', 'web'],
        successCriteria: ['요청한 산출물이 완성됨'],
        reportSchedule: { weekday: 5, hour: 16, minute: 0 },
        policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
        budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: '2026-07-13T00:00:00.000Z' },
        missionThreadId: createdBody.title === '새로고침 실패 작업' ? 'thread-refresh-failure' : 'thread-document',
        planSummary: '',
        plannedAt: '',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      };
      createdMissions.set(mission.id, mission);
      if (createdBody.title === '새로고침 실패 작업') failNextOperationRefresh = true;
      else operationState = { ...operationState, missions: [mission] };
      const payload = conversationPayload(mission);
      await route.fulfill({ status: 201, json: { ...payload, message: payload.checkpoints[0], idempotentReplay: false } });
      return;
    }
    const conversationMatch = path.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
    if (request.method() === 'GET' && conversationMatch) {
      const mission = createdMissions.get(decodeURIComponent(conversationMatch[1]));
      if (!mission) throw new Error('missing test mission');
      await route.fulfill({ json: conversationPayload(mission) });
      return;
    }
    const liveMatch = path.match(/^\/api\/agent-operations\/work\/([^/]+)\/live$/);
    if (request.method() === 'POST' && liveMatch) {
      const mission = createdMissions.get(decodeURIComponent(liveMatch[1]));
      if (!mission) throw new Error('missing live test mission');
      const body = request.postDataJSON();
      if (mission.id === 'mission-refresh-failure' && body.initial === true) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      liveBodies.push(body);
      if (body.initial !== true) {
        mission.activeExecutionEngine = body.executionEngine;
        mission.activeExecutionModel = body.requestedModel || '';
        mission.resolvedExecutionModel = body.requestedModel || '';
        mission.checkpoints = [
          ...(mission.checkpoints || [
            { id: `initial-${mission.id}`, sessionId: mission.missionThreadId, sequence: 1, kind: 'user_message', text: mission.objective, metadata: {}, createdAt: mission.createdAt },
            { id: `answer-${mission.id}`, sessionId: mission.missionThreadId, sequence: 2, kind: 'agent_message', text: '요청을 확인했습니다. 같은 작업 대화에서 조사와 문서 정리를 이어가겠습니다.', metadata: { executionEngine: mission.executionEngine }, createdAt: '2026-07-13T00:00:30.000Z' },
          ]),
          {
            id: `message-${liveBodies.length}`,
            sessionId: mission.missionThreadId,
            sequence: liveBodies.length + 1,
            kind: 'user_message',
            text: body.text,
            metadata: { executionEngine: body.executionEngine },
            createdAt: '2026-07-13T00:01:00.000Z',
          },
        ];
      }
      const acceptedAt = '2026-07-13T00:01:00.000Z';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          `event: accepted\ndata: ${JSON.stringify({ delivery: { status: 'accepted', applicationMode: 'mission_context', acceptedAt }, idempotentReplay: false })}\n\n`,
          'event: done\ndata: {"idempotentReplay":false}\n\n',
        ].join(''),
      });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
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
        settings: { uiPreferences: {} },
        uiPreferences: {},
      },
    });
  });

  await page.goto(target);
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.waitForSelector('.agent-control-room');
  const prompt = page.getByLabel('에이전트에게 작업 지시');
  await prompt.fill('경쟁사 세 곳의 가격 정책을 조사하고 Word 문서로 정리한다.');
  await page.getByText('고급 설정', { exact: true }).click();
  await page.getByLabel('담당 에이전트', { exact: true }).selectOption('bizconsultant');
  await page.getByLabel('실행 엔진', { exact: true }).selectOption('codex');
  await page.getByLabel('실행 모델', { exact: true }).selectOption('gpt-5.6-sol');
  await prompt.press('Enter');

  await page.locator('.agent-work-conversation').waitFor();
  assert.equal(typeof createdBody.clientRequestId, 'string');
  assert.deepEqual({ ...createdBody, clientRequestId: '<generated>' }, {
    clientRequestId: '<generated>',
    templateId: 'general-agent-work',
    title: '경쟁사 세 곳의 가격 정책을 조사하고 Word 문서로 정리한다.',
    objective: '경쟁사 세 곳의 가격 정책을 조사하고 Word 문서로 정리한다.',
    initialMessage: '경쟁사 세 곳의 가격 정책을 조사하고 Word 문서로 정리한다.',
    agentId: 'bizconsultant',
    executionEngine: 'codex',
    requestedModel: 'gpt-5.6-sol',
    deliverable: { kind: 'file', format: 'auto' },
  });
  assert.equal(await page.locator('.agent-work-details').count(), 0);
  assert.equal(await page.locator('.agent-directory-panel[data-mode="sessions"]').count(), 1);
  assert.match(await page.locator('.agent-directory-panel[data-mode="sessions"]').textContent() || '', /Business Consultant/);
  assert.equal(await page.getByRole('button', { name: '계획 만들기', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '작업 중단', exact: true }).count(), 0);
  assert.equal(await page.getByText('실행 계획', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('작업 대화 메시지').isEnabled(), true);
  assert.equal(await page.locator('.agent-mission-composer').count(), 0);
  assert.equal(await page.locator('.agent-work-drawer, .agent-work-scrim').count(), 0);
  assert.match(await page.locator('.agent-work-session-engine').textContent() || '', /Codex · gpt-5\.6-sol/);
  assert.equal(await page.getByLabel('이 메시지의 실행 모델').inputValue(), 'gpt-5.6-sol');
  const telegramPanel = page.getByTestId('agent-work-telegram');
  await telegramPanel.locator('summary').click();
  assert.match(await telegramPanel.textContent() || '', /이 Work Conversation의 지시와 결과를 Telegram에서도 같은 순서로 봅니다/);
  assert.match(await telegramPanel.textContent() || '', /Bot token과 chat id는 Runner에만 저장됩니다/);
  assert.match(await telegramPanel.textContent() || '', /기존 Hermes poller/);
  assert.match(await telegramPanel.locator('.agent-work-telegram-command code').textContent() || '', /telegram-bind.*--work-conversation-id 'thread-document'/);
  assert.doesNotMatch(await telegramPanel.locator('.agent-work-telegram-command code').textContent() || '', /bot\d+:[A-Za-z0-9_-]+/);
  const telegramPresentation = await telegramPanel.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderTopStyle: style.borderTopStyle,
      borderTopColor: style.borderTopColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
    };
  });
  assert.equal(telegramPresentation.borderTopStyle, 'solid');
  assert.equal(telegramPresentation.borderRadius, '0px');
  assert.equal(telegramPresentation.boxShadow, 'none');

  const createdMission = createdMissions.get('mission-document');
  createdMission.channels = [{
    id: 'channel_telegram_qa',
    channel: 'telegram',
    status: 'active',
    runnerId: 'runner-engine-selection-qa',
    ingressOwnership: 'unverified',
    lastActivityAt: '2026-07-26T00:20:00.000Z',
  }];
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="agent-work-telegram"] summary')?.textContent?.includes('Runner에 등록됨')
  ), null, { timeout: 5_000 });
  assert.match(await telegramPanel.textContent() || '', /QA Runner/);
  assert.match(await telegramPanel.textContent() || '', /수신 소유권 미확인/);
  const telegramEvidencePath = String(process.env.AGENT_CALENDAR_TELEGRAM_UI_EVIDENCE || '').trim();
  if (telegramEvidencePath) {
    fs.mkdirSync(path.dirname(telegramEvidencePath), { recursive: true });
    await page.screenshot({ path: telegramEvidencePath, fullPage: true, animations: 'disabled' });
  }
  const workTitle = await page.locator('.agent-work-header h1').textContent();
  await page.getByLabel('이 메시지의 실행 엔진').selectOption('claude');
  await page.getByLabel('이 메시지의 실행 모델').selectOption('claude-sonnet-4-6');
  await page.getByLabel('작업 대화 메시지').fill('같은 대화를 Claude에서 이어서 검토해줘');
  await page.getByLabel('작업 대화 메시지').press('Enter');
  await page.getByText('같은 대화를 Claude에서 이어서 검토해줘', { exact: true }).waitFor();
  const claudeTurn = liveBodies.find((body) => body.initial !== true && body.text === '같은 대화를 Claude에서 이어서 검토해줘');
  assert.equal(claudeTurn.executionEngine, 'claude');
  assert.equal(claudeTurn.requestedModel, 'claude-sonnet-4-6');
  assert.equal(await page.locator('.agent-work-header h1').textContent(), workTitle);
  assert.equal(await page.locator('.agent-work-conversation').count(), 1);
  assert.equal(await page.getByLabel('이 메시지의 실행 엔진').inputValue(), 'claude');
  assert.equal(await page.getByLabel('이 메시지의 실행 모델').inputValue(), 'claude-sonnet-4-6');
  await page.waitForFunction(() => (
    document.querySelector('.agent-work-session-engine')?.textContent?.includes('Claude · claude-sonnet-4-6')
  ));
  assert.match(await page.locator('.agent-work-session-engine').textContent() || '', /Claude · claude-sonnet-4-6/);
  const userBubblePresentation = await page.locator('.agent-checkpoint[data-presentation="user"]').first().evaluate((element) => {
    const style = getComputedStyle(element);
    const header = element.querySelector('header');
    return {
      borderStyle: style.borderStyle,
      borderRadius: style.borderRadius,
      headerDisplay: header ? getComputedStyle(header).display : '',
      width: element.getBoundingClientRect().width,
    };
  });
  assert.equal(userBubblePresentation.borderStyle, 'none');
  assert.equal(userBubblePresentation.borderRadius, '18px');
  assert.equal(userBubblePresentation.headerDisplay, 'none');
  assert.ok(userBubblePresentation.width < 620);
  const evidencePath = String(process.env.AGENT_CALENDAR_COMPOSER_EVIDENCE || '').trim();
  if (evidencePath) {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    await page.screenshot({ path: evidencePath, fullPage: true, animations: 'disabled' });
  }

  await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
  await page.locator('.agent-control-room-board').waitFor();
  assert.equal(await prompt.evaluate((element) => element === document.activeElement), true);
  await prompt.fill('새로고침 실패 작업');
  await prompt.press('Enter');
  await page.locator('.agent-work-conversation').waitFor();
  assert.match(await page.locator('.agent-operations-error').textContent() || '', /작업은 완료됐지만.*새로고침/);
  assert.match((await page.locator('.agent-work-header').textContent() || '').replace(/\u00a0/g, ' '), /새로고침 실패 작업/);
  assert.equal(await page.getByLabel('작업 대화 메시지').isEnabled(), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createdBody }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
