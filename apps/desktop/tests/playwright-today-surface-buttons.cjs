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
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
};

const TODAY = todayKey();
const YESTERDAY = addDaysKey(TODAY, -1);
const TOMORROW = addDaysKey(TODAY, 1);

const state = {
  agents: [
    { id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' },
  ],
  tasks: [
    { id: 'today-main-task', title: '오늘 표면 작업', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'today-overdue-task', title: '오늘 표면 지연 작업', date: YESTERDAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'today-suggest-task', title: '오늘 표면 제안 작업', status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
  ],
  runs: [
    { id: 'today-review-run', title: '오늘 표면 검토 런', agent: 'default', status: 'done', goal: '오늘 화면 실행 열기' },
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
      const task = { id: 'today-created-task', ...body };
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
    if (method === 'POST' && path === '/api/runs/today-review-run/approve') {
      state.runs = state.runs.map((run) => run.id === 'today-review-run' ? { ...run, status: 'approved', approved: true } : run);
      await route.fulfill({ json: { ok: true, run: state.runs[0] } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: [],
        agents: state.agents,
        runs: state.runs,
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
  await page.waitForSelector('.task-list-screen');
  await page.waitForSelector('.list-quick input');

  await page.locator('.list-quick input').fill('오후3시 당일화면 빠른 추가 #업무 !높음 @agent');
  await page.locator('.list-quick button').click();
  await page.locator('.row', { hasText: '당일화면 빠른 추가' }).waitFor();
  assert.equal(await page.locator('.list-quick input').inputValue(), '');

  await page.locator('.row', { hasText: '오늘 표면 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');
  assert.equal(await page.locator('.detail-title-input').inputValue(), '오늘 표면 작업');
  await page.locator('.detail-close').click();

  await page.locator('.nav-item', { hasText: '에이전트' }).click();
  await page.locator('.run-row', { hasText: '오늘 표면 검토 런' }).click();
  await page.waitForSelector('.run-modal');
  assert.match(await page.locator('.run-modal').textContent(), /오늘 표면 검토 런/);
  await page.locator('.run-close').click();

  await page.locator('.run-row', { hasText: '오늘 표면 검토 런' }).click();
  await page.locator('.run-approve').click();
  await page.waitForFunction(() => !document.querySelector('.run-row'));

  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/tasks');
  const approveCall = calls.find((call) => call.method === 'POST' && call.path === '/api/runs/today-review-run/approve');

  assert.equal(createCall?.body.date, TODAY);
  assert.equal(createCall?.body.time, '15:00');
  assert.equal(createCall?.body.owner, 'Agent');
  assert.equal(Boolean(approveCall), true);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createTask: createCall.body, approvals: [approveCall.path] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
