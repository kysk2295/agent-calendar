const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');

const { AgentOperationsService } = require('../app/lib/agent-operations-service');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { HermesStore } = require('../app/lib/store');

const FIXED_NOW = '2026-07-15T00:00:00.000Z';
const clock = () => new Date(FIXED_NOW);

function workRequest(patch = {}) {
  return {
    clientRequestId: 'live-turn-request',
    templateId: 'general-agent-work',
    title: '실시간 작업 대화',
    objective: '대화로 작업 방향을 정리한다.',
    initialMessage: '먼저 조사 범위와 다음 행동을 알려줘.',
    executionEngine: 'hermes',
    deliverable: { kind: 'report', format: 'markdown' },
    ...patch,
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('live Work turn persists the final agent answer while emitting accepted, progress, and delta events', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-work-live-turn-'));
  const store = new HermesStore({ dataDir, clock });
  const calls = [];
  const service = new AgentOperationsService({
    store,
    clock,
    liveTurnCompletion: async ({ payload, meta, onEvent }) => {
      calls.push({ payload, meta });
      await onEvent({ kind: 'progress', text: '공식 근거를 확인하고 있습니다.' });
      await onEvent({ kind: 'agent_message', text: '먼저 범위를 ' });
      await onEvent({ kind: 'agent_message', text: '정리하겠습니다.' });
      return { text: '먼저 범위를 정리하겠습니다.', jobId: 'live-job-1', executionEngine: 'hermes' };
    },
  });

  try {
    const created = await service.createWork(workRequest());
    const events = [];

    await service.streamWorkTurn(created.work.id, { initial: true }, async (event) => events.push(event));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.stream, true);
    assert.equal(calls[0].meta.missionId, created.work.id);
    assert.deepEqual(events.map((event) => event.type), ['accepted', 'checkpoint', 'delta', 'delta', 'checkpoint', 'done']);
    assert.equal(events[0].delivery.status, 'accepted');
    assert.equal(events[2].text, '먼저 범위를 ');
    assert.equal(events[3].text, '정리하겠습니다.');

    const conversation = await service.getWorkConversation(created.work.id, { limit: 200 });
    assert.equal(conversation.work.status, 'active');
    const agentMessages = conversation.checkpoints.filter((event) => event.kind === 'agent_message');
    assert.equal(agentMessages.length, 1);
    assert.equal(agentMessages[0].text, '먼저 범위를 정리하겠습니다.');
    assert.equal(conversation.checkpoints.some((event) => event.kind === 'progress' && event.text === '공식 근거를 확인하고 있습니다.'), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('live Work turns do not invoke the runtime for unsupported external requests or idempotent replays', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-work-live-turn-safety-'));
  const store = new HermesStore({ dataDir, clock });
  let completionCalls = 0;
  const service = new AgentOperationsService({
    store,
    clock,
    liveTurnCompletion: async ({ onEvent }) => {
      completionCalls += 1;
      await onEvent({ kind: 'agent_message', text: '실제 답변' });
      return { text: '실제 답변', jobId: 'live-job-2', executionEngine: 'hermes' };
    },
  });

  try {
    const created = await service.createWork(workRequest({ clientRequestId: 'live-turn-safety-request' }));
    const rejected = [];
    await service.streamWorkTurn(created.work.id, {
      clientMessageId: 'external-send',
      text: '고객에게 이메일을 보내줘.',
    }, async (event) => rejected.push(event));
    assert.equal(completionCalls, 0);
    assert.deepEqual(rejected.map((event) => event.type), ['accepted', 'done']);
    assert.equal(rejected[0].delivery.status, 'rejected');

    const first = [];
    await service.streamWorkTurn(created.work.id, {
      clientMessageId: 'ordinary-message',
      text: '핵심 가설을 세 줄로 정리해줘.',
    }, async (event) => first.push(event));
    const replay = [];
    await service.streamWorkTurn(created.work.id, {
      clientMessageId: 'ordinary-message',
      text: '핵심 가설을 세 줄로 정리해줘.',
    }, async (event) => replay.push(event));

    assert.equal(completionCalls, 1);
    assert.equal(first.at(-1).type, 'done');
    assert.equal(replay.at(-1).type, 'done');
    assert.equal(replay.at(-1).idempotentReplay, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('live Work turn does not persist relay lifecycle noise as a progress checkpoint', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-work-live-turn-lifecycle-'));
  const store = new HermesStore({ dataDir, clock });
  const service = new AgentOperationsService({
    store,
    clock,
    liveTurnCompletion: async ({ onEvent }) => {
      await onEvent({ kind: 'progress', text: '[redacted-command]', metadata: { relayEvent: 'lifecycle' } });
      await onEvent({ kind: 'progress', text: '[redacted-command]', metadata: { relayEvent: 'stderr' } });
      await onEvent({ kind: 'agent_message', text: '사용자에게 필요한 실제 답변입니다.' });
      return { text: '사용자에게 필요한 실제 답변입니다.', jobId: 'live-job-lifecycle', executionEngine: 'local_llm' };
    },
  });

  try {
    const created = await service.createWork(workRequest({
      clientRequestId: 'live-turn-lifecycle-request',
      executionEngine: 'local_llm',
    }));

    await service.streamWorkTurn(created.work.id, { initial: true }, async () => {});

    const conversation = await service.getWorkConversation(created.work.id, { limit: 200 });
    assert.equal(conversation.checkpoints.some((event) => event.text === '[redacted-command]'), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('live Work turn records an unavailable responsible agent without launching a completion', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-work-live-turn-unavailable-'));
  const store = new HermesStore({ dataDir, clock });
  let completionCalls = 0;
  const service = new AgentOperationsService({
    store,
    clock,
    resolveAgentAvailability: async ({ agentId }) => ({
      available: false,
      agentId,
      status: 'stopped',
      code: 'agent_unavailable',
      message: '담당 에이전트가 현재 중지되어 응답을 시작하지 않았습니다. 준비된 뒤 다시 시도해 주세요.',
    }),
    liveTurnCompletion: async () => {
      completionCalls += 1;
      return { text: '이 응답은 생성되면 안 됩니다.' };
    },
  });

  try {
    const created = await service.createWork(workRequest({
      clientRequestId: 'live-turn-unavailable-request',
      agentId: 'bizconsultant',
    }));
    const events = [];

    await service.streamWorkTurn(created.work.id, { initial: true }, async (event) => events.push(event));

    assert.equal(completionCalls, 0);
    assert.deepEqual(events.map((event) => event.type), ['accepted', 'checkpoint', 'error', 'done']);
    assert.equal(events[1].checkpoint.kind, 'error');
    assert.equal(events[2].code, 'agent_unavailable');
    assert.match(events[2].message, /중지되어 응답을 시작하지 않았습니다/);

    const conversation = await service.getWorkConversation(created.work.id, { limit: 200 });
    assert.equal(conversation.work.status, 'draft');
    const unavailable = conversation.checkpoints.filter((event) => event.kind === 'error');
    assert.equal(unavailable.length, 1);
    assert.match(unavailable[0].text, /중지되어 응답을 시작하지 않았습니다/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('gateway exposes the real live Work turn as a credential-safe SSE response', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-work-live-turn-http-'));
  const store = new HermesStore({ dataDir, clock });
  const service = new AgentOperationsService({
    store,
    clock,
    liveTurnCompletion: async ({ onEvent }) => {
      await onEvent({ kind: 'agent_message', text: '실시간 ' });
      await onEvent({ kind: 'agent_message', text: '응답입니다.' });
      return { text: '실시간 응답입니다.', jobId: 'live-job-http', executionEngine: 'hermes' };
    },
  });
  const server = createRailwayGatewayServer({ env: {}, gatewayStore: store, agentOperationsService: service, agentOperationsClock: clock });
  const baseUrl = await listen(server);

  try {
    const created = await service.createWork(workRequest({ clientRequestId: 'live-turn-http-request' }));
    const response = await fetch(`${baseUrl}/api/agent-operations/work/${created.work.id}/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ initial: true }),
    });
    const stream = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(stream, /event: accepted/);
    assert.match(stream, /event: delta/);
    assert.match(stream, /event: checkpoint/);
    assert.match(stream, /event: done/);
    assert.doesNotMatch(stream, /liveTurnMessageId|source:live_work_turn/);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
