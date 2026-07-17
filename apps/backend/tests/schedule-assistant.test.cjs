const assert = require('node:assert/strict');
const test = require('node:test');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  ensureCompletionAnswerCoverage,
  scheduleLlmMessages,
} = require('../app/lib/schedule-assistant');

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

test('completion questions send only completed records to the LLM while retaining exact totals', () => {
  const messages = scheduleLlmMessages({
    question: '이번 주 완료한 일정이 뭐야?',
    computed: {
      range: { label: '이번 주', from: '2026-07-13', to: '2026-07-19' },
      total: 2,
      done: 1,
      undone: 1,
      completionRate: 50,
      workCount: 0,
      workHours: 0,
      questionType: 'completion-rate',
    },
    sources: [
      {
        id: 'done-1',
        type: 'task',
        title: '완료한 리포트',
        date: '2026-07-17',
        done: true,
        snippet: '완료한 리포트 상세 설명은 목록 답변에 필요하지 않다.',
      },
      { id: 'open-1', type: 'task', title: '아직 남은 회의', date: '2026-07-18', done: false },
    ],
  });

  assert.match(messages[1].content, /일정\/작업 전체: 2/);
  assert.match(messages[1].content, /완료: 1/);
  assert.match(messages[0].content, /완료 기록을 모두/);
  assert.match(messages[1].content, /완료 DB 기록/);
  assert.match(messages[1].content, /완료한 리포트/);
  assert.doesNotMatch(messages[1].content, /아직 남은 회의/);
  assert.doesNotMatch(messages[1].content, /상세 설명은 목록 답변에 필요하지 않다/);
  assert.doesNotMatch(messages[1].content, /근무\/알바|답변 요구/);
});

test('exact existence lookup excludes unrelated schedules on the same day', async () => {
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({
      tasks: [{
        id: 'unrelated-shift',
        title: '근무',
        date: '2026-07-18',
        time: '15:00',
        status: 'Planned',
        done: false,
      }],
      events: [],
    }),
    fetchImpl: async () => {
      throw new Error('exact lookup must not call an embedding fallback');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '내일 오후 3시에 화성 출장 일정이 등록되어 있어? 없으면 없다고 답해줘.',
        filters: { from: '2026-07-18', to: '2026-07-18' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.computed.total, 0);
    assert.equal(payload.sources.length, 0);
    assert.match(payload.answer, /없|있지 않/);
    assert.equal(payload.search.embeddingModel, 'exact-filter');
    assert.deepEqual(payload.search.constraints, {
      intent: 'existence',
      entity: '화성 출장',
      time: '15:00',
    });
  } finally {
    await close(server);
  }
});

test('calendar conversational follow-up is not misclassified as an exact existence lookup', async () => {
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({ tasks: [], events: [] }),
    fetchImpl: async () => {
      throw new Error('an empty follow-up context must not call network retrieval');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '방금 답변에서 가장 먼저 확인할 항목 하나와 그 이유만 한 문장으로 말해줘.',
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.computed.queryConstraints.exactLookup, false);
    assert.equal(payload.computed.questionType, 'schedule-summary');
    assert.notEqual(payload.search.embeddingModel, 'exact-filter');
  } finally {
    await close(server);
  }
});

test('explicit Korean date limits calendar evidence to that exact day', async () => {
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({
      tasks: [
        { id: 'future-target', title: '미래 계획 회의', date: '2035-01-02', status: 'Planned' },
        { id: 'wrong-day', title: '다른 날 회의', date: '2026-07-18', status: 'Planned' },
      ],
      events: [],
    }),
    fetchImpl: async () => {
      throw new Error('date-scoped lexical retrieval must not call network');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '2035년 1월 2일 일정 알려줘' }),
    });
    const payload = await response.json();

    assert.deepEqual(payload.computed.range, {
      from: '2035-01-02',
      to: '2035-01-02',
      label: '2035년 1월 2일',
    });
    assert.equal(payload.computed.total, 1);
    assert.deepEqual(payload.sources.map((source) => source.id), ['future-target']);
    assert.notEqual(payload.search.embeddingModel, 'hash-fallback');
  } finally {
    await close(server);
  }
});

test('next month question uses the next calendar month instead of all records', async () => {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthAfter = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  const dateKey = (date, day = 1) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const nextMonthLastDay = new Date(Date.UTC(monthAfter.getUTCFullYear(), monthAfter.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({
      tasks: [
        { id: 'next-month', title: '다음 달 일정', date: dateKey(nextMonth, 5), status: 'Planned' },
        { id: 'later', title: '다다음 달 일정', date: dateKey(monthAfter, 5), status: 'Planned' },
      ],
      events: [],
    }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '다음 달 일정 알려줘' }),
    });
    const payload = await response.json();

    assert.equal(payload.computed.range.from, dateKey(nextMonth, 1));
    assert.equal(payload.computed.range.to, nextMonthLastDay);
    assert.equal(payload.computed.total, 1);
    assert.deepEqual(payload.sources.map((source) => source.id), ['next-month']);
  } finally {
    await close(server);
  }
});

test('next weekday question resolves one exact date and is not misclassified as an existence lookup', async () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const current = new Date(`${today}T00:00:00Z`);
  const daysUntilFriday = ((5 - current.getUTCDay() + 7) % 7) || 7;
  const nextFriday = new Date(current);
  nextFriday.setUTCDate(nextFriday.getUTCDate() + daysUntilFriday);
  const nextFridayKey = nextFriday.toISOString().slice(0, 10);
  const nextSaturday = new Date(nextFriday);
  nextSaturday.setUTCDate(nextSaturday.getUTCDate() + 1);
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({
      tasks: [
        { id: 'next-friday', title: '금요일 일정', date: nextFridayKey, status: 'Planned' },
        { id: 'next-saturday', title: '토요일 일정', date: nextSaturday.toISOString().slice(0, 10), status: 'Planned' },
      ],
      events: [],
    }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '다음 금요일 일정이라고 하면 어느 날짜 범위를 확인했는지 먼저 밝히고 답해줘.',
      }),
    });
    const payload = await response.json();

    assert.deepEqual(payload.computed.range, {
      from: nextFridayKey,
      to: nextFridayKey,
      label: `${nextFriday.getUTCFullYear()}년 ${nextFriday.getUTCMonth() + 1}월 ${nextFriday.getUTCDate()}일 (다음 금요일)`,
    });
    assert.equal(payload.computed.queryConstraints.exactLookup, false);
    assert.equal(payload.computed.total, 1);
    assert.deepEqual(payload.sources.map((source) => source.id), ['next-friday']);
  } finally {
    await close(server);
  }
});

test('completion answer coverage appends only grounded records omitted by the LLM', () => {
  const answer = ensureCompletionAnswerCoverage({
    answer: '이번 주에는 리포트 작성(2026-07-17)을 완료했습니다.',
    computed: { questionType: 'completion-rate' },
    sources: [
      { id: 'done-1', title: '리포트 작성', date: '2026-07-17', done: true },
      { id: 'done-2', title: '회의 정리', date: '2026-07-16', done: true },
      { id: 'open-1', title: '다음 주 계획', date: '2026-07-18', done: false },
    ],
  });

  assert.equal((answer.match(/리포트 작성/g) || []).length, 1);
  assert.match(answer, /확인된 나머지 완료 기록/);
  assert.match(answer, /회의 정리 \(2026-07-16\)/);
  assert.doesNotMatch(answer, /다음 주 계획/);
});

test('completion list keeps every completed schedule item beyond the vector-search cutoff', async () => {
  const tasks = Array.from({ length: 21 }, (_, index) => ({
    id: `task-${index}`,
    title: index === 20 ? '아직 남은 일정' : `완료 일정 ${index + 1}`,
    date: '2026-07-17',
    status: index === 20 ? 'Planned' : 'Done',
    done: index !== 20,
  }));
  const server = createRailwayGatewayServer({
    env: { DATABASE_URL: '', HERMES_RUNTIME_URL: '' },
    gatewayStore: createStore({ tasks, events: [] }),
    fetchImpl: async () => {
      throw new Error('use deterministic embedding fallback');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '이번 주 완료한 일정이 뭐야?',
        filters: { from: '2026-07-13', to: '2026-07-19' },
      }),
    });
    const payload = await response.json();
    const completedSources = payload.sources.filter((source) => source.done);

    assert.equal(response.status, 200);
    assert.equal(payload.computed.done, 20);
    assert.equal(completedSources.length, 20);
    assert.equal(completedSources.some((source) => source.id === 'task-19'), true);
  } finally {
    await close(server);
  }
});

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
    assert.match(requestBody.messages[0].content, /목록.*제목.*날짜/);
    assert.match(requestBody.messages[0].content, /근거.*반복하지 마라/);
    assert.match(requestBody.messages[0].content, /요청하지 않은.*다음 액션/);
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

test('assistant ask reports lexical fallback without treating hash vectors as semantic retrieval', async () => {
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
    assert.equal(payload.search.embeddingModel, 'lexical-fallback');
    assert.doesNotMatch(JSON.stringify(payload), /hash-fallback/);
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

test('calendar chat view routes every text request to schedule assistant instead of runtime runs', async () => {
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
        message: '주간 계획 정리',
        view: 'calendar',
        filters: { from: '2026-04-01', to: '2026-07-01' },
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(body, /event: delta/);
    assert.match(body, /backend-calendar-ai-rag/);
    assert.match(body, /"answerMode":"fallback"/);
    const historyResponse = await fetch(`${baseUrl}/api/chat/messages`);
    const history = await historyResponse.json();
    assert.deepEqual(history.messages.map((message) => message.target), ['calendar', 'calendar']);
  } finally {
    await close(server);
  }
});

test('calendar chat streams a persistent Hermes agent turn after bge-m3 retrieval', async () => {
  const relayHeaders = {
    'content-type': 'application/json',
    'x-hermes-relay-token': 'relay-test-token',
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_CALENDAR_AGENT_CHAT_ENABLED: '1',
      HERMES_CALENDAR_AGENT_CONVERSATION_ID: 'agent-calendar-calendar',
      HERMES_RELAY_CALENDAR_SESSION_TURN_TIMEOUT_MS: '1000',
    },
    gatewayStore: createStore({
      tasks: [{
        id: 'task-meeting',
        title: '유니포트 회의 준비',
        date: '2026-07-18',
        time: '10:00',
        status: 'Planned',
        done: false,
      }],
      events: [],
      chatMessages: [
        { role: 'user', text: '오래되어 제외될 캘린더 질문', source: 'schedule-assistant', target: 'calendar' },
        { role: 'user', text: '오늘 일정이 있어?', source: 'schedule-assistant', target: 'calendar' },
        { role: 'assistant', text: '오늘은 유니포트 회의 준비가 있습니다.', source: 'schedule-assistant', target: 'calendar' },
        { role: 'user', text: '내일은?', source: 'schedule-assistant', target: 'calendar' },
        { role: 'assistant', text: '내일도 회의 준비를 이어가세요.', source: 'schedule-assistant', target: 'calendar' },
        { role: 'user', text: '대상이 없는 레거시 질문', source: 'schedule-assistant' },
        { role: 'assistant', text: '가'.repeat(650), source: 'schedule-assistant', target: 'calendar' },
        { role: 'system', text: '시스템 메시지는 제외해야 합니다.', source: 'schedule-assistant', target: 'calendar' },
        { role: 'assistant', text: '위키 답변은 제외해야 합니다.', source: 'wiki-fallback', target: 'wiki' },
        { role: 'assistant', text: '명시적 위키 대상은 source가 달라도 제외해야 합니다.', source: 'schedule-assistant', target: 'wiki' },
      ],
    }),
  });
  const baseUrl = await listen(server);
  let pendingJob = null;

  try {
    const firstPoll = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const responsePromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '내일 무엇부터 하면 좋을까?',
        view: 'calendar',
        filters: { from: '2026-07-18', to: '2026-07-18' },
      }),
    });

    const first = await firstPoll;
    pendingJob = first.job;
    if (first.job.kind !== 'calendar.search') {
      await fetch(`${baseUrl}/api/relay/jobs/${first.job.id}/complete`, {
        method: 'POST',
        headers: relayHeaders,
        body: JSON.stringify({ ok: false, error: 'unexpected_job_kind' }),
      });
      await responsePromise.then((response) => response.text());
    }
    assert.equal(first.job.kind, 'calendar.search');
    assert.equal(first.job.payload.query, '내일 무엇부터 하면 좋을까?');
    assert.deepEqual(first.job.payload.records.map((record) => record.id), ['task-meeting']);

    const secondPoll = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/relay/jobs/${first.job.id}/complete`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        ok: true,
        sources: [{
          id: 'task-meeting',
          title: '유니포트 회의 준비',
          date: '2026-07-18',
          time: '10:00',
          done: false,
          sourceType: 'task',
          score: 0.88,
        }],
        retrieval: {
          source: 'calendar-vector-index',
          mode: 'vector-hybrid',
          embeddingModel: 'bge-m3',
        },
      }),
    });

    const second = await secondPoll;
    pendingJob = second.job;
    assert.equal(second.job.kind, 'agent.chat');
    assert.equal(second.job.payload.profile, 'calendarassistant');
    assert.equal(second.job.payload.message, '내일 무엇부터 하면 좋을까?');
    assert.equal(second.job.payload.conversationId, 'agent-calendar-calendar');
    assert.equal(second.job.payload.context.sources[0].title, '유니포트 회의 준비');
    assert.deepEqual(second.job.payload.context.recentTurns, [
      { role: 'user', text: '오늘 일정이 있어?' },
      { role: 'assistant', text: '오늘은 유니포트 회의 준비가 있습니다.' },
      { role: 'user', text: '내일은?' },
      { role: 'assistant', text: '내일도 회의 준비를 이어가세요.' },
      { role: 'user', text: '대상이 없는 레거시 질문' },
      { role: 'assistant', text: '가'.repeat(600) },
    ]);

    const response = await responsePromise;
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamed = '';

    await fetch(`${baseUrl}/api/relay/jobs/${second.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'accepted',
        data: {
          type: 'accepted',
          requestId: second.job.payload.requestId,
          provider: 'custom:ollama',
          model: 'qwen2.5:7b',
          sessionVersion: 'direct-api-v1',
          queued: false,
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${second.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'delta',
        data: {
          type: 'delta',
          requestId: second.job.payload.requestId,
          sequence: 1,
          text: '내일은 유니포트 회의 준비부터 ',
        },
      }),
    });

    while (!streamed.includes('유니포트 회의 준비부터')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'the first answer delta must arrive before completion');
      streamed += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(streamed, /event: delta/);
    assert.doesNotMatch(streamed, /event: done/);

    await fetch(`${baseUrl}/api/relay/jobs/${second.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'completed',
        data: {
          type: 'completed',
          requestId: second.job.payload.requestId,
          text: '내일은 유니포트 회의 준비부터 하세요.',
          provider: 'custom:ollama',
          model: 'qwen2.5:7b',
          sessionVersion: 'direct-api-v1',
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${second.job.id}/complete`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({ ok: true }),
    });
    pendingJob = null;

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += decoder.decode(chunk.value, { stream: true });
    }
    streamed += decoder.decode();
    assert.match(streamed, /event: done/);
    assert.match(streamed, /"embeddingModel":"bge-m3"/);
    assert.match(streamed, /"agent":"calendarassistant"/);
    assert.doesNotMatch(streamed, /hash-fallback/);
  } finally {
    if (pendingJob?.id) {
      await fetch(`${baseUrl}/api/relay/jobs/${pendingJob.id}/complete`, {
        method: 'POST',
        headers: relayHeaders,
        body: JSON.stringify({ ok: false, error: 'test_cleanup' }),
      }).catch(() => {});
    }
    await close(server);
  }
});

test('calendar agent context keeps only six compact sources for prompt latency', async () => {
  const relayHeaders = {
    'content-type': 'application/json',
    'x-hermes-relay-token': 'relay-test-token',
  };
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `우선순위 작업 ${index + 1}`,
    date: '2026-07-18',
    status: 'Planned',
    done: false,
    notes: `상세 메모 ${index + 1} ${'가'.repeat(400)}`,
  }));
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_CALENDAR_AGENT_CHAT_ENABLED: '1',
      HERMES_RELAY_CALENDAR_SESSION_TURN_TIMEOUT_MS: '1000',
    },
    gatewayStore: createStore({ tasks, events: [] }),
  });
  const baseUrl = await listen(server);
  let pendingJob = null;

  try {
    const searchPoll = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const responsePromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '내일 무엇부터 하면 좋을까?',
        view: 'calendar',
        filters: { from: '2026-07-18', to: '2026-07-18' },
      }),
    });
    const search = await searchPoll;
    pendingJob = search.job;
    assert.equal(search.job.kind, 'calendar.search');

    const agentPoll = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await fetch(`${baseUrl}/api/relay/jobs/${search.job.id}/complete`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        ok: true,
        sources: tasks.map((task, index) => ({
          ...task,
          sourceType: 'task',
          snippet: `긴 검색 본문 ${index + 1} ${'나'.repeat(400)}`,
          score: 1 - (index * 0.01),
        })),
        retrieval: { embeddingModel: 'bge-m3', mode: 'vector-hybrid' },
      }),
    });
    const agent = await agentPoll;
    pendingJob = agent.job;

    assert.equal(agent.job.kind, 'agent.chat');
    assert.equal(agent.job.payload.context.sources.length, 6);
    assert.ok(agent.job.payload.context.sources.every((source) => source.snippet.length <= 180));

    await fetch(`${baseUrl}/api/relay/jobs/${agent.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'completed',
        data: {
          type: 'completed',
          requestId: agent.job.payload.requestId,
          text: '우선순위 작업 1부터 처리하세요.',
          provider: 'custom',
          model: 'qwen2.5:7b',
          sessionVersion: 'direct-api-v1',
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${agent.job.id}/complete`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({ ok: true }),
    });
    pendingJob = null;
    const response = await responsePromise;
    assert.equal(response.status, 200);
  } finally {
    if (pendingJob?.id) {
      await fetch(`${baseUrl}/api/relay/jobs/${pendingJob.id}/complete`, {
        method: 'POST',
        headers: relayHeaders,
        body: JSON.stringify({ ok: false, error: 'test_cleanup' }),
      }).catch(() => {});
    }
    await close(server);
  }
});

test('calendar chat never exposes a positive agent claim when exact lookup found no schedule', async () => {
  const relayHeaders = {
    'content-type': 'application/json',
    'x-hermes-relay-token': 'relay-test-token',
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_CALENDAR_AGENT_CHAT_ENABLED: '1',
      HERMES_CALENDAR_AGENT_CONVERSATION_ID: 'agent-calendar-calendar',
      HERMES_RELAY_CALENDAR_SESSION_TURN_TIMEOUT_MS: '1000',
    },
    gatewayStore: createStore({
      tasks: [{ id: 'unrelated', title: '근무', date: '2026-07-18', time: '15:00', status: 'Planned' }],
      events: [],
    }),
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chatPromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '내일 오후 3시에 화성 출장 일정이 등록되어 있어?',
        view: 'calendar',
        filters: { from: '2026-07-18', to: '2026-07-18' },
      }),
    });
    const polled = await pollPromise;

    assert.equal(polled.job.kind, 'agent.chat');
    assert.equal(polled.job.payload.context.facts.matched, false);
    assert.deepEqual(polled.job.payload.context.sources, []);
    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'delta',
        data: {
          type: 'delta',
          requestId: polled.job.payload.requestId,
          sequence: 1,
          text: '네, 해당 일정이 등록되어 있습니다.',
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'completed',
        data: {
          type: 'completed',
          requestId: polled.job.payload.requestId,
          text: '네, 해당 일정이 등록되어 있습니다.',
          provider: 'custom:ollama',
          model: 'qwen2.5:7b',
          sessionVersion: 'direct-api-v1',
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({ ok: true }),
    });

    const response = await chatPromise;
    const body = await response.text();
    assert.match(body, /등록되어 있지 않습니다/);
    assert.doesNotMatch(body, /네, 해당 일정이 등록되어 있습니다/);
    assert.match(body, /"sourceCount":0/);
  } finally {
    await close(server);
  }
});

test('calendar exact lookup replaces multilingual agent drift with one grounded sentence', async () => {
  const relayHeaders = {
    'content-type': 'application/json',
    'x-hermes-relay-token': 'relay-test-token',
  };
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_CALENDAR_AGENT_CHAT_ENABLED: '1',
      HERMES_RELAY_CALENDAR_SESSION_TURN_TIMEOUT_MS: '1000',
    },
    gatewayStore: createStore({
      tasks: [{ id: 'shift', title: '근무', date: '2026-07-18', status: 'Planned' }],
      events: [],
    }),
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chatPromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '내일 근무 일정 있어?',
        view: 'calendar',
        filters: { from: '2026-07-18', to: '2026-07-18' },
      }),
    });
    const agent = await pollPromise;
    assert.equal(agent.job.kind, 'agent.chat');
    assert.equal(agent.job.payload.context.facts.matched, true);

    const drift = `네, 내일 근무 일정이 있습니다. ${'불필요한 설명 '.repeat(20)}的帮助信息`;
    await fetch(`${baseUrl}/api/relay/jobs/${agent.job.id}/events`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({
        event: 'completed',
        data: {
          type: 'completed',
          requestId: agent.job.payload.requestId,
          text: drift,
          provider: 'custom',
          model: 'qwen2.5:7b',
          sessionVersion: 'direct-api-v1',
        },
      }),
    });
    await fetch(`${baseUrl}/api/relay/jobs/${agent.job.id}/complete`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify({ ok: true }),
    });

    const response = await chatPromise;
    const body = await response.text();
    assert.match(body, /근무.*일정이 1건 등록되어 있습니다/);
    assert.doesNotMatch(body, /的帮助信息|불필요한 설명/);
  } finally {
    await close(server);
  }
});

test('calendar chat stream uses Mac mini railway relay for local LLM synthesis when bridge is online', async () => {
  const state = {
    tasks: [{
      id: 'task-meeting',
      title: '유니포트 회의 준비',
      date: '2026-07-07',
      status: 'Planned',
      done: false,
    }],
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
      throw new Error('calendar chat stream should use relay instead of runtime fetch');
    },
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const chatPromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '오늘 뭐 해야 돼?',
        view: 'calendar',
        filters: { from: '2026-07-07', to: '2026-07-07' },
      }),
    });

    const polled = await pollPromise;
    assert.equal(polled.ok, true);
    assert.equal(polled.job.kind, 'chat.completions');
    assert.equal(polled.job.payload.model, 'qwen2.5:7b');
    assert.match(polled.job.payload.messages[1].content, /유니포트 회의 준비/);

    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-test-token',
      },
      body: JSON.stringify({
        event: 'message',
        data: { choices: [{ delta: { content: '오늘은 유니포트 회의 준비를 먼저 처리하세요.' } }] },
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

    const response = await chatPromise;
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(body, /오늘은 유니포트 회의 준비를 먼저 처리하세요/);
    assert.match(body, /"provider":"local-llm"/);
    assert.match(body, /"model":"qwen2.5:7b"/);
    assert.match(body, /"transport":"railway-relay"/);
  } finally {
    await close(server);
  }
});

test('calendar chat stream returns computed fallback when Mac mini local LLM rejects the model', async () => {
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_RELAY_SCHEDULE_LLM_TIMEOUT_MS: '1000',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createStore({
      tasks: [{ id: 'task-meeting', title: '유니포트 회의 준비', date: '2026-07-07', status: 'Planned', done: false }],
      events: [],
    }),
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const chatPromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '오늘 뭐 해야 돼?',
        view: 'calendar',
        filters: { from: '2026-07-07', to: '2026-07-07' },
      }),
    });

    const polled = await pollPromise;
    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-test-token',
      },
      body: JSON.stringify({ ok: false, error: "model 'qwen2.5:7b' not found" }),
    });

    const response = await chatPromise;
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: delta/);
    assert.match(body, /유니포트 회의 준비/);
    assert.match(body, /"answerMode":"fallback"/);
    assert.match(body, /"used":false/);
    assert.match(body, /"transport":"railway-relay"/);
    assert.doesNotMatch(body, /event: error/);
  } finally {
    await close(server);
  }
});

test('calendar chat stream returns computed fallback before the desktop request times out', async () => {
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_RELAY_TOKEN: 'relay-test-token',
      HERMES_RELAY_SCHEDULE_STREAM_TIMEOUT_MS: '25',
      HERMES_RELAY_SCHEDULE_LLM_TIMEOUT_MS: '5000',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createStore({
      tasks: [{ id: 'task-meeting', title: '유니포트 회의 준비', date: '2026-07-07', status: 'Planned', done: false }],
      events: [],
    }),
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-test-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '오늘 뭐 해야 돼?',
        view: 'calendar',
        filters: { from: '2026-07-07', to: '2026-07-07' },
      }),
    });
    const body = await response.text();
    const polled = await pollPromise;

    assert.equal(polled.job.kind, 'chat.completions');
    assert.equal(response.status, 200);
    assert.ok(Date.now() - startedAt < 2000, 'computed fallback should beat the desktop timeout');
    assert.match(body, /event: delta/);
    assert.match(body, /유니포트 회의 준비/);
    assert.match(body, /"answerMode":"fallback"/);
    assert.match(body, /"transport":"railway-relay"/);
    assert.doesNotMatch(body, /event: error/);
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
