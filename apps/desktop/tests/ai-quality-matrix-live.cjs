const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RAW_TRANSCRIPT = /(?:<task_data>|priorMissionEvidence|reportSchema|SYSTEM:\s*\{|\[redacted-command\]|stdout:|Write only the final requested output)/i;
const FAILURE_COPY = /(?:실시간 응답을 받지 못했습니다|잠시 후 다시 시도|답변 본문이 비어|runtime unavailable|curator_session_unavailable)/i;
const HARD_TIMEOUT_MS = 90_000;

function configuredSettings() {
  const settingsPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Agent Calendar', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const apiBaseUrl = String(settings.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const apiToken = String(settings.apiToken || '').trim();
  if (!apiBaseUrl || !apiToken) throw new Error('Configured Agent Calendar API credentials are required.');
  return { apiBaseUrl, apiToken };
}

function parseBlock(block) {
  const lines = block.split('\n');
  const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim() || 'message';
  const raw = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trimStart()).join('\n');
  if (!raw || raw === '[DONE]') return null;
  return { event, data: JSON.parse(raw) };
}

async function streamTurn(settings, body) {
  const startedAt = Date.now();
  const response = await fetch(`${settings.apiBaseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ requestId: randomUUID(), ...body }),
    signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
  });
  assert.equal(response.status, 200, `${body.view} stream returned ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.ok(response.body, `${body.view} stream returned no body`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const sources = new Map();
  let pending = '';
  let answer = '';
  let firstDeltaMs = null;
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let separator = pending.indexOf('\n\n');
    while (separator >= 0) {
      const parsed = parseBlock(pending.slice(0, separator));
      pending = pending.slice(separator + 2);
      separator = pending.indexOf('\n\n');
      if (!parsed) continue;
      events.push(parsed);
      if (parsed.event === 'error') throw new Error(String(parsed.data.error || `${body.view} stream error`));
      if (Array.isArray(parsed.data.sources)) {
        for (const source of parsed.data.sources) {
          const key = String(source.path || source.id || source.title || sources.size);
          sources.set(key, source);
        }
      }
      if (parsed.event === 'delta' && typeof parsed.data.text === 'string' && parsed.data.text) {
        if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt;
        answer += parsed.data.text;
      }
      if (parsed.event === 'done' && typeof parsed.data.text === 'string' && parsed.data.text) {
        answer = parsed.data.text;
      }
    }
    if (done) break;
  }
  if (pending.trim()) {
    const parsed = parseBlock(pending);
    if (parsed) events.push(parsed);
  }

  const compact = answer.replace(/\s+/gu, ' ').trim();
  assert.ok(compact.length >= 10, `${body.view} answer is too short to be a natural sentence: ${compact}`);
  assert.doesNotMatch(compact, RAW_TRANSCRIPT);
  assert.doesNotMatch(compact, FAILURE_COPY);
  assert.notEqual(firstDeltaMs, null, `${body.view} emitted no progressive answer delta`);
  return {
    view: body.view,
    question: body.message,
    answer: compact,
    firstDeltaMs,
    totalMs: Date.now() - startedAt,
    sources: [...sources.values()],
    metadata: events.map((entry) => entry.data).find((data) => data.llm?.agent || data.run?.agent || data.agent) || {},
  };
}

async function streamAgentWorkTurn(settings, workId, body) {
  const startedAt = Date.now();
  const response = await fetch(`${settings.apiBaseUrl}/api/agent-operations/work/${encodeURIComponent(workId)}/live`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
  });
  assert.equal(response.status, 200, `Agent Work stream returned ${response.status}`);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.ok(response.body, 'Agent Work stream returned no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let answer = '';
  let firstDeltaMs = null;
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let separator = pending.indexOf('\n\n');
    while (separator >= 0) {
      const parsed = parseBlock(pending.slice(0, separator));
      pending = pending.slice(separator + 2);
      separator = pending.indexOf('\n\n');
      if (!parsed) continue;
      if (parsed.event === 'error') throw new Error(String(parsed.data.message || parsed.data.error || 'Agent Work stream error'));
      if (parsed.event === 'delta' && typeof parsed.data.text === 'string' && parsed.data.text) {
        if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt;
        answer += parsed.data.text;
      }
      const checkpoint = parsed.data.checkpoint;
      if (parsed.event === 'checkpoint' && checkpoint?.kind === 'agent_message' && typeof checkpoint.text === 'string') {
        answer = checkpoint.text;
      }
    }
    if (done) break;
  }
  const compact = answer.replace(/\s+/gu, ' ').trim();
  assert.ok(compact.length >= 20, `Agent Work answer is too short: ${compact}`);
  assert.doesNotMatch(compact, RAW_TRANSCRIPT);
  assert.doesNotMatch(compact, FAILURE_COPY);
  assert.notEqual(firstDeltaMs, null, 'Agent Work emitted no progressive answer delta');
  return { view: 'agent-work', question: body.text || 'initial', answer: compact, firstDeltaMs, totalMs: Date.now() - startedAt, sources: [], metadata: { agent: 'default' } };
}

async function runAgentWorkCases(settings) {
  const nonce = `AC-MATRIX-${Date.now()}`;
  const objective = `실제 품질 검증입니다. ${nonce}를 그대로 포함하고 37 곱하기 19의 결과를 자연스러운 한국어 한 문장으로 답하세요.`;
  let workId = '';
  try {
    const response = await fetch(`${settings.apiBaseUrl}/api/agent-operations/work`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: randomUUID(),
        templateId: 'general-agent-work',
        title: `AI 품질 매트릭스 ${nonce}`,
        objective,
        initialMessage: objective,
        agentId: 'default',
        executionEngine: 'hermes',
        deliverable: { kind: 'report', format: 'markdown' },
      }),
      signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
    });
    assert.equal(response.status, 201, `Agent Work create returned ${response.status}`);
    const created = await response.json();
    workId = String(created.work?.id || '');
    assert.ok(workId, 'Agent Work create returned no work id');

    const initial = await streamAgentWorkTurn(settings, workId, { initial: true });
    assert.match(initial.answer, new RegExp(nonce));
    assert.match(initial.answer, /703/);
    const followUp = await streamAgentWorkTurn(settings, workId, {
      clientMessageId: randomUUID(),
      text: `방금 답변의 ${nonce}와 계산 결과를 유지하면서 더 간결한 한 문장으로 다듬어 주세요.`,
    });
    assert.match(followUp.answer, new RegExp(nonce));
    assert.match(followUp.answer, /703/);
    return [initial, followUp];
  } finally {
    if (workId) {
      const cleanupResponse = await fetch(`${settings.apiBaseUrl}/api/agent-operations/missions/${encodeURIComponent(workId)}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      assert.ok(cleanupResponse.ok, `Agent Work cleanup returned ${cleanupResponse.status}`);
    }
  }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

async function main() {
  const settings = configuredSettings();
  const cases = [
    {
      view: 'calendar',
      agent: 'default',
      agentId: 'default',
      message: '오늘(2026년 7월 18일) 등록된 일정과 할 일을 사실과 추정을 구분해 자연스러운 한국어로 알려줘.',
    },
    {
      view: 'calendar',
      agent: 'default',
      agentId: 'default',
      message: '방금 답변에서 가장 먼저 확인할 항목 하나와 그 이유만 한 문장으로 말해줘.',
    },
    {
      view: 'calendar',
      agent: 'default',
      agentId: 'default',
      message: '2099년 1월 1일 오후 3시에 등록된 화성 출장 일정이 실제로 있는지 확인해줘.',
    },
    {
      view: 'calendar',
      agent: 'default',
      agentId: 'default',
      message: '이번 주 일정과 할 일을 완료 여부와 함께 짧게 요약해줘.',
    },
    {
      view: 'calendar',
      agent: 'default',
      agentId: 'default',
      message: '다음 금요일 일정이라고 하면 어느 날짜 범위를 확인했는지 먼저 밝히고 답해줘.',
    },
    {
      view: 'wiki',
      agent: 'wikicurator',
      agentId: 'wikicurator',
      mode: 'wiki_qa_fast',
      limit: 8,
      includeJournal: false,
      includeRaw: false,
      message: 'UniPort BM 정본 기준으로 현재 수익 구조와 장기 확장 방향을 자연어로 설명해줘.',
    },
    {
      view: 'wiki',
      agent: 'wikicurator',
      agentId: 'wikicurator',
      mode: 'wiki_qa_fast',
      limit: 8,
      includeJournal: false,
      includeRaw: false,
      message: '방금 답변에서 지금 가장 먼저 검증할 가설 하나와 그 근거 위키를 알려줘.',
    },
    {
      view: 'wiki',
      agent: 'wikicurator',
      agentId: 'wikicurator',
      mode: 'wiki_qa_fast',
      limit: 8,
      includeJournal: false,
      includeRaw: false,
      message: 'UniPort의 사용자 문제, 현재 BM, 핵심 리스크를 여러 정본 위키 근거를 종합해 설명해줘.',
    },
    {
      view: 'wiki',
      agent: 'wikicurator',
      agentId: 'wikicurator',
      mode: 'wiki_qa_fast',
      limit: 8,
      includeJournal: false,
      includeRaw: false,
      message: 'UniPort BM에서 CPA보다 B2B 데이터가 장기적으로 더 큰 기회라는 판단의 근거와 한계를 알려줘.',
    },
    {
      view: 'wiki',
      agent: 'wikicurator',
      agentId: 'wikicurator',
      mode: 'wiki_qa_fast',
      limit: 8,
      includeJournal: false,
      includeRaw: false,
      expectNoEvidence: true,
      message: '위키에 AC-NONEXISTENT-7F3A9라는 프로젝트의 확정 매출 수치가 있는지 확인해줘.',
    },
  ];
  const results = [];
  for (const testCase of cases) results.push(await streamTurn(settings, testCase));
  const agentWorkResults = await runAgentWorkCases(settings);

  const evidenceWikiResults = results.filter((result, index) => result.view === 'wiki' && !cases[index].expectNoEvidence);
  assert.ok(evidenceWikiResults.every((result) => result.sources.length > 0), 'Grounded Wiki answers must retain evidence tags.');
  assert.ok(evidenceWikiResults.every((result) => result.sources.every((source) => source.path || source.title)), 'Wiki evidence must be openable.');
  const noEvidenceResult = results.find((result, index) => cases[index].expectNoEvidence);
  assert.ok(noEvidenceResult && noEvidenceResult.sources.length === 0, 'Unknown Wiki entities must not receive unrelated evidence tags.');
  assert.match(noEvidenceResult.answer, /없|찾지 못|확인되지|근거.*없/);
  for (const result of results) {
    const profile = String(result.metadata?.llm?.agent || result.metadata?.run?.agent || result.metadata?.agent || '');
    assert.equal(profile, result.view === 'wiki' ? 'wikicurator' : 'calendarassistant', `${result.view} answered through ${profile || 'unknown profile'}`);
  }
  const allResults = [...results, ...agentWorkResults];
  const p90FirstDeltaMs = percentile(allResults.map((result) => result.firstDeltaMs), 0.9);
  assert.ok(p90FirstDeltaMs <= 30_000, `p90 first answer delta exceeded 30 seconds: ${p90FirstDeltaMs}ms`);

  const report = {
    ok: true,
    p90FirstDeltaMs,
    results: allResults.map((result) => ({
      ...result,
      answer: result.answer.slice(0, 500),
      sources: result.sources.map((source) => ({ path: source.path || '', title: source.title || '' })),
    })),
    checkedAt: new Date().toISOString(),
  };
  const reportPath = process.env.AI_QUALITY_REPORT_PATH;
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
