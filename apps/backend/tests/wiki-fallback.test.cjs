const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
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
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('wiki search fallback indexes local LLM-Wiki and falls back from OpenAI OAuth to local LLM', async () => {
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
    },
    gatewayStore: createEmptyStore(),
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
              content: '로컬 Qwen 위키 응답: UniPort는 앱, 프리뷰, Railway 백엔드가 같은 콘텐츠 파일을 기준으로 연결됩니다.',
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    assert.match(payload.answer, /로컬 Qwen 위키 응답/);
    assert.equal(payload.llm.provider, 'local-llm');
    assert.equal(payload.llm.model, 'qwen2.5:7b');
    assert.equal(payload.llm.used, true);
    assert.equal(payload.llmAttempts.length, 2);
    assert.equal(llmCalls.length, 2);
    assert.equal(llmCalls[0].url, 'https://openai-oauth.test/v1/chat/completions');
    assert.equal(llmCalls[1].url, 'http://127.0.0.1:11435/v1/chat/completions');
    assert.equal(llmCalls[1].init.headers.authorization, 'Bearer local-llm-key');
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});

test('wiki chat stream fallback uses local LLM answer when Hermes runtime is absent', async () => {
  const wikiRoot = await createWikiRoot();
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      HERMES_WIKI_ROOT: wikiRoot,
      AGENT_CALENDAR_LOCAL_LLM_URL: 'http://127.0.0.1:11435',
      AGENT_CALENDAR_LOCAL_LLM_MODEL: 'qwen2.5:7b',
    },
    gatewayStore: createEmptyStore(),
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: '스트림 로컬 답변: UniPort 시스템구조는 위키 근거를 바탕으로 요약됩니다.',
          },
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
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
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(body, /스트림 로컬 답변/);
    assert.match(body, /local-llm/);
    assert.match(body, /2_wiki\/UniPort-시스템구조\.md/);
  } finally {
    await close(server);
    await rm(wikiRoot, { recursive: true, force: true });
  }
});
