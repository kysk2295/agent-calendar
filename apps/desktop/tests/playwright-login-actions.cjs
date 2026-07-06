const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
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
  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.waitForSelector('.login-overlay');

  await page.getByRole('button', { name: '비밀번호를 잊으셨나요?' }).click();
  await page.waitForSelector('.login-recovery');
  const recoveryText = await page.locator('.login-recovery').textContent();

  assert.equal(await page.getByRole('button', { name: /Apple로 계속하기/ }).count(), 0);
  await page.getByRole('button', { name: /Google로 계속하기/ }).click();
  await page.waitForFunction(() => !document.querySelector('.login-overlay'));
  assert.match(recoveryText || '', /복구 링크/);

  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.waitForSelector('.login-overlay');
  await page.getByRole('button', { name: /Google로 계속하기/ }).click();
  await page.waitForFunction(() => !document.querySelector('.login-overlay'));

  assert.equal(await page.locator('.api-banner').count(), 0);
  assert.equal(await page.locator('.login-overlay').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, recoveryText }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
