const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');

const {
  buildMissionPlanPrompt,
  createWeeklyOpportunityMission,
  parseMissionPlan,
  sanitizeSessionEvent,
  transitionAgentTask,
  validateReport,
} = require('../app/lib/agent-operations-domain');
const { HermesStore } = require('../app/lib/store');
const { PostgresHermesStore } = require('../app/lib/postgres-store');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { AgentOperationsService } = require('../app/lib/agent-operations-service');

const FIXED_NOW = '2026-07-13T09:00:00.000Z';
const clock = () => new Date(FIXED_NOW);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createValidPlan() {
  return {
    summary: '금요일 보고 전에 세 가지 기회를 검증한다.',
    tasks: [
      {
        key: 'scan',
        title: '경쟁사 변화 수집',
        reason: '가격 변화 근거가 부족하다.',
        expectedOutput: '공식 출처 비교표',
        scheduledAt: '2026-07-13T10:00:00.000Z',
        dueAt: '2026-07-13T11:00:00.000Z',
        estimatedMinutes: 40,
        actionClass: 'research',
        sourceRefs: ['web', 'wiki'],
      },
      {
        key: 'verify',
        title: '기회 가설 검증',
        reason: '수집한 변화를 사업 기회와 연결해야 한다.',
        expectedOutput: '근거가 포함된 가설 3개',
        scheduledAt: '2026-07-15T05:00:00.000Z',
        dueAt: '2026-07-15T06:00:00.000Z',
        estimatedMinutes: 40,
        actionClass: 'analysis',
        sourceRefs: ['web', 'wiki'],
      },
      {
        key: 'report',
        title: '주간 기회 보고',
        reason: '금요일 사용자 보고 계약이다.',
        expectedOutput: '기회 3개와 추천 1개',
        scheduledAt: '2026-07-17T06:00:00.000Z',
        dueAt: '2026-07-17T07:00:00.000Z',
        estimatedMinutes: 40,
        actionClass: 'report',
        sourceRefs: ['mission'],
      },
    ],
  };
}

test('creates the personal weekly opportunity mission with bounded autonomy', () => {
  // Given
  const id = 'mission-weekly';

  // When
  const mission = createWeeklyOpportunityMission({ id, clock });

  // Then
  assert.equal(mission.agentId, 'bizconsultant');
  assert.equal(mission.status, 'draft');
  assert.equal(mission.timezone, 'Asia/Seoul');
  assert.equal(mission.policy.maxRunsPerWeek, 6);
  assert.equal(mission.policy.maxRuntimeMinutesPerWeek, 120);
  assert.deepEqual(mission.policy.forbiddenActions, [
    'external_message',
    'publish',
    'purchase',
    'trade',
    'delete_source',
  ]);
});

test('builds a planning contract without hidden autonomous side effects', () => {
  // Given
  const mission = createWeeklyOpportunityMission({ id: 'mission-weekly', clock });

  // When
  const prompt = JSON.parse(buildMissionPlanPrompt({ mission }));

  // Then
  assert.equal(prompt.mission.id, mission.id);
  assert.match(prompt.instruction, /2-5 bounded tasks/i);
  assert.match(prompt.instruction, /exactly one report task/i);
  assert.match(prompt.instruction, /external side effects/i);
});

test('parses a bounded plan with exactly one report task', () => {
  // Given
  const mission = createWeeklyOpportunityMission({ id: 'mission-weekly', clock });

  // When
  const plan = parseMissionPlan({ mission, raw: JSON.stringify(createValidPlan()) });

  // Then
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0), 120);
  assert.equal(plan.tasks.filter((task) => task.actionClass === 'report').length, 1);
});

test('rejects duplicate, over-budget, and externally acting plan work', () => {
  // Given
  const mission = createWeeklyOpportunityMission({ id: 'mission-weekly', clock });
  const duplicate = createValidPlan();
  duplicate.tasks[1].key = duplicate.tasks[0].key;
  const overBudget = createValidPlan();
  overBudget.tasks[0].estimatedMinutes = 41;
  const forbidden = createValidPlan();
  forbidden.tasks[0].actionClass = 'external_message';

  // When / Then
  assert.throws(() => parseMissionPlan({ mission, raw: JSON.stringify(duplicate) }), /duplicate/i);
  assert.throws(() => parseMissionPlan({ mission, raw: JSON.stringify(overBudget) }), /budget/i);
  assert.throws(() => parseMissionPlan({ mission, raw: JSON.stringify(forbidden) }), /not allowed/i);
});

test('enforces explicit agent task state transitions', () => {
  // Given
  const proposed = { id: 'task-scan', status: 'proposed' };

  // When
  const scheduled = transitionAgentTask(proposed, 'approve', { clock });

  // Then
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.updatedAt, FIXED_NOW);
  assert.throws(() => transitionAgentTask(scheduled, 'complete', { clock }), /invalid task transition/i);
});

test('redacts secrets private paths and hidden reasoning from session events', () => {
  // Given
  const event = {
    kind: 'tool_activity',
    text: 'token=secret /Users/koyunseo/private.md',
    metadata: {
      authorization: 'Bearer secret',
      chainOfThought: 'hidden reasoning',
    },
  };

  // When
  const sanitized = sanitizeSessionEvent(event);

  // Then
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /secret|\/Users\/koyunseo|hidden reasoning/);
  assert.match(serialized, /redacted|private-path/i);
});

test('accepts only evidence-backed report structures', () => {
  // Given
  const report = {
    findings: ['기회 A'],
    evidence: [{ label: '공식 가격 페이지', url: 'https://example.com/pricing' }],
    limitations: ['실사용자 인터뷰 전'],
    budget: { usedRuns: 3, usedMinutes: 105 },
    followUps: [{ title: '사용자 인터뷰', reason: '수요 검증' }],
  };

  // When
  const validated = validateReport(report);

  // Then
  assert.deepEqual(validated, report);
  assert.throws(() => validateReport({ ...report, evidence: [] }), /evidence/i);
});

test('persists a mission task session events and report across a store restart', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-'));
  const first = new HermesStore({ dataDir, clock });
  const mission = first.createAgentMission(
    createWeeklyOpportunityMission({ id: 'mission-weekly', clock }),
  );
  const task = first.createTask({
    title: '경쟁사 변화 수집',
    owner: 'Agent',
    status: 'proposed',
    missionId: mission.id,
    origin: 'agent',
    createdByAgentId: 'bizconsultant',
    reason: '근거 부족',
    expectedOutput: '비교표',
    scheduledAt: '2026-07-13T10:00:00.000Z',
    dueAt: '2026-07-13T11:00:00.000Z',
    estimatedMinutes: 40,
    actionClass: 'research',
    sourceRefs: ['web', 'wiki'],
  });
  const session = first.createAgentSession({
    id: 'session-scan',
    missionId: mission.id,
    taskId: task.id,
    status: 'proposed',
  });
  first.appendAgentSessionEvent(session.id, {
    kind: 'plan',
    text: '공식 출처를 먼저 확인한다.',
  });
  first.appendAgentSessionEvent(session.id, {
    kind: 'progress',
    text: '공식 가격 페이지를 확인 중이다.',
  });
  first.createAgentReport({
    id: 'report-weekly',
    missionId: mission.id,
    sessionId: session.id,
    status: 'ready',
    findings: ['기회 1'],
    evidence: ['source-1'],
    limitations: [],
    budget: { usedRuns: 1, usedMinutes: 40 },
    followUps: [],
  });

  // When
  const restarted = new HermesStore({ dataDir, clock });
  const state = restarted.getState();
  const restoredSession = restarted.getAgentSession(session.id);

  // Then
  assert.equal(state.agentMissions[0].id, mission.id);
  assert.equal(state.tasks.find((item) => item.id === task.id).sessionId, session.id);
  assert.deepEqual(restoredSession.events.map((event) => event.sequence), [1, 2]);
  assert.equal(state.agentReports[0].id, 'report-weekly');

  await rm(dataDir, { recursive: true, force: true });
});

test('mirrors agent operation relationships to Postgres tables', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-postgres-'));
  const queries = [];
  const pool = {
    query: async (sql, values = []) => {
      queries.push({ sql: String(sql), values });
      return { rows: [] };
    },
  };
  const store = new PostgresHermesStore({
    pool,
    dataDir,
    clock,
    autoMigrate: false,
  });
  await store.ready;
  const mission = store.createAgentMission(
    createWeeklyOpportunityMission({ id: 'mission-postgres', clock }),
  );
  const task = store.createTask({
    id: 'task-postgres',
    title: '기회 근거 확인',
    owner: 'Agent',
    status: 'proposed',
    missionId: mission.id,
    origin: 'agent',
  });

  // When
  const session = store.createAgentSession({
    id: 'session-postgres',
    missionId: mission.id,
    taskId: task.id,
  });
  store.appendAgentSessionEvent(session.id, { kind: 'plan', text: '공식 출처 확인' });
  store.createAgentReport({
    id: 'report-postgres',
    missionId: mission.id,
    sessionId: session.id,
    findings: ['기회 A'],
    evidence: ['source-a'],
    limitations: [],
    budget: { usedMinutes: 10 },
    followUps: [],
  });

  // Then
  const sql = queries.map((query) => query.sql).join('\n');
  assert.match(sql, /insert into agent_missions/i);
  assert.match(sql, /insert into agent_sessions/i);
  assert.match(sql, /insert into agent_session_events/i);
  assert.match(sql, /insert into agent_reports/i);
  assert.match(sql, /insert into tasks \(id, title, status, owner, due_at, mission_id, session_id/i);

  await rm(dataDir, { recursive: true, force: true });
});

test('agent operations API creates lists and updates durable work contracts', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-api-'));
  const store = new HermesStore({ dataDir, clock });
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: store,
    agentOperationsClock: clock,
  });
  const baseUrl = await listen(server);

  try {
    // When
    const createResponse = await fetch(`${baseUrl}/api/agent-operations/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'weekly-opportunity-brief' }),
    });
    const created = await createResponse.json();

    // Then
    assert.equal(createResponse.status, 201);
    assert.equal(created.ok, true);
    assert.equal(created.mission.status, 'draft');

    // Given
    const task = store.createTask({
      id: 'task-api',
      title: '경쟁사 변화 수집',
      owner: 'Agent',
      status: 'proposed',
      missionId: created.mission.id,
      origin: 'agent',
      createdByAgentId: 'bizconsultant',
    });
    const session = store.createAgentSession({
      id: 'session-api',
      missionId: created.mission.id,
      taskId: task.id,
    });
    store.appendAgentSessionEvent(session.id, { kind: 'plan', text: '공식 출처 확인' });
    const report = store.createAgentReport({
      id: 'report-api',
      missionId: created.mission.id,
      sessionId: session.id,
      findings: ['기회 A'],
      evidence: ['source-a'],
      limitations: [],
      budget: { usedMinutes: 10 },
      followUps: [{ title: '사용자 인터뷰', reason: '수요를 검증한다.' }],
    });

    // When
    const stateResponse = await fetch(`${baseUrl}/api/agent-operations`);
    const sessionResponse = await fetch(`${baseUrl}/api/agent-operations/sessions/${session.id}`);
    const actionResponse = await fetch(`${baseUrl}/api/agent-operations/tasks/${task.id}/approve`, {
      method: 'POST',
    });
    const feedbackResponse = await fetch(`${baseUrl}/api/agent-operations/reports/${report.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useful: true, note: '의사결정에 사용함' }),
    });
    const followUpResponse = await fetch(`${baseUrl}/api/agent-operations/reports/${report.id}/follow-ups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0, decision: 'approved' }),
    });
    const state = await stateResponse.json();
    const sessionDetail = await sessionResponse.json();
    const action = await actionResponse.json();
    const feedback = await feedbackResponse.json();
    const followUp = await followUpResponse.json();

    // Then
    assert.equal(stateResponse.status, 200);
    assert.equal(state.missions.length, 1);
    assert.equal(state.tasks.length, 1);
    assert.equal(sessionDetail.session.events[0].kind, 'plan');
    assert.equal(action.task.status, 'scheduled');
    assert.equal(feedback.report.useful, true);
    assert.equal(store.getAgentReports()[0].feedback.note, '의사결정에 사용함');
    assert.equal(followUpResponse.status, 200);
    assert.equal(followUp.report.followUpDecisions[0].decision, 'approved');
    assert.equal(store.getAgentSession(session.id).events.at(-1).kind, 'approval_response');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Relay planning completion preserves tool activity and structured output', async () => {
  // Given
  const { runRelayChatCompletion } = require('../app/lib/relay-chat-completion');
  const observed = [];
  const relay = {
    isBridgeOnline: () => true,
    enqueue: ({ kind, payload, meta }) => ({ id: 'relay-job-plan', kind, payload, meta }),
    waitForEvents: async () => ({
      cursor: 2,
      complete: true,
      events: [
        { event: 'tool-activity', data: { tool: 'web-search', text: '공식 출처 검색' } },
        { event: 'message', data: { text: JSON.stringify(createValidPlan()) } },
      ],
    }),
    fail: () => {
      throw new Error('Relay fail must not run on a successful completion');
    },
  };

  // When
  const completion = await runRelayChatCompletion({
    relay,
    env: { HERMES_RELAY_ENABLED: '1', HERMES_RELAY_TOKEN: 'token' },
    payload: {
      model: 'bizconsultant',
      stream: true,
      messages: [{ role: 'user', content: 'plan' }],
    },
    meta: { missionId: 'mission-weekly', sessionId: 'session-plan' },
    onEvent: (event) => observed.push(event),
  });

  // Then
  assert.match(completion.text, /"tasks"/);
  assert.equal(completion.jobId, 'relay-job-plan');
  assert.equal(observed.some((event) => event.kind === 'tool_activity'), true);
  assert.equal(observed.some((event) => event.kind === 'agent_message'), true);
});

test('planning API creates proposed calendar work and one Task Session per task', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-plan-'));
  const store = new HermesStore({ dataDir, clock });
  const service = new AgentOperationsService({
    store,
    clock,
    planCompletion: async ({ onEvent }) => {
      await onEvent({ kind: 'tool_activity', text: '공식 출처 검색', metadata: { tool: 'web' } });
      return { text: JSON.stringify(createValidPlan()), jobId: 'relay-plan-ok', events: [] };
    },
  });
  const mission = service.createMission({ templateId: 'weekly-opportunity-brief' });
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: store,
    agentOperationsService: service,
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/agent-operations/missions/${mission.id}/plan`, {
      method: 'POST',
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.equal(body.tasks.length, 3);
    assert.equal(body.tasks.every((task) => task.status === 'proposed'), true);
    assert.equal(body.tasks.every((task) => task.sessionId), true);
    assert.equal(body.sessions.length, 3);
    assert.equal(store.getState().tasks.filter((task) => task.origin === 'agent').length, 3);
    assert.equal(store.getState().agentSessions.filter((session) => session.type === 'task').length, 3);
    assert.equal(store.getState().agentSessions.some((session) => session.type === 'mission-thread'), true);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('planning API rejects invalid JSON without creating Agent Tasks', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-plan-invalid-'));
  const store = new HermesStore({ dataDir, clock });
  const service = new AgentOperationsService({
    store,
    clock,
    planCompletion: async () => ({ text: 'not-json', jobId: 'relay-plan-invalid', events: [] }),
  });
  const mission = service.createMission({ templateId: 'weekly-opportunity-brief' });
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: store,
    agentOperationsService: service,
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/agent-operations/missions/${mission.id}/plan`, {
      method: 'POST',
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 422);
    assert.equal(body.error, 'plan_invalid');
    assert.equal(store.getState().tasks.filter((task) => task.origin === 'agent').length, 0);
    const missionThread = store.getState().agentSessions.find((session) => session.type === 'mission-thread');
    assert.equal(store.getAgentSession(missionThread.id).events.at(-1).kind, 'error');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('scheduler executes a due task once and records ordered session evidence', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-scheduler-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-scheduler', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-scheduler',
    title: '경쟁사 변화 수집',
    owner: 'Agent',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    createdByAgentId: 'bizconsultant',
    reason: '가격 변화 근거가 부족하다.',
    expectedOutput: '공식 출처 비교표',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    dueAt: '2026-07-13T10:00:00.000Z',
    estimatedMinutes: 40,
    actionClass: 'research',
    sourceRefs: ['web', 'wiki'],
  });
  const session = store.createAgentSession({
    id: 'session-scheduler',
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    status: 'scheduled',
  });
  store.appendAgentSessionEvent(session.id, { kind: 'plan', text: '공식 출처 확인' });
  let completionCalls = 0;
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async ({ onEvent }) => {
      completionCalls += 1;
      await onEvent({ kind: 'tool_activity', text: '공식 가격 페이지 조회' });
      return { text: '공식 가격 페이지를 비교한 결과 기회 A가 확인됐다.', jobId: 'relay-task' };
    },
  });

  // When
  const first = await scheduler.tick();
  const second = await scheduler.tick();

  // Then
  assert.deepEqual(first.startedTaskIds, [task.id]);
  assert.deepEqual(first.completedTaskIds, [task.id]);
  assert.deepEqual(second.startedTaskIds, []);
  assert.equal(completionCalls, 1);
  assert.equal(store.getState().tasks.find((item) => item.id === task.id).status, 'completed');
  assert.deepEqual(
    store.getAgentSession(session.id).events.map((event) => event.kind),
    ['plan', 'progress', 'tool_activity', 'agent_message', 'artifact', 'completion'],
  );

  await rm(dataDir, { recursive: true, force: true });
});

test('scheduler marks due work blocked while the Mac mini Relay is unavailable', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-blocked-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-blocked', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-blocked',
    title: '기회 근거 확인',
    owner: 'Agent',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    dueAt: '2026-07-13T10:00:00.000Z',
    estimatedMinutes: 20,
    actionClass: 'research',
    sourceRefs: ['web'],
  });
  const session = store.createAgentSession({
    id: 'session-blocked',
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    status: 'scheduled',
  });
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async () => {
      const error = new Error('Mac mini Hermes Relay is offline');
      error.code = 'runtime_unavailable';
      throw error;
    },
  });

  // When
  const result = await scheduler.tick();

  // Then
  assert.deepEqual(result.blockedTaskIds, [task.id]);
  assert.equal(store.getState().tasks.find((item) => item.id === task.id).status, 'blocked');
  assert.equal(store.getAgentSession(session.id).events.at(-1).kind, 'error');
  assert.match(store.getAgentSession(session.id).events.at(-1).text, /offline/i);

  await rm(dataDir, { recursive: true, force: true });
});

test('scheduler creates an evidence-backed report from a due report task', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-report-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-report', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-report',
    title: '주간 기회 보고',
    owner: 'Agent',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    dueAt: '2026-07-13T10:00:00.000Z',
    estimatedMinutes: 30,
    actionClass: 'report',
    sourceRefs: ['mission', 'prior_reports'],
  });
  const session = store.createAgentSession({
    id: 'session-report',
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    status: 'scheduled',
  });
  const reportPayload = {
    title: '주간 기회 보고',
    findings: ['기회 A'],
    evidence: [{ label: '공식 가격', url: 'https://example.com/pricing' }],
    limitations: ['사용자 인터뷰 전'],
    budget: { usedRuns: 3, usedMinutes: 90 },
    followUps: [{ title: '사용자 인터뷰', reason: '수요 검증' }],
  };
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async () => ({
      text: JSON.stringify(reportPayload),
      jobId: 'relay-report',
    }),
  });

  // When
  const result = await scheduler.tick();

  // Then
  assert.equal(result.createdReportIds.length, 1);
  assert.equal(store.getAgentReports()[0].findings[0], '기회 A');
  assert.equal(store.getAgentReports()[0].sessionId, session.id);
  assert.equal(store.getState().tasks.find((item) => item.id === task.id).reportId, result.createdReportIds[0]);

  await rm(dataDir, { recursive: true, force: true });
});

test('manual tick API uses the injected Agent Operations scheduler', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-tick-api-'));
  const store = new HermesStore({ dataDir, clock });
  let tickCalls = 0;
  const scheduler = {
    tick: async () => {
      tickCalls += 1;
      return {
        checkedAt: FIXED_NOW,
        startedTaskIds: [],
        completedTaskIds: [],
        blockedTaskIds: [],
        failedTaskIds: [],
        createdReportIds: [],
      };
    },
  };
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: store,
    agentOperationsScheduler: scheduler,
    agentOperationsClock: clock,
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/agent-operations/tick`, { method: 'POST' });
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.equal(body.tick.checkedAt, FIXED_NOW);
    assert.equal(tickCalls, 1);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Task Session messages persist with truthful next-checkpoint semantics', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-session-message-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-message', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-message',
    title: '기회 조사',
    owner: 'Agent',
    status: 'running',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: FIXED_NOW,
  });
  const session = store.createAgentSession({
    id: 'session-message',
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    status: 'running',
  });
  const service = new AgentOperationsService({ store, clock });

  // When
  const result = await service.addSessionMessage(session.id, {
    text: '가격 근거를 먼저 확인해줘',
  });
  const restarted = new HermesStore({ dataDir, clock });
  const restored = restarted.getAgentSession(session.id);

  // Then
  assert.equal(result.applicationMode, 'next_checkpoint');
  assert.equal(restored.events.at(-1).kind, 'user_message');
  assert.equal(restored.events.at(-1).metadata.applicationMode, 'next_checkpoint');
  assert.deepEqual(restored.pendingInstructions, ['가격 근거를 먼저 확인해줘']);

  await rm(dataDir, { recursive: true, force: true });
});

test('running pause requests and failed retries keep the existing Task Session', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-session-actions-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-actions', clock }),
    status: 'active',
  });
  const runningTask = store.createTask({
    id: 'task-running-action',
    title: '실행 중 조사',
    owner: 'Agent',
    status: 'running',
    missionId: mission.id,
    origin: 'agent',
  });
  const runningSession = store.createAgentSession({
    id: 'session-running-action',
    missionId: mission.id,
    taskId: runningTask.id,
    type: 'task',
    status: 'running',
  });
  const failedTask = store.createTask({
    id: 'task-failed-action',
    title: '실패한 조사',
    owner: 'Agent',
    status: 'failed',
    missionId: mission.id,
    origin: 'agent',
    attempt: 1,
  });
  const failedSession = store.createAgentSession({
    id: 'session-failed-action',
    missionId: mission.id,
    taskId: failedTask.id,
    type: 'task',
    status: 'failed',
  });
  const service = new AgentOperationsService({ store, clock });

  // When
  const pauseRequested = service.transitionTask(runningTask.id, 'pause');
  const retried = service.transitionTask(failedTask.id, 'retry');

  // Then
  assert.equal(pauseRequested.status, 'running');
  assert.equal(pauseRequested.pauseMode, 'next_checkpoint');
  assert.equal(pauseRequested.pauseRequestedAt, FIXED_NOW);
  assert.equal(retried.status, 'scheduled');
  assert.equal(retried.sessionId, failedSession.id);
  assert.equal(retried.attempt, 2);
  assert.equal(store.getAgentSession(runningSession.id).events.at(-1).kind, 'approval_response');

  await rm(dataDir, { recursive: true, force: true });
});

test('scheduler applies a running pause request before persisting completion', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-session-checkpoint-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-checkpoint', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-checkpoint',
    title: '중단 가능한 조사',
    owner: 'Agent',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    dueAt: '2026-07-13T10:00:00.000Z',
    estimatedMinutes: 20,
    actionClass: 'research',
    sourceRefs: ['web'],
  });
  const session = store.createAgentSession({
    id: 'session-checkpoint',
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    status: 'scheduled',
  });
  let releaseCompletion;
  const completionReady = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  let markStarted;
  const executionStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async () => {
      markStarted();
      await completionReady;
      return { text: '중단 요청 전까지 확보한 조사 결과', jobId: 'relay-checkpoint' };
    },
  });
  const service = new AgentOperationsService({ store, clock });

  // When
  const tickPromise = scheduler.tick();
  await executionStarted;
  service.transitionTask(task.id, 'pause');
  releaseCompletion();
  const result = await tickPromise;

  // Then
  const updated = store.getState().tasks.find((item) => item.id === task.id);
  const events = store.getAgentSession(session.id).events;
  assert.equal(updated.status, 'blocked');
  assert.deepEqual(result.completedTaskIds, []);
  assert.deepEqual(result.blockedTaskIds, [task.id]);
  assert.equal(events.some((event) => event.kind === 'completion'), false);
  assert.equal(events.some((event) => event.kind === 'artifact'), true);
  assert.match(events.at(-1).text, /checkpoint|체크포인트/i);

  await rm(dataDir, { recursive: true, force: true });
});

test('Telegram sends only a minimized Agent Report summary', async () => {
  // Given
  const {
    formatAgentReportTelegram,
    sendTelegramMessage,
  } = require('../app/lib/connectors/telegram');
  const calls = [];
  const report = {
    id: 'report-telegram',
    title: '주간 기회 보고',
    findings: ['기회 A', '기회 B', '기회 C', '기회 D'],
    evidence: ['/Users/koyunseo/private.md', 'Bearer secret'],
    limitations: ['가격 검증 필요', '사용자 인터뷰 필요'],
  };

  // When
  const text = formatAgentReportTelegram(report, {
    appUrl: 'agent-calendar://reports/report-telegram',
  });
  const result = await sendTelegramMessage({
    botToken: 'bot-token',
    chatId: '1234',
    text,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  // Then
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.chat_id, '1234');
  assert.match(sent.text, /주간 기회 보고/);
  assert.match(sent.text, /기회 C/);
  assert.doesNotMatch(sent.text, /기회 D|\/Users\/|Bearer|secret/);
  assert.equal(result.message_id, 99);
});

test('Telegram delivery failure never turns a completed Agent Report into failure', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-report-telegram-failure-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-telegram-failure', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-telegram-failure',
    title: '주간 기회 보고',
    owner: 'Agent',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    dueAt: '2026-07-13T10:00:00.000Z',
    estimatedMinutes: 30,
    actionClass: 'report',
    sourceRefs: ['mission'],
  });
  const session = store.createAgentSession({
    id: 'session-telegram-failure',
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    status: 'scheduled',
  });
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async () => ({
      text: JSON.stringify({
        title: '주간 기회 보고',
        findings: ['기회 A'],
        evidence: ['source-a'],
        limitations: [],
        budget: { usedRuns: 1, usedMinutes: 30 },
        followUps: [],
      }),
      jobId: 'relay-telegram-failure',
    }),
    sendTelegram: async () => {
      const error = new Error('Telegram HTTP 500');
      error.code = 'telegram_delivery_failed';
      throw error;
    },
  });

  // When
  await scheduler.tick();

  // Then
  const updatedTask = store.getState().tasks.find((item) => item.id === task.id);
  const report = store.getAgentReports()[0];
  const events = store.getAgentSession(session.id).events;
  assert.equal(updatedTask.status, 'completed');
  assert.equal(report.status, 'ready');
  assert.equal(report.deliveryStatus, 'failed');
  assert.equal(events.at(-1).kind, 'error');
  assert.match(events.at(-1).text, /Telegram HTTP 500/);

  await rm(dataDir, { recursive: true, force: true });
});
