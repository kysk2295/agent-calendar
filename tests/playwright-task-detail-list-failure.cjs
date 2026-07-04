const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    {
      id: 'task-detail-list-fail',
      title: '상세 리스트 실패 작업',
      date: '2026-07-04',
      time: '09:00',
      status: 'Planned',
      owner: 'Me',
      category: '기본함',
      project: '기본함',
      list: '기본함',
      notes: '',
    },
    {
      id: 'task-client-list-seed',
      title: '고객사 리스트 씨앗',
      date: '2026-07-04',
      status: 'Planned',
      owner: 'Me',
      category: '고객사',
      project: '고객사',
      list: '고객사',
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

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'PATCH') {
      const id = decodeURIComponent(taskMatch[1]);
      if (id === 'task-detail-list-fail' && body.list === '고객사') {
        await route.fulfill({ status: 500, json: { ok: false, error: 'list patch failed' } });
        return;
      }
      state.tasks = state.tasks.map((task) => task.id === id ? { ...task, ...body } : task);
      const task = state.tasks.find((item) => item.id === id);
      await route.fulfill({ json: { ok: true, task, data: { task, tasks: state.tasks } } });
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
  await page.getByRole('button', { name: '📥 기본함' }).click();
  await page.waitForSelector('.task-row');

  await page.locator('.task-row', { hasText: '상세 리스트 실패 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');

  await page.locator('.detail-list-pill').click();
  await page.locator('.detail-list-popover input').fill('고객');
  await page.locator('.detail-list-popover .new-list-row', { hasText: '고객사' }).click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.detail-list-popover').count(), 1);
  assert.equal(await page.locator('.detail-list-popover input').inputValue(), '고객');
  assert.match(await page.locator('.detail-list-pill').textContent(), /기본함/);
  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-detail-list-fail' && call.body.list === '고객사'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patchCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
