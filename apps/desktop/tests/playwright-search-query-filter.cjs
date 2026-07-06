const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const tasks = [
  { id: 'task-alpha', title: 'Alpha invoice follow-up', date: '2026-07-04', status: 'Planned', owner: 'Me', category: '기본함', project: '기본함' },
  { id: 'task-beta', title: 'Beta launch prep', date: '2026-07-04', status: 'Planned', owner: 'Me', category: '기본함', project: '기본함' },
];

const docs = [
  { id: 'doc-alpha', path: 'wiki/alpha.md', title: 'Alpha research note', body: 'Alpha 문서 본문', kind: 'note', updatedAt: '2026-07-04' },
  { id: 'doc-beta', path: 'wiki/beta.md', title: 'Beta research note', body: 'Beta 문서 본문', kind: 'note', updatedAt: '2026-07-04' },
];

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
    if (request.method() === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/documents') {
      await route.fulfill({ json: { ok: true, documents: docs } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, documents: docs, notes: docs, graph: { nodes: [], edges: [] } } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks,
        events: [],
        agents: [],
        runs: [],
        documents: docs,
        notes: docs,
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
  await page.waitForSelector('.app-root');
  await page.locator('.sidebar-search').click();
  await page.waitForSelector('.search-screen');

  const input = page.locator('.search-screen input[placeholder*="검색"]');
  await input.fill('Alpha');
  await page.waitForFunction(() => !document.querySelector('.search-screen')?.textContent?.includes('Beta launch prep'));

  const screenText = await page.locator('.search-screen').textContent();
  assert.match(screenText || '', /Alpha invoice follow-up/);
  assert.match(screenText || '', /Alpha research note/);
  assert.doesNotMatch(screenText || '', /Beta launch prep/);
  assert.doesNotMatch(screenText || '', /Beta research note/);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
