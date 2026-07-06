const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const journalSummary = {
  id: 'journal-2026-07-03',
  path: '4_journal/2026-06-25-railway-smoke-test.md',
  title: '2026-06-25-railway-smoke-test',
  folder: '4_journal',
  updatedAt: '2026-06-25T06:00:13.000Z',
  createdAt: '2026-06-25T06:00:13.000Z',
  bytes: 408,
  excerpt: '목록에 있는 짧은 요약입니다.',
};
const journalDetail = {
  ...journalSummary,
  content: [
    '---',
    'date: 2026-06-25',
    'tags: [스모크테스트, railway]',
    '---',
    '',
    '😊 상세 API에서 불러온 4_journal 전체 본문입니다.',
  ].join('\n'),
};

const wiki = {
  notes: [journalSummary],
  graph: {
    viewBox: '0 0 960 620',
    groups: ['4_journal'],
    nodes: [
      { id: journalSummary.path, path: journalSummary.path, title: journalSummary.title, label: journalSummary.title, group: '4_journal', x: 180, y: 180, r: 9, linkCount: 1 },
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
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], chatMessages: [], wikiIndex: wiki } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/documents') {
      await route.fulfill({ json: { ok: true, documents: [] } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      const selectedNote = url.searchParams.get('path') === journalSummary.path ? journalDetail : journalSummary;
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote } });
      return;
    }
    await route.fulfill({ json: { ok: true, data: {} } });
  });

  await page.goto(target);
  await page.getByRole('button', { name: /일기/ }).click();
  await page.waitForSelector('.diary-timeline');
  await page.waitForFunction(() => document.querySelector('.diary-timeline')?.textContent?.includes('상세 API에서 불러온 4_journal 전체 본문입니다'));

  const timelineText = await page.locator('.diary-timeline').textContent();
  assert.match(timelineText || '', /상세 API에서 불러온 4_journal 전체 본문입니다/);
  assert.doesNotMatch(timelineText || '', /date: 2026-06-25/);
  assert.match(timelineText || '', /6월 25일/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, source: journalSummary.path }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
