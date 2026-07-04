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

const addDaysKey = (key, offset) => {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

const TODAY = todayKey();
const YESTERDAY = addDaysKey(TODAY, -1);

const state = {
  tasks: [
    { id: 'task-list-overdue', title: '목록 표면 만료 작업', date: YESTERDAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-list-active-a', title: '목록 표면 활성 A', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-list-active-b', title: '목록 표면 활성 B', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-list-done', title: '목록 표면 완료 작업', date: TODAY, status: 'Done', done: true, owner: 'Me', category: '기본함', project: '기본함', notes: '' },
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

    if (method === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks: state.tasks, data: { tasks: state.tasks } } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      const task = { id: 'task-list-created', ...body };
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
  await page.waitForSelector('.task-list-screen');

  const overdueSection = page.locator('.task-section', { hasText: '만료됨' });
  await overdueSection.locator('header > button').first().click();
  await page.waitForFunction(() => document.querySelector('.task-section')?.getAttribute('data-collapsed') === 'true');
  assert.equal(await page.locator('.task-row', { hasText: '목록 표면 만료 작업' }).count(), 0);
  await overdueSection.locator('header > button').first().click();
  await page.locator('.task-row', { hasText: '목록 표면 만료 작업' }).waitFor();

  await page.getByRole('button', { name: /평일 근무/ }).click();
  assert.equal(await page.locator('.list-quick input').inputValue(), '근무 평일 ');
  await page.getByRole('button', { name: /매월 정산/ }).click();
  assert.equal(await page.locator('.list-quick input').inputValue(), '매월 ');

  await page.locator('.list-quick input').fill('내일 오후3시 목록 표면 빠른 추가 #업무 !높음 @agent 매주');
  await page.locator('.list-quick button').click();
  await page.locator('.task-row', { hasText: '목록 표면 빠른 추가' }).waitFor();
  assert.equal(await page.locator('.list-quick input').inputValue(), '');

  await page.locator('.task-row', { hasText: '목록 표면 활성 B' }).click();
  assert.equal(await page.locator('.inspector-title').inputValue(), '목록 표면 활성 B');
  await page.locator('.task-inspector .close').click();
  await page.waitForSelector('.task-inspector.empty');
  await page.locator('details.completed-block summary').click();
  await page.waitForSelector('details.completed-block[open] .task-row');
  await page.locator('.task-row', { hasText: '목록 표면 완료 작업' }).click();
  assert.equal(await page.locator('.inspector-title').inputValue(), '목록 표면 완료 작업');

  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/tasks');
  assert.equal(Boolean(createCall), true);
  assert.equal(createCall.body.owner, 'Agent');
  assert.equal(createCall.body.repeat, 'weekly');
  assert.equal(createCall.body.priority, 'P1');
  assert.deepEqual(createCall.body.tags, ['업무']);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createTask: createCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
