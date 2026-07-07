const VECTOR_DIMENSIONS = 256;

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

function vectorSearch(items, question, limit = 8) {
  const queryVector = embed(question);
  return items
    .map((item, index) => {
      const source = itemSearchText(item);
      return { item, index, score: cosine(queryVector, embed(source)) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
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

function normalizeSource(item, index) {
  const sourceType = text(item.sourceType || item.kind || item.type || item.source || 'record');
  return {
    id: itemId(item, `schedule-${index}`),
    title: itemTitle(item),
    type: sourceType,
    date: itemDate(item),
    time: itemTime(item),
    endTime: itemEndTime(item),
    status: itemStatus(item),
    done: isDone(item),
    tags: itemTags(item),
    list: itemList(item),
    source: sourceType,
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

function scheduleItemsFromState(state = {}) {
  return dedupeItems([
    ...array(state.tasks),
    ...array(state.events),
    ...array(state.calendarEvents),
    ...array(state.ticktickTasks),
    ...array(state.externalCalendarEvents),
  ]);
}

function recordFromScheduleItem(item, index, type) {
  const sourceType = text(item.sourceType || item.kind || item.type || type || 'schedule');
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
    ...array(state.documents).map(recordFromDocument),
    ...array(state.runs).map(recordFromRun),
    ...array(state.chatMessages).map(recordFromChatMessage),
    ...array(state.mailMessages).map(recordFromMailMessage),
    ...array(state.workboardPages).map(recordFromWorkboardPage),
    ...array(state.agents).map(recordFromAgent),
    ...array(state.schedulerJobs).map(recordFromSchedulerJob),
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

function relevantItems(question, scopedItems) {
  if (/시간|알바|근무/.test(question)) return scopedItems.filter(isWorkItem);
  const searched = vectorSearch(scopedItems, question, 12);
  return searched.length ? searched : scopedItems.slice(0, 12);
}

function isScheduleFirstQuestion(question) {
  return /일정|할\s*일|할일|캘린더|오늘|내일|이번|우선순위|회의|완료|완료율|기한|병원|알바|근무|시간|리스크|체크리스트|작업|계획|브리핑/.test(question);
}

function isScheduleSource(record) {
  return /task|calendar|event|ticktick|schedule/i.test(text(record.sourceType || record.type || record.source));
}

function relevantContextRecords(question, scopedRecords, scopedScheduleItems) {
  const directScheduleItems = relevantItems(question, scopedScheduleItems).map((item, index) => recordFromScheduleItem(item, index, text(item.kind || item.type || item.source || 'schedule')));
  const searched = vectorSearch(scopedRecords, question, 16);
  const scheduleFirst = isScheduleFirstQuestion(question);
  const searchedSchedule = searched.filter(isScheduleSource);
  const searchedWithoutChat = searched.filter((record) => {
    const sourceType = text(record.sourceType || record.type || record.source);
    return sourceType !== 'chat-message' && !/wiki/i.test(sourceType);
  });
  const combined = scheduleFirst
    ? [...directScheduleItems, ...searchedSchedule, ...(directScheduleItems.length || searchedSchedule.length ? [] : searchedWithoutChat)]
    : [...searched, ...directScheduleItems.slice(0, 4)];
  return dedupeItems(combined).slice(0, 18);
}

function formatHours(hours) {
  const rounded = Math.round(hours * 100) / 100;
  const whole = Math.floor(rounded);
  const minutes = Math.round((rounded - whole) * 60);
  if (minutes > 0) return `${whole}시간 ${minutes}분`;
  return `${rounded}시간`;
}

function buildComputed(question, range, items) {
  const questionType = /시간|알바|근무/.test(question)
    ? 'work-hours'
    : (/완료|비율|완료율/.test(question) ? 'completion-rate' : 'schedule-summary');
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

function repairContradictoryScheduleAnswer(question, computed, sources) {
  const topSources = sources.slice(0, 5);
  const pending = topSources.filter((source) => !source.done);
  const done = topSources.filter((source) => source.done);
  const evidence = topSources.map((source, index) => {
    const date = source.date ? `${source.date}${source.time ? ` ${source.time}` : ''}` : '날짜 미상';
    const status = source.done ? '완료' : '미완료';
    return `[${index + 1}] ${source.title} (${date}, ${status})`;
  }).join(', ');
  const firstAction = pending[0] || topSources[0];
  const secondAction = pending[1] || topSources[1];
  const actionText = [firstAction, secondAction].filter(Boolean).map((source, index) => (
    `${index + 1}. ${source.title}: ${source.date || computed.range.label} 기준 ${source.done ? '이미 완료된 근거로 후속 확인만 하면 됩니다' : '아직 미완료이므로 먼저 상태와 필요한 준비물을 확인하세요'}`
  )).join('\n');
  return [
    `${computed.range.label} DB에는 질문과 관련된 일정/할 일이 ${computed.total}건 있고, 그중 완료 ${computed.done}건, 미완료 ${computed.undone}건입니다. 따라서 기록이 없는 상황이 아니라, 남아 있는 항목을 기준으로 우선순위를 잡아야 하는 상황입니다.`,
    `핵심 근거는 ${evidence}입니다. 이 근거를 보면 ${computed.range.label}의 중심은 ${topSources[0]?.title || '확인된 일정'}이고, ${pending.length ? `아직 미완료 항목이 ${pending.length}건 남아 있어 실행 순서를 정하는 것이 중요합니다` : `확인된 상위 근거는 모두 완료 상태라 후속 확인이나 다음 일정 정리가 중요합니다`}. ${done.length ? `이미 완료된 항목 ${done.length}건은 진행 이력으로 보고, 남은 항목과 충돌하지 않는지 확인하면 됩니다.` : '완료된 항목이 없으므로 오늘은 실행을 시작하고 완료 상태를 남기는 것이 핵심입니다.'}`,
    `바로 할 다음 액션은 아래처럼 잡는 것이 좋습니다.\n${actionText || '1. 상위 근거의 날짜와 상태를 확인하고, 실제 실행 가능한 첫 작업으로 쪼개세요.'}`,
    `질문 "${question}"에 대한 결론은, 일정이 비어 있는 것이 아니라 DB에 남은 일정/할 일이 있으므로 가장 가까운 날짜와 미완료 상태를 기준으로 먼저 처리할 항목을 고르는 것입니다.`
  ].join('\n\n');
}

function ensureScheduleAnswerQuality({ question, computed, sources, answer }) {
  if (noItemsContradiction(answer, sources)) {
    return repairContradictoryScheduleAnswer(question, computed, sources);
  }
  return answer;
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
      maxTokens: Math.max(llmMaxTokens(env, 'local-llm'), 700),
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

function scheduleContextText({ question, computed, sources }) {
  const sourceLines = sources.map((source, index) => [
    `[${index + 1}] (${source.type || source.source || 'record'}) ${source.title}`,
    `id: ${source.id}`,
    `date: ${source.date || 'unknown'}`,
    `time: ${source.time || ''}${source.endTime ? `-${source.endTime}` : ''}`,
    `done: ${source.done ? 'true' : 'false'}`,
    `list: ${source.list || ''}`,
    `tags: ${(source.tags || []).join(', ')}`,
    source.snippet ? `snippet: ${source.snippet}` : '',
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
    '- 한국어로 최소 450자 이상 답하라.',
    '- 일정/작업 전체가 1건 이상이면 "일정/할 일이 없다"고 말하지 마라. 완료 0건은 기록 없음이 아니라 모두 미완료라는 뜻이다.',
    '- 첫 문단에는 전체 판단을 요약하라.',
    '- 이어서 DB 근거를 2개 이상 언급하고, 그 근거가 왜 중요한지 해석하라.',
    '- 마지막에는 사용자가 바로 실행할 수 있는 다음 액션을 제안하라.',
  ].join('\n');
}

function answerCharLength(value) {
  return text(value).replace(/\s/g, '').length;
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

async function expandScheduleAnswerIfShort({ llm, question, computed, sources, answer, fetchImpl }) {
  const minimumChars = 450;
  if (llm.provider !== 'local-llm') return answer;
  if (answerCharLength(answer) >= minimumChars) return answer;
  const expanded = await callScheduleLlm({
    llm,
    fetchImpl,
    messages: [
      {
        role: 'system',
        content: [
          '너는 사용자의 개인 캘린더 AI다.',
          '이미 작성된 답변을 같은 DB 근거만 사용해서 더 깊고 충분하게 확장하라.',
          '한국어로 최소 550자 이상 답하라. 핵심 판단, DB 근거 2개 이상, 해석, 바로 실행할 다음 액션을 포함하라.',
          '새로운 사실을 꾸미지 말고, 근거가 부족한 부분은 부족하다고 말하라.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          scheduleContextText({ question, computed, sources }),
          '',
          '초안 답변:',
          answer,
          '',
          '위 초안을 더 길고 구체적인 최종 답변으로 다시 작성하라.',
        ].join('\n'),
      },
    ],
  });
  return expanded || answer;
}

async function synthesizeScheduleAnswerWithConfig({ llm, question, computed, sources, fetchImpl = fetch } = {}) {
  if (!llm) return null;
  const answer = await callScheduleLlm({
    llm,
    fetchImpl,
    messages: [
      {
        role: 'system',
        content: [
          '너는 사용자의 개인 캘린더 AI다.',
          '할 일, 일정, 캘린더 이벤트 등 제공된 DB 기록만 근거로 답하라.',
              '질문마다 맥락을 해석해서 GPT 수준의 충분한 길이로 답하라. 최소 450자 이상, 보통 2~4개 문단 또는 5~9개 문장으로, 핵심 판단과 이유와 다음 액션을 포함한다.',
              '답변 형식을 고정하지 말고 질문 의도에 맞춰 자연스럽게 구조화하라. 필요한 경우 짧은 번호 목록을 써도 된다.',
              '숫자·시간·비율 질문은 제공된 정확 계산값을 우선 사용하고, 그 숫자가 의미하는 바를 설명하라.',
              '일정/작업 전체가 1건 이상이면 기록이 없다고 말하지 마라. 완료 0건은 모든 항목이 미완료라는 뜻이다.',
              'DB 근거가 부족한 부분은 추측하지 말고 부족한 지점을 분명히 말하되, 이미 있는 근거에서 가능한 판단은 끝까지 해라.',
            ].join('\n'),
      },
      {
        role: 'user',
        content: scheduleContextText({ question, computed, sources }),
      },
    ],
  });
  const finalAnswer = answer
    ? await expandScheduleAnswerIfShort({ llm, question, computed, sources, answer, fetchImpl })
    : '';
  return finalAnswer ? { answer: finalAnswer, llm: { provider: llm.provider, model: llm.model, used: true } } : null;
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
            { provider: llm.provider, model: llm.model, used: true },
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

function buildScheduleAssistantContext({ question, filters = {}, state = {} } = {}) {
  const q = text(question).trim();
  const range = questionRange(q, filters);
  const scopedScheduleItems = applyFilters(scheduleItemsFromState(state), filters, range);
  const scopedRecords = applyRecordFilters(calendarAiRecordsFromState(state), filters, range);
  const records = relevantContextRecords(q, scopedRecords, scopedScheduleItems);
  const sources = records.map(normalizeSource);
  const computed = buildComputed(q, range, scopedScheduleItems);
  return {
    ok: true,
    answer: fallbackAnswer(q, computed, sources),
    sources,
    computed,
    search: {
      strategy: 'backend-calendar-ai-rag',
      candidateCount: scopedRecords.length,
      scheduleCandidateCount: scopedScheduleItems.length,
      sourceCount: sources.length,
    },
  };
}

async function buildScheduleAssistantAnswer({ question, filters = {}, state = {}, env = process.env, fetchImpl = fetch } = {}) {
  const result = buildScheduleAssistantContext({ question, filters, state });
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
      const answer = ensureScheduleAnswerQuality({
        question: text(question).trim(),
        computed: result.computed,
        sources: result.sources,
        answer: synthesis.answer,
      });
      return {
        ...result,
        answer,
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
  isScheduleQuestion,
};
