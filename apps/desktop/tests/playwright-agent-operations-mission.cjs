const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const evidenceDir = process.env.EVIDENCE_DIR || '';

async function capture(page, name) {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: true });
}

const weeklyMission = {
  id: 'mission-weekly',
  templateId: 'weekly-opportunity-brief',
  title: 'Weekly Opportunity Brief',
  objective: '현재 사업과 제품에 도움이 되는 기회를 근거와 함께 매주 찾는다.',
  successCriteria: ['근거가 있는 기회 3개', '이번 주 추천 행동 1개'],
  agentId: 'bizconsultant',
  executionEngine: 'auto',
  deliverable: { kind: 'report', format: 'markdown' },
  status: 'draft',
  timezone: 'America/New_York',
  sources: ['wiki', 'web', 'prior_reports'],
  reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: {
    maxRunsPerWeek: 6,
    maxRuntimeMinutesPerWeek: 120,
    forbiddenActions: ['external_message', 'publish', 'purchase', 'trade'],
  },
  budget: { usedRuns: 2, usedMinutes: 42, weekStartedAt: '2026-07-13T00:00:00.000Z' },
  missionThreadId: 'thread-weekly',
  planSummary: '',
  plannedAt: '',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T09:00:00.000Z',
};

const plannedTasks = [{
    id: 'task-scan',
    missionId: 'mission-weekly',
    sessionId: 'session-scan',
    title: '경쟁사 변화 수집',
    status: 'proposed',
    scheduledAt: '2026-07-13T09:00:00.000Z',
    dueAt: '2026-07-13T11:30:00.000Z',
    date: '2026-07-13',
    time: '18:00',
    agent: 'bizconsultant',
    origin: 'agent',
    reason: '가격 변화 근거가 부족하다.',
    expectedOutput: '공식 출처 비교표',
    estimatedMinutes: 40,
    actionClass: 'research',
    sourceRefs: ['wiki', 'web'],
  }, {
    id: 'task-verify',
    missionId: 'mission-weekly',
    sessionId: 'session-verify',
    title: '기회 가설 검증',
    status: 'proposed',
    scheduledAt: '2026-07-15T05:00:00.000Z',
    dueAt: '2026-07-15T06:00:00.000Z',
    date: '2026-07-15',
    time: '14:00',
    agent: 'bizconsultant',
    origin: 'agent',
    reason: '변화를 실제 사업 기회와 연결해야 한다.',
    expectedOutput: '근거가 포함된 가설 3개',
    estimatedMinutes: 40,
    actionClass: 'analysis',
    sourceRefs: ['wiki', 'web'],
  }, {
    id: 'task-report',
    missionId: 'mission-weekly',
    sessionId: 'session-report',
    title: '주간 기회 보고',
    status: 'proposed',
    scheduledAt: '2026-07-17T06:00:00.000Z',
    dueAt: '2026-07-17T07:00:00.000Z',
    date: '2026-07-17',
    time: '15:00',
    agent: 'bizconsultant',
    origin: 'agent',
    reason: '금요일 의사결정 보고 계약이다.',
    expectedOutput: '기회 3개와 추천 1개',
    estimatedMinutes: 40,
    actionClass: 'report',
    sourceRefs: ['mission'],
  }];
const apiOrderedTasks = [plannedTasks[2], plannedTasks[0], plannedTasks[1]];

let operationState = {
  ok: true,
  missions: [],
  tasks: [],
  sessions: [],
  reports: [],
  daemon: { running: true, lastRun: null, lastError: null },
};

function plannedSessions() {
  return apiOrderedTasks.map((task) => ({
    id: task.sessionId,
    missionId: task.missionId,
    taskId: task.id,
    type: 'task',
    title: task.title,
    status: task.status,
    createdAt: '2026-07-13T09:00:00.000Z',
    updatedAt: '2026-07-13T09:10:00.000Z',
  }));
}

function conversationFor(mission) {
  const checkpoints = [{ id: 'initial-weekly', sessionId: mission.missionThreadId, sequence: 1, kind: 'user_message', text: mission.objective, metadata: {}, createdAt: mission.createdAt }];
  if (mission.plannedAt) checkpoints.push({ id: 'plan-weekly', sessionId: mission.missionThreadId, sequence: 2, kind: 'plan', text: mission.planSummary || '세 단계 실행 계획을 만들었습니다.', metadata: {}, createdAt: mission.plannedAt });
  return {
    ok: true,
    work: {
      id: mission.id, templateId: mission.templateId, title: mission.title, objective: mission.objective,
      status: mission.status, agentId: mission.agentId, assignmentReason: `explicit:${mission.agentId}`,
      executionEngine: mission.executionEngine, deliverable: mission.deliverable,
      missionThreadId: mission.missionThreadId, workConversationId: mission.missionThreadId,
      revisionCounter: 0, pendingRevisionId: '', currentResultReportId: '',
      createdAt: mission.createdAt, updatedAt: mission.updatedAt,
    },
    conversation: {
      id: mission.missionThreadId, missionId: mission.id, taskId: '', type: 'mission-thread', title: mission.title,
      status: mission.plannedAt ? 'waiting_for_approval' : 'draft', pendingInstructions: [],
      executionEngine: mission.executionEngine, deliverable: mission.deliverable,
      createdAt: mission.createdAt, updatedAt: mission.updatedAt,
    },
    checkpoints,
    nextCursor: null,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let operationRequests = 0;
  let slowUnrelatedRequests = false;
  const calls = [];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ method: request.method(), path });
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && path === '/api/agent-operations') {
      operationRequests += 1;
      await route.fulfill({ json: operationState });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/work') {
      operationState = { ...operationState, missions: [weeklyMission] };
      const payload = conversationFor(weeklyMission);
      await route.fulfill({ status: 201, json: { ok: true, work: payload.work, conversation: payload.conversation, message: payload.checkpoints[0], idempotentReplay: false } });
      return;
    }
    const conversationMatch = path.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
    if (request.method() === 'GET' && conversationMatch) {
      const mission = operationState.missions.find((item) => item.id === decodeURIComponent(conversationMatch[1]));
      if (!mission) { await route.fulfill({ status: 404, json: { ok: false, error: 'work_not_found' } }); return; }
      await route.fulfill({ json: conversationFor(mission) });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/missions/mission-weekly/plan') {
      operationState = {
        ...operationState,
        missions: [{ ...weeklyMission, planSummary: '세 단계 실행 계획을 만들었습니다.', plannedAt: '2026-07-13T09:00:00.000Z' }],
        tasks: apiOrderedTasks,
        sessions: plannedSessions(),
      };
      await route.fulfill({ json: { ok: true, mission: operationState.missions[0], tasks: apiOrderedTasks, sessions: operationState.sessions } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/tasks/task-scan/run-now') {
      operationState = {
        ...operationState,
        tasks: operationState.tasks.map((task) => task.id === 'task-scan' ? { ...task, status: 'completed' } : task),
        sessions: operationState.sessions.map((session) => session.taskId === 'task-scan' ? { ...session, status: 'completed' } : session),
      };
      await route.fulfill({
        json: {
          ok: true,
          run: { startedTaskIds: ['task-scan'], completedTaskIds: ['task-scan'], createdReportIds: [] },
          task: operationState.tasks.find((task) => task.id === 'task-scan'),
        },
      });
      return;
    }
    if (request.method() === 'POST' && path.startsWith('/api/agent-operations/tasks/')) {
      const taskId = path.split('/')[4];
      operationState = {
        ...operationState,
        tasks: operationState.tasks.map((task) => task.id === taskId ? { ...task, status: 'scheduled' } : task),
      };
      await route.fulfill({ json: { ok: true, task: operationState.tasks.find((task) => task.id === taskId) } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/missions/mission-weekly/activate') {
      operationState = {
        ...operationState,
        missions: operationState.missions.map((mission) => ({ ...mission, status: 'active' })),
        tasks: operationState.tasks.map((task) => (
          task.missionPause && task.status === 'blocked'
            ? { ...task, status: 'scheduled', missionPause: false }
            : task
        )),
      };
      await route.fulfill({ json: { ok: true, mission: operationState.missions[0] } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/missions/mission-weekly/pause') {
      operationState = { ...operationState, missions: operationState.missions.map((mission) => ({ ...mission, status: 'paused' })), tasks: operationState.tasks.map((task) => ({ ...task, status: task.status === 'scheduled' ? 'blocked' : task.status, missionPause: true })) };
      await route.fulfill({ json: { ok: true, mission: operationState.missions[0], tasks: operationState.tasks } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/missions/mission-weekly/cancel') {
      operationState = { ...operationState, missions: operationState.missions.map((mission) => ({ ...mission, status: 'cancelled' })), tasks: operationState.tasks.map((task) => task.status === 'completed' ? task : { ...task, status: 'cancelled' }) };
      await route.fulfill({ json: { ok: true, mission: operationState.missions[0], tasks: operationState.tasks } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/agents') {
      await route.fulfill({
        json: {
          ok: true,
          agents: [{
            id: 'bizconsultant',
            name: 'bizconsultant',
            displayName: 'Business Consultant',
            status: 'ready',
            model: 'Recommended',
            role: '시장 변화와 사업 기회를 검증합니다.',
            provider: 'Mac mini Hermes',
            trustLevel: '개인 승인',
            allowedTaskClasses: ['research', 'analysis', 'report'],
          }],
        },
      });
      return;
    }
    if (slowUnrelatedRequests && request.method() === 'GET' && path === '/api/wiki') {
      await new Promise((resolve) => setTimeout(resolve, 5000));
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
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.waitForSelector('.agent-control-room');

  assert.equal(operationRequests >= 1, true);
  assert.equal(await page.locator('.agent-operations-tabs').count(), 0);
  const prompt = page.getByLabel('에이전트에게 작업 지시');
  await prompt.fill('Weekly Opportunity Brief\n현재 사업과 제품에 도움이 되는 기회를 근거와 함께 매주 찾는다.');
  await page.getByText('고급 설정').click();
  await page.getByLabel('담당 에이전트').selectOption('bizconsultant');
  await prompt.press('Enter');
  await page.locator('.agent-work-header h1', { hasText: 'Weekly Opportunity Brief' }).waitFor();
  await page.getByRole('button', { name: '계획 만들기', exact: true }).click();
  await page.locator('.agent-work-task').first().waitFor();
  assert.equal(await page.locator('.agent-work-task').count(), 3);
  assert.deepEqual(await page.locator('.agent-work-task header strong').allTextContents(), [
    '경쟁사\u00a0변화\u00a0수집',
    '기회\u00a0가설\u00a0검증',
    '주간\u00a0기회\u00a0보고',
  ]);
  assert.equal(await page.getByRole('button', { name: 'Task Session 열기' }).count(), 3);
  assert.match(await page.locator('.agent-work-details').textContent() || '', /0\/3/);
  assert.match(await page.locator('.agent-work-details').textContent() || '', /가격\u00a0변화\u00a0근거가\u00a0부족하다/);
  await page.setViewportSize({ width: 768, height: 900 });
  const tabletMissionWidths = await page.locator('.agent-work-conversation, .agent-work-timeline').evaluateAll((elements) => elements.map((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })));
  assert.equal(tabletMissionWidths.every((width) => width.scrollWidth <= width.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 900 });
  slowUnrelatedRequests = true;
  const approveStartedAt = Date.now();
  await page.getByRole('button', { name: '전체 승인', exact: true }).click();
  await page.locator('.agent-work-header b', { hasText: '운영 중' }).waitFor({ timeout: 2000 });
  assert.equal(Date.now() - approveStartedAt < 2000, true);
  slowUnrelatedRequests = false;
  assert.match(await page.locator('.agent-work-header').textContent() || '', /Business Consultant/);
  assert.equal(await page.getByRole('button', { name: '전체 일시정지' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '작업 중단' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '지금 실행' }).count(), 3);
  await page.getByRole('button', { name: '지금 실행' }).first().click();
  await page.locator('.agent-work-task').first().locator('header span', { hasText: '완료' }).waitFor();
  assert.equal(calls.some((call) => call.path === '/api/agent-operations/tasks/task-scan/run-now'), true);
  await capture(page, 'mission-active-desktop');
  assert.match(await page.locator('.agent-work-header').textContent() || '', /Business Consultant/);
  const firstPauseResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/agent-operations/missions/mission-weekly/pause'
  ));
  await page.getByRole('button', { name: '전체 일시정지' }).click();
  assert.equal((await firstPauseResponse).status(), 200);
  try {
    await page.locator('.agent-work-header b', { hasText: '확인 필요' }).waitFor();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
      header: await page.locator('.agent-work-header').textContent(),
      alerts: await page.locator('.agent-operations-error').allTextContents(),
      recentCalls: calls.slice(-20),
    })}`);
  }
  const missionActions = page.locator('.agent-work-mission-actions');
  assert.equal(await missionActions.getByRole('button', { name: '재개', exact: true }).count(), 1);
  await missionActions.getByRole('button', { name: '재개', exact: true }).click();
  await page.locator('.agent-work-header b', { hasText: '운영 중' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '전체 일시정지' }).count(), 1);
  const secondPauseResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/agent-operations/missions/mission-weekly/pause'
  ));
  await page.getByRole('button', { name: '전체 일시정지' }).click();
  assert.equal((await secondPauseResponse).status(), 200);
  await page.locator('.agent-work-header b', { hasText: '확인 필요' }).waitFor();
  await page.getByRole('button', { name: '작업 중단' }).click();
  await page.locator('.agent-work-header b', { hasText: '중단됨' }).waitFor();
  assert.match(await page.locator('.agent-work-details').textContent() || '', /1\/3/);
  assert.equal(calls.filter((call) => call.path.includes('/tasks/') && call.path.endsWith('/approve')).length, 3);
  assert.equal(calls.some((call) => call.path.endsWith('/activate')), true);
  assert.equal(calls.some((call) => call.path.endsWith('/pause')), true);
  assert.equal(calls.some((call) => call.path.endsWith('/cancel')), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, operationRequests }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
