const crypto = require('node:crypto');

const {
  DELIVERABLE_KINDS,
  EXECUTION_ENGINES,
  createGeneralAgentMission,
  createWeeklyOpportunityMission,
} = require('./agent-operations-domain');
const { isOfficialProfileName } = require('./official-profiles');

class AgentWorkContractError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'AgentWorkContractError';
    this.code = code;
    this.status = status;
  }
}

function boundedText(value, field, maximumLength, { required = true } = {}) {
  if (typeof value !== 'string') {
    throw new AgentWorkContractError('work_request_invalid', `${field} must be a string`);
  }
  const text = value.trim();
  if (required && !text) {
    throw new AgentWorkContractError('work_request_invalid', `${field} is required`);
  }
  if (text.length > maximumLength) {
    throw new AgentWorkContractError(
      'work_request_invalid',
      `${field} must be at most ${maximumLength} characters`,
    );
  }
  return text;
}

function deterministicId(prefix, source) {
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function assignedAgent(input) {
  const explicit = input.agentId.trim();
  if (explicit) {
    if (!isOfficialProfileName(explicit)) {
      throw new AgentWorkContractError('agent_invalid', 'Agent must be an official profile');
    }
    return { agentId: explicit, assignmentReason: `explicit:${explicit}` };
  }
  const outcome = `${input.title}\n${input.objective}`.toLowerCase();
  if (/(?:wiki|knowledge|document|위키|지식|문서)/i.test(outcome)) {
    return { agentId: 'wikicurator', assignmentReason: 'keyword:wikicurator' };
  }
  if (/(?:market|business|competitor|research|시장|사업|경쟁|조사)/i.test(outcome)) {
    return { agentId: 'bizconsultant', assignmentReason: 'keyword:bizconsultant' };
  }
  return { agentId: 'default', assignmentReason: 'default:official' };
}

function normalizeDeliverable(value) {
  if (
    value !== undefined
    && (!value || typeof value !== 'object' || Array.isArray(value))
  ) {
    throw new AgentWorkContractError('work_request_invalid', 'deliverable must be an object');
  }
  const source = value || {};
  const kind = boundedText(source.kind === undefined ? 'report' : source.kind, 'deliverable.kind', 80);
  if (!DELIVERABLE_KINDS.includes(kind)) {
    throw new AgentWorkContractError(
      'deliverable_invalid',
      'Deliverable kind must be report, document, image, or file',
    );
  }
  return {
    kind,
    format: boundedText(
      source.format === undefined ? (kind === 'report' ? 'markdown' : '') : source.format,
      'deliverable.format',
      80,
      { required: false },
    ),
  };
}

function normalizeWorkRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentWorkContractError('work_request_invalid', 'Work request body must be an object');
  }
  const clientRequestId = boundedText(input.clientRequestId, 'clientRequestId', 200);
  const templateId = boundedText(
    input.templateId === undefined ? 'general-agent-work' : input.templateId,
    'templateId',
    80,
  );
  if (!['weekly-opportunity-brief', 'general-agent-work'].includes(templateId)) {
    throw new AgentWorkContractError('template_not_found', 'Agent mission template was not found');
  }
  const title = boundedText(input.title, 'title', 300);
  const objective = boundedText(input.objective, 'objective', 6_000);
  const initialMessage = boundedText(input.initialMessage, 'initialMessage', 8_000);
  const executionEngine = boundedText(
    input.executionEngine === undefined ? 'auto' : input.executionEngine,
    'executionEngine',
    80,
  );
  if (!EXECUTION_ENGINES.includes(executionEngine)) {
    throw new AgentWorkContractError(
      'execution_engine_invalid',
      'Execution engine must be auto, hermes, local_llm, or codex',
    );
  }
  const deliverable = normalizeDeliverable(input.deliverable);
  const agentId = boundedText(
    input.agentId === undefined ? '' : input.agentId,
    'agentId',
    80,
    { required: false },
  );
  const assignment = assignedAgent({ title, objective, agentId });
  return {
    clientRequestId,
    templateId,
    title,
    objective,
    initialMessage,
    executionEngine,
    deliverable,
    ...assignment,
  };
}

function prepareDelegatedWork(input = {}, clock = () => new Date()) {
  const normalized = normalizeWorkRequest(input);
  const now = clock().toISOString();
  const missionId = deterministicId('mission-work', normalized.clientRequestId);
  const conversationId = deterministicId('mission-thread', normalized.clientRequestId);
  const messageId = deterministicId('session-event', `${normalized.clientRequestId}:initial`);
  const requestFingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
  const missionTemplate = normalized.templateId === 'general-agent-work'
    ? createGeneralAgentMission({
      id: missionId,
      title: normalized.title,
      objective: normalized.objective,
      agentId: normalized.agentId,
      executionEngine: normalized.executionEngine,
      deliverable: normalized.deliverable,
      clock,
    })
    : {
      ...createWeeklyOpportunityMission({ id: missionId, clock }),
      title: normalized.title,
      objective: normalized.objective,
      agentId: normalized.agentId,
      executionEngine: normalized.executionEngine,
      deliverable: normalized.deliverable,
    };
  const mission = {
    ...missionTemplate,
    clientRequestId: normalized.clientRequestId,
    requestFingerprint,
    missionThreadId: conversationId,
    workConversationId: conversationId,
    assignmentReason: normalized.assignmentReason,
    revisionCounter: 0,
    pendingRevisionId: '',
    currentResultReportId: '',
  };
  const conversation = {
    id: conversationId,
    missionId,
    taskId: '',
    type: 'mission-thread',
    title: normalized.title,
    status: 'draft',
    pendingInstructions: [],
    createdAt: now,
    updatedAt: now,
    lastEventAt: now,
  };
  const message = {
    id: messageId,
    sessionId: conversationId,
    sequence: 1,
    kind: 'user_message',
    text: normalized.initialMessage,
    createdAt: now,
    metadata: {
      clientMessageId: `${normalized.clientRequestId}:initial`,
      deliveryStatus: 'accepted',
      applicationMode: 'mission_context',
      acceptedAt: now,
    },
  };
  return { mission, conversation, message };
}

function prepareWorkMessage({ missionId, clientMessageId, text, clock = () => new Date() } = {}) {
  let normalizedMissionId;
  let normalizedClientMessageId;
  let normalizedText;
  try {
    normalizedMissionId = boundedText(missionId, 'missionId', 160);
    normalizedClientMessageId = boundedText(clientMessageId, 'clientMessageId', 200);
    normalizedText = boundedText(text, 'text', 8_000);
  } catch (error) {
    if (error instanceof AgentWorkContractError) {
      throw new AgentWorkContractError('work_message_invalid', error.message);
    }
    throw error;
  }
  const acceptedAt = clock().toISOString();
  return {
    missionId: normalizedMissionId,
    clientMessageId: normalizedClientMessageId,
    eventId: deterministicId(
      'session-event',
      `${normalizedMissionId}:${normalizedClientMessageId}`,
    ),
    text: normalizedText,
    acceptedAt,
  };
}

module.exports = {
  AgentWorkContractError,
  prepareDelegatedWork,
  prepareWorkMessage,
};
