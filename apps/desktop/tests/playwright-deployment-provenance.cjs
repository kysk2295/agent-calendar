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
    calls.push({ method: request.method(), path });
    if (request.method() === 'GET' && path === '/api/gateway-status') {
      await route.fulfill({
        json: {
          buildCommit: '0123456789ab',
          deploymentId: 'deployment-12345678',
          runtimeAccessMode: 'relay',
          effectiveRuntimeReachable: true,
        },
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
  await page.locator('.profile').click();
  const status = page.locator('.deployment-status');
  await status.waitFor({ timeout: 5_000 });
  const statusText = await status.textContent();

  assert.match(statusText, /0123456789ab/);
  assert.match(statusText, /deployment-12345678/);
  assert.match(statusText, /Relay 연결/);
  assert.equal(calls.some((call) => call.path === '/api/gateway-status'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, statusText }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
