const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let createdBody = null;
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
    return { ok: true, work, conversation, checkpoints: [{ id: `initial-${mission.id}`, sessionId: mission.missionThreadId, sequence: 1, kind: 'user_message', text: mission.objective, metadata: {}, createdAt: mission.createdAt }], nextCursor: null };
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
    if (request.method() === 'POST' && path === '/api/agent-operations/work') {
      createdBody = request.postDataJSON();
      const mission = {
        id: createdBody.title === '새로고침 실패 작업' ? 'mission-refresh-failure' : 'mission-document',
        templateId: createdBody.templateId,
        title: createdBody.title,
        objective: createdBody.objective,
        agentId: createdBody.agentId,
        executionEngine: createdBody.executionEngine,
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
  await page.getByLabel('담당 에이전트').selectOption('bizconsultant');
  await page.getByLabel('실행 엔진').selectOption('codex');
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
    deliverable: { kind: 'file', format: 'auto' },
  });
  assert.match(await page.locator('.agent-work-details').textContent() || '', /Codex/);
  assert.equal(await page.locator('.agent-mission-composer').count(), 0);
  assert.equal(await page.locator('.agent-work-drawer, .agent-work-scrim').count(), 0);

  await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
  await page.locator('.agent-control-room-board').waitFor();
  assert.equal(await prompt.evaluate((element) => element === document.activeElement), true);
  await prompt.fill('새로고침 실패 작업');
  await prompt.press('Enter');
  await page.locator('.agent-work-conversation').waitFor();
  assert.match(await page.locator('.agent-operations-error').textContent() || '', /작업은 완료됐지만.*새로고침/);
  assert.match(await page.locator('.agent-work-header').textContent() || '', /새로고침 실패 작업/);
  assert.equal(await page.getByLabel('작업 대화 메시지').isEnabled(), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createdBody }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
