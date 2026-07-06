const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const tasks = [
  { id: 'task-search-alpha', title: 'Alpha search task', date: '2026-07-04', status: 'Planned', owner: 'Me', category: '기본함', project: '기본함' },
];

const docs = [
  { id: 'wiki-alpha-surface', path: '2_wiki/alpha-surface.md', title: 'Alpha wiki surface', content: 'Alpha wiki reader body', folder: '2_wiki', kind: 'note', updatedAt: '2026-07-04' },
  { id: 'wiki-beta-surface', path: '2_wiki/beta-surface.md', title: 'Beta wiki surface', content: 'Beta wiki reader body', folder: '2_wiki', kind: 'note', updatedAt: '2026-07-04' },
];

const wiki = {
  notes: docs,
  graph: {
    viewBox: '0 0 960 620',
    groups: ['2_wiki'],
    nodes: [
      { id: '2_wiki/alpha-surface.md', path: '2_wiki/alpha-surface.md', title: 'Alpha wiki surface', label: 'Alpha wiki surface', group: '2_wiki', x: 180, y: 180, r: 10, linkCount: 4 },
      { id: '2_wiki/beta-surface.md', path: '2_wiki/beta-surface.md', title: 'Beta wiki surface', label: 'Beta wiki surface', group: '2_wiki', x: 360, y: 260, r: 10, linkCount: 4 },
    ],
    edges: [{ id: 'alpha-beta', from: '2_wiki/alpha-surface.md', to: '2_wiki/beta-surface.md' }],
  },
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
    if (request.method() === 'GET' && path === '/api/tasks') {
      await route.fulfill({ json: { ok: true, tasks } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/documents') {
      await route.fulfill({ json: { ok: true, documents: docs } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, documents: docs, notes: docs, graph: wiki.graph, selectedNote: docs[0] } });
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
        chatMessages: [],
        wikiIndex: wiki,
        notes: docs,
        graph: wiki.graph,
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
  await page.locator('.search-screen input[placeholder*="검색"]').fill('Alpha');
  await page.locator('.search-group', { hasText: '작업' }).getByRole('button', { name: /Alpha search task/ }).click();
  await page.waitForSelector('.detail-modal');
  assert.equal(await page.locator('.detail-title-input').inputValue(), 'Alpha search task');
  await page.locator('.detail-close').click();
  await page.waitForFunction(() => !document.querySelector('.detail-modal'));

  await page.locator('.sidebar-search').click();
  await page.waitForSelector('.search-screen');
  await page.locator('.search-screen input[placeholder*="검색"]').fill('Alpha');
  await page.locator('.search-group', { hasText: '노트 · 위키' }).getByRole('button', { name: /Alpha wiki surface/ }).click();
  await page.waitForSelector('.wiki-reader');
  assert.match(await page.locator('.wiki-reader').textContent() || '', /Alpha wiki reader body/);
  await page.locator('.wiki-reader header button').click();
  await page.waitForFunction(() => !document.querySelector('.wiki-reader'));

  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-graph-controls');
  await page.locator('.wiki-suggest button', { hasText: '트레이딩 규칙은?' }).click();
  assert.equal(await page.locator('.askbar input').inputValue(), '트레이딩 규칙은?');

  const viewport = page.locator('.wiki-graph-viewport');
  await page.getByRole('button', { name: '그래프 확대' }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform')?.includes('scale(1.18'));
  await page.getByRole('button', { name: '그래프 축소' }).click();
  await page.getByRole('button', { name: '그래프 위치 초기화' }).click();
  await page.waitForFunction(() => document.querySelector('.wiki-graph-viewport')?.getAttribute('transform') === 'translate(0 0) scale(1)');

  const svg = page.locator('.wiki-graph-svg');
  const box = await svg.boundingBox();
  assert.notEqual(box, null);
  const beforePan = await viewport.getAttribute('transform');
  await page.mouse.move(box.x + 260, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 340, box.y + 270);
  await page.mouse.up();
  const afterPan = await viewport.getAttribute('transform');
  assert.notEqual(afterPan, beforePan);

  await page.locator('.wiki-svg-node').nth(1).click();
  await page.waitForSelector('.wiki-reader');
  assert.match(await page.locator('.wiki-reader').textContent() || '', /Beta wiki reader body/);
  await page.locator('.wiki-reader header button').click();
  await page.waitForFunction(() => !document.querySelector('.wiki-reader'));

  await page.locator('.tree-group-toggle', { hasText: '2_wiki' }).click();
  await page.locator('.wiki-side input[placeholder*="검색"]').fill('Alpha');
  await page.locator('.wiki-side button', { hasText: 'Alpha wiki surface' }).click();
  await page.waitForSelector('.wiki-reader');
  assert.match(await page.locator('.wiki-reader').textContent() || '', /Alpha wiki reader body/);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
