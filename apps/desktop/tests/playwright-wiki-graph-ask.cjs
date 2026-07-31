const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL;
if (!target) throw new Error('HERMES_UI_URL is required; run this scenario through run-playwright-with-vite.cjs');
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

  await page.addInitScript(() => {
    window.hermesDesktop = {
      getSettings: async () => ({
        apiBaseUrl: '',
        hasApiToken: false,
        theme: 'default',
        authProfile: { provider: 'password', id: 'wiki-graph-user', email: 'wiki@example.test', name: 'Wiki QA' },
        uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
      }),
      getHermesConnection: async () => ({ baseUrl: '', credential: '' }),
      getSessionStatus: async () => ({ signedIn: true, sessionId: 'wiki-graph-session' }),
      getDesktopReleaseStatus: async () => ({ supported: false, phase: 'unsupported', currentVersion: '', availableVersion: null, progressPercent: null, checkedAt: null, message: '' }),
      consumeDesktopRecoveryStatus: async () => ({ phase: 'none', crashCount: 0, reason: null, occurredAt: null, message: '' }),
      onDesktopReleaseStatus: () => () => {},
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
    if (method === 'GET' && path === '/api/settings') {
      await route.fulfill({ json: { ok: true, onboarding: { status: 'completed' } } });
      return;
    }
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
    if (method === 'POST' && path === '/api/wiki/search') {
      await route.fulfill({ json: {
        ok: true,
        query: body.question,
        results: [{ path: '2_wiki/uniport.md', title: 'UniPort 전략', heading: '개요', snippet: 'UniPort는 대학생 프로젝트를 운영하는 지식입니다.' }],
      } });
      return;
    }
    if (method === 'POST' && path === '/api/chat/stream') {
      await route.fulfill({
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          'event: delta',
          `data: {"text":"기록을 보면 UniPort 전략은?는 UniPort 전략 문서와 연결됩니다."}`,
          '',
          'event: done',
          `data: {"text":"기록을 보면 UniPort 전략은?는 UniPort 전략 문서와 연결됩니다.","source":"railway-relay","gatewayFallback":false,"answerMode":"llm","sources":[{"path":"2_wiki/uniport-canonical.md","title":"UniPort 정본","excerpt":"큐레이터가 사용한 벡터 근거"}],"retrieval":{"embeddingModel":"bge-m3","mode":"vector-hybrid"},"llm":{"provider":"profile","agent":"wikicurator"},"run":{"model":"wiki-curator","agent":"wikicurator"}}`,
          '',
          '',
        ].join('\n'),
      });
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
  assert.match(answer || '', /기록을 보면 UniPort 전략은\?/);
  assert.match(answer || '', /UniPort 전략/);
  assert.match(answer || '', /wikicurator/);
  await page.getByRole('button', { name: '출처 열기: UniPort 정본' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '출처 열기: UniPort 전략' }).count(), 0);
  const searchCall = calls.find((call) => call.method === 'POST' && call.path === '/api/wiki/search');
  const streamCall = calls.find((call) => call.method === 'POST' && call.path === '/api/chat/stream');
  assert.equal(Boolean(searchCall), false);
  assert.equal(Boolean(streamCall), true);
  assert.equal(streamCall.body.includeJournal, false);
  assert.equal(streamCall.body.includeRaw, false);
  assert.equal(streamCall.body.agent, 'wikicurator');
  assert.equal(streamCall.body.message, 'UniPort 전략은?');
  assert.equal(streamCall.body.model, undefined);
  assert.doesNotMatch(JSON.stringify(streamCall.body), /SOURCES:/);

  await browser.close();
  console.log(JSON.stringify({ ok: true, before, afterZoom, wikiSearch: searchCall?.body, wikiStream: streamCall?.body }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
