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
  return text(item.title || item.name || item.summary || item.subject || item.label, '일정');
}

function itemDate(item) {
  return firstDate(item.date || item.startDate || item.day || item.due || item.start || item.completedAt || item.completedTime);
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
  if (explicitFrom || explicitTo) return { from: explicitFrom, to: explicitTo, label: '선택한 기간' };

  const today = todayKey();
  const current = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = current.getUTCDay() || 7;
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

function inRange(item, range) {
  if (!range.from && !range.to) return true;
  const date = itemDate(item);
  if (!date) return false;
  return (!range.from || date >= range.from) && (!range.to || date <= range.to);
}

function normalizeSource(item, index) {
  return {
    id: itemId(item, `schedule-${index}`),
    title: itemTitle(item),
    date: itemDate(item),
    time: itemTime(item),
    endTime: itemEndTime(item),
    status: itemStatus(item),
    done: isDone(item),
    tags: itemTags(item),
    list: itemList(item),
    source: text(item.source || item.kind || item.type || 'schedule'),
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

function relevantItems(question, scopedItems) {
  if (/시간|알바|근무/.test(question)) return scopedItems.filter(isWorkItem);
  const searched = vectorSearch(scopedItems, question, 12);
  return searched.length ? searched : scopedItems.slice(0, 12);
}

function formatHours(hours) {
  const rounded = Math.round(hours * 100) / 100;
  const whole = Math.floor(rounded);
  const minutes = Math.round((rounded - whole) * 60);
  if (minutes > 0) return `${whole}시간 ${minutes}분`;
  return `${rounded}시간`;
}

function buildComputed(question, range, items) {
  const done = items.filter(isDone).length;
  const total = items.length;
  const workItems = items.filter(isWorkItem);
  const workHours = workItems.reduce((sum, item) => sum + (durationHours(item) || 4), 0);
  return {
    range,
    total,
    done,
    undone: total - done,
    completionRate: total ? Math.round((done / total) * 1000) / 10 : 0,
    workCount: workItems.length,
    workHours: Math.round(workHours * 100) / 100,
    questionType: /시간|알바|근무/.test(question)
      ? 'work-hours'
      : (/완료|비율|완료율/.test(question) ? 'completion-rate' : 'schedule-summary'),
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

function openAiKey(env = process.env) {
  return text(env.OPENAI_API_KEY || env.HERMES_OPENAI_API_KEY || env.AGENT_CALENDAR_OPENAI_API_KEY).trim();
}

function openAiModel(env = process.env) {
  return text(env.OPENAI_CHAT_MODEL || env.HERMES_OPENAI_CHAT_MODEL || env.AGENT_CALENDAR_OPENAI_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
}

function openAiBaseUrl(env = process.env) {
  return text(env.OPENAI_BASE_URL || env.HERMES_OPENAI_BASE_URL || env.AGENT_CALENDAR_OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/g, '');
}

function scheduleContextText({ question, computed, sources }) {
  const sourceLines = sources.map((source, index) => [
    `[${index + 1}] ${source.title}`,
    `id: ${source.id}`,
    `date: ${source.date || 'unknown'}`,
    `time: ${source.time || ''}${source.endTime ? `-${source.endTime}` : ''}`,
    `done: ${source.done ? 'true' : 'false'}`,
    `list: ${source.list || ''}`,
    `tags: ${(source.tags || []).join(', ')}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    `질문: ${question}`,
    '',
    '계산 요약:',
    `기간: ${computed.range.label} (${computed.range.from || '처음'} ~ ${computed.range.to || '끝'})`,
    `전체: ${computed.total}`,
    `완료: ${computed.done}`,
    `미완료: ${computed.undone}`,
    `완료율: ${computed.completionRate}%`,
    `근무/알바 건수: ${computed.workCount}`,
    `근무/알바 시간: ${computed.workHours}`,
    '',
    '근거 목록:',
    sourceLines || '관련 일정/작업 없음',
  ].join('\n');
}

async function synthesizeScheduleAnswer({ question, computed, sources, env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = openAiKey(env);
  if (!apiKey) return null;
  const model = openAiModel(env);
  const response = await fetchImpl(`${openAiBaseUrl(env)}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            '너는 사용자의 할 일·일정 데이터를 분석하는 비서다.',
            '아래 데이터만 근거로 한국어 3~5문장으로 답하라.',
            '숫자 질문은 제공된 계산값을 우선 사용하고 명확한 값으로 답하라.',
            '데이터에 없는 것은 추측하지 말고, 무엇을 더 기록하면 되는지 알려줘라.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: scheduleContextText({ question, computed, sources }),
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`openai_request_failed:${response.status}:${body.slice(0, 160)}`);
  }
  const payload = await response.json();
  const answer = text(payload?.choices?.[0]?.message?.content).trim();
  return answer ? { answer, llm: { provider: 'openai', model, used: true } } : null;
}

function buildScheduleAssistantContext({ question, filters = {}, state = {} } = {}) {
  const q = text(question).trim();
  const range = questionRange(q, filters);
  const scopedItems = applyFilters(scheduleItemsFromState(state), filters, range);
  const items = relevantItems(q, scopedItems);
  const sources = items.map(normalizeSource);
  const computed = buildComputed(q, range, items);
  return {
    ok: true,
    answer: fallbackAnswer(q, computed, sources),
    sources,
    computed,
    search: {
      strategy: 'backend-schedule-rag',
      candidateCount: scopedItems.length,
      sourceCount: sources.length,
    },
  };
}

async function buildScheduleAssistantAnswer({ question, filters = {}, state = {}, env = process.env, fetchImpl = fetch } = {}) {
  const result = buildScheduleAssistantContext({ question, filters, state });
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
        llm: synthesis.llm,
      };
    }
  } catch (error) {
    return {
      ...result,
      llm: {
        provider: 'openai',
        model: openAiModel(env),
        used: false,
        error: error.message || String(error),
      },
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
