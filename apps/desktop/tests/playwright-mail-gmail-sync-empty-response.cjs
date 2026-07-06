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
      await route.fulfill({ json: { ok: true, account: { id: 'gmail-account', email: body.email } } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/sync') {
      await route.fulfill({ json: { ok: true } });
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

  await page.locator('.gmail-connect input').first().fill('empty-sync@gmail.com');
  await page.locator('.gmail-connect input').nth(1).fill('app-password');
  await page.getByRole('button', { name: '연결 · 동기화' }).click();
  await page.waitForFunction(() => document.querySelector('.gmail-connect small')?.textContent?.includes('Gmail 동기화 응답이 비어 있습니다'));

  const status = await page.locator('.gmail-connect small').textContent();
  assert.match(status || '', /Gmail 연결 실패: Gmail 동기화 응답이 비어 있습니다/);
  assert.equal(await page.locator('.gmail-connect input').nth(1).inputValue(), 'app-password');
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/accounts'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/sync'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, status, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
