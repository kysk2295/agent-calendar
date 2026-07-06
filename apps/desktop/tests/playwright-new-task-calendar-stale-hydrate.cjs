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
        json: { ok: true, event: { id: 'event-stale-new-task', title: body.title, date: body.date, startDate: body.startDate } },
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

  await page.locator('.new-task-title-row input').fill('재조회 전에는 닫히면 안 되는 새 작업');
  await page.locator('.new-task-desc').fill('캘린더 재조회가 늦으면 모달 입력을 보존해야 합니다.');
  await page.getByLabel('작업 만들기').click();

  await page.waitForSelector('.api-banner', { timeout: 15000 });
  assert.equal(await page.locator('.new-task-popover').count(), 1);
  assert.equal(await page.locator('.new-task-title-row input').inputValue(), '재조회 전에는 닫히면 안 되는 새 작업');
  assert.equal(await page.locator('.new-task-desc').inputValue(), '캘린더 재조회가 늦으면 모달 입력을 보존해야 합니다.');
  assert.equal(await page.getByRole('button', { name: /재조회 전에는 닫히면 안 되는 새 작업/ }).count(), 0);
  assert.match(await page.locator('.api-banner').textContent(), /생성한 일정을 캘린더에서 아직 확인하지 못했습니다/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/calendar/events'), true);
  assert.equal(calls.filter((call) => call.method === 'GET' && call.path === '/api/calendar/events').length >= 2, true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, eventCalls: calls.filter((call) => call.path === '/api/calendar/events').map((call) => call.method) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
