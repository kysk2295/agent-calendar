const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const target = process.env.HERMES_UI_URL || 'http://127.0.0.1:5174/';
const totalIterations = Number(process.env.AGENT_CALENDAR_AI_LIVE_ITERATIONS || 100);
const calendarIterations = Number(process.env.AGENT_CALENDAR_AI_LIVE_CALENDAR_ITERATIONS || Math.ceil(totalIterations / 2));
const wikiIterations = Number(process.env.AGENT_CALENDAR_AI_LIVE_WIKI_ITERATIONS || Math.floor(totalIterations / 2));
const reportDir = process.env.AGENT_CALENDAR_AI_LIVE_REPORT_DIR || path.resolve(__dirname, '../audit');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `calendar-wiki-ai-live-100-${stamp}.json`);

const apiCalls = [];
const results = [];
const failures = [];

function parseRequestBody(request) {
  try {
    return request.postData() ? JSON.parse(request.postData()) : {};
  } catch {
    return {};
  }
}

function parseSse(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((block) => {
      const event = block.split('\n').find((line) => line.startsWith('event:'))?.replace(/^event:\s*/, '').trim() || 'message';
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n').trim();
      if (!data) return null;
      try {
        return { event, data: JSON.parse(data) };
      } catch {
        return { event, data };
      }
    })
    .filter(Boolean);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function writeReport(extra = {}) {
  const assistantCalls = apiCalls.filter((call) => call.method === 'POST' && call.path === '/api/assistant/ask');
  const wikiSearchCalls = apiCalls.filter((call) => call.method === 'POST' && call.path === '/api/wiki/search');
  const wikiStreamCalls = apiCalls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream' && (call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki')));
  const nonWikiStreamCalls = apiCalls.filter((call) => call.method === 'POST' && call.path === '/api/chat/stream' && !(call.body.view === 'wiki' || String(call.body.agent || '').includes('wiki')));
  const report = {
    ok: failures.length === 0
      && results.filter((result) => result.kind === 'calendar').length === calendarIterations
      && results.filter((result) => result.kind === 'wiki').length === wikiIterations,
    mode: 'live-no-route-fulfill',
    target,
    requested: {
      totalIterations,
      calendarIterations,
      wikiIterations,
    },
    completed: {
      total: results.length,
      calendar: results.filter((result) => result.kind === 'calendar').length,
      wiki: results.filter((result) => result.kind === 'wiki').length,
    },
    apiCalls: {
      assistantAsk: assistantCalls.length,
      wikiSearch: wikiSearchCalls.length,
      wikiStream: wikiStreamCalls.length,
      nonWikiStream: nonWikiStreamCalls.length,
    },
    providerCounts: results.reduce((counts, result) => {
      const provider = result.llm?.provider || 'unknown';
      counts[provider] = (counts[provider] || 0) + 1;
      return counts;
    }, {}),
    failures,
    results,
    updatedAt: nowIso(),
    ...extra,
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

async function waitForAssistantAsk(page, action) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/assistant/ask' && response.request().method() === 'POST';
  }, { timeout: 180000 });
  await action();
  return responsePromise;
}

async function waitForWikiSearchAndStream(page, action) {
  const searchPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/wiki/search' && response.request().method() === 'POST';
  }, { timeout: 240000 });
  const streamPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    const body = parseRequestBody(response.request());
    return url.pathname === '/api/chat/stream'
      && response.request().method() === 'POST'
      && (body.view === 'wiki' || String(body.agent || '').includes('wiki'));
  }, { timeout: 300000 });
  await action();
  return {
    searchResponse: await searchPromise,
    streamResponse: await streamPromise,
  };
}

async function askCalendar(page, index) {
  const question = '이번 주 완료율을 한 문장으로 알려줘?';
  const startedAt = Date.now();
  const response = await waitForAssistantAsk(page, async () => {
    await page.locator('.chat textarea').fill(question);
    await page.getByRole('button', { name: '전송' }).click();
  });
  const payload = await safeJson(response);
  const answer = String(payload?.answer || payload?.text || '').trim();
  assert.equal(response.status(), 200);
  assert.equal(payload?.search?.strategy, 'backend-calendar-ai-rag');
  assert.ok(answer.length > 0, 'calendar answer must not be empty');
  await page.waitForFunction((needle) => {
    return (document.querySelector('.messages')?.textContent || '').includes(needle);
  }, answer.slice(0, Math.min(24, answer.length)), { timeout: 60000 });
  return {
    kind: 'calendar',
    index,
    question,
    status: response.status(),
    elapsedMs: Date.now() - startedAt,
    answerPreview: answer.slice(0, 220),
    llm: payload?.llm || null,
    search: payload?.search || null,
    sourceCount: Array.isArray(payload?.sources) ? payload.sources.length : 0,
  };
}

async function askWiki(page, index) {
  const question = 'UniPort 시스템구조를 한 문장으로 요약해줘';
  const startedAt = Date.now();
  const { searchResponse, streamResponse } = await waitForWikiSearchAndStream(page, async () => {
    await page.locator('.askbar input').fill(question);
    await page.getByRole('button', { name: '질문' }).click();
  });
  const searchPayload = await safeJson(searchResponse);
  let streamText = '';
  let streamBodyError = '';
  try {
    await page.waitForFunction((expectedCount) => {
      return (window.__liveApiBodies || []).filter((entry) => entry.path === '/api/chat/stream').length >= expectedCount;
    }, index + 1, { timeout: 60000 });
    const captured = await page.evaluate((expectedIndex) => {
      const entries = (window.__liveApiBodies || []).filter((entry) => entry.path === '/api/chat/stream');
      return entries[expectedIndex] || entries.at(-1) || null;
    }, index);
    streamText = captured?.text || '';
    streamBodyError = captured?.error || '';
  } catch (error) {
    try {
      streamText = await streamResponse.text();
    } catch (bodyError) {
      streamBodyError = bodyError.message || String(bodyError);
    }
  }
  const events = parseSse(streamText);
  const done = events.find((event) => event.event === 'done')?.data || events.at(-1)?.data || {};
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.askbar button')].find((entry) => entry.textContent?.includes('질문'));
    const answerNode = document.querySelector('.wiki-answer');
    return Boolean(button && answerNode && answerNode.textContent && answerNode.textContent.length > 20);
  }, null, { timeout: 60000 });
  const renderedAnswer = await page.locator('.wiki-answer').textContent().catch(() => '');
  const answer = String(done.text || searchPayload?.answer || renderedAnswer || '').trim();
  const sources = Array.isArray(done.sources) ? done.sources : (searchPayload?.sources || searchPayload?.results || []);
  assert.equal(searchResponse.status(), 200);
  assert.equal(streamResponse.status(), 200);
  assert.ok(sources.length > 0, 'wiki sources must not be empty');
  assert.ok(answer.length > 0, 'wiki answer must not be empty');
  return {
    kind: 'wiki',
    index,
    question,
    status: {
      search: searchResponse.status(),
      stream: streamResponse.status(),
    },
    elapsedMs: Date.now() - startedAt,
    answerPreview: answer.slice(0, 220),
    llm: done.llm || searchPayload?.llm || null,
    retrieval: done.retrieval || searchPayload?.retrieval || null,
    ...(streamBodyError ? { streamBodyError } : {}),
    sourceCount: sources.length,
    firstSource: sources[0] ? {
      path: sources[0].path,
      title: sources[0].title,
      score: sources[0].score,
    } : null,
  };
}

async function main() {
  assert.ok(Number.isInteger(totalIterations) && totalIterations > 0, 'AGENT_CALENDAR_AI_LIVE_ITERATIONS must be positive');
  assert.ok(Number.isInteger(calendarIterations) && calendarIterations >= 0, 'calendar iterations must be zero or positive');
  assert.ok(Number.isInteger(wikiIterations) && wikiIterations >= 0, 'wiki iterations must be zero or positive');
  await writeReport({ startedAt: nowIso() });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  await page.addInitScript(() => {
    window.__liveApiBodies = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const request = input instanceof Request ? input : null;
      const response = await originalFetch(input, init);
      try {
        const url = new URL(request?.url || String(input), window.location.href);
        const method = String(init.method || request?.method || 'GET').toUpperCase();
        if (method === 'POST' && url.pathname === '/api/chat/stream') {
          const clone = response.clone();
          clone.text()
            .then((text) => {
              window.__liveApiBodies.push({
                at: new Date().toISOString(),
                method,
                path: url.pathname,
                status: response.status,
                text,
              });
            })
            .catch((error) => {
              window.__liveApiBodies.push({
                at: new Date().toISOString(),
                method,
                path: url.pathname,
                status: response.status,
                text: '',
                error: error?.message || String(error),
              });
            });
        }
      } catch {
        // Keep the pass-through fetch behavior intact even if reporting fails.
      }
      return response;
    };
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    apiCalls.push({
      at: nowIso(),
      method: request.method(),
      path: url.pathname,
      body: parseRequestBody(request),
    });
  });

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-fab', { timeout: 30000 });
    await page.locator('.chat-fab').click();
    await page.waitForSelector('.chat');

    for (let index = 0; index < calendarIterations; index += 1) {
      try {
        results.push(await askCalendar(page, index));
      } catch (error) {
        failures.push({ kind: 'calendar', index, message: error.message || String(error), at: nowIso() });
        throw error;
      } finally {
        await writeReport();
      }
    }

    await page.getByRole('button', { name: /위키/ }).click();
    await page.waitForSelector('.wiki-graph-controls', { timeout: 30000 });

    for (let index = 0; index < wikiIterations; index += 1) {
      try {
        results.push(await askWiki(page, index));
      } catch (error) {
        failures.push({ kind: 'wiki', index, message: error.message || String(error), at: nowIso() });
        throw error;
      } finally {
        await writeReport();
      }
    }

    const report = await writeReport({ finishedAt: nowIso() });
    assert.equal(report.completed.calendar, calendarIterations);
    assert.equal(report.completed.wiki, wikiIterations);
    assert.equal(report.apiCalls.assistantAsk, calendarIterations);
    assert.equal(report.apiCalls.wikiSearch, wikiIterations);
    assert.equal(report.apiCalls.wikiStream, wikiIterations);
    assert.equal(report.apiCalls.nonWikiStream, 0);
    if (totalIterations >= 90) assert.ok(report.completed.total >= 90, 'expected around 100 completed live checks');
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  await writeReport({ failedAt: nowIso(), error: error.message || String(error) });
  console.error(error);
  console.error(`Partial report: ${reportPath}`);
  process.exit(1);
});
