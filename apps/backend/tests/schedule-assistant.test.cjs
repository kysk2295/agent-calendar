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
    assert.equal(payload.answerMode, 'fallback');
    assert.deepEqual(payload.sources.map((source) => source.id).sort(), ['event-shift-b', 'task-shift-a']);
    assert.equal(payload.search.strategy, 'backend-calendar-ai-rag');
    assert.equal(payload.search.intent, 'ask');
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
    assert.equal(payload.answerMode, 'llm');
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
    assert.equal(payload.answerMode, 'llm');
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
    assert.equal(payload.answerMode, 'fallback');
    assert.equal(payload.llm.provider, 'openai-oauth');
    assert.equal(payload.llm.used, false);
    assert.match(payload.llm.error, /openai_oauth_request_failed:502/);
    assert.match(payload.llm.error, /expired/);
  } finally {
    await close(server);
  }
});

test('assistant ask falls back from Railway OpenAI OAuth proxy to local Qwen-compatible LLM without length-expansion pass', async () => {
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
      if (String(url).includes('/api/embeddings')) {
        return new Response('not found', { status: 404 });
      }
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
    assert.doesNotMatch(localRequestBody.messages[0].content, /최소\s*\d+자/);
    assert.doesNotMatch(localRequestBody.messages[1].content, /최소\s*\d+자/);
    assert.equal(payload.answer, '로컬 Qwen 응답: 선택한 기간 알바는 총 8시간 30분입니다.');
    assert.deepEqual(payload.llm, { provider: 'local-llm', model: 'qwen2.5:7b', used: true });
    assert.equal(payload.answerMode, 'llm');
    assert.equal(payload.llmAttempts.length, 2);
    assert.equal(payload.llmAttempts[0].provider, 'openai-oauth');
    assert.equal(payload.llmAttempts[0].used, false);
    assert.equal(payload.llmAttempts[1].provider, 'local-llm');
    assert.equal(payload.llmAttempts[1].used, true);
  } finally {
    await close(server);
  }
});

test('assistant ask only exposes task and calendar sources to calendar AI', async () => {
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
          { message: { content: 'UniPort 일정은 장보기 기록만 확인됩니다.' } },
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
    assert.equal(payload.answer, 'UniPort 일정은 장보기 기록만 확인됩니다.');
    assert.equal(payload.search.strategy, 'backend-calendar-ai-rag');
    assert.ok(payload.sources.length >= 1);
    assert.ok(payload.sources.every((source) => /task|calendar|event|ticktick|schedule/i.test(source.type || source.sourceType || source.source || '')));
    assert.doesNotMatch(promptContext, /\(document\) UniPort 백로그 회의/);
    assert.doesNotMatch(promptContext, /\(run\) UniPort 배포 점검/);
    assert.doesNotMatch(promptContext, /결제 API 안정화/);
  } finally {
    await close(server);
  }
});

test('assistant ask ranks schedule sources with embedding, date, and keyword hybrid score', async () => {
  const state = {
    tasks: [
      {
        id: 'task-unrelated-near',
        title: '가까운 장보기',
        date: '2026-07-08',
        status: 'Planned',
        done: false,
      },
      {
        id: 'task-meeting-far',
        title: '유니포트 투자자 미팅 준비',
        date: '2026-07-30',
        status: 'Planned',
        done: false,
      },
    ],
    events: [],
  };
  const embeddingPrompts = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
      AGENT_CALENDAR_EMBEDDING_MODEL: 'bge-m3-test',
    },
    gatewayStore: createStore(state),
    fetchImpl: async (url, init = {}) => {
      assert.equal(String(url), 'http://ollama.test/api/embeddings');
      const body = JSON.parse(init.body || '{}');
      embeddingPrompts.push(body.prompt);
      const vector = /투자자|미팅|회의/.test(body.prompt) ? [1, 0] : [0, 1];
      return new Response(JSON.stringify({ embedding: vector }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '유니포트 투자자 미팅 준비 뭐 해야 돼?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.search.embeddingModel, 'bge-m3-test');
    assert.equal(payload.sources[0].id, 'task-meeting-far');
    assert.ok(payload.sources[0].score > payload.sources[1].score);
    assert.ok(embeddingPrompts.some((prompt) => /유니포트 투자자 미팅 준비/.test(prompt)));
  } finally {
    await close(server);
  }
});

test('assistant ask reports hash-fallback embedding model when Ollama embeddings fail', async () => {
  const state = {
    tasks: [
      {
        id: 'task-meeting',
        title: '유니포트 회의 준비',
        date: '2026-07-08',
        status: 'Planned',
        done: false,
      },
    ],
    events: [],
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
    },
    gatewayStore: createStore(state),
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '유니포트 회의 준비 뭐 해야 돼?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.search.embeddingModel, 'hash-fallback');
    assert.equal(payload.answerMode, 'fallback');
  } finally {
    await close(server);
  }
});

test('assistant ask caches schedule record embeddings between repeated questions', async () => {
  const state = {
    tasks: [
      { id: 'task-a', title: '유니포트 회의 준비', date: '2026-07-08', status: 'Planned', done: false },
      { id: 'task-b', title: '카드뉴스 초안', date: '2026-07-09', status: 'Planned', done: false },
    ],
    events: [],
  };
  const embeddingPrompts = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
      AGENT_CALENDAR_EMBEDDING_MODEL: 'bge-m3-test',
    },
    gatewayStore: createStore(state),
    fetchImpl: async (url, init = {}) => {
      assert.equal(String(url), 'http://ollama.test/api/embeddings');
      const body = JSON.parse(init.body || '{}');
      embeddingPrompts.push(body.prompt);
      return new Response(JSON.stringify({ embedding: /유니포트|회의/.test(body.prompt) ? [1, 0] : [0, 1] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    const first = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '유니포트 회의 준비 뭐 해야 돼?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    assert.equal(first.status, 200);
    const callsAfterFirstAsk = embeddingPrompts.length;

    const second = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '유니포트 회의 준비 뭐 해야 돼?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    assert.equal(second.status, 200);

    const promptsAfterSecondAsk = embeddingPrompts.slice(callsAfterFirstAsk);
    assert.ok(promptsAfterSecondAsk.length > 0);
    assert.deepEqual(promptsAfterSecondAsk, promptsAfterSecondAsk.map(() => '유니포트 회의 준비 뭐 해야 돼?'));
  } finally {
    await close(server);
  }
});

test('assistant ask computes overdue and due-soon items deterministically', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-07T12:00:00.000Z') });
  const state = {
    tasks: [
      { id: 'task-overdue', title: '세금계산서 발행', date: '2026-07-04', status: 'Planned', done: false },
      { id: 'task-soon', title: '유니포트 회의 준비', date: '2026-07-08', status: 'Planned', done: false },
      { id: 'task-done', title: '완료된 지난 일', date: '2026-07-03', status: 'Done', done: true },
    ],
    events: [],
  };
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore(state),
    fetchImpl: async () => {
      throw new Error('computed-only ask should not call network');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '기한 지났거나 임박한 할 일 정리해줘',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.computed.questionType, 'overdue');
    assert.deepEqual(payload.computed.overdueItems.map((item) => item.title), ['세금계산서 발행']);
    assert.equal(payload.computed.overdueItems[0].daysOverdue, 3);
    assert.deepEqual(payload.computed.dueSoonItems.map((item) => item.title), ['유니포트 회의 준비']);
  } finally {
    await close(server);
  }
});

test('assistant ask computes overlapping calendar conflict pairs', async () => {
  const state = {
    tasks: [],
    events: [
      { id: 'event-a', title: '팀 주간회의', date: '2026-07-08', time: '14:30', endTime: '15:30' },
      { id: 'event-b', title: '투자자 미팅', date: '2026-07-08', time: '15:00', endTime: '16:00' },
      { id: 'event-c', title: '저녁 운동', date: '2026-07-08', time: '18:00', endTime: '19:00' },
    ],
  };
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore(state),
    fetchImpl: async () => {
      throw new Error('computed-only ask should not call network');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '이번 주 일정 충돌이나 겹치는 것 있어?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.computed.questionType, 'conflict');
    assert.equal(payload.computed.conflictPairs.length, 1);
    assert.deepEqual(payload.computed.conflictPairs[0].items.map((item) => item.title), ['팀 주간회의', '투자자 미팅']);
  } finally {
    await close(server);
  }
});

test('assistant ask computes distribution by tags and lists', async () => {
  const state = {
    tasks: [
      { id: 'task-a', title: 'API 안정화', date: '2026-07-08', tags: ['유니포트'], category: '개발' },
      { id: 'task-b', title: '카드뉴스 초안', date: '2026-07-09', tags: ['유니포트', '마케팅'], category: '마케팅' },
      { id: 'task-c', title: '병원 예약', date: '2026-07-09', tags: ['개인'], category: '개인' },
    ],
    events: [],
  };
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore(state),
    fetchImpl: async () => {
      throw new Error('computed-only ask should not call network');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '이번 주 프로젝트별 작업량 비교해줘',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.computed.questionType, 'distribution');
    assert.deepEqual(payload.computed.byTag, { '유니포트': 2, '마케팅': 1, '개인': 1 });
    assert.deepEqual(payload.computed.byList, { '개발': 1, '마케팅': 1, '개인': 1 });
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
    assert.equal(payload.answerMode, 'fallback');
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
    assert.match(body, /"answerMode":"fallback"/);
  } finally {
    await close(server);
  }
});

test('assistant ask uses Mac mini railway relay for local LLM synthesis when bridge is online', async () => {
  const state = {
    tasks: [
      {
        id: 'task-meeting',
        title: '유니포트 회의 준비',
        date: '2026-07-07',
        status: 'Planned',
        done: false,
      },
    ],
    events: [],
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_RELAY_SCHEDULE_LLM_TIMEOUT_MS: '1000',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createStore(state),
    fetchImpl: async () => {
      throw new Error('assistant ask should use relay instead of runtime fetch');
    },
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=10000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const askPromise = fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '오늘 뭐 해야 돼?',
        filters: { from: '2026-07-07', to: '2026-07-07' },
      }),
    });

    const polled = await pollPromise;
    assert.equal(polled.ok, true);
    assert.equal(polled.job.kind, 'chat.completions');
    assert.equal(polled.job.payload.model, 'qwen2.5:7b');
    assert.equal(polled.job.payload.stream, true);
    assert.match(polled.job.payload.messages[1].content, /유니포트 회의 준비/);

    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-test-token',
      },
      body: JSON.stringify({
        event: 'message',
        data: {
          choices: [
            {
              delta: {
                content: '오늘은 유니포트 회의 준비를 먼저 처리하세요. (근거: 유니포트 회의 준비 7/7)',
              },
            },
          ],
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-test-token',
      },
      body: JSON.stringify({ ok: true }),
    });

    const response = await askPromise;
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.answer, '오늘은 유니포트 회의 준비를 먼저 처리하세요. (근거: 유니포트 회의 준비 7/7)');
    assert.equal(payload.answerMode, 'llm');
    assert.deepEqual(payload.llm, {
      provider: 'local-llm',
      model: 'qwen2.5:7b',
      used: true,
      transport: 'railway-relay',
    });
  } finally {
    await close(server);
  }
});

test('assistant ask retries once when LLM says there are no items despite sources', async () => {
  const state = {
    tasks: [
      {
        id: 'task-meeting',
        title: '유니포트 회의 준비',
        date: '2026-07-08',
        status: 'Planned',
        done: false,
      },
    ],
    events: [],
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
      const content = llmCalls.length === 1
        ? '오늘 일정과 할 일이 모두 없습니다.'
        : '유니포트 회의 준비가 남아 있습니다. (근거: 유니포트 회의 준비 7/8)';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '이번 주 뭐 해야 돼?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();
    const retryBody = JSON.parse(llmCalls[1].init.body);

    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 2);
    assert.equal(payload.answer, '유니포트 회의 준비가 남아 있습니다. (근거: 유니포트 회의 준비 7/8)');
    assert.equal(payload.answerMode, 'llm-retry');
    assert.deepEqual(payload.llm, { provider: 'openai', model: 'gpt-test-calendar', used: true });
    assert.match(retryBody.messages[1].content, /sources가 1건 존재/);
    assert.match(retryBody.messages[1].content, /없다고 말하지 말고 다시 답하라/);
  } finally {
    await close(server);
  }
});

test('assistant ask reports fallback when contradiction retry still contradicts sources', async () => {
  const state = {
    tasks: [
      {
        id: 'task-meeting',
        title: '유니포트 회의 준비',
        date: '2026-07-08',
        status: 'Planned',
        done: false,
      },
    ],
    events: [],
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
        choices: [{ message: { content: '오늘 일정과 할 일이 모두 없습니다.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '이번 주 뭐 해야 돼?',
        filters: { from: '2026-07-01', to: '2026-07-31' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 2);
    assert.equal(payload.answerMode, 'fallback');
    assert.equal(payload.llm.used, false);
    assert.equal(payload.llm.provider, 'openai');
    assert.match(payload.llm.error, /no_items_contradiction/);
    assert.match(payload.answer, /유니포트 회의 준비/);
  } finally {
    await close(server);
  }
});

test('assistant ask labels gateway-store tasks and events with canonical schedule source types', async () => {
  const state = {
    tasks: [
      {
        id: 'task-gateway-shaped',
        title: '유니포트 회의 준비',
        date: '2026-07-01',
        status: 'Planned',
        source: 'railway-gateway',
      },
    ],
    events: [],
    calendarEvents: [
      {
        id: 'event-gateway-shaped',
        title: '팀 주간회의',
        date: '2026-07-01',
        time: '14:30',
        endTime: '15:30',
        source: 'railway-gateway',
      },
    ],
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
    },
    gatewayStore: createStore(state),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '남은 일정과 할 일 뭐가 있어?' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.ok(payload.sources.length >= 2);
    payload.sources.forEach((source) => {
      assert.ok(source.sourceType, 'source must expose sourceType');
      assert.match(source.sourceType, /task|calendar|event|ticktick|schedule/i);
      assert.match(source.type, /task|calendar|event|ticktick|schedule/i);
    });
    const titles = payload.sources.map((source) => source.title);
    assert.ok(titles.includes('유니포트 회의 준비'));
    assert.ok(titles.includes('팀 주간회의'));
  } finally {
    await close(server);
  }
});
