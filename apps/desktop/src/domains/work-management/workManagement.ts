import type { ApiEnvelope } from '../../api/hermesApi';

export type WorkItem = Record<string, unknown>;
export type TaxonomyKind = 'list' | 'tag';
export type TaxonomyItem = {
  id: string;
  label: string;
  icon: string;
  group: string;
  kind: TaxonomyKind;
  recordId?: string;
  hidden?: boolean;
};

export type ScheduleQuestionSummary = {
  scopeLabel: string;
  from: string;
  to: string;
  total: number;
  done: number;
  todo: number;
  workHours: number;
  workCount: number;
  summary: string;
  list: string;
  sources: WorkItem[];
};

export const APP_TIME_ZONE = 'Asia/Seoul';
export const TAXONOMY_SOURCE = 'hermes-desktop-taxonomy';
const CALENDAR_META_MARKER = '[Agent Calendar]\n';

function text(value: unknown, fallback = '') {
  return String(value || fallback);
}

function itemTitle(item: WorkItem, fallback = '항목') {
  return text(item.title || item.goal || item.name || item.subject || item.label || item.text || item.path, fallback);
}

function itemId(item: WorkItem, fallback: string) {
  return text(item.id || item._id || item.key || item.path, fallback);
}

function nestedItem(item: WorkItem, ...keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as WorkItem;
  }
  return null;
}

export function normalizeCalendarEvent(item: WorkItem): WorkItem {
  const nested = nestedItem(item, 'event', 'calendarEvent', 'task');
  const source = text(item.source || nested?.source || 'calendar-event');
  return {
    ...(nested || item),
    id: itemId(nested || item, itemId(item, '')),
    kind: 'calendar-event',
    type: 'calendar-event',
    source,
  };
}

export function isDone(item: WorkItem) {
  return /done|complete|completed|ok|완료/i.test(text(item.status || item.lane || item.lastStatus));
}

export function taskOwner(item: WorkItem) {
  const owner = text(item.owner || item.agent || item.agentId, 'Me');
  if (/agent|default|bizconsultant|stockagent|uniportpm|wikicurator|Hermes|Agent Calendar/i.test(owner)) return 'Agent';
  if (/hybrid|joint|공동/i.test(owner)) return 'Hybrid';
  return 'Me';
}

export function dateKeyInTimeZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function todayKey() {
  return dateKeyInTimeZone();
}

export function dateLabel(offset = 0) {
  const day = new Date(`${todayKey()}T00:00:00`);
  day.setDate(day.getDate() + offset);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: APP_TIME_ZONE, month: 'long', day: 'numeric', weekday: 'short' }).format(day);
}

export function todayMetaLabel() {
  const day = new Date(`${todayKey()}T00:00:00`);
  const label = new Intl.DateTimeFormat('ko-KR', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(day);
  return label.replace(/\s([월화수목금토일])$/, ' ($1)');
}

export function formatTime(value: string) {
  if (!value) return '';
  const [hourRaw, minute = '00'] = value.split(':');
  const hour = Number(hourRaw);
  const period = hour < 12 ? '오전' : '오후';
  return `${period} ${hour % 12 || 12}:${minute}`;
}

export function formatDateChip(value: string) {
  if (!value) return '날짜 추가';
  const date = new Date(`${value}T00:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export function formatUpdatedStamp(value: string) {
  if (!value) return '방금 수정';
  const datePart = value.includes('T') ? value.split('T')[0] : value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return `${formatDateChip(datePart)} 수정`;
  return value.length > 16 ? '최근 수정' : value;
}

export function repeatLabel(value: string) {
  return ({ none: '안 함', daily: '매일', weekday: '평일', weekly: '매주', monthly: '매월' } as Record<string, string>)[value] || '안 함';
}

export function addDaysKey(date: string, offset: number) {
  const day = new Date(`${date}T00:00:00`);
  day.setDate(day.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
}

export function quickDatePreset(kind: 'today' | 'tomorrow' | 'nextWeek' | 'evening', _baseDate = todayKey()) {
  if (kind === 'tomorrow') return { date: addDaysKey(todayKey(), 1), time: '' };
  if (kind === 'nextWeek') return { date: addDaysKey(todayKey(), 7), time: '' };
  if (kind === 'evening') return { date: todayKey(), time: '18:00' };
  return { date: todayKey(), time: '' };
}

export function addMonthsKey(date: string, offset: number) {
  const day = new Date(`${date}T00:00:00`);
  day.setMonth(day.getMonth() + offset);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
}

export function weekRangeLabel(date = todayKey()) {
  const day = new Date(`${date}T00:00:00`);
  const dayOfWeek = day.getDay() || 7;
  day.setDate(day.getDate() - dayOfWeek + 1);
  const start = new Date(day);
  const end = new Date(day);
  end.setDate(start.getDate() + 6);
  const format = (value: Date) => new Intl.DateTimeFormat('ko-KR', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value).replace(/\. /g, '.').replace(/\.$/, '');
  return `${format(start)} - ${format(end)}`;
}

export function scheduleQuestionRange(question: string) {
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

export function scheduleItemDate(item: WorkItem) {
  const value = text(item.date || item.startDate || item.day || item.due);
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : value.slice(0, 10);
}

export function inScheduleRange(item: WorkItem, from: string, to: string) {
  if (!from && !to) return true;
  const date = scheduleItemDate(item);
  return Boolean(date) && (!from || date >= from) && (!to || date <= to);
}

export function scheduleItemDurationHours(item: WorkItem) {
  const startTime = text(item.time || item.t);
  const endTime = text(item.endTime || item.tEnd || calendarMetadata(item).endTime);
  if (!startTime || !endTime) return 0;
  const [startHour = 0, startMinute = 0] = startTime.split(':').map((part) => Number(part) || 0);
  const [endHour = 0, endMinute = 0] = endTime.split(':').map((part) => Number(part) || 0);
  const minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  return minutes > 0 ? minutes / 60 : 0;
}

export function isWorkItem(item: WorkItem) {
  return /알바|근무|work|shift/i.test([
    itemTitle(item, ''),
    taskListName(item),
    taskTags(item).join(' '),
    text(item.notes || item.description),
  ].join(' '));
}

export function taskDataSummary(question: string, items: WorkItem[]): ScheduleQuestionSummary {
  const range = scheduleQuestionRange(question);
  const scoped = items.filter((item) => inScheduleRange(item, range.from, range.to));
  const done = scoped.filter(isDone).length;
  const todo = scoped.length - done;
  const workItems = scoped.filter(isWorkItem);
  const workHours = workItems.reduce((sum, item) => sum + (scheduleItemDurationHours(item) || 4), 0);
  const list = scoped.slice(0, 20).map((item, index) => {
    const tags = taskTags(item);
    return [
      `${index + 1}. ${itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}`,
      scheduleItemDate(item) || '날짜 없음',
      text(item.time || ''),
      isDone(item) ? '완료' : '미완료',
      taskListName(item) || text(item.source || ''),
      tags.length ? `#${tags.join(' #')}` : '',
    ].filter(Boolean).join(' · ');
  }).join('\n');
  const pct = Math.round((done / Math.max(scoped.length, 1)) * 100);
  return {
    scopeLabel: range.label,
    from: range.from,
    to: range.to,
    total: scoped.length,
    done,
    todo,
    workHours,
    workCount: workItems.length,
    summary: `${range.label} 기준 전체 ${scoped.length}개, 완료 ${done}개, 미완료 ${todo}개, 완료율 ${pct}%, 근무/알바 ${workItems.length}건 ${Number.isInteger(workHours) ? workHours : workHours.toFixed(1)}시간`,
    list,
    sources: scoped.slice(0, 10),
  };
}

export function fallbackAnswer(question: string, summary: ScheduleQuestionSummary) {
  if (!summary.total) return '아직 해당 범위에 기록이 없어요. 먼저 작업이나 일정을 추가하면 그 데이터를 기준으로 답할 수 있어요.';
  const rate = Math.round((summary.done / Math.max(summary.total, 1)) * 100);
  if (/시간|알바|근무/.test(question)) {
    const hours = Number.isInteger(summary.workHours) ? String(summary.workHours) : summary.workHours.toFixed(1);
    const basis = summary.workCount ? `${summary.workCount}건 기준` : `${summary.scopeLabel} 기록 기준`;
    return `${summary.scopeLabel} 알바/근무 시간은 ${hours}시간으로 계산돼요. 근거: ${basis}. 시작~종료 시간이 없는 근무 기록은 회당 4시간으로 추정했어요.`;
  }
  if (/완료|완료율|비율|평균/.test(question)) {
    return `${summary.scopeLabel} 완료율은 ${rate}%예요. ${summary.done}/${summary.total} 완료, 미완료 ${summary.todo}개입니다.\n근거: ${summary.scopeLabel} 작업 ${summary.total}개.`;
  }
  if (/추천|뭐|무엇|다음|할\s*일|할일/.test(question)) {
    const next = summary.sources
      .filter((item) => !isDone(item))
      .sort((a, b) => `${scheduleItemDate(a) || '9999-99-99'}:${Number(b.pri || b.priority || 0)}`.localeCompare(`${scheduleItemDate(b) || '9999-99-99'}:${Number(a.pri || a.priority || 0)}`))
      .slice(0, 3);
    if (!next.length) return `${summary.scopeLabel}에는 남은 작업이 없어요. 완료된 ${summary.done}개 기록을 보면 지금은 새 목표를 잡아도 괜찮아 보여요.\n근거: ${summary.scopeLabel} 작업 ${summary.total}개.`;
    return [
      `${summary.scopeLabel} 기준으로 다음에 하면 좋은 건 ${next.length}개예요.`,
      ...next.map((item, index) => `${index + 1}. ${itemTitle(item, '작업')}${scheduleItemDate(item) ? ` (${scheduleItemDate(item)})` : ''}`),
      `근거: 미완료 작업 ${summary.todo}개 중 날짜가 가까운 항목을 우선으로 골랐어요.`,
    ].join('\n');
  }
  return `${summary.summary}입니다.\n근거: ${summary.scopeLabel} 작업 ${summary.total}개.`;
}

export function parseQuick(textValue: string, fallbackDate?: string) {
  let title = textValue;
  let date = fallbackDate || '';
  let time = '';
  const tags: string[] = [];
  let owner = 'Me';
  let repeat = 'none';
  let priority = '';
  title = title.replace(/#(\S+)/g, (_, tag: string) => { tags.push(tag); return ''; });
  if (/@(hermes|agent|codex|에이전트)/i.test(title)) owner = 'Agent';
  title = title.replace(/@\S+/g, '');
  if (/!높음|!high|p1/i.test(title)) priority = 'P1';
  if (/!중간|!med|p2/i.test(title)) priority = 'P2';
  if (/!낮음|!low|p3/i.test(title)) priority = 'P3';
  title = title.replace(/!(높음|중간|낮음|high|med|low)|p[123]/gi, '');
  if (/평일/.test(title)) repeat = 'weekday';
  else if (/매일|daily/i.test(title)) repeat = 'daily';
  else if (/매주|weekly/i.test(title)) repeat = 'weekly';
  else if (/매월|매달|monthly/i.test(title)) repeat = 'monthly';
  title = title.replace(/평일|매일|매주|매월|매달|daily|weekly|monthly/gi, '');
  if (/오늘/.test(title)) { date = todayKey(); title = title.replace(/오늘/g, ''); }
  if (/내일/.test(title)) { date = addDaysKey(todayKey(), 1); title = title.replace(/내일/g, ''); }
  if (/모레/.test(title)) { date = addDaysKey(todayKey(), 2); title = title.replace(/모레/g, ''); }
  const timeMatch = title.match(/(오전|오후)\s*(\d{1,2})\s*시\s*(\d{1,2})?\s*분?/);
  if (timeMatch) {
    let hour = Number(timeMatch[2]);
    if (timeMatch[1] === '오후' && hour < 12) hour += 12;
    if (timeMatch[1] === '오전' && hour === 12) hour = 0;
    time = `${String(hour).padStart(2, '0')}:${String(Number(timeMatch[3] || 0)).padStart(2, '0')}`;
    title = title.replace(timeMatch[0], '');
  } else {
    const simpleTime = title.match(/(\d{1,2}):(\d{2})|(\d{1,2})시/);
    if (simpleTime) {
      time = simpleTime[3] ? `${String(Number(simpleTime[3])).padStart(2, '0')}:00` : `${String(Number(simpleTime[1])).padStart(2, '0')}:${simpleTime[2]}`;
      title = title.replace(simpleTime[0], '');
    }
  }
  return { title: title.replace(/\s+/g, ' ').trim() || textValue, date, time, tags, owner, repeat, priority };
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[:/#?&]/g, '-');
}

export function taxonomyNavKey(kind: TaxonomyKind, id: string) {
  return `${kind}:${slugify(id)}`;
}

export function parseTaxonomyRecord(item: WorkItem): TaxonomyItem | null {
  const title = itemTitle(item, '');
  const source = text(item.source);
  const marker = text(item.kind || item.type || item.recordType);
  const notes = text(item.notes || item.description);
  let parsed: Record<string, unknown> = {};
  if (notes.trim().startsWith('{')) {
    try { parsed = JSON.parse(notes) as Record<string, unknown>; } catch { parsed = {}; }
  }
  const kind = text(item.taxonomyKind || parsed.kind || (/^__(hermes|agents_calendar)_list:/.test(title) ? 'list' : /^__(hermes|agents_calendar)_tag:/.test(title) ? 'tag' : '')) as TaxonomyKind;
  const isMeta = source === TAXONOMY_SOURCE || marker === 'taxonomy' || /^__(hermes|agents_calendar)_(list|tag):/.test(title);
  if (!isMeta || (kind !== 'list' && kind !== 'tag')) return null;
  const label = text(item.label || item.name || parsed.label || title.replace(/^__(hermes|agents_calendar)_(list|tag):/, ''), kind === 'list' ? '새 리스트' : '새 태그');
  return {
    id: text(item.slug || parsed.id || itemId(item, slugify(label)), slugify(label)),
    label,
    icon: text(item.icon || parsed.icon, kind === 'list' ? '📁' : '🏷'),
    group: text(item.group || parsed.group, kind === 'list' ? '리스트' : '태그'),
    kind,
    recordId: itemId(item, ''),
    hidden: Boolean(item.hidden || parsed.hidden),
  };
}

export function isTaxonomyRecord(item: WorkItem) {
  return Boolean(parseTaxonomyRecord(item));
}

export function taskListName(task: WorkItem) {
  return text(task.category || task.list || task.project, '');
}

export function taskTags(task: WorkItem) {
  if (Array.isArray(task.tags)) return task.tags.map(String).filter(Boolean);
  return text(task.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function shouldPersistTask(id: string) {
  return Boolean(id) && !id.startsWith('local-') && !id.startsWith('draft-') && !/^t\d+$/.test(id);
}

export function isCalendarEventRecord(item: WorkItem) {
  const kind = text(item.kind || item.type || item.recordType);
  const source = text(item.source);
  return kind === 'calendar-event' || kind === 'event' || source === 'calendar-event' || source === 'external-calendar';
}

export function isTaskRecord(item: WorkItem) {
  return !isTaxonomyRecord(item) && !isCalendarEventRecord(item);
}

export function plainCalendarNotes(item: WorkItem) {
  return text(item.notes || item.description).split(CALENDAR_META_MARKER)[0].trimEnd();
}

export function calendarMetadata(item: WorkItem) {
  const rawNotes = text(item.notes || item.description);
  let stored: Record<string, unknown> = {};
  const markerIndex = rawNotes.indexOf(CALENDAR_META_MARKER);
  if (markerIndex !== -1) {
    try { stored = JSON.parse(rawNotes.slice(markerIndex + CALENDAR_META_MARKER.length)) as Record<string, unknown>; } catch { stored = {}; }
  }
  const repeat = text(item.repeat || item.recurrence || stored.repeat || stored.recurrence, 'none') || 'none';
  return {
    allDay: Boolean(item.allDay ?? stored.allDay),
    endDate: text(item.endDate || stored.endDate),
    endTime: text(item.endTime || stored.endTime),
    repeat,
    repeatUntil: text(item.repeatUntil || stored.repeatUntil),
  };
}

export function calendarNotes(item: WorkItem) {
  const notes = plainCalendarNotes(item);
  const meta = calendarMetadata(item);
  const hasMeta = meta.allDay || meta.endDate || meta.endTime || meta.repeat !== 'none' || meta.repeatUntil;
  return hasMeta ? `${notes ? `${notes}\n\n` : ''}${CALENDAR_META_MARKER}${JSON.stringify(meta)}` : notes;
}

export function taskPayload(item: WorkItem) {
  const payload: Record<string, unknown> = {};
  const copyKeys = ['title', 'notes', 'description', 'date', 'time', 'endDate', 'endTime', 'allDay', 'owner', 'agent', 'status', 'lane', 'tags', 'repeat', 'repeatUntil', 'recurrence', 'priority', 'project', 'category', 'list', 'done', 'reminder', 'reminderAt'];
  for (const key of copyKeys) if (item[key] !== undefined) payload[key] = item[key];
  const calendar = calendarMetadata(item);
  payload.allDay = calendar.allDay;
  payload.endDate = calendar.endDate;
  payload.endTime = calendar.endTime;
  payload.recurrence = calendar.repeat === 'none' ? '' : calendar.repeat;
  payload.repeatUntil = calendar.repeatUntil;
  if (item.notes !== undefined || item.description !== undefined || calendar.allDay || calendar.endDate || calendar.endTime || calendar.repeat !== 'none' || calendar.repeatUntil) payload.notes = calendarNotes(item);
  if (item.category !== undefined && payload.project === undefined) payload.project = item.category;
  if (item.list !== undefined && payload.project === undefined) payload.project = item.list;
  if (item.status !== undefined && payload.lane === undefined) payload.lane = item.status;
  if (item.done !== undefined && payload.status === undefined) payload.status = item.done ? 'Done' : 'Planned';
  const date = text(item.date);
  const time = text(item.time);
  if ((date || time) && payload.due === undefined) payload.due = `${date}${time ? ` ${time}` : ''}`.trim();
  if (!date && !time && (item.date === '' || item.time === '') && payload.due === undefined) payload.due = '';
  return payload;
}

export function desktopTaskPayload(item: WorkItem) {
  return { ...taskPayload(item), source: 'desktop-task-db' };
}

export function calendarEventPayload(item: WorkItem) {
  const calendar = calendarMetadata(item);
  return {
    ...taskPayload(item),
    title: itemTitle(item, '새 일정'),
    date: text(item.date || item.startDate || item.day, todayKey()),
    startDate: text(item.startDate || item.date || item.day, todayKey()),
    time: text(item.time || item.t),
    endDate: calendar.endDate || text(item.endDate || item.dateEnd || item.dueDate),
    endTime: calendar.endTime || text(item.endTime || item.tEnd),
    allDay: calendar.allDay,
    recurrence: calendar.repeat === 'none' ? '' : calendar.repeat,
    repeat: calendar.repeat,
    repeatUntil: calendar.repeatUntil,
    notes: calendarNotes(item),
    kind: 'calendar-event',
    type: 'calendar-event',
    source: text(item.source || 'desktop-calendar-event'),
  };
}

export function responseTask(payload: ApiEnvelope) {
  const direct = payload.task;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as WorkItem;
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as ApiEnvelope).task;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as WorkItem;
  }
  return null;
}

export function responseCalendarEvent(payload: ApiEnvelope) {
  const direct = payload.event || payload.calendarEvent;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as WorkItem;
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as ApiEnvelope).event || (data as ApiEnvelope).calendarEvent;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as WorkItem;
  }
  return null;
}

export function taskMatchesCreated(expected: WorkItem, candidate: WorkItem) {
  const expectedId = itemId(expected, '');
  const candidateId = itemId(candidate, '');
  if (expectedId && candidateId && expectedId === candidateId) return true;
  return itemTitle(expected, '') !== '' && itemTitle(expected, '') === itemTitle(candidate, '') && text(expected.date) === text(candidate.date);
}

export function calendarEventMatchesCreated(expected: WorkItem, candidate: WorkItem) {
  const expectedId = itemId(expected, '');
  const candidateId = itemId(candidate, '');
  if (expectedId && candidateId && expectedId === candidateId) return true;
  const expectedDate = text(expected.startDate || expected.date);
  const candidateDate = text(candidate.startDate || candidate.date);
  return itemTitle(expected, '') !== '' && itemTitle(expected, '') === itemTitle(candidate, '') && expectedDate === candidateDate;
}

export function taxonomyMatchesSaved(expected: TaxonomyItem, candidate: WorkItem) {
  const parsed = parseTaxonomyRecord(candidate);
  if (!parsed || parsed.kind !== expected.kind) return false;
  if (expected.recordId && parsed.recordId && expected.recordId === parsed.recordId) return true;
  return slugify(parsed.id) === slugify(expected.id) || slugify(parsed.label) === slugify(expected.label);
}
