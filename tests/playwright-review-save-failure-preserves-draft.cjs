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

    if (method === 'POST' && path === '/api/wiki/ask') {
      await route.fulfill({ json: { ok: true, answer: '실패해도 남는 회고 초안' } });
      return;
    }
    if (method === 'POST' && path === '/api/documents') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'review save failed' } });
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
  await page.waitForSelector('.review-retro');
  await page.getByRole('button', { name: '자동 생성' }).click();
  await page.waitForFunction(() => document.querySelector('.review-retro')?.textContent?.includes('실패해도 남는 회고 초안'));
  await page.getByRole('button', { name: '위키에 저장' }).click();

  await page.waitForSelector('.api-banner');
  assert.match(await page.locator('.review-retro').textContent(), /실패해도 남는 회고 초안/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/wiki/ask'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/documents'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
