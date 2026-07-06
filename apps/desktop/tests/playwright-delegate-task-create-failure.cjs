const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    {
      id: 'task-delegate-create-fail',
      title: '작업 생성 실패 위임 대상',
      date: '2026-07-04',
      owner: 'Me',
      status: 'Planned',
      category: '기본함',
      project: '기본함',
      list: '기본함',
    },
  ],
  agents: [{ id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' }],
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

    if (method === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents: state.agents } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'task create failed' } });
      return;
    }
    if (method === 'POST' && path === '/api/missions/launch') {
      await route.fulfill({ json: { ok: true, run: { id: 'run-should-not-start', goal: body.goal, status: 'running' } } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: [],
        agents: state.agents,
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
  await page.locator('.task-row', { hasText: '작업 생성 실패 위임 대상' }).dblclick();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-agent').click();
  await page.waitForSelector('.delegate-modal');

  await page.locator('.delegate-modal textarea').fill('작업 생성 실패면 미션 실행하지 말기');
  await page.getByRole('button', { name: '위임하고 실행' }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.delegate-modal').count(), 1);
  assert.equal(await page.locator('.delegate-modal textarea').inputValue(), '작업 생성 실패면 미션 실행하지 말기');
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/missions/launch'), false);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
