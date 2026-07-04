import type { WikiSearchResult } from './wikiTypes.js';

const SYSTEM_PROMPT = `너는 Ko Yunseo의 LLM-Wiki 기반 QA 엔진이자 위키 큐레이터다.

규칙:
- 반드시 제공된 SOURCES 안의 근거를 우선 사용한다.
- 모르는 내용은 모른다고 말한다.
- 근거가 부족하면 "위키 근거 부족"이라고 표시한다.
- 답변은 한국어로 한다.
- 사용자가 감정적/개인적 질문을 하면 인간적이고 직접적으로 답한다.
- 답변은 GPT에게 물어본 것처럼 자연스럽고 연결감 있게 작성한다.
- "요약/근거/다음 행동" 같은 고정 템플릿을 강제하지 않는다.
- sources에 없는 사실은 추측이라고 표시한다.`;
const ANSWER_STYLE_INSTRUCTION = '답변은 자연스러운 한국어로 하되, 3-5문장 안에서 핵심부터 말하고 마지막 문장까지 완결해줘. 긴 목차나 "요약/근거/다음 행동" 템플릿은 쓰지 마. 위키 근거가 부족하면 솔직히 "위키 근거 부족"이라고 말해줘. 가능하면 핵심 근거를 [1], [2]처럼 짧게 표시해줘.';

const MAX_SOURCE_COUNT = 5;
const MAX_TOTAL_SOURCE_CONTEXT_CHARS = 4_200;
const MAX_SOURCE_EXCERPT_CHARS = 620;
const MIN_SOURCE_EXCERPT_CHARS = 160;
const MAX_RAILWAY_SOURCE_COUNT = 2;
const MAX_RAILWAY_SOURCE_EXCERPT_CHARS = 180;

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9가-힣]+/g) || [];
}

function normalizeExcerpt(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function compactSourceText(source: WikiSearchResult, question: string, maxChars: number) {
  const normalizedText = normalizeExcerpt(source.text || '');
  const normalizedSnippet = normalizeExcerpt(source.snippet || '');
  const budget = Math.max(MIN_SOURCE_EXCERPT_CHARS, maxChars);
  if (!normalizedText && !normalizedSnippet) return '';
  if (normalizedText.length <= budget) return normalizedText;
  if (normalizedSnippet) return normalizedSnippet.slice(0, budget);

  const lowerText = normalizedText.toLowerCase();
  const tokens = tokenize(`${question} ${source.title} ${source.heading}`).filter((token) => token.length > 1);
  const hit = tokens
    .map((token) => lowerText.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] || 0;
  const start = Math.max(0, hit - Math.floor(budget * 0.35));
  const excerpt = normalizedText.slice(start, start + budget);
  const prefix = start > 0 ? '... ' : '';
  const suffix = start + budget < normalizedText.length ? ' ...' : '';
  return `${prefix}${excerpt}${suffix}`;
}

function sourceContext(sources: WikiSearchResult[], question: string, options: {
  maxSourceCount?: number;
  maxTotalChars?: number;
  maxSourceChars?: number;
  minSourceChars?: number;
} = {}) {
  const maxSourceCount = options.maxSourceCount || MAX_SOURCE_COUNT;
  const maxTotalChars = options.maxTotalChars || MAX_TOTAL_SOURCE_CONTEXT_CHARS;
  const maxSourceChars = options.maxSourceChars || MAX_SOURCE_EXCERPT_CHARS;
  const minSourceChars = options.minSourceChars || MIN_SOURCE_EXCERPT_CHARS;
  const sections: string[] = [];
  let remaining = maxTotalChars;

  for (const [index, source] of sources.slice(0, maxSourceCount).entries()) {
    const header = [
      `[${index + 1}] ${source.title} - ${source.heading}`,
      `path: ${source.path}`,
      `score: ${source.score.toFixed(4)}`,
    ].join('\n');
    const separatorLength = sections.length ? '\n\n---\n\n'.length : 0;
    const excerptBudget = Math.min(maxSourceChars, remaining - header.length - separatorLength - 1);
    if (excerptBudget < minSourceChars) break;
    const excerpt = compactSourceText(source, question, excerptBudget);
    const section = `${header}\n${excerpt}`;
    sections.push(section);
    remaining -= section.length + separatorLength;
    if (remaining < minSourceChars) break;
  }

  return sections.join('\n\n---\n\n');
}

function railwayWikiCommand(question: string, sources: WikiSearchResult[]) {
  const context = sources.slice(0, MAX_RAILWAY_SOURCE_COUNT)
    .map((source, index) => {
      const excerpt = compactSourceText(source, question, MAX_RAILWAY_SOURCE_EXCERPT_CHARS);
      return `[${index + 1}] ${source.title} / ${source.heading}: ${excerpt}`;
    })
    .join('\n');
  return [
    '위키 큐레이터 답변.',
    '규칙: SOURCES만 사용. 한국어 한 문장, 120자 이하. 반드시 문장 끝에 [1]처럼 인용. 모르면 "위키 근거 부족".',
    '',
    `Q: ${question}`,
    '',
    `SOURCES:\n${context || '(검색된 근거 없음)'}`,
  ].join('\n');
}

function parseRailwaySse(raw: string) {
  const deltas: string[] = [];
  let doneText = '';
  let source = '';
  let model = '';
  let gatewayFallback = false;
  let error = '';
  for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.replace(/^event:\s*/, '').trim() || '';
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''))
      .join('\n')
      .trim();
    if (!data) continue;
    let payload: Record<string, any>;
    try { payload = JSON.parse(data); } catch { continue; }
    if (typeof payload.source === 'string') source = payload.source;
    if (typeof payload.error === 'string') error = payload.error;
    if (payload.gatewayFallback !== undefined) gatewayFallback = Boolean(payload.gatewayFallback);
    if (typeof payload.run?.model === 'string') model = payload.run.model;
    if (event === 'delta' && typeof payload.text === 'string') deltas.push(payload.text);
    if (event === 'done' && typeof payload.text === 'string') doneText = payload.text;
    if (!event && typeof payload.text === 'string') deltas.push(payload.text);
  }
  return {
    answer: (doneText || deltas.join('')).trim(),
    model,
    source,
    gatewayFallback,
    error,
  };
}

function applyRailwaySseBlock(state: {
  deltas: string[];
  doneText: string;
  source: string;
  model: string;
  gatewayFallback: boolean;
  error: string;
}, block: string) {
  const lines = block.split('\n');
  const event = lines.find((line) => line.startsWith('event:'))?.replace(/^event:\s*/, '').trim() || '';
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s?/, ''))
    .join('\n')
    .trim();
  if (!data) return event;
  let payload: Record<string, any>;
  try { payload = JSON.parse(data); } catch { return event; }
  if (typeof payload.source === 'string') state.source = payload.source;
  if (typeof payload.error === 'string') state.error = payload.error;
  if (payload.gatewayFallback !== undefined) state.gatewayFallback = Boolean(payload.gatewayFallback);
  if (typeof payload.run?.model === 'string') state.model = payload.run.model;
  if (event === 'delta' && typeof payload.text === 'string') state.deltas.push(payload.text);
  if (event === 'done' && typeof payload.text === 'string') state.doneText = payload.text;
  if (!event && typeof payload.text === 'string') state.deltas.push(payload.text);
  return event;
}

function answerLooksComplete(answer: string) {
  const trimmed = answer.trim();
  if (trimmed.length < 45) return false;
  const withoutTrailingCitations = trimmed.replace(/(?:\s*\[[0-9]+\])+$/g, '').trim();
  return /[.!?。！？…)\]]$/.test(trimmed) || /(다|요|임|음|함|해|돼)$/.test(withoutTrailingCitations);
}

async function readRailwaySse(response: Response) {
  if (!response.body) return parseRailwaySse(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    deltas: [] as string[],
    doneText: '',
    source: '',
    model: '',
    gatewayFallback: false,
    error: '',
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const event = applyRailwaySseBlock(state, block);
        const answer = (state.doneText || state.deltas.join('')).trim();
        const errorMessage = state.error || (/^Railway relay failed:/i.test(answer) ? answer : '');
        if (!errorMessage && event === 'delta' && answerLooksComplete(answer)) {
          await reader.cancel();
          return {
            answer,
            model: state.model,
            source: state.source,
            gatewayFallback: state.gatewayFallback,
            error: state.error,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (buffer.trim()) applyRailwaySseBlock(state, buffer);
  return {
    answer: (state.doneText || state.deltas.join('')).trim(),
    model: state.model,
    source: state.source,
    gatewayFallback: state.gatewayFallback,
    error: state.error,
  };
}

function isRetryableRailwayError(message: string) {
  return /timeout|timed out|railway relay bridge timed out|terminated/i.test(message);
}

export async function askHermesWithSources(options: {
  baseUrl: string;
  apiKey?: string;
  agent?: string;
  model?: string;
  question: string;
  sources: WikiSearchResult[];
  fetchImpl?: typeof fetch;
}) {
  const baseUrl = options.baseUrl.replace(/\/+$/g, '');
  const agent = options.agent || options.model || 'wiki-curator';
  const model = options.model || agent;
  const sourceText = sourceContext(options.sources, options.question);
  const body = {
    model,
    temperature: 0.2,
    metadata: {
      agent,
      profile: agent,
      mode: 'wiki_qa',
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `QUESTION:\n${options.question}\n\nSOURCES:\n${sourceText}\n\n${ANSWER_STYLE_INSTRUCTION}` },
    ],
  };
  const response = await (options.fetchImpl || fetch)(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: Record<string, any>;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  if (!response.ok) throw new Error(`Hermes chat ${response.status}: ${raw.slice(0, 500)}`);
  const answer = String(payload.choices?.[0]?.message?.content || payload.answer || payload.text || '').trim();
  if (!answer) throw new Error('Hermes chat returned an empty answer');
  return { answer, model: String(payload.model || model), agent, raw: payload };
}

export async function askRailwayWithSources(options: {
  baseUrl: string;
  apiToken?: string;
  agent?: string;
  model?: string;
  question: string;
  sources: WikiSearchResult[];
  fetchImpl?: typeof fetch;
}) {
  const baseUrl = options.baseUrl.replace(/\/+$/g, '');
  const agent = options.agent || options.model || 'wiki-curator';
  const model = options.model || agent;
  const command = railwayWikiCommand(options.question, options.sources);
  const body = {
    message: command,
    view: 'wiki',
    agent,
    agentId: agent,
    model,
    mode: 'wiki_qa_fast',
  };
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await (options.fetchImpl || fetch)(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Railway Hermes chat ${response.status}: ${raw.slice(0, 500)}`);
    }
    const parsed = await readRailwaySse(response);
    const errorMessage = parsed.error || (/^Railway relay failed:/i.test(parsed.answer) ? parsed.answer : '');
    if (errorMessage) {
      lastError = new Error(errorMessage);
      if (attempt === 0 && isRetryableRailwayError(errorMessage)) continue;
      throw lastError;
    }
    if (!parsed.answer) throw new Error('Railway Hermes chat returned an empty answer');
    return {
      answer: parsed.answer,
      model: parsed.model || model,
      agent,
      source: parsed.source || 'railway',
      gatewayFallback: parsed.gatewayFallback,
      raw: parsed,
    };
  }
  throw lastError || new Error('Railway Hermes chat returned an empty answer');
}
