const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const agents = [{ id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' }];
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

    if (method === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-before-empty-run', title: body.title, status: body.status } } });
      return;
    }
    if (method === 'POST' && path === '/api/missions/launch') {
      await route.fulfill({ json: { ok: true } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents,
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
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.waitForSelector('.mission');
  await page.locator('.mission textarea').fill('빈 런 응답이어도 남아야 하는 미션');
  await page.getByRole('button', { name: /계획 세우기/ }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.run-modal').count(), 0);
  assert.equal(await page.locator('.mission textarea').inputValue(), '빈 런 응답이어도 남아야 하는 미션');
  assert.match(await page.locator('.api-banner').textContent(), /미션 실행 응답이 비어 있습니다/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/missions/launch'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
