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

    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({
        json: { ok: true, task: { id: 'task-stale-quick-add', title: body.title, status: body.status } },
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
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.getByRole('button', { name: '📥 기본함' }).click();
  await page.waitForSelector('.list-quick input');

  await page.locator('.list-quick input').fill('재조회 전에는 지우면 안 되는 빠른 추가');
  await page.locator('.list-quick button').click();

  await page.waitForSelector('.api-banner', { timeout: 15000 });
  assert.equal(await page.locator('.list-quick input').inputValue(), '재조회 전에는 지우면 안 되는 빠른 추가');
  assert.equal(await page.locator('.row', { hasText: '재조회 전에는 지우면 안 되는 빠른 추가' }).count(), 0);
  assert.match(await page.locator('.api-banner').textContent(), /생성한 작업을 목록에서 아직 확인하지 못했습니다/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks'), true);
  assert.equal(calls.filter((call) => call.method === 'GET' && call.path === '/api/tasks').length >= 2, true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, taskCalls: calls.filter((call) => call.path === '/api/tasks').map((call) => call.method) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
