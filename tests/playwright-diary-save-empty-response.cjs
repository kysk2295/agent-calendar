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
  await page.getByRole('button', { name: /일기/ }).click();
  await page.waitForSelector('.diary-card');
  await page.locator('.diary-moods').getByRole('button', { name: '😊' }).click();
  await page.locator('.diary-card textarea').fill('빈 저장 응답이면 지워지면 안 되는 일기');
  await page.getByRole('button', { name: '위키에 저장' }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.diary-card textarea').inputValue(), '빈 저장 응답이면 지워지면 안 되는 일기');
  assert.equal(await page.locator('.diary-moods button[data-active="true"]').textContent(), '😊');
  assert.match(await page.locator('.api-banner').textContent(), /문서 저장 응답이 비어 있습니다/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/documents'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, documentCalls: calls.filter((call) => call.method === 'POST' && call.path === '/api/documents') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
