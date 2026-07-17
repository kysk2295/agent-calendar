const SESSION_TURN_EVENT_FIELDS = Object.freeze({
  accepted: Object.freeze(['type', 'requestId', 'provider', 'model', 'sessionVersion', 'queued']),
  delta: Object.freeze(['type', 'requestId', 'sequence', 'text']),
  'tool-status': Object.freeze(['type', 'requestId', 'label']),
  completed: Object.freeze(['type', 'requestId', 'text', 'provider', 'model', 'sessionVersion']),
  failed: Object.freeze(['type', 'requestId', 'code', 'retryable']),
});

function sessionTurnError(code, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.retryable = Boolean(retryable);
  return error;
}

function validateSessionTurnPayload(payload = {}) {
  const keys = Object.keys(payload).sort();
  const calendar = payload.profile === 'calendarassistant';
  const expectedKeys = calendar
    ? ['context', 'conversationId', 'message', 'profile', 'requestId']
    : ['conversationId', 'message', 'profile', 'requestId'];
  const contextText = calendar ? JSON.stringify(payload.context || null) : '';
  const valid = JSON.stringify(keys) === JSON.stringify(expectedKeys)
    && ['wikicurator', 'calendarassistant'].includes(payload.profile)
    && typeof payload.message === 'string'
    && Boolean(payload.message.trim())
    && typeof payload.requestId === 'string'
    && Boolean(payload.requestId.trim())
    && typeof payload.conversationId === 'string'
    && /^[a-zA-Z0-9._:-]{1,128}$/.test(payload.conversationId)
    && (!calendar || (
      payload.context
      && typeof payload.context === 'object'
      && !Array.isArray(payload.context)
      && contextText.length <= 48_000
    ));
  if (!valid) throw sessionTurnError('invalid_session_turn_request');
  return { ...payload };
}

function validatePublicSessionTurnEvent(event = {}, expectedRequestId = '') {
  const type = String(event?.type || '');
  const allowedFields = SESSION_TURN_EVENT_FIELDS[type];
  if (!allowedFields || !event || typeof event !== 'object' || Array.isArray(event)) {
    throw sessionTurnError('invalid_session_turn_event');
  }
  const keys = Object.keys(event);
  if (keys.some((key) => !allowedFields.includes(key))) {
    throw sessionTurnError('invalid_session_turn_event');
  }
  if (
    typeof event.requestId !== 'string'
    || !event.requestId
    || (expectedRequestId && event.requestId !== expectedRequestId)
  ) {
    throw sessionTurnError('invalid_session_turn_event');
  }

  if (type === 'accepted') {
    if (
      typeof event.provider !== 'string'
      || typeof event.model !== 'string'
      || typeof event.sessionVersion !== 'string'
      || typeof event.queued !== 'boolean'
    ) throw sessionTurnError('invalid_session_turn_event');
  } else if (type === 'delta') {
    if (!Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.text !== 'string') {
      throw sessionTurnError('invalid_session_turn_event');
    }
  } else if (type === 'tool-status') {
    if (typeof event.label !== 'string') throw sessionTurnError('invalid_session_turn_event');
  } else if (type === 'completed') {
    if (
      typeof event.text !== 'string'
      || typeof event.provider !== 'string'
      || typeof event.model !== 'string'
      || typeof event.sessionVersion !== 'string'
    ) throw sessionTurnError('invalid_session_turn_event');
  } else if (typeof event.code !== 'string' || typeof event.retryable !== 'boolean') {
    throw sessionTurnError('invalid_session_turn_event');
  }
  return Object.fromEntries(allowedFields
    .filter((key) => Object.prototype.hasOwnProperty.call(event, key))
    .map((key) => [key, event[key]]));
}

function waitForBatch(promise, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, sessionTurnError('request_aborted'));
    const timer = setTimeout(
      () => finish(reject, sessionTurnError('curator_timeout', true)),
      Math.max(1, timeoutMs),
    );
    if (typeof timer.unref === 'function') timer.unref();
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      () => finish(reject, sessionTurnError('relay_disconnected', true)),
    );
  });
}

async function runRelaySessionTurn({
  relay,
  payload = {},
  timeoutMs = 90_000,
  signal,
  onEvent = () => {},
} = {}) {
  const request = validateSessionTurnPayload(payload);
  if (signal?.aborted) throw sessionTurnError('request_aborted');
  if (!relay || typeof relay.enqueue !== 'function' || !relay.isBridgeOnline?.()) {
    throw sessionTurnError('relay_disconnected', true);
  }
  const job = relay.enqueue({
    kind: 'agent.chat',
    payload: request,
    meta: {
      view: request.profile === 'calendarassistant' ? 'calendar-ai' : 'wiki-ai',
      agent: request.profile,
      source: 'railway-relay-agent-chat',
    },
  });
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 90_000);
  const seenRecordIds = new Set();
  let cursor = 0;
  let accepted = false;
  let lastDeltaSequence = 0;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const batch = await waitForBatch(
      relay.waitForEvents(job.id, cursor, Math.min(5_000, remaining)),
      { signal, timeoutMs: remaining },
    );
    cursor = Number.isInteger(batch?.cursor) ? batch.cursor : cursor;
    const events = [];
    for (const record of batch?.events || []) {
      if (record.event === 'bridge-complete') continue;
      if (!SESSION_TURN_EVENT_FIELDS[record.event]) {
        throw sessionTurnError('invalid_session_turn_event');
      }
      const value = validatePublicSessionTurnEvent(record.data, request.requestId);
      if (value.type !== record.event) throw sessionTurnError('invalid_session_turn_event');
      events.push({ recordId: String(record.id || ''), value });
    }
    if (events.filter(({ value }) => ['completed', 'failed'].includes(value.type)).length > 1) {
      throw sessionTurnError('invalid_session_turn_event');
    }

    for (const { recordId, value } of events) {
      if (recordId && seenRecordIds.has(recordId)) continue;
      if (recordId) seenRecordIds.add(recordId);
      if (value.type === 'accepted') {
        if (accepted) continue;
        accepted = true;
      }
      if (value.type === 'delta') {
        if (value.sequence <= lastDeltaSequence) continue;
        if (value.sequence !== lastDeltaSequence + 1) {
          throw sessionTurnError('invalid_session_turn_event');
        }
        lastDeltaSequence = value.sequence;
      }
      await onEvent(value);
      if (value.type === 'completed') return { ...value, jobId: job.id };
      if (value.type === 'failed') throw sessionTurnError(value.code, value.retryable);
    }
    if (batch?.complete) throw sessionTurnError('relay_disconnected', true);
  }
  throw sessionTurnError('curator_timeout', true);
}

module.exports = {
  runRelaySessionTurn,
  sessionTurnError,
  validatePublicSessionTurnEvent,
  validateSessionTurnPayload,
};
