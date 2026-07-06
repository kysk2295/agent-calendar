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

const tasks = [
  {
    id: 'task-delegate-submit',
    title: '위임 실행 대상 작업',
    date: todayKey(),
    owner: 'Me',
    status: 'Planned',
    category: '기본함',
    project: '기본함',
    notes: '',
  },
];
const agents = [
  { id: 'default', name: 'default', displayName: 'Default Agent', status: 'ready' },
  { id: 'writer', name: 'writer', displayName: 'Writer Agent', status: 'ready', emoji: '✍️' },
];
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

    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-delegated-created', ...body } } });
      return;
    }
    if (method === 'POST' && path === '/api/missions/launch') {
      await route.fulfill({
        json: {
          ok: true,
          run: {
            id: 'run-delegate-submit',
            title: '위임 실행 런',
            goal: body.goal,
            agent: body.agentId,
            status: 'running',
          },
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks,
        events: [],
        agents,
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
  await page.locator('.task-row', { hasText: '위임 실행 대상 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');
  await page.locator('.detail-agent').click();
  await page.waitForSelector('.delegate-modal');
  await page.getByRole('button', { name: /Writer Agent/ }).click();
  await page.getByRole('button', { name: '위임하고 실행' }).click();
  await page.waitForSelector('.run-modal');

  const createTask = calls.find((call) => call.method === 'POST' && call.path === '/api/tasks');
  const launch = calls.find((call) => call.method === 'POST' && call.path === '/api/missions/launch');
  const runText = await page.locator('.run-modal').textContent();

  assert.equal(createTask?.body.owner, 'Agent');
  assert.equal(createTask?.body.status, 'Doing');
  assert.match(String(createTask?.body.title || ''), /위임 실행 대상 작업/);
  assert.equal(launch?.body.agentId, 'writer');
  assert.match(String(launch?.body.goal || ''), /위임 실행 대상 작업/);
  assert.match(runText || '', /위임 실행 런|위임 실행 대상 작업/);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createTask: createTask?.body, launch: launch?.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
