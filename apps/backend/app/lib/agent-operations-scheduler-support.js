const crypto = require('node:crypto');

function schedulerId(prefix, clock) {
  const stamp = clock().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function createSchedulerResult(checkedAt, { skipped = false, reason = '' } = {}) {
  return {
    checkedAt,
    ...(skipped ? { skipped: true, reason } : {}),
    startedTaskIds: [],
    completedTaskIds: [],
    blockedTaskIds: [],
    failedTaskIds: [],
    cancelledTaskIds: [],
    createdReportIds: [],
  };
}

function isRuntimeFailure(error) {
  return ['runtime_unavailable', 'relay_timeout', 'relay_failed', 'relay_cancel_unconfirmed'].includes(error?.code);
}

function completedMissionEvidence(store, missionId, excludedSessionId) {
  const state = store.getState();
  const taskTitles = new Map(state.tasks.map((task) => [task.id, task.title]));
  return state.agentSessions
    .filter((session) => (
      session.missionId === missionId
      && session.id !== excludedSessionId
      && session.status === 'completed'
    ))
    .flatMap((session) => {
      const detail = store.getAgentSession(session.id);
      return (detail?.events || [])
        .filter((event) => ['agent_message', 'artifact'].includes(event.kind))
        .map((event) => ({
          taskTitle: taskTitles.get(session.taskId) || session.title,
          kind: event.kind,
          text: String(event.text || '').slice(0, 6_000),
        }));
    })
    .filter((event) => event.text)
    .slice(-12);
}

function recordMissionBudget(store, mission, task) {
  const budget = mission.budget || {};
  store.updateAgentMission(mission.id, {
    budget: {
      ...budget,
      usedRuns: Number(budget.usedRuns || 0) + 1,
      usedMinutes: Number(budget.usedMinutes || 0) + Number(task.estimatedMinutes || 0),
    },
  });
}

module.exports = {
  completedMissionEvidence,
  createSchedulerResult,
  isRuntimeFailure,
  recordMissionBudget,
  schedulerId,
};
