const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const dateKey = (offset = 0) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

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

  await page.locator('.new-date-chip').click();
  await page.locator('.new-accordion-row', { hasText: '시간' }).click();
  await page.waitForSelector('.date-time-menu');
  await page.locator('.date-time-menu button', { hasText: '오후 6:00' }).click();
  await page.waitForFunction(() => !document.querySelector('.date-time-menu'));

  await page.getByRole('button', { name: '지속 시간' }).click();

  await page.locator('.duration-grid input').nth(0).click();
  await page.waitForSelector('.duration-date-dialog');
  await page.locator('.new-segment button', { hasText: '지속 시간' }).click();
  await page.waitForFunction(() => !document.querySelector('.duration-date-dialog'));

  await page.locator('.duration-grid input').nth(0).click();
  await page.waitForSelector('.duration-date-dialog');
  await page.locator(`.duration-date-dialog button[data-date="${dateKey(1)}"]`).click();
  assert.equal(await page.locator('.duration-grid input').nth(0).inputValue(), dateKey(1));

  await page.locator('.duration-grid input').nth(2).click();
  await page.waitForSelector('.duration-date-dialog');
  await page.locator(`.duration-date-dialog button[data-date="${dateKey(2)}"]`).click();
  assert.equal(await page.locator('.duration-grid input').nth(2).inputValue(), dateKey(2));

  await page.locator('.duration-time-input').first().click();
  await page.waitForSelector('.duration-time-menu');
  await page.locator('.new-segment button', { hasText: '지속 시간' }).click();
  await page.waitForFunction(() => !document.querySelector('.duration-time-menu'));

  await page.locator('.duration-time-input').nth(1).click();
  await page.waitForSelector('.duration-time-menu');
  await page.locator('.duration-time-menu button', { hasText: '오후 8:00' }).click();
  await page.waitForFunction(() => !document.querySelector('.new-panel'));

  await page.locator('.new-date-chip').click();
  await page.waitForSelector('.new-panel');
  const popoverBox = await page.locator('.new-task-popover').boundingBox();
  assert.ok(popoverBox);
  await page.mouse.click(popoverBox.x + popoverBox.width - 48, popoverBox.y + popoverBox.height - 48);
  await page.waitForFunction(() => !document.querySelector('.new-panel'));

  await page.locator('.new-list-button').click();
  await page.waitForSelector('.new-list-panel');
  await page.locator('.new-task-title-row input').click();
  await page.waitForFunction(() => !document.querySelector('.new-list-panel'));

  await browser.close();
  console.log(JSON.stringify({ ok: true, startDate: dateKey(1), endDate: dateKey(2) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
