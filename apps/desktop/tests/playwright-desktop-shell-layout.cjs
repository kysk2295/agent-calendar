const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

async function installDesktopFixture(page) {
  await page.addInitScript(() => {
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        theme: 'default',
        authProfile: {
          provider: 'password',
          id: 'desktop-shell-user',
          email: 'desktop@example.test',
          name: 'Desktop QA',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      saveSettings: async (settings) => settings,
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
    };
  });
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) {
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
        items: [],
        jobs: [],
        messages: [],
        channels: [],
        sessions: [],
        tools: [],
        taxonomy: [],
      },
    });
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 824 } });
    await installDesktopFixture(page);
    await page.goto(target);
    await page.locator('.app-root').waitFor();

    // Given: a narrow CSS viewport caused by zoom or browser preview.
    // When: the Agent Calendar shell is rendered.
    // Then: the desktop sidebar remains and no mobile navigation exists.
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(await page.locator('.mobile-navigation').count(), 0);
    const shell = await page.locator('.app-root').evaluate((element) => {
      const style = getComputedStyle(element);
      return { display: style.display, flexDirection: style.flexDirection };
    });
    assert.deepEqual(shell, { display: 'flex', flexDirection: 'row' });
    const calendar = await page.locator('.month-grid').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert.equal(calendar.scrollWidth <= calendar.clientWidth + 1, true);
    const [calendarBox, saturdayBox] = await Promise.all([
      page.locator('.month-grid').boundingBox(),
      page.locator('.weekday').last().boundingBox(),
    ]);
    assert.ok(calendarBox && saturdayBox);
    assert.equal(saturdayBox.x + saturdayBox.width <= calendarBox.x + calendarBox.width + 1, true);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ ok: true, viewport: '640x824', shell: 'desktop' }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
