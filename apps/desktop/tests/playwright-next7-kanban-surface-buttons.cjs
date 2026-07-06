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
const NEXT_WEEK = addDaysKey(TODAY, 7);
const OUTSIDE = addDaysKey(TODAY, 8);

const state = {
  tasks: [
    { id: 'task-next7-visible', title: '다음7일 표면 표시 작업', date: NEXT_WEEK, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-next7-hidden', title: '다음7일 표면 숨김 작업', date: OUTSIDE, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-kanban-todo', title: '칸반 기본 카드', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-kanban-doing', title: '칸반 진행 카드', date: TODAY, status: 'Doing', owner: 'Agent', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-kanban-review', title: '칸반 검토 카드', date: TODAY, status: 'review', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-kanban-done', title: '칸반 완료 카드', date: TODAY, status: 'Done', done: true, owner: 'Me', category: '기본함', project: '기본함', notes: '' },
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
      const task = { id: 'task-next7-created', ...body };
      state.tasks = [task, ...state.tasks];
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
  await page.locator('.nav-item', { hasText: '다음 7일' }).click();
  await page.waitForSelector('.task-list-screen');
  assert.equal(await page.locator('.task-row', { hasText: '다음7일 표면 표시 작업' }).count(), 1);
  assert.equal(await page.locator('.task-row', { hasText: '다음7일 표면 숨김 작업' }).count(), 0);

  await page.locator('.list-quick input').fill('다음7일 빠른 추가');
  await page.locator('.list-quick button').click();
  await page.locator('.task-row', { hasText: '다음7일 빠른 추가' }).waitFor();
  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/tasks');
  assert.equal(createCall?.body.date, TODAY);

  await page.locator('.nav-item', { hasText: '칸반 보드' }).click();
  await page.waitForSelector('.kanban');
  const columns = await page.locator('.kanban-col').evaluateAll((nodes) => nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim()));
  assert.equal(columns.some((text) => /기본.*칸반 기본 카드/.test(text || '')), true);
  assert.equal(columns.some((text) => /진행 중.*칸반 진행 카드/.test(text || '')), true);
  assert.equal(columns.some((text) => /검토.*칸반 검토 카드/.test(text || '')), true);
  assert.equal(columns.some((text) => /완료.*칸반 완료 카드/.test(text || '')), true);

  await page.locator('.kanban-card', { hasText: '칸반 진행 카드' }).click();
  await page.waitForSelector('.detail-modal');
  assert.equal(await page.locator('.detail-title-input').inputValue(), '칸반 진행 카드');
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createTask: createCall.body, columns }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
