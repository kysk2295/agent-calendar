const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const goldenSet = require('./fixtures/golden-set.json');
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

function createGoldenStore() {
  const state = {
    tasks: [
      { id: 'task-tax', title: '세금계산서 발행', date: '2026-07-04', due: '2026-07-04', status: 'Planned', tags: ['finance'], list: '운영' },
      { id: 'task-meeting-prep', title: '유니포트 회의 준비', date: '2026-07-08', due: '2026-07-08', status: 'Planned', tags: ['UniPort'], list: 'UniPort' },
      { id: 'task-cardnews', title: '카드뉴스 초안', date: '2026-07-09', due: '2026-07-09', status: 'Planned', tags: ['UniPort'], list: 'UniPort' },
      { id: 'task-done-draft', title: '초안 검토 완료', date: '2026-07-07', status: 'Done', done: true, tags: ['UniPort'], list: 'UniPort' },
    ],
    events: [
      { id: 'event-hospital', title: '병원 예약', date: '2026-07-07', time: '10:30', endTime: '11:00', kind: 'calendar-event', type: 'calendar-event' },
      { id: 'event-weekly', title: '팀 주간회의', date: '2026-07-07', time: '14:30', endTime: '15:30', kind: 'calendar-event', type: 'calendar-event' },
      { id: 'event-investor', title: '유니포트 투자자 미팅', date: '2026-07-07', time: '15:00', endTime: '16:00', kind: 'calendar-event', type: 'calendar-event' },
    ],
    calendarEvents: [],
    externalCalendarEvents: [],
    ticktickTasks: [],
    runs: [],
    documents: [],
    chatMessages: [],
    mailMessages: [],
  };
  return { getState: () => state };
}

async function createGoldenWikiRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-golden-wiki-'));
  await mkdir(path.join(root, '2_wiki'), { recursive: true });
  await writeFile(path.join(root, '2_wiki', 'UniPort-시스템구조.md'), [
    '# UniPort 시스템구조',
    '',
    '## 채널 구조',
    'Hermes는 사용자 요청을 받아 LLM Wiki의 프로젝트 지식을 읽고 작업을 수행한다.',
    '',
    '## 실행 층',
    'Railway 백엔드는 DB와 API를 담당하고 Mac mini는 로컬 LLM 추론을 담당한다. Mac mini 단일 장비 의존은 운영 리스크다.',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, '2_wiki', 'UniPort-개발반영.md'), [
    '# UniPort 개발반영',
    '',
    '## 반영 절차',
    '새 기능은 수정, 백업, 프리뷰 이미지 검증, 앱 반영 순서로 올린다.',
    '릴리즈와 콘텐츠 수정 뒤에는 백업과 프리뷰 검증을 건너뛰지 않는다.',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, '2_wiki', 'Mac-mini-운영.md'), [
    '# Mac mini 운영',
    '',
    '## 리스크',
    'Mac mini는 로컬 LLM 추론을 맡는 단일 장비다. 이 장비가 멈추면 로컬 답변 경로가 중단된다.',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, '2_wiki', '위키-AI-운영원칙.md'), [
    '# 위키 AI 운영원칙',
    '',
    '## 답변 원칙',
    '위키 답변은 제공된 위키 청크에만 근거해야 한다. 위키에 없는 내용은 없다고 말하고 지어내지 않는다.',
    '각 문단 끝에는 출처를 표기한다. 웹 검색은 사용하지 않는다.',
  ].join('\n'), 'utf8');
  return root;
}

function embeddingVector(prompt = '') {
  if (/김치찌개|프로야구/.test(prompt)) return [0, 0, 0, 0];
  if (/개발반영|새 기능|릴리즈|반영|백업|프리뷰|검증|건너/.test(prompt)) return [1, 0, 0, 0];
  if (/Mac mini|로컬 LLM|단일 장비|운영 리스크|멈추|실행 층|Railway 백엔드/.test(prompt)) return [0, 1, 0, 0];
  if (/위키 AI|위키 답변|위키 청크|출처|없는 내용|근거/.test(prompt)) return [0, 0, 1, 0];
  if (/UniPort|Hermes|Railway|시스템 구조|시스템구조|실행 층/.test(prompt)) return [0, 0, 0, 1];
  if (/병원|세금계산서|유니포트|카드뉴스|회의|완료율|시간|작업|일정/.test(prompt)) return [1, 1, 0, 0];
  return [0.1, 0.1, 0.1, 0.1];
}

function createGoldenFetch() {
  return async (url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    if (String(url).endsWith('/api/embeddings')) {
      return new Response(JSON.stringify({ embedding: embeddingVector(body.prompt || '') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/chat/completions')) {
      const prompt = JSON.stringify(body.messages || []);
      const answer = /제주도/.test(prompt)
        ? '다음 달 제주도 관련 일정은 찾지 못했어요.'
        : '병원, 유니포트, 카드뉴스, 회의 준비, 팀 주간회의, 세금계산서, 초안, 완료율, 시간 근거를 바탕으로 답합니다. (근거: 테스트 골든셋)';
      return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function includesAll(haystack, needles = []) {
  return needles.every((needle) => String(haystack).includes(needle));
}

test('golden fixture contains calendar 15 and wiki 15 cases', () => {
  assert.equal(goldenSet.filter((entry) => entry.kind === 'calendar').length, 15);
  assert.equal(goldenSet.filter((entry) => entry.kind === 'wiki').length, 15);
});

test('api golden calendar cases satisfy hard schema and source isolation', async () => {
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
      AGENT_CALENDAR_EMBEDDING_MODEL: 'bge-m3-test',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://local-llm.test',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createGoldenStore(),
    fetchImpl: createGoldenFetch(),
  });
  const baseUrl = await listen(server);
  try {
    for (const entry of goldenSet.filter((item) => item.kind === 'calendar')) {
      const response = await fetch(`${baseUrl}/api/assistant/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: entry.question }),
      });
      const payload = await response.json();
      const haystack = `${payload.answer}\n${JSON.stringify(payload.computed || {})}\n${JSON.stringify(payload.sources || [])}`;

      assert.equal(response.status, 200, entry.question);
      assert.equal(payload.search?.strategy, 'backend-calendar-ai-rag', entry.question);
      assert.equal(payload.search?.intent, 'ask', entry.question);
      assert.ok(['llm', 'llm-retry', 'llm-augmented', 'fallback'].includes(payload.answerMode), entry.question);
      assert.equal(payload.computed?.questionType, entry.expectedComputed.questionType, entry.question);
      assert.ok(includesAll(haystack, entry.mustIncludeFacts), entry.question);
      for (const forbidden of entry.mustNotInclude || []) assert.doesNotMatch(payload.answer || '', new RegExp(forbidden), entry.question);
      for (const source of payload.sources || []) {
        assert.doesNotMatch(String(source.sourceType || source.type || source.source || ''), /wiki|chat|mail/i, entry.question);
      }
    }
  } finally {
    await close(server);
  }
});

test('api golden wiki cases satisfy retrieval contract and no calendar contamination', async () => {
  const wikiRoot = await createGoldenWikiRoot();
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
      AGENT_CALENDAR_EMBEDDING_MODEL: 'bge-m3-test',
      AGENT_CALENDAR_WIKI_MIN_SCORE: '0.35',
    },
    gatewayStore: createGoldenStore(),
    fetchImpl: createGoldenFetch(),
  });
  const baseUrl = await listen(server);
  try {
    for (const entry of goldenSet.filter((item) => item.kind === 'wiki')) {
      const response = await fetch(`${baseUrl}/api/wiki/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: entry.question, limit: 4 }),
      });
      const payload = await response.json();
      const haystack = `${payload.answer}\n${JSON.stringify(payload.sources || [])}`;

      assert.equal(response.status, 200, entry.question);
      assert.equal(payload.retrieval?.source, entry.expectedRetrieval, entry.question);
      assert.ok(payload.answerMode, entry.question);
      assert.ok(includesAll(haystack, entry.mustIncludeFacts), entry.question);
      for (const forbidden of entry.mustNotInclude || []) assert.doesNotMatch(haystack, new RegExp(forbidden), entry.question);
      for (const source of payload.sources || []) {
        assert.doesNotMatch(String(source.path || source.source || ''), /task|calendar|chat|mail/i, entry.question);
      }
      if (entry.expectedAnswerMode) {
        assert.equal(payload.answerMode, entry.expectedAnswerMode, entry.question);
        assert.equal(payload.llm?.used, false, entry.question);
      } else if (entry.expectedFirstSourcePath) {
        assert.equal(payload.sources?.[0]?.path, entry.expectedFirstSourcePath, entry.question);
      }
    }
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});
