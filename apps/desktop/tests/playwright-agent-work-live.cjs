const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = process.env.EVIDENCE_DIR || path.resolve('.omo/evidence/agent-work-operating-system/task-7-desktop-live-final');
const createdAt = '2026-07-14T09:00:00.000Z';

const mission = {
  id: 'work-live', templateId: 'general-agent-work', title: '실시간 경쟁사 조사', objective: '경쟁사의 최신 가격을 조사한다.',
  successCriteria: [], agentId: 'bizconsultant', executionEngine: 'auto', deliverable: { kind: 'document', format: 'docx' },
  status: 'active', timezone: 'Asia/Seoul', sources: ['web'], reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: [] },
  budget: { usedRuns: 1, usedMinutes: 10, weekStartedAt: createdAt }, missionThreadId: 'thread-live',
  planSummary: '가격을 조사합니다.', plannedAt: createdAt, createdAt, updatedAt: createdAt,
};
const task = {
  id: 'task-approval', missionId: mission.id, sessionId: 'session-live', title: '가격표 검토', status: 'proposed',
  agent: mission.agentId, origin: 'agent', reason: '내부 검토 범위입니다.', expectedOutput: '가격표 요약',
  scheduledAt: createdAt, dueAt: createdAt, date: '2026-07-14', time: '18:00', estimatedMinutes: 20,
  actionClass: 'research', sourceRefs: [], executionEngine: 'auto', deliverable: mission.deliverable,
};
const report = {
  id: 'report-live', missionId: mission.id, taskId: task.id, sessionId: task.sessionId, title: '가격 조사 결과',
  findings: ['A사의 최신 가격을 확인했습니다.'], evidence: [{ label: '가격표', url: 'https://example.com/pricing' }],
  limitations: ['B사는 발표 전입니다.'], followUps: [{ title: 'B사 재확인', reason: '발표 뒤 확인합니다.' }],
  followUpDecisions: [], useful: null, createdAt, updatedAt: createdAt,
};
const backgroundTask = { ...task, id: 'task-background', sessionId: 'session-background', title: '백그라운드 가격 검증', expectedOutput: '백그라운드 검증 결과' };
const backgroundReport = { ...report, id: 'report-background', taskId: backgroundTask.id, sessionId: backgroundTask.sessionId, title: '백그라운드 가격 검증 결과', findings: ['폴링 중 새 결과가 생성되었습니다.'] };
const revisionTask = { ...task, id: 'task-revision', sessionId: 'session-revision', title: '수정 차수 보완', expectedOutput: '보완된 가격 조사 결과' };
const revisionReport = { ...report, id: 'report-revision', taskId: revisionTask.id, sessionId: revisionTask.sessionId, title: '수정 차수 가격 조사 결과', findings: ['사용자 수정 지시를 반영했습니다.'] };
let operationState = {
  ok: true, missions: [mission], tasks: [task], sessions: [], reports: [report],
  daemon: { running: true, lastRun: createdAt, lastError: null },
};
let liveCheckpointVisible = false;
let createdMission = null;
let createdCheckpoints = [];
let missionMutationCheckpoints = [];

function workPayload(item, assignmentReason = `explicit:${item.agentId}`) {
  return {
    id: item.id, templateId: item.templateId, title: item.title, objective: item.objective, status: item.status,
    agentId: item.agentId, assignmentReason, executionEngine: item.executionEngine, resolvedExecutionEngine: 'codex',
    deliverable: item.deliverable, missionThreadId: item.missionThreadId, workConversationId: item.missionThreadId,
    revisionCounter: item.id === mission.id && missionMutationCheckpoints.length ? 2 : 1,
    pendingRevisionId: '',
    currentResultReportId: item.id === mission.id ? (operationState.reports.filter((candidate) => candidate.missionId === item.id).at(-1)?.id || report.id) : '',
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}

function conversationPayload(item, cursor) {
  const conversation = {
    id: item.missionThreadId, missionId: item.id, taskId: '', type: 'mission-thread', title: item.title,
    status: 'waiting_for_approval', pendingInstructions: [], executionEngine: item.executionEngine,
    deliverable: item.deliverable, createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
  if (item.id !== mission.id) {
    return { ok: true, work: workPayload(item, `keyword:${item.agentId}`), conversation, checkpoints: createdCheckpoints, nextCursor: null };
  }
  const checkpoints = Array.from({ length: 205 }, (_, index) => ({
    id: `event-${String(index + 1).padStart(3, '0')}`, sessionId: mission.missionThreadId, sequence: index + 1,
    kind: index === 203 ? 'completion' : index === 204 ? 'approval_request' : index === 0 ? 'user_message' : 'progress',
    text: index === 203 ? '가격 조사 결과가 준비되었습니다.' : index === 204 ? '가격표 검토 승인이 필요합니다.' : index === 0 ? mission.objective : `진행 체크포인트 ${index + 1}`,
    metadata: index === 203 ? { reportId: report.id, taskId: task.id } : index === 204 ? { taskId: task.id } : {},
    createdAt: new Date(Date.parse(createdAt) + index * 1000).toISOString(),
  }));
  if (liveCheckpointVisible) checkpoints.push(
    { id: 'event-206-live-approval', sessionId: mission.missionThreadId, sequence: 206, kind: 'approval_request', text: '백그라운드 검증 제안 승인이 필요합니다.', metadata: { taskId: backgroundTask.id }, createdAt: '2026-07-14T09:04:00.000Z' },
    { id: 'event-207-live-result', sessionId: mission.missionThreadId, sequence: 207, kind: 'completion', text: '백그라운드 실행이 완료되어 최신 결과가 추가되었습니다.', metadata: { reportId: backgroundReport.id, taskId: backgroundTask.id }, createdAt: '2026-07-14T09:04:01.000Z' },
  );
  checkpoints.push(...missionMutationCheckpoints);
  const pageCheckpoints = cursor === 'older-page' ? [...checkpoints.slice(0, 6), checkpoints[6]] : checkpoints.slice(5).reverse();
  return {
    ok: true, work: workPayload(item), conversation, checkpoints: pageCheckpoints,
    nextCursor: cursor === 'older-page' ? null : 'older-page',
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

async function tabTo(page, locator, backwards = false) {
  for (let index = 0; index < 160; index += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    if (await locator.evaluate((element) => element === document.activeElement).catch(() => false)) return;
  }
  throw new Error(`keyboard focus did not reach ${await locator.getAttribute('aria-label').catch(() => '')}`);
}

async function capture(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const target = path.join(evidenceDir, `${name}.png`);
  const buffer = await page.screenshot({ path: target, animations: 'disabled' });
  const integrity = JSON.parse(execFileSync('python3', ['-c', 'from PIL import Image\nimport json,sys\nim=Image.open(sys.argv[1]).convert("RGBA")\np=im.get_flattened_data()\nprint(json.dumps({"black":sum(1 for r,g,b,a in p if a > 250 and r <= 2 and g <= 2 and b <= 2)/len(p),"transparent":sum(1 for r,g,b,a in p if a < 250)/len(p)}))', target], { encoding: 'utf8' }).trim());
  const blackRatio = integrity.black;
  assert.equal(blackRatio < 0.02, true, `${name} raw RGB black ratio ${blackRatio}`);
  assert.equal(integrity.transparent < 0.001, true, `${name} transparent ratio ${integrity.transparent}`);
  return { sha256: crypto.createHash('sha256').update(buffer).digest('hex'), blackRatio, transparentRatio: integrity.transparent };
}

async function scrollWorkSurface(page, edge) {
  const result = await page.evaluate((nextEdge) => {
    const candidates = [
      document.querySelector('.agent-work-conversation'),
      document.querySelector('.agent-work-timeline'),
    ].filter(Boolean);
    const owner = candidates.find((element) => {
      const overflowY = getComputedStyle(element).overflowY;
      return ['auto', 'scroll'].includes(overflowY) && element.scrollHeight > element.clientHeight;
    });
    if (!owner) return null;
    owner.scrollTop = nextEdge === 'bottom' ? owner.scrollHeight : 0;
    return {
      className: owner.className,
      clientHeight: owner.clientHeight,
      scrollHeight: owner.scrollHeight,
    };
  }, edge);
  assert.notEqual(result, null, `no scroll owner found for ${edge}`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertKeyRegionsFitViewport(page) {
  const clipped = await page.locator('.agent-work-header, .agent-work-header > div, .agent-work-layout, .agent-work-primary, .agent-work-timeline, .agent-checkpoint, .agent-checkpoint-result, .agent-work-result-actions, .agent-work-details, .agent-work-composer').evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
    })
    .map((element) => ({ className: element.className, box: element.getBoundingClientRect().toJSON(), innerWidth: window.innerWidth })));
  assert.deepEqual(clipped, []);
}

async function main() {
  const { server, url } = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  const consoleErrors = [];
  let activeConversationRequests = 0;
  let maxConversationRequests = 0;
  let activeAggregateRequests = 0;
  let maxAggregateRequests = 0;
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const apiPath = requestUrl.pathname;
    if (!apiPath.startsWith('/api/')) { await route.continue(); return; }
    const method = request.method();
    const body = request.postDataJSON?.() || {};
    calls.push({ method, path: apiPath, cursor: requestUrl.searchParams.get('cursor'), body });
    if (method === 'GET' && apiPath === '/api/agent-operations') {
      activeAggregateRequests += 1;
      maxAggregateRequests = Math.max(maxAggregateRequests, activeAggregateRequests);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await route.fulfill({ json: operationState });
      activeAggregateRequests -= 1;
      return;
    }
    if (method === 'GET' && apiPath === '/api/agents') { await route.fulfill({ json: { ok: true, agents: [{ id: mission.agentId, displayName: 'Business Consultant', status: 'ready', role: '분석', provider: 'Hermes', trustLevel: '승인', allowedTaskClasses: ['research'] }] } }); return; }
    if (method === 'GET' && apiPath === '/api/scheduler/jobs') { await route.fulfill({ json: { ok: true, jobs: [] } }); return; }
    const conversationMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
    if (method === 'GET' && conversationMatch) {
      const id = decodeURIComponent(conversationMatch[1]);
      const item = operationState.missions.find((candidate) => candidate.id === id);
      if (!item) { await route.fulfill({ status: 404, json: { ok: false, error: 'not_found' } }); return; }
      activeConversationRequests += 1;
      maxConversationRequests = Math.max(maxConversationRequests, activeConversationRequests);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await route.fulfill({ json: conversationPayload(item, requestUrl.searchParams.get('cursor')) });
      activeConversationRequests -= 1;
      return;
    }
    if (method === 'POST' && apiPath === '/api/agent-operations/work') {
      createdMission = { ...mission, id: 'work-keyboard', title: body.title, objective: body.objective, agentId: mission.agentId, status: 'draft', missionThreadId: 'thread-keyboard', plannedAt: '', planSummary: '', updatedAt: '2026-07-14T10:00:00.000Z' };
      const createdTask = { ...task, id: 'task-keyboard', missionId: createdMission.id, status: 'proposed' };
      const initial = { id: 'event-keyboard-initial', sessionId: createdMission.missionThreadId, sequence: 1, kind: 'user_message', text: body.initialMessage, metadata: { deliveryStatus: 'accepted', applicationMode: 'mission_context', acceptedAt: createdAt }, createdAt };
      const approval = { id: 'event-keyboard-approval', sessionId: createdMission.missionThreadId, sequence: 2, kind: 'approval_request', text: '작성 계획 승인이 필요합니다.', metadata: { taskId: createdTask.id }, createdAt: '2026-07-14T09:00:01.000Z' };
      createdCheckpoints = [initial, approval];
      operationState = { ...operationState, missions: [createdMission, ...operationState.missions], tasks: [createdTask, ...operationState.tasks] };
      await route.fulfill({ status: 201, json: { ok: true, work: workPayload(createdMission, `keyword:${createdMission.agentId}`), conversation: conversationPayload(createdMission, null).conversation, message: initial, idempotentReplay: false } }); return;
    }
    const liveMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/live$/);
    if (method === 'POST' && liveMatch) {
      const messageMissionId = decodeURIComponent(liveMatch[1]);
      const item = operationState.missions.find((candidate) => candidate.id === messageMissionId);
      if (!item) { await route.fulfill({ status: 404, json: { ok: false, error: 'not_found' } }); return; }
      const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (body.initial === true) {
        const message = createdCheckpoints.find((checkpoint) => checkpoint.kind === 'user_message');
        const delivery = { status: 'accepted', applicationMode: 'mission_context', acceptedAt: createdAt };
        await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse('accepted', { message, delivery, idempotentReplay: true }) + sse('done', { idempotentReplay: true }) }); return;
      }
      const revision = item.id === mission.id && body.text === '수정 차수로 보완해줘';
      const stateTransition = item.id === mission.id && body.text === '수정 차수 작업을 일시정지해줘';
      const deliveryStatus = revision || stateTransition ? 'applied' : 'accepted';
      const applicationMode = revision ? 'revision' : stateTransition ? 'state_transition' : 'mission_context';
      const message = { id: 'event-keyboard-message', sessionId: item.missionThreadId, sequence: createdCheckpoints.length + 1, kind: 'user_message', text: body.text, metadata: { deliveryStatus, applicationMode, acceptedAt: createdAt, ...(deliveryStatus === 'applied' ? { appliedAt: createdAt } : {}) }, createdAt: '2026-07-14T09:00:02.000Z' };
      if (item.id === mission.id && body.text === '수정 차수로 보완해줘') {
        operationState = { ...operationState, tasks: [...operationState.tasks, revisionTask], reports: [...operationState.reports, revisionReport] };
        missionMutationCheckpoints = [
          { ...message, id: 'event-208-revision-message', sequence: 208, metadata: { ...message.metadata, applicationMode: 'revision', revisionId: 'revision-2' } },
          { id: 'event-209-revision-started', sessionId: item.missionThreadId, sequence: 209, kind: 'revision_started', text: '수정 차수 2를 시작했습니다.', metadata: { revisionId: 'revision-2', revisionNumber: 2, taskId: revisionTask.id }, createdAt: '2026-07-14T09:05:01.000Z' },
          { id: 'event-210-revision-approval', sessionId: item.missionThreadId, sequence: 210, kind: 'approval_request', text: '수정 차수 보완 승인이 필요합니다.', metadata: { revisionId: 'revision-2', taskId: revisionTask.id }, createdAt: '2026-07-14T09:05:02.000Z' },
          { id: 'event-211-revision-result', sessionId: item.missionThreadId, sequence: 211, kind: 'completion', text: '수정 차수 결과가 준비되었습니다.', metadata: { revisionId: 'revision-2', reportId: revisionReport.id, taskId: revisionTask.id }, createdAt: '2026-07-14T09:05:03.000Z' },
        ];
      } else if (item.id === mission.id && body.text === '수정 차수 작업을 일시정지해줘') {
        operationState = { ...operationState, tasks: operationState.tasks.map((candidate) => candidate.id === revisionTask.id ? { ...candidate, status: 'blocked', failureCode: 'manual_pause' } : candidate) };
        missionMutationCheckpoints = [...missionMutationCheckpoints, { ...message, id: 'event-212-pause-message', sequence: 212, metadata: { ...message.metadata, applicationMode: 'state_transition', targetTaskId: revisionTask.id } }, { id: 'event-213-paused', sessionId: item.missionThreadId, sequence: 213, kind: 'blocked', text: '수정 차수 작업을 일시정지했습니다.', metadata: { action: 'pause', taskId: revisionTask.id }, createdAt: '2026-07-14T09:06:01.000Z' }];
      } else if (item.id !== mission.id) {
        createdCheckpoints = [...createdCheckpoints, message];
      }
      const delivery = { status: deliveryStatus, applicationMode, acceptedAt: createdAt, ...(deliveryStatus === 'applied' ? { appliedAt: createdAt } : {}) };
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse('accepted', { message, delivery, idempotentReplay: false }) + sse('done', { idempotentReplay: false }) }); return;
    }
    const taskMatch = apiPath.match(/^\/api\/agent-operations\/tasks\/([^/]+)\/(approve|pause|resume|cancel|retry)$/);
    if (method === 'POST' && taskMatch) {
      operationState = { ...operationState, tasks: operationState.tasks.map((item) => item.id === taskMatch[1] ? { ...item, status: 'scheduled' } : item) };
      await route.fulfill({ json: { ok: true } }); return;
    }
    await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], notes: [], graph: { nodes: [], edges: [] }, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: {} }, uiPreferences: {} } });
  });

  try {
    await page.goto(url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    const card = page.locator('[data-work-mission="work-live"]').first();
    await card.click();
    await page.locator('.agent-checkpoint').nth(204).waitFor();
    assert.equal(await page.locator('.agent-checkpoint').count(), 205);
    assert.equal(await page.locator('.agent-checkpoint').first().getAttribute('data-kind'), 'user_message');
    const lastCheckpointText = (await page.locator('.agent-checkpoint').last().textContent() || '').replace(/\u00a0/g, ' ');
    assert.match(lastCheckpointText, /승인이 필요/);
    assert.deepEqual(calls.filter((call) => call.path.endsWith('/work-live/conversation')).slice(0, 2).map((call) => call.cursor), [null, 'older-page']);
    const headerText = await page.locator('.agent-work-header').textContent() || '';
    assert.match(headerText, /직접 지정.*사용자가 담당 에이전트를 선택/);
    const detailsText = await page.locator('.agent-work-details').textContent() || '';
    assert.match(detailsText, /요청 방식.*자동 선택/);
    assert.match(detailsText, /실제 실행.*Codex/);
    assert.equal(await page.locator('.agent-work-details .agent-work-result').count(), 0);
    const result = page.locator('.agent-checkpoint-result').first();
    assert.match(await result.textContent() || '', /확인할 점.*B사는 발표 전/);
    assert.equal(await result.getByRole('button', { name: '도움 됨' }).count(), 1);
    assert.equal(await result.getByRole('button', { name: 'B사 재확인 승인' }).count(), 1);

    const liveComposer = page.getByLabel('작업 대화 메시지');
    await liveComposer.fill('작성 중인 지시는 유지되어야 합니다.');
    await liveComposer.focus();
    await page.locator('.agent-work-timeline').evaluate((element) => { element.scrollTop = 120; });
    const scrollBeforeLiveUpdate = await page.locator('.agent-work-timeline').evaluate((element) => element.scrollTop);
    const aggregateCallsBeforeLive = calls.filter((call) => call.method === 'GET' && call.path === '/api/agent-operations').length;
    maxAggregateRequests = 0;
    liveCheckpointVisible = true;
    operationState = { ...operationState, tasks: [...operationState.tasks, backgroundTask], reports: [...operationState.reports, backgroundReport] };
    await page.getByText('백그라운드 실행이 완료되어 최신 결과가 추가되었습니다.').waitFor({ timeout: 6_000 });
    await page.locator('.agent-checkpoint-result').filter({ hasText: '백그라운드 가격 검증 결과' }).waitFor();
    const backgroundApproval = page.locator('.agent-checkpoint').filter({ hasText: '백그라운드 검증 제안 승인이 필요합니다.' });
    assert.equal(await backgroundApproval.getByRole('button', { name: '이 제안 승인' }).count(), 1);
    assert.equal(await page.locator('.agent-checkpoint').count(), 207);
    assert.equal(await liveComposer.inputValue(), '작성 중인 지시는 유지되어야 합니다.');
    assert.equal(await liveComposer.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator('.agent-work-timeline').evaluate((element) => element.scrollTop), scrollBeforeLiveUpdate);
    assert.equal(maxConversationRequests, 1);
    assert.equal(maxAggregateRequests, 1);
    assert.equal(calls.filter((call) => call.method === 'GET' && call.path === '/api/agent-operations').length, aggregateCallsBeforeLive + 1);
    await page.waitForTimeout(2_300);
    assert.equal(calls.filter((call) => call.method === 'GET' && call.path === '/api/agent-operations').length, aggregateCallsBeforeLive + 1);

    const revisionCallStart = calls.length;
    await liveComposer.fill('수정 차수로 보완해줘');
    await liveComposer.press('Enter');
    await page.locator('.agent-checkpoint-result').filter({ hasText: '수정 차수 가격 조사 결과' }).waitFor();
    const revisionApproval = page.locator('.agent-checkpoint').filter({ hasText: '수정 차수 보완 승인이 필요합니다.' });
    await revisionApproval.getByRole('button', { name: '이 제안 승인' }).waitFor();
    const revisionCalls = calls.slice(revisionCallStart);
    const revisionPost = revisionCalls.findIndex((call) => call.method === 'POST' && call.path.endsWith('/work-live/live'));
    const revisionAggregate = revisionCalls.findIndex((call) => call.method === 'GET' && call.path === '/api/agent-operations');
    const revisionConversation = revisionCalls.findIndex((call) => call.method === 'GET' && call.path.endsWith('/work-live/conversation'));
    assert.equal(revisionPost >= 0 && revisionAggregate > revisionPost && revisionConversation > revisionAggregate, true, JSON.stringify(revisionCalls));

    await liveComposer.fill('수정 차수 작업을 일시정지해줘');
    await liveComposer.press('Enter');
    await page.getByText('수정 차수 작업을 일시정지했습니다.').waitFor();
    assert.equal(await revisionApproval.getByRole('button', { name: '이 제안 승인' }).count(), 0);
    const revisionTaskCard = page.locator('.agent-work-task').filter({ hasText: '수정 차수 보완' });
    await revisionTaskCard.getByRole('button', { name: '재개', exact: true }).waitFor();
    assert.equal(maxAggregateRequests, 1);

    await liveComposer.fill('');
    await scrollWorkSurface(page, 'top');
    const desktopTop = await capture(page, 'desktop-live-1280');
    await scrollWorkSurface(page, 'bottom');
    const desktopBottom = await capture(page, 'desktop-live-bottom-1280');
    assert.notEqual(desktopTop.sha256, desktopBottom.sha256);
    await page.setViewportSize({ width: 768, height: 900 });
    await scrollWorkSurface(page, 'top');
    const tabletTop = await capture(page, 'tablet-live-768');
    await scrollWorkSurface(page, 'bottom');
    const tabletBottom = await capture(page, 'tablet-live-bottom-768');
    assert.notEqual(tabletTop.sha256, tabletBottom.sha256);
    await page.setViewportSize({ width: 375, height: 812 });
    await scrollWorkSurface(page, 'top');
    const mobileTop = await capture(page, 'mobile-live-375');
    await scrollWorkSurface(page, 'bottom');
    const lastCheckpointBox = await page.locator('.agent-checkpoint').last().boundingBox();
    const composerBox = await page.locator('.agent-work-composer').boundingBox();
    assert.equal(Boolean(lastCheckpointBox && composerBox && lastCheckpointBox.y + lastCheckpointBox.height <= composerBox.y), true, JSON.stringify({ lastCheckpointBox, composerBox }));
    const mobileBottom = await capture(page, 'mobile-live-bottom-375');
    assert.notEqual(mobileTop.sha256, mobileBottom.sha256);

    await page.setViewportSize({ width: 768, height: 900 });
    await page.setViewportSize({ width: 384, height: 450 });
    assert.equal(await page.evaluate(() => window.innerWidth), 384);
    assert.equal(await page.locator('.agent-work-conversation').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await assertKeyRegionsFitViewport(page);
    const zoomTargets = await page.locator('.agent-control-room button:visible, .agent-control-room a:visible, .agent-control-room summary:visible, .agent-control-room textarea:visible').evaluateAll((elements) => elements
      .filter((element) => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44; })
      .map((element) => `${element.tagName}:${element.textContent?.trim()}`));
    assert.deepEqual(zoomTargets, []);
    await scrollWorkSurface(page, 'top');
    const zoomTop = await capture(page, 'zoom-200-live');
    await scrollWorkSurface(page, 'bottom');
    const zoomBottom = await capture(page, 'zoom-200-live-bottom');
    assert.notEqual(zoomTop.sha256, zoomBottom.sha256);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    const delegate = page.getByLabel('에이전트에게 작업 지시');
    await tabTo(page, delegate);
    assert.equal(await delegate.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.type('키보드로 조사 문서를 만들어줘');
    const delegateButton = page.getByRole('button', { name: '위임' });
    await tabTo(page, delegateButton);
    assert.equal(await delegateButton.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    const heading = page.locator('.agent-work-header h1', { hasText: '키보드로 조사 문서를 만들어줘' });
    await heading.waitFor();
    assert.equal(await heading.evaluate((element) => element === document.activeElement), true);
    const composer = page.getByLabel('작업 대화 메시지');
    await tabTo(page, composer);
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.type('공식 출처를 추가해줘');
    await page.keyboard.press('Enter');
    await page.getByText('공식 출처를 추가해줘', { exact: true }).waitFor();
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
    const approve = page.getByRole('button', { name: '이 제안 승인' });
    await tabTo(page, approve);
    assert.equal(await approve.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Space');
    await page.locator('.agent-work-action-status', { hasText: '승인 처리가 완료됐습니다.' }).waitFor();
    const back = page.getByRole('button', { name: '관제 홈으로 돌아가기' });
    await tabTo(page, back);
    assert.equal(await back.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await delegate.evaluate((element) => element === document.activeElement), true);
    assert.deepEqual(consoleErrors, []);
    console.log(JSON.stringify({ ok: true, checkpoints: 213, keyboardFlow: true, maxConversationRequests, maxAggregateRequests, calls: calls.length }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
