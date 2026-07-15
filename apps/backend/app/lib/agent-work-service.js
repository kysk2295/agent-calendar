const { sanitizeSessionEvent } = require('./agent-operations-domain');
const {
  AgentWorkContractError,
  prepareDelegatedWork,
  prepareWorkMessage,
} = require('./agent-work-contract');
const {
  AgentWorkConversationError,
  readWorkConversation,
} = require('./agent-work-conversation');
const {
  AgentWorkDeliveryError,
  classifyWorkDelivery,
  deliveryFromEvent,
  isUnsupportedExternalRequest,
} = require('./agent-work-delivery');
const {
  AgentWorkRevisionError,
  classifyRevisionIntent,
  createRevisionAttempt,
} = require('./agent-work-revision');

async function createWork({ store, clock, input } = {}) {
  if (
    isUnsupportedExternalRequest(input?.title)
    || isUnsupportedExternalRequest(input?.objective)
    || isUnsupportedExternalRequest(input?.initialMessage)
  ) {
    throw new AgentWorkDeliveryError(
      'unsupported_external_request',
      'External side effects are not supported by Delegated Work',
      422,
    );
  }
  const records = prepareDelegatedWork(input, clock);
  const result = await store.createDelegatedWork(records);
  return {
    work: result.mission,
    conversation: result.conversation,
    message: result.message,
    idempotentReplay: result.idempotentReplay,
  };
}

function classifyMessage(store, missionId, text) {
  let decision = classifyWorkDelivery({ state: store.getState(), missionId, text });
  const revisionIntent = decision.kind === 'ordinary' ? classifyRevisionIntent(text) : '';
  if (revisionIntent === 'follow_up') {
    decision = {
      kind: 'follow_up',
      delivery: { status: 'rejected', applicationMode: 'follow_up_required' },
    };
  }
  if (revisionIntent === 'revision') {
    decision = {
      kind: 'revision',
      delivery: { status: 'accepted', applicationMode: 'revision' },
    };
  }
  return decision;
}

function replayedMessage(store, message) {
  const existing = store.getDelegatedWorkMessage(message.missionId, message.clientMessageId);
  if (!existing) return null;
  if (existing.text !== message.text) {
    throw new AgentWorkContractError(
      'work_message_idempotency_conflict',
      'clientMessageId was already used for different text',
      409,
    );
  }
  return {
    message: existing,
    delivery: deliveryFromEvent(existing),
    idempotentReplay: true,
  };
}

async function applyRevision({ store, clock, missionId, message, decision } = {}) {
  const attempt = await createRevisionAttempt({
    store,
    missionId,
    instruction: message.text,
    message,
    delivery: decision.delivery,
    clock,
  });
  return {
    message: attempt.message,
    delivery: deliveryFromEvent(attempt.message),
    idempotentReplay: attempt.idempotentReplay,
  };
}

function applyCommand({ store, clock, transitionTask, decision, stored } = {}) {
  transitionTask(decision.target.id, decision.action);
  const actionMessage = store.updateAgentSessionEvent(stored.message.id, {
    metadata: {
      ...(stored.message.metadata || {}),
      action: decision.action,
      ...(decision.deferred ? {} : {
        deliveryStatus: 'applied',
        appliedAt: clock().toISOString(),
      }),
    },
  });
  return {
    ...stored,
    message: actionMessage,
    delivery: deliveryFromEvent(actionMessage),
  };
}

async function addWorkMessage({ store, clock, missionId, input, transitionTask } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentWorkContractError('work_message_invalid', 'Work message body must be an object');
  }
  const message = prepareWorkMessage({
    missionId,
    clientMessageId: input.clientMessageId,
    text: input.text,
    clock,
  });
  const hasLocalWork = store.getState().agentMissions.some((mission) => mission.id === missionId);
  if (!hasLocalWork && typeof store.refreshAgentWork === 'function') {
    await store.refreshAgentWork(missionId);
  }
  const replay = replayedMessage(store, message);
  if (replay) return replay;
  const decision = classifyMessage(store, missionId, message.text);
  if (decision.kind === 'revision') {
    return applyRevision({ store, clock, missionId, message, decision });
  }
  if (decision.kind === 'command' && typeof store.applyDelegatedWorkCommand === 'function') {
    return await store.applyDelegatedWorkCommand(
      { ...message, delivery: decision.delivery },
      (stored) => applyCommand({ store, clock, transitionTask, decision, stored }),
    );
  }
  const stored = await store.addDelegatedWorkMessage({ ...message, delivery: decision.delivery });
  if (decision.kind === 'unsupported_external') {
    store.appendAgentSessionEvent(stored.message.sessionId, sanitizeSessionEvent({
      id: `${stored.message.id}-blocked`,
      kind: 'blocked',
      text: '요청한 외부 작업은 현재 지원되지 않아 실행하지 않았습니다.',
      createdAt: message.acceptedAt,
      metadata: {
        code: 'unsupported_external_request',
        applicationMode: 'unsupported_external_request',
      },
    }));
  }
  return stored;
}

function getWorkConversation({ store, missionId, options } = {}) {
  const read = () => readWorkConversation({
    store,
    missionId,
    cursor: options.cursor,
    limit: options.limit,
  });
  if (typeof store.refreshAgentWork !== 'function') return read();
  const refreshed = store.refreshAgentWork(missionId);
  return refreshed && typeof refreshed.then === 'function' ? refreshed.then(read) : read();
}

function isAgentWorkError(error) {
  return error instanceof AgentWorkContractError
    || error instanceof AgentWorkConversationError
    || error instanceof AgentWorkDeliveryError
    || error instanceof AgentWorkRevisionError;
}

module.exports = {
  addWorkMessage,
  createWork,
  getWorkConversation,
  isAgentWorkError,
};
