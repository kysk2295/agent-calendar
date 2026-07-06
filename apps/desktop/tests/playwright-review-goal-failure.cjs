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
        status: 500,
        json: { ok: false, error: 'review goal create failed' },
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
  await page.getByRole('button', { name: /주간 회고/ }).click();
  await page.waitForSelector('.review-add input');

  await page.locator('.review-add input').fill('실패해도 남는 회고 목표');
  await page.locator('.review-add input').press('Enter');

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.review-add input').inputValue(), '실패해도 남는 회고 목표');

  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/tasks');
  assert.equal(Boolean(createCall), true);
  assert.match(await page.locator('.api-banner').textContent(), /Agents Calendar API 500 \/api\/tasks/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createGoal: createCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
