const crypto = require('node:crypto');

const { sanitizeSessionEvent } = require('./agent-operations-domain');

const TERMINAL_TASK_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const TERMINAL_MISSION_STATUSES = new Set(['completed', 'cancelled', 'failed']);

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

function terminalizeAgentMission({
  store,
  missionId,
  clock = () => new Date(),
  wikiRoot = '',
} = {}) {
  const state = store.getState();
  const mission = state.agentMissions.find((item) => item.id === missionId);
  if (!mission || TERMINAL_MISSION_STATUSES.has(mission.status) || mission.pendingRevisionId) {
    return mission || null;
  }
  const tasks = state.tasks.filter((task) => (
    task.missionId === mission.id && task.origin === 'agent'
  ));
  if (!tasks.length || tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) {
    return mission;
  }
  const allCancelled = tasks.every((task) => task.status === 'cancelled');
  const currentResult = state.agentReports.find((report) => (
    report.id === mission.currentResultReportId
    && report.missionId === mission.id
    && report.status === 'ready'
  ));
  if (!allCancelled && !currentResult) return mission;

  const status = allCancelled
    ? 'cancelled'
    : tasks.some((task) => task.status === 'failed')
      ? 'failed'
      : 'completed';
  const terminalAt = clock().toISOString();
  let updated = store.updateAgentMission(mission.id, {
    status,
    [`${status}At`]: terminalAt,
  });
  if (status === 'completed') {
    const missionThread = state.agentSessions.find((session) => (
      session.id === mission.missionThreadId
      && session.missionId === mission.id
      && session.type === 'mission-thread'
    ));
    if (missionThread) {
      store.appendAgentSessionEvent(missionThread.id, sanitizeSessionEvent({
        kind: 'completion',
        text: '위임 작업의 모든 하위 작업이 완료되어 현재 결과를 확정했습니다.',
        createdAt: terminalAt,
        metadata: {
          status,
          completedAt: terminalAt,
          reportId: currentResult.id,
          taskCount: tasks.length,
        },
      }));
    }
    try {
      const { archiveCompletedDelegatedWork } = require('./agent-work-wiki-archive');
      const archiveResult = archiveCompletedDelegatedWork({
        store,
        missionId: mission.id,
        wikiRoot,
        clock,
      });
      if (archiveResult?.mission) {
        updated = archiveResult.mission;
      } else if (archiveResult?.status) {
        updated = store.getAgentMissions().find((item) => item.id === mission.id) || updated;
      } else {
        updated = store.getAgentMissions().find((item) => item.id === mission.id) || updated;
      }
    } catch {
      // Archive must never block terminalization.
      updated = store.getAgentMissions().find((item) => item.id === mission.id) || updated;
    }
  }
  return updated;
}

module.exports = {
  completedMissionEvidence,
  createSchedulerResult,
  isRuntimeFailure,
  recordMissionBudget,
  schedulerId,
  terminalizeAgentMission,
};
