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
const TOMORROW = (() => {
  const date = new Date(`${TODAY}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
})();

const state = {
  tasks: [],
  events: [
    {
      id: 'event-detail-tools',
      title: '캘린더 상세 도구 일정',
      date: TODAY,
      startDate: TODAY,
      time: '09:00',
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
    const eventMatch = path.match(/^\/api\/calendar\/events\/([^/]+)$/);
    if (eventMatch && method === 'PATCH') {
      const id = decodeURIComponent(eventMatch[1]);
      state.events = state.events.map((event) => event.id === id ? { ...event, ...body } : event);
      const event = state.events.find((item) => item.id === id);
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
  await page.locator('.event-pill', { hasText: '캘린더 상세 도구 일정' }).first().click();
  await page.waitForSelector('.detail-modal');

  const waitForEventPatch = async (action) => {
    const responsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/calendar/events/event-detail-tools') &&
      response.request().method() === 'PATCH'
    ));
    await action();
    await responsePromise;
  };

  await waitForEventPatch(() => page.locator('.detail-flag').click());

  await page.locator('.detail-tool[title="서식"]').click();
  await waitForEventPatch(() => page.getByRole('button', { name: '제목' }).click());

  await page.locator('.detail-tool[title="댓글"]').click();
  await page.locator('.detail-tool-popover input').fill('캘린더 이벤트 댓글');
  await waitForEventPatch(() => page.getByRole('button', { name: '남기기' }).click());

  await page.locator('.detail-tool[title="더보기"]').click();
  await waitForEventPatch(() => page.getByRole('button', { name: '내일로' }).click());

  const repeatButton = page.getByRole('button', { name: /매주 반복|반복 해제/ });
  if (!(await repeatButton.isVisible().catch(() => false))) {
    await page.locator('.detail-tool[title="더보기"]').click();
  }
  await waitForEventPatch(() => repeatButton.click());

  await page.locator('.detail-date-trigger').click();
  await waitForEventPatch(() => page.locator('.detail-date-row', { hasText: '정각에' }).click());

  const eventPatches = calls.filter((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-detail-tools');
  const taskPatches = calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/api/tasks/'));

  assert.equal(eventPatches.length >= 6, true);
  assert.equal(taskPatches.length, 0);
  assert.equal(eventPatches.some((call) => call.body.priority === 'P1'), true);
  assert.equal(eventPatches.some((call) => String(call.body.notes || '').includes('## 소제목')), true);
  assert.equal(eventPatches.some((call) => String(call.body.notes || '').includes('캘린더 이벤트 댓글')), true);
  assert.equal(eventPatches.some((call) => call.body.date === TOMORROW && call.body.startDate === TOMORROW), true);
  assert.equal(eventPatches.some((call) => call.body.recurrence === 'weekly' && call.body.repeat === 'weekly'), true);
  assert.equal(eventPatches.some((call) => call.body.reminder === 'at_time' && call.body.reminderAt === 'at_time'), true);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, eventPatches: eventPatches.map((call) => call.body) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
