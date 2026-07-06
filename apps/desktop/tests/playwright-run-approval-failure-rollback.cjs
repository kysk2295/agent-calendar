const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const runs = [
  { id: 'run-approval-fail', title: '승인 실패 보존 런', agent: 'default', status: 'done' },
];
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
    calls.push({ method: request.method(), path });

    if (request.method() === 'POST' && path === '/api/runs/run-approval-fail/approve') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'approval failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [{ id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' }],
        runs,
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
  await page.waitForSelector('.run-row');

  await page.locator('.run-row', { hasText: '승인 실패 보존 런' }).click();
  await page.locator('.run-approve').click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.run-row').count(), 1);
  assert.match(await page.locator('.run-row').textContent(), /승인 실패 보존 런/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/runs/run-approval-fail/approve'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, approvals: calls.filter((call) => call.path.includes('/approve')).map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
