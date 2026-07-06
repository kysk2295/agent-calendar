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

const TODAY = todayKey();

const state = {
  tasks: [
    {
      id: 'task-calendar-surface-all-day',
      title: '캘린더 표면 all-day 작업',
      date: TODAY,
      owner: 'Me',
      status: 'Planned',
      project: '기본함',
      category: '기본함',
      source: 'desktop-task-db',
      notes: '',
    },
    {
      id: 'task-calendar-surface-timed',
      title: '캘린더 표면 시간 작업',
      date: TODAY,
      time: '09:00',
      owner: 'Me',
      status: 'Planned',
      project: '기본함',
      category: '기본함',
      source: 'desktop-task-db',
      notes: '',
    },
  ],
  events: [
    {
      id: 'event-calendar-surface',
      title: '캘린더 표면 일정',
      date: TODAY,
      startDate: TODAY,
      time: '11:00',
      owner: 'Me',
      status: 'Planned',
      project: '기본함',
      category: '기본함',
      kind: 'calendar-event',
      type: 'calendar-event',
      source: 'desktop-calendar-event',
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

    if (method === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks: state.tasks, data: { tasks: state.tasks } } });
      return;
    }
    if (method === 'GET' && path === '/api/calendar/events') {
      await route.fulfill({ json: { ok: true, events: state.events, data: { events: state.events } } });
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
        events: state.events,
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
  await page.waitForSelector('.calendar');

  const initialMonth = await page.locator('.screen-toolbar h2').textContent();
  await page.locator('.screen-toolbar > button').nth(2).click();
  await page.waitForFunction((month) => document.querySelector('.screen-toolbar h2')?.textContent !== month, initialMonth);
  await page.locator('.screen-toolbar > button').nth(1).click();
  await page.waitForFunction((month) => document.querySelector('.screen-toolbar h2')?.textContent === month, initialMonth);
  await page.locator('.screen-toolbar > button').nth(0).click();
  await page.locator('.day-cell[data-today="true"]').waitFor();

  await page.getByRole('button', { name: '주', exact: true }).click();
  await page.waitForSelector('.week-grid');
  await page.locator('.week-col[data-today="true"] .week-events').click();
  await page.waitForSelector('.new-task-popover');
  assert.match(await page.locator('.new-date-chip').textContent(), /월|오늘|일/);
  await page.locator('.new-close').click();

  await page.locator('.week-col[data-today="true"] .week-head').click();
  await page.waitForSelector('.day-schedule');
  await page.locator('.hour-row').nth(5).click();
  await page.waitForSelector('.new-task-popover');
  assert.match(await page.locator('.new-date-chip').textContent(), /오후|오전|시|일/);
  await page.locator('.new-close').click();

  await page.locator('.day-all-day', { hasText: '캘린더 표면 all-day 작업' }).locator('i').click();
  await page.waitForTimeout(250);
  const donePatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-calendar-surface-all-day' && call.body.status === 'Done' && call.body.done === true);
  assert.equal(Boolean(donePatch), true);

  await page.locator('.day-all-day', { hasText: '캘린더 표면 all-day 작업' }).locator('b').click();
  await page.locator('.hour-row').nth(3).click();
  await page.waitForTimeout(250);
  const placePatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-calendar-surface-all-day' && call.body.time === '10:00' && call.body.date === TODAY);
  assert.equal(Boolean(placePatch), true);

  await page.getByRole('button', { name: '월', exact: true }).click();
  await page.locator('.day-cell[data-today="true"] strong').click();
  await page.waitForSelector('.day-schedule');
  await page.getByRole('button', { name: '월', exact: true }).click();
  await page.locator('.event-pill', { hasText: '캘린더 표면 일정' }).first().click();
  await page.waitForSelector('.detail-modal');
  assert.equal(await page.locator('.detail-title-input').inputValue(), '캘린더 표면 일정');

  await browser.close();
  console.log(JSON.stringify({
    ok: true,
    patched: calls.filter((call) => call.method === 'PATCH').map((call) => ({ path: call.path, body: call.body })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
