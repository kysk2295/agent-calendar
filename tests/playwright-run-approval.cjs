const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const runs = [
  { id: 'run-stale', title: 'Stale review run', agent: 'default', status: 'done' },
  { id: 'run-ok', title: 'Approving review run', agent: 'default', status: 'done' },
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

    if (request.method() === 'POST' && path === '/api/runs/run-stale/approve') {
      await route.fulfill({ status: 404, json: { ok: false, error: 'missing run' } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/runs/run-ok/approve') {
      runs[1] = { ...runs[1], status: 'approved', approved: true };
      await route.fulfill({ json: { ok: true, run: runs[1] } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }],
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
  assert.equal(await page.locator('.run-row').count(), 2);

  await page.locator('.run-row', { hasText: 'Stale review run' }).click();
  await page.locator('.run-approve').click();
  await page.waitForFunction(() => document.querySelectorAll('.run-row').length === 1);
  assert.equal(await page.locator('.api-banner').count(), 0);
  await page.locator('.run-close').click();

  await page.locator('.run-row', { hasText: 'Approving review run' }).click();
  await page.locator('.run-approve').click();
  await page.waitForFunction(() => !document.querySelector('.run-row'));

  assert.equal(calls.some((call) => call.path === '/api/runs/run-stale/approve'), true);
  assert.equal(calls.some((call) => call.path === '/api/runs/run-ok/approve'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, approvals: calls.filter((call) => call.path.includes('/approve')).map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
