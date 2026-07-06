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

    if (method === 'GET' && path === '/api/inbox/commands') {
      await route.fulfill({ json: { ok: true, items: [], commands: [] } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/accounts') {
      await route.fulfill({ status: 401, json: { ok: false, error: 'invalid app password' } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/sync') {
      await route.fulfill({ json: { ok: true, items: [] } });
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
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.locator('.nav-item').filter({ hasText: '메일함' }).click();
  await page.waitForSelector('.gmail-connect');

  await page.getByRole('button', { name: '연결 · 동기화' }).click();
  await page.waitForFunction(() => document.querySelector('.gmail-connect small')?.textContent?.includes('Gmail 주소와 앱 비밀번호'));
  const callsAfterEmpty = calls.filter((call) => call.method === 'POST').length;

  await page.locator('.gmail-connect input').first().fill('bad@gmail.com');
  await page.locator('.gmail-connect input').nth(1).fill('bad-password');
  await page.getByRole('button', { name: '연결 · 동기화' }).click();
  await page.waitForFunction(() => document.querySelector('.gmail-connect small')?.textContent?.includes('Gmail 연결 실패'));
  const status = await page.locator('.gmail-connect small').textContent();

  assert.equal(callsAfterEmpty, 0);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/accounts' && call.body.email === 'bad@gmail.com'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/sync'), false);
  assert.match(status || '', /Agents Calendar API 401/);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, status, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
