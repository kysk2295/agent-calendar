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
      await route.fulfill({ status: 500, json: { ok: false, error: 'stream failed' } });
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

  await page.goto(target);
  await page.waitForSelector('.chat-fab');
  await page.locator('.chat-fab').click();
  await page.waitForSelector('.chat');
  await page.locator('.chat textarea').fill('실패해도 남는 채팅 요청');
  await page.getByRole('button', { name: '전송' }).click();
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('Railway 연결 실패'));

  const result = await page.evaluate(() => ({
    input: document.querySelector('.chat textarea')?.value || '',
    messages: document.querySelector('.messages')?.textContent?.replace(/\s+/g, ' ').trim() || '',
  }));
  const streamCall = calls.find((call) => call.method === 'POST' && call.path === '/api/chat/stream');

  assert.equal(Boolean(streamCall), true);
  assert.equal(streamCall.body.message, '실패해도 남는 채팅 요청');
  assert.match(result.messages, /Railway 연결 실패/);
  assert.equal(result.input, '실패해도 남는 채팅 요청');

  await browser.close();
  console.log(JSON.stringify({ ok: true, result, streamCall }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
