const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const state = {
  tasks: [
    {
      id: 'task-detail-reminder-fail',
      title: '상세 리마인더 실패 작업',
      date: '2026-07-04',
      time: '09:00',
      status: 'Planned',
      owner: 'Me',
      category: '기본함',
      project: '기본함',
      list: '기본함',
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

    if (method === 'PATCH' && path === '/api/tasks/task-detail-reminder-fail') {
      await route.fulfill({ status: 500, json: { ok: false, error: 'reminder patch failed' } });
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
  await page.waitForSelector('.task-row');

  await page.locator('.task-row', { hasText: '상세 리마인더 실패 작업' }).dblclick();
  await page.waitForSelector('.detail-modal');

  await page.locator('.detail-date-trigger').click();
  const reminderButton = page.locator('.detail-date-row', { hasText: '정각에' }).first();
  await reminderButton.click();

  await page.waitForSelector('.api-banner');
  const reminderState = await page.locator('.detail-date-row').filter({ hasText: /정각/ }).first().evaluate((node) => ({
    active: node.getAttribute('data-active'),
    text: node.textContent || '',
  }));

  assert.equal(reminderState.active, 'false');
  assert.match(reminderState.text, /정각에/);
  assert.doesNotMatch(reminderState.text, /켜짐/);
  assert.equal(calls.some((call) => call.method === 'PATCH' && call.path === '/api/tasks/task-detail-reminder-fail'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, reminderState, patchCalls: calls.filter((call) => call.method === 'PATCH') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
