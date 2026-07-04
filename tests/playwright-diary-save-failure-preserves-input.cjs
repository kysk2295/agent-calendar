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

    if (method === 'POST' && path === '/api/documents') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'diary save failed' } });
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
  await page.getByRole('button', { name: /일기/ }).click();
  await page.waitForSelector('.diary-card');
  await page.locator('.diary-moods').getByRole('button', { name: '😊' }).click();
  await page.locator('.diary-card textarea').fill('실패해도 남는 일기 본문');
  await page.getByRole('button', { name: '위키에 저장' }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.diary-card textarea').inputValue(), '실패해도 남는 일기 본문');
  assert.equal(await page.locator('.diary-moods button[data-active="true"]').textContent(), '😊');
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/documents'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, documentCalls: calls.filter((call) => call.method === 'POST' && call.path === '/api/documents') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
