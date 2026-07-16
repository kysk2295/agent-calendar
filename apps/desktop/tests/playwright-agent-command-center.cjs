const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const auditDir = process.env.AGENT_COMMAND_CENTER_AUDIT_DIR || '';

async function capture(page, name) {
  if (!auditDir) return;
  await mkdir(auditDir, { recursive: true });
  await page.screenshot({ path: path.join(auditDir, `${name}.png`), fullPage: false });
}

async function assertConsoleButtonClearOfControls(page, label) {
  const overlaps = await page.evaluate(() => {
    const fab = document.querySelector('.chat-fab');
    if (!(fab instanceof HTMLElement)) return ['Console button missing'];
    const fabRect = fab.getBoundingClientRect();
    const intersects = (left, right) => (
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
    );
    return [...document.querySelectorAll('.agent-control-room button, .agent-control-room a, .agent-control-room input, .agent-control-room textarea, .agent-control-room select')]
      .filter((element) => element !== fab)
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && intersects(fabRect, rect);
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60) || element.tagName);
  });
  assert.deepEqual(overlaps, [], `${label}: Console button overlaps Agent Work controls`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let createdBody = null;
  let operationState = {
    ok: true,
    missions: [{
      id: 'mission-live',
      templateId: 'general-agent-work',
      title: '경쟁사 가격 모니터링',
      objective: '경쟁사 가격 변화를 확인하고 주간 보고서를 작성한다.',
      successCriteria: ['가격 변화 근거와 다음 행동'],
      agentId: 'bizconsultant',
      executionEngine: 'hermes',
      deliverable: { kind: 'report', format: 'markdown' },
      status: 'active',
      timezone: 'Asia/Seoul',
      sources: ['wiki', 'web'],
      reportSchedule: { weekday: 5, hour: 16, minute: 0 },
      policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
      budget: { usedRuns: 2, usedMinutes: 28, weekStartedAt: '2026-07-13T00:00:00.000Z' },
      missionThreadId: 'thread-live',
      planSummary: '가격 변화 수집 후 보고',
      plannedAt: '2026-07-13T00:00:00.000Z',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }],
    tasks: [{
      id: 'task-live',
      missionId: 'mission-live',
      sessionId: 'session-live',
      title: '경쟁사 가격표 조사',
      status: 'running',
      agent: 'bizconsultant',
      origin: 'agent',
      reason: '새 가격 변화를 확인한다.',
      expectedOutput: '출처가 있는 가격 비교표',
      scheduledAt: '2026-07-13T01:00:00.000Z',
      dueAt: '2026-07-13T02:00:00.000Z',
      date: '2026-07-13',
      time: '10:00',
      estimatedMinutes: 45,
      actionClass: 'research',
      sourceRefs: ['web'],
      executionEngine: 'hermes',
      deliverable: { kind: 'report', format: 'markdown' },
      blockedReason: '',
      pauseMode: '',
      attempt: 1,
      reportId: '',
    }, {
      id: 'task-proposed',
      missionId: 'mission-live',
      sessionId: '',
      title: '경쟁사 요금제 후속 분석',
      status: 'proposed',
      agent: 'bizconsultant',
      origin: 'agent',
      reason: '가격 조사 중 전환율 데이터 공백을 발견했다.',
      expectedOutput: '가격 정책 시사점 1페이지',
      scheduledAt: '2026-07-14T01:00:00.000Z',
      dueAt: '2026-07-14T02:00:00.000Z',
      date: '2026-07-14',
      time: '10:00',
      estimatedMinutes: 60,
      actionClass: 'analysis',
      sourceRefs: ['web'],
      executionEngine: 'hermes',
      deliverable: { kind: 'report', format: 'markdown' },
      blockedReason: '',
      pauseMode: '',
      attempt: 0,
      reportId: '',
    }],
    sessions: [],
    reports: [{
      id: 'report-review',
      missionId: 'mission-live',
      sessionId: 'session-live',
      taskId: 'task-live',
      title: '지난주 가격 보고',
      status: 'completed',
      findings: ['가격 변동 2건'],
      evidence: [],
      limitations: [],
      followUps: [],
      followUpDecisions: [],
      budget: { usedRuns: 1, usedMinutes: 20 },
      deliveryStatus: 'waiting_for_review',
      useful: null,
      createdAt: '2026-07-12T06:00:00.000Z',
      updatedAt: '2026-07-12T06:00:00.000Z',
    }],
    daemon: { running: true, lastRun: '2026-07-13T00:30:00.000Z', lastError: null },
  };
  const automationJobs = [{
    id: 'hermes-cron:weekly-research',
    name: '주간 기회 리서치',
    goal: '내 위키와 외부 자료를 조사해 사업 기회를 보고합니다.',
    agent: 'bizconsultant',
    scheduleDisplay: '매주 월요일 09:00',
    status: 'active',
    enabled: true,
    source: 'hermes-cli-cron',
    lastRunAt: '2026-07-13T00:00:00.000Z',
    nextRunAt: '2026-07-20T00:00:00.000Z',
  }, {
    id: 'hermes-cron:wiki-curator',
    name: '매일 위키 정리',
    goal: '새 메모를 연결하고 중복 문서를 확인합니다.',
    agent: 'wikicurator',
    scheduleDisplay: '매일 02:00',
    status: 'not_ok',
    enabled: true,
    lastRunAt: '2026-07-12T17:00:00.000Z',
    nextRunAt: '',
  }];
  const conversationFor = (mission) => ({
    ok: true,
    work: {
      id: mission.id,
      templateId: mission.templateId,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      agentId: mission.agentId,
      assignmentReason: `keyword:${mission.agentId}`,
      executionEngine: mission.executionEngine,
      deliverable: mission.deliverable,
      missionThreadId: mission.missionThreadId,
      workConversationId: mission.missionThreadId,
      revisionCounter: 0,
      pendingRevisionId: '',
      currentResultReportId: mission.id === 'mission-live' ? 'report-review' : '',
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    },
    conversation: {
      id: mission.missionThreadId,
      missionId: mission.id,
      taskId: '',
      type: 'mission-thread',
      title: mission.title,
      status: mission.plannedAt ? 'waiting_for_approval' : 'draft',
      pendingInstructions: [],
      executionEngine: mission.executionEngine,
      deliverable: mission.deliverable,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    },
    checkpoints: [{ id: `initial-${mission.id}`, sessionId: mission.missionThreadId, sequence: 1, kind: 'user_message', text: mission.objective, metadata: {}, createdAt: mission.createdAt }, ...(mission.id === 'mission-live' ? [{ id: 'result-mission-live', sessionId: 'session-live', sequence: 2, kind: 'completion', text: '지난주 가격 보고가 준비되었습니다.', metadata: { reportId: 'report-review', taskId: 'task-live' }, createdAt: '2026-07-12T06:00:00.000Z' }] : [])],
    nextCursor: null,
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && pathname === '/api/agent-operations') {
      await route.fulfill({ json: operationState });
      return;
    }
    const conversationMatch = pathname.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
    if (request.method() === 'GET' && conversationMatch) {
      const mission = operationState.missions.find((item) => item.id === decodeURIComponent(conversationMatch[1]));
      if (!mission) { await route.fulfill({ status: 404, json: { ok: false, error: 'work_not_found' } }); return; }
      await route.fulfill({ json: conversationFor(mission) });
      return;
    }
    if (request.method() === 'POST' && pathname === '/api/agent-operations/work') {
      createdBody = request.postDataJSON();
      const mission = {
        id: 'mission-created',
        templateId: createdBody.templateId,
        title: createdBody.title,
        objective: createdBody.objective,
        agentId: 'bizconsultant',
        executionEngine: createdBody.executionEngine,
        deliverable: createdBody.deliverable,
        status: 'draft',
        timezone: 'Asia/Seoul',
        sources: ['wiki', 'web'],
        successCriteria: [],
        reportSchedule: { weekday: 5, hour: 16, minute: 0 },
        policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
        budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: '2026-07-14T00:00:00.000Z' },
        missionThreadId: 'thread-created',
        planSummary: '',
        plannedAt: '',
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:00:00.000Z',
      };
      operationState = { ...operationState, missions: [mission, ...operationState.missions] };
      const payload = conversationFor(mission);
      await route.fulfill({ status: 201, json: { ok: true, work: payload.work, conversation: payload.conversation, message: payload.checkpoints[0], idempotentReplay: false } });
      return;
    }
    if (request.method() === 'GET' && pathname === '/api/scheduler/jobs') {
      await route.fulfill({ json: { ok: true, jobs: [...automationJobs, null] } });
      return;
    }
    if (request.method() === 'GET' && pathname === '/api/agents') {
      await route.fulfill({
        json: {
          ok: true,
          agents: [{
            id: 'bizconsultant',
            displayName: 'Business Consultant',
            status: 'ready',
            role: '사업 기회 조사',
            provider: 'Mac mini Hermes',
            trustLevel: '개인 승인',
            allowedTaskClasses: ['research', 'analysis', 'report'],
          }, {
            id: 'wikicurator',
            displayName: 'Wiki Curator',
            status: 'ready',
            role: '위키 정리',
            provider: 'Mac mini Hermes',
            trustLevel: '내부 쓰기',
            allowedTaskClasses: ['wiki', 'report'],
          }],
        },
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
  assert.equal(await page.locator('.chat-fab').isVisible(), true);
  await assertConsoleButtonClearOfControls(page, 'desktop');
  await page.locator('.chat-fab').click();
  await page.locator('.chat').waitFor();
  await page.locator('.chat header button[aria-label="캘린더 AI 닫기"]').click();
  await page.locator('.chat').waitFor({ state: 'detached' });

  assert.equal(await page.locator('.agent-operations-tabs').count(), 0);
  assert.equal(await page.getByRole('button', { name: '리서치', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '위키 정리', exact: true }).count(), 0);
  assert.equal(await page.getByRole('tab', { name: '보고서', exact: true }).count(), 0);
  assert.equal(await page.locator('.agent-mission-composer').count(), 0);
  assert.match(await page.locator('.agent-control-summary').textContent() || '', /완료 0 · 진행 1 · 확인 필요 1/);
  assert.equal(await page.locator('.agent-status-card').count(), 3);
  assert.match(await page.locator('.agent-scheduler-card').textContent() || '', /주간 기회 리서치/);
  assert.match(await page.locator('.agent-scheduler-card').textContent() || '', /매주 월요일 09:00/);
  assert.match(await page.locator('.agent-running-list').textContent() || '', /경쟁사 가격표 조사/);
  assert.match(await page.locator('.agent-approval-queue').textContent() || '', /경쟁사 요금제 후속 분석/);
  assert.match(await page.locator('.agent-activity-timeline').textContent() || '', /지난주 가격 보고/);
  await page.locator('.agent-running-card', { hasText: '경쟁사 가격표 조사' }).click();
  await page.waitForSelector('.agent-work-conversation');
  await page.locator('.agent-checkpoint', { hasText: '경쟁사 가격 변화를 확인하고 주간 보고서를 작성한다.' }).waitFor();
  const conversationText = (await page.locator('.agent-work-conversation').textContent() || '').replace(/\u00a0/g, ' ');
  assert.match(conversationText, /경쟁사 가격 변화를 확인하고 주간 보고서를 작성한다\./);
  assert.match(conversationText, /가격 변동 2건/);
  assert.equal(await page.locator('.agent-work-drawer, .agent-work-scrim').count(), 0);
  await capture(page, 'agent-work-conversation-desktop');
  await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
  await capture(page, 'agent-work-desktop');

  const prompt = page.getByLabel('에이전트에게 작업 지시');
  await prompt.fill('오늘 미국 시장 하락 원인을 분석하고 다음 행동을 제안해줘.');
  await prompt.press('Enter');
  await page.locator('.agent-work-header', { hasText: '오늘 미국 시장 하락 원인' }).waitFor();
  assert.equal(createdBody.objective, '오늘 미국 시장 하락 원인을 분석하고 다음 행동을 제안해줘.');
  assert.equal(Object.hasOwn(createdBody, 'agentId'), false);
  assert.equal(createdBody.executionEngine, 'auto');
  assert.deepEqual(createdBody.deliverable, { kind: 'file', format: 'auto' });
  assert.notEqual(createdBody.title, '새 에이전트 작업');
  await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();

  await page.setViewportSize({ width: 768, height: 900 });
  const tabletWidths = await page.locator('.agent-control-room').evaluateAll((elements) => elements.map((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })));
  assert.equal(tabletWidths.every((width) => width.scrollWidth <= width.clientWidth), true);
  await assertConsoleButtonClearOfControls(page, 'tablet');
  await capture(page, 'agent-work-tablet');

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileWidths = await page.locator('.agent-control-room').evaluateAll((elements) => elements.map((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })));
  assert.equal(mobileWidths.every((width) => width.scrollWidth <= width.clientWidth), true);
  const mobileRelay = await page.locator('.agent-control-live').boundingBox();
  assert.ok(mobileRelay);
  assert.equal(mobileRelay.x >= 0 && mobileRelay.x + mobileRelay.width <= 375, true);
  const mobileViewport = await page.evaluate(() => {
    const heading = document.querySelector('.screen-heading strong')?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollX: window.scrollX,
      documentWidth: document.documentElement.scrollWidth,
      heading: heading ? { left: heading.left, right: heading.right, width: heading.width } : null,
    };
  });
  assert.equal(mobileViewport.scrollX, 0);
  assert.equal(mobileViewport.documentWidth <= mobileViewport.innerWidth, true);
  assert.ok(mobileViewport.heading);
  assert.equal(mobileViewport.heading.left >= 0 && mobileViewport.heading.right <= mobileViewport.innerWidth, true);
  assert.equal(await page.getByLabel('에이전트에게 작업 지시').isVisible(), true);
  assert.equal(await page.locator('.chat-fab').isVisible(), true);
  await assertConsoleButtonClearOfControls(page, 'mobile');
  await page.locator('.chat-fab').click();
  await page.locator('.chat').waitFor();
  await page.locator('.chat header button[aria-label="캘린더 AI 닫기"]').click();
  await page.locator('.chat').waitFor({ state: 'detached' });
  await capture(page, 'agent-work-mobile');

  await browser.close();
  console.log(JSON.stringify({ ok: true, automationCount: automationJobs.length, createdBody }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
