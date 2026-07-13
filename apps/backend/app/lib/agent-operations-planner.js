const crypto = require('node:crypto');

const {
  buildMissionPlanPrompt,
  parseMissionPlan,
  sanitizeSessionEvent,
} = require('./agent-operations-domain');

class AgentOperationsPlanError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AgentOperationsPlanError';
    this.code = code;
    this.status = status;
  }
}

function createPlannerId(prefix, clock) {
  const stamp = clock().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function missionThreadFor(store, mission, clock) {
  const existing = store.getState().agentSessions.find((session) => (
    session.missionId === mission.id && session.type === 'mission-thread'
  ));
  if (existing) return existing;
  return store.createAgentSession({
    id: createPlannerId('mission-thread', clock),
    missionId: mission.id,
    taskId: '',
    type: 'mission-thread',
    title: mission.title,
    status: 'planning',
  });
}

function appendPlanningError(store, sessionId, error) {
  store.appendAgentSessionEvent(sessionId, sanitizeSessionEvent({
    kind: 'error',
    text: error.message || 'Mission planning failed',
    metadata: { code: error.code || 'plan_invalid' },
  }));
}

function createPlannedTask({ store, mission, taskPlan, clock }) {
  const task = store.createTask({
    id: createPlannerId('agent-task', clock),
    title: taskPlan.title,
    owner: 'Agent',
    status: 'proposed',
    date: taskPlan.scheduledAt.slice(0, 10),
    time: taskPlan.scheduledAt.slice(11, 16),
    due: taskPlan.dueAt,
    agent: mission.agentId,
    model: 'Recommended',
    missionId: mission.id,
    origin: 'agent',
    createdByAgentId: mission.agentId,
    reason: taskPlan.reason,
    expectedOutput: taskPlan.expectedOutput,
    scheduledAt: taskPlan.scheduledAt,
    dueAt: taskPlan.dueAt,
    estimatedMinutes: taskPlan.estimatedMinutes,
    actionClass: taskPlan.actionClass,
    sourceRefs: taskPlan.sourceRefs,
    approvalMode: 'required',
  });
  const session = store.createAgentSession({
    id: createPlannerId('task-session', clock),
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    title: task.title,
    status: 'proposed',
  });
  store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
    kind: 'plan',
    text: `${taskPlan.reason}\nExpected output: ${taskPlan.expectedOutput}`,
    metadata: {
      actionClass: taskPlan.actionClass,
      scheduledAt: taskPlan.scheduledAt,
      dueAt: taskPlan.dueAt,
      estimatedMinutes: taskPlan.estimatedMinutes,
      sourceRefs: taskPlan.sourceRefs,
    },
  }));
  store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
    kind: 'approval_request',
    text: '첫 주 에이전트 작업은 실행 전에 승인이 필요합니다.',
    metadata: { action: 'approve', taskId: task.id },
  }));
  const linkedTask = store.getState().tasks.find((item) => item.id === task.id);
  return { task: linkedTask, session };
}

async function planAgentMission({ store, mission, planCompletion, clock = () => new Date() } = {}) {
  const existingTasks = store.getState().tasks.filter((task) => (
    task.missionId === mission.id && task.origin === 'agent' && task.status !== 'cancelled'
  ));
  if (existingTasks.length) {
    throw new AgentOperationsPlanError(
      'mission_already_planned',
      'This mission already has an active plan',
      409,
    );
  }
  const missionThread = missionThreadFor(store, mission, clock);
  store.appendAgentSessionEvent(missionThread.id, sanitizeSessionEvent({
    kind: 'plan',
    text: `Planning mission: ${mission.title}`,
    metadata: {
      objective: mission.objective,
      successCriteria: mission.successCriteria,
      budget: mission.policy,
    },
  }));

  let completion;
  try {
    const prompt = buildMissionPlanPrompt({
      mission,
      priorReports: store.getAgentReports().filter((report) => report.missionId === mission.id),
      userFeedback: Array.isArray(mission.userFeedback) ? mission.userFeedback : [],
    });
    completion = await planCompletion({
      payload: {
        model: mission.agentId,
        stream: true,
        messages: [
          { role: 'system', content: 'You plan bounded internal work for Agent Calendar. Return JSON only.' },
          { role: 'user', content: prompt },
        ],
      },
      meta: { missionId: mission.id, sessionId: missionThread.id },
      onEvent: async (event) => {
        store.appendAgentSessionEvent(missionThread.id, sanitizeSessionEvent(event));
      },
    });
  } catch (error) {
    appendPlanningError(store, missionThread.id, error);
    throw new AgentOperationsPlanError(
      error.code || 'runtime_unavailable',
      error.message || 'Mac mini Hermes planning failed',
      error.code === 'runtime_unavailable' ? 503 : 502,
    );
  }

  let plan;
  try {
    plan = parseMissionPlan({ mission, raw: completion?.text });
  } catch (error) {
    appendPlanningError(store, missionThread.id, error);
    throw new AgentOperationsPlanError('plan_invalid', 'Hermes returned an invalid mission plan', 422);
  }

  const created = plan.tasks.map((taskPlan) => createPlannedTask({
    store,
    mission,
    taskPlan,
    clock,
  }));
  const updatedMission = store.updateAgentMission(mission.id, {
    missionThreadId: missionThread.id,
    planSummary: plan.summary,
    plannedAt: clock().toISOString(),
  });
  store.updateAgentSession(missionThread.id, { status: 'waiting_for_approval' });
  return {
    mission: updatedMission,
    missionThread: store.getAgentSession(missionThread.id),
    plan,
    tasks: created.map((item) => item.task),
    sessions: created.map((item) => item.session),
  };
}

module.exports = {
  AgentOperationsPlanError,
  planAgentMission,
};
