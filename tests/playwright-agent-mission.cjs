const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const agents = [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }];
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

    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method: request.method(), path, body });

    if (request.method() === 'GET' && path === '/api/agents') {
      await route.fulfill({ json: { ok: true, agents } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-mission', title: body.title, status: body.status } } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/missions/launch') {
      await route.fulfill({
        json: {
          ok: true,
          run: {
            id: 'run-new',
            title: '새 미션 런',
            goal: body.goal,
            agent: body.agentId || 'default',
            status: 'running',
            progress: 5,
          },
        },
      });
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
  await page.waitForSelector('.mission');
  await page.locator('.mission textarea').fill('감사 미션 실행');
  await page.getByRole('button', { name: /계획 세우기/ }).click();
  await page.waitForSelector('.run-modal');
  await page.waitForTimeout(900);

  const modalText = await page.locator('.run-modal').textContent();
  assert.match(modalText || '', /새 미션 런|감사 미션 실행/);
  assert.doesNotMatch(modalText || '', /선택된 실행 없음/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/missions/launch'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
