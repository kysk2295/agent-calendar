import type {
  AgentMission,
  AgentDeliverable,
  AgentDeliverableKind,
  AgentExecutionEngine,
  AgentMissionState,
  AgentOperationsState,
  AgentSession,
  AgentSessionDetail,
  AgentSessionEvent,
  AgentTask,
  AgentTaskFailureCode,
  AgentTaskState,
  SessionEventKind,
} from './types';
import { parseAgentReport } from './agentReportParser';
import { sanitizeSessionRecord, sanitizeSessionValue } from './sessionSanitizer';
export const EMPTY_AGENT_OPERATIONS_STATE: AgentOperationsState = {
  missions: [],
  tasks: [],
  sessions: [],
  reports: [],
  daemon: { running: false, lastRun: null, lastError: null, mode: null },
  runner: null,
};

function taskScheduleTimestamp(task: AgentTask): number {
  const value = task.scheduledAt || `${task.date || ''}T${task.time || '00:00'}:00`;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

export function compareAgentTasksBySchedule(left: AgentTask, right: AgentTask): number {
  return taskScheduleTimestamp(left) - taskScheduleTimestamp(right) || left.id.localeCompare(right.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function missionState(value: unknown): AgentMissionState {
  switch (value) {
    case 'active':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'draft';
  }
}
function taskState(value: unknown): AgentTaskState {
  switch (value) {
    case 'approved':
    case 'scheduled':
    case 'running':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'proposed';
  }
}
function eventKind(value: unknown): SessionEventKind {
  switch (value) {
    case 'agent_message':
    case 'user_message':
    case 'plan':
    case 'tool_activity':
    case 'progress':
    case 'approval_request':
    case 'approval_response':
    case 'artifact':
    case 'error':
    case 'completion':
      return value;
    default:
      return 'progress';
  }
}

function executionEngine(value: unknown): AgentExecutionEngine {
  switch (value) {
    case 'auto':
    case 'local_llm':
    case 'codex':
    case 'claude':
    case 'grok':
    case 'hermes':
      return value;
    default:
      return 'auto';
  }
}

function deliverableKind(value: unknown): AgentDeliverableKind {
  switch (value) {
    case 'document':
    case 'image':
    case 'file':
      return value;
    default:
      return 'report';
  }
}

function parseDeliverable(value: unknown): AgentDeliverable {
  const record = recordValue(value);
  const kind = deliverableKind(record.kind);
  return {
    kind,
    format: stringValue(record.format, kind === 'report' ? 'markdown' : ''),
  };
}

function parseWikiArchive(value: unknown): AgentMission['wikiArchive'] {
  if (!isRecord(value)) return null;
  const status = stringValue(value.status);
  if (status !== 'written' && status !== 'skipped_no_wiki' && status !== 'failed') return null;
  return {
    status,
    relativePath: stringValue(value.relativePath),
    archivedAt: stringValue(value.archivedAt),
  };
}

function parseMission(value: unknown): AgentMission | null {
  if (!isRecord(value) || !stringValue(value.id)) return null;
  const schedule = recordValue(value.reportSchedule);
  const policy = recordValue(value.policy);
  const budget = recordValue(value.budget);
  const wikiArchive = parseWikiArchive(value.wikiArchive);
  const proposedMemoryPins = stringArray(value.proposedMemoryPins).slice(0, 3);
  return {
    id: stringValue(value.id),
    templateId: stringValue(value.templateId),
    title: stringValue(value.title, 'Agent Mission'),
    objective: stringValue(value.objective),
    successCriteria: stringArray(value.successCriteria),
    agentId: stringValue(value.agentId, 'bizconsultant'),
    executionEngine: executionEngine(value.executionEngine),
    deliverable: parseDeliverable(value.deliverable),
    status: missionState(value.status),
    timezone: stringValue(value.timezone, 'Asia/Seoul'),
    sources: stringArray(value.sources),
    reportSchedule: {
      weekday: numberValue(schedule.weekday, 5),
      hour: numberValue(schedule.hour, 16),
      minute: numberValue(schedule.minute, 0),
    },
    policy: {
      maxRunsPerWeek: numberValue(policy.maxRunsPerWeek, 0),
      maxRuntimeMinutesPerWeek: numberValue(policy.maxRuntimeMinutesPerWeek, 0),
      forbiddenActions: stringArray(policy.forbiddenActions),
    },
    budget: {
      usedRuns: numberValue(budget.usedRuns, 0),
      usedMinutes: numberValue(budget.usedMinutes, 0),
      weekStartedAt: stringValue(budget.weekStartedAt),
    },
    missionThreadId: stringValue(value.missionThreadId),
    planSummary: stringValue(value.planSummary),
    plannedAt: stringValue(value.plannedAt),
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
    ...(wikiArchive ? { wikiArchive } : {}),
    ...(proposedMemoryPins.length ? {
      proposedMemoryPins,
      proposedMemoryPinCount: numberValue(value.proposedMemoryPinCount, proposedMemoryPins.length),
    } : {}),
    ...(value.delegationMode === 'mode_a' || value.delegationMode === 'mode_b'
      ? { delegationMode: value.delegationMode }
      : {}),
  };
}

function parseTask(value: unknown): AgentTask | null {
  if (!isRecord(value) || !stringValue(value.id) || value.origin !== 'agent') return null;
  const failureCode: AgentTaskFailureCode | undefined = value.failureCode === 'budget_exhausted' || value.failureCode === 'relay_cancel_unconfirmed' ? value.failureCode : undefined;
  return {
    id: stringValue(value.id),
    missionId: stringValue(value.missionId),
    sessionId: stringValue(value.sessionId),
    title: stringValue(value.title, 'Agent Task'),
    status: taskState(value.status),
    agent: stringValue(value.agent || value.createdByAgentId, 'bizconsultant'),
    origin: 'agent',
    reason: stringValue(value.reason),
    expectedOutput: stringValue(value.expectedOutput),
    scheduledAt: stringValue(value.scheduledAt),
    dueAt: stringValue(value.dueAt),
    date: stringValue(value.date) || stringValue(value.scheduledAt).slice(0, 10),
    time: stringValue(value.time) || stringValue(value.scheduledAt).slice(11, 16),
    estimatedMinutes: numberValue(value.estimatedMinutes),
    actionClass: stringValue(value.actionClass),
    sourceRefs: stringArray(value.sourceRefs),
    executionEngine: executionEngine(value.executionEngine),
    deliverable: parseDeliverable(value.deliverable),
    blockedReason: stringValue(value.blockedReason),
    pauseMode: stringValue(value.pauseMode),
    ...(failureCode ? { failureCode } : {}),
    attempt: numberValue(value.attempt),
    reportId: stringValue(value.reportId),
  };
}

function parseSession(value: unknown): AgentSession | null {
  if (!isRecord(value) || !stringValue(value.id)) return null;
  return {
    id: stringValue(value.id),
    missionId: stringValue(value.missionId),
    taskId: stringValue(value.taskId),
    type: value.type === 'mission-thread' ? 'mission-thread' : 'task',
    title: stringValue(value.title, 'Task Session'),
    status: stringValue(value.status),
    executionEngine: executionEngine(value.executionEngine),
    deliverable: parseDeliverable(value.deliverable),
    pendingInstructions: stringArray(value.pendingInstructions),
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
  };
}

function parseEvent(value: unknown): AgentSessionEvent | null {
  if (!isRecord(value) || !stringValue(value.id)) return null;
  return {
    id: stringValue(value.id),
    sessionId: stringValue(value.sessionId),
    sequence: numberValue(value.sequence),
    kind: eventKind(value.kind),
    text: stringValue(sanitizeSessionValue(value.text)),
    metadata: sanitizeSessionRecord(value.metadata),
    createdAt: stringValue(value.createdAt),
  };
}

function parseArray<T>(value: unknown, parser: (item: unknown) => T | null): readonly T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parser).filter((item): item is T => item !== null);
}

export function parseAgentOperationsEnvelope(value: unknown): AgentOperationsState {
  if (!isRecord(value)) return EMPTY_AGENT_OPERATIONS_STATE;
  const daemon = recordValue(value.daemon);
  const lastRun = recordValue(daemon.lastRun);
  const lastError = recordValue(daemon.lastError);
  const runner = recordValue(value.runner);
  const runnerStatus = stringValue(runner.status || daemon.mode);
  return {
    missions: parseArray(value.missions, parseMission),
    tasks: parseArray(value.tasks, parseTask),
    sessions: parseArray(value.sessions, parseSession),
    reports: parseArray(value.reports, parseAgentReport),
    daemon: {
      running: daemon.running === true,
      lastRun: stringValue(daemon.lastRun) || stringValue(lastRun.checkedAt) || null,
      lastError: stringValue(daemon.lastError) || stringValue(lastError.message) || null,
      mode: stringValue(daemon.mode) || null,
    },
    runner: runnerStatus || Object.keys(runner).length
      ? {
        connected: runner.connected === true,
        status: runnerStatus || 'unknown',
        message: stringValue(runner.message) || null,
      }
      : null,
  };
}

export function parseAgentSessionEnvelope(value: unknown): AgentSessionDetail | null {
  if (!isRecord(value)) return null;
  const session = parseSession(value.session);
  if (!session) return null;
  const source = isRecord(value.session) ? value.session.events : [];
  return {
    ...session,
    events: [...parseArray(source, parseEvent)].sort((left, right) => left.sequence - right.sequence),
  };
}
