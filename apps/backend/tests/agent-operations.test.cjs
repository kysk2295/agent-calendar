const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');

const {
  buildMissionPlanPrompt,
  createWeeklyOpportunityMission,
  parseMissionPlan,
  sanitizeAgentReport,
  sanitizeSessionEvent,
  transitionAgentTask,
  validateReport,
} = require('../app/lib/agent-operations-domain');
const { HermesStore } = require('../app/lib/store');
const { PostgresHermesStore } = require('../app/lib/postgres-store');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { AgentOperationsService } = require('../app/lib/agent-operations-service');
const { taskExecutionMessages } = require('../app/lib/agent-operations-execution');
const { COMMAND_ROUTES } = require('../app/lib/commands');
const { listMissionTemplates } = require('../app/lib/missions');
const { buildMissionRunPayload } = require('../app/lib/missions');
const { OFFICIAL_PROFILE_NAMES } = require('../app/lib/official-profiles');
const { buildAgentProfileSetup } = require('../app/lib/agent-profile-setup');
const { buildWorkboardRunPayload, buildWorkboardTaskDraft } = require('../app/lib/workboard');

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

test('report execution receives prior mission evidence and an explicit JSON contract', () => {
  // Given
  const mission = createWeeklyOpportunityMission({ id: 'mission-weekly', clock });
  const reportTask = createValidPlan().tasks.find((task) => task.actionClass === 'report');
  const session = { events: [] };
  const priorMissionEvidence = [{
    taskTitle: '경쟁사 변화 수집',
    kind: 'agent_message',
    text: '공식 가격 페이지에서 두 경쟁사의 팀 요금 인상을 확인했다.',
  }];

  // When
  const messages = taskExecutionMessages(mission, reportTask, session, priorMissionEvidence);
  const systemContract = JSON.parse(messages[0].content);
  const userContract = JSON.parse(messages[1].content);

  // Then
  assert.equal(systemContract.instruction.includes('Return JSON only'), true);
  assert.deepEqual(Object.keys(systemContract.reportSchema), [
    'title',
    'findings',
    'evidence',
    'limitations',
    'followUps',
    'budget',
  ]);
  assert.deepEqual(userContract.priorMissionEvidence, priorMissionEvidence);
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

test('redacts profile direct output before it reaches chat or task persistence', () => {
  // Given
  const { runOutput } = require('../app/lib/relay-profile-completion');

  // When
  const output = runOutput({
    output: 'token=topsecret /Users/koyunseo/private.md',
  });

  // Then
  assert.doesNotMatch(output, /topsecret|\/Users\/koyunseo/);
  assert.match(output, /redacted|private-path/i);
});

test('sanitizes report content and rejects local evidence URLs before persistence', () => {
  // Given
  const report = {
    title: 'token=topsecret Weekly report',
    findings: ['/Users/koyunseo/private.md contains an opportunity'],
    evidence: [{ label: 'secret=hidden file', url: 'file:///Users/koyunseo/private.md' }],
    limitations: ['Bearer abc123'],
    followUps: [{ title: 'Verify', reason: 'password=hunter2' }],
    budget: { usedRuns: 1, usedMinutes: 30 },
  };

  // When
  const sanitized = sanitizeAgentReport(report);

  // Then
  assert.doesNotMatch(JSON.stringify(sanitized), /topsecret|\/Users\/koyunseo|abc123|hunter2|hidden/);
  assert.equal(sanitized.evidence[0].url, '');
});

test('session repair migration matches the mission and chooses one deterministic session', async () => {
  // Given
  const migrationPath = path.join(__dirname, '../app/db/migrations/0007_restore_agent_task_sessions.sql');

  // When
  const sql = await readFile(migrationPath, 'utf8');

  // Then
  assert.match(sql, /session\.mission_id\s*=\s*task\.mission_id/i);
  assert.match(sql, /row_number\(\)\s+over/i);
  assert.match(sql, /session_rank\s*=\s*1/i);
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
  assert.throws(
    () => validateReport({ ...report, evidence: [{ label: '', url: '' }] }),
    /usable evidence/i,
  );
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

test('keeps the newest task session link when Postgres upserts finish out of order', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-postgres-order-'));
  const persistedTasks = new Map();
  const pool = {
    query: async (sql, values = []) => {
      if (/insert into tasks/i.test(String(sql))) {
        const payload = JSON.parse(values[7]);
        await new Promise((resolve) => setTimeout(resolve, payload.sessionId ? 1 : 30));
        persistedTasks.set(payload.id, payload);
      }
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
    createWeeklyOpportunityMission({ id: 'mission-postgres-order', clock }),
  );
  const task = store.createTask({
    id: 'task-postgres-order',
    title: '세션 링크 순서 검증',
    owner: 'Agent',
    status: 'proposed',
    missionId: mission.id,
    origin: 'agent',
    createdByAgentId: 'bizconsultant',
  });

  // When
  const session = store.createAgentSession({
    id: 'session-postgres-order',
    missionId: mission.id,
    taskId: task.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Then
  assert.equal(persistedTasks.get(task.id).sessionId, session.id);

  await rm(dataDir, { recursive: true, force: true });
});

test('Postgres allows only one process to claim a scheduled Agent Task', async () => {
  // Given
  let databaseStatus = 'scheduled';
  let taskUpserts = 0;
  let markUpsertsReady;
  const upsertsReady = new Promise((resolve) => { markUpsertsReady = resolve; });
  const pool = {
    query: async (sql, values = []) => {
      const statement = String(sql);
      if (/insert into tasks/i.test(statement)) {
        databaseStatus = String(values[2]);
        taskUpserts += 1;
        if (taskUpserts === 2) markUpsertsReady();
        return { rows: [] };
      }
      if (/update tasks[\s\S]*where id = \$1 and status = 'scheduled'/i.test(statement)) {
        if (databaseStatus !== 'scheduled') return { rows: [] };
        databaseStatus = String(values[1]);
        return { rows: [{ id: values[0] }] };
      }
      return { rows: [] };
    },
  };
  const firstDir = await mkdtemp(path.join(os.tmpdir(), 'agent-claim-first-'));
  const secondDir = await mkdtemp(path.join(os.tmpdir(), 'agent-claim-second-'));
  const first = new PostgresHermesStore({ pool, dataDir: firstDir, clock, autoMigrate: false });
  const second = new PostgresHermesStore({ pool, dataDir: secondDir, clock, autoMigrate: false });
  await Promise.all([first.ready, second.ready]);
  const taskInput = {
    id: 'task-atomic-claim',
    title: '원자적 선점',
    status: 'scheduled',
    origin: 'agent',
  };
  first.createTask(taskInput);
  second.createTask(taskInput);
  await upsertsReady;

  // When
  const claims = await Promise.all([
    first.claimAgentTask(taskInput.id, { startedAt: FIXED_NOW, attempt: 1 }),
    second.claimAgentTask(taskInput.id, { startedAt: FIXED_NOW, attempt: 1 }),
  ]);

  // Then
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(databaseStatus, 'running');

  await Promise.all([
    rm(firstDir, { recursive: true, force: true }),
    rm(secondDir, { recursive: true, force: true }),
  ]);
});

test('serializes a task delete after an in-flight Postgres upsert', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-postgres-delete-'));
  const persistedTasks = new Map();
  const pool = {
    query: async (sql, values = []) => {
      if (/insert into tasks/i.test(String(sql))) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        persistedTasks.set(values[0], JSON.parse(values[7]));
      }
      if (/delete from tasks/i.test(String(sql))) persistedTasks.delete(values[0]);
      return { rows: [] };
    },
  };
  const store = new PostgresHermesStore({ pool, dataDir, clock, autoMigrate: false });
  await store.ready;
  const task = store.createTask({ id: 'task-delete-order', title: '삭제 순서', status: 'proposed' });

  // When
  store.deleteTask(task.id);
  await new Promise((resolve) => setTimeout(resolve, 70));

  // Then
  assert.equal(persistedTasks.has(task.id), false);

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
    const activateResponse = await fetch(`${baseUrl}/api/agent-operations/missions/${created.mission.id}/activate`, { method: 'POST' });
    const pauseResponse = await fetch(`${baseUrl}/api/agent-operations/missions/${created.mission.id}/pause`, { method: 'POST' });
    const resumeMissionResponse = await fetch(`${baseUrl}/api/agent-operations/missions/${created.mission.id}/activate`, { method: 'POST' });
    const cancelMissionResponse = await fetch(`${baseUrl}/api/agent-operations/missions/${created.mission.id}/cancel`, { method: 'POST' });
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
    const rejectFollowUpResponse = await fetch(`${baseUrl}/api/agent-operations/reports/${report.id}/follow-ups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0, decision: 'rejected' }),
    });
    const state = await stateResponse.json();
    const sessionDetail = await sessionResponse.json();
    const action = await actionResponse.json();
    const activated = await activateResponse.json();
    const paused = await pauseResponse.json();
    const resumedMission = await resumeMissionResponse.json();
    const cancelledMission = await cancelMissionResponse.json();
    const feedback = await feedbackResponse.json();
    const followUp = await followUpResponse.json();
    const rejectedFollowUp = await rejectFollowUpResponse.json();

    // Then
    assert.equal(stateResponse.status, 200);
    assert.equal(state.missions.length, 1);
    assert.equal(state.tasks.length, 1);
    assert.equal(sessionDetail.session.events[0].kind, 'plan');
    assert.equal(action.task.status, 'scheduled');
    assert.equal(activated.mission.status, 'active');
    assert.equal(paused.mission.status, 'paused');
    assert.equal(resumedMission.mission.status, 'active');
    assert.equal(cancelledMission.mission.status, 'cancelled');
    assert.equal(store.getState().tasks.find((item) => item.id === task.id).status, 'cancelled');
    assert.equal(feedback.report.useful, true);
    assert.equal(store.getAgentReports()[0].feedback.note, '의사결정에 사용함');
    assert.equal(followUpResponse.status, 200);
    assert.equal(followUp.report.followUpDecisions[0].decision, 'approved');
    assert.equal(rejectedFollowUp.report.followUpDecisions[0].decision, 'rejected');
    assert.equal(store.getAgentSession(session.id).events.at(-1).kind, 'approval_response');
    assert.match(store.getAgentSession(session.id).events.at(-1).text, /후속 제안 거절/);
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

test('Agent Operations profile work has a dedicated six minute timeout', () => {
  const { agentOperationsProfileTimeout } = require('../app/lib/relay-profile-completion');

  assert.equal(agentOperationsProfileTimeout({}), 360_000);
  assert.equal(agentOperationsProfileTimeout({ AGENT_OPERATIONS_PROFILE_TIMEOUT_MS: '420000' }), 420_000);
  assert.equal(agentOperationsProfileTimeout({ AGENT_OPERATIONS_PROFILE_TIMEOUT_MS: 'invalid' }), 360_000);
});

test('profile timeout forwards an explicit model and requests remote run cancellation', async () => {
  // Given
  const { runRelayProfileCompletion } = require('../app/lib/relay-profile-completion');
  let nowMs = 0;
  const jobs = [];
  const relay = {
    isBridgeOnline: () => true,
    enqueue: (input) => {
      const job = { ...input, id: `job-${jobs.length + 1}` };
      jobs.push(job);
      return job;
    },
    waitForEvents: async (jobId) => {
      if (jobId === 'job-1') {
        return {
          cursor: 1,
          complete: true,
          events: [{ event: 'bridge-complete', data: { body: { run: { id: 'run-long', status: 'running', model: 'gpt-explicit', logs: [] } } } }],
        };
      }
      return {
        cursor: 1,
        complete: true,
        events: [{ event: 'bridge-complete', data: { body: { run: { id: 'run-long', status: 'stopped' } } } }],
      };
    },
    snapshot: () => ({ state: { runs: [{ id: 'run-long', status: 'running', model: 'gpt-explicit', logs: [] }] } }),
    fail: () => {},
  };

  // When
  await assert.rejects(
    runRelayProfileCompletion({
      relay,
      env: { HERMES_RELAY_TOKEN: 'relay-token' },
      payload: { profile: 'bizconsultant', model: 'gpt-explicit', messages: [{ role: 'user', content: 'bounded task' }] },
      timeoutMs: 1_000,
      pollIntervalMs: 1_000,
      now: () => nowMs,
      sleep: async (duration) => { nowMs += duration; },
    }),
    (error) => error.code === 'relay_timeout' && error.runId === 'run-long',
  );

  // Then
  const launchBody = JSON.parse(jobs[0].payload.body);
  assert.equal(launchBody.model, 'gpt-explicit');
  assert.equal(launchBody.timeoutMs, 1_000);
  assert.deepEqual(launchBody.toolsets, ['safe']);
  assert.equal(launchBody.yolo, false);
  assert.match(launchBody.deadlineAt, /^1970-01-01T00:00:01\.000Z$/);
  assert.equal(jobs[1].payload.path, '/api/runs/run-long/stop');
});

test('profile timeout blocks retries when remote cancellation is not confirmed', async () => {
  // Given
  const { runRelayProfileCompletion } = require('../app/lib/relay-profile-completion');
  let nowMs = 0;
  const jobs = [];
  const relay = {
    isBridgeOnline: () => true,
    enqueue: (input) => {
      const job = { ...input, id: `job-rejected-${jobs.length + 1}` };
      jobs.push(job);
      return job;
    },
    waitForEvents: async (jobId) => (jobId === 'job-rejected-1'
      ? {
        cursor: 1,
        complete: true,
        events: [{ event: 'bridge-complete', data: { body: { run: { id: 'run-unresolved', status: 'running', logs: [] } } } }],
      }
      : {
        cursor: 1,
        complete: true,
        events: [{ event: 'bridge-complete', data: { ok: false, status: 409, error: 'stop rejected' } }],
      }),
    snapshot: () => ({ state: { runs: [{ id: 'run-unresolved', status: 'running', logs: [] }] } }),
    fail: () => {},
  };

  // When / Then
  await assert.rejects(
    runRelayProfileCompletion({
      relay,
      env: { HERMES_RELAY_TOKEN: 'relay-token' },
      payload: { profile: 'bizconsultant', messages: [{ role: 'user', content: 'bounded task' }] },
      meta: { idempotencyKey: 'task-idempotent' },
      timeoutMs: 1_000,
      pollIntervalMs: 1_000,
      now: () => nowMs,
      sleep: async (duration) => { nowMs += duration; },
    }),
    (error) => error.code === 'relay_cancel_unconfirmed' && error.runId === 'run-unresolved',
  );
  assert.equal(JSON.parse(jobs[0].payload.body).idempotencyKey, 'task-idempotent');
});

test('profile launch timeout recovers the remote run by idempotency key before cancellation', async () => {
  // Given
  const { runRelayProfileCompletion } = require('../app/lib/relay-profile-completion');
  const jobs = [];
  const relay = {
    isBridgeOnline: () => true,
    enqueue: (input) => {
      const job = { ...input, id: `job-launch-timeout-${jobs.length + 1}` };
      jobs.push(job);
      return job;
    },
    waitForEvents: async (jobId) => (jobId === 'job-launch-timeout-1'
      ? { cursor: 0, complete: true, events: [] }
      : {
        cursor: 1,
        complete: true,
        events: [{ event: 'bridge-complete', data: { ok: false, status: 409, error: 'stop rejected' } }],
      }),
    snapshot: () => ({
      state: {
        runs: [{
          id: 'run-lost-launch-response',
          status: 'running',
          idempotencyKey: 'task-launch-timeout',
          logs: [],
        }],
      },
    }),
    fail: () => {},
  };

  // When / Then
  await assert.rejects(
    runRelayProfileCompletion({
      relay,
      env: { HERMES_RELAY_TOKEN: 'relay-token' },
      payload: { profile: 'bizconsultant', messages: [{ role: 'user', content: 'bounded task' }] },
      meta: { idempotencyKey: 'task-launch-timeout' },
      timeoutMs: 1_000,
    }),
    (error) => (
      error.code === 'relay_cancel_unconfirmed'
      && error.runId === 'run-lost-launch-response'
    ),
  );
  assert.equal(jobs[1].payload.path, '/api/runs/run-lost-launch-response/stop');
});

test('profile launch timeout returns a completed run recovered by idempotency key', async () => {
  // Given
  const { runRelayProfileCompletion } = require('../app/lib/relay-profile-completion');
  const jobs = [];
  const relay = {
    isBridgeOnline: () => true,
    enqueue: (input) => {
      const job = { ...input, id: `job-completed-recovery-${jobs.length + 1}` };
      jobs.push(job);
      return job;
    },
    waitForEvents: async () => ({ cursor: 0, complete: true, events: [] }),
    snapshot: () => ({
      state: {
        runs: [{
          id: 'run-completed-recovery',
          status: 'completed',
          model: 'Codex',
          idempotencyKey: 'task-completed-recovery',
          logs: ['stdout: recovered completion'],
        }],
      },
    }),
    fail: () => {},
  };

  // When
  const completion = await runRelayProfileCompletion({
    relay,
    env: { HERMES_RELAY_TOKEN: 'relay-token' },
    payload: { profile: 'bizconsultant', messages: [{ role: 'user', content: 'bounded task' }] },
    meta: { idempotencyKey: 'task-completed-recovery' },
    timeoutMs: 1_000,
  });

  // Then
  assert.equal(completion.text, 'recovered completion');
  assert.equal(completion.runId, 'run-completed-recovery');
  assert.equal(jobs.length, 1);
});

test('profile timeout waits for a stopping run to become terminal', async () => {
  // Given
  const { runRelayProfileCompletion } = require('../app/lib/relay-profile-completion');
  let nowMs = 0;
  let stopRequested = false;
  let stopSnapshots = 0;
  const jobs = [];
  const relay = {
    isBridgeOnline: () => true,
    enqueue: (input) => {
      const job = { ...input, id: `job-stopping-${jobs.length + 1}` };
      jobs.push(job);
      if (input.payload.path.includes('/stop')) stopRequested = true;
      return job;
    },
    waitForEvents: async (jobId) => (jobId === 'job-stopping-1'
      ? {
        cursor: 1,
        complete: true,
        events: [{ event: 'bridge-complete', data: { body: { run: { id: 'run-stopping', status: 'running', logs: [] } } } }],
      }
      : {
        cursor: 1,
        complete: true,
        events: [{ event: 'bridge-complete', data: { body: { run: { id: 'run-stopping', status: 'stopping' } } } }],
      }),
    snapshot: () => {
      if (!stopRequested) return { state: { runs: [{ id: 'run-stopping', status: 'running', logs: [] }] } };
      stopSnapshots += 1;
      return {
        state: {
          runs: [{ id: 'run-stopping', status: stopSnapshots >= 2 ? 'stopped' : 'stopping', logs: [] }],
        },
      };
    },
    fail: () => {},
  };

  // When / Then
  await assert.rejects(
    runRelayProfileCompletion({
      relay,
      env: { HERMES_RELAY_TOKEN: 'relay-token' },
      payload: { profile: 'bizconsultant', messages: [{ role: 'user', content: 'bounded task' }] },
      meta: { idempotencyKey: 'task-stopping' },
      timeoutMs: 1_000,
      pollIntervalMs: 1_000,
      now: () => nowMs,
      sleep: async (duration) => { nowMs += duration; },
    }),
    (error) => error.code === 'relay_timeout' && error.runId === 'run-stopping',
  );
  assert.equal(stopSnapshots >= 2, true);
});

test('built-in command and mission routes only reference live official profiles', () => {
  // Given / When
  const referenced = [
    ...COMMAND_ROUTES.map((route) => route.agent),
    ...listMissionTemplates().map((template) => template.agent),
  ];

  // Then
  assert.equal(referenced.every((profile) => OFFICIAL_PROFILE_NAMES.includes(profile)), true);
  assert.equal(referenced.includes('marketflow'), false);
});

test('mission launch preserves the safe toolset deadline and approval boundary', () => {
  // Given
  const deadlineAt = '2026-07-13T09:06:00.000Z';

  // When
  const run = buildMissionRunPayload({
    templateId: 'product-build',
    goal: 'Read-only opportunity research',
    agentId: 'bizconsultant',
    toolsets: ['safe'],
    yolo: false,
    timeoutMs: 360_000,
    deadlineAt,
    idempotencyKey: 'task-mission-launch',
  });

  // Then
  assert.deepEqual(run.toolsets, ['safe']);
  assert.equal(run.yolo, false);
  assert.equal(run.noApproval, false);
  assert.equal(run.timeoutMs, 360_000);
  assert.equal(run.deadlineAt, deadlineAt);
  assert.equal(run.idempotencyKey, 'task-mission-launch');

  const defaultRun = buildMissionRunPayload({
    templateId: 'product-build',
    goal: 'Default mission safety',
    agentId: 'bizconsultant',
  });
  assert.deepEqual(defaultRun.toolsets, ['safe']);
  assert.equal(defaultRun.yolo, false);
  assert.equal(defaultRun.noApproval, false);

  const hostileRun = buildMissionRunPayload({
    templateId: 'product-build',
    goal: 'Attempt unsafe mission defaults',
    agentId: 'marketflow',
    toolsets: ['all'],
    yolo: true,
    noApproval: true,
  });
  assert.equal(OFFICIAL_PROFILE_NAMES.includes(hostileRun.agent), true);
  assert.notEqual(hostileRun.agent, 'marketflow');
  assert.deepEqual(hostileRun.toolsets, ['safe']);
  assert.equal(hostileRun.yolo, false);
  assert.equal(hostileRun.noApproval, false);
});

test('Hermes profile command templates never bypass runtime approvals', async () => {
  // Given
  const files = [
    '../app/lib/agent-registry.js',
    '../app/lib/hermes-cli-profiles.js',
    '../app/railway-gateway-server.js',
  ];

  // When
  const sources = await Promise.all(files.map((file) => readFile(path.join(__dirname, file), 'utf8')));

  // Then
  assert.equal(sources.every((source) => !source.includes('--yolo')), true);
});

test('legacy run payloads use official profiles and require approval', async () => {
  // Given
  const draft = buildWorkboardTaskDraft({
    title: 'Publish weekly content',
    content: 'Share the final draft after review',
    selectedDate: '2026-07-13',
  });

  // When
  const run = buildWorkboardRunPayload(draft);
  const setup = buildAgentProfileSetup('marketflow');
  const safetyFiles = [
    '../app/lib/workboard.js',
    '../app/lib/scheduler.js',
    '../app/lib/connectors/telegram.js',
    '../app/lib/calendar-work.js',
    '../app/lib/agent-profile-setup.js',
    '../app/lib/commands.js',
    '../app/lib/missions.js',
    '../app/railway-gateway-server.js',
  ];
  const safetySources = await Promise.all(
    safetyFiles.map((file) => readFile(path.join(__dirname, file), 'utf8')),
  );

  // Then
  assert.equal(OFFICIAL_PROFILE_NAMES.includes(draft.agent), true);
  assert.equal(draft.agent, 'default');
  assert.equal(run.noApproval, false);
  assert.doesNotMatch(run.goal, /without asking for human approval/i);
  assert.equal(setup.profile, 'default');
  assert.equal(safetySources.every((source) => !source.includes('noApproval: true')), true);
  assert.equal(safetySources.every((source) => !source.includes('marketflow')), true);
});

test('run persistence defaults to manual approval', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-run-approval-default-'));
  const store = new HermesStore({ dataDir, clock });

  // When
  const run = store.createRun({ goal: 'Safe persisted run', agent: 'bizconsultant' });

  // Then
  assert.equal(run.noApproval, false);

  await rm(dataDir, { recursive: true, force: true });
});

test('planning API creates proposed calendar work and one Task Session per task', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-plan-'));
  const store = new HermesStore({ dataDir, clock });
  let planningRequest = null;
  const service = new AgentOperationsService({
    store,
    clock,
    planCompletion: async ({ onEvent, payload, meta }) => {
      planningRequest = { payload, meta };
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
    assert.equal(body.tasks.every((task) => task.agent === 'bizconsultant'), true);
    assert.equal(body.tasks.every((task) => task.sessionId), true);
    assert.equal(body.sessions.length, 3);
    assert.equal(store.getState().tasks.filter((task) => task.origin === 'agent').length, 3);
    assert.equal(store.getState().agentSessions.filter((session) => session.type === 'task').length, 3);
    assert.equal(store.getState().agentSessions.some((session) => session.type === 'mission-thread'), true);
    assert.equal(planningRequest.payload.profile, 'bizconsultant');
    assert.equal(Object.hasOwn(planningRequest.payload, 'model'), false);
    assert.equal(planningRequest.meta.agentId, 'bizconsultant');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('default Agent Operations planning executes the selected Hermes CLI profile', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-profile-plan-'));
  const store = new HermesStore({ dataDir, clock });
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RELAY_TOKEN: 'relay-token',
      HERMES_RELAY_STREAM_TIMEOUT_MS: '1000',
    },
    gatewayStore: store,
    agentOperationsClock: clock,
  });
  const baseUrl = await listen(server);

  try {
    const createResponse = await fetch(`${baseUrl}/api/agent-operations/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'weekly-opportunity-brief' }),
    });
    const created = await createResponse.json();
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const planPromise = fetch(`${baseUrl}/api/agent-operations/missions/${created.mission.id}/plan`, {
      method: 'POST',
    });
    const polled = await pollPromise;
    const relayJob = polled.job;
    const runtimeBody = JSON.parse(relayJob.payload.body || '{}');

    await fetch(`${baseUrl}/api/relay/jobs/${relayJob.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        ok: true,
        status: 200,
        body: {
          ok: true,
          run: {
            id: 'run-agent-plan',
            status: 'done',
            agent: 'bizconsultant',
            logs: [`stdout: ${JSON.stringify(createValidPlan())}`],
          },
        },
      }),
    });

    const response = await planPromise;
    const body = await response.json();
    assert.equal(relayJob.kind, 'runtime.request');
    assert.equal(relayJob.payload.path, '/api/missions/launch');
    assert.equal(runtimeBody.agentId, 'bizconsultant');
    assert.match(runtimeBody.goal, /Return JSON only/);
    assert.equal(response.status, 200);
    assert.equal(body.tasks.length, 3);
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

test('planning retries one invalid budget proposal with the validation reason', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-plan-retry-'));
  const store = new HermesStore({ dataDir, clock });
  const invalidPlan = createValidPlan();
  invalidPlan.tasks[0].estimatedMinutes = 80;
  const planningRequests = [];
  const service = new AgentOperationsService({
    store,
    clock,
    planCompletion: async ({ payload, meta }) => {
      planningRequests.push({ payload, meta });
      return {
        text: JSON.stringify(planningRequests.length === 1 ? invalidPlan : createValidPlan()),
        jobId: `relay-plan-${planningRequests.length}`,
        events: [],
      };
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
    assert.equal(planningRequests.length, 2);
    assert.match(planningRequests[1].payload.messages.at(-1).content, /runtime budget/i);
    assert.match(planningRequests[1].payload.messages.at(-1).content, /120/);
    assert.notEqual(planningRequests[0].meta.idempotencyKey, planningRequests[1].meta.idempotencyKey);
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
  let executionRequest = null;
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async ({ onEvent, payload, meta }) => {
      completionCalls += 1;
      executionRequest = { payload, meta };
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
  assert.equal(executionRequest.payload.profile, 'bizconsultant');
  assert.equal(Object.hasOwn(executionRequest.payload, 'model'), false);
  assert.equal(executionRequest.meta.agentId, 'bizconsultant');
  assert.equal(store.getState().tasks.find((item) => item.id === task.id).status, 'completed');
  assert.deepEqual(
    store.getAgentSession(session.id).events.map((event) => event.kind),
    ['plan', 'progress', 'tool_activity', 'agent_message', 'artifact', 'completion'],
  );

  await rm(dataDir, { recursive: true, force: true });
});

test('scheduler serializes overlapping ticks and runs at most one due task per tick', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-overlap-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-overlap', clock }),
    status: 'active',
  });
  for (const id of ['a', 'b']) {
    const task = store.createTask({
      id: `task-overlap-${id}`,
      title: `겹침 검증 ${id}`,
      status: 'scheduled',
      missionId: mission.id,
      origin: 'agent',
      scheduledAt: '2026-07-13T08:59:00.000Z',
      estimatedMinutes: 10,
      actionClass: 'research',
      sourceRefs: ['web'],
    });
    store.createAgentSession({
      id: `session-overlap-${id}`,
      missionId: mission.id,
      taskId: task.id,
      status: 'scheduled',
    });
  }
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const executionCalls = [];
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async ({ meta }) => {
      executionCalls.push(meta.taskId);
      if (executionCalls.length === 1) {
        markStarted();
        await firstGate;
      }
      return { text: 'bounded result', jobId: `job-${meta.taskId}` };
    },
  });

  // When
  const firstTick = scheduler.tick();
  await firstStarted;
  const overlappingTick = await scheduler.tick();
  releaseFirst();
  await firstTick;
  await scheduler.tick();

  // Then
  assert.equal(overlappingTick.skipped, true);
  assert.deepEqual(executionCalls, ['task-overlap-a', 'task-overlap-b']);

  await rm(dataDir, { recursive: true, force: true });
});

test('scheduler quarantines an orphaned task before starting the next valid task', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-orphan-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-orphan', clock }),
    status: 'active',
  });
  const orphan = store.createTask({
    id: 'task-orphan-a',
    title: '세션 없는 작업',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:58:00.000Z',
    actionClass: 'research',
  });
  const valid = store.createTask({
    id: 'task-orphan-b',
    title: '정상 작업',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    actionClass: 'research',
  });
  store.createAgentSession({
    id: 'session-after-orphan',
    missionId: mission.id,
    taskId: valid.id,
    status: 'scheduled',
  });
  const executionCalls = [];
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async ({ meta }) => {
      executionCalls.push(meta.taskId);
      return { text: 'valid result', jobId: 'job-after-orphan' };
    },
  });

  // When
  const result = await scheduler.tick();

  // Then
  assert.deepEqual(result.failedTaskIds, [orphan.id]);
  assert.deepEqual(result.startedTaskIds, [valid.id]);
  assert.deepEqual(executionCalls, [valid.id]);
  assert.equal(store.getState().tasks.find((task) => task.id === orphan.id).failureCode, 'task_contract_invalid');

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

test('scheduler blocks a task when remote cancellation cannot be confirmed', async () => {
  // Given
  const { AgentOperationsScheduler } = require('../app/lib/agent-operations-scheduler');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-operations-cancel-unconfirmed-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-cancel-unconfirmed', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-cancel-unconfirmed',
    title: '원격 취소 확인',
    status: 'scheduled',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-13T08:59:00.000Z',
    actionClass: 'research',
  });
  store.createAgentSession({
    id: 'session-cancel-unconfirmed',
    missionId: mission.id,
    taskId: task.id,
    status: 'scheduled',
  });
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async () => {
      const error = new Error('Remote cancellation was not confirmed');
      error.code = 'relay_cancel_unconfirmed';
      throw error;
    },
  });

  // When
  const result = await scheduler.tick();

  // Then
  const storedTask = store.getState().tasks.find((item) => item.id === task.id);
  assert.deepEqual(result.blockedTaskIds, [task.id]);
  assert.equal(storedTask.status, 'blocked');
  assert.equal(storedTask.failureCode, 'relay_cancel_unconfirmed');

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
  const priorTask = store.createTask({
    id: 'task-prior-research',
    title: '기회 근거 수집',
    owner: 'Agent',
    status: 'completed',
    missionId: mission.id,
    origin: 'agent',
    scheduledAt: '2026-07-12T08:00:00.000Z',
    actionClass: 'research',
  });
  const priorSession = store.createAgentSession({
    id: 'session-prior-research',
    missionId: mission.id,
    taskId: priorTask.id,
    type: 'task',
    status: 'completed',
  });
  store.appendAgentSessionEvent(priorSession.id, {
    kind: 'agent_message',
    text: '공식 가격 페이지에서 기회 A의 근거를 확인했다.',
  });
  const reportPayload = {
    title: '주간 기회 보고',
    findings: ['기회 A'],
    evidence: [{ label: '공식 가격', url: 'https://example.com/pricing' }],
    limitations: ['사용자 인터뷰 전'],
    budget: { usedRuns: 3, usedMinutes: 90 },
    followUps: [{ title: '사용자 인터뷰', reason: '수요 검증' }],
  };
  let executionPayload;
  const scheduler = new AgentOperationsScheduler({
    store,
    clock,
    executeCompletion: async ({ payload }) => {
      executionPayload = payload;
      return {
        text: JSON.stringify(reportPayload),
        jobId: 'relay-report',
      };
    },
  });

  // When
  const result = await scheduler.tick();

  // Then
  assert.equal(result.createdReportIds.length, 1);
  assert.equal(store.getAgentReports()[0].findings[0], '기회 A');
  assert.equal(store.getAgentReports()[0].sessionId, session.id);
  assert.equal(store.getState().tasks.find((item) => item.id === task.id).reportId, result.createdReportIds[0]);
  assert.match(executionPayload.messages[1].content, /공식 가격 페이지에서 기회 A의 근거/);

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

test('a task with unconfirmed remote cancellation cannot resume', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-session-unconfirmed-cancel-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-unconfirmed-cancel', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-unconfirmed-cancel',
    title: '취소 확인 대기',
    status: 'blocked',
    missionId: mission.id,
    origin: 'agent',
  });
  store.updateTask(task.id, { failureCode: 'relay_cancel_unconfirmed' });
  store.createAgentSession({
    id: 'session-unconfirmed-cancel',
    missionId: mission.id,
    taskId: task.id,
    status: 'blocked',
  });
  const service = new AgentOperationsService({ store, clock });

  // When / Then
  assert.throws(
    () => service.transitionTask(task.id, 'resume'),
    (error) => error.code === 'relay_cancel_unconfirmed' && error.status === 409,
  );

  await rm(dataDir, { recursive: true, force: true });
});

test('generic task mutation cannot bypass Agent Operations cancellation state', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-task-mutation-guard-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission({
    ...createWeeklyOpportunityMission({ id: 'mission-task-mutation-guard', clock }),
    status: 'active',
  });
  const task = store.createTask({
    id: 'task-mutation-guard',
    title: '취소 확인 대기',
    status: 'blocked',
    missionId: mission.id,
    origin: 'agent',
  });
  store.updateTask(task.id, { failureCode: 'relay_cancel_unconfirmed' });
  const server = createRailwayGatewayServer({ env: {}, gatewayStore: store });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'scheduled', failureCode: '' }),
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 409);
    assert.equal(body.error, 'agent_task_action_required');
    assert.equal(store.getState().tasks.find((item) => item.id === task.id).status, 'blocked');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
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
        evidence: [{ label: '공식 출처', url: 'https://example.com/source-a' }],
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

test('Telegram delivery is marked not configured instead of remaining pending', async () => {
  // Given
  const { deliverAgentReport } = require('../app/lib/agent-report-delivery');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-report-telegram-unconfigured-'));
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission(createWeeklyOpportunityMission({ id: 'mission-no-telegram', clock }));
  const session = store.createAgentSession({ id: 'session-no-telegram', missionId: mission.id, status: 'completed' });
  const report = store.createAgentReport({
    id: 'report-no-telegram',
    missionId: mission.id,
    sessionId: session.id,
    status: 'ready',
    deliveryStatus: 'pending',
    findings: ['기회 A'],
    evidence: [{ label: '공식 출처', url: 'https://example.com' }],
    limitations: [],
    followUps: [],
    budget: { usedRuns: 1, usedMinutes: 30 },
  });

  // When
  const updated = await deliverAgentReport({ store, sessionId: session.id, report, sendTelegram: null, clock });

  // Then
  assert.equal(updated.deliveryStatus, 'not_configured');
  assert.equal(store.getAgentReports()[0].deliveryStatus, 'not_configured');

  await rm(dataDir, { recursive: true, force: true });
});

test('Agent Operations list redacts legacy report content before responding', () => {
  // Given
  const dataDir = path.join(os.tmpdir(), `agent-report-list-redaction-${process.pid}-${Date.now()}`);
  const store = new HermesStore({ dataDir, clock });
  const mission = store.createAgentMission(createWeeklyOpportunityMission({ id: 'mission-report-list', clock }));
  store.createAgentReport({
    id: 'report-list-secret',
    missionId: mission.id,
    status: 'ready',
    findings: ['token=topsecret'],
    evidence: [{ label: '/Users/koyunseo/private.md', url: 'file:///Users/koyunseo/private.md' }],
    limitations: [],
    followUps: [],
    budget: { usedRuns: 1, usedMinutes: 1 },
  });
  const service = new AgentOperationsService({ store, clock });

  // When
  const response = service.listState();

  // Then
  assert.doesNotMatch(JSON.stringify(response.reports), /topsecret|\/Users\/koyunseo/);
  assert.equal(response.reports[0].evidence[0].url, '');

  return rm(dataDir, { recursive: true, force: true });
});
