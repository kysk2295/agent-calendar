const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = process.env.EVIDENCE_DIR || path.resolve('.omo/evidence/agent-work-operating-system/task-7-final-desktop-states');
const createdAt = '2026-07-14T09:00:00.000Z';
const mission = {
  id: 'work-failed', templateId: 'general-agent-work', title: '가격 보고서 생성', objective: '가격 보고서를 만든다.',
  successCriteria: [], agentId: 'bizconsultant', executionEngine: 'auto', deliverable: { kind: 'document', format: 'docx' },
  status: 'failed', timezone: 'Asia/Seoul', sources: ['web'], reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
  budget: { usedRuns: 2, usedMinutes: 45, weekStartedAt: createdAt }, missionThreadId: 'thread-failed',
  planSummary: '가격 자료를 정리합니다.', plannedAt: createdAt, createdAt, updatedAt: createdAt,
};
const task = {
  id: 'task-failed', missionId: mission.id, sessionId: 'session-failed', title: 'Word 보고서 변환', status: 'failed',
  agent: 'bizconsultant', origin: 'agent', reason: '문서 변환기가 응답하지 않았습니다.', expectedOutput: '가격 보고서',
  scheduledAt: createdAt, dueAt: createdAt, date: '2026-07-14', time: '18:00', estimatedMinutes: 20,
  actionClass: 'document', sourceRefs: [], executionEngine: 'auto', deliverable: mission.deliverable,
  blockedReason: '문서 변환기가 응답하지 않았습니다.', pauseMode: '', attempt: 1, reportId: '',
};
const budgetBlockedTask = {
  ...task, id: 'task-budget', title: '수정 결과 생성', status: 'blocked', failureCode: 'budget_exhausted',
  blockedReason: 'Revision execution budget is exhausted',
};
const resumableTask = {
  ...task, id: 'task-resumable', title: '출처 확인 대기', status: 'blocked', failureCode: undefined,
  blockedReason: '공식 발표를 기다리고 있습니다.',
};
const operationState = {
  ok: true, missions: [mission], tasks: [task, budgetBlockedTask, resumableTask], sessions: [], reports: [],
  daemon: { running: true, lastRun: createdAt, lastError: null },
};

function conversationPayload() {
  return {
    ok: true,
    work: {
      id: mission.id, templateId: mission.templateId, title: mission.title, objective: mission.objective, status: mission.status,
      agentId: mission.agentId, assignmentReason: 'explicit:bizconsultant', executionEngine: mission.executionEngine,
      deliverable: mission.deliverable, missionThreadId: mission.missionThreadId, workConversationId: mission.missionThreadId,
      revisionCounter: 1, pendingRevisionId: '', currentResultReportId: '', createdAt, updatedAt: createdAt,
    },
    conversation: {
      id: mission.missionThreadId, missionId: mission.id, taskId: '', type: 'mission-thread', title: mission.title,
      status: 'planning', pendingInstructions: [], executionEngine: mission.executionEngine, deliverable: mission.deliverable,
      createdAt, updatedAt: createdAt,
    },
    checkpoints: [{ id: 'event-error', sessionId: mission.missionThreadId, sequence: 1, kind: 'error', text: task.blockedReason, metadata: { taskId: task.id }, createdAt }],
    nextCursor: null,
  };
}

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve('apps/desktop'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function capture(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: true });
}

async function assertTargets(page, label) {
  const undersized = await page.locator('.agent-control-room textarea:visible, .agent-control-room input:visible').evaluateAll((elements) => elements
    .map((element) => ({ label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.tagName, height: element.getBoundingClientRect().height }))
    .filter((item) => item.height < 44));
  assert.deepEqual(undersized, [], `${label}: ${JSON.stringify(undersized)}`);
}

async function main() {
  const { server, url } = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const apiPath = new URL(request.url()).pathname;
    if (!apiPath.startsWith('/api/')) { await route.continue(); return; }
    if (request.method() === 'GET' && apiPath === '/api/agent-operations') { await route.fulfill({ json: operationState }); return; }
    if (request.method() === 'GET' && apiPath === '/api/agents') { await route.fulfill({ json: { ok: true, agents: [{ id: 'bizconsultant', displayName: 'Business Consultant', status: 'ready', model: 'Recommended', role: '분석', provider: 'Hermes', trustLevel: '승인', allowedTaskClasses: ['document'] }] } }); return; }
    if (request.method() === 'GET' && apiPath === '/api/scheduler/jobs') { await route.fulfill({ json: { ok: true, jobs: [] } }); return; }
    if (request.method() === 'GET' && apiPath === `/api/agent-operations/work/${mission.id}/conversation`) { await route.fulfill({ json: conversationPayload() }); return; }
    await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], notes: [], graph: { nodes: [], edges: [] }, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: {} }, uiPreferences: {} } });
  });

  try {
    await page.goto(url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.locator('.agent-control-room-board').waitFor();
    const failedCard = page.locator('.agent-running-card[data-status="failed"]');
    assert.equal(await failedCard.count(), 1);
    assert.match(await failedCard.textContent() || '', /Word 보고서 변환/);
    assert.match(await failedCard.textContent() || '', /실패/);
    assert.match(await failedCard.textContent() || '', /문서 변환기가 응답하지 않았습니다/);
    assert.match(await failedCard.textContent() || '', /작업 열기|재시도/);
    const budgetCard = page.locator('.agent-running-card', { hasText: '수정 결과 생성' });
    assert.match(await budgetCard.textContent() || '', /수정 차수 실행 예산이 소진되어 기존 결과를 유지합니다/);
    assert.doesNotMatch(await budgetCard.textContent() || '', /Revision execution budget is exhausted/);
    const failedActivity = page.locator('.agent-activity-timeline > button', { hasText: 'Word 보고서 변환' });
    assert.doesNotMatch(await failedActivity.textContent() || '', /일정/);

    for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
      await page.setViewportSize(viewport);
      await assertTargets(page, viewport.name);
      const metrics = await page.locator('.agent-control-room').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      assert.equal(metrics.scrollWidth <= metrics.clientWidth, true, `${viewport.name}: horizontal overflow`);
      await capture(page, `${viewport.name}-failed-control-home`);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 384, height: 450, screenWidth: 768, screenHeight: 900, deviceScaleFactor: 2, mobile: false });
    assert.equal(await page.evaluate(() => window.innerWidth), 384);
    await assertTargets(page, '200%-zoom');
    const zoomMetrics = await page.locator('.agent-control-room').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    assert.equal(zoomMetrics.scrollWidth <= zoomMetrics.clientWidth, true, '200%-zoom: horizontal overflow');
    await capture(page, 'zoom-200-failed-control-home');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await page.setViewportSize({ width: 1280, height: 900 });
    await failedCard.focus();
    await page.keyboard.press('Enter');
    const heading = page.locator('.agent-work-header h1');
    await heading.waitFor();
    assert.equal(await heading.evaluate((element) => element === document.activeElement), true);
    const budgetTask = page.locator('.agent-work-task', { hasText: '수정 결과 생성' });
    assert.equal(await budgetTask.getByRole('button', { name: '재개', exact: true }).count(), 0);
    const resumable = page.locator('.agent-work-task', { hasText: '출처 확인 대기' });
    assert.equal(await resumable.getByRole('button', { name: '재개', exact: true }).count(), 1);
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    assert.equal(await failedCard.evaluate((element) => element === document.activeElement), true);
    assert.deepEqual(consoleErrors, []);
    console.log(JSON.stringify({ ok: true, checks: 11, captures: 4 }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
