const TASK_STATES = Object.freeze([
  'proposed',
  'approved',
  'scheduled',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

const SESSION_EVENT_KINDS = Object.freeze([
  'agent_message',
  'user_message',
  'plan',
  'tool_activity',
  'progress',
  'approval_request',
  'approval_response',
  'artifact',
  'error',
  'completion',
]);

const ALLOWED_ACTION_CLASSES = Object.freeze(['research', 'analysis', 'report']);

const TASK_ACTIONS = Object.freeze({
  approve: { proposed: 'scheduled' },
  pause: { scheduled: 'blocked' },
  resume: { blocked: 'scheduled' },
  cancel: { proposed: 'cancelled', scheduled: 'cancelled', blocked: 'cancelled' },
  retry: { failed: 'scheduled' },
  start: { scheduled: 'running' },
  block: { running: 'blocked' },
  complete: { running: 'completed' },
  fail: { running: 'failed' },
});

function createWeeklyOpportunityMission({ id, clock = () => new Date() } = {}) {
  if (!String(id || '').trim()) throw new Error('mission id is required');
  const now = clock().toISOString();
  return {
    id: String(id),
    templateId: 'weekly-opportunity-brief',
    title: 'Weekly Opportunity Brief',
    objective: '현재 사업과 제품에 도움이 되는 기회를 근거와 함께 매주 찾는다.',
    successCriteria: [
      '근거가 있는 기회 3개',
      '이번 주 추천 행동 1개',
      '한계와 다음 검증 작업',
    ],
    agentId: 'bizconsultant',
    status: 'draft',
    timezone: 'Asia/Seoul',
    reportSchedule: { weekday: 5, hour: 16, minute: 0 },
    sources: ['wiki', 'web', 'prior_reports'],
    policy: {
      maxRunsPerWeek: 6,
      maxRuntimeMinutesPerWeek: 120,
      firstPlanRequiresApproval: true,
      newActionClassRequiresApproval: true,
      externalSideEffectsRequireApproval: true,
      forbiddenActions: [
        'external_message',
        'publish',
        'purchase',
        'trade',
        'delete_source',
      ],
    },
    budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

function buildMissionPlanPrompt({ mission, priorReports = [], userFeedback = [] } = {}) {
  if (!mission?.id) throw new Error('mission is required');
  return JSON.stringify({
    instruction: [
      'Return JSON only.',
      'Create 2-5 bounded tasks, including exactly one report task.',
      'Do not perform external side effects.',
      'Every task needs a reason, expected output, approved sources, schedule, due time, and estimate.',
    ].join(' '),
    mission,
    priorReports,
    userFeedback,
    schema: {
      summary: 'string',
      tasks: [{
        key: 'unique-string',
        title: 'string',
        reason: 'string',
        expectedOutput: 'string',
        scheduledAt: 'ISO-8601',
        dueAt: 'ISO-8601',
        estimatedMinutes: 'positive-number',
        actionClass: 'research|analysis|report',
        sourceRefs: ['approved-source'],
      }],
    },
  });
}

function parseMissionPlan({ mission, raw } = {}) {
  if (!mission?.policy) throw new Error('mission policy is required');
  const text = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 2 || parsed.tasks.length > 5) {
    throw new Error('plan must contain 2-5 tasks');
  }

  const keys = new Set();
  let reportCount = 0;
  let estimatedMinutesTotal = 0;
  const tasks = parsed.tasks.map((task) => {
    const key = String(task?.key || '').trim();
    if (!key || keys.has(key)) throw new Error(`duplicate or missing task key: ${key}`);
    keys.add(key);

    const actionClass = String(task.actionClass || '').trim();
    if (!ALLOWED_ACTION_CLASSES.includes(actionClass)) {
      throw new Error(`action class not allowed: ${actionClass}`);
    }
    if (actionClass === 'report') reportCount += 1;

    const estimatedMinutes = Number(task.estimatedMinutes);
    if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) {
      throw new Error('estimated minutes must be positive');
    }
    estimatedMinutesTotal += estimatedMinutes;

    const sourceRefs = Array.isArray(task.sourceRefs)
      ? task.sourceRefs.map(String).map((source) => source.trim()).filter(Boolean)
      : [];
    const scheduledAt = new Date(task.scheduledAt);
    const dueAt = new Date(task.dueAt);
    if (!sourceRefs.length) throw new Error(`task ${key} requires approved sources`);
    if (Number.isNaN(scheduledAt.getTime()) || Number.isNaN(dueAt.getTime()) || dueAt <= scheduledAt) {
      throw new Error(`task ${key} has an invalid schedule`);
    }

    const title = String(task.title || '').trim();
    const reason = String(task.reason || '').trim();
    const expectedOutput = String(task.expectedOutput || '').trim();
    if (!title || !reason || !expectedOutput) throw new Error(`task ${key} is missing its contract`);
    return {
      key,
      title,
      reason,
      expectedOutput,
      scheduledAt: scheduledAt.toISOString(),
      dueAt: dueAt.toISOString(),
      estimatedMinutes,
      actionClass,
      sourceRefs,
    };
  });

  if (reportCount !== 1) throw new Error('plan must contain exactly one report task');
  if (tasks.length > Number(mission.policy.maxRunsPerWeek)) throw new Error('plan exceeds run budget');
  if (estimatedMinutesTotal > Number(mission.policy.maxRuntimeMinutesPerWeek)) {
    throw new Error('plan exceeds runtime budget');
  }
  return { summary: String(parsed.summary || '').trim(), tasks };
}

function transitionAgentTask(task, action, { clock = () => new Date() } = {}) {
  const currentStatus = String(task?.status || '');
  const nextStatus = TASK_ACTIONS[action]?.[currentStatus];
  if (!nextStatus) throw new Error(`invalid task transition: ${currentStatus} -> ${action}`);
  return { ...task, status: nextStatus, updatedAt: clock().toISOString() };
}

function redactSessionValue(value, key = '') {
  if (/authorization|token|secret|password|chain.?of.?thought|reasoning/i.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .replace(/("(?:authorization|token|secret|password)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
      .replace(/(?:token|secret|password)\s*[=:]\s*[^\s]+/gi, '[redacted]')
      .replace(/\/(?:Users|home)\/[^\s"']+/g, '[private-path]');
  }
  if (Array.isArray(value)) return value.map((item) => redactSessionValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactSessionValue(child, childKey)]),
    );
  }
  return value;
}

function sanitizeSessionEvent(event = {}) {
  const kind = String(event.kind || '');
  if (kind && !SESSION_EVENT_KINDS.includes(kind)) throw new Error(`unsupported session event kind: ${kind}`);
  return redactSessionValue(event);
}

function sanitizeReportText(value, maximumLength = 2_000) {
  return String(redactSessionValue(String(value || ''))).trim().slice(0, maximumLength);
}

function sanitizeEvidenceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().slice(0, 2_048) : '';
  } catch {
    return '';
  }
}

function sanitizeAgentReport(report = {}) {
  const redacted = redactSessionValue(report);
  return {
    ...redacted,
    title: sanitizeReportText(redacted.title, 300),
    findings: (Array.isArray(redacted.findings) ? redacted.findings : [])
      .slice(0, 20)
      .map((finding) => sanitizeReportText(finding)),
    evidence: (Array.isArray(redacted.evidence) ? redacted.evidence : [])
      .slice(0, 20)
      .map((evidence) => ({
        label: sanitizeReportText(evidence?.label, 300),
        url: sanitizeEvidenceUrl(evidence?.url),
      })),
    limitations: (Array.isArray(redacted.limitations) ? redacted.limitations : [])
      .slice(0, 20)
      .map((limitation) => sanitizeReportText(limitation)),
    followUps: (Array.isArray(redacted.followUps) ? redacted.followUps : [])
      .slice(0, 20)
      .map((followUp) => ({
        title: sanitizeReportText(followUp?.title, 300),
        reason: sanitizeReportText(followUp?.reason),
      })),
  };
}

function validateReport(report = {}) {
  for (const field of ['findings', 'evidence', 'limitations', 'followUps']) {
    if (!Array.isArray(report[field])) throw new Error(`report ${field} must be an array`);
  }
  if (!report.findings.length) throw new Error('report findings are required');
  if (!report.evidence.length) throw new Error('report evidence is required');
  if (!report.budget || !Number.isFinite(Number(report.budget.usedMinutes))) {
    throw new Error('report budget is required');
  }
  return report;
}

module.exports = {
  ALLOWED_ACTION_CLASSES,
  SESSION_EVENT_KINDS,
  TASK_ACTIONS,
  TASK_STATES,
  buildMissionPlanPrompt,
  createWeeklyOpportunityMission,
  parseMissionPlan,
  sanitizeAgentReport,
  sanitizeSessionEvent,
  transitionAgentTask,
  validateReport,
};
