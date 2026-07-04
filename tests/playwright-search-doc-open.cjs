const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const docs = [
  {
    id: 'doc-search-open',
    path: 'wiki/search-open.md',
    title: 'Search result document',
    body: '검색 결과 문서 본문입니다.',
    kind: 'note',
    tags: ['search'],
    updatedAt: '2026-07-04',
  },
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
        tasks: [],
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
  await page.locator('.search-group', { hasText: '노트 · 위키' }).getByRole('button', { name: /Search result document/ }).click();
  await page.waitForSelector('.wiki-reader', { timeout: 3000 });

  const result = await page.evaluate(() => ({
    heading: document.querySelector('.screen-heading strong')?.textContent?.trim() || '',
    activeNav: Array.from(document.querySelectorAll('.nav-item[data-active="true"]')).map((node) => node.textContent?.replace(/\s+/g, ' ').trim()),
    reader: document.querySelector('.wiki-reader')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    apiBanner: document.querySelector('.api-banner')?.textContent?.trim() || '',
  }));

  assert.equal(result.heading, '위키');
  assert.equal(result.activeNav.some((text) => text?.includes('위키')), true);
  assert.match(result.reader, /Search result document/);
  assert.match(result.reader, /검색 결과 문서 본문입니다/);
  assert.equal(result.apiBanner, '');

  await browser.close();
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
