const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    { id: 'review-goal-existing', title: '기존 회고 목표', status: 'Planned', owner: 'Me', list: 'goals', category: '목표', project: '목표', tags: ['goal', 'review'], notes: '' },
    { id: 'review-done-task', title: '완료된 업무', status: 'Done', done: true, owner: 'Me', category: '기본함', project: '기본함', notes: '' },
  ],
  documents: [],
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

    if (method === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks: state.tasks, data: { tasks: state.tasks } } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      const task = { id: 'review-goal-created', ...body };
      state.tasks = [task, ...state.tasks];
      await route.fulfill({ json: { ok: true, task, data: { task, tasks: state.tasks } } });
      return;
    }
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'PATCH') {
      const id = decodeURIComponent(taskMatch[1]);
      state.tasks = state.tasks.map((task) => task.id === id ? { ...task, ...body } : task);
      const task = state.tasks.find((item) => item.id === id);
      await route.fulfill({ json: { ok: true, task, data: { task, tasks: state.tasks } } });
      return;
    }
    if (method === 'POST' && path === '/api/wiki/ask') {
      await route.fulfill({ json: { ok: true, answer: '주간 회고 자동 생성 결과\n- 좋았던 점\n- 다음 개선' } });
      return;
    }
    if (method === 'POST' && path === '/api/documents') {
      const document = { id: 'review-doc-created', path: '4_journal/review.md', ...body };
      state.documents = [document, ...state.documents];
      await route.fulfill({ json: { ok: true, document, data: { document } } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: [],
        agents: [],
        runs: [],
        documents: state.documents,
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
  await page.locator('.nav-item', { hasText: '주간 회고' }).click();
  await page.waitForSelector('.review-screen');

  await page.locator('.review-goal', { hasText: '기존 회고 목표' }).click();
  await page.waitForTimeout(150);

  await page.locator('.review-add input').fill('새 회고 목표');
  await page.locator('.review-add input').press('Enter');
  await page.locator('.review-goal', { hasText: '새 회고 목표' }).waitFor();
  assert.equal(await page.locator('.review-add input').inputValue(), '');

  await page.getByRole('button', { name: '자동 생성' }).click();
  await page.waitForFunction(() => document.querySelector('.review-retro article')?.textContent?.includes('주간 회고 자동 생성 결과'));
  await page.getByRole('button', { name: '위키에 저장' }).click();
  await page.waitForTimeout(150);

  const toggleCall = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/review-goal-existing');
  const createGoalCall = calls.find((call) => call.method === 'POST' && call.path === '/api/tasks');
  const askCall = calls.find((call) => call.method === 'POST' && call.path === '/api/wiki/ask');
  const saveCall = calls.find((call) => call.method === 'POST' && call.path === '/api/documents');

  assert.equal(toggleCall?.body.status, 'Done');
  assert.equal(toggleCall?.body.done, true);
  assert.equal(createGoalCall?.body.title, '새 회고 목표');
  assert.deepEqual(createGoalCall?.body.tags, ['goal', 'review']);
  assert.equal(Boolean(askCall), true);
  assert.match(String(saveCall?.body.body || ''), /주간 회고 자동 생성 결과/);
  assert.equal(saveCall?.body.kind, 'review');
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createGoal: createGoalCall.body, saved: saveCall.body.title }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
