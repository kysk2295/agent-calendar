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

const history = Array.from({ length: 40 }, (_, index) => ({
  id: `calendar-history-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  target: 'calendar',
  text: `이전 캘린더 대화 ${index + 1}: 이번 주 일정과 할 일을 확인하고 빈 시간대를 정리한 기록입니다. `
    + '오래된 대화가 다시 표시되어도 현재 일정 문맥을 유지해야 합니다. '.repeat(3),
}));

async function main() {
  const vite = await startVite();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  const calls = [];

  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let streamIndex = 0;
    window.__chatAutoScrollRequests = [];
    window.__chatAutoScrollStreams = [];
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (new URL(rawUrl, window.location.href).pathname !== '/api/chat/stream') return nativeFetch(input, init);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      window.__chatAutoScrollRequests.push(body);
      streamIndex += 1;
      const currentStream = streamIndex;
      const encoder = new TextEncoder();
      const fullText = `응답 ${currentStream} 첫 조각입니다. 응답 ${currentStream} 두 번째 조각입니다. 응답 ${currentStream} 마지막 응답 조각입니다.`;
      const events = [
        `event: delta\ndata: ${JSON.stringify({ text: `응답 ${currentStream} 첫 조각입니다. ` })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ text: `응답 ${currentStream} 두 번째 조각입니다. ` })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ text: `응답 ${currentStream} 마지막 응답 조각입니다.` })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ text: fullText })}\n\n`,
      ];
      return new Response(new ReadableStream({
        start(controller) {
          let nextEvent = 0;
          window.__chatAutoScrollStreams.push({
            emitNext() {
              controller.enqueue(encoder.encode(events[nextEvent]));
              nextEvent += 1;
              if (nextEvent === events.length) controller.close();
            },
          });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    };
  });

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

    if (request.method() === 'GET' && pathName === '/api/chat/messages') {
      await route.fulfill({ json: { messages: history } });
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

  try {
    await page.goto(vite.url);
    await page.locator('.chat-fab').click();
    await page.locator('.chat').waitFor();
    await page.waitForFunction(() => {
      const container = document.querySelector('.messages');
      return container && Math.abs(container.scrollHeight - (container.scrollTop + container.clientHeight)) <= 2;
    });

    await page.locator('.chat textarea').fill('내일 일정과 빈 시간을 알려줘');
    await page.getByRole('button', { name: '전송' }).click();
    const emitNext = (stream) => page.evaluate((index) => window.__chatAutoScrollStreams[index].emitNext(), stream);
    await page.waitForFunction(() => window.__chatAutoScrollStreams.length === 1);
    await emitNext(0);
    await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent?.includes('응답 1 첫 조각입니다.'));
    await page.waitForFunction(() => {
      const container = document.querySelector('.messages');
      return container && Math.abs(container.scrollHeight - (container.scrollTop + container.clientHeight)) <= 2;
    });
    await emitNext(0);
    await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent?.includes('응답 1 두 번째 조각입니다.'));
    await emitNext(0);
    await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent?.includes('응답 1 마지막 응답 조각입니다.'));
    await emitNext(0);
    await page.waitForFunction(() => {
      const container = document.querySelector('.messages');
      return container && Math.abs(container.scrollHeight - (container.scrollTop + container.clientHeight)) <= 2;
    });

    const readScrollState = () => page.locator('.messages').evaluate((container) => {
      const last = container.querySelector('.message:last-child');
      const containerRect = container.getBoundingClientRect();
      const lastRect = last?.getBoundingClientRect();
      const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
      const lastBubbleVisible = Boolean(lastRect)
        && lastRect.top >= containerRect.top - 2
        && lastRect.bottom <= containerRect.bottom + 2;
      return {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        distanceFromBottom,
        lastBubbleVisible,
        lastText: last?.textContent || '',
      };
    });
    const scrollState = await readScrollState();

    assert.ok(Math.abs(scrollState.distanceFromBottom) <= 2, `chat scroll must be at bottom within 2px: ${JSON.stringify(scrollState)}`);
    assert.equal(scrollState.lastBubbleVisible, true, `final assistant bubble must be visible: ${JSON.stringify(scrollState)}`);

    await page.locator('.messages').evaluate((container) => {
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll'));
    });
    await page.locator('.chat textarea').fill('이번 주 남은 일정도 알려줘');
    await page.getByRole('button', { name: '전송' }).click();
    await page.waitForFunction(() => {
      const container = document.querySelector('.messages');
      return container && Math.abs(container.scrollHeight - (container.scrollTop + container.clientHeight)) <= 2;
    });
    const resumedScrollState = await readScrollState();
    assert.equal(resumedScrollState.lastBubbleVisible, true, `a new user message must resume latest-message following: ${JSON.stringify(resumedScrollState)}`);
    await page.waitForFunction(() => window.__chatAutoScrollStreams.length === 2);
    await emitNext(1);
    await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent?.includes('응답 2 첫 조각입니다.'));
    await page.locator('.messages').evaluate((container) => {
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll'));
    });
    await emitNext(1);
    await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent?.includes('응답 2 두 번째 조각입니다.'));
    await emitNext(1);
    await page.waitForFunction(() => document.querySelector('.message:last-child')?.textContent?.includes('응답 2 마지막 응답 조각입니다.'));
    await emitNext(1);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const userScrollState = await readScrollState();
    assert.ok(userScrollState.scrollTop <= 2, `manual history scroll must be preserved during later stream chunks: ${JSON.stringify(userScrollState)}`);
    assert.equal(userScrollState.lastBubbleVisible, false, `latest bubble should not yank a reader away from history: ${JSON.stringify(userScrollState)}`);

    const streamCalls = await page.evaluate(() => window.__chatAutoScrollRequests);
    assert.equal(streamCalls.length, 2);
    for (const streamCall of streamCalls) {
      assert.equal(streamCall.view, 'calendar');
      assert.equal(streamCall.agent, 'default');
      assert.equal(streamCall.agentId, 'default');
    }

    console.log(JSON.stringify({ ok: true, scrollState, resumedScrollState, userScrollState, streamCalls }, null, 2));
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
