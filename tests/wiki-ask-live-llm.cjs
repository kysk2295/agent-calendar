const assert = require('node:assert/strict');

const endpoint = String(process.env.WIKI_ASK_ENDPOINT || 'http://127.0.0.1:8642/api/wiki/ask');
const iterations = Number(process.env.HERMES_LIVE_WIKI_ASK_ITERATIONS || 3);
const token = process.env.HERMES_API_TOKEN || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';

function answerFrom(payload) {
  return String(payload.answer || payload.text || payload.data?.answer || payload.data?.text || '');
}

function sourcesFrom(payload) {
  const sources = payload.sources || payload.citations || payload.data?.sources || payload.data?.citations || [];
  return Array.isArray(sources) ? sources : [];
}

function assertLiveLlmAnswer(payload, answer) {
  const provider = payload.engine?.provider || payload.llm?.provider;
  assert.ok(answer.length >= 80, 'live answer should contain a substantial LLM/wiki response');
  assert.notEqual(payload.gatewayFallback, true, 'live wiki ask should use the LLM path, not gatewayFallback');
  assert.notEqual(provider, 'none', 'live wiki ask should report a real provider');
  assert.ok(provider, 'live wiki ask should include engine.provider or llm.provider');
  assert.doesNotMatch(answer, /백엔드 위키 답변 본문이 비어 있습니다/);
  assert.doesNotMatch(answer, /위키 답변 실패/);
  assert.doesNotMatch(answer, /undefined|null|\[object Object\]/i);
}

async function askLive(index) {
  const marker = `LIVE_WIKI_LLM_CHECK_${Date.now()}_${index}`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      question: `${marker} 위키가 실제 LLM 답변처럼 자연스럽게 답하는지 확인해줘`,
      limit: 8,
      includeJournal: process.env.INCLUDE_JOURNAL === '1',
      includeRaw: process.env.INCLUDE_RAW === '1',
      mode: 'smart',
    }),
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  const answer = answerFrom(payload);
  const sources = sourcesFrom(payload);

  assert.equal(response.ok, true, `live wiki ask failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
  assertLiveLlmAnswer(payload, answer);

  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    answerLength: answer.length,
    answerPreview: answer.slice(0, 220),
    sourceCount: sources.length,
    engine: payload.engine,
    llm: payload.llm,
    gatewayFallback: payload.gatewayFallback,
    topLevelKeys: Object.keys(payload),
  };
}

async function main() {
  assert.ok(Number.isInteger(iterations) && iterations > 0, 'HERMES_LIVE_WIKI_ASK_ITERATIONS must be a positive integer');
  const results = [];
  for (let index = 0; index < iterations; index += 1) {
    results.push(await askLive(index));
  }
  const avgElapsedMs = Math.round(results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length);
  const minAnswerLength = Math.min(...results.map((result) => result.answerLength));
  const maxAnswerLength = Math.max(...results.map((result) => result.answerLength));
  console.log(JSON.stringify({
    ok: true,
    live: true,
    endpoint,
    iterations,
    avgElapsedMs,
    minAnswerLength,
    maxAnswerLength,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
