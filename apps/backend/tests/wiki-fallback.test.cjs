const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { chunksFromWikiNotes } = require('../app/lib/wiki-rag');

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

function createEmptyStore() {
  return {
    getState: () => ({
      tasks: [],
      events: [],
      runs: [],
      documents: [],
      chatMessages: [],
      mailMessages: [],
    }),
  };
}

async function createWikiRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-wiki-'));
  await mkdir(path.join(root, '2_wiki'), { recursive: true });
  await writeFile(
    path.join(root, '2_wiki', 'UniPort-시스템구조.md'),
    [
      '# UniPort 시스템구조',
      '',
      'UniPort는 교육 콘텐츠 앱, 프리뷰 렌더러, Railway 백엔드가 같은 콘텐츠 파일을 기준으로 동작한다.',
      '핵심 구조는 사용자 질문을 위키 검색으로 근거화하고 LLM이 그 근거만 사용해 답변하는 것이다.',
      '',
      '상세 운영 로그 '.repeat(80),
      'END_OF_LONG_CONTEXT_SHOULD_NOT_REACH_LLM',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, '2_wiki', 'UniPort-주간-활동-보고서.md'),
    [
      '# UniPort 주간 활동 보고서',
      '',
      'UniPort 시스템구조라는 단어를 언급하지만, 이 문서는 주간 활동과 운영 회의 기록이다.',
      '출시 직후 운영 기준과 팀 피드백 루프를 다룬다.',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('wiki search fallback indexes local LLM-Wiki quickly without LLM synthesis', async () => {
  const wikiRoot = await createWikiRoot();
  const llmCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_OPENAI_OAUTH_URL: 'https://openai-oauth.test',
      AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY: 'oauth-proxy-key',
      AGENT_CALENDAR_OPENAI_MODEL: 'gpt-oauth-wiki',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11435',
      AGENT_CALENDAR_LOCAL_LLM_API_KEY: 'local-llm-key',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
      AGENT_CALENDAR_LOCAL_LLM_MAX_TOKENS: '64',
    },
    gatewayStore: createEmptyStore(),
    fetchImpl: async (url) => {
      if (String(url).includes('/api/embeddings')) {
        return new Response('not found', { status: 404 });
      }
      llmCalls.push({ url: String(url) });
      throw new Error('wiki search should not call an LLM provider');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/wiki/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'UniPort 시스템구조 요약', limit: 3 }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.wikiIndex.fallbackReason, 'local-wiki-root');
    assert.equal(payload.wikiIndex.wikiRoot, wikiRoot);
    assert.ok(payload.sources.length >= 1);
    assert.equal(payload.sources[0].path, '2_wiki/UniPort-시스템구조.md');
    assert.equal(payload.llm.provider, 'none');
    assert.equal(payload.retrieval.mode, 'retrieval_only');
    assert.equal(llmCalls.length, 0);
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('wiki rag chunks markdown on heading boundaries with headingPath metadata', () => {
  const chunks = chunksFromWikiNotes([
    {
      path: '2_wiki/운영.md',
      title: '운영',
      content: [
        '# 운영',
        '',
        '문서 소개',
        '',
        '## 배포',
        '배포 절차는 수정, 백업, 프리뷰 검증, 앱 반영 순서다. '.repeat(18),
        '',
        '## 리스크',
        'Mac mini 단일 장비 의존이 가장 큰 리스크다. '.repeat(18),
      ].join('\n'),
    },
  ]);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some((chunk) => chunk.headingPath === '운영 > 배포'));
  assert.ok(chunks.some((chunk) => chunk.headingPath === '운영 > 리스크'));
  assert.ok(chunks.every((chunk) => chunk.content.length <= 880));
  assert.doesNotMatch(chunks.find((chunk) => chunk.headingPath === '운영 > 배포').content, /## 리스크/);
});

test('wiki search fallback ranks chunks with shared Ollama embeddings and reports model', async () => {
  const wikiRoot = await createWikiRoot();
  await writeFile(
    path.join(wikiRoot, '2_wiki', 'UniPort-개발반영.md'),
    [
      '# UniPort 개발반영',
      '',
      '새 기능은 수정, 백업, 프리뷰 이미지 검증, 앱 반영 순서로 올린다.',
      '반영 절차에서 백업과 프리뷰 검증을 건너뛰지 않는 것이 핵심이다.',
    ].join('\n'),
    'utf8',
  );
  const embeddingPrompts = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
      AGENT_CALENDAR_EMBEDDING_MODEL: 'bge-m3-test',
    },
    gatewayStore: createEmptyStore(),
    fetchImpl: async (url, init = {}) => {
      assert.equal(String(url), 'http://ollama.test/api/embeddings');
      const body = JSON.parse(init.body || '{}');
      embeddingPrompts.push(body.prompt);
      const vector = /새 기능|수정|백업|프리뷰|반영/.test(body.prompt) ? [1, 0] : [0, 1];
      return new Response(JSON.stringify({ embedding: vector }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/wiki/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '새 기능 만들면 실제 앱에 어떻게 올려?', limit: 3 }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.retrieval.embeddingModel, 'bge-m3-test');
    assert.equal(payload.sources[0].path, '2_wiki/UniPort-개발반영.md');
    assert.ok(payload.sources[0].score > payload.sources[1].score);
    assert.ok(embeddingPrompts.some((prompt) => /새 기능 만들면/.test(prompt)));
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('wiki chat stream fallback uses local LLM answer when Hermes runtime is absent', async () => {
  const wikiRoot = await createWikiRoot();
  const llmCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11435',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createEmptyStore(),
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('/api/embeddings')) {
        return new Response('not found', { status: 404 });
      }
      llmCalls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: '스트림 로컬 답변: UniPort 시스템구조는 위키 근거를 바탕으로 요약됩니다.',
          },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        view: 'wiki',
        agent: 'wiki-curator',
        message: [
          '위키 큐레이터 답변.',
          '규칙: SOURCES만 사용.',
          '',
          'Q: UniPort 시스템구조 요약',
          '',
          'SOURCES:',
          '[1] UniPort 주간 활동 보고서 / 근거: 이 문서는 시스템구조가 아니라 주간 활동이다.',
        ].join('\n'),
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(body, /스트림 로컬 답변/);
    assert.match(body, /local-llm/);
    assert.match(body, /"answerMode":"llm"/);
    assert.match(body, /2_wiki\/UniPort-시스템구조\.md/);
    assert.match(llmCalls[0].body.messages[1].content, /^질문:\nUniPort 시스템구조 요약/m);
    assert.ok(llmCalls[0].body.messages[1].content.length < 1400);
    assert.doesNotMatch(llmCalls[0].body.messages[0].content, /최소\s*\d+자/);
    assert.doesNotMatch(llmCalls[0].body.messages[1].content, /END_OF_LONG_CONTEXT_SHOULD_NOT_REACH_LLM/);
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('wiki stream fallback times out stalled OpenAI OAuth before using local LLM', async () => {
  const wikiRoot = await createWikiRoot();
  const llmCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_OPENAI_OAUTH_URL: 'https://openai-oauth.test',
      AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY: 'oauth-proxy-key',
      AGENT_CALENDAR_OPENAI_OAUTH_TIMEOUT_MS: '5',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11435',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createEmptyStore(),
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('/api/embeddings')) {
        return new Response('not found', { status: 404 });
      }
      llmCalls.push({ url: String(url), init });
      if (String(url).startsWith('https://openai-oauth.test')) {
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'OAuth timeout 이후 로컬 LLM이 답했습니다.',
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        view: 'wiki',
        agent: 'wiki-curator',
        message: 'UniPort 시스템구조 요약',
        limit: 3,
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /OAuth timeout 이후/);
    assert.match(body, /"provider":"local-llm"/);
    assert.match(body, /"provider":"openai-oauth"/);
    assert.match(body, /timeout|aborted/i);
    assert.equal(llmCalls.length, 2);
    assert.ok(llmCalls[0].init.signal, 'OAuth request should receive an abort signal');
    const localBody = JSON.parse(llmCalls[1].init.body || '{}');
    assert.doesNotMatch(localBody.messages[0].content, /최소\s*\d+자/);
    assert.match(body, /"answerMode":"llm"/);
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('wiki stream returns no-retrieval without LLM when top score is below threshold', async () => {
  const wikiRoot = await createWikiRoot();
  const calls = [];
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_OLLAMA_URL: 'http://ollama.test',
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11435',
      AGENT_CALENDAR_WIKI_MIN_SCORE: '0.35',
    },
    gatewayStore: createEmptyStore(),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      if (String(url).includes('/api/embeddings')) {
        const prompt = calls.at(-1).body.prompt || '';
        const embedding = /김치찌개/.test(prompt) ? [1, 0] : [0, 1];
        return new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('no-retrieval should not call chat completions');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        view: 'wiki',
        agent: 'wiki-curator',
        message: '김치찌개 맛있게 끓이는 법 알려줘',
        limit: 3,
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /"answerMode":"no-retrieval"/);
    assert.match(body, /위키에서 관련 문서를 찾지 못했어요/);
    assert.equal(calls.some((call) => String(call.url).includes('/chat/completions')), false);
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});
