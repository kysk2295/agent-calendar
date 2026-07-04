const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

const pastDiary = {
  id: 'past-diary-surface',
  path: '4_journal/2026-07-03-surface.md',
  title: '일기 · 2026-07-03',
  kind: 'diary',
  folder: '4_journal',
  date: '2026-07-03',
  body: '😌 어제의 표면 테스트 일기 본문',
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

    const method = request.method();
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method, path, body });

    if (method === 'POST' && path === '/api/documents') {
      await route.fulfill({ json: { ok: true, document: { id: 'saved-diary-surface', path: '4_journal/2026-07-04-surface.md', ...body } } });
      return;
    }
    if (method === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, notes: [pastDiary], documents: [pastDiary], graph: { nodes: [], edges: [] }, selectedNote: pastDiary } });
      return;
    }

    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [],
        runs: [],
        documents: [pastDiary],
        chatMessages: [],
        notes: [pastDiary],
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
  await page.getByRole('button', { name: /일기/ }).click();
  await page.waitForSelector('.diary-card');

  await page.locator('.diary-moods').getByRole('button', { name: '🤔' }).click();
  assert.equal(await page.locator('.diary-moods button[data-active="true"]').textContent(), '🤔');
  await page.locator('.diary-moods').getByRole('button', { name: '🤔' }).click();
  assert.equal(await page.locator('.diary-moods button[data-active="true"]').count(), 0);
  await page.locator('.diary-moods').getByRole('button', { name: '😊' }).click();

  await page.locator('.diary-card textarea').fill('오늘의 표면 테스트 일기');
  await page.locator('.diary-prompts').getByRole('button', { name: /\+ 무엇을 배웠나\?/ }).click();
  assert.match(await page.locator('.diary-card textarea').inputValue(), /무엇을 배웠나/);

  await page.getByRole('button', { name: '위키에 저장' }).click();
  await page.waitForFunction(() => document.querySelector('.diary-card textarea')?.value === '');
  assert.equal(await page.locator('.diary-moods button[data-active="true"]').count(), 0);

  const saveCall = calls.find((call) => call.method === 'POST' && call.path === '/api/documents');
  assert.equal(Boolean(saveCall), true);
  assert.equal(saveCall.body.kind, 'diary');
  assert.match(saveCall.body.body, /^😊 오늘의 표면 테스트 일기/);
  assert.match(saveCall.body.body, /무엇을 배웠나/);

  await page.locator('.diary-timeline button', { hasText: '어제의 표면 테스트 일기 본문' }).click();
  assert.equal(await page.locator('.diary-card textarea').inputValue(), '어제의 표면 테스트 일기 본문');

  await browser.close();
  console.log(JSON.stringify({ ok: true, savedBody: saveCall.body.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
