const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const inbox = [
  { id: 'mail-surface-first', subject: '메일 표면 첫 번째', title: '메일 표면 첫 번째', from: 'Alpha', email: 'alpha@example.com', body: '첫 번째 본문', unread: true },
  { id: 'mail-surface-second', subject: '메일 표면 선택 대상', title: '메일 표면 선택 대상', from: 'Beta', email: 'beta@example.com', body: '선택 대상 본문', unread: false },
];

const calls = [];

async function main() {
  const artifactDir = path.resolve(__dirname, '../test-results/phase10-mail-read-only');
  fs.mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await page.addInitScript(() => {
    const releaseStatus = {
      supported: false,
      phase: 'unsupported',
      currentVersion: '0.1.0',
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      message: '테스트 환경',
    };
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        hasSession: true,
        theme: 'default',
        authProfile: {
          provider: 'authkit',
          id: 'phase10-mail-user',
          email: 'mail@example.test',
          name: 'Mail QA',
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
        session: {
          signedIn: true,
          workspaceId: 'workspace-phase10-mail',
          userId: 'phase10-mail-user',
          role: 'owner',
        },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getSessionStatus: async () => ({
        signedIn: true,
        sessionId: 'session-phase10-mail',
        userId: 'phase10-mail-user',
        workspaceId: 'workspace-phase10-mail',
        role: 'owner',
        email: 'mail@example.test',
        displayName: 'Mail QA',
        accessExpiresAt: null,
      }),
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
      getDesktopReleaseStatus: async () => releaseStatus,
      consumeDesktopRecoveryStatus: async () => ({
        phase: 'none',
        crashCount: 0,
        reason: null,
        occurredAt: null,
        message: '',
      }),
      onDesktopReleaseStatus: () => () => {},
      onAuthSessionChanged: () => () => {},
      onAuthLoginError: () => () => {},
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

    const method = request.method();
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/api/mail/messages') {
      await route.fulfill({ json: { ok: true, items: inbox, commands: inbox } });
      return;
    }
    if (method === 'POST' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, task: { id: 'task-from-mail', ...body } } });
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
        settings: { onboarding: { status: 'dismissed' }, uiPreferences: { notify: true, agentShare: true, weekStartMon: true } },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      },
    });
  });

  await page.goto(target);
  await page.locator('.nav-item', { hasText: '메일함' }).evaluate((element) => element.click());
  await page.waitForSelector('.mail-item');

  assert.match(await page.locator('.mail-list header').textContent(), /1 안 읽음/);
  await page.locator('.mail-item', { hasText: '메일 표면 선택 대상' }).click();
  assert.match(await page.locator('.mail-reader').textContent(), /메일 표면 선택 대상/);
  assert.equal(await page.locator('.mail-item[data-active="true"]').textContent(), await page.locator('.mail-item', { hasText: '메일 표면 선택 대상' }).textContent());
  assert.match(await page.locator('.mail-connection-note').textContent(), /읽기 전용/);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '별표' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '보관', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(artifactDir, 'mail-read-only-surface.png'), fullPage: true });

  const mailReadsBeforeRefresh = calls.filter((call) => call.method === 'GET' && call.path === '/api/mail/messages').length;
  await page.locator('.mail-list header button').click();
  await page.waitForFunction(
    (count) => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/mail/messages')).length >= count,
    mailReadsBeforeRefresh,
  ).catch(() => {});
  await page.waitForTimeout(100);

  await page.getByRole('button', { name: /작업으로 추가/ }).click();
  await page.waitForFunction(() => document.querySelector('.mail-actions')?.textContent?.includes('기본함에 추가됨'));
  await page.getByRole('button', { name: /에이전트에 위임/ }).click();
  await page.waitForSelector('.delegate-modal');
  await page.getByRole('button', { name: '취소' }).click();
  await page.getByRole('button', { name: /답장 초안/ }).click();
  await page.waitForSelector('.delegate-modal');
  const replyText = await page.locator('.delegate-modal textarea').inputValue();
  await page.screenshot({ path: path.join(artifactDir, 'mail-delegation.png'), fullPage: true });
  await page.getByRole('button', { name: '취소' }).click();

  assert.match(replyText, /답장 초안/);
  assert.equal(calls.filter((call) => call.method === 'GET' && call.path === '/api/mail/messages').length > mailReadsBeforeRefresh, true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/tasks' && call.body.source === 'desktop-mail' && call.body.sourceMailId === 'mail-surface-second'), true);
  assert.equal(calls.some((call) => call.path === '/api/mail/accounts'), false);
  assert.equal(calls.some((call) => call.path === '/api/mail/sync'), false);
  assert.equal(calls.some((call) => call.path.startsWith('/api/mail/messages/')), false);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({
    ok: true,
    artifactDir,
    mailReads: calls.filter((call) => call.method === 'GET' && call.path === '/api/mail/messages').length,
    postCalls: calls.filter((call) => call.method === 'POST').map((call) => call.path),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
