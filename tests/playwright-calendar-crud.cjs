const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    {
      id: 'task-existing',
      title: '기존 예약 작업',
      date: '2026-06-29',
      time: '09:00',
      owner: 'Me',
      status: 'Planned',
      project: '기본함',
      category: '기본함',
      tags: [],
      source: 'desktop-task-db',
      notes: '',
    },
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
    let jsonBody = {};
    try { jsonBody = request.postData() ? JSON.parse(request.postData()) : {}; } catch { jsonBody = {}; }
    calls.push({ method, path, body: jsonBody });

    if (method === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: state.tasks, events: state.events, agents: [], runs: [], documents: [], chatMessages: [] } });
      return;
    }
    if (method === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, data: { tasks: state.tasks }, tasks: state.tasks } });
      return;
    }
    if (method === 'GET' && path === '/api/calendar/events') {
      await route.fulfill({ json: { ok: true, data: { events: state.events }, events: state.events } });
      return;
    }
    if (method === 'POST' && path === '/api/calendar/events') {
      const event = {
        id: 'event-calendar-created',
        title: String(jsonBody.title || '새 일정'),
        date: jsonBody.selectedDate || '2026-06-29',
        startDate: jsonBody.startDate || jsonBody.date || '2026-06-29',
        time: jsonBody.time || '',
        endDate: jsonBody.endDate || '',
        endTime: jsonBody.endTime || '',
        allDay: Boolean(jsonBody.allDay),
        recurrence: jsonBody.recurrence || '',
        owner: 'Me',
        status: 'Planned',
        project: '기본함',
        category: '기본함',
        kind: 'calendar-event',
        source: 'desktop-calendar-event',
        notes: '',
      };
      state.events.unshift(event);
      await route.fulfill({ json: { ok: true, event, data: { event, events: state.events } } });
      return;
    }
    const eventMatch = path.match(/^\/api\/calendar\/events\/([^/]+)$/);
    if (eventMatch && method === 'PATCH') {
      const id = decodeURIComponent(eventMatch[1]);
      state.events = state.events.map((event) => event.id === id ? { ...event, ...jsonBody } : event);
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
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'PATCH') {
      const id = decodeURIComponent(taskMatch[1]);
      state.tasks = state.tasks.map((task) => task.id === id ? { ...task, ...jsonBody } : task);
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
    await route.fulfill({ json: { ok: true, data: {} } });
  });

  await page.goto(target);
  await page.waitForSelector('.calendar');

  await page.getByRole('button', { name: '일', exact: true }).click();
  await page.locator('.hour-row').first().click();
  await page.locator('.new-task-title-row input').fill('Playwright 캘린더 일정');
  await page.locator('.new-date-chip').click();
  await page.getByRole('button', { name: '지속 시간' }).click();
  await page.locator('.duration-grid input').nth(1).fill('10:00');
  await page.locator('.duration-grid input').nth(2).fill('2026-06-29');
  await page.locator('.duration-grid input').nth(3).fill('11:30');
  await page.locator('.duration-grid .switch').click();
  await page.getByRole('button', { name: '반복' }).click();
  await page.getByRole('button', { name: '매주' }).click();
  await page.getByRole('button', { name: '확인' }).click();

  await page.waitForFunction(() => !document.querySelector('.new-task-popover'));
  await page.getByRole('button', { name: /Playwright 캘린더 일정/ }).first().click();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-head input').fill('Playwright 캘린더 수정');
  await page.locator('.detail-form input').nth(0).fill('2026-06-30');
  await page.locator('.detail-form input').nth(1).fill('12:00');
  await page.locator('.detail-form input').nth(2).fill('2026-06-30');
  await page.locator('.detail-form input').nth(3).fill('13:00');
  await page.getByRole('button', { name: '매월' }).click();
  await page.locator('.detail-form input').nth(4).fill('2026-12-31');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: '삭제' }).click();
  await page.waitForFunction(() => !document.querySelector('.detail-modal'));

  const createEvent = calls.find((call) => call.method === 'POST' && call.path === '/api/calendar/events');
  const patchCalls = calls.filter((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-calendar-created');
  const deleteCall = calls.find((call) => call.method === 'DELETE' && call.path === '/api/calendar/events/event-calendar-created');
  const calendarTaskCalls = calls.filter((call) => call.path.startsWith('/api/tasks/') && call.path.includes('event-calendar-created'));
  const lastPatch = patchCalls.at(-1)?.body || {};

  assert.equal(Boolean(createEvent), true);
  assert.equal(createEvent.body.syncTickTick, false);
  assert.equal(patchCalls.length > 0, true);
  assert.equal(lastPatch.syncTickTick, false);
  assert.equal(lastPatch.recurrence, 'monthly');
  assert.equal(lastPatch.endDate, '2026-06-30');
  assert.equal(lastPatch.endTime, '13:00');
  assert.match(String(lastPatch.notes || ''), /\[Hermes Calendar\]/);
  assert.equal(Boolean(deleteCall), true);
  assert.equal(deleteCall.body.syncTickTick, false);
  assert.deepEqual(calendarTaskCalls, []);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createEvent: createEvent.body, lastPatch, delete: deleteCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
