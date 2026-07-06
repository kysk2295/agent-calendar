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
  await page.waitForSelector('.nav-title');
  await page.locator('.nav-title', { hasText: '리스트' }).getByRole('button', { name: '+' }).click();
  await page.waitForSelector('.taxonomy-modal');

  await page.locator('.taxonomy-field input').fill('빈 응답에도 남는 리스트');
  await page.locator('.taxonomy-group-input').fill('검증 그룹');
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForFunction(() => document.querySelector('.api-banner')?.textContent?.includes('리스트/태그 저장 응답이 비어 있습니다'));

  assert.equal(await page.locator('.taxonomy-modal').count(), 1);
  assert.equal(await page.locator('.taxonomy-field input').inputValue(), '빈 응답에도 남는 리스트');
  assert.equal(await page.locator('.taxonomy-group-input').inputValue(), '검증 그룹');
  assert.match(await page.locator('.api-banner').innerText(), /리스트\/태그 저장 응답이 비어 있습니다/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
