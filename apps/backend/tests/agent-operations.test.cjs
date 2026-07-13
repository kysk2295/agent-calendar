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
      followUps: [],
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
    const state = await stateResponse.json();
    const sessionDetail = await sessionResponse.json();
    const action = await actionResponse.json();
    const feedback = await feedbackResponse.json();

    // Then
    assert.equal(stateResponse.status, 200);
    assert.equal(state.missions.length, 1);
    assert.equal(state.tasks.length, 1);
    assert.equal(sessionDetail.session.events[0].kind, 'plan');
    assert.equal(action.task.status, 'scheduled');
    assert.equal(feedback.report.useful, true);
    assert.equal(store.getAgentReports()[0].feedback.note, '의사결정에 사용함');
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
