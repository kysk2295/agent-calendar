const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const iterations = Number(process.env.HERMES_WIKI_ASK_ITERATIONS || 250);
const calls = [];

const wiki = {
  notes: [
    { id: 'wiki-a', path: '2_wiki/uniport.md', title: 'UniPort 전략', excerpt: 'UniPort는 대학생 프로젝트를 운영하는 지식입니다.', content: 'UniPort 본문입니다.' },
    { id: 'wiki-b', path: '2_wiki/trading.md', title: '트레이딩 규칙', excerpt: '리스크와 포지션 규칙.', content: '트레이딩 본문입니다.' },
  ],
  graph: {
    viewBox: '0 0 960 620',
    groups: ['2_wiki'],
    nodes: [
      { id: '2_wiki/uniport.md', path: '2_wiki/uniport.md', title: 'UniPort 전략', label: 'UniPort 전략', group: '2_wiki', x: 180, y: 180, r: 9, linkCount: 3 },
      { id: '2_wiki/trading.md', path: '2_wiki/trading.md', title: '트레이딩 규칙', label: '트레이딩 규칙', group: '2_wiki', x: 340, y: 260, r: 8, linkCount: 2 },
    ],
    edges: [{ id: 'edge-a-b', from: '2_wiki/uniport.md', to: '2_wiki/trading.md' }],
  },
};

function llmAnswer(question, marker) {
  return `좋아요. ${marker} 기준으로 연결해서 보면, UniPort 전략은 프로젝트를 어디에 집중할지 정하는 운영 지식이고 트레이딩 규칙은 리스크를 어디까지 감수할지 정하는 판단 기준에 가까워요. 그래서 ${question}에 답하자면, 두 문서를 따로 보는 것보다 “기회가 보여도 기준을 넘지 않으면 실행하지 않는다”는 하나의 원칙으로 묶는 편이 자연스럽습니다. 지금은 UniPort 전략 문서를 먼저 확인하고, 그 안의 실행 항목마다 트레이딩 규칙처럼 손실 한도와 중단 조건을 붙이면 됩니다.`;
}

function assertConversationalLlmAnswer(answer, marker) {
  assert.match(answer, new RegExp(marker));
  assert.doesNotMatch(answer, /요약:|근거:|다음 행동:/);
  assert.match(answer, /좋아요|보면|정리하면|연결해서 보면/);
  assert.match(answer, /(습니다|해요|세요|됩니다)[.!?]?/);
  assert.ok(answer.length >= 120, 'answer should be long enough to read like an LLM response');
  assert.doesNotMatch(answer, /백엔드 위키 답변 본문이 비어 있습니다/);
  assert.doesNotMatch(answer, /위키 답변 실패/);
  assert.doesNotMatch(answer, /undefined|null|\[object Object\]/i);
}

async function main() {
  assert.ok(Number.isInteger(iterations) && iterations > 0, 'HERMES_WIKI_ASK_ITERATIONS must be a positive integer');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const method = request.method();
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], chatMessages: [], wikiIndex: wiki } });
      return;
    }
    if (method === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
      return;
    }
    if (method === 'POST' && path === '/api/wiki/search') {
      const marker = String(body.question || '').match(/LLM_FORMAT_(\d+)/)?.[0] || 'LLM_FORMAT_UNKNOWN';
      await route.fulfill({
        json: {
          ok: true,
          query: body.question,
          results: [{ path: '2_wiki/uniport.md', title: 'UniPort 전략', heading: '개요', snippet: `${marker} UniPort 전략 근거입니다.` }],
        },
      });
      return;
    }
    if (method === 'POST' && path === '/api/chat/stream') {
      const marker = String(body.message || '').match(/LLM_FORMAT_(\d+)/)?.[0] || 'LLM_FORMAT_UNKNOWN';
      const answer = llmAnswer(String(body.message || ''), marker);
      await route.fulfill({
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          'event: delta',
          `data: ${JSON.stringify({ text: answer })}`,
          '',
          'event: done',
          `data: ${JSON.stringify({ text: answer, source: 'railway-relay', gatewayFallback: false, run: { model: 'wiki-curator' } })}`,
          '',
        ].join('\n'),
      });
      return;
    }

    await route.fulfill({ json: { ok: true, data: {}, items: [], commands: [], jobs: [], messages: [], channels: [], tools: [], settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } }, uiPreferences: { notify: true, agentShare: true, weekStartMon: true } } });
  });

  await page.goto(target);
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-graph-controls');

  for (let index = 0; index < iterations; index += 1) {
    const marker = `LLM_FORMAT_${String(index).padStart(3, '0')}`;
    const question = `${marker} UniPort 전략과 트레이딩 규칙을 연결해서 답해줘`;

    await page.locator('.askbar input').fill(question);
    await page.getByRole('button', { name: '질문' }).click();
    await page.waitForFunction((expected) => {
      const answer = document.querySelector('.wiki-answer')?.textContent || '';
      return answer.includes(expected);
    }, marker);

    const answer = await page.locator('.wiki-answer').textContent();
    assertConversationalLlmAnswer(answer || '', marker);
    assert.match(answer || '', /UniPort 전략/);
  }

  const searchCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/wiki/search');
  const streamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  assert.equal(searchCalls.length, iterations);
  assert.equal(streamCalls.length, iterations);
  searchCalls.forEach((call, index) => {
    assert.equal(call.body.limit, 8);
    assert.match(String(call.body.question || ''), new RegExp(`LLM_FORMAT_${String(index).padStart(3, '0')}`));
  });
  streamCalls.forEach((call) => assert.equal(call.body.agent, 'wikicurator'));

  await browser.close();
  console.log(JSON.stringify({ ok: true, iterations, wikiSearchCalls: searchCalls.length, wikiStreamCalls: streamCalls.length, answerStyle: 'conversational-gpt-like' }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
