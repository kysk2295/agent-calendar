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
const task = {
  id: 'task-scan',
  missionId: 'mission-weekly',
  sessionId: 'session-scan',
  title: '경쟁사 변화 수집',
  status: 'running',
  agent: 'bizconsultant',
  origin: 'agent',
  reason: '가격 변화 근거가 부족하다.',
  expectedOutput: '공식 출처 비교표',
  scheduledAt: '2026-07-13T09:00:00.000Z',
  dueAt: '2026-07-13T11:30:00.000Z',
  date: '2026-07-13',
  time: '18:00',
  estimatedMinutes: 40,
  actionClass: 'research',
  sourceRefs: ['wiki', 'web'],
};
const mission = {
  id: 'mission-weekly',
  templateId: 'weekly-opportunity-brief',
  title: 'Weekly Opportunity Brief',
  objective: '현재 사업과 제품에 도움이 되는 기회를 근거와 함께 매주 찾는다.',
  successCriteria: ['근거가 있는 기회 3개'],
  agentId: 'bizconsultant',
  status: 'active',
  timezone: 'Asia/Seoul',
  sources: ['wiki', 'web'],
  reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: ['publish', 'trade'] },
  budget: { usedRuns: 2, usedMinutes: 42, weekStartedAt: '2026-07-13T00:00:00.000Z' },
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T09:00:00.000Z',
};
const session = {
  id: 'session-scan',
  missionId: 'mission-weekly',
  taskId: 'task-scan',
  type: 'task',
  title: '경쟁사 변화 수집',
  status: 'running',
  pendingInstructions: [],
  createdAt: '2026-07-13T09:00:00.000Z',
  updatedAt: '2026-07-13T09:10:00.000Z',
};
const relatedTasks = [
  { ...task, id: 'task-proposed', sessionId: 'session-proposed', title: '새 시장 신호 제안', status: 'proposed', time: '15:00' },
  { ...task, id: 'task-completed', sessionId: 'session-completed', title: '지난주 근거 보고', status: 'completed', time: '16:00' },
  { ...task, id: 'task-blocked', sessionId: 'session-blocked', title: '출처 접근 확인', status: 'blocked', time: '17:00', blockedReason: '승인된 출처가 응답하지 않습니다.' },
];
const relatedSessions = relatedTasks.map((relatedTask) => ({
  ...session,
  id: relatedTask.sessionId,
  taskId: relatedTask.id,
  title: relatedTask.title,
  status: relatedTask.status,
}));
const events = [
  { id: 'event-tool', sessionId: session.id, sequence: 3, kind: 'tool_activity', text: '공식 가격 페이지를 확인했습니다.', metadata: { tool: 'web' }, createdAt: '2026-07-13T09:03:00.000Z' },
  { id: 'event-plan', sessionId: session.id, sequence: 1, kind: 'plan', text: '공식 출처 세 곳을 비교합니다.', metadata: {}, createdAt: '2026-07-13T09:01:00.000Z' },
  { id: 'event-secret', sessionId: session.id, sequence: 2, kind: 'progress', text: 'token=topsecret /Users/koyunseo/private.md', metadata: {}, createdAt: '2026-07-13T09:02:00.000Z' },
  { id: 'event-artifact', sessionId: session.id, sequence: 4, kind: 'artifact', text: '가격 비교표 초안', metadata: { label: '비교표', url: 'https://example.com/evidence' }, createdAt: '2026-07-13T09:04:00.000Z' },
];
const report = {
  id: 'report-scan',
  missionId: mission.id,
  sessionId: session.id,
  taskId: task.id,
  title: '경쟁사 가격 변화 보고',
  status: 'ready',
  findings: ['경쟁사 두 곳이 팀 요금제를 인상했습니다.'],
  evidence: [{ label: '공식 가격 페이지', url: 'https://example.com/evidence' }],
  limitations: ['지역별 가격은 추가 확인이 필요합니다.'],
  followUps: [{ title: '사용자 인터뷰', reason: '가격 인상 민감도를 검증합니다.' }],
  followUpDecisions: [],
  budget: { usedRuns: 1, usedMinutes: 40 },
  deliveryStatus: 'telegram_sent',
  useful: null,
  createdAt: '2026-07-13T09:10:00.000Z',
  updatedAt: '2026-07-13T09:10:00.000Z',
};

let operationState = {
  ok: true,
  missions: [mission],
  tasks: [task, ...relatedTasks],
  sessions: [session, ...relatedSessions],
  reports: [report],
  daemon: { running: true, lastRun: '2026-07-13T09:10:00.000Z', lastError: null },
};

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const calls = [];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ method: request.method(), path });
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() === 'GET' && path === '/api/agent-operations') return route.fulfill({ json: operationState });
    if (request.method() === 'GET' && path === '/api/agent-operations/sessions/session-scan') {
      return route.fulfill({ json: { ok: true, session: { ...session, events } } });
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/sessions/session-scan/messages') {
      const body = request.postDataJSON();
      events.push({ id: 'event-user', sessionId: session.id, sequence: 5, kind: 'user_message', text: body.text, metadata: { applicationMode: 'next_checkpoint' }, createdAt: '2026-07-13T09:05:00.000Z' });
      return route.fulfill({ json: { ok: true, session, message: events.at(-1) } });
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/tasks/task-scan/pause') {
      operationState = { ...operationState, tasks: operationState.tasks.map((item) => item.id === task.id ? { ...item, pauseMode: 'next_checkpoint' } : item) };
      events.push({ id: 'event-pause', sessionId: session.id, sequence: 6, kind: 'approval_response', text: '일시정지 요청을 받았습니다.', metadata: { applicationMode: 'next_checkpoint' }, createdAt: '2026-07-13T09:06:00.000Z' });
      return route.fulfill({ json: { ok: true, task: operationState.tasks[0] } });
    }
    if (request.method() === 'POST' && path === '/api/agent-operations/reports/report-scan/follow-ups') {
      const body = request.postDataJSON();
      const updatedReport = { ...operationState.reports[0], followUpDecisions: [{ index: body.index, decision: body.decision, title: '사용자 인터뷰', reason: '가격 인상 민감도를 검증합니다.', recordedAt: '2026-07-13T09:12:00.000Z' }] };
      operationState = { ...operationState, reports: [updatedReport] };
      return route.fulfill({ json: { ok: true, report: updatedReport } });
    }
    if (request.method() === 'GET' && path === '/api/agents') {
      return route.fulfill({ json: { ok: true, agents: [{ id: 'bizconsultant', displayName: 'Business Consultant', status: 'ready', model: 'Recommended' }] } });
    }
    return route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], notes: [], graph: { nodes: [], edges: [] }, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: {} }, uiPreferences: {} } });
  });

  await page.goto(target);
  await page.locator('.event-pill.agent-task-running', { hasText: '경쟁사 변화 수집' }).waitFor();
  await page.getByRole('button', { name: '나', exact: true }).click();
  await page.locator('.event-pill', { hasText: '경쟁사 변화 수집' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '에이전트', exact: true }).click();
  assert.equal(await page.locator('.event-pill.agent-task-proposed').count(), 1);
  assert.equal(await page.locator('.event-pill.agent-task-completed').count(), 1);
  assert.equal(await page.locator('.event-pill.agent-task-blocked').count(), 1);
  assert.match(await page.locator('.event-pill.agent-task-running').getAttribute('title') || '', /미션 Weekly Opportunity Brief/);
  assert.match(await page.locator('.event-pill.agent-task-running').getAttribute('title') || '', /기대 결과 공식 출처 비교표/);
  assert.match(await page.locator('.event-pill.agent-task-blocked').getAttribute('title') || '', /차단 원인 승인된 출처가 응답하지 않습니다/);
  await capture(page, 'calendar-agents-desktop');
  await page.locator('.event-pill.agent-task-running', { hasText: '경쟁사 변화 수집' }).click();

  await page.locator('.task-session-panel').waitFor();
  assert.match(await page.locator('.task-session-panel').textContent() || '', /Weekly Opportunity Brief/);
  assert.match(await page.locator('.task-session-panel').textContent() || '', /공식 출처 비교표/);
  assert.match(await page.locator('.task-session-contract').textContent() || '', /시작.*7월 13일 18:00/);
  assert.match(await page.locator('.task-session-contract').textContent() || '', /마감.*7월 13일 20:30/);
  assert.match(await page.locator('.task-session-contract').textContent() || '', /42 \/ 120분/);
  assert.match(await page.locator('.task-session-contract').textContent() || '', /가격 비교표 초안/);
  assert.equal(await page.locator('.task-session-list > button').count(), 4);
  assert.deepEqual(await page.locator('.task-session-event-text').allTextContents(), [
    '공식 출처 세 곳을 비교합니다.',
    '[redacted] [private-path]',
    '공식 가격 페이지를 확인했습니다.',
    '가격 비교표 초안',
  ]);
  assert.doesNotMatch(await page.locator('.task-session-panel').textContent() || '', /topsecret|\/Users\/koyunseo/);

  await page.getByLabel('Task Session 메시지').fill('가격 근거를 먼저 확인해줘');
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await page.locator('.task-session-event', { hasText: '가격 근거를 먼저 확인해줘' }).waitFor();
  await page.getByRole('button', { name: '일시정지' }).click();
  await page.locator('.task-session-checkpoint', { hasText: 'next checkpoint' }).waitFor();
  await capture(page, 'task-session-desktop');
  assert.equal(calls.some((call) => call.path.endsWith('/messages') && call.method === 'POST'), true);
  assert.equal(calls.some((call) => call.path.endsWith('/pause') && call.method === 'POST'), true);

  await page.getByRole('button', { name: 'Task Session 닫기' }).click();
  await page.locator('.task-session-panel').waitFor({ state: 'detached' });
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.getByRole('tab', { name: 'Reports' }).click();
  assert.match(await page.locator('.agent-report-row').textContent() || '', /경쟁사 두 곳이 팀 요금제를 인상했습니다/);
  assert.match(await page.locator('.agent-report-row').textContent() || '', /공식 가격 페이지/);
  assert.match(await page.locator('.agent-report-row').textContent() || '', /사용자 인터뷰/);
  await page.getByRole('button', { name: '사용자 인터뷰 승인' }).click();
  await page.locator('.agent-report-followup', { hasText: '승인됨' }).waitFor();
  await page.getByRole('button', { name: '사용자 인터뷰 거절' }).click();
  await page.locator('.agent-report-followup', { hasText: '거절됨' }).waitFor();
  assert.equal(calls.some((call) => call.path.endsWith('/reports/report-scan/follow-ups') && call.method === 'POST'), true);
  await page.waitForTimeout(150);
  await capture(page, 'reports-desktop');
  await page.getByRole('button', { name: '세션 보기' }).click();
  await page.locator('.task-session-panel').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.task-session-list').waitFor();
  assert.match(await page.locator('.task-session-list').textContent() || '', /새 시장 신호 제안/);
  await capture(page, 'task-session-mobile');
  const mobileMetrics = await page.locator('.task-session-panel').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.equal(mobileMetrics.scrollWidth <= mobileMetrics.clientWidth, true);
  assert.equal(mobileMetrics.scrollHeight > mobileMetrics.clientHeight, true);
  await page.locator('.task-session-panel').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await capture(page, 'task-session-mobile-bottom');
  await page.getByRole('button', { name: 'Task Session 닫기' }).click();
  await browser.close();
  console.log(JSON.stringify({ ok: true, sessionGets: calls.filter((call) => call.path.endsWith('/sessions/session-scan')).length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
