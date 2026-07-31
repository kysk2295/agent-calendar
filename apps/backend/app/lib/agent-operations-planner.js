const crypto = require('node:crypto');

const {
  buildMissionPlanPrompt,
  parseMissionPlan,
  sanitizeSessionEvent,
} = require('./agent-operations-domain');
const { markMissionContextApplied } = require('./agent-work-delivery');

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

function isRuntimeUnavailable(error) {
  return error?.code === 'runtime_unavailable' || error?.error === 'runtime_unavailable';
}

function createDeterministicFallbackPlan({ mission, clock }) {
  const maxRuns = Number(mission.policy?.maxRunsPerWeek);
  const maxMinutes = Math.floor(Number(mission.policy?.maxRuntimeMinutesPerWeek));
  const taskCount = Math.min(3, Math.floor(maxRuns));
  if (!Number.isFinite(maxRuns) || taskCount < 2 || !Number.isFinite(maxMinutes) || maxMinutes < taskCount) {
    throw new AgentOperationsPlanError(
      'plan_policy_invalid',
      'Mission policy cannot support a deterministic fallback plan',
      422,
    );
  }

  const objective = String(mission.objective || mission.title || '요청한 작업').trim();
  const missionSourceRefs = Array.isArray(mission.sources)
    ? mission.sources.map(String).map((source) => source.trim()).filter(Boolean)
    : [];
  const sourceRefs = missionSourceRefs.length ? missionSourceRefs : ['mission'];
  const totalMinutes = Math.min(maxMinutes, taskCount * 30);
  const baseMinutes = Math.floor(totalMinutes / taskCount);
  const remainder = totalMinutes % taskCount;
  const scheduledFrom = clock().getTime();
  const schedule = (index) => {
    const scheduledAt = new Date(scheduledFrom + (index * 2 * 60 * 60 * 1000));
    const dueAt = new Date(scheduledAt.getTime() + (90 * 60 * 1000));
    return { scheduledAt: scheduledAt.toISOString(), dueAt: dueAt.toISOString() };
  };
  const taskContracts = taskCount === 2
    ? [
      {
        key: 'research',
        title: `${mission.title} 근거 수집`,
        reason: `요청 목표를 수행하기 전에 검증 가능한 근거가 필요합니다: ${objective}`,
        expectedOutput: '출처와 핵심 사실이 연결된 근거 목록',
        actionClass: 'research',
        sourceRefs,
      },
      {
        key: 'report',
        title: `${mission.title} 결과 보고`,
        reason: '수집한 근거를 요청 목표에 맞는 최종 결과로 정리해야 합니다.',
        expectedOutput: `${objective}에 대한 근거, 결론, 한계가 포함된 최종 산출물`,
        actionClass: 'report',
        sourceRefs: ['mission'],
      },
    ]
    : [
      {
        key: 'research',
        title: `${mission.title} 근거 수집`,
        reason: `요청 목표를 수행하기 전에 검증 가능한 근거가 필요합니다: ${objective}`,
        expectedOutput: '출처와 핵심 사실이 연결된 근거 목록',
        actionClass: 'research',
        sourceRefs,
      },
      {
        key: 'analysis',
        title: `${mission.title} 근거 분석`,
        reason: '수집한 근거를 목표와 성공 기준에 맞춰 비교하고 해석해야 합니다.',
        expectedOutput: '근거별 시사점, 불확실성, 권고안이 포함된 분석',
        actionClass: 'analysis',
        sourceRefs: ['mission'],
      },
      {
        key: 'report',
        title: `${mission.title} 결과 보고`,
        reason: '검증한 근거와 분석을 요청 목표에 맞는 최종 결과로 정리해야 합니다.',
        expectedOutput: `${objective}에 대한 근거, 결론, 한계가 포함된 최종 산출물`,
        actionClass: 'report',
        sourceRefs: ['mission'],
      },
    ];

  return {
    summary: `Deterministic fallback으로 "${objective}" 작업 계획을 생성했습니다.`,
    tasks: taskContracts.map((task, index) => ({
      ...task,
      ...schedule(index),
      estimatedMinutes: baseMinutes + (index < remainder ? 1 : 0),
    })),
  };
}

function appendFallbackCheckpoint(store, sessionId, reason) {
  store.appendAgentSessionEvent(sessionId, sanitizeSessionEvent({
    kind: 'progress',
    text: '실행 가능한 계획 런타임이 없어 deterministic fallback으로 계획을 만들었습니다.',
    metadata: { code: 'deterministic_fallback', reason },
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
    executionEngine: mission.executionEngine || 'hermes',
    deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
    approvalMode: 'required',
  });
  const session = store.createAgentSession({
    id: createPlannerId('task-session', clock),
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    title: task.title,
    status: 'proposed',
    executionEngine: mission.executionEngine || 'hermes',
    deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
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
      executionEngine: mission.executionEngine || 'hermes',
      deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
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
  let planningMessages;
  const handlePlanningEvent = async (event) => {
    store.appendAgentSessionEvent(missionThread.id, sanitizeSessionEvent(event));
  };
  if (typeof planCompletion !== 'function') {
    completion = { text: JSON.stringify(createDeterministicFallbackPlan({ mission, clock })) };
    appendFallbackCheckpoint(store, missionThread.id, 'plan_completion_missing');
  }
  try {
    if (typeof planCompletion === 'function') {
      const workMessages = store.getAgentSession(missionThread.id).events
        .filter((event) => event.kind === 'user_message')
        .map((event) => event.text);
      const basePrompt = buildMissionPlanPrompt({
        mission,
        priorReports: store.getAgentReports().filter((report) => report.missionId === mission.id),
        userFeedback: Array.isArray(mission.userFeedback) ? mission.userFeedback : [],
      });
      const prompt = workMessages.length
        ? `${basePrompt}\nWork Conversation context:\n${workMessages.map((text) => `- ${text}`).join('\n')}`
        : basePrompt;
      planningMessages = [
        { role: 'system', content: 'You plan bounded internal work for Agent Calendar. Return JSON only.' },
        { role: 'user', content: prompt },
      ];
      completion = await planCompletion({
        payload: {
          profile: mission.agentId,
          executionEngine: mission.executionEngine || 'hermes',
          deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
          stream: true,
          messages: planningMessages,
        },
        meta: {
          missionId: mission.id,
          sessionId: missionThread.id,
          agentId: mission.agentId,
          executionEngine: mission.executionEngine || 'hermes',
          deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
          idempotencyKey: `${mission.id}:plan:1`,
        },
        onEvent: handlePlanningEvent,
      });
      if (isRuntimeUnavailable(completion)) {
        completion = { text: JSON.stringify(createDeterministicFallbackPlan({ mission, clock })) };
        appendFallbackCheckpoint(store, missionThread.id, 'runtime_unavailable');
      }
    }
  } catch (error) {
    if (isRuntimeUnavailable(error)) {
      completion = { text: JSON.stringify(createDeterministicFallbackPlan({ mission, clock })) };
      appendFallbackCheckpoint(store, missionThread.id, 'runtime_unavailable');
    } else {
      appendPlanningError(store, missionThread.id, error);
      throw new AgentOperationsPlanError(
        error.code || 'runtime_unavailable',
        error.message || 'Hermes Runner planning failed',
        error.code === 'runtime_unavailable' ? 503 : 502,
      );
    }
  }

  let plan;
  try {
    plan = parseMissionPlan({ mission, raw: completion?.text });
  } catch (validationError) {
    store.appendAgentSessionEvent(missionThread.id, sanitizeSessionEvent({
      kind: 'progress',
      text: `Hermes 계획을 검증에서 거절했습니다. 한 번 교정합니다: ${validationError.message}`,
      metadata: { code: 'plan_correction', attempt: 2 },
    }));
    const correction = [
      `The previous JSON plan was rejected: ${validationError.message}.`,
      `Return a corrected plan with 2-5 tasks and total estimatedMinutes <= ${mission.policy.maxRuntimeMinutesPerWeek}.`,
      'Include exactly one report task and no forbidden external action. Return corrected JSON only.',
    ].join(' ');
    try {
      completion = await planCompletion({
          payload: {
            profile: mission.agentId,
            executionEngine: mission.executionEngine || 'hermes',
            deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
            stream: true,
          messages: [
            ...planningMessages,
            { role: 'assistant', content: String(completion?.text || '') },
            { role: 'user', content: correction },
          ],
        },
        meta: {
          missionId: mission.id,
          sessionId: missionThread.id,
          agentId: mission.agentId,
          executionEngine: mission.executionEngine || 'hermes',
          deliverable: mission.deliverable || { kind: 'report', format: 'markdown' },
          planAttempt: 2,
          idempotencyKey: `${mission.id}:plan:2`,
        },
        onEvent: handlePlanningEvent,
      });
      plan = parseMissionPlan({ mission, raw: completion?.text });
    } catch (error) {
      if (isRuntimeUnavailable(error)) {
        plan = parseMissionPlan({
          mission,
          raw: JSON.stringify(createDeterministicFallbackPlan({ mission, clock })),
        });
        appendFallbackCheckpoint(store, missionThread.id, 'runtime_unavailable');
      } else {
        appendPlanningError(store, missionThread.id, error);
        if (error.code && error.code !== 'plan_invalid') {
          throw new AgentOperationsPlanError(
            error.code,
            error.message || 'Hermes Runner planning failed',
            error.code === 'runtime_unavailable' ? 503 : 502,
          );
        }
        throw new AgentOperationsPlanError('plan_invalid', 'Hermes returned an invalid mission plan', 422);
      }
    }
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
  markMissionContextApplied({
    store,
    missionId: mission.id,
    appliedAt: clock().toISOString(),
  });
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
