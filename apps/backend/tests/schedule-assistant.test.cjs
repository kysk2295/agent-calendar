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
    assert.equal(payload.search.strategy, 'backend-calendar-ai-rag');
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
    assert.match(requestBody.messages[0].content, /DB 기록만 근거/);
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

test('assistant ask uses Railway OpenAI OAuth proxy when configured', async () => {
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
  const env = {
    DATABASE_URL: '',
    HERMES_RUNTIME_URL: '',
    AGENT_CALENDAR_OPENAI_OAUTH_URL: 'https://openai-oauth.test',
    AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY: 'oauth-proxy-key',
    AGENT_CALENDAR_OPENAI_MODEL: 'gpt-oauth-calendar',
  };
  const server = createRailwayGatewayServer({
    env,
    gatewayStore: createStore(state),
    fetchImpl: async (url, init = {}) => {
      llmCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'OAuth 프록시 응답: 선택한 기간 알바는 총 8시간 30분입니다.',
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
    assert.equal(llmCalls[0].url, 'https://openai-oauth.test/v1/chat/completions');
    assert.equal(llmCalls[0].init.headers.authorization, 'Bearer oauth-proxy-key');
    const requestBody = JSON.parse(llmCalls[0].init.body);
    assert.equal(requestBody.model, 'gpt-oauth-calendar');
    assert.match(requestBody.messages[0].content, /DB 기록만 근거/);
    assert.match(requestBody.messages[1].content, /8\.5/);
    assert.match(requestBody.messages[1].content, /카페 알바 오픈/);
    assert.match(requestBody.messages[1].content, /카페 알바 마감/);
    assert.equal(payload.answer, 'OAuth 프록시 응답: 선택한 기간 알바는 총 8시간 30분입니다.');
    assert.deepEqual(payload.llm, { provider: 'openai-oauth', model: 'gpt-oauth-calendar', used: true });
    assert.equal(payload.computed.workHours, 8.5);
  } finally {
    await close(server);
  }
});

test('assistant ask falls back when Railway OpenAI OAuth proxy token is expired', async () => {
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
      AGENT_CALENDAR_OPENAI_OAUTH_URL: 'https://openai-oauth.test',
      AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY: 'oauth-proxy-key',
      AGENT_CALENDAR_OPENAI_MODEL: 'gpt-oauth-calendar',
    },
    gatewayStore: createStore(state),
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: 'Provided authentication token is expired. Please try signing in again.',
        type: 'upstream_error',
      },
    }), { status: 502, headers: { 'content-type': 'application/json' } }),
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
    assert.equal(payload.llm.provider, 'openai-oauth');
    assert.equal(payload.llm.used, false);
    assert.match(payload.llm.error, /openai_oauth_request_failed:502/);
    assert.match(payload.llm.error, /expired/);
  } finally {
    await close(server);
  }
});

test('assistant ask falls back from Railway OpenAI OAuth proxy to local Qwen-compatible LLM', async () => {
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
      AGENT_CALENDAR_OPENAI_OAUTH_URL: 'https://openai-oauth.test',
      AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY: 'oauth-proxy-key',
      AGENT_CALENDAR_OPENAI_MODEL: 'gpt-oauth-calendar',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createStore(state),
    fetchImpl: async (url, init = {}) => {
      llmCalls.push({ url: String(url), init });
      if (String(url).startsWith('https://openai-oauth.test')) {
        return new Response(JSON.stringify({
          error: {
            message: 'Provided authentication token is expired. Please try signing in again.',
            type: 'upstream_error',
          },
        }), { status: 502, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: '로컬 Qwen 응답: 선택한 기간 알바는 총 8시간 30분입니다.',
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
    assert.equal(llmCalls.length, 2);
    assert.equal(llmCalls[0].url, 'https://openai-oauth.test/v1/chat/completions');
    assert.equal(llmCalls[1].url, 'http://127.0.0.1:11434/v1/chat/completions');
    const localRequestBody = JSON.parse(llmCalls[1].init.body);
    assert.equal(localRequestBody.model, 'qwen2.5:7b');
    assert.match(localRequestBody.messages[1].content, /8\.5/);
    assert.equal(payload.answer, '로컬 Qwen 응답: 선택한 기간 알바는 총 8시간 30분입니다.');
    assert.deepEqual(payload.llm, { provider: 'local-llm', model: 'qwen2.5:7b', used: true });
    assert.equal(payload.llmAttempts.length, 2);
    assert.equal(payload.llmAttempts[0].provider, 'openai-oauth');
    assert.equal(payload.llmAttempts[0].used, false);
    assert.equal(payload.llmAttempts[1].provider, 'local-llm');
    assert.equal(payload.llmAttempts[1].used, true);
  } finally {
    await close(server);
  }
});

test('assistant ask retrieves broader calendar AI DB context, not only schedule rows', async () => {
  const state = {
    tasks: [
      {
        id: 'task-unrelated',
        title: '장보기',
        date: '2026-07-01',
        status: 'Planned',
        done: false,
      },
    ],
    events: [],
    documents: [
      {
        id: 'doc-uniport-backlog',
        title: 'UniPort 백로그 회의',
        source: 'document',
        createdAt: '2026-07-02T09:00:00Z',
        content: 'UniPort 백로그는 결제 API 안정화와 온보딩 문서 정리를 먼저 봐야 한다.',
      },
    ],
    runs: [
      {
        id: 'run-uniport-deploy',
        goal: 'UniPort 배포 점검',
        status: 'done',
        createdAt: '2026-07-03T11:00:00Z',
        summary: '배포 전 환경변수와 Railway 상태를 다시 확인했다.',
      },
    ],
    chatMessages: [
      {
        id: 'chat-uniport-note',
        role: 'user',
        text: 'UniPort는 다음 회의 전에 온보딩 문서가 필요하다고 메모했다.',
        createdAt: '2026-07-03T12:00:00Z',
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
              content: 'UniPort는 결제 API 안정화와 온보딩 문서를 먼저 보면 좋겠습니다.',
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
        question: 'UniPort 백로그는 다음에 뭘 보면 좋을까?',
      }),
    });
    const payload = await response.json();
    const requestBody = JSON.parse(llmCalls[0].init.body);
    const promptContext = requestBody.messages[1].content;

    assert.equal(response.status, 200);
    assert.equal(payload.answer, 'UniPort는 결제 API 안정화와 온보딩 문서를 먼저 보면 좋겠습니다.');
    assert.equal(payload.search.strategy, 'backend-calendar-ai-rag');
    assert.ok(payload.sources.some((source) => source.type === 'document' && source.title === 'UniPort 백로그 회의'));
    assert.ok(payload.sources.some((source) => source.type === 'run' && source.title === 'UniPort 배포 점검'));
    assert.match(promptContext, /\(document\) UniPort 백로그 회의/);
    assert.match(promptContext, /\(run\) UniPort 배포 점검/);
    assert.match(promptContext, /결제 API 안정화/);
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
    assert.match(body, /backend-calendar-ai-rag/);
  } finally {
    await close(server);
  }
});
