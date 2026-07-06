const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    {
      id: 'task-drag-month',
      title: '드래그 할일',
      date: '2026-07-08',
      time: '',
      owner: 'Me',
      status: 'Planned',
      project: '기본함',
      category: '기본함',
      tags: [],
      source: 'desktop-task-db',
      notes: '',
    },
  ],
  events: [
    {
      id: 'event-drag-month',
      title: '드래그 일정',
      date: '2026-07-09',
      startDate: '2026-07-09',
      time: '14:00',
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
    const eventMatch = path.match(/^\/api\/calendar\/events\/([^/]+)$/);
    if (eventMatch && method === 'PATCH') {
      const id = decodeURIComponent(eventMatch[1]);
      state.events = state.events.map((event) => event.id === id ? { ...event, ...body } : event);
      const event = state.events.find((item) => item.id === id);
      await route.fulfill({ json: { ok: true, event, data: { event, events: state.events } } });
      return;
    }
    if (eventMatch && method === 'DELETE') {
      const id = decodeURIComponent(eventMatch[1]);
      const event = state.events.find((item) => item.id === id);
      state.events = state.events.filter((item) => item.id !== id);
      await route.fulfill({ json: { ok: true, event, data: { event, events: state.events } } });
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
        messages: [],
        commands: [],
        jobs: [],
        channels: [],
        tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
      },
    });
  });

  await page.goto(target);
  await page.waitForSelector('.calendar');

  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/tasks/task-drag-month') && response.request().method() === 'PATCH'),
    page.locator('.event-pill', { hasText: '드래그 할일' }).dragTo(page.locator('.day-cell[data-date="2026-07-10"]')),
  ]);

  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/calendar/events/event-drag-month') && response.request().method() === 'PATCH'),
    page.locator('.event-pill', { hasText: '드래그 일정' }).dragTo(page.locator('.day-cell[data-date="2026-07-11"]')),
  ]);

  await page.locator('.day-cell[data-date="2026-07-11"] strong').click();
  await page.waitForSelector('.day-schedule');
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/calendar/events/event-drag-month') && response.request().method() === 'PATCH'),
    page.locator('.hour-row em', { hasText: '드래그 일정' }).dragTo(page.getByRole('button', { name: /오전 10시/ })),
  ]);

  await page.locator('.hour-row em', { hasText: '드래그 일정' }).click();
  await page.waitForSelector('.detail-modal');
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/calendar/events/event-drag-month') && response.request().method() === 'DELETE'),
    page.locator('.detail-delete').click(),
  ]);
  await page.waitForFunction(() => !document.querySelector('.detail-modal'));

  const taskPatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-drag-month');
  const eventDatePatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-drag-month' && call.body.date === '2026-07-11');
  const eventTimePatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-drag-month' && call.body.time === '10:00');
  const eventDelete = calls.find((call) => call.method === 'DELETE' && call.path === '/api/calendar/events/event-drag-month');
  assert.equal(taskPatch?.body.date, '2026-07-10');
  assert.equal(eventDatePatch?.body.date, '2026-07-11');
  assert.equal(eventDatePatch?.body.startDate, '2026-07-11');
  assert.equal(eventTimePatch?.body.date, '2026-07-11');
  assert.equal(eventTimePatch?.body.time, '10:00');
  assert.equal(Boolean(eventDelete), true);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, taskPatch: taskPatch.body, eventDatePatch: eventDatePatch.body, eventTimePatch: eventTimePatch.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
