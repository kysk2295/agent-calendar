const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const wiki = {
  notes: [
    { id: 'wiki-alpha-tree', path: '2_wiki/alpha-tree.md', title: 'Alpha tree note', content: 'Alpha tree body', folder: '2_wiki', kind: 'note' },
    { id: 'wiki-beta-tree', path: '2_wiki/beta-tree.md', title: 'Beta tree note', content: 'Beta tree body', folder: '2_wiki', kind: 'note' },
  ],
  graph: {
    nodes: [
      { id: '2_wiki/alpha-tree.md', path: '2_wiki/alpha-tree.md', title: 'Alpha tree note', label: 'Alpha tree note', group: '2_wiki' },
      { id: '2_wiki/beta-tree.md', path: '2_wiki/beta-tree.md', title: 'Beta tree note', label: 'Beta tree note', group: '2_wiki' },
    ],
    edges: [],
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
    if (request.method() === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: wiki.notes, chatMessages: [], wikiIndex: wiki } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        tasks: [],
        events: [],
        agents: [],
        runs: [],
        documents: wiki.notes,
        notes: wiki.notes,
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
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-side');

  await page.locator('.tree-group-toggle', { hasText: '2_wiki' }).click();
  await page.waitForSelector('.tree section[data-open="true"]');
  assert.match(await page.locator('.wiki-side').textContent(), /Beta tree note/);

  await page.locator('.wiki-side input[placeholder*="검색"]').fill('Alpha');
  await page.waitForFunction(() => !document.querySelector('.wiki-side')?.textContent?.includes('Beta tree note'));

  const treeText = await page.locator('.wiki-side').textContent();
  assert.match(treeText || '', /Alpha tree note/);
  assert.doesNotMatch(treeText || '', /Beta tree note/);

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
