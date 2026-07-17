const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

let inbox = [
  { id: 'mail-surface-first', subject: '메일 표면 첫 번째', title: '메일 표면 첫 번째', from: 'Alpha', email: 'alpha@example.com', body: '첫 번째 본문', unread: true },
  { id: 'mail-surface-second', subject: '메일 표면 선택 대상', title: '메일 표면 선택 대상', from: 'Beta', email: 'beta@example.com', body: '선택 대상 본문', unread: false },
];

const synced = [
  { id: 'mail-surface-synced', subject: '동기화된 메일', title: '동기화된 메일', from: 'Gmail', email: 'gmail@example.com', body: '동기화 본문', unread: true },
];

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

    if (method === 'GET' && path === '/api/mail/messages') {
      await route.fulfill({ json: { ok: true, items: inbox, commands: inbox } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/accounts') {
      await route.fulfill({ json: { ok: true, account: { id: 'gmail-account', email: body.email } } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/sync') {
      inbox = synced;
      await route.fulfill({ json: { ok: true, items: synced, imported: synced.length } });
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
        commands: inbox,
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
  await page.locator('.nav-item', { hasText: '메일함' }).click();
  await page.waitForSelector('.mail-item');

  assert.match(await page.locator('.mail-list header').textContent(), /1 안 읽음/);
  await page.locator('.mail-item', { hasText: '메일 표면 선택 대상' }).click();
  assert.match(await page.locator('.mail-reader').textContent(), /메일 표면 선택 대상/);
  assert.equal(await page.locator('.mail-item[data-active="true"]').textContent(), await page.locator('.mail-item', { hasText: '메일 표면 선택 대상' }).textContent());

  await page.locator('.mail-list header button').click();
  await page.waitForFunction(() => document.querySelector('.gmail-connect small')?.textContent?.includes('Gmail 주소와 앱 비밀번호'));
  const postsAfterEmptyRefresh = calls.filter((call) => call.method === 'POST').length;

  await page.locator('.gmail-connect input').first().fill('surface@gmail.com');
  await page.locator('.gmail-connect input').nth(1).fill('app-password');
  await page.locator('.mail-list header button').click();
  await page.waitForFunction(() => document.querySelector('.gmail-connect small')?.textContent?.includes('Gmail 동기화 완료'));
  await page.locator('.mail-item', { hasText: '동기화된 메일' }).waitFor();

  assert.equal(postsAfterEmptyRefresh, 0);
  assert.equal(await page.locator('.gmail-connect input').nth(1).inputValue(), '');
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/accounts' && call.body.email === 'surface@gmail.com'), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/mail/sync'), true);
  assert.match(await page.locator('.mail-reader').textContent(), /동기화된 메일/);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
