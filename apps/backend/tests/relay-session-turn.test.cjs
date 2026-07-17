const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runRelaySessionTurn,
  validatePublicSessionTurnEvent,
} = require('../app/lib/relay-session-turn');


function event(id, type, data = {}) {
  return {
    id,
    event: type,
    data: { type, requestId: 'req-1', ...data },
  };
}


function fakeRelay(batches, { online = true } = {}) {
  const calls = [];
  const jobs = [];
  return {
    calls,
    jobs,
    isBridgeOnline: () => online,
    enqueue(input) {
      jobs.push(input);
      return { id: 'job-1' };
    },
    async waitForEvents(jobId, cursor, timeoutMs) {
      calls.push({ jobId, cursor, timeoutMs });
      return batches.shift() || { events: [], cursor, complete: true };
    },
  };
}


const payload = {
  profile: 'wikicurator',
  message: '질문 원문',
  requestId: 'req-1',
  conversationId: 'agent-calendar-wiki',
};


test('runRelaySessionTurn forwards ordered events using relay cursor continuation', async () => {
  const relay = fakeRelay([
    {
      events: [
        event('job-1:0', 'accepted', {
          provider: 'openai-codex',
          model: 'gpt-5.5',
          sessionVersion: 'opaque',
          queued: false,
        }),
        event('job-1:1', 'delta', { sequence: 1, text: '첫 ' }),
      ],
      cursor: 2,
      complete: false,
    },
    {
      events: [
        event('job-1:2', 'delta', { sequence: 2, text: '답변' }),
        event('job-1:3', 'completed', {
          text: '첫 답변',
          provider: 'openai-codex',
          model: 'gpt-5.5',
          sessionVersion: 'opaque',
        }),
      ],
      cursor: 4,
      complete: true,
    },
  ]);
  const received = [];

  const result = await runRelaySessionTurn({
    relay,
    payload,
    timeoutMs: 1000,
    onEvent: async (item) => received.push(item),
  });

  assert.deepEqual(relay.jobs, [{
    kind: 'agent.chat',
    payload,
    meta: {
      view: 'wiki-ai',
      agent: 'wikicurator',
      source: 'railway-relay-agent-chat',
    },
  }]);
  assert.deepEqual(relay.calls.map((call) => call.cursor), [0, 2]);
  assert.deepEqual(received.map((item) => item.type), [
    'accepted',
    'delta',
    'delta',
    'completed',
  ]);
  assert.equal(result.text, '첫 답변');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.jobId, 'job-1');
});


test('runRelaySessionTurn suppresses replayed delta sequence and record id', async () => {
  const duplicate = event('job-1:1', 'delta', { sequence: 1, text: '첫 ' });
  const relay = fakeRelay([{
    events: [
      event('job-1:0', 'accepted', {
        provider: 'p',
        model: 'm',
        sessionVersion: 'v',
        queued: false,
      }),
      duplicate,
      duplicate,
      event('job-1:2', 'delta', { sequence: 1, text: '첫 ' }),
      event('job-1:3', 'completed', {
        text: '첫 답변',
        provider: 'p',
        model: 'm',
        sessionVersion: 'v',
      }),
    ],
    cursor: 5,
    complete: true,
  }]);
  const received = [];

  await runRelaySessionTurn({ relay, payload, onEvent: (item) => received.push(item) });

  assert.deepEqual(received.map((item) => item.type), ['accepted', 'delta', 'completed']);
});


test('validatePublicSessionTurnEvent rejects unknown fields and mismatched types', () => {
  assert.throws(
    () => validatePublicSessionTurnEvent({
      type: 'delta',
      requestId: 'req-1',
      sequence: 1,
      text: 'ok',
      sessionId: 'secret',
    }),
    /invalid_session_turn_event/,
  );
  assert.throws(
    () => validatePublicSessionTurnEvent({ type: 'tool', requestId: 'req-1' }),
    /invalid_session_turn_event/,
  );
});


test('runRelaySessionTurn rejects the retired Telegram capture payload', async () => {
  const relay = fakeRelay([]);
  await assert.rejects(
    runRelaySessionTurn({
      relay,
      payload: {
        profile: 'wikicurator',
        source: 'telegram',
        message: '질문 원문',
        requestId: 'req-1',
        delivery: 'capture',
        policy: 'wiki-read-only',
      },
    }),
    (error) => error.code === 'invalid_session_turn_request',
  );
  assert.equal(relay.jobs.length, 0);
});


test('runRelaySessionTurn rejects unknown events and multiple terminals', async () => {
  const unknownRelay = fakeRelay([{
    events: [{ id: 'job-1:0', event: 'raw', data: { secret: true } }],
    cursor: 1,
    complete: true,
  }]);
  await assert.rejects(
    runRelaySessionTurn({ relay: unknownRelay, payload }),
    (error) => error.code === 'invalid_session_turn_event',
  );

  const terminalRelay = fakeRelay([{
    events: [
      event('job-1:0', 'completed', { text: 'answer' }),
      event('job-1:1', 'failed', { code: 'late_failure', retryable: false }),
    ],
    cursor: 2,
    complete: true,
  }]);
  await assert.rejects(
    runRelaySessionTurn({ relay: terminalRelay, payload }),
    (error) => error.code === 'invalid_session_turn_event',
  );
});


test('runRelaySessionTurn maps curator busy and relay disconnect to stable errors', async () => {
  const busyRelay = fakeRelay([{
    events: [event('job-1:0', 'failed', { code: 'curator_busy', retryable: true })],
    cursor: 1,
    complete: true,
  }]);
  await assert.rejects(
    runRelaySessionTurn({ relay: busyRelay, payload }),
    (error) => error.code === 'curator_busy' && error.retryable === true,
  );

  const offlineRelay = fakeRelay([], { online: false });
  await assert.rejects(
    runRelaySessionTurn({ relay: offlineRelay, payload }),
    (error) => error.code === 'relay_disconnected',
  );
});


test('runRelaySessionTurn supports abort and timeout', async () => {
  const hangingRelay = {
    isBridgeOnline: () => true,
    enqueue: () => ({ id: 'job-1' }),
    waitForEvents: () => new Promise(() => {}),
  };
  const controller = new AbortController();
  const aborted = runRelaySessionTurn({
    relay: hangingRelay,
    payload,
    timeoutMs: 1000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, (error) => error.code === 'request_aborted');

  await assert.rejects(
    runRelaySessionTurn({ relay: hangingRelay, payload, timeoutMs: 10 }),
    (error) => error.code === 'curator_timeout',
  );
});
