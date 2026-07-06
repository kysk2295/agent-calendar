const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [],
  events: [
    {
      id: 'event-range-single',
      title: '병원 입원',
      date: '2026-07-08',
      startDate: '2026-07-08',
      time: '18:00',
      endDate: '2026-07-09',
      endTime: '19:00',
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    if (method === 'POST' && path === '/api/calendar/events') {
      await wait(500);
      const event = {
        id: `event-created-${state.events.length}`,
        title: String(body.title || '새 일정'),
        date: body.date || body.startDate || '2026-07-08',
        startDate: body.startDate || body.date || '2026-07-08',
        time: body.time || '',
        endDate: body.endDate || '',
        endTime: body.endTime || '',
        owner: 'Me',
        status: 'Planned',
        project: '기본함',
        category: '기본함',
        kind: 'calendar-event',
        type: 'calendar-event',
        source: 'desktop-calendar-event',
        notes: '',
      };
      state.events.unshift(event);
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

  const rangeCells = await page.locator('.day-cell').evaluateAll((cells) => cells
    .map((cell) => ({
      day: cell.querySelector('strong')?.textContent || '',
      text: cell.textContent || '',
      pills: Array.from(cell.querySelectorAll('.event-pill')).map((pill) => ({
        text: pill.textContent || '',
        className: pill.className,
        background: getComputedStyle(pill).backgroundColor,
      })),
    }))
    .filter((cell) => cell.day === '8' || cell.day === '9'));
  assert.equal(rangeCells.find((cell) => cell.day === '8')?.text.includes('병원 입원'), true);
  assert.equal(rangeCells.find((cell) => cell.day === '9')?.text.includes('병원 입원'), false);
  assert.equal(rangeCells.find((cell) => cell.day === '9')?.text.includes('오후 7:00'), true);
  assert.match(rangeCells.find((cell) => cell.day === '8')?.pills[0]?.className || '', /range-start/);
  assert.match(rangeCells.find((cell) => cell.day === '9')?.pills[0]?.className || '', /range-end/);
  assert.equal(rangeCells.find((cell) => cell.day === '8')?.pills[0]?.background, 'rgb(142, 163, 243)');

  await page.locator('.day-cell', { hasText: /^8/ }).first().click();
  await page.locator('.new-task-title-row input').fill('중복 방지 일정');
  const input = page.locator('.new-task-title-row input');
  await input.press('Enter');
  await input.press('Enter').catch(() => {});
  await input.press('Enter').catch(() => {});
  await input.press('Enter').catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.new-task-popover'));

  const createCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/calendar/events' && call.body.title === '중복 방지 일정');
  assert.equal(createCalls.length, 1);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createCount: createCalls.length, rangeCells }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
