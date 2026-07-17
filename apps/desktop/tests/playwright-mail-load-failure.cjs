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
    if (request.method() === 'GET' && url.pathname === '/api/mail/messages') {
      await route.fulfill({ status: 503, json: { ok: false, error: 'mail_unavailable' } });
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

  await page.getByText('메일을 불러오지 못했습니다.').waitFor({ timeout: 5_000 });
  assert.equal(await page.getByText('연결된 메일이 없습니다.').count(), 0);
  assert.equal(await page.getByRole('button', { name: '메일 다시 불러오기' }).count(), 1);

  const stalePage = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  let mailReads = 0;
  await stalePage.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/mail/messages') {
      mailReads += 1;
      if (mailReads > 2) {
        await route.fulfill({ status: 503, json: { ok: false, error: 'mail_refresh_unavailable' } });
        return;
      }
      await route.fulfill({ json: { ok: true, items: [{ id: 'mail:stale', from: 'sender@example.com', subject: '보존할 기존 메일', text: '기존 내용', unread: true }] } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/mail/accounts') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/mail/sync') {
      await route.fulfill({ json: { ok: true, items: [{ id: 'mail:stale', from: 'sender@example.com', subject: '보존할 기존 메일', text: '기존 내용', unread: true }] } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [], events: [], agents: [], runs: [], documents: [], notes: [],
        graph: { nodes: [], edges: [] }, items: [], jobs: [], messages: [], channels: [], tools: [],
        settings: { uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await stalePage.goto(target);
  await stalePage.getByRole('button', { name: /메일함/ }).click();
  await stalePage.getByRole('heading', { name: '보존할 기존 메일' }).waitFor();
  await stalePage.getByPlaceholder('name@gmail.com').fill('owner@gmail.com');
  await stalePage.getByPlaceholder('Google 앱 비밀번호').fill('app-password');
  await stalePage.getByRole('button', { name: '연결 · 동기화' }).click();
  await stalePage.getByText('메일을 불러오지 못했습니다.').waitFor({ timeout: 5_000 });
  assert.equal(await stalePage.locator('.mail-item').filter({ hasText: '보존할 기존 메일' }).count(), 1);
  assert.equal(await stalePage.getByRole('button', { name: '메일 다시 불러오기' }).count(), 1);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
