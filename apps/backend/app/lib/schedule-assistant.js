const { cosineSimilarity, embedTextWithMetadata } = require('./embeddings');

const VECTOR_DIMENSIONS = 256;
const recordEmbeddingCache = new Map();
const RECORD_EMBEDDING_CACHE_LIMIT = 5000;

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

function text(value, fallback = '') {
  return String(value || fallback);
}

function compactValue(value, maxLength = 700) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim().slice(0, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return '';
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function firstDate(value) {
  const match = text(value).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function itemId(item, fallback) {
  return text(item.id || item._id || item.key || item.uid || item.sourceId, fallback);
}

function itemTitle(item) {
  return text(item.title || item.name || item.summary || item.subject || item.label || item.goal, '기록');
}

function itemDate(item) {
  return firstDate(item.date || item.startDate || item.day || item.due || item.start || item.createdAt || item.updatedAt || item.completedAt || item.completedTime);
}

function itemTags(item) {
  if (Array.isArray(item.tags)) return item.tags.map(String).filter(Boolean);
  return text(item.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function itemList(item) {
  return text(item.category || item.project || item.list || item.calendar || item.source || item.folder, '');
}

function itemStatus(item) {
  return text(item.status || item.lane || item.state, '');
}

function isDone(item) {
  return Boolean(item.done)
    || Boolean(item.completedAt || item.completedTime)
    || /done|complete|completed|ok|완료/i.test(itemStatus(item));
}

function itemEndTime(item) {
  const direct = text(item.endTime || item.tEnd || item.end_time);
  if (direct) return direct;
  const notes = text(item.notes || item.description || item.body);
  const marker = '[Agent Calendar]\n';
  const index = notes.indexOf(marker);
  if (index === -1) return '';
  try {
    const meta = JSON.parse(notes.slice(index + marker.length));
    return text(meta.endTime);
  } catch {
    return '';
  }
}

function itemTime(item) {
  const direct = text(item.time || item.t || item.startTime || item.start_time);
  if (direct) return direct;
  const start = text(item.start || item.startDate);
  const match = start.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function durationHours(item) {
  const startTime = itemTime(item);
  const endTime = itemEndTime(item);
  if (!startTime || !endTime) return 0;
  const [startHour = 0, startMinute = 0] = startTime.split(':').map((part) => Number(part) || 0);
  const [endHour = 0, endMinute = 0] = endTime.split(':').map((part) => Number(part) || 0);
  const minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return minutes > 0 ? minutes / 60 : 0;
}

function isWorkItem(item) {
  return /알바|근무|work|shift/i.test([
    itemTitle(item),
    itemList(item),
    itemTags(item).join(' '),
    text(item.notes || item.description || item.body),
  ].join(' '));
}

function tokenize(value) {
  const rawTokens = text(value).toLowerCase().match(/[a-z0-9]+|[가-힣]+/g) || [];
  const tokens = [];
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

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function embed(value) {
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  for (const token of tokenize(value)) {
    const hash = hashToken(token);
    vector[hash % VECTOR_DIMENSIONS] += hash & 1 ? 1 : -1;
  }
  let norm = 0;
  for (const entry of vector) norm += entry * entry;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function cosine(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

function itemSearchText(item) {
  if (item._searchText) return text(item._searchText);
  return [
    itemTitle(item),
    itemDate(item),
    itemTime(item),
    itemEndTime(item),
    isDone(item) ? '완료' : '미완료',
    itemList(item),
    itemTags(item).join(' '),
    text(item.notes || item.description || item.body),
  ].filter(Boolean).join(' ');
}

function recordEmbeddingModelKey(options = {}) {
  const env = options.env || process.env;
  return text(
    options.model
    || env.AGENT_CALENDAR_EMBEDDING_MODEL
    || env.HERMES_EMBEDDING_MODEL
    || env.OLLAMA_EMBEDDING_MODEL
    || 'bge-m3',
  ).trim() || 'bge-m3';
}

function recordEmbeddingCacheKey(item, source, options = {}) {
  return [
    recordEmbeddingModelKey(options),
    itemId(item, ''),
    text(item.updatedAt || item.modifiedAt || item.completedAt || ''),
    source,
  ].join('\u001f');
}

async function embedScheduleRecord(item, source, options = {}) {
  const key = recordEmbeddingCacheKey(item, source, options);
  const cached = recordEmbeddingCache.get(key);
  if (cached) return cached;
  const embedded = await embedTextWithMetadata(source, options);
  recordEmbeddingCache.set(key, embedded);
  if (recordEmbeddingCache.size > RECORD_EMBEDDING_CACHE_LIMIT) {
    const firstKey = recordEmbeddingCache.keys().next().value;
    if (firstKey) recordEmbeddingCache.delete(firstKey);
  }
  return embedded;
}

function keywordOverlapScore(question, source) {
  const queryTokens = new Set(tokenize(question));
  if (!queryTokens.size) return 0;
  const sourceTokens = new Set(tokenize(source));
  let hits = 0;
  for (const token of queryTokens) {
    if (sourceTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function dateProximityScore(item, range = {}) {
  const date = itemDate(item);
  if (!date) return 0;
  if (range.from || range.to) {
    if ((!range.from || date >= range.from) && (!range.to || date <= range.to)) return 1;
    const boundary = date < range.from ? range.from : range.to;
    const days = Math.abs((new Date(`${date}T00:00:00Z`) - new Date(`${boundary}T00:00:00Z`)) / 86400000);
    return 1 / (1 + days / 7);
  }
  const days = Math.abs((new Date(`${date}T00:00:00Z`) - new Date(`${todayKey()}T00:00:00Z`)) / 86400000);
  return 1 / (1 + days / 7);
}

function isRetrospectiveQuestion(question) {
  return /완료한|끝낸|지난|저번|회고|완료된/.test(question);
}

async function vectorSearch(items, question, limit = 8, options = {}) {
  const query = await embedTextWithMetadata(question, options);
  const fallbackModels = new Set(query.fallback ? ['hash-fallback'] : []);
  const retrospective = isRetrospectiveQuestion(question);
  const entries = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const source = itemSearchText(item);
    const embedded = await embedScheduleRecord(item, source, options);
    if (embedded.fallback) fallbackModels.add('hash-fallback');
    const embeddingScore = Math.max(0, cosineSimilarity(query.vector, embedded.vector));
    const dateScore = dateProximityScore(item, options.range || {});
    const keywordScore = keywordOverlapScore(question, source);
    const baseScore = (0.55 * embeddingScore) + (0.25 * dateScore) + (0.20 * keywordScore);
    const score = baseScore * (!retrospective && !isDone(item) ? 1.15 : 1);
    entries.push({
      item: { ...item, _score: Number(score.toFixed(6)) },
      index,
      score,
    });
  }
  const embeddingModel = fallbackModels.size ? 'hash-fallback' : query.model;
  return {
    items: entries
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score - a.score) || a.index - b.index)
      .slice(0, limit)
      .map((entry) => entry.item),
    embeddingModel,
  };
}

function addDaysKey(date, offset) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

function addMonthsKey(date, offset) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCMonth(day.getUTCMonth() + offset);
  return day.toISOString().slice(0, 10);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function questionRange(question, filters = {}) {
  const explicitFrom = text(filters.from);
  const explicitTo = text(filters.to);
  const today = todayKey();
  const current = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = current.getUTCDay() || 7;
  const monday = addDaysKey(today, 1 - dayOfWeek);
  if (explicitFrom || explicitTo) {
    let label = '선택한 기간';
    if (/오늘/.test(question)) label = '오늘';
    else if (/내일/.test(question)) label = '내일';
    else if (/지난\s*주|저번\s*주/.test(question)) label = '지난주';
    else if (/이번\s*주|금주/.test(question)) label = '이번 주';
    return { from: explicitFrom, to: explicitTo, label };
  }
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

function inRange(item, range) {
  if (!range.from && !range.to) return true;
  const date = itemDate(item);
  if (!date) return false;
  return (!range.from || date >= range.from) && (!range.to || date <= range.to);
}

const SCHEDULE_SOURCE_TYPE_PATTERN = /task|calendar|event|ticktick|schedule/i;

function canonicalScheduleSourceType(candidates = [], fallback = 'record') {
  const values = candidates.map((value) => text(value)).filter(Boolean);
  return values.find((value) => SCHEDULE_SOURCE_TYPE_PATTERN.test(value)) || values[0] || fallback;
}

function normalizeSource(item, index) {
  const sourceType = canonicalScheduleSourceType([item.sourceType, item.kind, item.type, item.source]);
  return {
    id: itemId(item, `schedule-${index}`),
    title: itemTitle(item),
    sourceType,
    type: sourceType,
    date: itemDate(item),
    time: itemTime(item),
    endTime: itemEndTime(item),
    status: itemStatus(item),
    done: isDone(item),
    tags: itemTags(item),
    list: itemList(item),
    source: sourceType,
    score: Number(item._score || item.score || 0),
    snippet: compactValue(item.snippet || item.excerpt || item.preview || item.body || item.notes || item.description || item._searchText, 260),
  };
}

function dedupeItems(items) {
  const byId = new Map();
  items.forEach((item, index) => {
    const key = itemId(item, `schedule-${index}`);
    if (!byId.has(key)) byId.set(key, item);
  });
  return [...byId.values()];
}

function withScheduleKind(items, kind) {
  return array(items).map((item) => (item && typeof item === 'object' && !item.kind ? { ...item, kind } : item));
}

function scheduleItemsFromState(state = {}) {
  return dedupeItems([
    ...withScheduleKind(state.tasks, 'task'),
    ...withScheduleKind(state.events, 'calendar-event'),
    ...withScheduleKind(state.calendarEvents, 'calendar-event'),
    ...withScheduleKind(state.ticktickTasks, 'ticktick-task'),
    ...withScheduleKind(state.externalCalendarEvents, 'external-calendar-event'),
  ]);
}

function recordFromScheduleItem(item, index, type) {
  const sourceType = canonicalScheduleSourceType([item.sourceType, item.kind, item.type, type], 'schedule');
  return {
    ...item,
    id: itemId(item, `${sourceType}-${index}`),
    sourceType,
    _searchText: [
      sourceType,
      itemTitle(item),
      itemDate(item),
      itemTime(item),
      itemEndTime(item),
      isDone(item) ? '완료' : '미완료',
      itemStatus(item),
      itemList(item),
      itemTags(item).join(' '),
      compactValue(item.notes || item.description || item.body, 900),
    ].filter(Boolean).join('\n'),
  };
}

function recordFromDocument(document, index) {
  const sourceType = text(document.source || document.kind || 'document');
  const title = itemTitle(document);
  const body = compactValue(document.content || document.body || document.text || document.excerpt || document.summary || document.notes, 1400);
  return {
    ...document,
    id: itemId(document, `document-${index}`),
    title,
    sourceType,
    date: itemDate(document),
    snippet: body,
    _searchText: [
      sourceType,
      title,
      text(document.path || document.wikiPath || document.filePath),
      text(document.status),
      body,
    ].filter(Boolean).join('\n'),
  };
}

function recordFromRun(run, index) {
  const title = text(run.goal || run.title || run.command || run.id, '실행 기록');
  const body = compactValue(run.summary || run.result || run.output || run.final || run.error || run.notes || run.artifacts || run.logs, 1200);
  return {
    ...run,
    id: itemId(run, `run-${index}`),
    title,
    sourceType: 'run',
    date: itemDate(run),
    status: text(run.status || run.state),
    snippet: body,
    _searchText: [
      'run',
      title,
      text(run.agent || run.agentId || run.model),
      text(run.status || run.state),
      body,
    ].filter(Boolean).join('\n'),
  };
}

function recordFromChatMessage(message, index) {
  const body = compactValue(message.text || message.body || message.content || message.message, 900);
  return {
    ...message,
    id: itemId(message, `chat-${index}`),
    title: `${text(message.role || message.sender || 'chat')} 메시지`,
    sourceType: 'chat-message',
    date: itemDate(message),
    snippet: body,
    _searchText: ['chat-message', text(message.role || message.sender), body].filter(Boolean).join('\n'),
  };
}

function recordFromMailMessage(message, index) {
  const title = text(message.subject || message.title || message.preview || message.from, '메일');
  const body = compactValue(message.body || message.text || message.preview || message.snippet, 1000);
  return {
    ...message,
    id: itemId(message, `mail-${index}`),
    title,
    sourceType: 'mail',
    date: itemDate(message),
    snippet: body,
    _searchText: [
      'mail',
      title,
      text(message.from || message.sender),
      text(message.to),
      body,
    ].filter(Boolean).join('\n'),
  };
}

function recordFromWorkboardPage(page, index) {
  const title = itemTitle(page);
  const body = compactValue(page.body || page.content || page.description || page.columns || page.cards || page.items, 1200);
  return {
    ...page,
    id: itemId(page, `workboard-${index}`),
    title,
    sourceType: 'workboard-page',
    date: itemDate(page),
    snippet: body,
    _searchText: ['workboard-page', title, body].filter(Boolean).join('\n'),
  };
}

function recordFromAgent(agent, index) {
  const title = text(agent.displayName || agent.name || agent.id, '에이전트');
  const body = compactValue(agent.role || agent.description || agent.status || agent.profileReadiness || agent.runtimeBinding, 900);
  return {
    ...agent,
    id: itemId(agent, `agent-${index}`),
    title,
    sourceType: 'agent',
    date: itemDate(agent),
    status: text(agent.status || agent.state),
    snippet: body,
    _searchText: ['agent', title, text(agent.role), text(agent.status || agent.state), body].filter(Boolean).join('\n'),
  };
}

function recordFromSchedulerJob(job, index) {
  const title = itemTitle(job);
  const body = compactValue(job.prompt || job.command || job.description || job.notes || job.schedule, 900);
  return {
    ...job,
    id: itemId(job, `scheduler-${index}`),
    title,
    sourceType: 'scheduler-job',
    date: itemDate(job),
    status: text(job.status || job.state),
    snippet: body,
    _searchText: ['scheduler-job', title, text(job.status || job.state), body].filter(Boolean).join('\n'),
  };
}

function calendarAiRecordsFromState(state = {}) {
  return dedupeItems([
    ...array(state.tasks).map((item, index) => recordFromScheduleItem(item, index, 'task')),
    ...array(state.events).map((item, index) => recordFromScheduleItem(item, index, 'calendar-event')),
    ...array(state.calendarEvents).map((item, index) => recordFromScheduleItem(item, index, 'calendar-event')),
    ...array(state.ticktickTasks).map((item, index) => recordFromScheduleItem(item, index, 'ticktick-task')),
    ...array(state.externalCalendarEvents).map((item, index) => recordFromScheduleItem(item, index, 'external-calendar-event')),
  ]);
}

function applyFilters(items, filters = {}, range) {
  const list = text(filters.list).toLowerCase();
  const tag = text(filters.tag).replace(/^#/, '').toLowerCase();
  return items.filter((item) => {
    if (!inRange(item, range)) return false;
    if (list && itemList(item).toLowerCase() !== list) return false;
    if (tag && !itemTags(item).some((itemTag) => itemTag.toLowerCase() === tag)) return false;
    return true;
  });
}

function applyRecordFilters(records, filters = {}, range) {
  const sourceType = text(filters.sourceType || filters.type).toLowerCase();
  return records.filter((record) => {
    if (!inRange(record, range)) return false;
    if (sourceType && text(record.sourceType || record.type || record.source).toLowerCase() !== sourceType) return false;
    return true;
  });
}

async function relevantItems(question, scopedItems, searchOptions = {}) {
  if (/시간|알바|근무/.test(question)) return scopedItems.filter(isWorkItem);
  const searched = await vectorSearch(scopedItems, question, 12, searchOptions);
  return searched.items.length ? searched.items : scopedItems.slice(0, 12);
}

function isScheduleFirstQuestion(question) {
  return /일정|할\s*일|할일|캘린더|오늘|내일|이번|우선순위|회의|완료|완료율|기한|병원|알바|근무|시간|리스크|체크리스트|작업|계획|브리핑/.test(question);
}

function isScheduleSource(record) {
  return /task|calendar|event|ticktick|schedule/i.test(text(record.sourceType || record.type || record.source));
}

async function relevantContextRecords(question, scopedRecords, scopedScheduleItems, searchOptions = {}) {
  const directScheduleItems = (await relevantItems(question, scopedScheduleItems, searchOptions)).map((item, index) => recordFromScheduleItem(item, index, canonicalScheduleSourceType([item.kind, item.type], 'schedule')));
  const searchableRecords = /시간|알바|근무/.test(question) ? scopedRecords.filter(isWorkItem) : scopedRecords;
  const searched = await vectorSearch(searchableRecords, question, 16, searchOptions);
  const scheduleFirst = isScheduleFirstQuestion(question);
  const searchedSchedule = searched.items.filter(isScheduleSource);
  const combined = scheduleFirst
    ? [...directScheduleItems, ...searchedSchedule]
    : [...searched.items, ...directScheduleItems.slice(0, 4)];
  return {
    records: dedupeItems(combined).slice(0, 18),
    embeddingModel: searched.embeddingModel,
  };
}

function formatHours(hours) {
  const rounded = Math.round(hours * 100) / 100;
  const whole = Math.floor(rounded);
  const minutes = Math.round((rounded - whole) * 60);
  if (minutes > 0) return `${whole}시간 ${minutes}분`;
  return `${rounded}시간`;
}

function dayDifference(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / 86400000);
}

function computedItemSummary(item) {
  return {
    id: itemId(item, itemTitle(item)),
    title: itemTitle(item),
    date: itemDate(item),
    time: itemTime(item),
    endTime: itemEndTime(item),
  };
}

function buildDueComputed(items, nowKey = todayKey()) {
  const dueCandidates = items.filter((item) => !isDone(item) && itemDate(item));
  const overdueItems = dueCandidates
    .filter((item) => itemDate(item) < nowKey)
    .map((item) => ({
      ...computedItemSummary(item),
      daysOverdue: Math.max(0, dayDifference(itemDate(item), nowKey)),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.date.localeCompare(b.date));
  const dueSoonItems = dueCandidates
    .filter((item) => {
      const daysUntil = dayDifference(nowKey, itemDate(item));
      return daysUntil >= 0 && daysUntil <= 2;
    })
    .map((item) => ({
      ...computedItemSummary(item),
      daysUntilDue: Math.max(0, dayDifference(nowKey, itemDate(item))),
    }))
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.date.localeCompare(b.date));
  return { overdueItems, dueSoonItems };
}

function minutesFromTime(value) {
  const match = text(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

function buildConflictComputed(items) {
  const timed = items
    .map((item) => {
      const date = itemDate(item);
      const start = minutesFromTime(itemTime(item));
      const end = minutesFromTime(itemEndTime(item));
      if (!date || start === null || end === null || end <= start) return null;
      return { item, date, start, end };
    })
    .filter(Boolean)
    .sort((a, b) => `${a.date}:${a.start}`.localeCompare(`${b.date}:${b.start}`));
  const conflictPairs = [];
  for (let leftIndex = 0; leftIndex < timed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < timed.length; rightIndex += 1) {
      const left = timed[leftIndex];
      const right = timed[rightIndex];
      if (left.date !== right.date) continue;
      if (left.start < right.end && right.start < left.end) {
        conflictPairs.push({
          date: left.date,
          items: [computedItemSummary(left.item), computedItemSummary(right.item)],
        });
      }
    }
  }
  return { conflictPairs };
}

function incrementCount(bucket, key) {
  const normalized = text(key, '').trim();
  if (!normalized) return;
  bucket[normalized] = (bucket[normalized] || 0) + 1;
}

function buildDistributionComputed(items) {
  const byTag = {};
  const byList = {};
  items.forEach((item) => {
    itemTags(item).forEach((tag) => incrementCount(byTag, tag));
    incrementCount(byList, itemList(item));
  });
  return { byTag, byList };
}

function buildComputed(question, range, items) {
  let questionType = 'schedule-summary';
  if (/시간|알바|근무/.test(question)) questionType = 'work-hours';
  else if (!/미완료/.test(question) && /완료|비율|완료율/.test(question)) questionType = 'completion-rate';
  else if (/기한|마감|지났|임박|늦어|가까운/.test(question)) questionType = 'overdue';
  else if (/충돌|겹치/.test(question)) questionType = 'conflict';
  else if (/프로젝트별|비교|균형|작업량/.test(question)) questionType = 'distribution';
  const workItems = items.filter(isWorkItem);
  const countedItems = questionType === 'work-hours' ? workItems : items;
  const done = countedItems.filter(isDone).length;
  const total = countedItems.length;
  const workHours = workItems.reduce((sum, item) => sum + (durationHours(item) || 4), 0);
  return {
    range,
    total,
    done,
    undone: total - done,
    completionRate: total ? Math.round((done / total) * 1000) / 10 : 0,
    workCount: workItems.length,
    workHours: Math.round(workHours * 100) / 100,
    questionType,
    ...(questionType === 'overdue' ? buildDueComputed(countedItems) : {}),
    ...(questionType === 'conflict' ? buildConflictComputed(countedItems) : {}),
    ...(questionType === 'distribution' ? buildDistributionComputed(countedItems) : {}),
  };
}

function fallbackAnswer(question, computed, sources) {
  if (!sources.length) {
    return '아직 이 질문에 답할 일정/작업 기록이 없어요. 작업이나 일정에 날짜, 태그, 시작/종료 시간을 남기면 더 정확히 계산할 수 있습니다.';
  }
  if (computed.questionType === 'work-hours') {
    return `${computed.range.label} 기준으로 알바/근무 기록은 ${computed.workCount}건이고, 합계는 ${formatHours(computed.workHours)}(${computed.workHours}시간)입니다. 근거로는 ${sources.slice(0, 3).map((source) => source.title).join(', ')}를 사용했어요. 시작/종료 시간이 없는 근무는 1건당 4시간으로 추정합니다.`;
  }
  if (computed.questionType === 'completion-rate') {
    return `${computed.range.label} 기준 완료율은 ${computed.completionRate}%입니다. 전체 ${computed.total}건 중 ${computed.done}건이 완료됐고 ${computed.undone}건이 남아 있어요.`;
  }
  const next = sources.filter((source) => !source.done).slice(0, 3);
  if (/(추천|뭘|무엇|다음)/.test(question) && next.length) {
    return `지금 맥락에서는 ${next.map((source) => source.title).join(', ')} 순서로 처리하는 것을 추천해요. ${computed.range.label}의 관련 기록 ${computed.total}건을 기준으로 봤고, 완료된 일보다 남은 일을 우선했습니다.`;
  }
  return `${computed.range.label}의 관련 기록은 ${computed.total}건이고, 그중 ${computed.done}건이 완료됐습니다. 질문과 가장 가까운 근거는 ${sources.slice(0, 3).map((source) => source.title).join(', ')}입니다.`;
}

function noItemsContradiction(answer, sources) {
  if (!sources.length) return false;
  return /일정과\s*할\s*일이\s*(?:모두\s*)?없|일정\/할\s*일이\s*(?:모두\s*)?없|할\s*일이\s*(?:모두\s*)?없습니다|기록이\s*없어|기록\s*없음/.test(text(answer));
}

function openAiKey(env = process.env) {
  return text(env.OPENAI_API_KEY || env.HERMES_OPENAI_API_KEY || env.AGENT_CALENDAR_OPENAI_API_KEY).trim();
}

function openAiModel(env = process.env) {
  return text(env.OPENAI_CHAT_MODEL || env.HERMES_OPENAI_CHAT_MODEL || env.AGENT_CALENDAR_OPENAI_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
}

function localLlmModel(env = process.env) {
  return text(
    env.AGENT_CALENDAR_LOCAL_LLM_MODEL
    || env.HERMES_LOCAL_LLM_MODEL
    || env.LOCAL_LLM_MODEL
    || env.OLLAMA_MODEL
    || 'qwen2.5:7b'
  ).trim() || 'qwen2.5:7b';
}

function openAiBaseUrl(env = process.env) {
  return text(env.OPENAI_BASE_URL || env.HERMES_OPENAI_BASE_URL || env.AGENT_CALENDAR_OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/g, '');
}

function openAiOAuthUrl(env = process.env) {
  return text(
    env.AGENT_CALENDAR_OPENAI_OAUTH_URL
    || env.HERMES_OPENAI_OAUTH_URL
    || env.OPENAI_OAUTH_URL
    || env.RAILWAY_SERVICE_OPENAI_OAUTH_URL
  ).trim().replace(/\/+$/g, '');
}

function openAiOAuthKey(env = process.env) {
  return text(
    env.AGENT_CALENDAR_OPENAI_OAUTH_PROXY_API_KEY
    || env.HERMES_OPENAI_OAUTH_PROXY_API_KEY
    || env.OPENAI_OAUTH_PROXY_API_KEY
    || env.PROXY_API_KEY
  ).trim();
}

function localLlmUrl(env = process.env) {
  return text(
    env.AGENT_CALENDAR_LOCAL_LLM_URL
    || env.HERMES_LOCAL_LLM_URL
    || env.LOCAL_LLM_URL
    || env.OLLAMA_BASE_URL
  ).trim().replace(/\/+$/g, '');
}

function localLlmKey(env = process.env) {
  return text(
    env.AGENT_CALENDAR_LOCAL_LLM_API_KEY
    || env.HERMES_LOCAL_LLM_API_KEY
    || env.LOCAL_LLM_API_KEY
  ).trim();
}

function llmMaxTokens(env = process.env, provider = '') {
  const value = provider === 'local-llm'
    ? (env.AGENT_CALENDAR_LOCAL_LLM_MAX_TOKENS || env.HERMES_LOCAL_LLM_MAX_TOKENS || env.LOCAL_LLM_MAX_TOKENS || env.AGENT_CALENDAR_LLM_MAX_TOKENS || env.HERMES_LLM_MAX_TOKENS)
    : (env.AGENT_CALENDAR_LLM_MAX_TOKENS || env.HERMES_LLM_MAX_TOKENS || env.OPENAI_MAX_TOKENS);
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function localScheduleMaxTokens(env = process.env) {
  return llmMaxTokens(env, 'local-llm') || 220;
}

function llmTimeoutMs(env = process.env, provider = '') {
  const value = provider === 'local-llm'
    ? (env.AGENT_CALENDAR_LOCAL_LLM_TIMEOUT_MS || env.HERMES_LOCAL_LLM_TIMEOUT_MS || env.LOCAL_LLM_TIMEOUT_MS || env.AGENT_CALENDAR_LLM_TIMEOUT_MS || env.HERMES_LLM_TIMEOUT_MS)
    : (env.AGENT_CALENDAR_OPENAI_TIMEOUT_MS || env.HERMES_OPENAI_TIMEOUT_MS || env.OPENAI_TIMEOUT_MS || env.AGENT_CALENDAR_LLM_TIMEOUT_MS || env.HERMES_LLM_TIMEOUT_MS);
  const parsed = Number(value || 90000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 90000;
}

function openAiCompatibleBaseUrl(value) {
  const base = text(value).trim().replace(/\/+$/g, '');
  if (!base) return '';
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

function scheduleLlmConfigs(env = process.env) {
  const configs = [];
  const oauthUrl = openAiOAuthUrl(env);
  const oauthKey = openAiOAuthKey(env);
  if (oauthUrl && oauthKey) {
    configs.push({
      provider: 'openai-oauth',
      errorPrefix: 'openai_oauth_request_failed',
      baseUrl: openAiCompatibleBaseUrl(oauthUrl),
      apiKey: oauthKey,
      model: openAiModel(env),
      maxTokens: llmMaxTokens(env, 'openai-oauth'),
      timeoutMs: llmTimeoutMs(env, 'openai-oauth'),
    });
  }
  const localUrl = localLlmUrl(env);
  if (localUrl) {
    configs.push({
      provider: 'local-llm',
      errorPrefix: 'local_llm_request_failed',
      baseUrl: openAiCompatibleBaseUrl(localUrl),
      apiKey: localLlmKey(env),
      model: localLlmModel(env),
      maxTokens: localScheduleMaxTokens(env),
      timeoutMs: llmTimeoutMs(env, 'local-llm'),
    });
  }
  const apiKey = openAiKey(env);
  if (apiKey) {
    configs.push({
      provider: 'openai',
      errorPrefix: 'openai_request_failed',
      baseUrl: openAiBaseUrl(env),
      apiKey,
      model: openAiModel(env),
      maxTokens: llmMaxTokens(env, 'openai'),
      timeoutMs: llmTimeoutMs(env, 'openai'),
    });
  }
  return configs;
}

function scheduleLlmContextSources({ question, computed, sources }) {
  const records = Array.isArray(sources) ? sources : [];
  if (computed.questionType === 'completion-rate') {
    return records.filter((source) => source.done);
  }
  if (/미완료|남은|해야|할\s*일|할일/.test(question)) {
    return records.filter((source) => !source.done);
  }
  return records;
}

function scheduleContextText({ question, computed, sources }) {
  const contextSources = scheduleLlmContextSources({ question, computed, sources });
  const compactListContext = computed.questionType === 'completion-rate';
  const sourceLines = contextSources.map((source, index) => [
    `[${index + 1}] (${source.type || source.source || 'record'}) ${source.title}`,
    `date: ${source.date || 'unknown'}`,
    `done: ${source.done ? 'true' : 'false'}`,
    ...(!compactListContext ? [
      `time: ${source.time || ''}${source.endTime ? `-${source.endTime}` : ''}`,
      `list: ${source.list || ''}`,
      `tags: ${(source.tags || []).join(', ')}`,
      source.snippet ? `snippet: ${source.snippet}` : '',
    ] : []),
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    `질문: ${question}`,
    '',
    '정확 계산이 필요한 일정/작업 요약:',
    `기간: ${computed.range.label} (${computed.range.from || '처음'} ~ ${computed.range.to || '끝'})`,
    `일정/작업 전체: ${computed.total}`,
    `완료: ${computed.done}`,
    `미완료: ${computed.undone}`,
    `완료율: ${computed.completionRate}%`,
    `근무/알바 건수: ${computed.workCount}`,
    `근무/알바 시간: ${computed.workHours}`,
    '',
    'DB 검색 근거:',
    sourceLines || '관련 DB 기록 없음',
    '',
    '답변 요구:',
    '- 목록·완료 여부 질문은 한 문장 요약 뒤 관련 항목만 `- 제목 (날짜)` 형식으로 나열하라.',
    '- 목록의 항목 자체가 근거이므로 `(근거: ...)` 문구를 항목마다 반복하지 마라.',
    '- 분석·추천 질문에서만 판단에 필요한 근거를 한 번 인용하라.',
    '- 일정/작업 전체가 1건 이상이면 "일정/할 일이 없다"고 말하지 마라. 완료 0건은 기록 없음이 아니라 모두 미완료라는 뜻이다.',
    '- 사용자가 추천·계획을 물었을 때만 다음 액션을 제안하고, 요청하지 않은 해석이나 다음 액션은 덧붙이지 마라.',
    '- 사용자가 상세 설명을 요청하지 않았다면 120어절 이내로 간결하게 답하라.',
  ].join('\n');
}

async function callScheduleLlm({ llm, messages, fetchImpl }) {
  const headers = {
    'content-type': 'application/json',
  };
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llm.timeoutMs || 90000);
  let response;
  try {
    response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.35,
        ...(llm.maxTokens ? { max_tokens: llm.maxTokens } : {}),
        messages,
      }),
    });
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      const timeoutError = new Error(`${llm.errorPrefix}:timeout:${llm.timeoutMs || 90000}`);
      timeoutError.llm = llm;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    const error = new Error(`${llm.errorPrefix}:${response.status}:${body.slice(0, 160)}`);
    error.llm = llm;
    throw error;
  }
  const payload = await response.json();
  return text(payload?.choices?.[0]?.message?.content).trim();
}

function scheduleSystemPrompt() {
  return [
    '너는 사용자의 개인 캘린더 AI다.',
    '할 일, 일정, 캘린더 이벤트 등 제공된 DB 기록만 근거로 답하라.',
    '숫자·시간·비율 질문은 제공된 정확 계산값을 우선 사용하고, 그 숫자가 의미하는 바를 설명하라.',
    '일정/작업 전체가 1건 이상이면 기록이 없다고 말하지 마라. 완료 0건은 모든 항목이 미완료라는 뜻이다.',
    'DB 근거가 부족한 부분은 추측하지 말고 부족한 지점을 분명히 말하되, 이미 있는 근거에서 가능한 판단은 끝까지 해라.',
    '목록 질문에는 한 문장 요약 뒤 관련 항목의 제목과 날짜만 나열하라.',
    '목록의 항목 자체가 근거이므로 근거 문구를 항목마다 반복하지 마라.',
    '분석·추천 질문에서만 판단 근거를 한 번 인용하라.',
    '사용자가 추천·계획을 물었을 때만 다음 액션을 제안하고, 요청하지 않은 해석이나 다음 액션은 덧붙이지 마라.',
    '상세 설명 요청이 없다면 120어절 이내로 자연스럽고 간결하게 답하라.',
  ].join('\n');
}

function scheduleLlmMessages({ question, computed, sources, retryInstruction = '' }) {
  return [
    {
      role: 'system',
      content: scheduleSystemPrompt(),
    },
    {
      role: 'user',
      content: [
        scheduleContextText({ question, computed, sources }),
        retryInstruction,
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

async function synthesizeScheduleAnswerWithConfig({ llm, question, computed, sources, fetchImpl = fetch } = {}) {
  if (!llm) return null;
  const answer = await callScheduleLlm({
    llm,
    fetchImpl,
    messages: scheduleLlmMessages({ question, computed, sources }),
  });
  if (!answer) return null;
  if (!noItemsContradiction(answer, sources)) {
    return {
      answer,
      answerMode: 'llm',
      llm: { provider: llm.provider, model: llm.model, used: true },
    };
  }
  const retry = await callScheduleLlm({
    llm,
    fetchImpl,
    messages: scheduleLlmMessages({
      question,
      computed,
      sources,
      retryInstruction: `sources가 ${sources.length}건 존재한다. 없다고 말하지 말고 다시 답하라.`,
    }),
  });
  if (retry && !noItemsContradiction(retry, sources)) {
    return {
      answer: retry,
      answerMode: 'llm-retry',
      llm: { provider: llm.provider, model: llm.model, used: true },
    };
  }
  return {
    answer: fallbackAnswer(question, computed, sources),
    answerMode: 'fallback',
    llm: {
      provider: llm.provider,
      model: llm.model,
      used: false,
      error: 'no_items_contradiction_after_retry',
    },
  };
}

async function synthesizeScheduleAnswer({ question, computed, sources, env = process.env, fetchImpl = fetch } = {}) {
  const configs = scheduleLlmConfigs(env);
  if (!configs.length) return null;
  const attempts = [];
  for (const llm of configs) {
    try {
      const synthesis = await synthesizeScheduleAnswerWithConfig({
        llm,
        question,
        computed,
        sources,
        fetchImpl,
      });
      if (synthesis?.answer) {
        return {
          ...synthesis,
          attempts: [
            ...attempts,
            { provider: llm.provider, model: llm.model, used: Boolean(synthesis.llm?.used), ...(synthesis.llm?.error ? { error: synthesis.llm.error } : {}) },
          ],
        };
      }
      attempts.push({ provider: llm.provider, model: llm.model, used: false, error: 'empty_llm_answer' });
    } catch (error) {
      attempts.push({
        provider: llm.provider,
        model: llm.model,
        used: false,
        error: error.message || String(error),
      });
    }
  }
  const error = new Error(attempts.map((attempt) => attempt.error).filter(Boolean).join(' | ') || 'llm_unavailable');
  const lastAttempt = attempts[attempts.length - 1];
  error.llm = lastAttempt || configs[configs.length - 1];
  error.attempts = attempts;
  throw error;
}

async function buildScheduleAssistantContext({ question, filters = {}, state = {}, env = process.env, fetchImpl = fetch } = {}) {
  const q = text(question).trim();
  const range = questionRange(q, filters);
  const scopedScheduleItems = applyFilters(scheduleItemsFromState(state), filters, range);
  const scopedRecords = applyRecordFilters(calendarAiRecordsFromState(state), filters, range);
  const { records, embeddingModel } = await relevantContextRecords(q, scopedRecords, scopedScheduleItems, { env, fetchImpl, range });
  const sources = records.map(normalizeSource);
  const computed = buildComputed(q, range, scopedScheduleItems);
  return {
    ok: true,
    answer: fallbackAnswer(q, computed, sources),
    answerMode: 'fallback',
    sources,
    computed,
    search: {
      strategy: 'backend-calendar-ai-rag',
      intent: 'ask',
      embeddingModel,
      candidateCount: scopedRecords.length,
      scheduleCandidateCount: scopedScheduleItems.length,
      sourceCount: sources.length,
    },
  };
}

async function buildScheduleAssistantAnswer({ question, filters = {}, state = {}, env = process.env, fetchImpl = fetch } = {}) {
  const result = await buildScheduleAssistantContext({ question, filters, state, env, fetchImpl });
  const configuredLlms = scheduleLlmConfigs(env);
  try {
    const synthesis = await synthesizeScheduleAnswer({
      question: text(question).trim(),
      computed: result.computed,
      sources: result.sources,
      env,
      fetchImpl,
    });
    if (synthesis?.answer) {
      return {
        ...result,
        answer: synthesis.answer,
        answerMode: synthesis.answerMode || 'llm',
        llm: synthesis.llm,
        ...(synthesis.attempts ? { llmAttempts: synthesis.attempts } : {}),
      };
    }
  } catch (error) {
    const llm = error.llm || configuredLlms[configuredLlms.length - 1] || { provider: 'openai', model: openAiModel(env) };
    return {
      ...result,
      llm: {
        provider: llm.provider,
        model: llm.model,
        used: false,
        error: error.message || String(error),
      },
      answerMode: 'fallback',
      ...(error.attempts ? { llmAttempts: error.attempts } : {}),
    };
  }
  return {
    ...result,
    llm: {
      provider: 'none',
      model: '',
      used: false,
    },
    answerMode: 'fallback',
  };
}

function isScheduleQuestion(value) {
  const message = text(value).trim();
  if (!message) return false;
  if (/^(추가|위임|만들어|잡아|생성|넣어|등록|실행|보내|작성)\b/.test(message)) return false;
  return /[?？]$/.test(message)
    || /(몇|얼마|뭐|무엇|어떻게|언제|왜|추천|알려줘|비율|평균|총|완료율|시간|했지|했어|어때)/.test(message);
}

module.exports = {
  buildScheduleAssistantAnswer,
  fallbackAnswer,
  isScheduleQuestion,
  localLlmModel,
  noItemsContradiction,
  scheduleLlmMessages,
};
