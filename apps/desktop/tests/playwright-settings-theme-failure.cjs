const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

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

    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    if (request.method() === 'POST' && path === '/api/settings' && body.theme === 'sage') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'theme write failed' } });
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
        settings: {
          theme: 'default',
          uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
        },
        theme: 'default',
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.waitForSelector('.profile');
  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');

  await page.getByTestId('settings-nav-theme').click();
  await page.locator('.settings-overlay .settings-theme-list button', { hasText: 'Sage' }).click();
  await page.waitForSelector('.api-banner');

  assert.equal(await page.locator('.app-root').getAttribute('data-theme'), 'default');
  assert.equal(await page.locator('.settings-overlay .settings-theme-list button[data-active="true"]', { hasText: 'Terracotta' }).count(), 1);
  assert.match(await page.locator('.api-banner').innerText(), /Agents Calendar API 500 \/api\/settings|테마 저장 실패/);
  assert.equal(await page.locator('.settings-overlay').count(), 1);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
