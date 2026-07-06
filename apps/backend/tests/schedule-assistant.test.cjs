const assert = require('node:assert/strict');
const test = require('node:test');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createStore(state) {
  const messages = [];
  return {
    getState: () => state,
    searchTasks: () => state.tasks,
    searchCalendarEvents: () => state.events,
    addChatMessage: (message) => {
      messages.push(message);
      return { id: `message-${messages.length}`, ...message };
    },
    listChatMessages: () => messages,
  };
}

test('assistant ask computes work hours from backend tasks and calendar events', async () => {
  const state = {
    tasks: [
      {
        id: 'task-shift-a',
        title: '카페 알바 오픈',
        date: '2026-06-10',
        time: '09:00',
        endTime: '13:00',
        status: 'Done',
        done: true,
        tags: ['알바'],
        category: '근무',
      },
      {
        id: 'task-study',
        title: 'React 공부',
        date: '2026-06-11',
        time: '14:00',
        endTime: '15:00',
        status: 'Done',
        done: true,
        tags: ['공부'],
        category: '학습',
      },
    ],
    events: [
      {
        id: 'event-shift-b',
        title: '카페 알바 마감',
        date: '2026-06-20',
        time: '18:00',
        endTime: '22:30',
        status: 'Done',
        done: true,
        tags: ['알바'],
        calendar: '근무',
      },
    ],
  };
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore(state),
    fetchImpl: async () => {
      throw new Error('assistant ask should not proxy to runtime');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '3달간 알바 총 몇 시간 했지?',
        filters: { from: '2026-04-01', to: '2026-07-01' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.match(payload.answer, /8\.5시간|8시간 30분/);
    assert.equal(payload.computed.workHours, 8.5);
    assert.equal(payload.computed.workCount, 2);
    assert.equal(payload.computed.total, 2);
    assert.deepEqual(payload.sources.map((source) => source.id).sort(), ['event-shift-b', 'task-shift-a']);
    assert.equal(payload.search.strategy, 'backend-schedule-rag');
    assert.equal(payload.gatewayFallback, true);
  } finally {
    await close(server);
  }
});

test('assistant ask rejects an empty question', async () => {
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({ tasks: [], events: [] }),
    fetchImpl: async () => {
      throw new Error('assistant ask should not proxy to runtime');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /question/i);
  } finally {
    await close(server);
  }
});

test('assistant ask uses OpenAI-compatible LLM when an API key is configured', async () => {
  const state = {
    tasks: [
      {
        id: 'task-shift-a',
        title: '카페 알바 오픈',
        date: '2026-06-10',
        time: '09:00',
        endTime: '13:00',
        status: 'Done',
        done: true,
        tags: ['알바'],
        category: '근무',
      },
    ],
    events: [
      {
        id: 'event-shift-b',
        title: '카페 알바 마감',
        date: '2026-06-20',
        time: '18:00',
        endTime: '22:30',
        status: 'Done',
        done: true,
        tags: ['알바'],
        calendar: '근무',
      },
    ],
  };
  const llmCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_CHAT_MODEL: 'gpt-test-calendar',
    },
    gatewayStore: createStore(state),
    fetchImpl: async (url, init = {}) => {
      llmCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'LLM 응답: 선택한 기간 알바는 총 8시간 30분입니다.',
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '3달간 알바 총 몇 시간 했지?',
        filters: { from: '2026-04-01', to: '2026-07-01' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(llmCalls[0].init.headers.authorization, 'Bearer test-openai-key');
    const requestBody = JSON.parse(llmCalls[0].init.body);
    assert.equal(requestBody.model, 'gpt-test-calendar');
    assert.equal(requestBody.messages[0].role, 'system');
    assert.match(requestBody.messages[0].content, /아래 데이터만 근거/);
    assert.match(requestBody.messages[1].content, /8\.5/);
    assert.match(requestBody.messages[1].content, /카페 알바 오픈/);
    assert.match(requestBody.messages[1].content, /카페 알바 마감/);
    assert.equal(payload.answer, 'LLM 응답: 선택한 기간 알바는 총 8시간 30분입니다.');
    assert.deepEqual(payload.llm, { provider: 'openai', model: 'gpt-test-calendar', used: true });
    assert.equal(payload.computed.workHours, 8.5);
  } finally {
    await close(server);
  }
});

test('assistant ask falls back to computed answer when LLM request fails', async () => {
  const state = {
    tasks: [
      {
        id: 'task-shift-a',
        title: '카페 알바 오픈',
        date: '2026-06-10',
        time: '09:00',
        endTime: '13:00',
        status: 'Done',
        done: true,
        tags: ['알바'],
        category: '근무',
      },
    ],
    events: [],
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_CHAT_MODEL: 'gpt-test-calendar',
    },
    gatewayStore: createStore(state),
    fetchImpl: async () => new Response('provider down', { status: 503 }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '3달간 알바 총 몇 시간 했지?',
        filters: { from: '2026-04-01', to: '2026-07-01' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.match(payload.answer, /4시간/);
    assert.equal(payload.computed.workHours, 4);
    assert.equal(payload.llm.used, false);
    assert.equal(payload.llm.provider, 'openai');
    assert.match(payload.llm.error, /openai_request_failed:503/);
  } finally {
    await close(server);
  }
});

test('chat stream routes schedule questions to schedule assistant instead of runtime runs', async () => {
  const state = {
    tasks: [
      {
        id: 'task-shift-a',
        title: '카페 알바 오픈',
        date: '2026-06-10',
        time: '09:00',
        endTime: '13:00',
        status: 'Done',
        done: true,
        tags: ['알바'],
        category: '근무',
      },
    ],
    events: [
      {
        id: 'event-shift-b',
        title: '카페 알바 마감',
        date: '2026-06-20',
        time: '18:00',
        endTime: '22:30',
        status: 'Done',
        done: true,
        tags: ['알바'],
        calendar: '근무',
      },
    ],
  };
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore(state),
    fetchImpl: async () => {
      throw new Error('schedule question chat should not proxy to runtime');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '3달간 알바 총 몇 시간 했지?',
        filters: { from: '2026-04-01', to: '2026-07-01' },
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(body, /event: delta/);
    assert.match(body, /8\.5시간|8시간 30분/);
    assert.match(body, /backend-schedule-rag/);
  } finally {
    await close(server);
  }
});
