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
const TOMORROW = addDaysKey(TODAY, 1);

const state = {
  tasks: [
    { id: 'task-inspector', title: 'Inspector tools task', date: TODAY, status: 'Planned', owner: 'Me', category: '기본함', project: '기본함', notes: '초기 메모' },
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

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'PATCH') {
      const id = decodeURIComponent(taskMatch[1]);
      state.tasks = state.tasks.map((task) => task.id === id ? { ...task, ...body } : task);
      await route.fulfill({ json: { ok: true, task: state.tasks.find((task) => task.id === id), data: { tasks: state.tasks } } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: state.tasks,
        events: [],
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
  await page.getByRole('button', { name: '📥 기본함' }).click();
  await page.waitForSelector('.task-inspector');

  await page.locator('.inspector-title').fill('Inspector renamed');
  await page.locator('.task-inspector textarea').click();
  await page.waitForTimeout(150);
  await page.locator('.task-inspector .flag').click();

  await page.getByRole('button', { name: /하위 할일 추가/ }).click();
  await page.locator('.inspector-tool-panel input').fill('하위 액션');
  await page.locator('.inspector-tool-panel').getByRole('button', { name: '추가', exact: true }).click();

  await page.locator('.task-inspector footer button').filter({ hasText: 'A' }).click();
  await page.getByRole('button', { name: '목록' }).click();

  await page.locator('.task-inspector footer button').filter({ hasText: '💬' }).click();
  await page.locator('.inspector-tool-panel input').fill('인스펙터 댓글');
  await page.locator('.inspector-tool-panel').getByRole('button', { name: '남기기', exact: true }).click();

  await page.locator('.task-inspector footer button').filter({ hasText: '⋯' }).click();
  await page.getByRole('button', { name: '내일로' }).click();
  await page.getByRole('button', { name: '매주 반복' }).click();
  await page.locator('.task-inspector .close').click();
  await page.waitForSelector('.task-inspector.empty');

  const patches = calls.filter((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-inspector');

  assert.equal(patches.some((call) => call.body.title === 'Inspector renamed'), true);
  assert.equal(patches.some((call) => call.body.priority === 'P1'), true);
  assert.equal(patches.some((call) => String(call.body.notes || '').includes('- [ ] 하위 액션')), true);
  assert.equal(patches.some((call) => String(call.body.notes || '').includes('- 항목')), true);
  assert.equal(patches.some((call) => String(call.body.notes || '').includes('[댓글] 인스펙터 댓글')), true);
  assert.equal(patches.some((call) => call.body.date === TOMORROW), true);
  assert.equal(patches.some((call) => call.body.repeat === 'weekly'), true);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, patchCount: patches.length, lastTask: state.tasks[0] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
