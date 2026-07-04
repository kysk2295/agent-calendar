const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

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

    if (method === 'POST' && path === '/api/calendar/events') {
      await route.fulfill({
        status: 500,
        json: { ok: false, error: 'calendar create failed' },
      });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
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
  await page.waitForSelector('.day-cell[data-today="true"]');
  await page.locator('.day-cell[data-today="true"]').click();
  await page.waitForSelector('.new-task-popover');

  await page.locator('.new-task-title-row input').fill('실패해도 남는 작업');
  await page.locator('.new-task-desc').fill('저장 실패 후에도 설명은 보존되어야 함');
  await page.getByLabel('할 일 추가').click();
  await page.locator('.new-task-check-row input:not([type])').fill('보존할 체크 항목');
  await page.getByLabel('작업 만들기').click();

  await page.waitForSelector('.api-banner');
  assert.equal(await page.locator('.new-task-popover').count(), 1);
  assert.equal(await page.locator('.new-task-title-row input').inputValue(), '실패해도 남는 작업');
  assert.equal(await page.locator('.new-task-desc').inputValue(), '저장 실패 후에도 설명은 보존되어야 함');
  assert.equal(await page.locator('.new-task-check-row input:not([type])').inputValue(), '보존할 체크 항목');

  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/calendar/events');
  assert.equal(Boolean(createCall), true);
  assert.match(await page.locator('.api-banner').textContent(), /Agents Calendar API 500 \/api\/calendar\/events/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createTask: createCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
