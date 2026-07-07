const assert = require('node:assert/strict');
const test = require('node:test');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { buildScheduleIngestDrafts, isScheduleIngestCommand } = require('../app/lib/schedule-ingest');

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
  const writes = [];
  return {
    getState: () => state,
    addCalendarEvent: (event) => {
      writes.push({ type: 'calendar-event', event });
      return event;
    },
    createTask: (task) => {
      writes.push({ type: 'task', task });
      return task;
    },
    writes,
  };
}

test('assistant ingest extracts text command drafts without writing to DB', async () => {
  const store = createStore({ tasks: [], events: [] });
  const llmCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: store,
    fetchImpl: async (url, init = {}) => {
      llmCalls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                drafts: [
                  {
                    kind: 'event',
                    title: '유니포트 투자자 미팅',
                    date: '2026-07-08',
                    start: '15:00',
                    end: '16:00',
                    location: null,
                    notes: '원문: "내일 3시 유니포트 투자자 미팅"',
                    confidence: 'high',
                  },
                ],
                warnings: [],
              }),
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '내일 3시 유니포트 투자자 미팅 잡아줘' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.search.intent, 'ingest');
    assert.equal(payload.ingest.ocrEngine, 'none');
    assert.equal(payload.drafts.length, 1);
    assert.deepEqual(payload.drafts[0], {
      kind: 'event',
      title: '유니포트 투자자 미팅',
      date: '2026-07-08',
      start: '15:00',
      end: '16:00',
      location: null,
      notes: '원문: "내일 3시 유니포트 투자자 미팅"',
      confidence: 'high',
    });
    assert.deepEqual(payload.conflicts, []);
    assert.equal(store.writes.length, 0);
    assert.match(llmCalls[0].body.messages[1].content, /오늘 날짜: 2026-07-07/);
    assert.match(llmCalls[0].body.messages[1].content, /이미지\/텍스트에 없는 일정을 만들어내지 마라/);
  } finally {
    await close(server);
  }
});

test('assistant ingest drops invalid draft dates and returns warnings', async () => {
  const store = createStore({ tasks: [], events: [] });
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
    },
    gatewayStore: store,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              drafts: [
                {
                  kind: 'event',
                  title: '날짜 없는 약속',
                  date: '다음주',
                  start: '15:00',
                  end: null,
                  location: null,
                  notes: '원문: "다음주 약속"',
                  confidence: 'low',
                },
              ],
              warnings: [],
            }),
          },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '다음주 약속 잡아줘' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.drafts, []);
    assert.match(payload.warnings.join('\n'), /날짜 없는 약속/);
    assert.equal(store.writes.length, 0);
  } finally {
    await close(server);
  }
});

test('assistant ingest detects conflicts against existing calendar events', async () => {
  const store = createStore({
    tasks: [],
    events: [
      { id: 'event-weekly', title: '팀 주간회의', date: '2026-07-08', time: '14:30', endTime: '15:30' },
    ],
  });
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
    },
    gatewayStore: store,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              drafts: [
                {
                  kind: 'event',
                  title: '유니포트 투자자 미팅',
                  date: '2026-07-08',
                  start: '15:00',
                  end: '16:00',
                  location: null,
                  notes: '원문: "7월 8일 3시 미팅"',
                  confidence: 'high',
                },
              ],
              warnings: [],
            }),
          },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '7월 8일 3시 유니포트 투자자 미팅 잡아줘' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.conflicts.length, 1);
    assert.equal(payload.conflicts[0].draftIndex, 0);
    assert.equal(payload.conflicts[0].existing.title, '팀 주간회의');
    assert.equal(store.writes.length, 0);
  } finally {
    await close(server);
  }
});

test('assistant ask endpoint routes imperative schedule text to ingest intent', async () => {
  const store = createStore({ tasks: [], events: [] });
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
    },
    gatewayStore: store,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              drafts: [
                {
                  kind: 'event',
                  title: '유니포트 회의',
                  date: '2026-07-08',
                  start: '15:00',
                  end: null,
                  location: null,
                  notes: '원문: "내일 3시 유니포트 회의"',
                  confidence: 'high',
                },
              ],
              warnings: [],
            }),
          },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '내일 3시 유니포트 회의 잡아줘' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.search.intent, 'ingest');
    assert.equal(payload.drafts.length, 1);
    assert.equal(payload.drafts[0].title, '유니포트 회의');
    assert.equal(store.writes.length, 0);
  } finally {
    await close(server);
  }
});

test('assistant ingest accepts multipart image attachment with text without writing to DB', async () => {
  const store = createStore({ tasks: [], events: [] });
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
    },
    gatewayStore: store,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              drafts: [
                {
                  kind: 'event',
                  title: '병원 예약',
                  date: '2026-07-21',
                  start: '10:30',
                  end: null,
                  location: null,
                  notes: '원문: "7/21 오전 10:30 예약"',
                  confidence: 'low',
                },
              ],
              warnings: [],
            }),
          },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const baseUrl = await listen(server);

  try {
    const form = new FormData();
    form.set('text', '7/21 오전 10:30 병원 예약');
    form.set('image', new Blob(['fake image'], { type: 'image/png' }), 'reservation.png');
    const response = await fetch(`${baseUrl}/api/assistant/ingest`, {
      method: 'POST',
      body: form,
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.search.intent, 'ingest');
    assert.equal(payload.ingest.ocrEngine, 'apple-vision');
    assert.equal(payload.drafts[0].title, '병원 예약');
    assert.equal(payload.drafts[0].confidence, 'low');
    assert.equal(store.writes.length, 0);
  } finally {
    await close(server);
  }
});

test('assistant ingest uses Apple Vision OCR text for image-only drafts', async () => {
  const llmCalls = [];
  const result = await buildScheduleIngestDrafts({
    imageFile: {
      filename: 'reservation.png',
      contentType: 'image/png',
      buffer: Buffer.from('fake image'),
    },
    state: { tasks: [], events: [] },
    env: {
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    ocrRunner: async ({ file }) => {
      assert.equal(file.filename, 'reservation.png');
      return {
        engine: 'apple-vision',
        text: '[OO정형외과] 김세오님 7/21(화) 오전 10:30 예약되었습니다',
        blocks: [{ text: '7/21(화) 오전 10:30 예약되었습니다', confidence: 0.94 }],
      };
    },
    fetchImpl: async (url, init = {}) => {
      llmCalls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                drafts: [
                  {
                    kind: 'event',
                    title: 'OO정형외과 예약',
                    date: '2026-07-21',
                    start: '10:30',
                    end: null,
                    location: null,
                    notes: '원문: "7/21(화) 오전 10:30 예약되었습니다"',
                    confidence: 'low',
                  },
                ],
                warnings: [],
              }),
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ingest.ocrEngine, 'apple-vision');
  assert.equal(result.drafts[0].title, 'OO정형외과 예약');
  assert.equal(result.drafts[0].start, '10:30');
  assert.match(llmCalls[0].body.messages[1].content, /OO정형외과/);
});

test('assistant ingest falls back to qwen vision model when Apple OCR text is sparse', async () => {
  const models = [];
  const result = await buildScheduleIngestDrafts({
    imageFile: {
      filename: 'poster.png',
      contentType: 'image/png',
      buffer: Buffer.from('fake image'),
    },
    state: { tasks: [], events: [] },
    env: {
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11434',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
      AGENT_CALENDAR_VISION_LLM_MODEL: 'qwen2.5vl:7b',
    },
    ocrRunner: async () => ({
      engine: 'apple-vision',
      text: '7/2',
      blocks: [{ text: '7/2', confidence: 0.3 }],
    }),
    fetchImpl: async (url, init = {}) => {
      const body = JSON.parse(init.body || '{}');
      models.push(body.model);
      if (body.model === 'qwen2.5vl:7b') {
        return new Response(JSON.stringify({
          choices: [{ message: { content: '7월 22일 화요일 오후 7시 UniPort 데모데이 포스터' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                drafts: [
                  {
                    kind: 'event',
                    title: 'UniPort 데모데이',
                    date: '2026-07-22',
                    start: '19:00',
                    end: null,
                    location: null,
                    notes: '원문: "7월 22일 화요일 오후 7시 UniPort 데모데이"',
                    confidence: 'high',
                  },
                ],
                warnings: [],
              }),
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ingest.ocrEngine, 'qwen-vl');
  assert.deepEqual(models, ['qwen2.5vl:7b', 'qwen2.5:7b']);
  assert.equal(result.drafts[0].title, 'UniPort 데모데이');
});

test('isScheduleIngestCommand accepts imperative commands and rejects questions', () => {
  assert.equal(isScheduleIngestCommand('내일 3시 회의 잡아줘'), true);
  assert.equal(isScheduleIngestCommand('8월 14일 제주도 여행 등록해줘'), true);
  assert.equal(isScheduleIngestCommand('다음 주 화요일 병원 예약 추가해줘'), true);
  assert.equal(isScheduleIngestCommand('잡아둔 일정 중에 이번 주 남은 것 알려줘'), false);
  assert.equal(isScheduleIngestCommand('등록된 일정 뭐가 있어?'), false);
  assert.equal(isScheduleIngestCommand('회의를 언제 잡아야 할까?'), false);
  assert.equal(isScheduleIngestCommand('오늘 일정 알려줘'), false);
  assert.equal(isScheduleIngestCommand(''), false);
});

test('assistant ask keeps schedule questions containing 잡아둔 on the ask path', async () => {
  const store = createStore({ tasks: [], events: [] });
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
    },
    gatewayStore: store,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/assistant/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '잡아둔 일정 중에 이번 주 남은 것 알려줘' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.search.intent, 'ask');
    assert.equal(payload.drafts, undefined);
    assert.ok(payload.answer.length > 0);
    assert.equal(store.writes.length, 0);
  } finally {
    await close(server);
  }
});

test('buildScheduleIngestDrafts extracts drafts through an injected relay completion when no LLM URL exists', async () => {
  const completionCalls = [];
  const result = await buildScheduleIngestDrafts({
    textInput: '내일 3시 유니포트 회의 잡아줘',
    state: { events: [] },
    env: {},
    completionImpl: async ({ model, temperature, messages }) => {
      completionCalls.push({ model, temperature, messages });
      return JSON.stringify({
        drafts: [
          {
            kind: 'event',
            title: '유니포트 회의',
            date: '2026-07-08',
            start: '15:00',
            end: null,
            location: null,
            notes: '원문: "내일 3시 유니포트 회의"',
            confidence: 'high',
          },
        ],
        warnings: [],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(completionCalls.length, 1);
  assert.equal(completionCalls[0].temperature, 0.1);
  assert.ok(completionCalls[0].messages[1].content.includes('내일 3시 유니포트 회의'));
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].title, '유니포트 회의');
  assert.equal(result.llm.provider, 'local-llm');
  assert.equal(result.llm.used, true);
  assert.equal(result.llm.transport, 'railway-relay');
});

test('buildScheduleIngestDrafts reports an honest warning when the relay completion returns empty text', async () => {
  const result = await buildScheduleIngestDrafts({
    textInput: '내일 3시 유니포트 회의 잡아줘',
    state: { events: [] },
    env: {},
    completionImpl: async () => '',
  });

  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('relay LLM이 빈 응답')));
  assert.equal(result.llm.used, false);
  assert.equal(result.llm.transport, 'railway-relay');
});
