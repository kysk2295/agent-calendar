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
  tasks: [],
  events: [
    {
      id: 'event-detail-complete',
      title: '캘린더 상세 완료 작업',
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
  await page.locator('.event-pill', { hasText: '캘린더 상세 완료 작업' }).first().click();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-modal .detail-check').click();
  await page.waitForFunction(() => document.querySelector('.detail-modal .detail-check')?.getAttribute('data-done') === 'true');

  const eventPatch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-detail-complete' && call.body.status === 'Done' && call.body.done === true);
  const taskPatches = calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/api/tasks/'));
  assert.equal(Boolean(eventPatch), true);
  assert.equal(eventPatch.body.status, 'Done');
  assert.equal(eventPatch.body.done, true);
  assert.equal(taskPatches.length, 0);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, eventPatch: eventPatch.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
