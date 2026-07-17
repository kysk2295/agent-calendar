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

    calls.push({ method: request.method(), path });
    if (request.method() === 'GET' && path === '/api/mail/messages') {
      await route.fulfill({ json: { ok: true, items: [] } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/inbox/commands') {
      await route.fulfill({
        json: {
          ok: true,
          items: [{
            id: 'chat:must-not-render',
            source: 'web',
            sourceLabel: 'Web chat',
            title: '메일로 보이면 안 되는 Web chat',
            text: '메일로 보이면 안 되는 Web chat',
          }],
        },
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
  await page.getByRole('button', { name: /메일함/ }).click();

  await page.getByText('연결된 메일이 없습니다.').waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.mail-item').count(), 0);
  assert.equal(await page.getByText(/메일로 보이면 안 되는 Web chat/).count(), 0);
  assert.equal(calls.some((call) => call.path === '/api/inbox/commands'), false);
  assert.equal(calls.some((call) => call.path === '/api/mail/messages'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, mailCalls: calls.filter((call) => call.path.includes('mail')) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
