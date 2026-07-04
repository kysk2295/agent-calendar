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

    if (request.method() === 'GET' && path === '/api/usage') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'usage failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [
          {
            id: 'task-noncritical-failure',
            title: '비핵심 API 실패에도 보이는 작업',
            date: '2026-07-04',
            owner: 'Me',
            status: 'Planned',
            category: '기본함',
            project: '기본함',
          },
        ],
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
  await page.waitForSelector('.task-row');

  const body = await page.locator('body').textContent();
  assert.match(body || '', /비핵심 API 실패에도 보이는 작업/);
  assert.match(await page.locator('.api-banner').textContent(), /usage/);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
