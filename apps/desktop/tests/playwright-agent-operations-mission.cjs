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
  status: 'draft',
  timezone: 'Asia/Seoul',
  sources: ['wiki', 'web', 'prior_reports'],
  reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: {
    maxRunsPerWeek: 6,
    maxRuntimeMinutesPerWeek: 120,
    forbiddenActions: ['external_message', 'publish', 'purchase', 'trade'],
  },
  budget: { usedRuns: 2, usedMinutes: 42, weekStartedAt: '2026-07-13T00:00:00.000Z' },
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

let operationState = {
  ok: true,
  missions: [],
  tasks: [],
  sessions: [],
  reports: [],
  daemon: { running: true, lastRun: null, lastError: null },
};

function plannedSessions() {
  return plannedTasks.map((task) => ({
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
    if (request.method() === 'POST' && path === '/api/agent-operations/missions') {
      operationState = { ...operationState, missions: [weeklyMission] };
      await route.fulfill({ json: { ok: true, mission: weeklyMission } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/missions/mission-weekly/plan') {
      operationState = {
        ...operationState,
        missions: [{ ...weeklyMission, plannedAt: '2026-07-13T09:00:00.000Z' }],
        tasks: plannedTasks,
        sessions: plannedSessions(),
      };
      await route.fulfill({ json: { ok: true, mission: operationState.missions[0], tasks: plannedTasks, sessions: operationState.sessions } });
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
      operationState = { ...operationState, missions: operationState.missions.map((mission) => ({ ...mission, status: 'cancelled' })), tasks: operationState.tasks.map((task) => ({ ...task, status: 'cancelled' })) };
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
  await page.waitForSelector('.agent-operations-tabs');

  assert.equal(operationRequests >= 1, true);
  assert.deepEqual(
    await page.locator('.agent-operations-tabs button').allTextContents(),
    ['Missions', 'Agents', 'Reports'],
  );
  assert.match(await page.locator('.agent-operations-workspace').textContent() || '', /Weekly Opportunity Brief/);
  await page.getByRole('button', { name: '미션 만들기', exact: true }).click();
  await page.locator('.mission-contract h2', { hasText: 'Weekly Opportunity Brief' }).waitFor();
  assert.match(await page.locator('.agent-operations-workspace').textContent() || '', /42 \/ 120분/);
  await page.getByRole('button', { name: '계획 만들기', exact: true }).click();
  await page.locator('.agent-operation-task').first().waitFor();
  assert.equal(await page.locator('.agent-operation-task').count(), 3);
  assert.match(await page.locator('.mission-task-list').textContent() || '', /가격 변화 근거가 부족하다/);
  slowUnrelatedRequests = true;
  const approveStartedAt = Date.now();
  await page.getByRole('button', { name: '계획 승인', exact: true }).click();
  await page.locator('.mission-state', { hasText: '운영 중' }).waitFor({ timeout: 2000 });
  assert.equal(Date.now() - approveStartedAt < 2000, true);
  slowUnrelatedRequests = false;
  assert.match(await page.locator('.mission-contract').textContent() || '', /담당 에이전트.*bizconsultant/);
  assert.match(await page.locator('.mission-contract').textContent() || '', /근거가 있는 기회 3개/);
  assert.equal(await page.getByRole('button', { name: '미션 일시정지' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '미션 중단' }).count(), 1);
  await capture(page, 'mission-active-desktop');
  await page.getByRole('tab', { name: 'Agents' }).click();
  assert.match(await page.locator('.agent-roster-row').textContent() || '', /Mac mini Hermes/);
  assert.match(await page.locator('.agent-roster-row').textContent() || '', /신뢰 · 개인 승인/);
  assert.match(await page.locator('.agent-roster-row').textContent() || '', /research/);
  assert.match(await page.locator('.agent-roster-row').textContent() || '', /보고 유용성 평가 없음/);
  await page.waitForTimeout(150);
  await capture(page, 'agent-roster-desktop');
  await page.getByRole('tab', { name: 'Reports' }).click();
  assert.match(await page.locator('.agent-operations-workspace').textContent() || '', /첫 보고가 생성되면/);
  await page.getByRole('tab', { name: 'Missions' }).click();
  await page.getByRole('button', { name: '미션 일시정지' }).click();
  await page.locator('.mission-state', { hasText: '일시정지' }).waitFor();
  await page.getByRole('button', { name: '미션 중단' }).click();
  await page.locator('.mission-state', { hasText: '중단됨' }).waitFor();
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
