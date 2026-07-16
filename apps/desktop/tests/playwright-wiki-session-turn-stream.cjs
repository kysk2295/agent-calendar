const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];
const wiki = {
  notes: [{ id: 'wiki-a', path: '2_wiki/근거.md', title: '정본 근거', excerpt: '근거 본문' }],
  graph: {
    nodes: [{ id: '2_wiki/근거.md', path: '2_wiki/근거.md', title: '정본 근거', group: '2_wiki' }],
    edges: [],
  },
};


async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const requestUrl = typeof input === 'string' ? input : input.url;
      const path = new URL(requestUrl, window.location.href).pathname;
      if (path !== '/api/chat/stream') return originalFetch(input, init);

      const requestBody = JSON.parse(String(init.body || '{}'));
      window.__wikiSessionTurnRequest = requestBody;
      const encoder = new TextEncoder();
      const frame = (name, data) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(frame('accepted', {
            requestId: requestBody.requestId,
            provider: 'openai-codex',
            model: 'gpt-5.5',
            responsibleAgent: 'wiki-curator',
          }));
          setTimeout(() => controller.enqueue(frame('delta', {
            text: '첫 번째 자연어 조각 ',
            sequence: 1,
            run: { model: 'gpt-5.5', agent: 'wikicurator' },
          })), 10);
          setTimeout(() => controller.enqueue(frame('delta', {
            text: '두 번째 조각',
            sequence: 2,
            run: { model: 'gpt-5.5', agent: 'wikicurator' },
          })), 400);
          setTimeout(() => controller.enqueue(frame('evidence', {
            sources: [{ id: 'canonical', path: '2_wiki/정본.md', title: '정본 근거', excerpt: '벡터 근거' }],
            retrieval: { mode: 'vector-hybrid', embeddingModel: 'bge-m3' },
            responsibleAgent: 'wiki-curator',
          })), 1200);
          setTimeout(() => {
            controller.enqueue(frame('done', {
              text: '첫 번째 자연어 조각 두 번째 조각',
              sources: [{ id: 'canonical', path: '2_wiki/정본.md', title: '정본 근거', excerpt: '벡터 근거' }],
              retrieval: { mode: 'vector-hybrid', embeddingModel: 'bge-m3' },
              llm: { provider: 'openai-codex', model: 'gpt-5.5', agent: 'wikicurator', used: true },
              answerMode: 'llm',
              responsibleAgent: 'wiki-curator',
              run: { model: 'gpt-5.5', agent: 'wikicurator' },
            }));
            controller.close();
          }, 1400);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    };
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    calls.push({ method: request.method(), path });
    if (request.method() === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], chatMessages: [], wikiIndex: wiki } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/wiki/search') {
      await route.fulfill({ json: { ok: true, sources: wiki.notes } });
      return;
    }
    await route.fulfill({ json: { ok: true, items: [], data: {} } });
  });

  await page.goto(target);
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-graph-controls');

  const question = '현재 세션으로 그대로 물어봐';
  const startedAt = Date.now();
  await page.locator('.askbar input').fill(question);
  await page.getByRole('button', { name: '질문' }).click();
  await page.waitForFunction(() => (
    document.querySelector('.wiki-answer')?.textContent || ''
  ).includes('첫 번째 자연어 조각'));
  assert.ok(Date.now() - startedAt < 1000, 'first answer delta should render before evidence');
  assert.equal(await page.getByRole('button', { name: '출처 열기: 정본 근거' }).count(), 0);

  await page.waitForFunction(() => (
    document.querySelector('.wiki-answer')?.textContent || ''
  ).includes('두 번째 조각'));
  await page.getByRole('button', { name: '출처 열기: 정본 근거' }).waitFor();

  const requestBody = await page.evaluate(() => window.__wikiSessionTurnRequest);
  const answer = await page.locator('.wiki-answer').textContent();
  assert.match(answer || '', /첫 번째 자연어 조각 두 번째 조각/);
  assert.equal(requestBody.message, question);
  assert.equal(requestBody.agent, 'wikicurator');
  assert.match(requestBody.requestId, /^[a-f0-9-]{36}$/i);
  assert.equal(requestBody.sources, undefined);
  assert.equal(requestBody.retrieval, undefined);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/wiki/search').length, 0);

  await browser.close();
  process.stdout.write(`${JSON.stringify({ ok: true, requestId: 'opaque', progressive: true })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
