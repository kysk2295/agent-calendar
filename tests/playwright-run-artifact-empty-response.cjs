const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const run = {
  id: 'run-artifact-empty',
  title: '빈 문서 응답 실행',
  goal: '빈 문서 응답을 확인한다',
  agent: 'default',
  status: 'done',
  progress: 100,
  artifact: '빈 응답 결과 문서',
};

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
        agents: [{ id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready', profile: { name: 'default' } }],
        runs: [run],
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
  await page.getByRole('button', { name: /에이전트/ }).click();
  await page.waitForSelector('.agent-runs');
  await page.locator('.run-row', { hasText: '빈 문서 응답 실행' }).click();
  await page.waitForSelector('.run-report');

  await page.locator('.run-artifact').getByRole('button', { name: /열기/ }).click();
  await page.waitForSelector('.api-banner', { timeout: 5000 });

  assert.equal(await page.locator('.run-report').count(), 1);
  assert.equal(await page.locator('.wiki-reader').count(), 0);
  assert.doesNotMatch(await page.locator('.nav-item[data-active="true"]').textContent(), /위키/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/documents'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
