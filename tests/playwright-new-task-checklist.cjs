const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const calls = [];
const events = [];

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
      const event = { id: 'task-checklist', ...body };
      events.unshift(event);
      await route.fulfill({ json: { ok: true, event, events } });
      return;
    }
    if (method === 'GET' && path === '/api/calendar/events') {
      await route.fulfill({ json: { ok: true, events } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events,
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

  await page.locator('.new-task-title-row input').fill('체크리스트 저장 작업');
  await page.getByLabel('할 일 추가').click();
  await page.locator('.new-task-check-row input:not([type])').fill('완료된 하위 항목');
  await page.locator('.new-task-check-row input[type="checkbox"]').first().check();
  await page.getByLabel('할 일 추가').click();
  await page.locator('.new-task-check-row input:not([type])').nth(1).fill('남은 하위 항목');
  await page.getByLabel('작업 만들기').click();
  await page.waitForFunction(() => !document.querySelector('.new-task-popover'));

  const createCall = calls.find((call) => call.method === 'POST' && call.path === '/api/calendar/events');
  assert.equal(Boolean(createCall), true);
  assert.match(String(createCall.body.notes || ''), /- \[x\] 완료된 하위 항목/);
  assert.match(String(createCall.body.notes || ''), /- \[ \] 남은 하위 항목/);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, createTask: createCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
