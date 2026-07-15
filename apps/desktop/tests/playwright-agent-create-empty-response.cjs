const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const agents = [
  { id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' },
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

    const method = request.method();
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents } });
      return;
    }
    if (method === 'POST' && path === '/api/agent-operations/work') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (method === 'GET' && path === '/api/agent-operations') {
      await route.fulfill({ json: { ok: true, missions: [], tasks: [], sessions: [], reports: [], daemon: { running: true, lastRun: null, lastError: null } } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents,
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
  await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
  await page.waitForSelector('.agent-control-room');
  const workCards = page.locator('[data-work-mission]');
  const beforeCards = await workCards.count();
  const prompt = page.getByLabel('에이전트에게 작업 지시');
  await prompt.fill('빈 응답이면 이 작업 지시를 보존해야 합니다.');
  await page.getByRole('button', { name: '위임' }).click();

  await page.waitForSelector('.agent-operations-error');
  assert.equal(await prompt.inputValue(), '빈 응답이면 이 작업 지시를 보존해야 합니다.');
  assert.equal(await workCards.count(), beforeCards);
  assert.equal(await page.locator('.agent-work-conversation').count(), 0);
  assert.equal(await page.getByRole('button', { name: '다시 시도' }).count(), 1);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/agent-operations/work'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
