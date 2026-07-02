const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5173/';
const calls = [];

const wiki = {
  notes: [
    { id: 'wiki-a', path: '2_wiki/uniport.md', title: 'UniPort 전략', excerpt: 'UniPort는 대학생 프로젝트를 운영하는 지식입니다.', content: 'UniPort 본문입니다.' },
    { id: 'wiki-b', path: '2_wiki/trading.md', title: '트레이딩 규칙', excerpt: '리스크와 포지션 규칙.', content: '트레이딩 본문입니다.' },
  ],
  graph: {
    viewBox: '0 0 960 620',
    groups: ['2_wiki'],
    nodes: [
      { id: '2_wiki/uniport.md', path: '2_wiki/uniport.md', title: 'UniPort 전략', label: 'UniPort 전략', group: '2_wiki', x: 180, y: 180, r: 9, linkCount: 3 },
      { id: '2_wiki/trading.md', path: '2_wiki/trading.md', title: '트레이딩 규칙', label: '트레이딩 규칙', group: '2_wiki', x: 340, y: 260, r: 8, linkCount: 2 },
    ],
    edges: [{ id: 'edge-a-b', from: '2_wiki/uniport.md', to: '2_wiki/trading.md' }],
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

    if (method === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], chatMessages: [], wikiIndex: wiki } });
      return;
    }
    if (method === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
      return;
    }
    if (method === 'POST' && path === '/api/wiki/ask') {
      await route.fulfill({ json: { ok: true, answer: `위키 답변: ${body.question}`, sources: [{ path: '2_wiki/uniport.md', title: 'UniPort 전략' }] } });
      return;
    }
    await route.fulfill({ json: { ok: true, data: {} } });
  });

  await page.goto(target);
  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-graph-controls');

  const graphGroup = page.locator('.wiki-graph-canvas svg g').first();
  const before = await graphGroup.getAttribute('transform');
  await page.getByRole('button', { name: '그래프 확대' }).click();
  const afterZoom = await graphGroup.getAttribute('transform');
  assert.notEqual(afterZoom, before);
  assert.match(afterZoom || '', /scale\(1\.18/);

  await page.locator('.askbar input').fill('UniPort 전략은?');
  await page.getByRole('button', { name: '질문' }).click();
  await page.waitForSelector('.wiki-answer');
  const answer = await page.locator('.wiki-answer').textContent();
  assert.match(answer || '', /위키 답변: UniPort 전략은\?/);
  assert.match(answer || '', /UniPort 전략/);
  assert.equal(calls.some((call) => call.method === 'POST' && call.path === '/api/wiki/ask'), true);

  await browser.close();
  console.log(JSON.stringify({ ok: true, before, afterZoom, wikiAsk: calls.find((call) => call.path === '/api/wiki/ask')?.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
