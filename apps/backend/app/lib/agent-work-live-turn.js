const { sanitizeSessionEvent } = require('./agent-operations-domain');
const { AgentWorkContractError } = require('./agent-work-contract');
const { publicSessionEventRecord } = require('./public-agent-records');

class AgentWorkLiveTurnError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AgentWorkLiveTurnError';
    this.code = code;
    this.status = status;
  }
}

function missionThread(store, missionId) {
  const state = store.getState();
  const mission = state.agentMissions.find((item) => item.id === missionId);
  if (!mission) throw new AgentWorkLiveTurnError('work_not_found', 'Delegated work was not found', 404);
  const session = state.agentSessions.find((item) => (
    item.id === mission.missionThreadId && item.missionId === mission.id && item.type === 'mission-thread'
  ));
  if (!session) {
    throw new AgentWorkLiveTurnError('work_persistence_incomplete', 'Work Conversation was not found', 500);
  }
  return { mission, session, state };
}

function initialMessage(state, sessionId) {
  return state.agentSessionEvents
    .filter((event) => event.sessionId === sessionId && event.kind === 'user_message')
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))[0] || null;
}

function terminalResponseAlreadyStored(state, sessionId, messageId) {
  return state.agentSessionEvents.find((event) => (
    event.sessionId === sessionId
    && ['agent_message', 'error'].includes(event.kind)
    && event.metadata?.liveTurnMessageId === messageId
  )) || null;
}

function publicCheckpoint(event) {
  return publicSessionEventRecord(event) || {
    id: String(event?.id || ''),
    sessionId: String(event?.sessionId || ''),
    kind: 'error',
    text: '작업 대화 이벤트를 표시할 수 없습니다.',
    sequence: Number(event?.sequence || 0),
    createdAt: String(event?.createdAt || ''),
  };
}

function liveTurnMessages({ mission, state, sessionId }) {
  const transcript = state.agentSessionEvents
    .filter((event) => event.sessionId === sessionId && ['user_message', 'agent_message'].includes(event.kind))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(-24)
    .map((event) => ({
      role: event.kind === 'agent_message' ? 'assistant' : 'user',
      content: sanitizeSessionEvent({ kind: event.kind, text: event.text }).text,
    }))
    .filter((message) => message.content);
  return [
    {
      role: 'system',
      content: [
        'You are the responsible Agent Calendar work assistant.',
        'Answer the user directly with concise, useful Korean progress or clarification.',
        'This is a bounded internal task. Do not perform external side effects, invent artifacts, expose private reasoning, raw tools, credentials, or private paths.',
        `Work title: ${mission.title}`,
        `Work objective: ${mission.objective}`,
      ].join('\n'),
    },
    ...transcript,
  ];
}

function isLiveReplyEligible(result) {
  return result.delivery?.status === 'accepted'
    && result.delivery?.applicationMode === 'mission_context';
}

async function streamWorkTurn({
  store,
  clock = () => new Date(),
  missionId,
  input = {},
  addMessage,
  completion,
  resolveAgentAvailability = null,
  onEvent = async () => {},
} = {}) {
  if (typeof addMessage !== 'function') {
    throw new AgentWorkLiveTurnError('work_turn_unavailable', 'Live Work Conversation is unavailable', 503);
  }
  if (typeof completion !== 'function') {
    throw new AgentWorkLiveTurnError('runtime_unavailable', 'Live Agent runtime is unavailable', 503);
  }

  let context = missionThread(store, missionId);
  let result;
  if (input.initial === true) {
    const message = initialMessage(context.state, context.session.id);
    if (!message) {
      throw new AgentWorkLiveTurnError('work_persistence_incomplete', 'Initial Work Conversation message was not found', 500);
    }
    result = {
      message,
      delivery: {
        status: String(message.metadata?.deliveryStatus || 'accepted'),
        applicationMode: String(message.metadata?.applicationMode || 'mission_context'),
        acceptedAt: String(message.metadata?.acceptedAt || message.createdAt || ''),
      },
      idempotentReplay: true,
    };
  } else {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AgentWorkLiveTurnError('work_turn_invalid', 'Live Work Conversation message is invalid', 422);
    }
    result = await addMessage(missionId, {
      clientMessageId: input.clientMessageId,
      text: input.text,
    });
    context = missionThread(store, missionId);
  }

  await onEvent({
    type: 'accepted',
    message: publicCheckpoint(result.message),
    delivery: result.delivery,
    idempotentReplay: result.idempotentReplay === true,
  });

  if (!isLiveReplyEligible(result)) {
    await onEvent({ type: 'done', idempotentReplay: result.idempotentReplay === true });
    return result;
  }

  const alreadyStored = terminalResponseAlreadyStored(context.state, context.session.id, result.message.id);
  if (alreadyStored) {
    await onEvent({ type: 'checkpoint', checkpoint: publicCheckpoint(alreadyStored) });
    await onEvent({ type: 'done', idempotentReplay: true });
    return { ...result, response: alreadyStored, idempotentReplay: true };
  }

  if (typeof resolveAgentAvailability === 'function') {
    const availability = await resolveAgentAvailability({ mission: context.mission });
    if (availability?.available === false) {
      const code = String(availability.code || 'agent_unavailable');
      const safeError = sanitizeSessionEvent({
        kind: 'error',
        text: String(availability.message || '담당 에이전트가 현재 준비되지 않아 응답을 시작하지 않았습니다. 준비된 뒤 다시 시도해 주세요.'),
        metadata: {
          code,
          source: 'live_work_turn',
          liveTurnMessageId: result.message.id,
          agentId: context.mission.agentId,
          agentStatus: String(availability.status || 'unavailable'),
        },
        createdAt: clock().toISOString(),
      });
      const stored = store.appendAgentSessionEvent(context.session.id, safeError);
      await onEvent({ type: 'checkpoint', checkpoint: publicCheckpoint(stored) });
      await onEvent({ type: 'error', code, message: publicCheckpoint(stored).text });
      await onEvent({ type: 'done', idempotentReplay: result.idempotentReplay === true });
      return { ...result, error: stored };
    }
  }

  let streamedText = '';
  const persistProgress = async (event) => {
    const safe = sanitizeSessionEvent(event);
    const relayEvent = String(safe.metadata?.relayEvent || '').toLowerCase();
    if (relayEvent) return;
    if (!['progress', 'plan', 'approval_request', 'approval_response', 'blocked'].includes(safe.kind)) return;
    const stored = store.appendAgentSessionEvent(context.session.id, safe);
    await onEvent({ type: 'checkpoint', checkpoint: publicCheckpoint(stored) });
  };
  try {
    const runtime = await completion({
      payload: {
        profile: context.mission.agentId,
        executionEngine: context.mission.executionEngine || 'hermes',
        deliverable: context.mission.deliverable || { kind: 'report', format: 'markdown' },
        stream: true,
        messages: liveTurnMessages(context),
      },
      meta: {
        missionId: context.mission.id,
        sessionId: context.session.id,
        agentId: context.mission.agentId,
        executionEngine: context.mission.executionEngine || 'hermes',
        deliverable: context.mission.deliverable || { kind: 'report', format: 'markdown' },
        idempotencyKey: `live:${context.mission.id}:${result.message.id}`,
      },
      onEvent: async (event) => {
        const safe = sanitizeSessionEvent(event);
        if (safe.kind === 'agent_message' && safe.text) {
          streamedText += safe.text;
          await onEvent({ type: 'delta', text: safe.text });
          return;
        }
        await persistProgress(safe);
      },
    });
    const finalText = sanitizeSessionEvent({ kind: 'agent_message', text: runtime?.text }).text;
    if (!finalText) {
      throw new AgentWorkLiveTurnError('output_invalid', 'Live Agent runtime returned no response', 502);
    }
    if (!streamedText && finalText) await onEvent({ type: 'delta', text: finalText });
    const stored = store.appendAgentSessionEvent(context.session.id, sanitizeSessionEvent({
      kind: 'agent_message',
      text: finalText,
      metadata: {
        source: 'live_work_turn',
        liveTurnMessageId: result.message.id,
        jobId: runtime?.jobId || '',
        requestedExecutionEngine: context.mission.executionEngine || 'hermes',
        executionEngine: runtime?.executionEngine || context.mission.executionEngine || 'hermes',
        ...(runtime?.executionEngine === 'hermes' || runtime?.executionEngine === 'codex'
          ? { resolvedExecutionEngine: runtime.executionEngine }
          : {}),
      },
      createdAt: clock().toISOString(),
    }));
    const latestMission = missionThread(store, context.mission.id).mission;
    if (latestMission.status === 'draft') {
      store.updateAgentMission(context.mission.id, { status: 'active' });
    }
    await onEvent({ type: 'checkpoint', checkpoint: publicCheckpoint(stored) });
    await onEvent({ type: 'done', idempotentReplay: false });
    return { ...result, response: stored };
  } catch (error) {
    const safeError = sanitizeSessionEvent({
      kind: 'error',
      text: error instanceof Error ? error.message : 'Live Agent runtime failed',
      metadata: { code: error?.code || 'live_turn_failed' },
      createdAt: clock().toISOString(),
    });
    const stored = store.appendAgentSessionEvent(context.session.id, safeError);
    await onEvent({ type: 'checkpoint', checkpoint: publicCheckpoint(stored) });
    await onEvent({
      type: 'error',
      code: String(error?.code || 'live_turn_failed'),
      message: publicCheckpoint(stored).text,
    });
    await onEvent({ type: 'done', idempotentReplay: false });
    return { ...result, error: stored };
  }
}

module.exports = {
  AgentWorkLiveTurnError,
  streamWorkTurn,
};
