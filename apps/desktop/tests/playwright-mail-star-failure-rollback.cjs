const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const inbox = [
  {
    id: 'mail-star-fail',
    subject: '별표 실패 메일',
    title: '별표 실패 메일',
    from: 'Mail QA',
    email: 'qa@example.com',
    body: '별표 변경 실패 후에는 원래 별표 상태로 돌아와야 합니다.',
    unread: true,
    star: false,
  },
];

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
      await route.fulfill({ json: { ok: true, items: inbox, commands: inbox } });
      return;
    }
    if (method === 'POST' && path === '/api/inbox/commands/mail-star-fail/star') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'star failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [{ id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' }],
        runs: [],
        documents: [],
        notes: [],
        graph: { nodes: [], edges: [] },
        items: inbox,
        commands: inbox,
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
  await page.getByRole('button', { name: /메일함/ }).click();
  await page.waitForSelector('.mail-item');
  await page.locator('.mail-item', { hasText: '별표 실패 메일' }).click();
  await page.getByRole('button', { name: '별표', exact: true }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.getByRole('button', { name: '별표', exact: true }).textContent(), '☆');
  assert.doesNotMatch(await page.locator('.mail-item', { hasText: '별표 실패 메일' }).textContent(), /★/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/inbox/commands/mail-star-fail/star'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, starCalls: calls.filter((call) => call.path.endsWith('/star')) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
