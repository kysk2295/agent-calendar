const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5174/';
const iterations = Number(process.env.AGENT_CALENDAR_AI_QA_ITERATIONS || 100);
const liveRounds = Number(process.env.AGENT_CALENDAR_AI_QA_LIVE_ROUNDS || 1);
const reportDir = process.env.AGENT_CALENDAR_AI_QA_REPORT_DIR || path.resolve(__dirname, '../audit');

const calls = [];
const live = {
  calendar: 0,
  wikiSearch: 0,
  wikiStream: 0,
};
const handled = {
  calendar: 0,
  wikiSearch: 0,
  wikiStream: 0,
};

const wiki = {
  notes: [
    { id: 'wiki-uniport', path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', excerpt: 'UniPort는 앱, 프리뷰, Railway 백엔드가 같은 콘텐츠 파일을 기준으로 연결됩니다.' },
    { id: 'wiki-hermes', path: '2_wiki/hermes-os-prd-v1.md', title: 'Hermes OS PRD', excerpt: 'Hermes OS의 위키 검색 AI는 캘린더 AI와 별도 경로로 동작합니다.' },
  ],
  graph: {
    viewBox: '0 0 960 620',
    groups: ['2_wiki'],
    nodes: [
      { id: '2_wiki/UniPort-시스템구조.md', path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', label: 'UniPort 시스템구조', group: '2_wiki', x: 220, y: 220, r: 8, linkCount: 2 },
      { id: '2_wiki/hermes-os-prd-v1.md', path: '2_wiki/hermes-os-prd-v1.md', title: 'Hermes OS PRD', label: 'Hermes OS PRD', group: '2_wiki', x: 420, y: 280, r: 7, linkCount: 1 },
    ],
    edges: [{ id: 'uniport-hermes', from: '2_wiki/UniPort-시스템구조.md', to: '2_wiki/hermes-os-prd-v1.md' }],
  },
};

function parseBody(request) {
  try {
    return request.postData() ? JSON.parse(request.postData()) : {};
  } catch {
    return {};
  }
}

async function routeApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const apiPath = url.pathname;
  if (!apiPath.startsWith('/api/')) {
    await route.continue();
    return;
  }

  const method = request.method();
  const body = parseBody(request);
  calls.push({ method, path: apiPath, body });

  if (method === 'POST' && apiPath === '/api/assistant/ask') {
    if (live.calendar < liveRounds) {
      live.calendar += 1;
      handled.calendar += 1;
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        answer: `CALENDAR_AI_STUB_${live.calendar}: 캘린더 AI는 /api/assistant/ask에서 DB 기반으로 답했습니다.`,
        llm: { provider: 'local-llm', model: 'qwen2.5:7b', used: true },
        search: { strategy: 'backend-calendar-ai-rag' },
      },
    });
    handled.calendar += 1;
    return;
  }

  if (method === 'POST' && apiPath === '/api/wiki/search') {
    if (live.wikiSearch < liveRounds) {
      live.wikiSearch += 1;
      handled.wikiSearch += 1;
      await route.continue();
      return;
    }
    const index = handled.wikiSearch;
    await route.fulfill({
      json: {
        ok: true,
        query: body.question,
        results: [
          { path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', excerpt: `WIKI_AI_STUB_${index}: UniPort 시스템구조 근거입니다.`, score: 0.91 },
        ],
        sources: [
          { path: '2_wiki/UniPort-시스템구조.md', title: 'UniPort 시스템구조', excerpt: `WIKI_AI_STUB_${index}: UniPort 시스템구조 근거입니다.`, score: 0.91 },
        ],
        llm: { provider: 'local-llm', model: 'qwen2.5:7b', used: true },
      },
    });
    handled.wikiSearch += 1;
    return;
  }

  if (method === 'POST' && apiPath === '/api/chat/stream' && (body.view === 'wiki' || String(body.agent || '').includes('wiki'))) {
    if (live.wikiStream < liveRounds) {
      live.wikiStream += 1;
      handled.wikiStream += 1;
      await route.continue();
      return;
    }
    const index = handled.wikiStream;
    const answer = `WIKI_AI_STUB_${index}: 위키 AI는 /api/wiki/search 결과를 바탕으로 /api/chat/stream에서 별도 답변을 생성했습니다.`;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: [
        'event: delta',
        `data: ${JSON.stringify({ text: answer, source: 'wiki-fallback', gatewayFallback: true, run: { model: 'qwen2.5:7b', agent: 'wiki-curator' } })}`,
        '',
        'event: done',
        `data: ${JSON.stringify({ ok: true, text: answer, sources: wiki.notes, llm: { provider: 'local-llm', model: 'qwen2.5:7b', used: true }, retrieval: { source: 'wiki-files', mode: 'rag', chunkCount: 1 }, source: 'wiki-fallback', gatewayFallback: true, run: { model: 'qwen2.5:7b', agent: 'wiki-curator' } })}`,
        '',
      ].join('\n'),
    });
    handled.wikiStream += 1;
    return;
  }

  if (method === 'GET' && apiPath === '/api/wiki' && handled.wikiSearch >= liveRounds) {
    await route.fulfill({ json: { ok: true, wikiIndex: wiki, notes: wiki.notes, graph: wiki.graph, selectedNote: wiki.notes[0] } });
    return;
  }

  await route.continue();
}

async function waitForCallCount(predicate, expected, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (calls.filter(predicate).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected} matching calls`);
}

async function sendCalendarQuestion(page, index) {
  const expectedCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/assistant/ask').length + 1;
  await page.locator('.chat textarea').fill(`CALENDAR_AI_${index} 이번 주 완료율?`);
  await page.getByRole('button', { name: '전송' }).click();
  await waitForCallCount((call) => call.method === 'POST' && call.path === '/api/assistant/ask', expectedCalls);
  await page.waitForFunction(() => {
    const messages = document.querySelector('.messages')?.textContent || '';
    return !messages.includes('응답 수신 중') && messages.length > 0;
  }, null, { timeout: 120000 });
}

async function sendWikiQuestion(page, index) {
  const expectedSearchCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/wiki/search').length + 1;
  const expectedStreamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream' && (call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki'))).length + 1;
  await page.locator('.askbar input').fill(`WIKI_AI_${index} UniPort 시스템구조 요약`);
  await page.getByRole('button', { name: '질문' }).click();
  await waitForCallCount((call) => call.method === 'POST' && call.path === '/api/wiki/search', expectedSearchCalls);
  await waitForCallCount((call) => call.method === 'POST' && call.path === '/api/chat/stream' && (call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki')), expectedStreamCalls);
  await page.waitForFunction(() => {
    const answer = document.querySelector('.wiki-answer')?.textContent || '';
    return !answer.includes('질문 중') && answer.length > 20;
  }, null, { timeout: 180000 });
}

async function main() {
  assert.ok(Number.isInteger(iterations) && iterations > 0, 'iterations must be positive');
  assert.ok(Number.isInteger(liveRounds) && liveRounds >= 0, 'live rounds must be zero or positive');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await page.route('**/*', routeApi);

  await page.goto(target);
  await page.waitForSelector('.chat-fab', { timeout: 30000 });
  await page.locator('.chat-fab').click();
  await page.waitForSelector('.chat');

  const calendarIterations = Math.ceil(iterations / 2);
  const wikiIterations = Math.floor(iterations / 2);
  for (let index = 0; index < calendarIterations; index += 1) {
    await sendCalendarQuestion(page, index);
  }

  await page.getByRole('button', { name: /위키/ }).click();
  await page.waitForSelector('.wiki-graph-controls', { timeout: 30000 });
  for (let index = 0; index < wikiIterations; index += 1) {
    await sendWikiQuestion(page, index);
  }

  const assistantCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/assistant/ask');
  const wikiSearchCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/wiki/search');
  const wikiStreamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream' && (call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki')));
  const nonWikiStreamCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream' && !(call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki')));

  assert.equal(assistantCalls.length, calendarIterations);
  assert.equal(wikiSearchCalls.length, wikiIterations);
  assert.equal(wikiStreamCalls.length, wikiIterations);
  assert.equal(nonWikiStreamCalls.length, 0);
  assert.equal(assistantCalls.some((call) => call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki')), false);
  assert.equal(wikiSearchCalls.some((call) => call.path === '/api/assistant/ask'), false);

  const report = {
    ok: true,
    target,
    iterations,
    liveRounds,
    calendarIterations,
    wikiIterations,
    calls: {
      assistantAsk: assistantCalls.length,
      wikiSearch: wikiSearchCalls.length,
      wikiStream: wikiStreamCalls.length,
      nonWikiStream: nonWikiStreamCalls.length,
    },
    livePassthrough: live,
    handled,
    samples: {
      assistant: assistantCalls.slice(0, 2).map((call) => call.body),
      wikiSearch: wikiSearchCalls.slice(0, 2).map((call) => call.body),
      wikiStream: wikiStreamCalls.slice(0, 2).map((call) => ({ view: call.body.view, agent: call.body.agent, mode: call.body.mode })),
    },
  };

  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `calendar-wiki-ai-100-${stamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await browser.close();
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
