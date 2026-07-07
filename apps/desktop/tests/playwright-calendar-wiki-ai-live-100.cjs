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

const calendarQuestions = [
  '오늘 일정과 할 일을 근거 기반으로 자세히 요약하고 우선순위까지 제안해줘',
  '이번 주 일정과 할 일의 흐름을 자세히 분석해서 병목과 다음 액션을 알려줘',
  '유니포트 관련 일정과 할 일을 찾아서 오늘 무엇부터 해야 할지 자세히 제안해줘',
  '기한이 지났거나 임박한 할 일을 근거와 함께 자세히 정리해줘',
  '이번 주 완료율을 계산하고 그 숫자가 의미하는 바를 자세히 설명해줘',
  '오늘 처리하지 않으면 위험한 일정이나 할 일을 찾아서 이유를 자세히 말해줘',
  '최근 등록된 일정과 할 일을 묶어서 내 작업 패턴을 자세히 분석해줘',
  '병원 또는 개인 일정이 업무 일정에 미치는 영향을 자세히 정리해줘',
  '회의와 관련된 일정이나 할 일을 찾아서 준비해야 할 내용을 자세히 알려줘',
  '캘린더와 할 일 DB를 바탕으로 오늘의 현실적인 작업 순서를 자세히 짜줘',
  '이번 주 남은 일정 중 에너지를 많이 쓸 가능성이 높은 항목을 자세히 알려줘',
  '완료되지 않은 할 일들을 기준으로 지금 가장 먼저 줄여야 할 리스크를 자세히 설명해줘',
  '오늘 일정 중 시간 충돌이나 준비 부족 가능성이 있는 항목을 자세히 찾아줘',
  '유니포트 회의와 관련해서 내가 놓치면 안 되는 후속 액션을 자세히 정리해줘',
  '이번 주 일정과 할 일에서 반복해서 등장하는 주제를 자세히 분석해줘',
  '최근 캘린더 기록을 바탕으로 내가 실제로 집중하고 있는 프로젝트를 자세히 알려줘',
  '오늘의 할 일을 30분 단위로 나눌 수 있게 우선순위와 이유를 자세히 제안해줘',
  '미완료 작업을 기준으로 오늘 포기해도 되는 일과 꼭 해야 하는 일을 자세히 나눠줘',
  '일정과 할 일 기록에서 유니포트 개발 관련 작업만 뽑아 자세히 설명해줘',
  '이번 주 내 일정에서 외부 약속과 내부 작업의 균형을 자세히 평가해줘',
  '최근 일정과 할 일을 바탕으로 다음 회의 전에 준비할 자료를 자세히 추론해줘',
  '오늘 기준으로 가장 늦어지고 있는 작업을 찾아 근거와 함께 자세히 말해줘',
  '이번 주 기록에서 완료된 일과 남은 일을 비교해서 자세히 회고해줘',
  '내 일정 DB를 바탕으로 오늘 컨디션을 고려한 최소 실행 계획을 자세히 제안해줘',
  '할 일과 캘린더 이벤트를 함께 보고 중복되거나 연결된 항목을 자세히 찾아줘',
  '이번 주 프로젝트별 작업량을 근거 기반으로 자세히 비교해줘',
  '오늘의 일정과 할 일 중 유니포트 성과에 직접 연결되는 항목을 자세히 알려줘',
  '다가오는 일정에서 미리 준비하면 좋은 것들을 자세히 정리해줘',
  '이번 주 완료율이 낮다면 왜 낮은지 DB 근거로 자세히 설명해줘',
  '할 일 목록에서 실행 단위가 너무 큰 항목을 찾아 작게 쪼개서 자세히 제안해줘',
  '최근 작업 기록을 바탕으로 내가 미루고 있는 유형을 자세히 분석해줘',
  '오늘 일정에서 커뮤니케이션이 필요한 항목을 찾아 메시지 초안 수준으로 자세히 알려줘',
  '캘린더와 할 일을 함께 보고 이번 주 리스크 상위 3개를 자세히 정리해줘',
  '내 일정 DB를 바탕으로 지금 바로 할 수 있는 15분짜리 액션들을 자세히 추천해줘',
  '이번 주의 남은 할 일을 가치와 긴급도로 나눠 자세히 우선순위를 매겨줘',
  '최근 일정 중 반복되는 병원이나 개인 일정을 고려해 작업 계획을 자세히 조정해줘',
  '유니포트 관련 일정이 다른 일정과 충돌하는지 근거 기반으로 자세히 봐줘',
  '오늘 내가 결정해야 할 것과 실행해야 할 것을 구분해서 자세히 정리해줘',
  '일정과 할 일 기록에서 다음 개발 단계로 이어지는 신호를 자세히 찾아줘',
  '최근 완료한 일들을 바탕으로 이번 주 성과를 자세히 요약해줘',
  '미완료 일정과 할 일을 기준으로 오늘 저녁까지 끝내야 할 것을 자세히 골라줘',
  '이번 주 일정에서 준비 시간이 부족해 보이는 항목을 자세히 알려줘',
  '할 일 DB를 바탕으로 유니포트 회의 전 체크리스트를 자세히 만들어줘',
  '오늘 일정과 할 일을 보고 쉬는 시간까지 포함한 현실적인 계획을 자세히 세워줘',
  '최근 작업 기록에서 중요하지만 급하지 않은 일을 자세히 찾아줘',
  '이번 주 캘린더 이벤트 중 결과물을 남겨야 하는 항목을 자세히 정리해줘',
  '할 일과 일정 기록을 바탕으로 다음 24시간의 실행 전략을 자세히 제안해줘',
  '오늘 기준으로 내가 놓치고 있는 약속이나 후속 작업이 있는지 자세히 확인해줘',
  '이번 주 전체 맥락에서 가장 중요한 하나의 목표를 근거와 함께 자세히 제안해줘',
  '현재 일정과 할 일을 바탕으로 나에게 맞는 오늘의 작업 브리핑을 자세히 작성해줘',
];

const wikiQuestions = [
  'UniPort의 현재 시스템 구조를 근거 기반으로 자세히 설명하고 핵심 리스크를 알려줘',
  'UniPort에서 Hermes와 LLM 위키가 맡는 역할을 근거 기반으로 자세히 비교해줘',
  'UniPort 개발 반영 경로를 위키 근거로 자세히 정리하고 다음 액션을 제안해줘',
  'UniPort의 에이전트 구조가 왜 필요한지 위키 근거로 자세히 설명해줘',
  'UniPort 시스템 구조에서 Telegram과 Discord 채널의 역할을 자세히 설명해줘',
  'UniPort 교육 콘텐츠와 개발 자동화가 어떻게 연결되는지 근거 기반으로 자세히 말해줘',
  'UniPort 프로젝트의 현재 운영 구조를 한눈에 이해할 수 있게 자세히 요약해줘',
  'UniPort 위키 근거만 사용해서 가장 중요한 기술적 의존성을 자세히 알려줘',
  'UniPort의 Mac mini 운영 구조와 Railway 백엔드 관계를 자세히 설명해줘',
  'UniPort 시스템에서 LLM Wiki가 두뇌 역할을 하는 이유를 자세히 설명해줘',
  'UniPort의 개발 반영 자동화에서 실패 가능성이 큰 지점을 자세히 찾아줘',
  'UniPort 구조에서 사람, 팀, 에이전트, 위키가 어떻게 이어지는지 자세히 설명해줘',
  'UniPort 프로젝트가 현재 어떤 제품 방향을 갖고 있는지 위키 근거로 자세히 정리해줘',
  'UniPort 관련 문서에서 다음 개발 우선순위를 자세히 추론해줘',
  'UniPort 시스템 구조 문서의 핵심을 초보 개발자에게 설명하듯 자세히 풀어줘',
  'UniPort 운영에서 디스코드 @pm 봇이 필요한 이유를 근거 기반으로 자세히 설명해줘',
  'UniPort의 Railway 백엔드와 로컬 Mac mini runtime을 비교해서 자세히 설명해줘',
  'UniPort 위키에서 개발 반영까지 이어지는 흐름을 단계별로 자세히 정리해줘',
  'UniPort 구조에서 콘텐츠 수정과 프리뷰 검증이 어떻게 연결되는지 자세히 알려줘',
  'UniPort 시스템의 가장 취약한 운영 리스크를 위키 근거로 자세히 분석해줘',
  'UniPort를 처음 맡은 엔지니어에게 전달할 구조 브리핑을 자세히 작성해줘',
  'UniPort의 에이전트 기반 운영 방식이 기존 개발 방식과 어떻게 다른지 자세히 설명해줘',
  'UniPort 관련 위키에서 반복되는 키워드를 바탕으로 핵심 방향을 자세히 정리해줘',
  'UniPort 시스템 구조에서 자동화 가능한 부분과 사람이 봐야 하는 부분을 자세히 나눠줘',
  'UniPort 프로젝트의 현재 문서 체계를 근거 기반으로 자세히 설명해줘',
  'UniPort 개발에서 위키 검색 AI와 캘린더 AI가 섞이면 안 되는 이유를 자세히 설명해줘',
  'UniPort 시스템 구조를 제품, 운영, 개발 관점으로 나누어 자세히 정리해줘',
  'UniPort의 교육 콘텐츠 변경이 실제 앱 화면까지 반영되는 과정을 자세히 말해줘',
  'UniPort에서 검증 자동화가 필요한 이유와 기대 효과를 자세히 설명해줘',
  'UniPort 위키 근거로 지금 가장 먼저 정리해야 할 문서나 구조를 자세히 제안해줘',
  'UniPort 시스템 구조 문서에서 이해하기 어려운 부분을 찾아 자세히 풀어줘',
  'UniPort의 채널 라우팅 구조가 팀 운영에 주는 장점을 자세히 분석해줘',
  'UniPort와 Hermes OS의 관계를 위키 근거로 자세히 설명해줘',
  'UniPort 개발 반영 경로에서 백업과 이미지 반영이 왜 중요한지 자세히 말해줘',
  'UniPort 시스템을 유지보수할 때 모니터링해야 할 항목을 자세히 제안해줘',
  'UniPort 위키 근거로 다음 스프린트에서 확인해야 할 리스크를 자세히 정리해줘',
  'UniPort의 로컬 LLM/위키 기반 답변 구조가 왜 필요한지 자세히 설명해줘',
  'UniPort에서 사용자 질문이 위키 검색과 LLM 답변으로 이어지는 구조를 자세히 설명해줘',
  'UniPort 관련 위키에서 사업/제품 관점으로 중요한 내용을 자세히 뽑아줘',
  'UniPort 구조에서 자동 공유 dev-digest의 역할을 자세히 설명해줘',
  'UniPort 프로젝트를 안정적으로 운영하기 위한 체크리스트를 위키 근거로 자세히 만들어줘',
  'UniPort 시스템 구조의 핵심 컴포넌트를 의존성 순서로 자세히 정리해줘',
  'UniPort에서 프리뷰 이미지와 실제 앱 화면 검증이 연결되는 이유를 자세히 설명해줘',
  'UniPort 개발 자동화가 실패했을 때 원인 분리를 어떻게 해야 할지 자세히 제안해줘',
  'UniPort 위키 근거만으로 현재 구현 상태와 남은 과제를 자세히 구분해줘',
  'UniPort의 사람/팀/에이전트 협업 구조를 사례 중심으로 자세히 설명해줘',
  'UniPort 시스템 구조를 비개발자도 이해할 수 있게 자세히 풀어줘',
  'UniPort 운영 문서에서 Mac mini 원격 운영 정보가 중요한 이유를 자세히 설명해줘',
  'UniPort 프로젝트의 다음 의사결정에 필요한 근거를 위키에서 자세히 정리해줘',
  'UniPort 시스템 구조를 바탕으로 오늘 개발자가 해야 할 일을 자세히 제안해줘',
];

assert.equal(new Set(calendarQuestions).size, calendarQuestions.length);
assert.equal(new Set(wikiQuestions).size, wikiQuestions.length);

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

function compactLength(value) {
  return String(value || '').replace(/\s/g, '').length;
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
    answerModeCounts: results.reduce((counts, result) => {
      const mode = result.answerMode || 'unknown';
      counts[mode] = (counts[mode] || 0) + 1;
      return counts;
    }, {}),
    qualityMetrics: {
      calendar: {
        compactLengthAtLeast200: results.filter((result) => result.kind === 'calendar' && result.compactLength >= 200).length,
        noItemsContradictions: results.filter((result) => result.kind === 'calendar' && result.noItemsContradiction).length,
      },
      wiki: {
        compactLengthAtLeast200: results.filter((result) => result.kind === 'wiki' && result.compactLength >= 200).length,
        sourceCitationMentions: results.filter((result) => result.kind === 'wiki' && /\(출처:|\[\d+\]/.test(result.answer || '')).length,
      },
    },
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
  const question = calendarQuestions[index % calendarQuestions.length];
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
  assert.equal(payload?.llm?.provider, 'local-llm');
  assert.equal(payload?.llm?.used, true);
  assert.ok(payload?.answerMode, 'calendar answerMode must be present');
  assert.ok(Array.isArray(payload?.sources) && payload.sources.length > 0, 'calendar sources must not be empty');
  const sourceTypes = payload.sources.map((source) => String(source.sourceType || source.type || source.source || ''));
  assert.ok(sourceTypes.some((sourceType) => /task|calendar|event|ticktick|schedule/i.test(sourceType)), `calendar sources should include schedule/task records: ${sourceTypes.join(', ')}`);
  assert.ok(sourceTypes.every((sourceType) => sourceType !== 'chat-message' && !/wiki/i.test(sourceType)), `calendar sources should not include chat/wiki records: ${sourceTypes.join(', ')}`);
  const contradiction = /일정과\s*할\s*일이\s*(?:모두\s*)?없|일정\/할\s*일이\s*(?:모두\s*)?없|할\s*일이\s*(?:모두\s*)?없습니다/.test(answer);
  await page.waitForFunction((needle) => {
    return (document.querySelector('.messages')?.textContent || '').includes(needle);
  }, answer.slice(0, Math.min(24, answer.length)), { timeout: 60000 });
  return {
    kind: 'calendar',
    index,
    question,
    status: response.status(),
    elapsedMs: Date.now() - startedAt,
    answer,
    answerPreview: answer.slice(0, 220),
    answerMode: payload?.answerMode || 'unknown',
    compactLength: compactLength(answer),
    noItemsContradiction: contradiction,
    llm: payload?.llm || null,
    search: payload?.search || null,
    sourceCount: Array.isArray(payload?.sources) ? payload.sources.length : 0,
    sources: Array.isArray(payload?.sources) ? payload.sources.slice(0, 5).map((source) => ({
      id: source.id,
      title: source.title,
      date: source.date,
      sourceType: source.sourceType || source.type || source.source,
      done: source.done,
    })) : [],
  };
}

async function askWiki(page, index) {
  const question = wikiQuestions[index % wikiQuestions.length];
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
  assert.equal((done.llm || searchPayload?.llm || {})?.provider, 'local-llm');
  assert.equal((done.llm || searchPayload?.llm || {})?.used, true);
  assert.ok(done.answerMode || searchPayload?.answerMode, 'wiki answerMode must be present');
  return {
    kind: 'wiki',
    index,
    question,
    status: {
      search: searchResponse.status(),
      stream: streamResponse.status(),
    },
    elapsedMs: Date.now() - startedAt,
    answer,
    answerPreview: answer.slice(0, 220),
    answerMode: done.answerMode || searchPayload?.answerMode || 'unknown',
    compactLength: compactLength(answer),
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
