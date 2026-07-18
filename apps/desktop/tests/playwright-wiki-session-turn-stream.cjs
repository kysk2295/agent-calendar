const assert = require('node:assert/strict');
const path = require('node:path');
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

async function startVite() {
  if (process.env.HERMES_UI_URL) return { server: null, url: target };
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve(__dirname, '..'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}


async function main() {
  const { server, url } = await startVite();
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
      window.__wikiSessionTurnRequestComplete = false;
      const encoder = new TextEncoder();
      const frameText = (name, data, { trailingDelimiter = true, lineEnding = '\n' } = {}) => (
        `event: ${name}${lineEnding}data: ${JSON.stringify(data)}${trailingDelimiter ? `${lineEnding}${lineEnding}` : ''}`
      );
      const frame = (name, data, options) => encoder.encode(frameText(name, data, options));
      const stream = new ReadableStream({
        start(controller) {
          const isSecondQuestion = requestBody.message === '두 번째 질문';
          const complete = () => {
            window.__wikiSessionTurnRequestComplete = true;
            controller.close();
          };
          controller.enqueue(frame('accepted', {
            requestId: requestBody.requestId,
            provider: 'openai-codex',
            model: 'gpt-5.5',
            responsibleAgent: 'wiki-curator',
          }));
          if (isSecondQuestion) {
            setTimeout(() => {
              const delta = frameText('delta', {
                text: '두 번째 질문을 받는 중입니다. ',
                sequence: 1,
                run: { model: 'gpt-5.5', agent: 'wikicurator' },
              }, { lineEnding: '\r\n' });
              // Deliberately split the CRLF blank-line delimiter between its final
              // carriage return and line feed to exercise chunk-boundary parsing.
              const splitAt = delta.length - 1;
              controller.enqueue(encoder.encode(delta.slice(0, splitAt)));
              setTimeout(() => controller.enqueue(encoder.encode(delta.slice(splitAt))), 20);
            }, 700);
            setTimeout(() => controller.enqueue(frame('evidence', {
              sources: [{ id: 'canonical-b', path: '2_wiki/두번째.md', title: '두 번째 근거', excerpt: '두 번째 벡터 근거' }],
              retrieval: { mode: 'vector-hybrid', embeddingModel: 'bge-m3' },
              responsibleAgent: 'wiki-curator',
            })), 900);
            setTimeout(() => {
              controller.enqueue(frame('done', {
                text: '두 번째 질문에 대한 최종 답변',
                sources: [{ id: 'canonical-b', path: '2_wiki/두번째.md', title: '두 번째 근거', excerpt: '두 번째 벡터 근거' }],
                retrieval: { mode: 'vector-hybrid', embeddingModel: 'bge-m3' },
                llm: { provider: 'openai-codex', model: 'gpt-5.5', agent: 'wikicurator', used: true },
                answerMode: 'llm',
                responsibleAgent: 'wiki-curator',
                run: { model: 'gpt-5.5', agent: 'wikicurator' },
              }, false));
              complete();
            }, 1100);
            return;
          }
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
            complete();
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

  try {
    await page.goto(url);
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

    await page.getByRole('button', { name: '출처 열기: 정본 근거' }).click();
    await page.locator('.wiki-reader').waitFor();
    assert.equal(await page.locator('.wiki-reader strong').textContent(), '정본 근거');
    assert.match(await page.locator('.wiki-reader article').textContent() || '', /벡터 근거/);

    const secondQuestion = '두 번째 질문';
    await page.locator('.askbar input').fill(secondQuestion);
    await page.getByRole('button', { name: '질문' }).click();
    await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="출처 열기:"]').length === 0);
    assert.equal(await page.locator('.wiki-answer').count(), 0);
    await page.getByRole('button', { name: '출처 열기: 두 번째 근거' }).waitFor();
    await page.waitForFunction(() => window.__wikiSessionTurnRequestComplete === true);
    await page.getByRole('button', { name: '질문', exact: true }).waitFor();
    const secondAnswer = await page.locator('.wiki-answer').textContent();
    assert.match(secondAnswer || '', /두 번째 질문에 대한 최종 답변/);
    await page.getByRole('button', { name: '출처 열기: 두 번째 근거' }).click();
    await page.locator('.wiki-reader').waitFor();
    assert.equal(await page.locator('.wiki-reader strong').textContent(), '두 번째 근거');
    assert.match(await page.locator('.wiki-reader article').textContent() || '', /두 번째 벡터 근거/);

    process.stdout.write(`${JSON.stringify({ ok: true, requestId: 'opaque', progressive: true, finalUndelimitedDone: true, evidenceReader: true, staleEvidenceCleared: true })}\n`);
  } finally {
    await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
