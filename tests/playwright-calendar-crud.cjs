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
      id: 'task-existing',
      title: '기존 예약 작업',
      date: TODAY,
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
        date: jsonBody.selectedDate || TODAY,
        startDate: jsonBody.startDate || jsonBody.date || TODAY,
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
  await page.locator('.new-accordion-row', { hasText: '시간' }).click();
  await page.waitForSelector('.new-panel .date-time-menu');
  await page.locator('.new-panel .date-time-menu button', { hasText: '오전 1:00' }).waitFor();
  await page.locator('.new-panel .date-time-menu button', { hasText: '오전 9:30' }).click();
  await page.waitForFunction(() => !document.querySelector('.new-panel .date-time-menu'));
  await page.getByRole('button', { name: '지속 시간' }).click();
  await page.locator('.new-panel .duration-time-input').first().click();
  await page.waitForSelector('.new-panel .duration-time-menu');
  await page.locator('.new-panel .duration-time-menu button', { hasText: '오전 1:00' }).waitFor();
  await page.locator('.new-panel .duration-time-menu button', { hasText: '오전 10:00' }).click();
  await page.locator('.duration-grid input').nth(2).fill(TODAY);
  await page.locator('.new-panel .duration-time-input').nth(1).click();
  await page.waitForSelector('.new-panel .duration-time-menu');
  await page.locator('.new-panel .duration-time-menu button', { hasText: '오전 11:30' }).click();
  await page.waitForFunction(() => !document.querySelector('.new-panel'));
  await page.locator('.new-date-chip').click();
  await page.getByRole('button', { name: '반복' }).click();
  await page.getByRole('button', { name: '매주' }).click();
  await page.locator('.new-task-title-row input').press('Enter');

  await page.waitForFunction(() => !document.querySelector('.new-task-popover'));
  await page.getByRole('button', { name: /Playwright 캘린더 일정/ }).first().click();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-title-input').fill('Playwright 캘린더 수정');
  await page.locator('.detail-date-trigger').click();
  await page.getByRole('button', { name: '지속 시간' }).click();
  await page.locator('.duration-grid input').nth(0).fill('2026-06-30');
  await page.locator('.duration-grid input').nth(1).fill('12:00');
  await page.locator('.duration-grid input').nth(2).fill('2026-06-30');
  await page.locator('.duration-grid input').nth(3).fill('13:00');
  await page.getByRole('button', { name: '확인' }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: '삭제' }).click();
  await page.waitForFunction(() => !document.querySelector('.detail-modal'));

  const createEvent = calls.find((call) => call.method === 'POST' && call.path === '/api/calendar/events');
  const patchCalls = calls.filter((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-calendar-created');
  const deleteCall = calls.find((call) => call.method === 'DELETE' && call.path === '/api/calendar/events/event-calendar-created');
  const calendarTaskCalls = calls.filter((call) => call.path.startsWith('/api/tasks/') && call.path.includes('event-calendar-created'));
  const lastPatch = patchCalls.at(-1)?.body || {};

  assert.equal(Boolean(createEvent), true);
  assert.equal(createEvent.body.time, '10:00');
  assert.equal(createEvent.body.endTime, '11:30');
  assert.equal(createEvent.body.recurrence, 'weekly');
  assert.equal(patchCalls.length > 0, true);
  assert.equal(lastPatch.date, '2026-06-30');
  assert.equal(lastPatch.startDate, '2026-06-30');
  assert.equal(lastPatch.time, '12:00');
  assert.equal(lastPatch.endDate, '2026-06-30');
  assert.equal(lastPatch.endTime, '13:00');
  assert.match(String(lastPatch.notes || ''), /\[Agent Calendar\]/);
  assert.equal(Boolean(deleteCall), true);
  assert.deepEqual(calendarTaskCalls, []);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createEvent: createEvent.body, lastPatch, delete: deleteCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
