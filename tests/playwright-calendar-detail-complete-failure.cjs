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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  tasks: [],
  events: [
    {
      id: 'event-detail-complete-fail',
      title: '캘린더 상세 완료 실패 일정',
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
      if (body.status === 'Done') await delay(400);
      await route.fulfill({ status: 500, json: { ok: false, error: 'calendar complete failed' } });
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
  await page.locator('.event-pill', { hasText: '캘린더 상세 완료 실패 일정' }).first().click();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-modal .detail-check').click();
  await page.waitForFunction(() => document.querySelector('.detail-modal .detail-check')?.getAttribute('data-done') === 'true');
  await page.waitForSelector('.api-banner');
  await page.waitForFunction(() => (
    document.querySelector('.detail-modal .detail-check')?.getAttribute('data-done') === 'false' &&
    document.querySelector('.detail-modal .detail-status')?.textContent?.includes('진행 중')
  ));

  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/calendar/events/event-detail-complete-fail' && call.body.status === 'Done'), true);
  assert.equal(await page.locator('.detail-title-input').inputValue(), '캘린더 상세 완료 실패 일정');
  assert.match(await page.locator('.api-banner').textContent(), /Agents Calendar API 500 \/api\/calendar\/events\/event-detail-complete-fail/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patchCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
