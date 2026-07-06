const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const todayKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const state = {
  tasks: [
    {
      id: 'task-complete-fail',
      title: '완료 실패 보존 작업',
      date: todayKey(),
      status: 'Planned',
      owner: 'Me',
      category: '기본함',
      project: '기본함',
      notes: '',
    },
  ],
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

    if (method === 'PATCH' && path === '/api/tasks/task-complete-fail') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'complete failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
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
  await page.locator('.nav-item', { hasText: '오늘' }).click();
  await page.waitForSelector('.plan-row');

  await page.locator('.plan-row', { hasText: '완료 실패 보존 작업' }).locator('.check').click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.completion-toast').count(), 0);
  assert.equal(await page.locator('.plan-row', { hasText: '완료 실패 보존 작업' }).count(), 1);
  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-complete-fail'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patchCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
