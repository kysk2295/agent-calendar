const {
  publicMissionRecord,
  publicSessionEventRecord,
  publicSessionRecord,
} = require('./public-agent-records');

const SAFE_CHECKPOINT_KINDS = new Set([
  'user_message',
  'agent_message',
  'plan',
  'approval_request',
  'approval_response',
  'progress',
  'artifact',
  'error',
  'completion',
  'revision_started',
  'revision_completed',
  'blocked',
]);

class AgentWorkConversationError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AgentWorkConversationError';
    this.code = code;
    this.status = status;
  }
}

function checkpointKey(checkpoint) {
  return [
    String(checkpoint.createdAt || ''),
    Number.isSafeInteger(checkpoint.sequence) ? checkpoint.sequence : 0,
    String(checkpoint.id || ''),
  ];
}

function compareCheckpoint(left, right) {
  const [leftTime, leftSequence, leftId] = checkpointKey(left);
  const [rightTime, rightSequence, rightId] = checkpointKey(right);
  return leftTime.localeCompare(rightTime)
    || leftSequence - rightSequence
    || leftId.localeCompare(rightId);
}

function encodeCursor(checkpoint) {
  return Buffer.from(JSON.stringify(checkpointKey(checkpoint)), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (
      !Array.isArray(decoded)
      || !(
        (decoded.length === 3
          && typeof decoded[0] === 'string'
          && Number.isSafeInteger(decoded[1])
          && typeof decoded[2] === 'string')
        || (decoded.length === 2 && decoded.every((item) => typeof item === 'string'))
      )
      || Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url') !== value
    ) {
      throw new Error('invalid cursor');
    }
    return decoded;
  } catch {
    throw new AgentWorkConversationError(
      'conversation_cursor_invalid',
      'Work Conversation cursor is invalid',
      422,
    );
  }
}

function parseLimit(value) {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new AgentWorkConversationError(
      'conversation_limit_invalid',
      'Work Conversation limit must be an integer from 1 to 200',
      422,
    );
  }
  return limit;
}

function cursorMatchesCheckpoint(checkpoint, cursorKey) {
  if (cursorKey.length === 2) {
    return checkpoint.createdAt === cursorKey[0] && checkpoint.id === cursorKey[1];
  }
  const [timestamp, sequence, id] = checkpointKey(checkpoint);
  return timestamp === cursorKey[0] && sequence === cursorKey[1] && id === cursorKey[2];
}

function resolvedExecutionEngine(state, mission) {
  const allowed = new Set(['hermes', 'codex']);
  const currentReport = state.agentReports.find((report) => report.id === mission.currentResultReportId);
  const taskIds = new Set(state.tasks.filter((task) => task.missionId === mission.id).map((task) => task.id));
  const sessionIds = new Set(state.agentSessions
    .filter((session) => session.missionId === mission.id)
    .map((session) => session.id));
  const candidates = [
    currentReport?.resolvedExecutionEngine,
    ...state.tasks
      .filter((task) => taskIds.has(task.id))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .map((task) => task.resolvedExecutionEngine),
    ...state.agentSessionEvents
      .filter((event) => sessionIds.has(event.sessionId) && ['agent_message', 'completion'].includes(event.kind))
      .sort(compareCheckpoint)
      .reverse()
      .flatMap((event) => [event.metadata?.resolvedExecutionEngine, event.metadata?.executionEngine]),
  ];
  return candidates.find((engine) => allowed.has(String(engine || '').trim())) || '';
}

function readWorkConversation({ store, missionId, cursor, limit } = {}) {
  const state = store.getState();
  const mission = state.agentMissions.find((item) => item.id === missionId);
  if (!mission) {
    throw new AgentWorkConversationError('work_not_found', 'Delegated work was not found', 404);
  }
  const conversation = state.agentSessions.find((session) => (
    session.id === mission.missionThreadId
    && session.missionId === mission.id
    && session.type === 'mission-thread'
  ));
  if (!conversation) {
    throw new AgentWorkConversationError(
      'work_persistence_incomplete',
      'Work Conversation was not found',
      500,
    );
  }
  const cursorKey = decodeCursor(cursor);
  const pageSize = parseLimit(limit);
  const sessionIds = new Set(
    state.agentSessions
      .filter((session) => session.missionId === mission.id)
      .map((session) => session.id),
  );
  const checkpoints = state.agentSessionEvents
    .filter((event) => sessionIds.has(event.sessionId) && SAFE_CHECKPOINT_KINDS.has(event.kind))
    .map(publicSessionEventRecord)
    .filter(Boolean)
    .sort(compareCheckpoint);
  const cursorCheckpoint = cursorKey
    ? checkpoints.find((checkpoint) => cursorMatchesCheckpoint(checkpoint, cursorKey))
    : null;
  if (cursorKey && !cursorCheckpoint) {
    throw new AgentWorkConversationError(
      'conversation_cursor_invalid',
      'Work Conversation cursor does not belong to this conversation',
      422,
    );
  }
  const remainingCheckpoints = checkpoints
    .filter((checkpoint) => !cursorCheckpoint || compareCheckpoint(checkpoint, cursorCheckpoint) > 0);
  const page = remainingCheckpoints.slice(0, pageSize);
  return {
    work: publicMissionRecord({
      ...mission,
      ...(resolvedExecutionEngine(state, mission)
        ? { resolvedExecutionEngine: resolvedExecutionEngine(state, mission) }
        : {}),
    }),
    conversation: publicSessionRecord(conversation),
    checkpoints: page,
    nextCursor: remainingCheckpoints.length > page.length ? encodeCursor(page.at(-1)) : null,
  };
}

module.exports = {
  AgentWorkConversationError,
  SAFE_CHECKPOINT_KINDS,
  readWorkConversation,
};
