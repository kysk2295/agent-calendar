const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });

  await page.addInitScript(() => {
    const defaults = { notify: true, agentShare: true, weekStartMon: true };
    const authProfile = {
      provider: 'password',
      id: 'qa-user',
      email: 'qa@example.test',
      name: 'QA',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    const readPreferences = () => {
      try {
        return JSON.parse(localStorage.getItem('qa-ui-preferences') || '') || defaults;
      } catch {
        return defaults;
      }
    };
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        theme: 'default',
        authProfile,
        uiPreferences: readPreferences(),
      }),
      saveSettings: async (settings) => {
        const uiPreferences = settings.uiPreferences || readPreferences();
        localStorage.setItem('qa-ui-preferences', JSON.stringify(uiPreferences));
        localStorage.setItem('qa-settings-save-count', String(Number(localStorage.getItem('qa-settings-save-count') || 0) + 1));
        return {
          apiBaseUrl: '',
          hasApiToken: false,
          theme: settings.theme || 'default',
          authProfile,
          uiPreferences,
        };
      },
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
    };
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }

    if (request.method() === 'POST' && path === '/api/settings') {
      await route.fulfill({ json: { ok: true } });
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

  const firstSwitch = page.locator('.pref-box .switch').first();
  const before = await firstSwitch.getAttribute('data-active');
  await firstSwitch.click();
  await page.waitForFunction(() => Number(localStorage.getItem('qa-settings-save-count') || 0) === 1);

  const changed = await firstSwitch.getAttribute('data-active');
  assert.notEqual(changed, before);

  await page.reload();
  await page.locator('.profile').click();
  await page.waitForSelector('.settings-overlay');
  const reloaded = await page.locator('.pref-box .switch').first().getAttribute('data-active');

  assert.equal(reloaded, changed);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
