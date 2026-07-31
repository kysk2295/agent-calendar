const { sanitizeAgentReport } = require('./agent-operations-domain');
const { resolveRequestedOfficialProfile } = require('./official-profiles');
const { safePublicText } = require('./runtime-gateway');

const DANGEROUS_KEY = /(?:^|_)(?:api.?key|authorization|command|credential|cwd|debug|password|passphrase|passwd|pwd|path|profile.?root|raw|reasoning|secret|token|yolo)(?:$|_)/i;
const PUBLIC_SCALAR_KEYS = new Set([
  'action', 'agent', 'agentId', 'approved', 'cancelled', 'category', 'complete', 'completed',
  'content', 'created', 'createdAt', 'date', 'decision', 'deleted', 'description', 'detail', 'due',
  'enabled', 'end', 'endDate', 'endTime', 'error', 'gatewayFallback', 'goal', 'id', 'jobId',
  'kind', 'label', 'message', 'missionId', 'model', 'name', 'notes', 'objective', 'ok', 'pending',
  'progress', 'queued', 'ready', 'reason', 'reportId', 'role', 'runId', 'sequence', 'sessionId',
  'source', 'start', 'startDate', 'status', 'state', 'taskId', 'text', 'time', 'title', 'type',
  'updatedAt',
]);
const PUBLIC_SESSION_METADATA_KEYS = new Set([
  'action', 'actionClass', 'agent', 'applicationMode', 'attempt', 'budget', 'checkpoint', 'code',
  'completedAt', 'decision', 'deliveryStatus', 'detail', 'dueAt', 'estimatedMinutes', 'evidenceCount',
  'externalSideEffectsRequireApproval', 'firstPlanRequiresApproval', 'followUpIndex', 'forbiddenActions',
  'jobId', 'maxRunsPerWeek', 'maxRuntimeMinutesPerWeek', 'missionId', 'model',
  'newActionClassRequiresApproval', 'objective', 'previousStatus', 'progress', 'receivedAt', 'recordedAt',
  'reportId', 'requestedAt', 'runId', 'scheduledAt', 'sessionId', 'sourceRefs', 'startedAt', 'state',
  'status', 'successCriteria', 'taskId', 'tool', 'executionEngine', 'requestedExecutionEngine',
  'deliverable', 'format', 'acceptedAt', 'appliedAt', 'targetTaskId', 'revisionId', 'revisionNumber',
  'resolvedExecutionEngine', 'wikiArchiveStatus', 'wikiArchiveNote', 'proposedMemoryPinCount',
]);

const PUBLIC_WIKI_ARCHIVE_STATUSES = new Set(['written', 'skipped_no_wiki', 'failed']);

const PUBLIC_EXECUTION_ENGINES = new Set(['auto', 'hermes', 'local_llm', 'codex']);
const PUBLIC_RESOLVED_EXECUTION_ENGINES = new Set(['hermes', 'codex', 'claude', 'grok']);
const PUBLIC_DELIVERABLE_KINDS = new Set(['report', 'document', 'image', 'file']);

function projectExecutionContract(source = {}, projected = {}) {
  const executionEngine = String(source.executionEngine || '').trim();
  if (PUBLIC_EXECUTION_ENGINES.has(executionEngine)) projected.executionEngine = executionEngine;
  const resolvedExecutionEngine = String(source.resolvedExecutionEngine || '').trim();
  if (PUBLIC_RESOLVED_EXECUTION_ENGINES.has(resolvedExecutionEngine)) {
    projected.resolvedExecutionEngine = resolvedExecutionEngine;
  }
  const kind = String(source.deliverable?.kind || '').trim();
  if (PUBLIC_DELIVERABLE_KINDS.has(kind)) {
    projected.deliverable = {
      kind,
      format: publicText(source.deliverable?.format, '', 80),
    };
  }
  return projected;
}

function publicIdentifier(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(id)) return '';
  return publicText(id, '', 160) === id ? id : '';
}

function publicText(value, fallback = '', maximumLength = 6_000, options = {}) {
  return safePublicText(value, fallback, maximumLength, options);
}

function publicStringArray(values, maximumLength = 2_000) {
  return (Array.isArray(values) ? values : [])
    .map((value) => publicText(value, '', maximumLength))
    .filter(Boolean);
}

function publicTimestamp(value) {
  return publicText(value, '', 80);
}

function publicMetadata(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return publicText(value, '');
  if (Array.isArray(value)) {
    return value.map((item) => publicMetadata(item, depth + 1)).filter((item) => item !== undefined && item !== '');
  }
  if (typeof value !== 'object') return undefined;
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEY.test(key) || !PUBLIC_SESSION_METADATA_KEYS.has(key)) continue;
    const safe = publicMetadata(child, depth + 1);
    if (safe !== undefined && safe !== '') projected[key] = safe;
  }
  return projected;
}

function publicMissionRecord(mission = {}) {
  const id = publicIdentifier(mission.id);
  if (!id) return null;
  const projected = { id };
  for (const key of ['templateId', 'missionThreadId', 'workConversationId']) {
    const value = publicIdentifier(mission[key]);
    if (value) projected[key] = value;
  }
  projected.pendingRevisionId = publicIdentifier(mission.pendingRevisionId) || '';
  projected.currentResultReportId = publicIdentifier(mission.currentResultReportId) || '';
  for (const key of ['title', 'objective', 'status', 'timezone', 'planSummary', 'assignmentReason']) {
    const value = publicText(mission[key], '');
    if (value) projected[key] = value;
  }
  const delegationMode = String(mission.delegationMode || '').trim();
  if (delegationMode === 'mode_a' || delegationMode === 'mode_b') {
    projected.delegationMode = delegationMode;
  }
  projected.agentId = resolveRequestedOfficialProfile({ agentId: mission.agentId });
  projectExecutionContract(mission, projected);
  projected.successCriteria = publicStringArray(mission.successCriteria);
  projected.sources = publicStringArray(mission.sources, 200);
  projected.reportSchedule = {
    weekday: Math.min(6, Math.max(0, Number(mission.reportSchedule?.weekday) || 0)),
    hour: Math.min(23, Math.max(0, Number(mission.reportSchedule?.hour) || 0)),
    minute: Math.min(59, Math.max(0, Number(mission.reportSchedule?.minute) || 0)),
  };
  projected.policy = {
    maxRunsPerWeek: Math.max(0, Number(mission.policy?.maxRunsPerWeek) || 0),
    maxRuntimeMinutesPerWeek: Math.max(0, Number(mission.policy?.maxRuntimeMinutesPerWeek) || 0),
    ...(typeof mission.policy?.firstPlanRequiresApproval === 'boolean' ? { firstPlanRequiresApproval: mission.policy.firstPlanRequiresApproval } : {}),
    ...(typeof mission.policy?.newActionClassRequiresApproval === 'boolean' ? { newActionClassRequiresApproval: mission.policy.newActionClassRequiresApproval } : {}),
    ...(typeof mission.policy?.externalSideEffectsRequireApproval === 'boolean' ? { externalSideEffectsRequireApproval: mission.policy.externalSideEffectsRequireApproval } : {}),
    forbiddenActions: publicStringArray(mission.policy?.forbiddenActions, 200),
  };
  projected.budget = {
    usedRuns: Math.max(0, Number(mission.budget?.usedRuns) || 0),
    usedMinutes: Math.max(0, Number(mission.budget?.usedMinutes) || 0),
    weekStartedAt: publicTimestamp(mission.budget?.weekStartedAt),
  };
  projected.revisionCounter = Math.max(0, Number(mission.revisionCounter) || 0);
  for (const key of ['plannedAt', 'activatedAt', 'pausedAt', 'cancelledAt', 'completedAt', 'failedAt', 'createdAt', 'updatedAt']) {
    const value = publicTimestamp(mission[key]);
    if (value) projected[key] = value;
  }
  if (mission.wikiArchive && typeof mission.wikiArchive === 'object') {
    const status = String(mission.wikiArchive.status || '').trim();
    if (PUBLIC_WIKI_ARCHIVE_STATUSES.has(status)) {
      const relativePath = publicText(mission.wikiArchive.relativePath, '', 300);
      projected.wikiArchive = {
        status,
        relativePath: relativePath && !relativePath.includes('..') ? relativePath : '',
        archivedAt: publicTimestamp(mission.wikiArchive.archivedAt),
      };
    }
  }
  if (Array.isArray(mission.proposedMemoryPins) && mission.proposedMemoryPins.length) {
    projected.proposedMemoryPins = publicStringArray(mission.proposedMemoryPins, 200).slice(0, 3);
    projected.proposedMemoryPinCount = projected.proposedMemoryPins.length;
  }
  return projected;
}

function publicTaskRecord(task = {}) {
  const id = publicIdentifier(task.id);
  if (!id) return null;
  const projected = { id };
  for (const key of [
    'missionId', 'sessionId', 'createdByAgentId', 'runId', 'reportId', 'lastRunId',
    'revisionId', 'revisesTaskId', 'revisesReportId',
  ]) {
    const value = publicIdentifier(task[key]);
    if (value) projected[key] = value;
  }
  for (const key of [
    'title', 'original', 'owner', 'status', 'due', 'date', 'time', 'endDate', 'endTime',
    'startDate', 'dueDate', 'lane', 'tag', 'agent', 'model', 'priority', 'project', 'category',
    'list', 'body', 'notes', 'content', 'recurrence', 'repeat', 'repeatUntil', 'source', 'origin',
    'reason', 'expectedOutput', 'actionClass', 'approvalMode', 'blockedReason', 'failureCode', 'pauseMode', 'kind', 'type',
  ]) {
    const value = publicText(task[key], '');
    if (value) projected[key] = value;
  }
  if (projected.agent) projected.agent = resolveRequestedOfficialProfile({ agent: projected.agent });
  projectExecutionContract(task, projected);
  for (const key of ['scheduledAt', 'dueAt', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'retryScheduledAt']) {
    const value = publicTimestamp(task[key]);
    if (value) projected[key] = value;
  }
  for (const key of ['estimatedMinutes', 'attempt', 'revisionNumber']) {
    if (task[key] !== undefined && task[key] !== null) projected[key] = Math.max(0, Number(task[key]) || 0);
  }
  for (const key of ['executable', 'allDay']) {
    if (typeof task[key] === 'boolean') projected[key] = task[key];
  }
  projected.sourceRefs = publicStringArray(task.sourceRefs, 300);
  for (const key of ['tags', 'reminders', 'successCriteria', 'pendingInstructions']) {
    if (Array.isArray(task[key])) projected[key] = publicStringArray(task[key]);
  }
  return projected;
}

function publicSessionEventRecord(event = {}) {
  const projected = {};
  for (const key of ['id', 'sessionId']) {
    const value = publicIdentifier(event[key]);
    if (value) projected[key] = value;
  }
  const kind = publicText(event.kind, '', 80);
  if (kind) projected.kind = kind;
  const text = publicText(event.text, '', 8_000, { preserveRedactions: true });
  if (text) projected.text = text;
  if (event.sequence !== undefined) projected.sequence = Math.max(0, Number(event.sequence) || 0);
  const createdAt = publicTimestamp(event.createdAt);
  if (createdAt) projected.createdAt = createdAt;
  const metadata = publicMetadata(event.metadata);
  const actualEventEngine = ['agent_message', 'completion'].includes(event.kind)
    ? String(event.metadata?.resolvedExecutionEngine || event.metadata?.executionEngine || '').trim()
    : '';
  if (metadata && PUBLIC_RESOLVED_EXECUTION_ENGINES.has(actualEventEngine)) {
    metadata.resolvedExecutionEngine = actualEventEngine;
  }
  if (metadata && Object.keys(metadata).length) projected.metadata = metadata;
  return Object.keys(projected).length ? projected : null;
}

function publicSessionRecord(session = {}) {
  const id = publicIdentifier(session.id);
  if (!id) return null;
  const projected = { id };
  for (const key of ['missionId', 'taskId', 'revisionId', 'revisesTaskId', 'revisesReportId']) {
    const value = publicIdentifier(session[key]);
    if (value) projected[key] = value;
  }
  for (const key of ['type', 'title', 'status']) {
    const value = publicText(session[key], '');
    if (value) projected[key] = value;
  }
  projected.pendingInstructions = publicStringArray(session.pendingInstructions);
  if (session.revisionNumber !== undefined) {
    projected.revisionNumber = Math.max(0, Number(session.revisionNumber) || 0);
  }
  projectExecutionContract(session, projected);
  for (const key of ['createdAt', 'updatedAt', 'lastEventAt']) {
    const value = publicTimestamp(session[key]);
    if (value) projected[key] = value;
  }
  if (Array.isArray(session.events)) projected.events = session.events.map(publicSessionEventRecord).filter(Boolean);
  return projected;
}

function publicReportRecord(report = {}) {
  const safe = sanitizeAgentReport(report);
  const id = publicIdentifier(safe.id);
  if (!id) return null;
  const projected = { id };
  projectExecutionContract(safe, projected);
  for (const key of [
    'missionId', 'sessionId', 'taskId', 'revisionId', 'revisesTaskId', 'revisesReportId',
    'supersedesReportId', 'supersededByReportId',
  ]) {
    const value = publicIdentifier(safe[key]);
    if (value) projected[key] = value;
  }
  for (const key of ['title', 'status', 'deliveryStatus', 'deliveryError']) {
    const value = publicText(safe[key], '');
    if (value) projected[key] = value;
  }
  projected.findings = publicStringArray(safe.findings);
  projected.evidence = (Array.isArray(safe.evidence) ? safe.evidence : []).map((evidence) => ({
    label: publicText(evidence?.label, '', 300),
    url: /^https?:\/\//i.test(String(evidence?.url || '')) ? String(evidence.url).slice(0, 2_048) : '',
  })).filter((evidence) => evidence.label);
  projected.limitations = publicStringArray(safe.limitations);
  projected.followUps = (Array.isArray(safe.followUps) ? safe.followUps : []).map((followUp) => ({
    title: publicText(followUp?.title, '', 300),
    reason: publicText(followUp?.reason, ''),
  })).filter((followUp) => followUp.title);
  projected.followUpDecisions = (Array.isArray(safe.followUpDecisions) ? safe.followUpDecisions : []).map((decision) => ({
    index: Math.max(0, Number(decision?.index) || 0),
    title: publicText(decision?.title, '', 300),
    reason: publicText(decision?.reason, ''),
    decision: ['approved', 'rejected'].includes(String(decision?.decision)) ? String(decision.decision) : '',
    recordedAt: publicTimestamp(decision?.recordedAt),
  })).filter((decision) => decision.title && decision.decision);
  projected.budget = {
    usedRuns: Math.max(0, Number(safe.budget?.usedRuns) || 0),
    usedMinutes: Math.max(0, Number(safe.budget?.usedMinutes) || 0),
  };
  projected.useful = typeof safe.useful === 'boolean' ? safe.useful : null;
  if (safe.revisionNumber !== undefined) {
    projected.revisionNumber = Math.max(0, Number(safe.revisionNumber) || 0);
  }
  for (const key of ['createdAt', 'updatedAt', 'deliveredAt', 'deliveryFailedAt']) {
    const value = publicTimestamp(safe[key]);
    if (value) projected[key] = value;
  }
  return projected;
}

function publicDocumentRecord(document = {}) {
  const id = publicIdentifier(document.id);
  if (!id) return null;
  const projected = { id };
  for (const key of [
    'title', 'name', 'filename', 'mimeType', 'type', 'sizeLabel', 'ocrStatus', 'ocr', 'extractedText',
    'extract', 'summary', 'source', 'sourceLabel', 'wikiPath', 'provenance', 'provenanceLabel', 'assetUrl', 'previewUrl',
  ]) {
    const value = publicText(document[key], '', 100_000);
    if (value) projected[key] = value;
  }
  if (document.size !== undefined) projected.size = Math.max(0, Number(document.size) || 0);
  if (Array.isArray(document.tags)) projected.tags = publicStringArray(document.tags, 300);
  for (const key of ['evidenceVisible', 'isTestFixture']) {
    if (typeof document[key] === 'boolean') projected[key] = document[key];
  }
  for (const key of ['createdAt', 'updatedAt']) {
    const value = publicTimestamp(document[key]);
    if (value) projected[key] = value;
  }
  return projected;
}

function publicCommandInboxItemRecord(item = {}) {
  const id = publicIdentifier(item.id);
  if (!id) return null;
  const projected = { id };
  const runId = publicIdentifier(item.runId);
  if (runId) projected.runId = runId;
  for (const key of ['source', 'sourceLabel', 'title', 'text', 'status', 'detail', 'wikiPath']) {
    const value = publicText(item[key], '', 20_000);
    if (value) projected[key] = value;
  }
  const receivedAt = publicTimestamp(item.receivedAt);
  if (receivedAt) projected.receivedAt = receivedAt;
  if (item.seenCount !== undefined) projected.seenCount = Math.max(0, Number(item.seenCount) || 0);
  for (const key of ['starred', 'star']) {
    if (typeof item[key] === 'boolean') projected[key] = item[key];
  }
  return projected;
}

function publicMailMessageRecord(message = {}) {
  const id = publicIdentifier(message.id);
  if (!id) return null;
  const projected = { id };
  for (const key of [
    'accountId', 'provider', 'source', 'sourceLabel', 'from', 'email', 'subject', 'title',
    'text', 'body', 'preview',
  ]) {
    const value = publicText(message[key], '', 100_000);
    if (value) projected[key] = value;
  }
  const receivedAt = publicTimestamp(message.receivedAt);
  if (receivedAt) projected.receivedAt = receivedAt;
  for (const key of ['unread', 'read', 'starred', 'star']) {
    if (typeof message[key] === 'boolean') projected[key] = message[key];
  }
  return projected;
}

function publicCommandRouteRecord(command = {}) {
  const projected = {};
  for (const key of ['message', 'view', 'templateId', 'model', 'source', 'reason']) {
    const value = publicText(command[key], '', 20_000);
    if (value) projected[key] = value;
  }
  projected.agent = resolveRequestedOfficialProfile({ agent: command.agent });
  return projected;
}

function publicChatMessageRecord(message = {}) {
  const projected = {};
  for (const key of ['id', 'runId']) {
    const value = publicIdentifier(message[key]);
    if (value) projected[key] = value;
  }
  for (const key of ['role', 'text', 'agent', 'model', 'source', 'target', 'wikiPath']) {
    const value = publicText(message[key], '', 100_000);
    if (value) projected[key] = value;
  }
  const createdAt = publicTimestamp(message.createdAt);
  if (createdAt) projected.createdAt = createdAt;
  return Object.keys(projected).length ? projected : null;
}

function publicActivitySessionRecord(session = {}) {
  const projected = {};
  const id = publicIdentifier(session.id);
  if (id) projected.id = id;
  for (const key of ['time', 'text', 'title', 'state', 'status']) {
    const value = publicText(session[key], '');
    if (value) projected[key] = value;
  }
  return Object.keys(projected).length ? projected : null;
}

function publicSchedulerResult(result = {}) {
  const projected = {};
  const checkedAt = publicTimestamp(result.checkedAt);
  if (checkedAt) projected.checkedAt = checkedAt;
  if (typeof result.skipped === 'boolean') projected.skipped = result.skipped;
  const reason = publicText(result.reason, '');
  if (reason) projected.reason = reason;
  for (const key of ['startedTaskIds', 'completedTaskIds', 'blockedTaskIds', 'failedTaskIds', 'cancelledTaskIds', 'createdReportIds']) {
    projected[key] = (Array.isArray(result[key]) ? result[key] : []).map(publicIdentifier).filter(Boolean);
  }
  return projected;
}

function publicDaemonRecord(daemon = {}) {
  const projected = {
    running: daemon.running === true,
    isTicking: daemon.isTicking === true,
    intervalMs: Math.max(0, Number(daemon.intervalMs) || 0),
    lastError: publicText(daemon.lastError, '') || null,
  };
  if (daemon.lastRun && typeof daemon.lastRun === 'object' && !Array.isArray(daemon.lastRun)) {
    projected.lastRun = {
      checkedAt: publicTimestamp(daemon.lastRun.checkedAt) || null,
      createdRuns: Math.max(0, Number(daemon.lastRun.createdRuns) || 0),
    };
  } else {
    projected.lastRun = publicTimestamp(daemon.lastRun) || null;
  }
  return projected;
}

function publicDeliveryRecord(delivery = {}) {
  const projected = {};
  for (const key of ['status', 'applicationMode']) {
    const value = publicText(delivery[key], '', 100);
    if (value) projected[key] = value;
  }
  for (const key of ['acceptedAt', 'appliedAt']) {
    const value = publicTimestamp(delivery[key]);
    if (value) projected[key] = value;
  }
  for (const key of ['targetTaskId', 'revisionId']) {
    const value = publicIdentifier(delivery[key]);
    if (value) projected[key] = value;
  }
  return projected;
}

function projectAgentOperationsResponse(body = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const projected = {};
  if (typeof source.ok === 'boolean') projected.ok = source.ok;
  for (const key of ['error', 'message']) {
    if (key === 'message' && typeof source[key] === 'object') continue;
    const value = publicText(source[key], '');
    if (value) projected[key] = value;
  }
  if (source.mission) projected.mission = publicMissionRecord(source.mission);
  if (source.work) projected.work = publicMissionRecord(source.work);
  if (source.task) projected.task = publicTaskRecord(source.task);
  if (source.session) projected.session = publicSessionRecord(source.session);
  if (source.conversation) projected.conversation = publicSessionRecord(source.conversation);
  if (source.message && typeof source.message === 'object') {
    projected.message = publicSessionEventRecord(source.message);
  }
  if (source.delivery) projected.delivery = publicDeliveryRecord(source.delivery);
  if (Array.isArray(source.checkpoints)) {
    projected.checkpoints = source.checkpoints.map(publicSessionEventRecord).filter(Boolean);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'nextCursor')) {
    projected.nextCursor = source.nextCursor === null
      ? null
      : (/^[A-Za-z0-9_-]{1,1000}$/.test(String(source.nextCursor || ''))
        ? String(source.nextCursor)
        : '');
  }
  if (source.report) projected.report = publicReportRecord(source.report);
  if (Array.isArray(source.missions)) projected.missions = source.missions.map(publicMissionRecord).filter(Boolean);
  if (Array.isArray(source.tasks)) projected.tasks = source.tasks.map(publicTaskRecord).filter(Boolean);
  if (Array.isArray(source.sessions)) projected.sessions = source.sessions.map(publicSessionRecord).filter(Boolean);
  if (Array.isArray(source.reports)) projected.reports = source.reports.map(publicReportRecord).filter(Boolean);
  if (source.daemon) projected.daemon = publicDaemonRecord(source.daemon);
  if (source.tick) projected.tick = publicSchedulerResult(source.tick);
  if (source.run) projected.run = publicSchedulerResult(source.run);
  if (typeof source.accepted === 'boolean') projected.accepted = source.accepted;
  if (source.acceptedAt) projected.acceptedAt = publicTimestamp(source.acceptedAt);
  if (source.taskId) projected.taskId = publicIdentifier(source.taskId);
  if (typeof source.idempotentReplay === 'boolean') {
    projected.idempotentReplay = source.idempotentReplay;
  }
  return projected;
}

function projectUnknownPublicJson(value, key = '', depth = 0) {
  if (depth > 5 || value === null || value === undefined || DANGEROUS_KEY.test(key)) return undefined;
  if (key === 'task') return publicTaskRecord(value);
  if (key === 'mission') return publicMissionRecord(value);
  if (key === 'session') return publicSessionRecord(value);
  if (key === 'report') return publicReportRecord(value);
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return publicText(value, '');
  if (Array.isArray(value)) {
    return value.map((item) => projectUnknownPublicJson(item, key, depth + 1)).filter((item) => item !== undefined && item !== '');
  }
  if (typeof value !== 'object') return undefined;
  const projected = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (DANGEROUS_KEY.test(childKey)) continue;
    if (!PUBLIC_SCALAR_KEYS.has(childKey) && ![
      'agent', 'agents', 'channels', 'data', 'event', 'events', 'items', 'job', 'jobs', 'logs',
      'messages', 'metrics', 'mission', 'missions', 'profileRequest', 'report', 'reports', 'result',
      'run', 'runs', 'session', 'sessions', 'settings', 'skills', 'task', 'tasks', 'tools',
    ].includes(childKey)) continue;
    const safe = projectUnknownPublicJson(child, childKey, depth + 1);
    if (safe !== undefined && safe !== '') projected[childKey] = safe;
  }
  return projected;
}

module.exports = {
  projectAgentOperationsResponse,
  projectUnknownPublicJson,
  publicActivitySessionRecord,
  publicChatMessageRecord,
  publicCommandInboxItemRecord,
  publicCommandRouteRecord,
  publicDaemonRecord,
  publicDocumentRecord,
  publicMailMessageRecord,
  publicMissionRecord,
  publicReportRecord,
  publicSchedulerResult,
  publicSessionEventRecord,
  publicSessionRecord,
  publicTaskRecord,
};
