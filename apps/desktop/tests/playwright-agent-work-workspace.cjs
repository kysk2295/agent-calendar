const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const evidenceDir = process.env.EVIDENCE_DIR || path.resolve('.omo/evidence/agent-work-operating-system/task-5-workspace');

const baseMission = {
  id: 'mission-work-1', templateId: 'general-agent-work', title: '경쟁사 가격표 조사와 장기적인 시장 변화 대응 전략을 함께 정리하는 운영 보고서',
  objective: '경쟁사 가격 변화를 확인하고 근거와 한계를 포함한 주간 보고서를 작성해 다음 의사결정이 흔들리지 않도록 정리한다.', successCriteria: ['가격 변동 2건'],
  agentId: 'bizconsultant', executionEngine: 'auto', deliverable: { kind: 'document', format: 'docx' },
  status: 'active', timezone: 'Asia/Seoul', sources: ['wiki', 'web'],
  reportSchedule: { weekday: 5, hour: 16, minute: 0 },
  policy: { maxRunsPerWeek: 6, maxRuntimeMinutesPerWeek: 120, forbiddenActions: ['external_message'] },
  budget: { usedRuns: 2, usedMinutes: 42, weekStartedAt: '2026-07-13T00:00:00.000Z' },
  missionThreadId: 'thread-work-1', planSummary: '가격 정책을 수집하고 비교 보고서를 작성합니다.',
  plannedAt: '2026-07-14T09:01:00.000Z', createdAt: '2026-07-14T09:00:00.000Z', updatedAt: '2026-07-14T09:08:00.000Z',
};

const baseTasks = [{
  id: 'task-research', missionId: baseMission.id, sessionId: 'session-research', title: '가격 정책 수집',
  status: 'scheduled', scheduledAt: '2026-07-14T10:00:00.000Z', dueAt: '2026-07-14T11:00:00.000Z',
  agent: 'bizconsultant', origin: 'agent', reason: '공식 가격 근거가 필요합니다.', expectedOutput: '가격 비교표',
  estimatedMinutes: 30, actionClass: 'research', sourceRefs: ['web'], executionEngine: 'auto', deliverable: { kind: 'document', format: 'docx' },
}, {
  id: 'task-blocked', missionId: baseMission.id, sessionId: 'session-blocked', title: '변화 원인 검증',
  status: 'blocked', scheduledAt: '2026-07-14T11:00:00.000Z', dueAt: '2026-07-14T12:00:00.000Z',
  agent: 'bizconsultant', origin: 'agent', reason: '출처 검증이 필요합니다.', expectedOutput: '근거 요약', blockedReason: '공식 발표 대기',
  estimatedMinutes: 30, actionClass: 'analysis', sourceRefs: ['web'], executionEngine: 'auto', deliverable: { kind: 'report', format: 'markdown' },
}, {
  id: 'task-approval', missionId: baseMission.id, sessionId: '', title: '공식 가격표를 바탕으로 내부 영업 대응안 초안 작성',
  status: 'proposed', scheduledAt: '2026-07-14T12:00:00.000Z', dueAt: '2026-07-14T13:00:00.000Z',
  agent: 'bizconsultant', origin: 'agent', reason: '가격 인상이 고객 대응 문구에 미치는 범위를 검토합니다.', expectedOutput: '내부 검토용 영업 대응안 초안',
  estimatedMinutes: 30, actionClass: 'internal_document', sourceRefs: ['web'], executionEngine: 'auto', deliverable: { kind: 'document', format: 'docx' },
}];

const baseReport = {
  id: 'report-current', missionId: baseMission.id, taskId: 'task-research', sessionId: 'session-research',
  title: '가격 변동 2건과 장기 대응 전략 검토 결과', findings: ['A사는 월 요금을 12% 인상했으며 장기 계약 할인 조건도 함께 변경했습니다.', 'B사는 무료 구간을 축소해 초기 도입 고객의 비용 부담이 커졌습니다.'],
  evidence: [{ label: '완성 문서', url: 'https://example.com/reports/weekly-market-report.docx' }, { label: '공식 가격표', url: 'https://example.com/pricing' }, { label: '차단 대상', url: 'javascript:alert(1)' }], limitations: ['C사 발표는 확인 중입니다.'],
  followUps: [{ title: '영업 대응안 작성', reason: '가격 변화에 맞춘 대응이 필요합니다.' }], followUpDecisions: [],
  useful: null, createdAt: '2026-07-14T09:07:00.000Z', updatedAt: '2026-07-14T09:08:00.000Z',
};
const priorReport = {
  ...baseReport, id: 'report-prior', sessionId: '', title: '이전 가격 조사 초안',
  findings: ['이전 조사에서는 A사 가격만 확인했습니다.'], evidence: [], limitations: ['B사 가격은 아직 확인하지 못했습니다.'],
  followUps: [{ title: '이전 초안 보완', reason: '현재 결과 이전의 제안입니다.' }],
  createdAt: '2026-07-14T09:04:30.000Z', updatedAt: '2026-07-14T09:04:30.000Z',
};

let operationState = {
  ok: true, missions: [baseMission], tasks: baseTasks,
  sessions: baseTasks.map((task) => ({ id: task.sessionId, missionId: task.missionId, taskId: task.id, type: 'task', title: task.title, status: task.status, createdAt: '2026-07-14T09:01:00.000Z', updatedAt: '2026-07-14T09:08:00.000Z' })),
  reports: [priorReport, baseReport], daemon: { running: true, lastRun: '2026-07-14T09:08:00.000Z', lastError: null },
};

const workSummary = (mission = baseMission) => ({
  id: mission.id, templateId: mission.templateId, title: mission.title, objective: mission.objective, status: mission.status,
  agentId: mission.agentId, assignmentReason: `keyword:${mission.agentId}`, executionEngine: mission.executionEngine,
  deliverable: mission.deliverable, missionThreadId: mission.missionThreadId, workConversationId: mission.missionThreadId,
  revisionCounter: 1, pendingRevisionId: '', currentResultReportId: 'report-current', createdAt: mission.createdAt, updatedAt: mission.updatedAt,
});

const conversationRecord = (mission = baseMission) => ({
  id: mission.missionThreadId, missionId: mission.id, taskId: '', type: 'mission-thread', title: mission.title,
  status: mission.plannedAt ? 'waiting_for_approval' : 'draft', pendingInstructions: [], executionEngine: mission.executionEngine,
  deliverable: mission.deliverable, createdAt: mission.createdAt, updatedAt: mission.updatedAt,
});

let checkpoints = [{ id: 'event-user', sessionId: 'thread-work-1', sequence: 1, kind: 'user_message', text: baseMission.objective, metadata: { deliveryStatus: 'accepted', applicationMode: 'mission_context', acceptedAt: '2026-07-14T09:00:00.000Z' }, createdAt: '2026-07-14T09:00:00.000Z' },
  { id: 'event-approval', sessionId: 'thread-work-1', sequence: 2, kind: 'approval_request', text: '내부 영업 대응안 초안을 작성하기 전에 승인이 필요합니다.', metadata: { taskId: 'task-approval', action: 'approve' }, createdAt: '2026-07-14T09:00:30.000Z' },
  { id: 'event-plan', sessionId: 'thread-work-1', sequence: 2, kind: 'plan', text: '가격 정책을 수집하고 비교 보고서를 작성합니다.', metadata: {}, createdAt: '2026-07-14T09:01:00.000Z' },
  { id: 'event-progress', sessionId: 'session-research', sequence: 3, kind: 'progress', text: '공식 가격표 3개를 확인했습니다.', metadata: { progress: 60, taskId: 'task-research' }, createdAt: '2026-07-14T09:03:00.000Z' },
  { id: 'event-blocked', sessionId: 'session-blocked', sequence: 4, kind: 'blocked', text: '공식 발표를 기다리고 있습니다.', metadata: { taskId: 'task-blocked' }, createdAt: '2026-07-14T09:04:00.000Z' },
  { id: 'event-prior-result', sessionId: 'session-research', sequence: 5, kind: 'completion', text: '첫 가격 조사 초안이 준비되었습니다.', metadata: { reportId: 'report-prior', taskId: 'task-research' }, createdAt: '2026-07-14T09:04:30.000Z' },
  { id: 'event-revision-start', sessionId: 'thread-work-1', sequence: 5, kind: 'revision_started', text: '수정 차수 1을 시작했습니다.', metadata: { revisionId: 'revision-1', revisionNumber: 1 }, createdAt: '2026-07-14T09:05:00.000Z' },
  { id: 'event-artifact', sessionId: 'session-research', sequence: 6, kind: 'artifact', text: '가격 비교표를 만들었습니다.', metadata: { reportId: 'report-current', taskId: 'task-research' }, createdAt: '2026-07-14T09:06:00.000Z' },
  { id: 'event-completion', sessionId: 'session-research', sequence: 7, kind: 'completion', text: '가격 변동 2건을 정리했습니다.', metadata: { reportId: 'report-current', taskId: 'task-research' }, createdAt: '2026-07-14T09:07:00.000Z' },
  { id: 'event-revision-complete', sessionId: 'thread-work-1', sequence: 8, kind: 'revision_completed', text: '수정 차수 1 결과가 현재 결과입니다.', metadata: { revisionId: 'revision-1', revisionNumber: 1, reportId: 'report-current' }, createdAt: '2026-07-14T09:08:00.000Z' }];

const agents = [{ id: 'bizconsultant', displayName: 'Business Consultant', status: 'ready', role: '시장 조사', provider: 'Hermes', trustLevel: '개인 승인', allowedTaskClasses: ['research'] },
  { id: 'wikicurator', displayName: 'Wiki Curator', status: 'ready', role: '문서 정리', provider: 'Hermes', trustLevel: '내부 쓰기', allowedTaskClasses: ['wiki'] }];
const jobs = [{ id: 'hermes-cron:weekly', name: '주간 기회 리서치', goal: '매주 기회를 찾습니다.', agent: 'bizconsultant', scheduleDisplay: '매주 월요일 09:00', status: 'active', enabled: true, source: 'hermes-cli-cron', lastRunAt: '2026-07-14T08:00:00.000Z', nextRunAt: '2026-07-21T00:00:00.000Z' }];

function conversationPayload(missionId) {
  const mission = operationState.missions.find((item) => item.id === missionId) || baseMission;
  const missionCheckpoints = missionId === baseMission.id ? checkpoints : checkpoints.filter((item) => item.id === `initial-${missionId}`);
  return { ok: true, work: workSummary(mission), conversation: conversationRecord(mission), checkpoints: missionCheckpoints, nextCursor: null };
}

function nextEvent(missionId, text, metadata) {
  const mission = operationState.missions.find((item) => item.id === missionId) || baseMission;
  return { id: `event-${Date.now()}-${checkpoints.length}`, sessionId: mission.missionThreadId, sequence: checkpoints.length + 1, kind: 'user_message', text, metadata, createdAt: new Date().toISOString() };
}

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve('apps/desktop'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function capture(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), animations: 'disabled' });
}

async function assertKeyRegionsFitViewport(page) {
  const clipped = await page.locator('.agent-work-header, .agent-work-header > div, .agent-work-layout, .agent-work-primary, .agent-work-timeline, .agent-checkpoint, .agent-checkpoint-result, .agent-work-result-actions, .agent-work-details, .agent-work-composer, .agent-work-state-error').evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
    })
    .map((element) => ({ className: element.className, box: element.getBoundingClientRect().toJSON(), innerWidth: window.innerWidth })));
  assert.deepEqual(clipped, []);
}

async function assertTextPairUnsplit(locator, pair) {
  const split = await locator.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const start = node.textContent?.indexOf(target) ?? -1;
      if (start >= 0) {
        const first = document.createRange();
        first.setStart(node, start);
        first.setEnd(node, start + 1);
        const last = document.createRange();
        last.setStart(node, start + target.length - 1);
        last.setEnd(node, start + target.length);
        return Math.abs(first.getBoundingClientRect().top - last.getBoundingClientRect().top) > 1;
      }
      node = walker.nextNode();
    }
    throw new Error(`Text pair not found: ${target}`);
  }, pair);
  assert.equal(split, false, `${pair} must remain on one line`);
}

async function main() {
  const { server, url } = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  const consoleErrors = [];
  let failedMessageAttempts = 0;
  let forceConversationRefreshFailure = false;
  let holdNextConversationLoad = true;
  let releaseConversationLoad = null;
  let showEmptyConversation = false;
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const urlValue = new URL(request.url());
    const apiPath = urlValue.pathname;
    if (!apiPath.startsWith('/api/')) { await route.continue(); return; }
    const method = request.method();
    const body = request.postDataJSON?.() || {};
    calls.push({ method, path: apiPath, body });
    if (method === 'GET' && apiPath === '/api/agent-operations') { await route.fulfill({ json: operationState }); return; }
    if (method === 'GET' && apiPath === '/api/agents') { await route.fulfill({ json: { ok: true, agents } }); return; }
    if (method === 'GET' && apiPath === '/api/scheduler/jobs') { await route.fulfill({ json: { ok: true, jobs } }); return; }
    const conversationMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/conversation$/);
    if (method === 'GET' && conversationMatch) {
      if (forceConversationRefreshFailure) { await route.fulfill({ status: 503, json: { ok: false, error: 'GET /api/agent-operations/work/private/conversation failed' } }); return; }
      if (holdNextConversationLoad) {
        await new Promise((resolve) => { releaseConversationLoad = resolve; });
        holdNextConversationLoad = false;
      }
      const payload = conversationPayload(decodeURIComponent(conversationMatch[1]));
      await route.fulfill({ json: showEmptyConversation ? { ...payload, checkpoints: [] } : payload }); return;
    }
    if (method === 'POST' && apiPath === '/api/agent-operations/work') {
      const mission = { ...baseMission, id: 'mission-created', title: body.title, objective: body.objective, agentId: 'wikicurator', status: 'draft', missionThreadId: 'thread-created', planSummary: '', plannedAt: '', createdAt: '2026-07-14T10:00:00.000Z', updatedAt: '2026-07-14T10:00:00.000Z' };
      operationState = { ...operationState, missions: [mission, ...operationState.missions] };
      const initial = { id: 'initial-mission-created', sessionId: mission.missionThreadId, sequence: 1, kind: 'user_message', text: body.initialMessage, metadata: { deliveryStatus: 'accepted', applicationMode: 'mission_context', acceptedAt: mission.createdAt }, createdAt: mission.createdAt };
      checkpoints = [initial, ...checkpoints];
      await route.fulfill({ status: 201, json: { ok: true, work: workSummary(mission), conversation: conversationRecord(mission), message: initial, idempotentReplay: false } }); return;
    }
    const liveMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/live$/);
    if (method === 'POST' && liveMatch) {
      const missionId = decodeURIComponent(liveMatch[1]);
      if (body.text === '실패 보존') {
        failedMessageAttempts += 1;
        if (failedMessageAttempts === 1) { await route.fulfill({ status: 503, json: { ok: false, error: 'temporary_failure', message: '잠시 후 다시 시도하세요.' } }); return; }
      }
      let message;
      let status = 'accepted';
      let applicationMode = 'mission_context';
      let acceptedAt = new Date().toISOString();
      if (body.initial === true) {
        message = checkpoints.find((item) => item.sessionId === `thread-${missionId.replace('mission-', '')}` || item.sessionId === 'thread-created') || checkpoints.find((item) => item.kind === 'user_message');
        acceptedAt = message?.metadata?.acceptedAt || message?.createdAt || acceptedAt;
      } else {
        const rejected = /이메일/.test(body.text);
        const queued = /다음 시도/.test(body.text);
        const followUp = /새 목표/.test(body.text);
        const revision = /같은 목표로 수정/.test(body.text);
        const nextCheckpoint = /일시정지/.test(body.text);
        const applied = revision;
        status = rejected || followUp ? 'rejected' : queued ? 'queued' : applied ? 'applied' : 'accepted';
        applicationMode = rejected ? 'unsupported_external_request' : followUp ? 'follow_up_required' : queued ? 'next_attempt' : revision ? 'revision' : nextCheckpoint ? 'next_checkpoint' : 'mission_context';
        const metadata = { deliveryStatus: status, applicationMode, acceptedAt, ...(applied ? { appliedAt: acceptedAt } : {}) };
        message = nextEvent(missionId, body.text, metadata);
        checkpoints = [...checkpoints, message];
        if (body.text === '대화 새로고침 실패') forceConversationRefreshFailure = true;
        if (rejected) checkpoints = [...checkpoints, { ...nextEvent(missionId, '외부 이메일 전송은 지원되지 않아 아무 작업도 수행하지 않았습니다.', {}), kind: 'blocked' }];
      }
      const delivery = { status, applicationMode, acceptedAt, ...(status === 'applied' ? { appliedAt: acceptedAt } : {}) };
      const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      let stream = sse('accepted', { message, delivery, idempotentReplay: body.initial === true || failedMessageAttempts > 1 });
      if (status === 'accepted' && applicationMode === 'mission_context') {
        const reply = { ...nextEvent(missionId, '실시간으로 작업 대화에 반영했습니다.', {}), kind: 'agent_message' };
        checkpoints = [...checkpoints, reply];
        stream += sse('delta', { text: '실시간으로 작업 대화에 ' });
        stream += sse('delta', { text: '반영했습니다.' });
        stream += sse('checkpoint', { checkpoint: reply });
      }
      stream += sse('done', { idempotentReplay: body.initial === true || failedMessageAttempts > 1 });
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: stream }); return;
    }
    const messageMatch = apiPath.match(/^\/api\/agent-operations\/work\/([^/]+)\/messages$/);
    if (method === 'POST' && messageMatch) {
      const missionId = decodeURIComponent(messageMatch[1]);
      if (body.text === '실패 보존') {
        failedMessageAttempts += 1;
        if (failedMessageAttempts === 1) { await route.fulfill({ status: 503, json: { ok: false, error: 'temporary_failure', message: '잠시 후 다시 시도하세요.' } }); return; }
      }
      const rejected = /이메일/.test(body.text);
      const queued = /다음 시도/.test(body.text);
      const followUp = /새 목표/.test(body.text);
      const revision = /같은 목표로 수정/.test(body.text);
      const nextCheckpoint = /일시정지/.test(body.text);
      const applied = revision;
      const status = rejected || followUp ? 'rejected' : queued ? 'queued' : applied ? 'applied' : 'accepted';
      const applicationMode = rejected ? 'unsupported_external_request' : followUp ? 'follow_up_required' : queued ? 'next_attempt' : revision ? 'revision' : nextCheckpoint ? 'next_checkpoint' : 'mission_context';
      const acceptedAt = new Date().toISOString();
      const metadata = { deliveryStatus: status, applicationMode, acceptedAt, ...(applied ? { appliedAt: acceptedAt } : {}) };
      const message = nextEvent(missionId, body.text, metadata);
      checkpoints = [...checkpoints, message];
      if (body.text === '대화 새로고침 실패') forceConversationRefreshFailure = true;
      if (rejected) checkpoints = [...checkpoints, { ...nextEvent(missionId, '외부 이메일 전송은 지원되지 않아 아무 작업도 수행하지 않았습니다.', {}), kind: 'blocked' }];
      await route.fulfill({ json: { ok: true, message, delivery: { status, applicationMode, acceptedAt, ...(applied ? { appliedAt: acceptedAt } : {}) }, idempotentReplay: failedMessageAttempts > 1 } }); return;
    }
    const planMatch = apiPath.match(/^\/api\/agent-operations\/missions\/([^/]+)\/plan$/);
    if (method === 'POST' && planMatch) {
      const missionId = decodeURIComponent(planMatch[1]);
      const mission = operationState.missions.find((item) => item.id === missionId);
      if (mission) operationState = { ...operationState, missions: operationState.missions.map((item) => item.id === missionId ? { ...item, plannedAt: '2026-07-14T10:05:00.000Z', planSummary: '요청을 확인하고 문서를 작성합니다.' } : item) };
      await route.fulfill({ json: { ok: true } }); return;
    }
    const taskActionMatch = apiPath.match(/^\/api\/agent-operations\/tasks\/([^/]+)\/(approve|pause|resume|cancel|retry|run-now)$/);
    if (method === 'POST' && taskActionMatch) {
      const [, taskId, action] = taskActionMatch;
      const nextStatus = action === 'pause' ? 'blocked' : action === 'cancel' ? 'cancelled' : action === 'run-now' ? 'completed' : action === 'retry' ? 'scheduled' : action === 'resume' ? 'scheduled' : 'scheduled';
      operationState = { ...operationState, tasks: operationState.tasks.map((task) => task.id === taskId ? { ...task, status: nextStatus } : task) };
      await route.fulfill({ json: { ok: true } }); return;
    }
    const missionActionMatch = apiPath.match(/^\/api\/agent-operations\/missions\/([^/]+)\/(activate|pause|cancel)$/);
    if (method === 'POST' && missionActionMatch) {
      const [, missionId, action] = missionActionMatch;
      const nextStatus = action === 'activate' ? 'active' : action === 'pause' ? 'paused' : 'cancelled';
      operationState = { ...operationState, missions: operationState.missions.map((mission) => mission.id === missionId ? { ...mission, status: nextStatus } : mission) };
      await route.fulfill({ json: { ok: true } }); return;
    }
    const feedbackMatch = apiPath.match(/^\/api\/agent-operations\/reports\/([^/]+)\/feedback$/);
    if (method === 'POST' && feedbackMatch) { operationState = { ...operationState, reports: operationState.reports.map((report) => report.id === feedbackMatch[1] ? { ...report, useful: body.useful } : report) }; await route.fulfill({ json: { ok: true } }); return; }
    const followUpMatch = apiPath.match(/^\/api\/agent-operations\/reports\/([^/]+)\/follow-ups$/);
    if (method === 'POST' && followUpMatch) { operationState = { ...operationState, reports: operationState.reports.map((report) => report.id === followUpMatch[1] ? { ...report, followUpDecisions: [{ index: body.index, decision: body.decision, decidedAt: new Date().toISOString() }] } : report) }; await route.fulfill({ json: { ok: true } }); return; }
    const sessionMatch = apiPath.match(/^\/api\/agent-operations\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) { await route.fulfill({ json: { ok: true, session: { id: sessionMatch[1], missionId: baseMission.id, taskId: 'task-research', type: 'task', title: '가격 정책 수집', status: 'completed', pendingInstructions: [], createdAt: baseMission.createdAt, updatedAt: baseMission.updatedAt }, events: [{ id: 'session-event', sessionId: sessionMatch[1], sequence: 1, kind: 'completion', text: '세부 실행을 완료했습니다.', createdAt: baseMission.updatedAt }] } }); return; }
    await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], notes: [], graph: { nodes: [], edges: [] }, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: {} }, uiPreferences: {} } });
  });

  try {
    await page.goto(url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await page.waitForSelector('.agent-control-room');
    assert.equal(await page.locator('.agent-work-conversation').count(), 0);
    assert.equal(await page.locator('.agent-scheduler-card button').count(), 0);
    for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
      await page.setViewportSize(viewport);
      await capture(page, `${viewport.name}-control-home`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const sourceCard = page.locator('.agent-running-card', { hasText: '가격 정책 수집' });
    await sourceCard.focus();
    await sourceCard.click();

    await page.getByText('작업 대화를 불러오는 중입니다.').waitFor();
    assert.equal(await page.locator('.agent-work-details').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(계획 만들기|전체 승인|작업 중단|전체 일시정지|이 제안 승인|이 제안 거절)$/ }).count(), 0);
    for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
      await page.setViewportSize(viewport);
      await capture(page, `${viewport.name}-conversation-loading`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(typeof releaseConversationLoad, 'function');
    releaseConversationLoad();

    // RED on the old drawer: selected work must replace Control Home in normal document flow.
    await page.locator('.agent-work-conversation').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.agent-control-room-board').count(), 0);
    assert.equal(await page.locator('.agent-work-drawer, .agent-work-scrim').count(), 0);
    assert.match(await page.locator('.agent-work-header').textContent() || '', /경쟁사 가격표 조사/);
    const workTypography = await page.locator('.agent-work-header h1').evaluate((heading) => ({
      family: getComputedStyle(document.documentElement).fontFamily,
      size: Number.parseFloat(getComputedStyle(heading).fontSize),
    }));
    assert.match(workTypography.family, /Apple SD Gothic Neo/);
    assert.ok(workTypography.size <= 24, `work title must stay within the operational type scale: ${workTypography.size}px`);
    assert.match(await page.locator('.agent-work-header').textContent() || '', /Business Consultant|bizconsultant/);
    assert.match(await page.locator('.agent-work-header').textContent() || '', /승인 필요|확인 필요/);
    assert.doesNotMatch(await page.locator('.agent-work-timeline').textContent() || '', /rm -rf|tool_activity/);
    const initialCheckpoint = page.locator('.agent-checkpoint[data-kind="user_message"]').first();
    assert.match(await initialCheckpoint.textContent() || '', /접수됨/);
    assert.match(await initialCheckpoint.textContent() || '', /작업 대화에 저장/);
    const approvalCheckpoint = page.locator('.agent-checkpoint[data-kind="approval_request"]');
    assert.match(await approvalCheckpoint.textContent() || '', /내부 검토용 영업 대응안 초안/);
    assert.match(await approvalCheckpoint.textContent() || '', /가격 인상이 고객 대응 문구에 미치는 범위/);
    assert.match(await approvalCheckpoint.textContent() || '', /Business Consultant|bizconsultant/);
    assert.equal(await approvalCheckpoint.getByRole('button', { name: /승인/ }).count(), 1);
    assert.equal(await approvalCheckpoint.getByRole('button', { name: /거절/ }).count(), 1);
    const resultCheckpoint = page.locator('.agent-checkpoint[data-kind="completion"]').filter({ hasText: '가격 변동 2건을 정리했습니다.' });
    assert.equal(await resultCheckpoint.locator('.agent-checkpoint-result').count(), 0);
    const priorResultCheckpoint = page.locator('.agent-checkpoint[data-kind="completion"]').filter({ hasText: '첫 가격 조사 초안이 준비되었습니다.' });
    assert.match(await priorResultCheckpoint.textContent() || '', /이전 결과.*이전 가격 조사 초안/);
    const currentResultCheckpoint = page.locator('.agent-checkpoint[data-kind="revision_completed"]');
    assert.match(await currentResultCheckpoint.textContent() || '', /현재 결과/);
    assert.match(await currentResultCheckpoint.textContent() || '', /A사는 월 요금을 12% 인상/);
    assert.equal(await currentResultCheckpoint.locator('a[href="https://example.com/pricing"]').count(), 1);
    assert.equal(await currentResultCheckpoint.locator('a.agent-work-artifact[href="https://example.com/reports/weekly-market-report.docx"]').count(), 1);
    assert.match(await currentResultCheckpoint.locator('.agent-work-evidence-blocked').textContent() || '', /차단됨.*차단 대상/);
    const desktopUndersizedTargets = await page.locator('.agent-control-room button:visible, .agent-control-room a:visible, .agent-control-room summary:visible, .agent-control-room select:visible').evaluateAll((elements) => elements.filter((element) => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44; }).map((element) => `${element.tagName}:${element.textContent?.trim()}`));
    assert.deepEqual(desktopUndersizedTargets, []);
    const composer = page.getByLabel('작업 대화 메시지');
    await composer.fill('대화 새로고침 실패');
    await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
    const conversationError = page.locator('.agent-work-state-error');
    await conversationError.waitFor();
    assert.doesNotMatch(await conversationError.textContent() || '', /\/api\/|GET /);
    const composerRefreshNotice = page.locator('.agent-work-message-error');
    await composerRefreshNotice.waitFor();
    assert.match(await composerRefreshNotice.textContent() || '', /메시지는 저장됐지만 최신 대화를 불러오지 못했습니다/);
    assert.doesNotMatch(await composerRefreshNotice.textContent() || '', /메시지를 보내지 못했습니다/);
    assert.equal(await composer.inputValue(), '');
    assert.match(await page.locator('.agent-work-delivery').textContent() || '', /접수됨/);
    assert.equal(await page.locator('.agent-work-details').count(), 0);
    assert.equal(await approvalCheckpoint.getByRole('button', { name: /이 제안 (승인|거절)/ }).count(), 0);
    await composer.fill('작성 중인 다음 지시');
    const conversationRetry = conversationError.getByRole('button', { name: '다시 시도' });
    await conversationRetry.click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await conversationError.isVisible(), true);
    assert.equal(await conversationRetry.evaluate((element) => element === document.activeElement), true);
    assert.equal(await approvalCheckpoint.getByRole('button', { name: /이 제안 (승인|거절)/ }).count(), 0);
    assert.equal(await composer.inputValue(), '작성 중인 다음 지시');
    forceConversationRefreshFailure = false;
    await conversationRetry.click();
    await conversationError.waitFor({ state: 'detached' });
    assert.equal(await composer.inputValue(), '작성 중인 다음 지시');
    assert.equal(await page.locator('.agent-work-header h1').evaluate((element) => element === document.activeElement), true);
    assert.equal(await approvalCheckpoint.getByRole('button', { name: '이 제안 승인' }).count(), 1);
    assert.equal(await approvalCheckpoint.getByRole('button', { name: '이 제안 거절' }).count(), 1);
    await composer.fill('');
    await approvalCheckpoint.getByRole('button', { name: '이 제안 승인' }).click();
    const actionReceipt = page.locator('.agent-work-action-status');
    await actionReceipt.filter({ hasText: '완료' }).waitFor();
    assert.match(await actionReceipt.textContent() || '', /승인.*완료/);
    assert.equal(await actionReceipt.getAttribute('role'), 'status');
    assert.equal(await approvalCheckpoint.getByRole('button', { name: /이 제안/ }).count(), 0);
    await capture(page, 'desktop-work-conversation');

    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await page.locator('.agent-control-room-board').waitFor();
    assert.equal(await sourceCard.evaluate((element) => element === document.activeElement), true);

    const duplicateOrigin = page.locator('.agent-activity-timeline button[data-work-mission="mission-work-1"]', { hasText: '가격 변동 2건' });
    await duplicateOrigin.focus();
    await page.keyboard.press('Enter');
    await page.locator('.agent-work-conversation').waitFor();
    assert.equal(await page.locator('.agent-work-header h1').evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.locator('.agent-control-room-board').waitFor();
    assert.equal(await duplicateOrigin.evaluate((element) => element === document.activeElement), true);

    const delegate = page.getByLabel('에이전트에게 작업 지시');
    await delegate.fill('위키 문서를 정리해서 docx로 만들어줘');
    assert.equal(await page.locator('.agent-delegate-bar select').count(), 0);
    await page.getByRole('button', { name: '위임' }).click();
    await page.locator('.agent-work-header h1', { hasText: '위키 문서를 정리해서 docx로 만들어줘' }).waitFor();
    const createCall = calls.find((call) => call.path === '/api/agent-operations/work');
    assert.equal(Object.hasOwn(createCall.body, 'agentId'), false);
    assert.equal(createCall.body.executionEngine, 'auto');

    assert.equal(await composer.isEnabled(), true);
    await composer.fill('계획에 공식 출처를 추가해줘');
    await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
    await page.getByRole('status').filter({ hasText: '접수됨' }).waitFor();
    await page.getByRole('button', { name: '계획 만들기' }).click();
    assert.equal(calls.some((call) => call.path.endsWith('/mission-created/plan')), true);

    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await page.locator('.agent-running-card', { hasText: '가격 정책 수집' }).click();
    for (const [text, expected] of [['다음 시도에 반영해줘', '다음 시도에 반영 예정'], ['작업을 일시정지해줘', '다음 체크포인트 적용 요청됨'], ['현재 결과를 같은 목표로 수정해줘', '적용됨'], ['고객에게 이메일을 보내줘', '실행할 수 없음'], ['새 목표로 판매 전략도 만들어줘', '별도 후속 작업 필요']]) {
      await composer.fill(text);
      await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
      await page.getByRole('status').filter({ hasText: expected }).waitFor();
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="작업 대화에 보내기"]');
        return button instanceof HTMLButtonElement && button.textContent === '보내기';
      });
    }
    const unsupportedCheckpoint = page.locator('.agent-checkpoint[data-kind="blocked"]', { hasText: '외부 이메일 전송은 지원되지 않아' });
    await unsupportedCheckpoint.waitFor();
    assert.equal(await unsupportedCheckpoint.getByRole('button', { name: /승인/ }).count(), 0);
    assert.match(await page.locator('.agent-work-timeline').textContent() || '', /수정 차수 1|현재 결과/);
    for (const expected of ['다음 시도에 반영 예정', '다음 체크포인트 적용 요청됨', '적용됨', '실행할 수 없음']) {
      assert.match(await page.locator('.agent-work-timeline').textContent() || '', new RegExp(expected));
    }

    assert.equal(await page.getByText('요청 방식', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('실제 실행', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '지금 실행' }).first().click();
    await page.getByRole('button', { name: '재개' }).click();
    await currentResultCheckpoint.getByRole('button', { name: '도움 됨' }).click();
    await currentResultCheckpoint.getByRole('button', { name: '영업 대응안 작성 승인' }).click();
    await page.getByRole('button', { name: 'Task Session 열기' }).first().click();
    await page.getByRole('dialog', { name: /Task Session/ }).waitFor();
    await page.getByRole('button', { name: 'Task Session 닫기' }).click();

    await composer.fill('실패 보존');
    await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
    await page.locator('.agent-work-message-error', { hasText: '메시지를 보내지 못했습니다. 입력을 유지했습니다. 다시 시도해 주세요.' }).waitFor();
    assert.equal(await composer.inputValue(), '실패 보존');
    assert.equal(await page.locator('.agent-work-conversation').count(), 1);
    await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
    await page.getByRole('status').filter({ hasText: '접수됨' }).waitFor();
    assert.equal(await composer.inputValue(), '');
    const retryCalls = calls.filter((call) => call.path.endsWith('/mission-work-1/live') && call.body.text === '실패 보존');
    assert.equal(retryCalls.length, 2);
    assert.equal(retryCalls[0].body.clientMessageId, retryCalls[1].body.clientMessageId);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.agent-work-timeline').evaluate((element) => { element.scrollTop = 0; });
    await capture(page, 'desktop-long-conversation-top');
    await page.locator('.agent-work-timeline').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await capture(page, 'desktop-long-conversation-bottom');
    assert.notDeepEqual(fs.readFileSync(path.join(evidenceDir, 'desktop-long-conversation-top.png')), fs.readFileSync(path.join(evidenceDir, 'desktop-long-conversation-bottom.png')));
    const desktopLastCheckpoint = await page.locator('.agent-checkpoint').last().boundingBox();
    const desktopTimeline = await page.locator('.agent-work-timeline').boundingBox();
    assert.equal(Boolean(desktopLastCheckpoint && desktopTimeline && desktopLastCheckpoint.y < desktopTimeline.y + desktopTimeline.height && desktopLastCheckpoint.y + desktopLastCheckpoint.height > desktopTimeline.y), true);

    for (const viewport of [{ width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
      await page.setViewportSize(viewport);
      const details = page.locator('.agent-work-details > details');
      await page.waitForFunction(() => !document.querySelector('.agent-work-details > details')?.hasAttribute('open'));
      await details.locator('summary').click();
      await page.waitForFunction(() => document.querySelector('.agent-work-details > details')?.hasAttribute('open'));
      await page.waitForFunction(() => { const element = document.querySelector('.agent-work-conversation'); return element && element.scrollHeight > element.clientHeight; });
      const scrollOwners = await page.locator('.agent-work-conversation, .agent-work-layout, .agent-work-primary, .agent-work-timeline, .agent-work-details').evaluateAll((elements) => elements.filter((element) => {
        const overflowY = getComputedStyle(element).overflowY;
        return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight;
      }).map((element) => element.className));
      assert.deepEqual(scrollOwners, ['agent-work-conversation']);
      const composerLayout = await page.locator('.agent-work-conversation').evaluate(async (conversation) => {
        const composer = conversation.querySelector('.agent-work-composer');
        if (!(composer instanceof HTMLElement)) throw new Error('composer missing');
        const overlaps = () => {
          const composerBox = composer.getBoundingClientRect();
          return [...conversation.querySelectorAll('.agent-checkpoint')]
            .map((checkpoint) => checkpoint.getBoundingClientRect())
            .filter((checkpointBox) => checkpointBox.bottom > composerBox.top && checkpointBox.top < composerBox.bottom)
            .map((checkpointBox) => checkpointBox.toJSON());
        };
        conversation.scrollTop = 0;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const topOverlaps = overlaps();
        conversation.scrollTop = Math.floor((conversation.scrollHeight - conversation.clientHeight) / 2);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { position: getComputedStyle(composer).position, topOverlaps, middleOverlaps: overlaps() };
      });
      assert.notEqual(composerLayout.position, 'sticky');
      assert.deepEqual(composerLayout.topOverlaps, [], JSON.stringify({ viewport, composerLayout }));
      assert.deepEqual(composerLayout.middleOverlaps, [], JSON.stringify({ viewport, composerLayout }));
      const cjkPolicies = await page.locator('.agent-work-header h1, .agent-work-state, .agent-checkpoint p, .agent-checkpoint dd, .agent-operations-error span').evaluateAll((elements) => elements.map((element) => ({ text: element.textContent?.trim(), wordBreak: getComputedStyle(element).wordBreak, overflowWrap: getComputedStyle(element).overflowWrap })));
      assert.equal(cjkPolicies.every((item) => item.wordBreak === 'keep-all' && item.overflowWrap === 'anywhere'), true, JSON.stringify(cjkPolicies));
      await assertTextPairUnsplit(page.locator('.agent-work-header h1'), '변화');
      await assertTextPairUnsplit(approvalCheckpoint.locator('dd').filter({ hasText: '범위를' }), '범위를');
      await assertTextPairUnsplit(unsupportedCheckpoint.locator('p'), '수행하지\u00a0않았습니다');
      assert.equal(await unsupportedCheckpoint.locator('p').evaluate((element) => getComputedStyle(element).textWrapStyle), 'pretty');
      const undersizedMetadata = await page.locator('.agent-status-card small:visible, .agent-status-card footer:visible, .agent-control-section-title > span:visible, .agent-control-section-note:visible, .agent-running-card small:visible, .agent-running-card p:visible, .agent-approval-open small:visible, .agent-approval-card > div span:visible, .agent-approval-card footer time:visible, .agent-activity-timeline > b:visible, .agent-activity-timeline time:visible, .agent-activity-timeline small:visible, .agent-work-kicker:visible, .agent-checkpoint header time:visible, .agent-checkpoint > small:visible, .agent-work-composer > small:visible, .agent-work-details-body *:visible').evaluateAll((elements) => elements.filter((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 10).map((element) => `${element.tagName}:${getComputedStyle(element).fontSize}:${element.textContent?.trim()}`));
      assert.deepEqual(undersizedMetadata, []);
      await page.locator('.agent-work-conversation').evaluate((element) => { element.scrollTop = 0; });
      await capture(page, `${viewport.name}-work-conversation`);
      assert.notEqual(await details.getAttribute('open'), null);
      await details.scrollIntoViewIfNeeded();
      assert.equal(await details.isVisible(), true);
      const undersized = await page.locator('.agent-control-room button:visible, .agent-control-room a:visible, .agent-control-room summary:visible, .agent-control-room select:visible').evaluateAll((elements) => elements.filter((element) => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44; }).map((element) => `${element.tagName}:${element.textContent?.trim()}`));
      assert.deepEqual(undersized, []);
      const tinyDetails = await page.locator('.agent-work-details-body *:visible').evaluateAll((elements) => elements.filter((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 10).map((element) => `${element.tagName}:${getComputedStyle(element).fontSize}`));
      assert.deepEqual(tinyDetails, []);
      const overflow = await page.locator('.agent-work-conversation').evaluate((element) => element.scrollWidth > element.clientWidth);
      assert.equal(overflow, false);
      await page.locator('.agent-work-composer').scrollIntoViewIfNeeded();
      const lastCheckpoint = page.locator('.agent-checkpoint').last();
      await lastCheckpoint.scrollIntoViewIfNeeded();
      const composerBox = await page.locator('.agent-work-composer').boundingBox();
      const lastCheckpointBox = await lastCheckpoint.boundingBox();
      assert.equal(Boolean(composerBox && lastCheckpointBox && (lastCheckpointBox.y + lastCheckpointBox.height <= composerBox.y || lastCheckpointBox.y >= composerBox.y + composerBox.height)), true, JSON.stringify({ viewport, composerBox, lastCheckpointBox }));
      await capture(page, `${viewport.name}-work-conversation-bottom`);
      if (await details.getAttribute('open') !== null) await details.locator('summary').click();
    }
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal((await page.getByLabel('에이전트에게 작업 지시').getAttribute('placeholder') || '').includes('문서로\u00a0만들어줘'), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedDuration = await page.locator('.agent-running-card').first().evaluate((element) => getComputedStyle(element).transitionDuration);
    assert.match(reducedDuration, /0\.01ms|0s/);
    const reducedWorkspaceMotion = await page.locator('.agent-operations-workspace').evaluate((element) => ({
      animationName: getComputedStyle(element).animationName,
      animationDuration: getComputedStyle(element).animationDuration,
      transitionDuration: getComputedStyle(element).transitionDuration,
    }));
    assert.equal(reducedWorkspaceMotion.animationName, 'none');
    assert.match(reducedWorkspaceMotion.animationDuration, /0\.01ms|0s/);
    assert.match(reducedWorkspaceMotion.transitionDuration, /0\.01ms|0s/);
    await capture(page, 'reduced-motion-control-home');
    await page.locator('.agent-running-card').first().click();
    assert.equal(await page.locator('main.agent-work-conversation').count(), 1);
    assert.equal(await page.locator('.agent-work-timeline[aria-live="polite"]').count(), 1);
    const focusedHeading = page.locator('.agent-work-header h1');
    assert.equal(await focusedHeading.evaluate((element) => element === document.activeElement), true);
    assert.equal(await focusedHeading.evaluate((element) => getComputedStyle(element).outlineStyle !== 'none' && Number.parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
    await capture(page, 'desktop-focus-open');
    await page.setViewportSize({ width: 384, height: 450 });
    assert.equal(await page.evaluate(() => window.innerWidth), 384);
    assert.equal(await page.locator('.agent-work-conversation').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await assertKeyRegionsFitViewport(page);
    await assertTextPairUnsplit(page.locator('.agent-work-header h1'), '변화');
    await capture(page, 'zoom-200-work-conversation');
    const zoomDetails = page.locator('.agent-work-details > details');
    await zoomDetails.scrollIntoViewIfNeeded();
    if (await zoomDetails.getAttribute('open') === null) await zoomDetails.locator('summary').click();
    const zoomArtifact = page.locator('.agent-work-timeline a.agent-work-artifact[href="https://example.com/reports/weekly-market-report.docx"]').last();
    await zoomArtifact.scrollIntoViewIfNeeded();
    assert.equal(await zoomArtifact.isVisible(), true);
    const zoomUndersizedTargets = await page.locator('.agent-control-room button:visible, .agent-control-room a:visible, .agent-control-room summary:visible, .agent-control-room select:visible').evaluateAll((elements) => elements.filter((element) => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44; }).map((element) => `${element.tagName}:${element.textContent?.trim()}`));
    assert.deepEqual(zoomUndersizedTargets, []);
    await capture(page, 'zoom-200-artifact-details');
    await page.locator('.agent-work-composer').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.agent-work-composer').isVisible(), true);
    assert.equal(await page.locator('.agent-work-conversation').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await assertKeyRegionsFitViewport(page);
    await capture(page, 'zoom-200-bottom-artifact-details');
    await composer.fill('대화 새로고침 실패');
    await page.getByRole('button', { name: '작업 대화에 보내기' }).click();
    const zoomRetry = page.locator('.agent-work-state-error');
    await zoomRetry.waitFor();
    const staleResult = page.locator('.agent-checkpoint-result').filter({ hasText: '가격 변동 2건과 장기 대응 전략 검토 결과' });
    await staleResult.waitFor();
    const stalePriorResult = page.locator('.agent-checkpoint-result').filter({ hasText: '이전 가격 조사 초안' });
    await stalePriorResult.waitFor();
    assert.match(await staleResult.textContent() || '', /A사는 월 요금을 12% 인상/);
    assert.match(await stalePriorResult.textContent() || '', /이전 조사에서는 A사 가격만 확인/);
    for (const result of [staleResult, stalePriorResult]) assert.equal(await result.getByRole('button', { name: /승인|거절|도움 됨|개선 필요/ }).count(), 0);
    assert.equal(await staleResult.getByRole('button', { name: 'Task Session 열기', exact: true }).count(), 1);
    await zoomRetry.scrollIntoViewIfNeeded();
    assert.equal(await zoomRetry.getByRole('button', { name: '다시 시도' }).isVisible(), true);
    assert.equal(await page.locator('.agent-work-composer').isVisible(), true);
    await page.locator('.agent-work-conversation').evaluate(async (conversation) => {
      const retry = conversation.querySelector('.agent-work-state-error');
      const composer = conversation.querySelector('.agent-work-composer');
      if (!(retry instanceof HTMLElement) || !(composer instanceof HTMLElement)) throw new Error('retry geometry missing');
      const overlap = retry.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
      if (overlap >= 0) conversation.scrollTop += overlap + 12;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const retryGeometry = await page.locator('.agent-work-conversation').evaluate((conversation) => {
      const retry = conversation.querySelector('.agent-work-state-error');
      const composer = conversation.querySelector('.agent-work-composer');
      return retry && composer ? { retry: retry.getBoundingClientRect().toJSON(), composer: composer.getBoundingClientRect().toJSON() } : null;
    });
    assert.equal(Boolean(retryGeometry && (retryGeometry.retry.bottom <= retryGeometry.composer.top || retryGeometry.retry.top >= retryGeometry.composer.bottom)), true, JSON.stringify(retryGeometry));
    assert.equal(await page.locator('.agent-work-conversation').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await assertKeyRegionsFitViewport(page);
    await capture(page, 'zoom-200-retry');
    const zoomRetryButton = zoomRetry.getByRole('button', { name: '다시 시도' });
    await zoomRetryButton.click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await zoomRetry.isVisible(), true);
    assert.equal(await zoomRetryButton.evaluate((element) => element === document.activeElement), true);
    forceConversationRefreshFailure = false;
    await zoomRetryButton.click();
    await zoomRetry.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.agent-work-header h1').evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator('.agent-work-header h1').evaluate((element) => getComputedStyle(element).outlineStyle !== 'none' && Number.parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
    await capture(page, 'zoom-200-retry-success-focus');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: '관제 홈으로 돌아가기' }).click();
    await page.locator('.agent-control-room-board').waitFor();
    showEmptyConversation = true;
    await page.locator('[data-work-mission="mission-work-1"]').first().click();
    await page.getByText('아직 체크포인트가 없습니다. 아래 입력창에서 첫 지시를 남길 수 있습니다.').waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await assertTextPairUnsplit(page.getByText('첫 지시를', { exact: true }), '첫 지시를');
    await page.setViewportSize({ width: 768, height: 812 });
    await page.setViewportSize({ width: 384, height: 406 });
    await assertTextPairUnsplit(page.getByText('첫 지시를', { exact: true }), '첫 지시를');
    await assertKeyRegionsFitViewport(page);
    for (const viewport of [{ width: 1280, height: 900, name: 'desktop' }, { width: 768, height: 900, name: 'tablet' }, { width: 375, height: 812, name: 'mobile' }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { window.scrollTo(0, 0); const conversation = document.querySelector('.agent-work-conversation'); if (conversation) conversation.scrollTop = 0; });
      await capture(page, `${viewport.name}-conversation-empty`);
    }
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes('503 (Service Unavailable)'));
    assert.equal(unexpectedConsoleErrors.length, 0, unexpectedConsoleErrors.join('\n'));
    fs.writeFileSync(path.join(evidenceDir, 'console.json'), JSON.stringify({ consoleErrors, expectedNetworkErrorCount: consoleErrors.length - unexpectedConsoleErrors.length, calls: calls.map(({ method, path: requestPath }) => ({ method, path: requestPath })) }, null, 2));
    console.log(JSON.stringify({ ok: true, calls: calls.length, screenshots: 20, failedMessageAttempts }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ calls, body: await page.locator('body').innerText().catch(() => '') }, null, 2));
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
