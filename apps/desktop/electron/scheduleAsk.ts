import type { IncomingMessage, ServerResponse } from 'node:http';

type FetchImpl = typeof fetch;
type ScheduleItem = Record<string, unknown>;

type ScheduleVectorEntry = {
  id: string;
  item: ScheduleItem;
  text: string;
  vector: Float32Array;
};

const VECTOR_DIMENSIONS = 256;
const DEFAULT_RAILWAY_BASE_URL = 'https://hermes-os-production-e174.up.railway.app';

const STOP_WORDS = new Set([
  '이번', '지난', '저번', '최근', '오늘', '내일', '동안', '간', '몇', '얼마', '뭐', '무엇',
  '했지', '했어', '어때', '알려줘', '정리해줘', '총', '평균', '비율',
]);

const KOREAN_SUFFIXES = [
  '에서는', '으로는', '에게는', '한테는', '이라는', '이라면', '이라서',
  '에서', '으로', '에게', '한테', '보다', '까지', '부터', '처럼', '마다',
  '라고', '라는', '이며', '이고', '인데', '하면', '해서', '하고',
  '은', '는', '이', '가', '을', '를', '의', '에', '도', '만', '와', '과', '로',
];

function text(value: unknown, fallback = '') {
  return String(value || fallback);
}

function arr(payload: Record<string, unknown> | undefined, ...keys: string[]): ScheduleItem[] {
  for (const key of keys) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value as ScheduleItem[];
  }
  const data = payload?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const found = arr(data as Record<string, unknown>, ...keys);
    if (found.length) return found;
  }
  return [];
}

async function requestJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function targetUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/g, '')}${path}`;
}

function itemId(item: ScheduleItem, fallback: string) {
  return text(item.id || item._id || item.key || item.uid, fallback);
}

function itemTitle(item: ScheduleItem) {
  return text(item.title || item.name || item.summary || item.subject || item.label, '일정');
}

function itemDate(item: ScheduleItem) {
  const value = text(item.date || item.startDate || item.day || item.due || item.start);
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : value.slice(0, 10);
}

function itemTags(item: ScheduleItem) {
  if (Array.isArray(item.tags)) return item.tags.map(String).filter(Boolean);
  return text(item.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function itemList(item: ScheduleItem) {
  return text(item.category || item.project || item.list || item.calendar || item.source, '');
}

function isDone(item: ScheduleItem) {
  return Boolean(item.done) || /done|complete|completed|ok|완료/i.test(text(item.status || item.lane || item.state));
}

function itemEndTime(item: ScheduleItem) {
  const direct = text(item.endTime || item.tEnd);
  if (direct) return direct;
  const notes = text(item.notes || item.description);
  const marker = '[Agent Calendar]\n';
  const index = notes.indexOf(marker);
  if (index === -1) return '';
  try {
    const meta = JSON.parse(notes.slice(index + marker.length)) as Record<string, unknown>;
    return text(meta.endTime);
  } catch {
    return '';
  }
}

function durationHours(item: ScheduleItem) {
  const startTime = text(item.time || item.t);
  const endTime = itemEndTime(item);
  if (!startTime || !endTime) return 0;
  const [startHour = 0, startMinute = 0] = startTime.split(':').map((part) => Number(part) || 0);
  const [endHour = 0, endMinute = 0] = endTime.split(':').map((part) => Number(part) || 0);
  const minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return minutes > 0 ? minutes / 60 : 0;
}

function isWorkItem(item: ScheduleItem) {
  return /알바|근무|work|shift/i.test([
    itemTitle(item),
    itemList(item),
    itemTags(item).join(' '),
    text(item.notes || item.description),
  ].join(' '));
}

function tokenize(value: string) {
  const rawTokens = value.toLowerCase().match(/[a-z0-9]+|[가-힣]+/g) || [];
  const tokens: string[] = [];
  rawTokens.forEach((token) => {
    let stem = '';
    for (const suffix of KOREAN_SUFFIXES) {
      if (token.length > suffix.length + 1 && token.endsWith(suffix)) {
        stem = token.slice(0, -suffix.length);
        break;
      }
    }
    if (!STOP_WORDS.has(token)) tokens.push(token);
    if (stem && !STOP_WORDS.has(stem)) tokens.push(stem);
  });
  return tokens;
}

function hashToken(token: string) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function embed(textValue: string) {
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  for (const token of tokenize(textValue)) {
    const hash = hashToken(token);
    const index = hash % VECTOR_DIMENSIONS;
    const sign = hash & 1 ? 1 : -1;
    vector[index] += sign;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function cosine(a: Float32Array, b: Float32Array) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

function itemText(item: ScheduleItem) {
  return [
    itemTitle(item),
    itemDate(item),
    text(item.time),
    itemEndTime(item),
    isDone(item) ? '완료' : '미완료',
    itemList(item),
    itemTags(item).join(' '),
    text(item.notes || item.description),
  ].filter(Boolean).join(' ');
}

function createScheduleVectorStore(items: ScheduleItem[]) {
  const entries: ScheduleVectorEntry[] = items.map((item, index) => {
    const source = itemText(item);
    return {
      id: itemId(item, `schedule-${index}`),
      item,
      text: source,
      vector: embed(source),
    };
  });
  return {
    search(query: string, limit = 8) {
      const queryVector = embed(query);
      return entries
        .map((entry) => ({ entry, score: cosine(queryVector, entry.vector) }))
        .filter((result) => result.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

function addDaysKey(date: string, offset: number) {
  const day = new Date(`${date}T00:00:00`);
  day.setDate(day.getDate() + offset);
  return day.toISOString().slice(0, 10);
}

function addMonthsKey(date: string, offset: number) {
  const day = new Date(`${date}T00:00:00`);
  day.setMonth(day.getMonth() + offset);
  return day.toISOString().slice(0, 10);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function questionRange(question: string, requestFilters: Record<string, unknown>) {
  const explicitFrom = text(requestFilters.from);
  const explicitTo = text(requestFilters.to);
  if (explicitFrom || explicitTo) return { from: explicitFrom, to: explicitTo, label: '선택한 기간' };

  const today = todayKey();
  const current = new Date(`${today}T00:00:00`);
  const dayOfWeek = current.getDay() || 7;
  const monday = addDaysKey(today, 1 - dayOfWeek);
  if (/오늘/.test(question)) return { from: today, to: today, label: '오늘' };
  if (/내일/.test(question)) {
    const tomorrow = addDaysKey(today, 1);
    return { from: tomorrow, to: tomorrow, label: '내일' };
  }
  if (/지난\s*주|저번\s*주/.test(question)) {
    const from = addDaysKey(monday, -7);
    return { from, to: addDaysKey(from, 6), label: '지난주' };
  }
  if (/이번\s*주|금주/.test(question)) return { from: monday, to: addDaysKey(monday, 6), label: '이번 주' };
  const monthMatch = question.match(/(?:최근|지난)?\s*(\d+)\s*(?:달|개월)/);
  if (monthMatch) {
    const months = Math.max(1, Number(monthMatch[1]) || 1);
    return { from: addMonthsKey(today, -months), to: today, label: `최근 ${months}개월` };
  }
  return { from: '', to: '', label: '전체 기록' };
}

function inRange(item: ScheduleItem, from: string, to: string) {
  if (!from && !to) return true;
  const date = itemDate(item);
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

function computedFor(question: string, scopeLabel: string, items: ScheduleItem[]) {
  const timeQuestion = /시간|알바|근무/.test(question);
  const relevant = timeQuestion ? items.filter(isWorkItem) : items;
  const done = relevant.filter(isDone).length;
  const total = relevant.length;
  const workItems = relevant.filter(isWorkItem);
  const workHours = workItems.reduce((sum, item) => sum + (durationHours(item) || 4), 0);
  return {
    scopeLabel,
    total,
    done,
    todo: total - done,
    doneRate: Math.round((done / Math.max(total, 1)) * 100),
    workCount: workItems.length,
    workHours,
  };
}

function fallbackAnswer(question: string, computed: ReturnType<typeof computedFor>) {
  if (!computed.total) return '해당 범위에 일정이나 작업 기록이 아직 없어요. 먼저 기록을 추가하면 그 데이터를 근거로 답할 수 있어요.';
  if (/시간|알바|근무/.test(question)) {
    const hours = Number.isInteger(computed.workHours) ? String(computed.workHours) : computed.workHours.toFixed(1);
    return `${computed.scopeLabel} 알바/근무 시간은 ${hours}시간이에요. 근거: 알바/근무 기록 ${computed.workCount}건. 시작~종료 시간이 없는 근무 기록은 회당 4시간으로 추정했어요.`;
  }
  if (/완료|완료율|비율|평균/.test(question)) {
    return `${computed.scopeLabel} 완료율은 ${computed.doneRate}%예요. ${computed.done}/${computed.total} 완료, 미완료 ${computed.todo}개입니다.`;
  }
  return `${computed.scopeLabel} 기준 전체 ${computed.total}개 중 ${computed.done}개를 완료했어요.`;
}

async function fetchJson(fetchImpl: FetchImpl, url: string, apiToken = '') {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`schedule source ${response.status}: ${url}`);
  return response.json() as Promise<Record<string, unknown>>;
}

function sourceForResult(result: { entry: ScheduleVectorEntry; score: number }) {
  const item = result.entry.item;
  return {
    id: result.entry.id,
    title: itemTitle(item),
    date: itemDate(item),
    time: text(item.time),
    endTime: itemEndTime(item),
    status: text(item.status || item.state || item.lane || (isDone(item) ? 'Done' : 'Planned')),
    list: itemList(item),
    tags: itemTags(item),
    score: Number(result.score.toFixed(4)),
    snippet: result.entry.text.slice(0, 220),
  };
}

export function isLocalScheduleAskRoute(method = 'GET', requestUrl = '') {
  const pathName = new URL(requestUrl, 'http://127.0.0.1').pathname;
  return method.toUpperCase() === 'POST' && pathName === '/api/assistant/ask';
}

export async function handleLocalScheduleAskRoute(req: IncomingMessage, res: ServerResponse, options: {
  fetchImpl?: FetchImpl;
  railwayBaseUrl?: string;
  railwayApiToken?: string;
} = {}) {
  const request = await requestJson(req);
  const question = text(request.question || request.query).trim();
  if (!question) {
    sendJson(res, 400, { ok: false, error: 'question is required' });
    return;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const railwayBaseUrl = options.railwayBaseUrl || DEFAULT_RAILWAY_BASE_URL;
  const apiToken = options.railwayApiToken || '';
  const filters = request.filters && typeof request.filters === 'object' && !Array.isArray(request.filters)
    ? request.filters as Record<string, unknown>
    : {};
  const range = questionRange(question, filters);
  const [tasksPayload, eventsPayload] = await Promise.all([
    fetchJson(fetchImpl, targetUrl(railwayBaseUrl, '/api/tasks'), apiToken),
    fetchJson(fetchImpl, targetUrl(railwayBaseUrl, '/api/calendar/events'), apiToken),
  ]);

  const items = [
    ...arr(tasksPayload, 'tasks'),
    ...arr(eventsPayload, 'events', 'calendarEvents').map((event) => ({ ...event, kind: 'calendar-event', type: 'calendar-event' })),
  ].filter((item) => inRange(item, range.from, range.to));

  const store = createScheduleVectorStore(items);
  const timeQuestion = /시간|알바|근무/.test(question);
  const vectorResults = store.search(question, Number(request.limit || 8) || 8)
    .filter((result) => !timeQuestion || isWorkItem(result.entry.item));
  const retrievedItems = vectorResults.map((result) => result.entry.item);
  const computed = computedFor(question, range.label, timeQuestion && retrievedItems.length ? retrievedItems : items);
  const answer = fallbackAnswer(question, computed);
  const sources = vectorResults.map(sourceForResult);

  sendJson(res, 200, {
    ok: true,
    answer,
    answerMode: 'fallback',
    sources,
    computed,
    search: {
      query: question,
      strategy: 'schedule-vector',
      intent: 'ask',
      range,
      resultCount: sources.length,
      dimensions: VECTOR_DIMENSIONS,
    },
    gatewayFallback: true,
    engine: {
      provider: 'local-schedule-rag',
      retrieval: 'hash-embedding-vector-store',
      model: 'computed-fallback',
    },
  });
}

export const __scheduleAskTest = {
  createScheduleVectorStore,
  embed,
  tokenize,
};
