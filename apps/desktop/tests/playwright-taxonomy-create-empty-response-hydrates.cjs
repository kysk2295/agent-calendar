const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const calls = [];
let savedTaxonomy = null;

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

    if (method === 'GET' && path === '/api/tasks') {
      const tasks = savedTaxonomy ? [savedTaxonomy] : [];
      await route.fulfill({ json: { ok: true, tasks, data: { tasks } } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      savedTaxonomy = { ...body, id: body.id || 'taxonomy-list-eventual' };
      await route.fulfill({ json: { ok: true } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: savedTaxonomy ? [savedTaxonomy] : [],
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
  await page.waitForSelector('.nav-title');
  await page.locator('.nav-title', { hasText: '리스트' }).getByRole('button', { name: '+' }).click();
  await page.waitForSelector('.taxonomy-modal');

  await page.locator('.taxonomy-field input').fill('재조회로 보이는 리스트');
  await page.locator('.taxonomy-group-input').fill('재조회 그룹');
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.nav-item')).some((item) => item.textContent?.includes('재조회로 보이는 리스트')));
  await page.waitForFunction(() => !document.querySelector('.taxonomy-modal'));

  assert.equal(await page.locator('.taxonomy-modal').count(), 0);
  assert.equal(await page.locator('.api-banner').count(), 0);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks'), true);
  assert.equal(calls.some((call) => call.method === 'GET' && call.path === '/api/tasks'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, taskCalls: calls.filter((call) => call.path === '/api/tasks').map((call) => call.method) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
