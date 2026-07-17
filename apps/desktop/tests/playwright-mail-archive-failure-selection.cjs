const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const inbox = [
  {
    id: 'mail-archive-first',
    subject: '첫 번째 메일',
    title: '첫 번째 메일',
    from: 'First',
    body: '첫 번째 본문',
    unread: true,
  },
  {
    id: 'mail-archive-second',
    subject: '선택 보존 메일',
    title: '선택 보존 메일',
    from: 'Second',
    body: '보관 실패 후에도 이 메일을 보고 있어야 합니다.',
    unread: true,
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

    if (method === 'GET' && path === '/api/mail/messages') {
      await route.fulfill({ json: { ok: true, items: inbox, commands: inbox } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/messages/mail-archive-second/archive') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'archive failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }],
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
  await page.locator('.mail-item', { hasText: '선택 보존 메일' }).click();
  await page.getByRole('button', { name: '보관', exact: true }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.mail-item').count(), 2);
  assert.match(await page.locator('.mail-reader').textContent(), /선택 보존 메일/);
  assert.equal(await page.locator('.mail-item[data-active="true"]').textContent(), await page.locator('.mail-item', { hasText: '선택 보존 메일' }).textContent());
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/archive')), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, archiveCalls: calls.filter((call) => call.path.endsWith('/archive')) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
