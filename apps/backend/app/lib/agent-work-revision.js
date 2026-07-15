const crypto = require('node:crypto');

const { sanitizeSessionEvent } = require('./agent-operations-domain');

class AgentWorkRevisionError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AgentWorkRevisionError';
    this.code = code;
    this.status = status;
  }
}

const REVISION_PATTERN = /^(?:(?:revision|revise|수정|보완)\s*:\s*\S[\s\S]*|(?:(?:please|kindly)\s+|(?:(?:could|would|can)\s+you(?:\s+please|\s+kindly)?\s+))?(?:revise|fix)(?:\s+(?:this|it|the\s+(?:result|report|conclusion|evidence|findings?|table|section|wording)))?(?:\s+[\s\S]*?)?(?:\s+please)?[.!?]?|(?:다시\s*)?(?:(?:결론|근거|결과|보고서|표|설명|문구|섹션)(?:을|를|은|는)?\s+[\s\S]*?\s+)?(?:수정|고쳐|보완)(?:해)?\s*(?:줘|주세요)?[.!?]?)$/i;
const FOLLOW_UP_PATTERN = /^(?:new\s+goal|follow[ -]?up|새\s*목표|별도\s*작업)\s*:\s*\S/i;
const DIFFERENT_GOAL_PATTERN = /(?:\b(?:goal|objective|topic|scope)\b[\s\S]*\b(?:change|switch|replace|revise)\b|\b(?:change|switch|replace|revise)\b[\s\S]*\b(?:goal|objective|topic|scope)\b|(?:목표|주제|분석\s*대상|작업\s*범위)[\s\S]*(?:바꿔|변경|교체|수정))/i;

function deterministicRevisionId(prefix, missionId, revisionNumber) {
  const digest = crypto
    .createHash('sha256')
    .update(`${missionId}:revision:${revisionNumber}`)
    .digest('hex')
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

function classifyRevisionIntent(text) {
  if (FOLLOW_UP_PATTERN.test(text)) return 'follow_up';
  if (DIFFERENT_GOAL_PATTERN.test(text)) return 'follow_up';
  if (REVISION_PATTERN.test(text)) return 'revision';
  return '';
}

function currentResult(store, mission) {
  const reports = store.getAgentReports().filter((report) => (
    report.missionId === mission.id && report.status === 'ready'
  ));
  const report = reports.find((item) => item.id === mission.currentResultReportId) || reports[0];
  if (!report) {
    throw new AgentWorkRevisionError(
      'revision_result_required',
      'A valid result is required before requesting a revision',
      409,
    );
  }
  const task = store.getState().tasks.find((item) => item.id === report.taskId);
  if (!task || task.status !== 'completed') {
    throw new AgentWorkRevisionError(
      'revision_result_required',
      'The current result task is not complete',
      409,
    );
  }
  return { report, task };
}

function createRevisionAttempt({
  store,
  missionId,
  instruction,
  message,
  delivery,
  clock = () => new Date(),
} = {}) {
  const mission = store.getAgentMissions().find((item) => item.id === missionId);
  if (!mission) throw new AgentWorkRevisionError('work_not_found', 'Delegated work was not found', 404);
  if (mission.pendingRevisionId) {
    throw new AgentWorkRevisionError(
      'revision_already_pending',
      'Complete or retry the pending revision before starting another',
      409,
    );
  }
  const current = currentResult(store, mission);
  const revisionNumber = Number(mission.revisionCounter || 0) + 1;
  const revisionId = deterministicRevisionId('revision', mission.id, revisionNumber);
  const taskId = deterministicRevisionId('agent-task-revision', mission.id, revisionNumber);
  const sessionId = deterministicRevisionId('task-session-revision', mission.id, revisionNumber);
  const now = clock().toISOString();
  const dueAt = new Date(new Date(now).getTime() + Math.max(1, Number(current.task.estimatedMinutes || 30)) * 60_000).toISOString();
  const task = {
    id: taskId,
    title: `${current.task.title} · 수정 차수 ${revisionNumber}`,
    owner: 'Agent',
    status: 'proposed',
    missionId: mission.id,
    sessionId,
    origin: 'agent',
    createdByAgentId: mission.agentId,
    reason: instruction,
    expectedOutput: current.task.expectedOutput || current.report.title,
    scheduledAt: now,
    dueAt,
    estimatedMinutes: Math.max(1, Number(current.task.estimatedMinutes || 30)),
    actionClass: 'report',
    sourceRefs: current.task.sourceRefs || mission.sources || ['mission'],
    executionEngine: current.task.executionEngine || mission.executionEngine || 'hermes',
    deliverable: current.task.deliverable || mission.deliverable || { kind: 'report', format: 'markdown' },
    approvalMode: 'required',
    revisionId,
    revisionNumber,
    revisesTaskId: current.task.id,
    revisesReportId: current.report.id,
    createdAt: now,
    updatedAt: now,
  };
  const session = {
    id: sessionId,
    missionId: mission.id,
    taskId: task.id,
    type: 'task',
    title: task.title,
    status: 'proposed',
    revisionId,
    revisionNumber,
    revisesTaskId: current.task.id,
    revisesReportId: current.report.id,
    createdAt: now,
    updatedAt: now,
  };
  const events = [
    sanitizeSessionEvent({
      id: deterministicRevisionId('session-event-revision-started', mission.id, revisionNumber),
      kind: 'revision_started',
      text: `수정 차수 ${revisionNumber} 시작: ${instruction}`,
      createdAt: now,
      metadata: {
        revisionId,
        revisionNumber,
        taskId: task.id,
        reportId: current.report.id,
      },
    }),
    sanitizeSessionEvent({
      id: deterministicRevisionId('session-event-revision-plan', mission.id, revisionNumber),
      kind: 'plan',
      text: instruction,
      createdAt: now,
      metadata: { revisionId, revisionNumber, taskId: task.id },
    }),
    sanitizeSessionEvent({
      id: deterministicRevisionId('session-event-revision-approval', mission.id, revisionNumber),
      kind: 'approval_request',
      text: '수정 차수 작업은 실행 전에 승인이 필요합니다.',
      createdAt: now,
      metadata: { action: 'approve', taskId: task.id, revisionId, revisionNumber },
    }),
  ];
  return store.createRevisionCycle({
    message,
    delivery: {
      ...delivery,
      status: 'applied',
      targetTaskId: task.id,
      revisionId,
      appliedAt: now,
    },
    baseTaskId: current.task.id,
    baseReportId: current.report.id,
    task,
    session,
    events,
    missionPatch: {
      revisionCounter: revisionNumber,
      pendingRevisionId: revisionId,
      currentResultReportId: current.report.id,
    },
  });
}

function revisionBudgetAvailable(mission, task) {
  if (!task.revisionId) return true;
  const usedRuns = Number(mission.budget?.usedRuns || 0);
  const usedMinutes = Number(mission.budget?.usedMinutes || 0);
  return usedRuns < Number(mission.policy?.maxRunsPerWeek || 0)
    && usedMinutes + Number(task.estimatedMinutes || 0) <= Number(mission.policy?.maxRuntimeMinutesPerWeek || 0);
}

function completeRevision({ store, missionId, task, report, clock = () => new Date() } = {}) {
  const completedAt = clock().toISOString();
  return store.completeRevisionCycle({
    missionId,
    task,
    report,
    event: sanitizeSessionEvent({
    id: deterministicRevisionId('session-event-revision-completed', missionId, task.revisionNumber),
    kind: 'revision_completed',
    text: `수정 차수 ${task.revisionNumber}가 유효한 결과로 완료되었습니다.`,
    createdAt: completedAt,
    metadata: {
      revisionId: task.revisionId,
      revisionNumber: task.revisionNumber,
      taskId: task.id,
      reportId: report.id,
      completedAt,
    },
    }),
  });
}

module.exports = {
  AgentWorkRevisionError,
  classifyRevisionIntent,
  completeRevision,
  createRevisionAttempt,
  revisionBudgetAvailable,
};
