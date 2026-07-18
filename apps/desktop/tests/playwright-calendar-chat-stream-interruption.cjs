const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  const calls = [];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    if (!pathName.startsWith('/api/')) {
      await route.continue();
      return;
    }

    let body = {};
    try {
      body = request.postData() ? JSON.parse(request.postData()) : {};
    } catch {
      body = {};
    }
    calls.push({ method: request.method(), path: pathName, body });

    if (request.method() === 'POST' && pathName === '/api/chat/stream') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'event: delta',
          'data: {"text":"부분 응답입니다."}',
          '',
          'event: error',
          'data: {"error":"upstream interrupted"}',
          '',
        ].join('\n'),
      });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [],
        runs: [],
        documents: [],
        notes: [],
        graph: { nodes: [], edges: [] },
        items: [],
        commands: [],
        jobs: [],
        messages: [],
        chatMessages: [],
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  const prompt = '이번 주 일정 알려줘';
  try {
    await page.goto(vite.url);
    await page.locator('.chat-fab').click();
    await page.locator('.chat').waitFor();
    await page.locator('.chat textarea').fill(prompt);
    await page.getByRole('button', { name: '전송' }).click();

    // The route is deterministic and resolves immediately, so this only gives React
    // one turn to commit the final interrupted state before inspecting the DOM.
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => ({
      input: document.querySelector('.chat textarea')?.value || '',
      messages: document.querySelector('.messages')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }));

    const streamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream');
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].body.message, prompt);
    assert.equal(streamCalls[0].body.view, 'calendar');
    assert.match(result.messages, /부분 응답입니다\./, 'partial answer must remain visible after interruption');
    assert.match(result.messages, /(중단|다시 시도|재시도)/, 'interruption must expose a retryable status');
    assert.equal(result.input, prompt, 'the empty composer must restore the failed prompt for retry');

    console.log(JSON.stringify({ ok: true, result, streamCalls: streamCalls.length }, null, 2));
  } finally {
    await browser.close();
    vite.server.httpServer?.closeAllConnections?.();
    await vite.server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
