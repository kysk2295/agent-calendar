const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const inbox = [
  {
    id: 'mail-action-1',
    subject: '메일 버튼 감사',
    title: '메일 버튼 감사',
    from: 'Agent Calendar',
    email: 'agent@example.com',
    body: '작업 추가, 위임, 답장, 보관 버튼을 검증합니다.',
    unread: true,
    star: false,
    createdAt: '2026-07-04T09:00:00.000Z',
  },
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
    if (method === 'POST' && path === '/api/mail/messages/mail-action-1/star') {
      inbox[0].star = true;
      await route.fulfill({ json: { ok: true, item: inbox[0] } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/messages/mail-action-1/task') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-from-mail', title: body.message || inbox[0].subject } } });
      return;
    }
    if (method === 'POST' && path === '/api/mail/messages/mail-action-1/archive') {
      inbox.splice(0, inbox.length);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (method === 'POST' && path === '/api/missions/launch') {
      await route.fulfill({ json: { ok: true, run: { id: 'run-mail-delegate', goal: body.goal, agent: body.agentId || 'default', status: 'running' } } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-agent-mail', title: body.title || body.goal || '메일 위임' } } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [{ id: 'default', name: 'default', displayName: 'Default Hermes', status: 'ready' }],
        runs: [],
        documents: [],
        notes: [],
        graph: { nodes: [], edges: [] },
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
  await page.locator('.nav-item').filter({ hasText: '메일함' }).click();
  await page.waitForSelector('.mail-item');
  await page.locator('.mail-item').first().click();

  const star = page.getByRole('button', { name: '별표' });
  await star.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="별표"]')?.textContent?.includes('★'));

  await page.getByRole('button', { name: /작업으로 추가/ }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /에이전트에 위임/ }).click();
  await page.waitForSelector('.delegate-modal');
  await page.getByRole('button', { name: '취소' }).click();
  await page.getByRole('button', { name: /답장 초안/ }).click();
  await page.waitForSelector('.delegate-modal');
  const replyText = await page.locator('.delegate-modal textarea').inputValue();
  await page.getByRole('button', { name: '취소' }).click();

  const beforeArchive = await page.locator('.mail-item').count();
  await page.getByRole('button', { name: '보관', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.mail-item'));

  assert.equal(beforeArchive, 1);
  assert.match(replyText, /답장 초안/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/star')), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/task')), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/archive')), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, actions: calls.filter((call) => call.method === 'POST').map((call) => call.path) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
