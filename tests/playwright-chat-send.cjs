const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const calls = [];

async function main() {
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

    if (method === 'POST' && path === '/api/chat/stream') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'data: {"text":"채팅 응답"}',
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
        runs: [{ id: 'run-chat', title: '채팅 테스트 런', goal: '채팅 테스트 런', agent: 'default', status: 'running' }],
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

  await page.goto(target);
  await page.waitForSelector('.chat-fab');
  await page.locator('.chat-fab').click();
  await page.waitForSelector('.chat');
  await page.locator('.chat textarea').fill('채팅 버튼 검증');
  await page.getByRole('button', { name: '전송' }).click();
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('채팅 응답'));

  const result = await page.evaluate(() => ({
    input: document.querySelector('.chat textarea')?.value || '',
    messages: document.querySelector('.messages')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    apiBanner: document.querySelector('.api-banner')?.textContent?.trim() || '',
  }));

  const streamCall = calls.find((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  assert.equal(Boolean(streamCall), true);
  assert.equal(streamCall.body.message, '채팅 버튼 검증');
  assert.equal(streamCall.body.agent, 'default');
  assert.match(result.messages, /채팅 버튼 검증/);
  assert.match(result.messages, /채팅 응답/);
  assert.equal(result.input, '');
  assert.equal(result.apiBanner, '');

  await browser.close();
  console.log(JSON.stringify({ ok: true, result, streamCall }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
