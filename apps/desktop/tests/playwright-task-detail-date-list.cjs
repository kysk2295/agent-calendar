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
const TOMORROW = addDaysKey(TODAY, 1);
const NEXT_WEEK = addDaysKey(TODAY, 7);

const state = {
  tasks: [
    {
      id: 'task-detail-flow',
      title: '상세 모달 날짜 리스트 작업',
      date: TODAY,
      time: '09:00',
      owner: 'Me',
      status: 'Planned',
      category: '기본함',
      project: '기본함',
      list: '기본함',
      notes: '',
    },
    {
      id: 'task-list-seed',
      title: '고객사 리스트 씨앗',
      date: TODAY,
      owner: 'Me',
      status: 'Planned',
      category: '고객사',
      project: '고객사',
      list: '고객사',
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

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: state.events,
        agents: [{ id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' }],
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

  await page.locator('.task-row', { hasText: '상세 모달 날짜 리스트 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');
  assert.equal(await page.locator('.detail-date-popover').count(), 0);
  assert.equal(await page.locator('.detail-status').count(), 0);
  assert.match(await page.locator('.detail-date-trigger').textContent(), /오늘, \d+월 \d+일, 오전 9:00/);
  assert.equal(await page.locator('.detail-date-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.detail-date-trigger .detail-date-icon').count(), 1);

  await page.locator('.detail-list-pill').click();
  await page.locator('.detail-list-popover input').fill('고객');
  await page.locator('.detail-list-popover .new-list-row', { hasText: '고객사' }).click();
  await page.waitForFunction(() => !document.querySelector('.detail-list-popover'));

  await page.locator('.detail-list-pill').click();
  await page.waitForSelector('.detail-list-popover');
  await page.locator('.detail-title-input').click();
  await page.waitForFunction(() => !document.querySelector('.detail-list-popover'));

  await page.locator('.detail-date-trigger').click();
  await page.waitForSelector('.detail-date-popover');
  assert.equal(await page.locator('.detail-date-trigger').getAttribute('aria-expanded'), 'true');
  const outsideDetailDatePoint = await page.evaluate(() => {
    const modal = document.querySelector('.detail-modal')?.getBoundingClientRect();
    const popover = document.querySelector('.detail-date-popover')?.getBoundingClientRect();
    const notes = document.querySelector('.detail-notes-input')?.getBoundingClientRect();
    if (!modal || !popover) return null;
    const safeRows = Array.from({ length: 5 }, (_, row) => modal.top + 80 + row * Math.max(24, (modal.height - 160) / 4));
    const safeCols = Array.from({ length: 5 }, (_, col) => modal.left + 32 + col * Math.max(24, (modal.width - 64) / 4));
    const gridCandidates = safeRows.flatMap((y) => safeCols.map((x) => ({ x, y })));
    const candidates = [
      ...(notes ? [
        { x: notes.left + notes.width / 2, y: notes.top + notes.height / 2 },
        { x: notes.left + notes.width - 24, y: notes.top + notes.height - 18 },
      ] : []),
      { x: modal.left + modal.width / 2, y: modal.top + modal.height / 2 },
      ...gridCandidates,
    ];
    return candidates.find((point) => (
      point.x < popover.left || point.x > popover.right || point.y < popover.top || point.y > popover.bottom
    )) || null;
  });
  assert.ok(outsideDetailDatePoint);
  await page.mouse.click(outsideDetailDatePoint.x, outsideDetailDatePoint.y);
  await page.waitForFunction(() => !document.querySelector('.detail-date-popover'));
  await page.waitForSelector('.detail-modal');

  await page.locator('.detail-date-trigger').click();
  const initialIconBoxes = await page.locator('.detail-date-row .date-row-icon').evaluateAll((icons) => icons.map((icon) => {
    const rect = icon.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height), tag: icon.tagName.toLowerCase(), color: getComputedStyle(icon).color };
  }));
  assert.deepEqual(initialIconBoxes, [
    { width: 23, height: 18, tag: 'svg', color: 'rgb(71, 112, 243)' },
    { width: 23, height: 18, tag: 'svg', color: 'rgb(215, 84, 58)' },
    { width: 23, height: 18, tag: 'svg', color: 'rgb(111, 106, 99)' },
  ]);
  await page.locator('.detail-month-head button').nth(0).click();
  await page.locator('.detail-month-head button').nth(1).click();
  await page.locator('.detail-month-head button').nth(2).click();
  await page.locator('.detail-date-grid button').filter({ hasText: /^15$/ }).first().click();
  await page.locator('.detail-date-presets button[title="오늘"]').click();
  await page.locator('.detail-date-presets button[title="내일"]').click();
  await page.locator('.detail-date-presets button[title="다음 주"]').click();
  await page.locator('.detail-date-presets button[title="오늘 저녁"]').click();
  await page.locator('.detail-date-row[data-kind="time"]').click();
  await page.locator('.detail-date-segment button', { hasText: '날짜' }).click();
  await page.locator('.detail-date-row', { hasText: '정각에' }).click();
  await page.locator('.detail-date-row', { hasText: '반복' }).click();
  assert.match(await page.locator('.detail-date-row[data-kind="reminder"]').textContent(), /알림×/);
  assert.match(await page.locator('.detail-date-row[data-kind="repeat"]').textContent(), /매주×/);
  const activeIconBoxes = await page.locator('.detail-date-row .date-row-icon').evaluateAll((icons) => icons.map((icon) => {
    const rect = icon.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height), tag: icon.tagName.toLowerCase(), color: getComputedStyle(icon).color };
  }));
  assert.deepEqual(activeIconBoxes, [
    initialIconBoxes[0],
    { width: 23, height: 18, tag: 'svg', color: 'rgb(215, 84, 58)' },
    { width: 23, height: 18, tag: 'svg', color: 'rgb(215, 84, 58)' },
  ]);

  await page.getByRole('button', { name: '지속 시간' }).click();
  await page.locator('.duration-toggle').click();
  await page.locator('.detail-date-popover footer button').filter({ hasText: '삭제' }).click();
  await page.getByRole('button', { name: '확인' }).click();

  const patches = calls.filter((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-detail-flow').map((call) => call.body);
  const finalTask = state.tasks.find((task) => task.id === 'task-detail-flow') || {};

  assert.equal(patches.some((body) => body.list === '고객사' && body.category === '고객사' && body.project === '고객사'), true);
  assert.equal(patches.some((body) => body.date === TOMORROW && body.allDay === true && body.time === ''), true);
  assert.equal(patches.some((body) => body.date === NEXT_WEEK && body.allDay === true && body.time === ''), true);
  assert.equal(patches.some((body) => body.date === TODAY && body.allDay === false && body.time === '18:00'), true);
  assert.equal(patches.some((body) => body.reminder === 'at_time' && body.reminderAt === 'at_time'), true);
  assert.equal(patches.some((body) => body.repeat === 'weekly' && body.recurrence === 'weekly'), true);
  assert.equal(patches.some((body) => body.allDay === true && body.time === ''), true);
  assert.equal(finalTask.date, '');
  assert.equal(finalTask.time, '');
  assert.equal(finalTask.endDate, '');
  assert.equal(finalTask.endTime, '');
  assert.equal(finalTask.repeat, 'none');
  assert.equal(finalTask.allDay, false);
  assert.equal(finalTask.due, '');
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patches }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
