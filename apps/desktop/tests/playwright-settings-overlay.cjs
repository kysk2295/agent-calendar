const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

let uiPreferences = { notify: true, agentShare: true, weekStartMon: true };
let theme = 'default';
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

    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method: request.method(), path, body });
    if (request.method() === 'POST' && path === '/api/settings') {
      if (body.uiPreferences) uiPreferences = { ...uiPreferences, ...body.uiPreferences };
      if (body.theme) theme = body.theme;
      await route.fulfill({ json: { ok: true, settings: { theme, uiPreferences }, theme, uiPreferences } });
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
        settings: { theme, uiPreferences },
        theme,
        uiPreferences,
      },
    });
  });

  await page.goto(target);
  await page.waitForSelector('.profile');
  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');

  await page.getByTestId('settings-nav-theme').click();
  await page.locator('.settings-theme-list button', { hasText: 'Sage' }).click();
  await page.waitForFunction(() => document.querySelector('.app-root')?.getAttribute('data-theme') === 'sage');
  const sageActive = await page.locator('.settings-theme-list button[data-active="true"]', { hasText: 'Sage' }).count();

  const firstSwitch = page.locator('.pref-box .switch').first();
  const beforePref = await firstSwitch.getAttribute('data-active');
  await firstSwitch.click();
  await page.waitForFunction((before) => document.querySelector('.pref-box .switch')?.getAttribute('data-active') !== before, beforePref);

  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.waitForSelector('.login.screen-in');
  await page.locator('.login.screen-in input[type="email"]').fill('yunseo@agent.calendar');
  await page.locator('.login.screen-in input[type="password"]').fill('pw');
  await page.locator('.login.screen-in .login-submit').click();
  await page.waitForFunction(() => !document.querySelector('.login.screen-in'));

  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');
  await page.getByRole('button', { name: '완료' }).click();
  await page.waitForFunction(() => !document.querySelector('.settings-overlay'));

  assert.equal(sageActive, 1);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/settings' && call.body.theme === 'sage'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/settings' && call.body.uiPreferences), true);
  assert.equal(await page.locator('.settings-overlay').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, settingsCalls: calls.filter((call) => call.path === '/api/settings') }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
