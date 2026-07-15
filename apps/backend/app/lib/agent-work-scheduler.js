const { sanitizeSessionEvent } = require('./agent-operations-domain');
const { taskExecutionMessages } = require('./agent-operations-execution');
const {
  markCheckpointRequestApplied,
  markEventApplied,
  queuedEventsForTask,
} = require('./agent-work-delivery');
const { completeRevision, revisionBudgetAvailable } = require('./agent-work-revision');

function blockExhaustedRevision({ store, mission, task, session, result, clock } = {}) {
  if (revisionBudgetAvailable(mission, task)) return false;
  store.updateTask(task.id, {
    status: 'blocked',
    failureCode: 'budget_exhausted',
    blockedReason: '수정 차수 실행 예산이 소진되었습니다.',
    finishedAt: clock().toISOString(),
  });
  store.updateAgentSession(session.id, { status: 'blocked' });
  store.appendAgentSessionEvent(session.id, sanitizeSessionEvent({
    kind: 'blocked',
    text: '수정 차수 실행 예산이 소진되어 기존 결과를 유지합니다.',
    metadata: { code: 'budget_exhausted', revisionId: task.revisionId },
  }));
  result.blockedTaskIds.push(task.id);
  return true;
}

function prepareWorkExecution({ store, mission, task, session, priorMissionEvidence } = {}) {
  const queuedEvents = queuedEventsForTask(store, mission.id, task.id);
  const currentSession = store.getAgentSession(session.id);
  return {
    queuedEvents,
    messages: taskExecutionMessages(
      mission,
      task,
      { ...currentSession, events: [...currentSession.events, ...queuedEvents] },
      priorMissionEvidence,
    ),
  };
}

function markQueuedExecutionApplied({ store, queuedEvents, clock } = {}) {
  const appliedAt = clock().toISOString();
  for (const event of queuedEvents) markEventApplied(store, event, appliedAt);
}

function markCheckpointApplied({ store, taskId, action, clock } = {}) {
  return markCheckpointRequestApplied({
    store,
    taskId,
    action,
    appliedAt: clock().toISOString(),
  });
}

async function completeWorkResult({ store, mission, task, session, report, clock } = {}) {
  if (!report) return null;
  if (task.revisionId) {
    return await completeRevision({
      store,
      missionId: mission.id,
      task: { ...task, sessionId: session.id },
      report,
      clock,
    });
  }
  return store.updateAgentMission(mission.id, { currentResultReportId: report.id });
}

module.exports = {
  blockExhaustedRevision,
  completeWorkResult,
  markCheckpointApplied,
  markQueuedExecutionApplied,
  prepareWorkExecution,
};
