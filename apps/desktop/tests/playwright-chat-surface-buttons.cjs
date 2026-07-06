const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

const runs = [
  { id: 'run-chat-surface', title: 'Chat surface run', goal: 'Chat surface run goal', agent: 'default', status: 'running', progress: 35 },
];

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
        body: ['data: {"text":"Enter 전송 응답"}', ''].join('\n'),
      });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [],
        runs,
        documents: [],
        chatMessages: [],
        notes: [],
        graph: { nodes: [], edges: [] },
        items: [],
        commands: [],
        jobs: [],
        messages: [],
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

  await page.locator('.chat-chips button', { hasText: 'UniPort 백로그 분배' }).click();
  assert.equal(await page.locator('.chat textarea').inputValue(), 'UniPort 백로그 분배');

  await page.locator('.chat-run-card', { hasText: 'Chat surface run goal' }).click();
  await page.waitForSelector('.run-modal');
  assert.match(await page.locator('.run-modal').textContent() || '', /Chat surface run/);
  await page.locator('.run-head button').click();
  await page.waitForFunction(() => !document.querySelector('.run-modal'));

  await page.locator('.chat textarea').fill('Enter로 전송');
  await page.locator('.chat textarea').press('Enter');
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent?.includes('Enter 전송 응답'));

  const streamCall = calls.find((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  assert.equal(Boolean(streamCall), true);
  assert.equal(streamCall.body.message, 'Enter로 전송');
  assert.equal(await page.locator('.chat textarea').inputValue(), '');

  await page.locator('.chat header button[aria-label="Agent Calendar 콘솔 닫기"]').click();
  await page.waitForFunction(() => !document.querySelector('.chat'));

  await browser.close();
  console.log(JSON.stringify({ ok: true, streamCall }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
