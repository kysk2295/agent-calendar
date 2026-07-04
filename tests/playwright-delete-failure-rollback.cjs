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
    id: 'task-delete-fail',
    title: '삭제 실패 보존 작업',
    date: todayKey(),
    owner: 'Me',
    status: 'Planned',
    category: '기본함',
    project: '기본함',
    notes: '',
  },
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
    calls.push({ method, path });

    if (method === 'DELETE' && path === '/api/tasks/task-delete-fail') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'delete failed' } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks,
        events: [],
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
  await page.locator('.task-row', { hasText: '삭제 실패 보존 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');
  const [deleteResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/tasks/task-delete-fail') && response.request().method() === 'DELETE'),
    page.getByRole('button', { name: '삭제', exact: true }).click(),
  ]);
  await page.waitForTimeout(250);

  assert.equal(calls.some((call) => call.method === 'DELETE' && call.path === '/api/tasks/task-delete-fail'), true);
  assert.equal(deleteResponse.status(), 500);
  assert.equal(await page.locator('.detail-modal').count(), 1);
  assert.equal(await page.locator('.detail-title-input').inputValue(), '삭제 실패 보존 작업');
  assert.match(await page.locator('.detail-error').textContent(), /삭제 실패/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, deleteCalls: calls.filter((call) => call.method === 'DELETE') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
