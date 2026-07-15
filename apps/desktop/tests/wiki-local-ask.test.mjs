import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { askHermesWithSources, askRailwayWithSources } from '../dist-electron/hermesChat.js';
import { createApiProxyServer } from '../dist-electron/proxy.js';

test('Hermes chat client sends OpenAI-compatible chat completion request to wiki curator', async () => {
  const calls = [];
  const answer = await askHermesWithSources({
    baseUrl: 'http://127.0.0.1:8642/v1',
    apiKey: 'secret',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: '투자에서 반복하는 실수는?',
    sources: [{ id: 'a1', path: '2_wiki/Market.md', title: 'Market', heading: '리스크', headingPath: ['Market', '리스크'], text: '손절을 늦춘다.', score: 1, snippet: '손절을 늦춘다.', folder: '2_wiki' }],
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: '기록을 보면 손절을 늦추는 패턴이 반복돼요.' } }], model: 'wiki-curator' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(answer.answer, '기록을 보면 손절을 늦추는 패턴이 반복돼요.');
  assert.equal(answer.model, 'wiki-curator');
  assert.equal(answer.agent, 'wiki-curator');
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(calls[0].body.model, 'wiki-curator');
  assert.equal(calls[0].body.metadata.agent, 'wiki-curator');
  assert.equal(calls[0].body.metadata.profile, 'wiki-curator');
  assert.equal(calls[0].body.metadata.mode, 'wiki_qa');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[1].content, /SOURCES/);
  assert.match(calls[0].body.messages[1].content, /2_wiki\/Market.md/);
  assert.match(calls[0].body.messages[1].content, /3-5문장/);
  assert.match(calls[0].body.messages[1].content, /마지막 문장까지 완결/);
  assert.doesNotMatch(calls[0].body.messages[1].content, /요약\/근거\/다음 행동으로 답해/);
});

test('Railway wiki ask compacts huge source chunks before sending prompt context', async () => {
  const calls = [];
  const hugeLog = `${'OVERSIZED_LOG_LINE '.repeat(3000)}END_OF_HUGE_LOG_SHOULD_NOT_BE_SENT`;
  await askRailwayWithSources({
    baseUrl: 'https://railway.example',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: 'Hermes OS Mac mini 연결 구조를 설명해줘',
    sources: [{
      id: 'huge-log',
      path: '5_conversation/agent-runs/2026-06-28-remote-ops-안녕-live-hello-diag.md',
      title: 'Hermes OS Mac mini 연결 구조',
      heading: 'Runtime Logs',
      headingPath: ['Hermes OS Mac mini 연결 구조', 'Runtime Logs'],
      text: hugeLog,
      score: 2.5,
      snippet: 'Hermes OS는 Railway gateway와 Mac mini runtime을 relay로 연결한다.',
      folder: '5_conversation',
    }],
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response([
        'event: done',
        'data: {"text":"Hermes는 Railway gateway와 Mac mini runtime을 나눠 연결해요.","source":"railway-relay","gatewayFallback":false,"run":{"model":"wiki-curator"}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const prompt = calls[0].body.message;
  assert.ok(prompt.length < 12_000, `prompt too large: ${prompt.length}`);
  assert.equal(calls[0].body.mode, 'wiki_qa_fast');
  assert.match(prompt, /Runtime Logs/);
  assert.match(prompt, /Hermes OS는 Railway gateway와 Mac mini runtime을 relay로 연결한다/);
  assert.doesNotMatch(prompt, /5_conversation\/agent-runs/);
  assert.doesNotMatch(prompt, /END_OF_HUGE_LOG_SHOULD_NOT_BE_SENT/);
});

test('Railway wiki ask sends a compact natural command with top-two source context for faster answers', async () => {
  const calls = [];
  const sources = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index + 1}`,
    path: `2_wiki/Doc-${index + 1}.md`,
    title: `Doc ${index + 1}`,
    heading: `Heading ${index + 1}`,
    headingPath: [`Doc ${index + 1}`, `Heading ${index + 1}`],
    text: `UniPort 관련 근거 ${index + 1}. ${'답변에 필요한 짧은 근거입니다. '.repeat(18)}`,
    score: 10 - index,
    snippet: `UniPort 관련 근거 ${index + 1}.`,
    folder: '2_wiki',
  }));

  await askRailwayWithSources({
    baseUrl: 'https://railway.example',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: 'UniPort 로드맵에서 당장 실행해야 할 3가지는 뭐야?',
    sources,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response([
        'event: done',
        'data: {"text":"로드맵의 우선순위는 사용자 확보, 피드백 회수, 핵심 루프 검증이에요.","source":"railway-relay","gatewayFallback":false,"run":{"model":"wiki-curator"}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const prompt = calls[0].body.message;
  assert.ok(prompt.length < 700, `prompt too large: ${prompt.length}`);
  assert.equal(calls[0].body.mode, 'wiki_qa_fast');
  assert.match(prompt, /\[2\] Doc 2 \/ Heading 2/);
  assert.doesNotMatch(prompt, /\[3\] Doc 3 \/ Heading 3/);
  assert.match(prompt, /한 문장/);
  assert.match(prompt, /120자 이하/);
  assert.equal(calls[0].body.messages, undefined);
});

test('Railway wiki ask returns when a complete streamed answer arrives before late done event', async () => {
  const answer = await askRailwayWithSources({
    baseUrl: 'https://railway.example',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: 'UniPort에서 지금 제일 중요한 병목은?',
    sources: [{
      id: 'roadmap',
      path: '2_wiki/UniPort.md',
      title: 'UniPort',
      heading: '병목',
      headingPath: ['UniPort', '병목'],
      text: '사용자 확보와 핵심 차별 루프 검증이 병목이다.',
      score: 10,
      snippet: '사용자 확보와 핵심 차별 루프 검증이 병목이다.',
      folder: '2_wiki',
    }],
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: delta\ndata: {"text":"UniPort에서 지금 가장 중요한 병목은 사용자 확보와 핵심 차별 루프 검증입니다. [1]"}\n\n'));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  });

  assert.match(answer.answer, /사용자 확보/);
  assert.equal(answer.gatewayFallback, false);
});

test('Railway wiki ask does not treat streamed relay failure text as a valid early answer', async () => {
  await assert.rejects(() => askRailwayWithSources({
    baseUrl: 'https://railway.example',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: 'UniPort에서 지금 제일 중요한 병목은?',
    sources: [],
    fetchImpl: async () => new Response([
      'event: delta',
      'data: {"text":"Railway relay failed: terminated"}',
      '',
      'event: done',
      'data: {"text":"Railway relay failed: terminated","error":"terminated"}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  }), /terminated/);
});

test('Railway wiki ask retries once when relay bridge times out', async () => {
  const calls = [];
  const answer = await askRailwayWithSources({
    baseUrl: 'https://railway.example',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: 'UniPort 로드맵에서 당장 실행해야 할 3가지는 뭐야?',
    sources: [{
      id: 'roadmap',
      path: '2_wiki/UniPort-로드맵.md',
      title: 'UniPort 로드맵',
      heading: '우선순위',
      headingPath: ['UniPort 로드맵', '우선순위'],
      text: 'Play Store 승인 즉시 마케팅 실행, UX 피드백 반영, 커리큘럼 준비.',
      score: 10,
      snippet: 'Play Store 승인 즉시 마케팅 실행.',
      folder: '2_wiki',
    }],
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return new Response([
          'event: done',
          'data: {"text":"Railway relay failed: railway relay bridge timed out","source":"railway-relay","gatewayFallback":false,"error":"railway relay bridge timed out","run":{"model":"wiki-curator"}}',
          '',
        ].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response([
        'event: done',
        'data: {"text":"당장 할 일은 마케팅 실행, UX 피드백 반영, 커리큘럼 준비예요.","source":"railway-relay","gatewayFallback":false,"run":{"model":"wiki-curator"}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(answer.gatewayFallback, false);
  assert.match(answer.answer, /마케팅 실행/);
});

test('Railway wiki ask retries once when relay generation is terminated', async () => {
  const calls = [];
  const answer = await askRailwayWithSources({
    baseUrl: 'https://railway.example',
    agent: 'wiki-curator',
    model: 'wiki-curator',
    question: '시장 데이터 수집 실패 시 어떤 정책을 따라야 해?',
    sources: [{
      id: 'automation',
      path: '7_automation/automation-registry.md',
      title: 'Automation Registry',
      heading: 'Automation Registry',
      headingPath: ['Automation Registry'],
      text: '자동화는 실패 정책과 실행 로그를 남긴다.',
      score: 8,
      snippet: '자동화는 실패 정책과 실행 로그를 남긴다.',
      folder: '7_automation',
    }],
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return new Response([
          'event: done',
          'data: {"text":"Railway relay failed: terminated","source":"railway-relay","gatewayFallback":false,"error":"terminated","run":{"model":"wiki-curator"}}',
          '',
        ].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response([
        'event: done',
        'data: {"text":"실패 시에는 로그를 남기고 원인을 분리해 재시도 여부를 판단해야 해요.","source":"railway-relay","gatewayFallback":false,"run":{"model":"wiki-curator"}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(answer.gatewayFallback, false);
  assert.match(answer.answer, /로그/);
});

const PROXY_CREDENTIAL = 'wiki-local-test-credential';
const PROXY_HEADERS = { 'x-agent-calendar-proxy-credential': PROXY_CREDENTIAL };

async function withProxy(fetchImpl, env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const server = createApiProxyServer({
    credential: PROXY_CREDENTIAL,
    fetchImpl,
    getSettings: () => ({ apiBaseUrl: 'https://railway.example', apiToken: '' }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('proxy handles /api/wiki/ask locally with vault search and Hermes wiki curator answer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await writeFile(path.join(root, '2_wiki', 'Market.md'), '# Market\n\n## 리스크\n투자에서 반복하는 실수는 손절을 늦추는 것이다.');
    const railwayCalls = [];
    await withProxy(async (url, init) => {
      railwayCalls.push({ url, body: JSON.parse(init.body) });
      return new Response([
        'event: delta',
        'data: {"text":"기록을 보면 손절을 늦추는 패턴이 반복돼요."}',
        '',
        'event: done',
        'data: {"text":"기록을 보면 손절을 늦추는 패턴이 반복돼요.","source":"mac-mini-hermes-api","gatewayFallback":false,"run":{"model":"wiki-curator"}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }, {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: root,
      HERMES_WIKI_AGENT: 'wiki-curator',
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki/ask`, {
        method: 'POST',
        headers: { ...PROXY_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ question: '투자에서 반복하는 실수는?', limit: 8 }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.gatewayFallback, false);
      assert.equal(payload.engine.provider, 'railway-hermes');
      assert.equal(payload.engine.agent, 'wiki-curator');
      assert.equal(payload.engine.baseUrl, 'https://railway.example');
      assert.equal(payload.engine.source, 'mac-mini-hermes-api');
      assert.match(payload.answer, /손절/);
      assert.equal(payload.sources[0].path, '2_wiki/Market.md');
    });
    assert.equal(railwayCalls.length, 1);
    assert.equal(railwayCalls[0].url, 'https://railway.example/api/chat/stream');
    assert.equal(railwayCalls[0].body.agent, 'wiki-curator');
    assert.equal(railwayCalls[0].body.view, 'wiki');
    assert.match(railwayCalls[0].body.message, /투자에서 반복하는 실수/);
    assert.match(railwayCalls[0].body.message, /SOURCES/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy marks Railway relay timeout as fallback instead of successful answer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await writeFile(path.join(root, '2_wiki', 'Market.md'), '# Market\n\n## 리스크\n투자에서 반복하는 실수는 손절을 늦추는 것이다.');
    await withProxy(async () => new Response([
      'event: done',
      'data: {"text":"Railway relay failed: railway relay bridge timed out","source":"railway-relay","gatewayFallback":false,"error":"railway relay bridge timed out","run":{"model":"wiki-curator"}}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }), {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: root,
      HERMES_WIKI_AGENT: 'wiki-curator',
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki/ask`, {
        method: 'POST',
        headers: { ...PROXY_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ question: '투자에서 반복하는 실수는?', limit: 8 }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.gatewayFallback, true);
      assert.match(payload.answer, /Hermes가 시간 내 자연어 답변을 생성하지 못했어요/);
      assert.match(payload.answer, /railway relay bridge timed out/);
      assert.doesNotMatch(payload.answer, /임시 답변/);
      assert.equal(payload.engine.provider, 'railway-hermes');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/wiki inventories every Markdown note and preserves heading text', async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await writeFile(path.join(root, '2_wiki', 'Empty.md'), '');
    await writeFile(path.join(root, '2_wiki', 'Frontmatter.md'), '---\ntitle: Metadata only\ntags: [meta]\n---\n');
    await writeFile(path.join(root, '2_wiki', 'Heading only.md'), '# Heading only\n## [[Target]]');
    await writeFile(path.join(root, '2_wiki', 'Target.md'), '');

    // When
    await withProxy(undefined, {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: root,
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki`, { headers: PROXY_HEADERS });
      const payload = await response.json();

      // Then
      assert.equal(response.status, 200);
      assert.deepEqual(payload.notes.map((note) => note.path).sort(), [
        '2_wiki/Empty.md',
        '2_wiki/Frontmatter.md',
        '2_wiki/Heading only.md',
        '2_wiki/Target.md',
      ]);
      const headingOnly = payload.notes.find((note) => note.path === '2_wiki/Heading only.md');
      assert.equal(headingOnly.body, '# Heading only\n## [[Target]]');
      assert.equal(payload.graph.nodes.length, 4);
      assert.deepEqual(payload.graph.edges.map((edge) => `${edge.from}->${edge.to}`), [
        '2_wiki/Heading only.md->2_wiki/Target.md',
      ]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/wiki returns terminating JSON when the local vault cannot be scanned', async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), 'missing-wiki-vault-'));
  const missingVault = path.join(root, 'does-not-exist');
  try {
    // When
    await withProxy(undefined, {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: missingVault,
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki`, { headers: PROXY_HEADERS, signal: AbortSignal.timeout(1_000) });
      const payload = await response.json();

      // Then
      assert.equal(response.status, 500);
      assert.match(response.headers.get('content-type') || '', /application\/json/);
      assert.equal(payload.ok, false);
      assert.match(payload.error, /ENOENT|does-not-exist/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/wiki rejects an in-vault note symlink that resolves outside the vault', async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-wiki-vault-'));
  const sentinel = 'OUTSIDE_VAULT_SECRET';
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    const secretPath = path.join(outside, 'Secret.md');
    await writeFile(secretPath, sentinel);
    await symlink(secretPath, path.join(root, '2_wiki', 'Leak.md'));

    // When
    await withProxy(undefined, {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: root,
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki?path=${encodeURIComponent('2_wiki/Leak.md')}`, { headers: PROXY_HEADERS });
      const responseText = await response.text();

      // Then
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type') || '', /application\/json/);
      assert.equal(JSON.parse(responseText).ok, false);
      assert.doesNotMatch(responseText, new RegExp(sentinel));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('GET /api/wiki serializes one note collection and one copy of each full body', async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  const sentinel = 'UNIQUE_FULL_BODY_SENTINEL';
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await writeFile(path.join(root, '2_wiki', 'Payload.md'), `# Payload\n\n${'preview '.repeat(40)}${sentinel}`);

    // When
    await withProxy(undefined, {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: root,
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki`, { headers: PROXY_HEADERS });
      const responseText = await response.text();
      const payload = JSON.parse(responseText);

      // Then
      assert.equal(response.status, 200);
      assert.equal(payload.notes.length, 1);
      assert.equal(payload.graph.nodes.length, 1);
      assert.equal(Object.hasOwn(payload, 'documents'), false);
      assert.equal(Object.hasOwn(payload, 'wikiIndex'), false);
      assert.equal(payload.selectedNote, null);
      assert.equal(responseText.split(sentinel).length - 1, 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
