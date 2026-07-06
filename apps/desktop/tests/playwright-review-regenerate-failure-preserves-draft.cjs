const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

let askCount = 0;
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
      askCount += 1;
      if (askCount === 1) {
        await route.fulfill({ json: { ok: true, answer: '첫 번째 회고 초안은 보존되어야 함' } });
        return;
      }
      await route.fulfill({ status: 500, json: { ok: false, error: 'regenerate failed' } });
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
  await page.waitForFunction(() => document.querySelector('.review-retro')?.textContent?.includes('첫 번째 회고 초안은 보존되어야 함'));

  await page.getByRole('button', { name: '자동 생성' }).click();
  await page.waitForFunction(() => !document.querySelector('.review-retro button.primary')?.textContent?.includes('생성 중'));

  const retroText = await page.locator('.review-retro').textContent();
  assert.match(retroText || '', /첫 번째 회고 초안은 보존되어야 함/);
  assert.doesNotMatch(retroText || '', /회고 생성 실패/);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/wiki/ask').length, 2);

  await browser.close();
  console.log(JSON.stringify({ ok: true, askCount }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
