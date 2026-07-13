const { sanitizeSessionEvent } = require('./agent-operations-domain');
const { relayEnabled } = require('./railway-relay');

function relayCompletionText(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    const data = text.startsWith('data:') ? text.replace(/^data:\s*/, '') : text;
    if (!data || data === '[DONE]') return '';
    if (data.startsWith('{') || data.startsWith('[')) {
      try {
        return relayCompletionText(JSON.parse(data));
      } catch {
        return data;
      }
    }
    return data;
  }
  if (Array.isArray(value)) return value.map(relayCompletionText).filter(Boolean).join('');
  if (typeof value !== 'object') return '';

  const direct = [value.text, value.content, value.output_text, value.outputText]
    .find((item) => typeof item === 'string' && item.trim());
  if (direct) return direct;
  if (Array.isArray(value.choices)) {
    return value.choices.map((choice) => (
      choice?.message?.content
      || choice?.delta?.content
      || choice?.text
      || ''
    )).filter(Boolean).join('');
  }
  if (Array.isArray(value.output)) return relayCompletionText(value.output);
  return relayCompletionText(value.body)
    || relayCompletionText(value.result)
    || relayCompletionText(value.data);
}

function sessionEventFromRelayRecord(record = {}) {
  const eventName = String(record.event || 'message').toLowerCase();
  const text = relayCompletionText(record.data);
  if (eventName.includes('tool')) {
    return sanitizeSessionEvent({
      kind: 'tool_activity',
      text: text || 'Hermes tool activity',
      metadata: { relayEvent: eventName, tool: record.data?.tool || record.data?.name || '' },
    });
  }
  if (eventName === 'error') {
    return sanitizeSessionEvent({
      kind: 'error',
      text: text || record.data?.error || 'Hermes Relay failed',
      metadata: { relayEvent: eventName },
    });
  }
  if (eventName === 'bridge-complete') {
    return sanitizeSessionEvent({
      kind: 'progress',
      text: 'Hermes Relay completion received',
      metadata: { relayEvent: eventName },
    });
  }
  if (text) {
    return sanitizeSessionEvent({
      kind: 'agent_message',
      text,
      metadata: { relayEvent: eventName },
    });
  }
  return sanitizeSessionEvent({
    kind: 'progress',
    text: `Hermes Relay ${eventName}`,
    metadata: { relayEvent: eventName },
  });
}

function relayError(code, message, jobId = '') {
  const error = new Error(message);
  error.code = code;
  error.jobId = jobId;
  return error;
}

async function runRelayChatCompletion({
  relay,
  env = process.env,
  payload,
  meta = {},
  onEvent = () => {},
  timeoutMs,
} = {}) {
  if (!relay || !relayEnabled(env) || !relay.isBridgeOnline()) {
    throw relayError('runtime_unavailable', 'Mac mini Hermes Relay is offline');
  }
  const job = relay.enqueue({
    kind: 'chat.completions',
    payload,
    meta: {
      view: 'agent-operations',
      model: payload?.model || '',
      ...meta,
    },
  });
  const durationMs = Math.max(
    1_000,
    Number(timeoutMs || env.HERMES_RELAY_STREAM_TIMEOUT_MS || 90_000),
  );
  const deadline = Date.now() + durationMs;
  const textParts = [];
  const events = [];
  let bridgeCompletionText = '';
  let cursor = 0;

  while (Date.now() < deadline) {
    const waitMs = Math.min(5_000, Math.max(1, deadline - Date.now()));
    const batch = await relay.waitForEvents(job.id, cursor, waitMs);
    cursor = batch.cursor;
    for (const record of batch.events || []) {
      const event = sessionEventFromRelayRecord(record);
      events.push(event);
      await onEvent(event);
      if (event.kind === 'agent_message' && event.text) textParts.push(event.text);
      if (record.event === 'bridge-complete') bridgeCompletionText = relayCompletionText(record.data);
      if (record.event === 'error') {
        throw relayError(
          'relay_failed',
          String(record.data?.error || event.text || 'Mac mini Hermes Relay failed'),
          job.id,
        );
      }
    }
    if (batch.complete) {
      return {
        text: (textParts.join('') || bridgeCompletionText).trim(),
        jobId: job.id,
        events,
      };
    }
  }

  const timeoutError = relayError(
    'relay_timeout',
    'Mac mini Hermes Relay timed out',
    job.id,
  );
  relay.fail(job.id, timeoutError);
  throw timeoutError;
}

module.exports = {
  relayCompletionText,
  runRelayChatCompletion,
  sessionEventFromRelayRecord,
};
