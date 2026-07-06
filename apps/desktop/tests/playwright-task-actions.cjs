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
const TOMORROW = addDaysKey(TODAY, 1);

const state = {
  tasks: [
    { id: 'task-overdue', title: '연기 대상 작업', date: YESTERDAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
    { id: 'task-action', title: '액션 대상 작업', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '' },
  ],
  events: [],
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
      state.tasks = state.tasks.map((task) => task.id === id ? { ...task, ...body } : task);
      const task = state.tasks.find((item) => item.id === id);
      await route.fulfill({ json: { ok: true, task, data: { task, tasks: state.tasks } } });
      return;
    }
    if (taskMatch && method === 'DELETE') {
      const id = decodeURIComponent(taskMatch[1]);
      const task = state.tasks.find((item) => item.id === id);
      state.tasks = state.tasks.filter((item) => item.id !== id);
      await route.fulfill({ json: { ok: true, task, data: { task, tasks: state.tasks } } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: state.events,
        agents: [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }],
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

  await page.getByRole('button', { name: '연기하다' }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('만료됨'));

  const actionRow = page.locator('.task-row', { hasText: '액션 대상 작업' });
  await actionRow.locator('i').click();
  await page.waitForSelector('.completion-toast');
  await page.getByRole('button', { name: '되돌리기' }).click();
  await page.waitForFunction(() => !document.querySelector('.completion-toast'));

  await actionRow.dblclick();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-flag').click();
  await page.locator('.detail-tool[title="서식"]').click();
  await page.getByRole('button', { name: '제목' }).click();
  await page.locator('.detail-tool[title="댓글"]').click();
  await page.locator('.detail-tool-popover input').fill('액션 댓글');
  await page.getByRole('button', { name: '남기기' }).click();
  await page.locator('.detail-tool[title="더보기"]').click();
  await page.getByRole('button', { name: '내일로' }).click();
  await page.locator('.detail-date-trigger').click();
  await page.locator('.detail-date-row', { hasText: '정각에' }).click();
  await page.getByRole('button', { name: '확인' }).click();
  await page.getByRole('button', { name: '삭제' }).click();
  await page.waitForFunction(() => !document.querySelector('.detail-modal'));

  const overduePatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-overdue');
  const actionPatches = calls.filter((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-action');
  const deleteCall = calls.find((call) => call.method === 'DELETE' && call.path === '/api/tasks/task-action');

  assert.equal(overduePatch?.body.date, TODAY);
  assert.equal(actionPatches.some((call) => call.body.done === true && call.body.status === 'Done'), true);
  assert.equal(actionPatches.some((call) => call.body.done === false && call.body.status === 'Planned'), true);
  assert.equal(actionPatches.some((call) => call.body.priority === 'P1'), true);
  assert.equal(actionPatches.some((call) => String(call.body.notes || '').includes('## 소제목')), true);
  assert.equal(actionPatches.some((call) => String(call.body.notes || '').includes('액션 댓글')), true);
  assert.equal(actionPatches.some((call) => call.body.date === TOMORROW), true);
  assert.equal(actionPatches.some((call) => call.body.reminder === 'at_time' && call.body.reminderAt === 'at_time'), true);
  assert.equal(Boolean(deleteCall), true);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patchCalls: calls.filter((call) => call.method === 'PATCH'), deleted: deleteCall?.path }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
