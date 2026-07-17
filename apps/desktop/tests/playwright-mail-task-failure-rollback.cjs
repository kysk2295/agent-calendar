const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const inbox = [
  {
    id: 'mail-task-fail',
    subject: '작업 변환 실패 메일',
    title: '작업 변환 실패 메일',
    from: 'Mail QA',
    email: 'qa@example.com',
    body: '작업 추가 실패 후에도 선택과 상태가 보존되어야 합니다.',
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

    if (method === 'GET' && path === '/api/mail/messages') {
      await route.fulfill({ json: { ok: true, items: inbox, commands: inbox } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/messages/mail-task-fail/task') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'task action failed' } });
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
  await page.locator('.mail-item', { hasText: '작업 변환 실패 메일' }).click();
  await page.getByRole('button', { name: /작업으로 추가/ }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.mail-item').count(), 1);
  assert.match(await page.locator('.mail-reader').textContent(), /작업 변환 실패 메일/);
  assert.doesNotMatch(await page.locator('.mail-actions').textContent(), /기본함에 추가됨/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/messages/mail-task-fail/task'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, taskCalls: calls.filter((call) => call.path.endsWith('/task')) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
