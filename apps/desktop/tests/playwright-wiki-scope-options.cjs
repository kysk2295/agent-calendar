const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

const wiki = {
  notes: [
    { id: 'wiki-scope', path: '2_wiki/scope.md', title: '위키 스코프', content: '스코프 테스트 본문입니다.' },
  ],
  graph: {
    nodes: [{ id: '2_wiki/scope.md', path: '2_wiki/scope.md', title: '위키 스코프', label: '위키 스코프', group: '2_wiki' }],
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

    const method = request.method();
    let body = {};
    try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = {}; }
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
      return;
    }
    if (method === 'POST' && path === '/api/wiki/search') {
      await route.fulfill({
        json: {
          ok: true,
          query: body.question,
          results: [{ path: '2_wiki/scope.md', title: '위키 스코프', heading: '스코프', snippet: '스코프 옵션이 켜진 상태로 질문했습니다.' }],
        },
      });
      return;
    }
    if (method === 'POST' && path === '/api/chat/stream') {
      await route.fulfill({
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          'event: delta',
          'data: {"text":"스코프 옵션이 켜진 상태로 질문했습니다."}',
          '',
          'event: done',
          'data: {"text":"스코프 옵션이 켜진 상태로 질문했습니다.","source":"railway-relay","gatewayFallback":false,"run":{"model":"wiki-curator"}}',
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
  await page.waitForSelector('.wiki-scope');

  await page.getByLabel('일기 포함').check();
  await page.getByLabel('raw 포함').check();
  await page.locator('.askbar input').fill('스코프 옵션 검증');
  await page.getByRole('button', { name: '질문' }).click();
  await page.waitForSelector('.wiki-answer');

  const searchCall = calls.find((call) => call.method === 'POST' && call.path === '/api/wiki/search');
  const streamCall = calls.find((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  const answer = await page.locator('.wiki-answer').textContent();

  assert.equal(Boolean(searchCall), false);
  assert.equal(Boolean(streamCall), true);
  assert.equal(streamCall.body.includeJournal, true);
  assert.equal(streamCall.body.includeRaw, true);
  assert.equal(streamCall.body.agent, 'wikicurator');
  assert.match(answer || '', /스코프 옵션/);
  assert.equal(await page.locator('.api-banner').count(), 0);

  await browser.close();
  console.log(JSON.stringify({ ok: true, wikiSearch: searchCall?.body, wikiStream: streamCall.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
