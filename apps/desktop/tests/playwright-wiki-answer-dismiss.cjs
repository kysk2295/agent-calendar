const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';

const wiki = {
  notes: [
    { id: 'wiki-dismiss', path: '2_wiki/dismiss.md', title: 'Dismiss test note', content: '답변 닫기 테스트 본문입니다.' },
  ],
  graph: {
    nodes: [{ id: '2_wiki/dismiss.md', path: '2_wiki/dismiss.md', title: 'Dismiss test note', group: '2_wiki' }],
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
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/chat/stream') {
      await route.fulfill({
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          'event: delta',
          'data: {"text":"닫을 수 있는 위키 답변입니다."}',
          '',
          'event: done',
          'data: {"text":"닫을 수 있는 위키 답변입니다.","source":"railway-relay","gatewayFallback":false,"run":{"model":"wiki-curator","agent":"wikicurator"}}',
          '',
          '',
        ].join('\n'),
      });
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
  await page.waitForSelector('.wiki-graph-controls');

  await page.locator('.askbar input').fill('답변 닫기 테스트');
  await page.getByRole('button', { name: '질문' }).click();
  await page.waitForSelector('.wiki-answer');
  assert.match(await page.locator('.wiki-answer').textContent() || '', /닫을 수 있는 위키 답변입니다/);

  await page.locator('.wiki-answer button').click();
  await page.waitForFunction(() => !document.querySelector('.wiki-answer'));

  assert.equal(await page.locator('.wiki-answer').count(), 0);
  assert.equal(await page.locator('.askbar input').inputValue(), '');

  await browser.close();
  console.log(JSON.stringify({ ok: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
