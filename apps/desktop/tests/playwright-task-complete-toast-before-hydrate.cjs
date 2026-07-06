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

const task = {
  id: 'task-complete-slow-hydrate',
  title: '느린 재조회 완료 토스트 작업',
  date: todayKey(),
  status: 'Planned',
  owner: 'Me',
  category: '기본함',
  project: '기본함',
  notes: '',
};

let patched = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    if (request.method() === 'PATCH' && path === '/api/tasks/task-complete-slow-hydrate') {
      patched = true;
      await route.fulfill({ json: { ok: true, task: { ...task, status: 'Done', done: true } } });
      return;
    }

    if (patched && (path === '/api/state' || path === '/api/tasks')) {
      await delay(1500);
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [patched ? { ...task, status: 'Done', done: true } : task],
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
  await page.locator('.nav-item', { hasText: '오늘' }).click();
  await page.waitForSelector('.plan-row');

  await page.locator('.plan-row', { hasText: '느린 재조회 완료 토스트 작업' }).locator('.check').click();
  await page.waitForSelector('.completion-toast', { timeout: 700 });

  assert.match(await page.locator('.completion-toast').textContent(), /느린 재조회 완료 토스트 작업/);
  assert.equal(patched, true);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
