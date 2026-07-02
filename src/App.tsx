import { useEffect, useMemo, useRef, useState } from 'react';
import { hermesApi, setApiBaseUrl, type ApiEnvelope } from './api/hermesApi';

type ScreenId = 'calendar' | 'today' | 'next7' | 'tasks' | 'kanban' | 'mail' | 'notes' | 'someday' | 'review' | 'wiki' | 'diary' | 'search' | 'agents' | 'widgets' | 'settings' | 'login';
type ModalId = 'task' | 'new' | 'delegate' | 'run' | 'agent' | 'settings' | 'taxonomy' | null;
type Item = Record<string, unknown>;
type NavItem = { id: ScreenId; icon: string; label: string; navKey?: string };
type NavGroup = { title: string; kind?: 'list' | 'tag'; group?: string; items: NavItem[] };
type TaxonomyKind = 'list' | 'tag';
type TaxonomyItem = { id: string; label: string; icon: string; group: string; kind: TaxonomyKind; recordId?: string; hidden?: boolean };
type UiPreferences = { notify: boolean; agentShare: boolean; weekStartMon: boolean };
type DesktopSettingsState = { apiBaseUrl: string; hasApiToken: boolean; theme: HermesDesktopSettings['theme']; uiPreferences: UiPreferences };
type DesktopTheme = HermesDesktopSettings['theme'];
type NewTaskControls = {
  date: string;
  setDate: (value: string) => void;
  time: string;
  setTime: (value: string) => void;
  repeat: string;
  setRepeat: (value: string) => void;
  owner: string;
  setOwner: (value: string) => void;
  list: string;
  setList: (value: string) => void;
  allDay: boolean;
  setAllDay: (value: boolean) => void;
  datePanel: boolean;
  setDatePanel: (value: boolean) => void;
  listPanel: boolean;
  setListPanel: (value: boolean) => void;
  subPanel: string | null;
  setSubPanel: (value: string | null) => void;
  mode: 'date' | 'duration';
  setMode: (value: 'date' | 'duration') => void;
  endDate: string;
  setEndDate: (value: string) => void;
  endTime: string;
  setEndTime: (value: string) => void;
};

type AppState = {
  tasks: Item[];
  events: Item[];
  agents: Item[];
  runs: Item[];
  docs: Item[];
  inbox: Item[];
  automation: Item[];
  channels: Item[];
  sessions: Item[];
  tools: Item[];
  chatMessages: Item[];
  taxonomy: Item[];
  wiki: ApiEnvelope;
  settings: ApiEnvelope;
  usage: ApiEnvelope;
};

const APP_TIME_ZONE = 'Asia/Seoul';

const EMPTY_STATE: AppState = {
  tasks: [],
  events: [],
  agents: [],
  runs: [],
  docs: [],
  inbox: [],
  automation: [],
  channels: [],
  sessions: [],
  tools: [],
  chatMessages: [],
  taxonomy: [],
  wiki: {},
  settings: {},
  usage: {},
};

const screenMeta: Record<ScreenId, { title: string; sub: string }> = {
  calendar: { title: '캘린더', sub: '나 · 에이전트 공유 일정' },
  today: { title: '오늘', sub: '' },
  next7: { title: '다음 7일', sub: '이번 주 + 다음 주' },
  tasks: { title: '기본함', sub: '분류되지 않은 작업' },
  kanban: { title: '칸반 보드', sub: '' },
  mail: { title: '메일함', sub: '메일 → 작업·위임으로 연결' },
  notes: { title: '생각노트', sub: '' },
  someday: { title: '언젠가', sub: '' },
  review: { title: '주간 회고', sub: '이번 주 목표 · KPI · 회고' },
  wiki: { title: '위키', sub: 'LLM-Wiki · 그래프 · 질문' },
  diary: { title: '일기', sub: '매일 쓰고 위키에 쌓기' },
  search: { title: '검색', sub: '' },
  agents: { title: '에이전트', sub: '작업 위임 · 실시간 실행' },
  widgets: { title: '위젯', sub: 'macOS 데스크톱 위젯 미리보기' },
  settings: { title: '설정', sub: '' },
  login: { title: '로그인', sub: '' },
};

const TAXONOMY_SOURCE = 'hermes-desktop-taxonomy';
const CALENDAR_META_MARKER = '[Hermes Calendar]\n';
const DEFAULT_UI_PREFERENCES: UiPreferences = { notify: true, agentShare: true, weekStartMon: true };

const smartNavGroups: NavGroup[] = [
  { title: '', items: [
    { id: 'calendar', icon: '🗓️', label: '캘린더' },
    { id: 'today', icon: '☀️', label: '오늘' },
    { id: 'next7', icon: '📆', label: '다음 7일' },
    { id: 'tasks', icon: '📥', label: '기본함' },
    { id: 'mail', icon: '✉️', label: '메일함' },
    { id: 'kanban', icon: '▦', label: '칸반 보드' },
  ] },
  { title: '회고 & 기록', items: [
    { id: 'review', icon: '📊', label: '주간 회고' },
    { id: 'wiki', icon: '📚', label: '위키' },
    { id: 'diary', icon: '📔', label: '일기' },
  ] },
  { title: 'HERMES', items: [
    { id: 'agents', icon: '🤖', label: '에이전트' },
    { id: 'widgets', icon: '▣', label: '위젯' },
  ] },
];

function arr(payload: ApiEnvelope | undefined, ...keys: string[]): Item[] {
  for (const key of keys) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value as Item[];
  }
  const data = payload?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const found = arr(data as ApiEnvelope, ...keys);
    if (found.length) return found;
  }
  const state = payload?.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const found = arr(state as ApiEnvelope, ...keys);
    if (found.length) return found;
  }
  return [];
}

function obj(payload: ApiEnvelope | undefined, key: string): ApiEnvelope {
  const value = payload?.[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ApiEnvelope;
  const data = payload?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return obj(data as ApiEnvelope, key);
  const state = payload?.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) return obj(state as ApiEnvelope, key);
  return {};
}

function text(value: unknown, fallback = '') {
  return String(value || fallback);
}

function itemTitle(item: Item, fallback = '항목') {
  return text(item.title || item.goal || item.name || item.subject || item.label || item.text || item.path, fallback);
}

function itemSub(item: Item, fallback = 'Hermes') {
  return text(item.date || item.due || item.status || item.agent || item.model || item.from || item.folder || item.source, fallback);
}

function nestedItem(item: Item, ...keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Item;
  }
  return null;
}

function normalizeCalendarEvent(item: Item): Item {
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

function isDone(item: Item) {
  return /done|complete|completed|ok|완료/i.test(text(item.status || item.lane || item.lastStatus));
}

function taskOwner(item: Item) {
  const owner = text(item.owner || item.agent || item.agentId, 'Me');
  if (/agent|default|marketflow|stockagent|uniportpm|Hermes/i.test(owner)) return 'Agent';
  if (/hybrid|joint|공동/i.test(owner)) return 'Hybrid';
  return 'Me';
}

function dateKeyInTimeZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function todayKey() {
  return dateKeyInTimeZone();
}

function dateLabel(offset = 0) {
  const day = new Date(`${todayKey()}T00:00:00`);
  day.setDate(day.getDate() + offset);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: APP_TIME_ZONE, month: 'long', day: 'numeric', weekday: 'short' }).format(day);
}

function todayMetaLabel() {
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

function formatTime(value: string) {
  if (!value) return '';
  const [hourRaw, minute = '00'] = value.split(':');
  const hour = Number(hourRaw);
  const period = hour < 12 ? '오전' : '오후';
  const display = hour % 12 || 12;
  return `${period} ${display}:${minute}`;
}

function formatDateChip(value: string) {
  if (!value) return '날짜 추가';
  const date = new Date(`${value}T00:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function formatUpdatedStamp(value: string) {
  if (!value) return '방금 수정';
  const datePart = value.includes('T') ? value.split('T')[0] : value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return `${formatDateChip(datePart)} 수정`;
  return value.length > 16 ? '최근 수정' : value;
}

function repeatLabel(value: string) {
  return ({ none: '안 함', daily: '매일', weekday: '평일', weekly: '매주', monthly: '매월' } as Record<string, string>)[value] || '안 함';
}

function addDaysKey(date: string, offset: number) {
  const day = new Date(`${date}T00:00:00`);
  day.setDate(day.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
}

function addMonthsKey(date: string, offset: number) {
  const day = new Date(`${date}T00:00:00`);
  day.setMonth(day.getMonth() + offset);
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
}

function weekRangeLabel(date = todayKey()) {
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

function parseQuick(textValue: string, fallbackDate?: string) {
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

function itemId(item: Item, fallback: string) {
  return text(item.id || item._id || item.key || item.path, fallback);
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[:/#?&]/g, '-');
}

function taxonomyNavKey(kind: TaxonomyKind, id: string) {
  return `${kind}:${slugify(id)}`;
}

function parseTaxonomyRecord(item: Item): TaxonomyItem | null {
  const title = itemTitle(item, '');
  const source = text(item.source);
  const marker = text(item.kind || item.type || item.recordType);
  const notes = text(item.notes || item.description);
  let parsed: Record<string, unknown> = {};
  if (notes.trim().startsWith('{')) {
    try { parsed = JSON.parse(notes) as Record<string, unknown>; } catch { parsed = {}; }
  }
  const kind = text(item.taxonomyKind || parsed.kind || (title.startsWith('__hermes_list:') ? 'list' : title.startsWith('__hermes_tag:') ? 'tag' : '')) as TaxonomyKind;
  const isMeta = source === TAXONOMY_SOURCE || marker === 'taxonomy' || title.startsWith('__hermes_list:') || title.startsWith('__hermes_tag:');
  if (!isMeta || (kind !== 'list' && kind !== 'tag')) return null;
  const label = text(item.label || item.name || parsed.label || title.replace(/^__hermes_(list|tag):/, ''), kind === 'list' ? '새 리스트' : '새 태그');
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

function isTaxonomyRecord(item: Item) {
  return Boolean(parseTaxonomyRecord(item));
}

function taskListName(task: Item) {
  return text(task.category || task.list || task.project, '');
}

function taskTags(task: Item) {
  if (Array.isArray(task.tags)) return task.tags.map(String).filter(Boolean);
  return text(task.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function shouldPersistTask(id: string) {
  return Boolean(id) && !id.startsWith('local-') && !id.startsWith('draft-') && !/^t\d+$/.test(id);
}

function isCalendarEventRecord(item: Item) {
  const kind = text(item.kind || item.type || item.recordType);
  const source = text(item.source);
  return kind === 'calendar-event' || kind === 'event' || source === 'calendar-event' || source === 'external-calendar';
}

function isTaskRecord(item: Item) {
  return !isTaxonomyRecord(item) && !isCalendarEventRecord(item);
}

function plainCalendarNotes(item: Item) {
  return text(item.notes || item.description).split(CALENDAR_META_MARKER)[0].trimEnd();
}

function calendarMetadata(item: Item) {
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

function calendarNotes(item: Item) {
  const notes = plainCalendarNotes(item);
  const meta = calendarMetadata(item);
  const hasMeta = meta.allDay || meta.endDate || meta.endTime || meta.repeat !== 'none' || meta.repeatUntil;
  return hasMeta ? `${notes ? `${notes}\n\n` : ''}${CALENDAR_META_MARKER}${JSON.stringify(meta)}` : notes;
}

function desktopTaskPayload(item: Item) {
  return { ...taskPayload(item), source: 'desktop-task-db' };
}

function calendarEventPayload(item: Item) {
  const calendar = calendarMetadata(item);
  const payload = taskPayload(item);
  return {
    ...payload,
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

function hermesWidgetOwner(item: Item): HermesWidgetOwner {
  const owner = taskOwner(item);
  if (owner === 'Agent') return 'agent';
  if (owner === 'Hybrid') return 'hybrid';
  return 'me';
}

function hermesWidgetTask(item: Item, fallback: string) {
  const date = widgetItemDate(item) || todayKey();
  const time = widgetItemTime(item);
  const status = text(item.status || item.lane || item.state, isDone(item) ? 'Done' : 'Planned');
  const calendar = calendarMetadata(item);
  const durationMinutes = (() => {
    if (!time || !calendar.endTime || (calendar.endDate && calendar.endDate !== date)) return undefined;
    const [startHour = 0, startMinute = 0] = time.split(':').map((part) => Number(part) || 0);
    const [endHour = 0, endMinute = 0] = calendar.endTime.split(':').map((part) => Number(part) || 0);
    const diff = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
    return diff > 0 ? diff : undefined;
  })();
  return {
    id: itemId(item, fallback),
    title: itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업'),
    date,
    ...(time ? { time } : {}),
    owner: hermesWidgetOwner(item),
    list: text(item.category || item.project || item.list || item.source, 'Hermes'),
    status,
    done: isDone(item),
    ...(durationMinutes ? { durationMinutes } : {}),
  };
}

function hermesWidgetRun(run: Item, fallback: string) {
  const progressValue = Number(text(run.progress || run.pct || run.percent, '0').replace(/[^\d.]/g, ''));
  return {
    id: itemId(run, fallback),
    title: itemTitle(run, '에이전트 실행'),
    status: text(run.status || run.state, 'running'),
    progress: Number.isFinite(progressValue) ? Math.max(0, Math.min(100, Math.round(progressValue))) : 0,
  };
}

function buildHermesWidgetSnapshot(tasks: Item[], events: Item[], runs: Item[]): HermesWidgetSnapshotPayload {
  const widgetTasks = [
    ...tasks.map((task, index) => hermesWidgetTask(task, `task-${index}`)),
    ...events.map((event, index) => hermesWidgetTask({ ...event, kind: 'calendar-event', type: 'calendar-event' }, `event-${index}`)),
  ].filter((task) => task.title && task.date);
  return {
    todayDate: todayKey(),
    tasks: widgetTasks,
    runs: runs.map((run, index) => hermesWidgetRun(run, `run-${index}`)),
    updatedAt: new Date().toISOString(),
  };
}

function taskPayload(item: Item) {
  const payload: Record<string, unknown> = {};
  const copyKeys = ['title', 'notes', 'description', 'date', 'time', 'endDate', 'endTime', 'allDay', 'owner', 'agent', 'status', 'lane', 'tags', 'repeat', 'repeatUntil', 'recurrence', 'priority', 'project', 'category', 'list', 'done'];
  for (const key of copyKeys) {
    if (item[key] !== undefined) payload[key] = item[key];
  }
  const calendar = calendarMetadata(item);
  payload.allDay = calendar.allDay;
  payload.endDate = calendar.endDate;
  payload.endTime = calendar.endTime;
  payload.recurrence = calendar.repeat === 'none' ? '' : calendar.repeat;
  payload.repeatUntil = calendar.repeatUntil;
  if (item.notes !== undefined || item.description !== undefined || calendar.allDay || calendar.endDate || calendar.endTime || calendar.repeat !== 'none' || calendar.repeatUntil) {
    payload.notes = calendarNotes(item);
  }
  if (item.category !== undefined && payload.project === undefined) payload.project = item.category;
  if (item.list !== undefined && payload.project === undefined) payload.project = item.list;
  if (item.status !== undefined && payload.lane === undefined) payload.lane = item.status;
  if (item.done !== undefined && payload.status === undefined) payload.status = item.done ? 'Done' : 'Planned';
  const date = text(item.date);
  const time = text(item.time);
  if ((date || time) && payload.due === undefined) payload.due = `${date}${time ? ` ${time}` : ''}`.trim();
  return payload;
}

function responseTask(payload: ApiEnvelope) {
  const direct = payload.task;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Item;
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as ApiEnvelope).task;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Item;
  }
  return null;
}

function responseCalendarEvent(payload: ApiEnvelope) {
  const direct = payload.event || payload.calendarEvent;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Item;
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as ApiEnvelope).event || (data as ApiEnvelope).calendarEvent;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Item;
  }
  return null;
}

function toChatMessage(item: Item) {
  return {
    role: text(item.role, 'assistant'),
    text: text(item.text || item.message || item.content || item.goal, ''),
  };
}

function settingsPreferences(payload: ApiEnvelope | undefined): UiPreferences {
  const direct = obj(payload, 'uiPreferences');
  const nested = obj(obj(payload, 'settings'), 'uiPreferences');
  const source = Object.keys(direct).length ? direct : nested;
  return {
    notify: typeof source.notify === 'boolean' ? source.notify : DEFAULT_UI_PREFERENCES.notify,
    agentShare: typeof source.agentShare === 'boolean' ? source.agentShare : DEFAULT_UI_PREFERENCES.agentShare,
    weekStartMon: typeof source.weekStartMon === 'boolean' ? source.weekStartMon : DEFAULT_UI_PREFERENCES.weekStartMon,
  };
}

function desktopSettingsState(settings: HermesDesktopSettings): DesktopSettingsState {
  return {
    apiBaseUrl: settings.apiBaseUrl,
    hasApiToken: settings.hasApiToken,
    theme: settings.theme,
    uiPreferences: settings.uiPreferences || DEFAULT_UI_PREFERENCES,
  };
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>('calendar');
  const [activeNavKey, setActiveNavKey] = useState('calendar');
  const [modal, setModal] = useState<ModalId>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [settings, setSettings] = useState<DesktopSettingsState>({ apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app', hasApiToken: false, theme: 'default', uiPreferences: DEFAULT_UI_PREFERENCES });
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newRepeat, setNewRepeat] = useState('none');
  const [newOwner, setNewOwner] = useState('me');
  const [newList, setNewList] = useState('inbox');
  const [newAllDay, setNewAllDay] = useState(false);
  const [newDatePanel, setNewDatePanel] = useState(false);
  const [newListPanel, setNewListPanel] = useState(false);
  const [newSubPanel, setNewSubPanel] = useState<string | null>(null);
  const [newMode, setNewMode] = useState<'date' | 'duration'>('date');
  const [newEndDate, setNewEndDate] = useState('');
  const [newEndTime, setNewEndTime] = useState('');
  const [loggedIn, setLoggedIn] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPw, setLoginPw] = useState('');
  const [prefs, setPrefs] = useState<UiPreferences>(DEFAULT_UI_PREFERENCES);
  const [quickText, setQuickText] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [calView, setCalView] = useState<'month' | 'week' | 'day'>('month');
  const [calDate, setCalDate] = useState(todayKey());
  const [placingTaskId, setPlacingTaskId] = useState('');
  const [activeMailId, setActiveMailId] = useState('');
  const [gmailEmail, setGmailEmail] = useState('');
  const [gmailPassword, setGmailPassword] = useState('');
  const [mailSyncing, setMailSyncing] = useState(false);
  const [mailStatus, setMailStatus] = useState('');
  const [activeNoteId, setActiveNoteId] = useState('');
  const [wikiQuestion, setWikiQuestion] = useState('');
  const [wikiAnswer, setWikiAnswer] = useState('');
  const [wikiAnswerSources, setWikiAnswerSources] = useState<Item[]>([]);
  const [wikiAsking, setWikiAsking] = useState(false);
  const [activeWikiId, setActiveWikiId] = useState('');
  const [wikiReaderOpen, setWikiReaderOpen] = useState(false);
  const [diaryText, setDiaryText] = useState('');
  const [diaryMood, setDiaryMood] = useState('');
  const [missionText, setMissionText] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('default');
  const [delegateText, setDelegateText] = useState('');
  const [delegateAgentId, setDelegateAgentId] = useState('default');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [taxonomyForm, setTaxonomyForm] = useState<{ kind: TaxonomyKind; group: string; editing?: TaxonomyItem } | null>(null);
  const [taxonomyName, setTaxonomyName] = useState('');
  const [taxonomyGroupName, setTaxonomyGroupName] = useState('');
  const [taxonomyIcon, setTaxonomyIcon] = useState('');
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentRole, setNewAgentRole] = useState('');
  const [newAgentEmoji, setNewAgentEmoji] = useState('🤖');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; text: string }>>([]);

  const baseTasks = state.tasks;
  const tasks = useMemo(() => [...baseTasks], [baseTasks]);
  const events = useMemo(() => [
    ...state.events
      .map((event) => ({ ...event, kind: 'calendar-event' })),
  ], [state.events]);
  const agents = state.agents;
  const runs = state.runs;
  const selectedRun = runs.find((run, index) => itemId(run, `run-${index}`) === selectedRunId) || runs[0];
  const taxonomy = useMemo(() => {
    const byId = new Map<string, TaxonomyItem>();
    const metadata = state.taxonomy.map(parseTaxonomyRecord).filter(Boolean) as TaxonomyItem[];
    const hiddenKeys = new Set(metadata
      .filter((entry) => entry.hidden)
      .flatMap((entry) => [`${entry.kind}:${slugify(entry.id)}`, `${entry.kind}:${slugify(entry.label)}`]));
    const isHidden = (entry: TaxonomyItem) => (
      entry.hidden ||
      hiddenKeys.has(`${entry.kind}:${slugify(entry.id)}`) ||
      hiddenKeys.has(`${entry.kind}:${slugify(entry.label)}`)
    );
    const add = (entry: TaxonomyItem) => {
      if (isHidden(entry)) return;
      byId.set(`${entry.kind}:${slugify(entry.id || entry.label)}`, { ...entry, id: slugify(entry.id || entry.label) });
    };
    metadata.forEach(add);
    const derivedLists = new Map<string, TaxonomyItem>();
    const derivedTags = new Map<string, TaxonomyItem>();
    tasks.forEach((task) => {
      const listName = taskListName(task);
      if (listName) {
        const id = slugify(listName);
        if (!derivedLists.has(id)) derivedLists.set(id, { id, label: listName, icon: '📁', group: '리스트', kind: 'list' });
      }
      taskTags(task).forEach((tag) => {
        const id = slugify(tag);
        if (!derivedTags.has(id)) derivedTags.set(id, { id, label: tag, icon: '🏷', group: '태그', kind: 'tag' });
      });
    });
    [...derivedLists.values(), ...derivedTags.values()].forEach((entry) => {
      if (isHidden(entry)) return;
      const key = `${entry.kind}:${slugify(entry.id || entry.label)}`;
      if (!byId.has(key)) byId.set(key, entry);
    });
    return [...byId.values()].sort((a, b) => `${a.group}:${a.label}`.localeCompare(`${b.group}:${b.label}`, 'ko'));
  }, [state.taxonomy, tasks]);
  const listDefinitions = taxonomy.filter((entry) => entry.kind === 'list' && !['언젠가', 'someday'].includes(text(entry.label).toLowerCase()) && !['언젠가', 'someday'].includes(text(entry.id).toLowerCase()));
  const tagDefinitions = taxonomy.filter((entry) => entry.kind === 'tag');
  const navGroups = useMemo<NavGroup[]>(() => {
    const listGroups = new Map<string, TaxonomyItem[]>();
    listDefinitions.forEach((entry) => {
      const group = entry.group || '리스트';
      listGroups.set(group, [...(listGroups.get(group) || []), entry]);
    });
    const dynamicListGroups: NavGroup[] = [...listGroups.entries()].map(([group, entries]) => ({
      title: group === '리스트' ? '리스트' : `리스트 · ${group}`,
      kind: 'list',
      group,
      items: entries.map((entry) => ({ id: 'tasks' as ScreenId, navKey: taxonomyNavKey('list', entry.id), icon: entry.icon, label: entry.label })),
    }));
    const tagGroups = new Map<string, TaxonomyItem[]>();
    tagDefinitions.forEach((entry) => {
      const group = entry.group || '태그';
      tagGroups.set(group, [...(tagGroups.get(group) || []), entry]);
    });
    const dynamicTagGroups: NavGroup[] = [...tagGroups.entries()].map(([group, entries]) => ({
      title: group === '태그' ? '태그' : `태그 · ${group}`,
      kind: 'tag',
      group,
      items: entries.map((entry) => ({ id: 'tasks' as ScreenId, navKey: taxonomyNavKey('tag', entry.id), icon: entry.icon, label: entry.label })),
    }));
    if (!dynamicListGroups.some((group) => group.group === '리스트')) dynamicListGroups.push({ title: '리스트', kind: 'list', group: '리스트', items: [] });
    if (!dynamicTagGroups.length) dynamicTagGroups.push({ title: '태그', kind: 'tag', group: '태그', items: [] });
    return [smartNavGroups[0], ...dynamicListGroups, ...dynamicTagGroups, ...smartNavGroups.slice(1)];
  }, [listDefinitions, tagDefinitions]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        if (!window.hermesDesktop) {
          setApiBaseUrl('');
          if (location.protocol === 'http:' || location.protocol === 'https:') {
            await hydrate();
          } else {
            setApiError('브라우저 미리보기 모드 · Railway 연결은 Electron 앱에서 프록시로 활성화됩니다.');
            setLoading(false);
          }
          return;
        }
        const desktopSettings = await window.hermesDesktop?.getSettings();
        const proxyBase = await window.hermesDesktop?.getProxyBaseUrl();
        if (desktopSettings && !cancelled) setSettings(desktopSettingsState(desktopSettings));
        setApiBaseUrl(proxyBase || desktopSettings?.apiBaseUrl || 'https://hermes-os-production-e174.up.railway.app');
        await hydrate();
      } catch (error) {
        if (!cancelled) {
          setApiError(error instanceof Error ? error.message : 'Electron 설정을 불러오지 못했습니다.');
          setLoading(false);
        }
      }
    }
    void boot();
    return () => { cancelled = true; };
  }, []);

  async function hydrate() {
    setLoading(true);
    setApiError('');
    try {
      const [dashboard, tasksPayload, eventsPayload, agentsPayload, wiki, inbox, automation, usage, tools, settingsPayload, channels, documentsPayload, chatPayload] = await Promise.all([
        hermesApi.getDashboardState(),
        hermesApi.getTasks(),
        hermesApi.getCalendarEvents(),
        hermesApi.getAgents(),
        hermesApi.getWiki(),
        hermesApi.getInbox(),
        hermesApi.getAutomation(),
        hermesApi.getUsage(),
        hermesApi.getTools(),
        hermesApi.getSettings(),
        hermesApi.getChannels(),
        hermesApi.getDocuments(),
        hermesApi.getChatMessages(),
      ]);
      const rawTasks = arr(tasksPayload, 'tasks');
      const taxonomyRecords = rawTasks.filter(isTaxonomyRecord);
      const tasks = rawTasks.filter(isTaskRecord);
      const events = [
        ...arr(eventsPayload, 'events', 'calendarEvents').map(normalizeCalendarEvent),
        ...rawTasks.filter(isCalendarEventRecord).map(normalizeCalendarEvent),
      ];
      const agents = arr(agentsPayload, 'agents');
      const runs = arr(dashboard, 'runs');
      const docs = arr(documentsPayload, 'documents');
      const inboxItems = arr(inbox, 'items', 'commands', 'commandRows');
      const remoteChat = arr(chatPayload, 'messages', 'chatMessages');
      setState({
        tasks,
        events,
        agents,
        runs,
        docs,
        inbox: inboxItems,
        automation: arr(automation, 'jobs', 'schedulerJobs'),
        channels: arr(channels, 'channels'),
        sessions: arr(dashboard, 'sessions'),
        tools: arr(tools, 'tools', 'skills', 'toolsets'),
        chatMessages: remoteChat,
        taxonomy: taxonomyRecords,
        wiki,
        settings: settingsPayload,
        usage,
      });
      setPrefs(settingsPreferences(settingsPayload));
      setSettings((current) => ({ ...current, uiPreferences: settingsPreferences(settingsPayload) }));
      if (remoteChat.length) {
        setChatMessages(remoteChat.slice(-40).map(toChatMessage).filter((message) => message.text));
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Railway API 응답 실패');
    } finally {
      setLoading(false);
    }
  }

  async function persistCreatedTask(task: Item, source: 'task' | 'calendar' = 'task') {
    try {
      if (source === 'calendar') {
        const created = await hermesApi.createCalendarEvent(calendarEventPayload(task));
        responseCalendarEvent(created);
      } else {
        await hermesApi.createTask(desktopTaskPayload(task));
      }
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '작업 생성 실패');
    }
  }

  async function createTask(extraNotes = '') {
    const title = newTitle.trim();
    if (!title) return;
    const parsed = parseQuick(title, newDate || (screen === 'today' ? todayKey() : undefined));
    const owner = parsed.owner === 'Agent' || newOwner === 'agent' ? 'Agent' : newOwner === 'hybrid' ? 'Hybrid' : 'Me';
    const targetList = activeListForNewTask();
    const targetTag = activeTagForNewTask();
    const tags = Array.from(new Set([...(parsed.tags || []), ...(targetTag ? [targetTag.label] : [])]));
    const task = {
      title: parsed.title,
      date: parsed.date || newDate || todayKey(),
      time: newAllDay ? '' : (parsed.time || newTime),
      endDate: newMode === 'duration' ? newEndDate : '',
      endTime: newMode === 'duration' ? newEndTime : '',
      owner,
      status: owner === 'Agent' ? 'Queued' : 'Planned',
      tags,
      repeat: parsed.repeat !== 'none' ? parsed.repeat : newRepeat,
      priority: parsed.priority,
      notes: [newDesc.trim(), extraNotes.trim()].filter(Boolean).join('\n'),
      list: targetList?.id || newList,
      category: targetList?.label || newList,
      project: targetList?.label || newList,
    };
    setNewTitle('');
    setNewDesc('');
    setNewDate('');
    setNewTime('');
    setNewEndDate('');
    setNewEndTime('');
    setNewRepeat('none');
    setNewOwner('me');
    setNewList('inbox');
    setNewAllDay(false);
    setNewDatePanel(false);
    setNewListPanel(false);
    setNewSubPanel(null);
    setNewMode('date');
    setModal(null);
    await persistCreatedTask(
      screen === 'calendar' ? { ...task, kind: 'calendar-event', type: 'calendar-event' } : task,
      screen === 'calendar' ? 'calendar' : 'task',
    );
  }

  async function createQuickTask(rawTitle: string, fallbackDate?: string, options: { owner?: string; status?: string; source?: 'task' | 'calendar' } = {}) {
    const parsed = parseQuick(rawTitle, fallbackDate);
    const targetList = activeListForNewTask();
    const targetTag = activeTagForNewTask();
    const tags = Array.from(new Set([...(parsed.tags || []), ...(targetTag ? [targetTag.label] : [])]));
    const task = {
      title: parsed.title,
      date: parsed.date || fallbackDate || '',
      time: parsed.time,
      owner: parsed.owner,
      status: parsed.owner === 'Agent' ? 'Queued' : 'Planned',
      tags,
      repeat: parsed.repeat,
      priority: parsed.priority,
      list: targetList?.id || 'inbox',
      category: targetList?.label || '기본함',
      project: targetList?.label || '기본함',
    };
    if (options.owner) task.owner = options.owner;
    if (options.status) task.status = options.status;
    const source = options.source || (screen === 'calendar' ? 'calendar' : 'task');
    if (source === 'calendar') {
      const eventTask = { ...task, kind: 'calendar-event', type: 'calendar-event' };
      await persistCreatedTask(eventTask, 'calendar');
      return eventTask;
    }
    await persistCreatedTask(task, 'task');
    return task;
  }

  function submitQuick(fallbackDate?: string) {
    const value = quickText.trim();
    if (!value) return;
    setQuickText('');
    void createQuickTask(value, fallbackDate);
  }

  function patchTask(task: Item, patch: Item) {
    const id = itemId(task, '');
    if (!id) return;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 작업만 수정할 수 있습니다.');
      return;
    }
    const snapshot = { ...task, ...patch };
    void hermesApi.updateTask(id, taskPayload(snapshot))
      .then(() => hydrate())
      .catch((error) => setApiError(error instanceof Error ? error.message : '작업 업데이트 실패'));
  }

  function patchCalendarEvent(task: Item, patch: Item) {
    const id = itemId(task, '');
    if (!id) return;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 일정만 수정할 수 있습니다.');
      return;
    }
    const snapshot = { ...task, ...patch, kind: 'calendar-event', type: 'calendar-event' };
    void hermesApi.updateCalendarEvent(id, calendarEventPayload(snapshot))
      .then(() => hydrate())
      .catch((error) => setApiError(error instanceof Error ? error.message : '일정 업데이트 실패'));
  }

  function toggleTask(task: Item) {
    const done = !isDone(task);
    patchTask(task, { status: done ? 'Done' : 'Planned', done });
  }

  function removeTask(task: Item) {
    const id = itemId(task, '');
    if (!id) return;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 작업만 삭제할 수 있습니다.');
      return;
    }
    void hermesApi.deleteTask(id)
      .then(async () => {
        await hydrate();
        setSelectedTaskId('');
        setModal(null);
      })
      .catch((error) => setApiError(error instanceof Error ? error.message : '작업 삭제 실패'));
  }

  function removeCalendarEvent(task: Item) {
    const id = itemId(task, '');
    if (!id) return;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 일정만 삭제할 수 있습니다.');
      return;
    }
    void hermesApi.deleteCalendarEvent(id)
      .then(async () => {
        await hydrate();
        setSelectedTaskId('');
        setModal(null);
      })
      .catch((error) => setApiError(error instanceof Error ? error.message : '일정 삭제 실패'));
  }

  function openTask(task: Item) {
    setSelectedTaskId(itemId(task, ''));
    setModal('task');
  }

  function openRun(run?: Item) {
    if (run) setSelectedRunId(itemId(run, ''));
    setModal('run');
  }

  async function startPlan(goal: string, agentId = selectedAgentId) {
    const textValue = goal.trim();
    if (!textValue) return;
    setModal(null);
    try {
      await createQuickTask(textValue, todayKey(), { owner: 'Agent', status: 'Doing', source: 'task' });
      const runPayload = await hermesApi.launchMission({
        templateId: 'product-build',
        goal: textValue,
        agentId,
        source: 'desktop-mission',
      });
      const run = obj(runPayload, 'run');
      await hydrate();
      if (Object.keys(run).length) openRun(run);
      openScreen('agents');
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '미션 실행 실패');
    }
  }

  async function createAgent() {
    const name = newAgentName.trim();
    if (!name) return;
    try {
      await hermesApi.createAgent({
        name,
        displayName: name,
        emoji: newAgentEmoji,
        role: newAgentRole || '사용자 정의 에이전트',
        source: 'hermes-desktop',
      });
      setNewAgentName('');
      setNewAgentRole('');
      setNewAgentEmoji('🤖');
      setModal(null);
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 생성 실패');
    }
  }

  async function sendChat() {
    const message = chatInput.trim();
    if (!message) return;
    setChatInput('');
    setChatMessages((current) => [...current, { role: 'user', text: message }, { role: 'assistant', text: '' }]);
    try {
      const response = await hermesApi.streamChat({ message, view: screen, agent: 'default' });
      if (!response.ok || !response.body) throw new Error(`chat stream ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const textChunk = buffer
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.replace(/^data:\s*/, ''))
          .map((line) => {
            try {
              const parsed = JSON.parse(line) as { text?: string; run?: { goal?: string } };
              return parsed.text || parsed.run?.goal || '';
            } catch {
              return '';
            }
          })
          .join('');
        if (textChunk) {
          setChatMessages((current) => current.map((msg, index) => (
            index === current.length - 1 ? { ...msg, text: textChunk } : msg
          )));
        }
      }
      await hydrate();
    } catch (error) {
      setChatMessages((current) => current.map((msg, index) => (
        index === current.length - 1 ? { ...msg, text: `Railway 연결 실패: ${error instanceof Error ? error.message : 'unknown error'}` } : msg
      )));
    }
  }

  async function askWiki() {
    const question = wikiQuestion.trim();
    if (!question || wikiAsking) return;
    setWikiAsking(true);
    setWikiAnswer('');
    setWikiAnswerSources([]);
    try {
      const payload = await hermesApi.askWiki({
        question,
        path: activeWikiId,
        limit: 8,
        mode: 'wiki_qa',
      });
      const data = obj(payload, 'data');
      const answer = text(payload.answer || payload.text || data.answer || data.text, '');
      const sources = arr(payload, 'sources', 'citations').length ? arr(payload, 'sources', 'citations') : arr(data, 'sources', 'citations');
      setWikiAnswer(answer || '백엔드 위키 답변 본문이 비어 있습니다.');
      setWikiAnswerSources(sources);
    } catch (error) {
      setWikiAnswer(error instanceof Error ? `위키 답변 실패: ${error.message}` : '위키 답변 실패');
    } finally {
      setWikiAsking(false);
    }
  }

  async function generateRetroDraft(summary: {
    range: string;
    done: number;
    total: number;
    overdue: number;
    delegated: number;
    goals: string[];
  }) {
    const payload = await hermesApi.askWiki({
      mode: 'weekly_review',
      limit: 10,
      question: [
        `${summary.range} 주간 회고 초안을 작성해줘.`,
        `완료 ${summary.done}/${summary.total}, 지연 ${summary.overdue}, 위임 ${summary.delegated}.`,
        `이번 주 목표: ${summary.goals.length ? summary.goals.join(', ') : '백엔드 DB에 저장된 목표 없음'}.`,
        '좋았던 점, 막힌 점, 다음 주 개선 항목으로 간결하게 정리해줘.',
      ].join('\n'),
      context: summary,
    });
    const data = obj(payload, 'data');
    return text(payload.answer || payload.text || data.answer || data.text, '').trim();
  }

  async function createReviewGoal(title: string) {
    const value = title.trim();
    if (!value) return;
    await hermesApi.createTask({
      title: value,
      status: 'Planned',
      owner: 'Me',
      list: 'goals',
      category: '목표',
      project: '목표',
      tags: ['goal', 'review'],
      source: 'desktop-review-goal',
    });
    await hydrate();
  }

  async function saveDocument(body: Record<string, unknown>) {
    const payload = await hermesApi.createDocument({
      ...body,
      date: text(body.date, todayKey()),
      source: text(body.source, 'hermes-desktop'),
    });
    const doc = obj(payload, 'document');
    if (Object.keys(doc).length) setActiveNoteId(text(doc.id || doc.path || doc.wikiPath, ''));
    await hydrate();
    return payload;
  }

  async function saveDiary() {
    const body = diaryText.trim();
    if (!body) return;
    try {
      await saveDocument({
        title: `일기 · ${dateLabel()}`,
        body: `${diaryMood} ${body}`.trim(),
        kind: 'diary',
        tags: ['diary', 'journal'],
        source: 'hermes-desktop-diary',
      });
      setDiaryText('');
      setDiaryMood('');
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '일기 저장 실패');
    }
  }

  async function saveRetro(body: string) {
    const retro = body.trim();
    if (!retro) return;
    try {
      await saveDocument({
        title: `주간 회고 · ${dateLabel()}`,
        body: retro,
        kind: 'review',
        tags: ['review', 'weekly-retro'],
        source: 'hermes-desktop-review',
      });
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '회고 저장 실패');
    }
  }

  async function createNote() {
    try {
      const payload = await saveDocument({
        title: `생각노트 · ${dateLabel()}`,
        body: '',
        kind: 'note',
        tags: ['note'],
        source: 'hermes-desktop-note',
      });
      const doc = obj(payload, 'document');
      setActiveNoteId(text(doc.id || doc.path || doc.wikiPath, ''));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '메모 생성 실패');
    }
  }

  function openScreen(nextScreen: ScreenId, navKey: string = nextScreen) {
    setScreen(nextScreen);
    setActiveNavKey(navKey);
  }

  function openNewTask(date = screen === 'today' ? todayKey() : '', time = '') {
    const selectedList = activeListForNewTask();
    setNewTitle('');
    setNewDesc('');
    setNewDate(date);
    setNewTime(time);
    setNewEndDate(date);
    setNewEndTime('');
    setNewRepeat('none');
    setNewOwner('me');
    setNewList(selectedList?.id || 'inbox');
    setNewAllDay(false);
    setNewDatePanel(false);
    setNewListPanel(false);
    setNewSubPanel(null);
    setNewMode('date');
    setModal('new');
  }

  async function addTaskFromMail(mail: Item) {
    const id = itemId(mail, '');
    if (!id) return;
    try {
      await hermesApi.runInboxCommand(id, 'task', { message: itemTitle(mail, '메일 작업') });
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '메일 작업 추가 실패');
    }
  }

  async function archiveMail(mail: Item) {
    const id = itemId(mail, '');
    if (!id) return;
    try {
      await hermesApi.runInboxCommand(id, 'archive');
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '메일 보관 실패');
    }
  }

  async function toggleMailStar(mail: Item) {
    const id = itemId(mail, '');
    if (!id) return;
    const next = !(mail.star || mail.starred || mail.important);
    try {
      await hermesApi.runInboxCommand(id, next ? 'star' : 'unstar');
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '메일 별표 변경 실패');
    }
  }

  async function connectGmail() {
    const email = gmailEmail.trim();
    const password = gmailPassword.trim();
    if (!email || !password) {
      setMailStatus('Gmail 주소와 앱 비밀번호를 입력하세요.');
      return;
    }
    setMailSyncing(true);
    setMailStatus('Gmail 연결 중...');
    try {
      await hermesApi.saveMailAccount({
        provider: 'gmail',
        email,
        username: email,
        password,
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        enabled: true,
      });
      const synced = await hermesApi.syncMail({ provider: 'gmail', email, limit: 50 });
      const syncedItems = arr(synced, 'items', 'commands', 'commandRows', 'inbox', 'messages');
      if (syncedItems.length) {
        setState((current) => ({ ...current, inbox: syncedItems }));
        setActiveMailId(itemId(syncedItems[0], ''));
      }
      setGmailPassword('');
      setMailStatus(`Gmail 동기화 완료 · ${syncedItems.length || text(synced.imported || synced.count || synced.total, '0')}개`);
      await hydrate();
    } catch (error) {
      setMailStatus(error instanceof Error ? `Gmail 연결 실패: ${error.message}` : 'Gmail 연결 실패');
    } finally {
      setMailSyncing(false);
    }
  }

  async function openRunArtifact(run?: Item) {
    if (!run) return;
    const runId = itemId(run, `run-${Date.now()}`);
    const title = text(run.artifact || run.document || run.goal || run.title, '실행 결과 정리');
    try {
      const payload = await saveDocument({
        title,
        body: `🤖 ${text(run.agent, 'Hermes')} 실행 결과\n\n[목표]\n${text(run.goal || run.title, title)}\n\n[상태]\n${text(run.status, 'running')} · ${text(run.step, '실행 타임라인을 확인하세요.')}`,
        tag: '업무',
        kind: 'doc',
        source: 'hermes-desktop-run-artifact',
        runId,
      });
      const doc = obj(payload, 'document');
      setActiveWikiId(text(doc.path || doc.wikiPath || doc.id, ''));
      setWikiReaderOpen(true);
      openScreen('wiki');
      setModal(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '실행 결과 저장 실패');
    }
  }

  async function approveRun(run: Item) {
    const id = itemId(run, '');
    if (!id) return;
    try {
      await hermesApi.approveRun(id);
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '실행 승인 실패');
    }
  }

  async function updatePrefs(nextPrefs: UiPreferences) {
    try {
      const payload = await hermesApi.saveSettings({ uiPreferences: nextPrefs });
      const updated = settingsPreferences(payload);
      setPrefs(updated);
      setSettings((current) => ({ ...current, uiPreferences: updated }));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '환경설정 저장 실패');
    }
  }

  function findTaxonomy(kind: TaxonomyKind, navKey: string) {
    const id = navKey.replace(`${kind}:`, '');
    return taxonomy.find((entry) => entry.kind === kind && slugify(entry.id) === id);
  }

  function taskMatchesList(task: Item, list: TaxonomyItem) {
    const values = [task.project, task.category, task.list, task.source].map((value) => text(value)).filter(Boolean);
    return values.some((value) => slugify(value) === slugify(list.label) || slugify(value) === slugify(list.id));
  }

  function taskMatchesTag(task: Item, tag: TaxonomyItem) {
    return taskTags(task).some((value) => slugify(value) === slugify(tag.label) || slugify(value) === slugify(tag.id));
  }

  function openTaxonomyForm(kind: TaxonomyKind, group = kind === 'list' ? '리스트' : '태그', editing?: TaxonomyItem) {
    setTaxonomyForm({ kind, group, editing });
    setTaxonomyName(editing?.label || '');
    setTaxonomyGroupName(editing?.group || group);
    setTaxonomyIcon(editing?.icon || (kind === 'list' ? '📁' : '🏷'));
    setModal('taxonomy');
  }

  function taxonomyPayload(item: TaxonomyItem, hidden = false) {
    const payload = { ...item, hidden };
    return {
      title: `__hermes_${item.kind}:${item.label}`,
      label: item.label,
      name: item.label,
      slug: item.id,
      icon: item.icon,
      group: item.group,
      kind: 'taxonomy',
      type: 'taxonomy',
      taxonomyKind: item.kind,
      source: TAXONOMY_SOURCE,
      project: 'Hermes Metadata',
      status: hidden ? 'Hidden' : 'Active',
      tags: ['hermes-meta'],
      hidden,
      notes: JSON.stringify(payload),
    };
  }

  async function updateTaxonomy(item: TaxonomyItem) {
    if (item.recordId && shouldPersistTask(item.recordId)) {
      await hermesApi.updateTask(item.recordId, taxonomyPayload(item));
    } else {
      await hermesApi.createTask(taxonomyPayload(item));
    }
    await hydrate();
  }

  async function hideTaxonomy(item: TaxonomyItem) {
    const hiddenItem = { ...item, hidden: true };
    openScreen('tasks');
    try {
      if (item.recordId && shouldPersistTask(item.recordId)) {
        await hermesApi.updateTask(item.recordId, taxonomyPayload(hiddenItem, true));
      } else {
        await hermesApi.createTask(taxonomyPayload(hiddenItem, true));
      }
      await hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '리스트/태그 숨김 실패');
    }
  }

  async function createTaxonomy() {
    if (!taxonomyForm) return;
    const label = taxonomyName.trim();
    if (!label) return;
    const group = taxonomyGroupName.trim() || taxonomyForm.group || (taxonomyForm.kind === 'list' ? '리스트' : '태그');
    const icon = taxonomyIcon.trim() || (taxonomyForm.kind === 'list' ? '📁' : '🏷');
    const item: TaxonomyItem = { id: taxonomyForm.editing?.id || slugify(label), label, icon, group, kind: taxonomyForm.kind, recordId: taxonomyForm.editing?.recordId };
    setTaxonomyForm(null);
    setModal(null);
    setTaxonomyName('');
    setTaxonomyGroupName('');
    setTaxonomyIcon('');
    openScreen('tasks', taxonomyNavKey(item.kind, item.id));
    try {
      await updateTaxonomy(item);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '리스트/태그 저장 실패');
    }
  }

  function listForValue(value: string) {
    return listDefinitions.find((entry) => slugify(entry.id) === slugify(value) || slugify(entry.label) === slugify(value));
  }

  function activeListForNewTask() {
    if (activeNavKey.startsWith('list:') && activeNavKey !== 'list:notes' && activeNavKey !== 'list:someday') {
      return findTaxonomy('list', activeNavKey);
    }
    return listForValue(newList);
  }

  function activeTagForNewTask() {
    return activeNavKey.startsWith('tag:') ? findTaxonomy('tag', activeNavKey) : undefined;
  }

  const activeNavItem = useMemo(
    () => navGroups.flatMap((group) => group.items).find((item) => (item.navKey || item.id) === activeNavKey),
    [activeNavKey],
  );
  const selectedMeta = screen === 'tasks' && activeNavItem && (activeNavItem.navKey || activeNavItem.id) !== 'tasks'
    ? {
      title: activeNavItem.navKey?.startsWith('tag:') ? `#${activeNavItem.label}` : activeNavItem.label,
      sub: '',
    }
    : screen === 'today'
      ? { ...screenMeta.today, sub: todayMetaLabel() }
      : screenMeta[screen];
  const selectedTaxonomy = useMemo(() => {
    if (screen !== 'tasks') return undefined;
    if (activeNavKey.startsWith('list:') && activeNavKey !== 'list:notes' && activeNavKey !== 'list:someday') return findTaxonomy('list', activeNavKey);
    if (activeNavKey.startsWith('tag:')) return findTaxonomy('tag', activeNavKey);
    return undefined;
  }, [activeNavKey, screen, taxonomy]);
  const filteredTasks = useMemo(() => {
    let next = tasks;
    if (screen === 'today') next = next.filter((task) => text(task.date) === todayKey());
    if (screen === 'next7') {
      const end = addDaysKey(todayKey(), 7);
      next = next.filter((task) => text(task.date) && text(task.date) >= todayKey() && text(task.date) <= end);
    }
    if (screen === 'someday') next = next.filter((task) => ['someday', '언젠가'].includes(text(task.list || task.category)));
    if (activeNavKey.startsWith('list:') && activeNavKey !== 'list:notes' && activeNavKey !== 'list:someday') {
      const list = findTaxonomy('list', activeNavKey);
      if (list) next = next.filter((task) => taskMatchesList(task, list));
    }
    if (activeNavKey.startsWith('tag:')) {
      const tag = findTaxonomy('tag', activeNavKey);
      if (tag) next = next.filter((task) => taskMatchesTag(task, tag));
    }
    if (!query.trim()) return next;
    return next.filter((task) => text(task.title).toLowerCase().includes(query.toLowerCase()));
  }, [activeNavKey, query, screen, tasks, taxonomy]);
  const scheduledTaskItems = filteredTasks.filter((task) => text(task.date || task.startDate || task.day));
  const selectedTask = [...tasks, ...events].find((task, index) => itemId(task, `task-${index}`) === selectedTaskId);
  const countForNav = (item: NavItem) => {
    const key = item.navKey || item.id;
    const end = addDaysKey(todayKey(), 7);
    if (key === 'today') return tasks.filter((task) => text(task.date) === todayKey() && !isDone(task)).length;
    if (key === 'next7') return tasks.filter((task) => text(task.date) && text(task.date) >= todayKey() && text(task.date) <= end && !isDone(task)).length;
    if (key === 'mail') return mailItems.length;
    if (key === 'agents') return runs.length;
    if (key === 'list:notes') return docs.filter((doc) => text(doc.kind, 'note') === 'note').length;
    if (key === 'tasks') return tasks.filter((task) => !isDone(task) && ['inbox', '기본함'].includes(text(task.list || task.category))).length;
    if (key.startsWith('list:')) {
      const list = findTaxonomy('list', key);
      return list ? tasks.filter((task) => !isDone(task) && taskMatchesList(task, list)).length : 0;
    }
    if (key.startsWith('tag:')) {
      const tag = findTaxonomy('tag', key);
      return tag ? tasks.filter((task) => !isDone(task) && taskMatchesTag(task, tag)).length : 0;
    }
    return 0;
  };
  const mailItems = state.inbox;
  const docs = useMemo(() => {
    return state.docs;
  }, [state.docs]);
  const newTaskControls: NewTaskControls = {
    date: newDate,
    setDate: setNewDate,
    time: newTime,
    setTime: setNewTime,
    repeat: newRepeat,
    setRepeat: setNewRepeat,
    owner: newOwner,
    setOwner: setNewOwner,
    list: newList,
    setList: setNewList,
    allDay: newAllDay,
    setAllDay: setNewAllDay,
    datePanel: newDatePanel,
    setDatePanel: setNewDatePanel,
    listPanel: newListPanel,
    setListPanel: setNewListPanel,
    subPanel: newSubPanel,
    setSubPanel: setNewSubPanel,
    mode: newMode,
    setMode: setNewMode,
    endDate: newEndDate,
    setEndDate: setNewEndDate,
    endTime: newEndTime,
    setEndTime: setNewEndTime,
  };

  useEffect(() => {
    if (loading || apiError) return;
    if (!window.hermesDesktop?.saveWidgetSnapshot) return;
    const timer = setTimeout(() => {
      const snapshot = buildHermesWidgetSnapshot(tasks, events, runs);
      void window.hermesDesktop?.saveWidgetSnapshot(snapshot).catch((error) => {
        console.warn('Hermes widget snapshot save failed', error);
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [apiError, events, loading, runs, tasks]);

  return (
    <div className="app-root" data-theme={settings.theme}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">H</div>
          <div>
            <div className="brand-title">Hermes Tasks</div>
            <div className="brand-sub">할 일 · 캘린더 · 에이전트</div>
          </div>
        </div>
        <button className="sidebar-search" onClick={() => openScreen('search')}>
          <span>⌕</span><span>검색</span><kbd>⌘K</kbd>
        </button>
        <nav className="nav">
          {navGroups.map((group, groupIndex) => (
            <div key={group.title || `smart-${groupIndex}`}>
              {group.title && <div className="nav-title"><span>{group.title}</span>{group.kind ? <button title={`${group.kind === 'list' ? '리스트' : '태그'} 추가`} onClick={() => openTaxonomyForm(group.kind as TaxonomyKind, group.group)}>+</button> : null}</div>}
              {group.items.map((item) => {
                const count = countForNav(item);
                return <button className="nav-item" data-active={activeNavKey === (item.navKey || item.id)} key={item.navKey || item.id} onClick={() => openScreen(item.id, item.navKey || item.id)}>
                  <span><b>{item.icon}</b>{item.label}</span>
                  {count > 0 && <em>{count}</em>}
                </button>;
              })}
              {group.kind === 'tag' && !group.items.length && <button className="nav-item empty-taxonomy" onClick={() => openTaxonomyForm('tag', group.group)}><span><b>＋</b>태그 만들기</span></button>}
            </div>
          ))}
        </nav>
        <button className="profile" onClick={() => setModal('settings')}>
          <span className="avatar">윤</span>
          <span><strong>Yunseo</strong><small>{apiError ? 'Railway 확인 필요' : 'Railway 연결'}</small></span>
          <span>⚙</span>
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="screen-heading"><strong>{selectedMeta.title}</strong><span>{selectedMeta.sub}</span></div>
        </header>
        {apiError && <div className="api-banner"><strong>Railway API 확인 필요</strong><span>{apiError}</span><button onClick={() => void hydrate()}>재시도</button></div>}
        {loading ? <Loading /> : (
          <section className="content">
            {screen === 'calendar' && <CalendarScreen tasks={scheduledTaskItems} events={events} openNewTask={openNewTask} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} calView={calView} setCalView={setCalView} calDate={calDate} setCalDate={setCalDate} placingTaskId={placingTaskId} setPlacingTaskId={setPlacingTaskId} />}
            {screen === 'today' && <TodayScreen tasks={filteredTasks} runs={runs} approveRun={approveRun} quickText={quickText} setQuickText={setQuickText} submitQuick={() => submitQuick(todayKey())} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} openRun={openRun} />}
            {screen === 'tasks' && selectedTaxonomy && <TaxonomyManager item={selectedTaxonomy} edit={(item) => openTaxonomyForm(item.kind, item.group, item)} hide={(item) => void hideTaxonomy(item)} />}
            {(screen === 'tasks' || screen === 'next7' || screen === 'someday') && <TaskListScreen tasks={filteredTasks} quickText={quickText} setQuickText={setQuickText} submitQuick={() => submitQuick(screen === 'next7' ? todayKey() : undefined)} applyRepeatTemplate={(label) => {
              const templates: Record<string, string> = { '매일 루틴': '매일 ', '매주 회의': '매주 ', '매월 정산': '매월 ', '평일 근무': '근무 평일 ' };
              setQuickText(templates[label] || '');
            }} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} />}
            {screen === 'kanban' && <KanbanScreen tasks={filteredTasks} openTask={openTask} />}
            {screen === 'mail' && <MailScreen inbox={mailItems} activeMailId={activeMailId} setActiveMailId={setActiveMailId} addTaskFromMail={(mail) => { void addTaskFromMail(mail); }} archiveMail={(mail) => { void archiveMail(mail); }} delegateMail={(mail, reply) => { setDelegateText(reply ? `아래 메일에 대한 정중한 답장 초안을 작성해줘.\n\n${itemTitle(mail, '메일')}` : `다음 메일을 처리해줘.\n\n${itemTitle(mail, '메일')}`); setModal('delegate'); }} toggleStar={(mail) => { void toggleMailStar(mail); }} gmailEmail={gmailEmail} setGmailEmail={setGmailEmail} gmailPassword={gmailPassword} setGmailPassword={setGmailPassword} mailSyncing={mailSyncing} mailStatus={mailStatus} connectGmail={connectGmail} />}
            {screen === 'notes' && <NotesScreen docs={docs} activeNoteId={activeNoteId} setActiveNoteId={setActiveNoteId} newNote={createNote} />}
            {screen === 'review' && <ReviewScreen tasks={tasks} generateRetroDraft={generateRetroDraft} createReviewGoal={createReviewGoal} saveRetro={saveRetro} />}
            {screen === 'wiki' && <WikiScreen wiki={state.wiki} docs={docs} activeWikiId={activeWikiId} setActiveWikiId={setActiveWikiId} readerOpen={wikiReaderOpen} setReaderOpen={setWikiReaderOpen} question={wikiQuestion} setQuestion={setWikiQuestion} answer={wikiAnswer} sources={wikiAnswerSources} asking={wikiAsking} ask={askWiki} />}
            {screen === 'diary' && <DiaryScreen docs={docs} diaryText={diaryText} setDiaryText={setDiaryText} diaryMood={diaryMood} setDiaryMood={setDiaryMood} saveDiary={saveDiary} />}
            {screen === 'search' && <SearchScreen query={query} tasks={tasks} docs={docs} openTask={openTask} />}
            {screen === 'agents' && <AgentsScreen agents={agents} runs={runs} missionText={missionText} setMissionText={setMissionText} selectedAgentId={selectedAgentId} setSelectedAgentId={setSelectedAgentId} startPlan={() => startPlan(missionText)} openModal={setModal} openRun={openRun} />}
            {screen === 'widgets' && <WidgetsScreen tasks={tasks} events={events} runs={runs} />}
            {screen === 'settings' && <SettingsScreen settings={settings} setSettings={setSettings} refresh={hydrate} />}
            {screen === 'login' && <LoginScreen />}
          </section>
        )}
      </main>

      <button className="chat-fab" data-active={chatOpen} onClick={() => setChatOpen((open) => !open)} aria-label={chatOpen ? 'Hermes 콘솔 닫기' : 'Hermes 콘솔 열기'} title="Hermes 콘솔">
        <span>H</span>
      </button>
      {chatOpen && <ChatDrawer messages={chatMessages} input={chatInput} setInput={setChatInput} send={sendChat} runs={runs} setChip={setChatInput} close={() => setChatOpen(false)} openRun={openRun} />}
      {modal === 'taxonomy' && taxonomyForm && <TaxonomyModal form={taxonomyForm} name={taxonomyName} setName={setTaxonomyName} groupName={taxonomyGroupName} setGroupName={setTaxonomyGroupName} icon={taxonomyIcon} setIcon={setTaxonomyIcon} close={() => { setTaxonomyForm(null); setModal(null); }} submit={() => void createTaxonomy()} />}
      <Modal modal={modal} setModal={setModal} newTitle={newTitle} setNewTitle={setNewTitle} newDesc={newDesc} setNewDesc={setNewDesc} newTask={newTaskControls} createTask={createTask} lists={listDefinitions} tags={tagDefinitions} agents={agents} runs={runs} selectedRun={selectedRun} selectedTask={selectedTask} patchTask={patchTask} patchCalendarEvent={patchCalendarEvent} removeTask={removeTask} removeCalendarEvent={removeCalendarEvent} toggleTask={toggleTask} delegateText={delegateText} setDelegateText={setDelegateText} delegateAgentId={delegateAgentId} setDelegateAgentId={setDelegateAgentId} startPlan={() => startPlan(delegateText, delegateAgentId)} openRunArtifact={openRunArtifact} newAgentName={newAgentName} setNewAgentName={setNewAgentName} newAgentRole={newAgentRole} setNewAgentRole={setNewAgentRole} newAgentEmoji={newAgentEmoji} setNewAgentEmoji={setNewAgentEmoji} createAgent={createAgent} settings={settings} setSettings={setSettings} refresh={hydrate} loggedIn={loggedIn} setLoggedIn={setLoggedIn} loginEmail={loginEmail} setLoginEmail={setLoginEmail} loginPw={loginPw} setLoginPw={setLoginPw} prefs={prefs} updatePrefs={updatePrefs} />
      {!loggedIn && <LoginOverlay email={loginEmail} setEmail={setLoginEmail} password={loginPw} setPassword={setLoginPw} submit={() => { setLoggedIn(true); setLoginPw(''); setModal(null); }} />}
    </div>
  );
}

function Loading() {
  return <div className="loading"><span />Railway gateway에서 상태를 불러오는 중</div>;
}

function widgetItemDate(item: Item) {
  return text(item._calendarDate || item.date || item.startDate || item.day);
}

function widgetItemTime(item: Item) {
  return text(item.time || item.t || item.startTime);
}

function widgetOwnerClass(item: Item) {
  const owner = taskOwner(item);
  if (owner === 'Agent') return 'agent';
  if (owner === 'Hybrid') return 'hybrid';
  return 'me';
}

function widgetMonthCells(items: Item[], activeKey = todayKey()) {
  const active = new Date(`${activeKey}T00:00:00`);
  const first = new Date(active.getFullYear(), active.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const today = todayKey();
  const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateFmt.format(date);
    const events = items
      .filter((item) => widgetItemDate(item) === key)
      .sort((a, b) => `${widgetItemTime(a) || '99:99'}${itemTitle(a)}`.localeCompare(`${widgetItemTime(b) || '99:99'}${itemTitle(b)}`, 'ko'));
    return {
      key,
      day: date.getDate(),
      inMonth: date.getMonth() === active.getMonth(),
      today: key === today,
      weekend: date.getDay() === 0 || date.getDay() === 6,
      events,
    };
  });
}

function widgetDateMeta(value = todayKey()) {
  const date = new Date(`${value}T00:00:00`);
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const weekday = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: APP_TIME_ZONE }).format(date);
  return { month, year, dayLabel: `${month}월 ${date.getDate()}일 (${weekday})` };
}

function WidgetsScreen({ tasks, events, runs }: { tasks: Item[]; events: Item[]; runs: Item[] }) {
  const today = todayKey();
  const allCalendarItems: Item[] = [
    ...events.map((event) => ({ ...event, kind: 'calendar-event', type: 'calendar-event' })),
    ...tasks,
  ];
  const monthCells = widgetMonthCells(allCalendarItems, today);
  const dateMeta = widgetDateMeta(today);
  const todayItems = tasks
    .filter((task) => widgetItemDate(task) === today)
    .sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || `${widgetItemTime(a) || '99:99'}${itemTitle(a)}`.localeCompare(`${widgetItemTime(b) || '99:99'}${itemTitle(b)}`, 'ko'));
  const remaining = todayItems.filter((task) => !isDone(task)).length;
  const nowStamp = Date.now();
  const nextEvent: Item | undefined = allCalendarItems
    .filter((item) => widgetItemDate(item) && widgetItemTime(item) && !isDone(item))
    .map((item) => ({ item, stamp: new Date(`${widgetItemDate(item)}T${widgetItemTime(item)}`).getTime() }))
    .filter((entry) => Number.isFinite(entry.stamp) && entry.stamp >= nowStamp)
    .sort((a, b) => a.stamp - b.stamp)[0]?.item;
  const runningRuns = runs.filter((run) => /running|doing|active|진행|실행/i.test(text(run.status || run.state)));
  const topRun = runningRuns[0] || runs[0];
  const reviewPending = tasks.filter((task) => /review|검토/i.test(text(task.status || task.lane))).length;
  const progress = text(topRun?.pct || topRun?.progress || topRun?.percent, topRun ? '진행 중' : '대기');

  return <div className="widgets-showcase screen-in">
    <div className="widgets-sky" aria-hidden="true"><i /><b /></div>
    <header className="widgets-title">
      <div className="brand-mark">H</div>
      <div><strong>Hermes 위젯</strong><span>macOS 데스크톱 위젯 · 알림 센터</span></div>
    </header>
    <div className="widgets-layout">
      <section className="widget-card widget-month" aria-label="월 캘린더 Large 위젯">
        <header><strong>{dateMeta.month}월</strong><span>{dateMeta.year}</span><i>H</i></header>
        <div className="widget-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <b key={day}>{day}</b>)}</div>
        <div className="widget-month-grid">
          {monthCells.map((cell) => {
            const visibleEvents = cell.events.slice(0, 2);
            return <div className="widget-day" data-muted={!cell.inMonth} data-today={cell.today} key={cell.key}>
              <span>{cell.day}</span>
              <div>
                {visibleEvents.map((item, index) => <em className={`widget-pill ${widgetOwnerClass(item)}`} key={`${cell.key}-${itemId(item, index.toString())}`}>{itemTitle(item, '일정')}</em>)}
                {cell.events.length > visibleEvents.length && <em className="widget-pill more">+{cell.events.length - visibleEvents.length}</em>}
                {!visibleEvents.length && cell.weekend && cell.inMonth && <em className="widget-pill weekend">주말</em>}
              </div>
            </div>;
          })}
        </div>
      </section>

      <div className="widgets-column">
        <section className="widget-card widget-today" aria-label="오늘 Medium 위젯">
          <header><strong>오늘 — Medium</strong><span>{dateMeta.dayLabel}</span><i>{remaining} 남음</i></header>
          <div className="widget-today-list">
            {todayItems.slice(0, 4).map((task, index) => <div className="widget-task" data-done={isDone(task)} key={itemId(task, `widget-today-${index}`)}>
              <b>{isDone(task) ? '✓' : ''}</b>
              <span>{itemTitle(task, '작업')}</span>
              {widgetItemTime(task) && <small>{formatTime(widgetItemTime(task))}</small>}
              <em className={widgetOwnerClass(task)}>{taskOwner(task) === 'Agent' ? '에이전트' : taskOwner(task) === 'Hybrid' ? '공동' : '나'}</em>
            </div>)}
            {!todayItems.length && <div className="widget-empty">오늘 작업 없음</div>}
          </div>
        </section>

        <div className="widgets-small-row">
          <section className="widget-card widget-small widget-next" aria-label="다음 일정 Small 위젯">
            <span>다음 일정</span>
            <strong>{nextEvent ? itemTitle(nextEvent, '다음 일정') : '예정 없음'}</strong>
            <p>{nextEvent ? `${formatTime(widgetItemTime(nextEvent))} · ${text(nextEvent.category || nextEvent.project || nextEvent.list, 'Hermes')}` : '시간 지정 일정이 없습니다'}</p>
            <footer><i className={nextEvent ? widgetOwnerClass(nextEvent) : 'me'} />{nextEvent ? `${taskOwner(nextEvent) === 'Agent' ? '에이전트' : '내 일정'} · 30분` : '캘린더 대기'}</footer>
          </section>

          <section className="widget-card widget-small widget-agent" aria-label="에이전트 상태 Small 위젯">
            <header><i>H</i><span>에이전트 상태</span><b /></header>
            <strong>{runningRuns.length}</strong>
            <small>실행 중</small>
            <p>{topRun ? itemTitle(topRun, '에이전트 실행') : '대기 중'}<br />{progress}</p>
            {reviewPending > 0 && <em>{reviewPending} 검토</em>}
          </section>
        </div>
      </div>
    </div>
    <footer className="widgets-caption">
      <span>월 캘린더 — Large</span>
      <span>오늘 — Medium</span>
      <span>다음 일정 · 에이전트 상태 — Small</span>
    </footer>
  </div>;
}

function CalendarScreen({ tasks, events, openNewTask, openTask, toggleTask, patchTask, calView, setCalView, calDate, setCalDate, placingTaskId, setPlacingTaskId }: { tasks: Item[]; events: Item[]; openNewTask: (date?: string, time?: string) => void; openTask: (task: Item) => void; toggleTask: (task: Item) => void; patchTask: (task: Item, patch: Item) => void; calView: 'month' | 'week' | 'day'; setCalView: (view: 'month' | 'week' | 'day') => void; calDate: string; setCalDate: (date: string) => void; placingTaskId: string; setPlacingTaskId: (id: string) => void }) {
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const calendarItems: Item[] = [
    ...events.map((event) => ({ ...event, kind: 'calendar-event', type: 'calendar-event' })),
    ...tasks.map((task) => ({ ...task, kind: text(task.kind || 'scheduled-task') })),
  ];
  const itemStartDate = (item: Item) => text(item.date || item.startDate || item.day);
  const itemEndDate = (item: Item, start: string) => {
    const raw = text(item.endDate || item.until || item.end);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) && raw >= start ? raw : start;
  };
  const rangeDates = (start: string, end: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
    const dates: string[] = [];
    let cursor = start;
    while (cursor <= end && dates.length < 60) {
      dates.push(cursor);
      cursor = addDaysKey(cursor, 1);
    }
    return dates;
  };
  const expandedCalendarItems: Item[] = calendarItems.flatMap((item): Item[] => {
    const start = itemStartDate(item);
    const end = itemEndDate(item, start);
    const dates = rangeDates(start, end);
    return dates.map((date, index) => ({ ...item, _calendarDate: date, _rangeStart: start, _rangeEnd: end, _rangeOffset: index, _rangeLength: dates.length }));
  });
  const isRangePill = (item: Item) => text(item._rangeStart) && text(item._rangeEnd) && text(item._rangeStart) !== text(item._rangeEnd);
  const calendarItemClass = (item: Item) => [
    isCalendarEventRecord(item) ? 'calendar-event-pill' : 'scheduled-task-pill',
    `owner-${taskOwner(item).toLowerCase()}`,
    isDone(item) ? 'status-done' : 'status-open',
    isRangePill(item) ? 'range-pill' : '',
    isRangePill(item) && text(item._calendarDate) === text(item._rangeStart) ? 'range-start' : '',
    isRangePill(item) && text(item._calendarDate) === text(item._rangeEnd) ? 'range-end' : '',
  ].filter(Boolean).join(' ');
  const calendarPillContent = (item: Item, fallback: string) => {
    const range = isRangePill(item);
    const showTitle = !range || Number(item._rangeOffset || 0) === 0;
    const showTime = !!text(item.time || item.t) && (!range || text(item._calendarDate) === text(item._rangeEnd));
    return <><span>{showTitle ? itemTitle(item, fallback) : '\u00A0'}</span>{showTime && <b>{formatTime(text(item.time || item.t))}</b>}</>;
  };
  const activeDate = new Date(`${calDate}T00:00:00`);
  const today = todayKey();
  const gridStart = new Date(activeDate.getFullYear(), activeDate.getMonth(), 1);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const label = `${activeDate.getFullYear()}년 ${activeDate.getMonth() + 1}월`;
  const shiftCalendar = (direction: number) => {
    if (calView === 'month') setCalDate(addMonthsKey(calDate, direction));
    if (calView === 'week') setCalDate(addDaysKey(calDate, direction * 7));
    if (calView === 'day') setCalDate(addDaysKey(calDate, direction));
  };
  const itemsFor = (date: string) => {
    const matched = expandedCalendarItems
      .filter((item) => text(item._calendarDate) === date)
      .sort((a, b) => Number(b._rangeLength || 1) - Number(a._rangeLength || 1) || text(a._rangeStart).localeCompare(text(b._rangeStart)));
    return matched.slice(0, 4);
  };
  const cells = Array.from({ length: 35 }, (_, index) => {
    const dateValue = new Date(gridStart);
    dateValue.setDate(gridStart.getDate() + index);
    const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateValue);
    return { day: dateValue.getDate(), date, inMonth: dateValue.getMonth() === activeDate.getMonth(), today: date === today, selected: date === calDate, items: itemsFor(date) };
  });
  const weekStart = new Date(`${calDate}T00:00:00`);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekCells = Array.from({ length: 7 }, (_, index) => {
    const dateValue = new Date(weekStart);
    dateValue.setDate(weekStart.getDate() + index);
    const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateValue);
    return { date, day: dateValue.getDate(), today: date === today, selected: date === calDate, weekday: weekdays[dateValue.getDay()], items: itemsFor(date).slice(0, 5) };
  });
  const dayDate = calDate;
  const dayDateObj = new Date(`${dayDate}T00:00:00`);
  const dayItems = itemsFor(dayDate).slice(0, 6);
  const placingTask = tasks.find((task, index) => itemId(task, `task-${index}`) === placingTaskId);
  const hours = Array.from({ length: 16 }, (_, index) => {
    const hour = index + 7;
    const time = `${String(hour).padStart(2, '0')}:00`;
    return { hour, time, items: dayItems.filter((item) => text(item.time).startsWith(String(hour).padStart(2, '0'))).slice(0, 2) };
  });
  const allDayItems = dayItems.filter((item) => !text(item.time));
  return <div className="calendar screen-in">
    <div className="screen-toolbar"><h2>{label}</h2><Legend /><Segment items={['월', '주', '일']} active={calView} setActive={(value) => setCalView(value as 'month' | 'week' | 'day')} values={['month', 'week', 'day']} /><button onClick={() => { setCalDate(todayKey()); setPlacingTaskId(''); }}>오늘</button><button onClick={() => shiftCalendar(-1)}>‹</button><button onClick={() => shiftCalendar(1)}>›</button></div>
    {calView === 'month' && <div className="month-grid">
      {weekdays.map((day) => <div className="weekday" key={day}>{day}</div>)}
      {cells.map((cell) => <button className="day-cell" data-muted={!cell.inMonth} data-today={cell.today} data-selected={cell.selected} key={cell.date} onClick={() => openNewTask(cell.date)}>
        <strong onClick={(event) => { event.stopPropagation(); setCalDate(cell.date); setCalView('day'); }}>{cell.day}</strong>
        {cell.items.map((item, index) => <span className={`event-pill ${calendarItemClass(item)}`} key={`${cell.day}-${index}`} onClick={(event) => { event.stopPropagation(); openTask(item); }}>{calendarPillContent(item, isCalendarEventRecord(item) ? '일정' : '작업')}</span>)}
      </button>)}
    </div>}
    {calView === 'week' && <div className="week-grid">
      {weekCells.map((cell) => <section className="week-col" data-today={cell.today} data-selected={cell.selected} key={cell.date}>
        <button className="week-head" onClick={() => { setCalDate(cell.date); setCalView('day'); }}><span>{cell.weekday}</span><strong>{cell.day}</strong></button>
        <div className="week-events" onClick={() => openNewTask(cell.date)}>
          {cell.items.map((item, index) => <button className={`week-event ${calendarItemClass(item)}`} key={`${cell.date}-${index}`} onClick={(event) => { event.stopPropagation(); openTask(item); }}><small>{text(item.time || item.t, index % 2 ? '오후 2:00' : '오전 9:00')}</small>{itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}</button>)}
        </div>
      </section>)}
    </div>}
    {calView === 'day' && <div className="day-schedule">
      <div className="day-hours">
        {hours.map((row) => <button className="hour-row" data-placing={!!placingTask} key={row.time} onClick={() => {
          if (placingTask) {
            patchTask(placingTask, { date: dayDate, time: row.time });
            setPlacingTaskId('');
          } else {
            openNewTask(dayDate, row.time);
          }
        }}>
          <span>{formatTime(row.time).replace(':00', '시')}</span>
          <div>{row.items.map((item, index) => <em className={calendarItemClass(item)} key={`${row.time}-${index}`} onClick={(event) => { event.stopPropagation(); openTask(item); }}><b>{formatTime(text(item.time || item.t, row.time))}</b> {itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}</em>)}</div>
        </button>)}
      </div>
      <aside className="day-side">
        <h3>{dayDateObj.getMonth() + 1}월 {dayDateObj.getDate()}일 ({weekdays[dayDateObj.getDay()]})</h3>
        <p>{placingTask ? `"${itemTitle(placingTask, '작업')}" 배치할 시간 슬롯을 선택하세요` : <>하루 종일 · 시간 미지정 <span>· "시간 잡기"로 타임블록</span></>}</p>
        {allDayItems.slice(0, 4).map((item, index) => <div className="day-all-day" data-event={isCalendarEventRecord(item)} data-done={isDone(item)} role="button" tabIndex={0} key={index} onClick={() => openTask(item)} onKeyDown={(event) => { if (event.key === 'Enter') openTask(item); }}>
          {!isCalendarEventRecord(item) && <i onClick={(event) => { event.stopPropagation(); toggleTask(item); }}>{isDone(item) ? '✓' : ''}</i>}<span>{itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}</span>{!isCalendarEventRecord(item) && <b onClick={(event) => { event.stopPropagation(); setPlacingTaskId(itemId(item, `day-${index}`)); }}>⏰ 시간 잡기</b>}
        </div>)}
      </aside>
    </div>}
  </div>;
}

function TodayScreen({ tasks, runs, approveRun, quickText, setQuickText, submitQuick, openTask, toggleTask, patchTask, openRun }: { tasks: Item[]; runs: Item[]; approveRun: (run: Item) => void; quickText: string; setQuickText: (value: string) => void; submitQuick: () => void; openTask: (task: Item) => void; toggleTask: (task: Item) => void; patchTask: (task: Item, patch: Item) => void; openRun: (run?: Item) => void }) {
  const today = todayKey();
  const tomorrow = addDaysKey(today, 1);
  const active = tasks.filter((task) => !isDone(task));
  const todayTasks = active.filter((task) => text(task.date) === today).slice(0, 5);
  const overdue = active.filter((task) => {
    const date = text(task.date);
    return date && date < today;
  }).slice(0, 4);
  const reviewRuns = runs.filter((run) => /done|완료|review|검토/i.test(text(run.status)) && !/approved|승인/i.test(text(run.status))).slice(0, 3);
  const suggestions = active.filter((task) => !text(task.date)).slice(0, 3);
  const stats = [
    ['지연', overdue.length, overdue.length ? '#C0533B' : '#3E9B72'],
    ['오늘 할 일', todayTasks.length, '#2B2620'],
    ['검토 대기', reviewRuns.length, reviewRuns.length ? '#9A7322' : '#3E9B72'],
  ];
  return <div className="plan-screen screen-in">
    <div className="quick-row plan-quick"><span>+</span><input value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitQuick(); }} placeholder="오늘 할 일 추가  ·  예: 오후3시 롯데리아 #업무 !높음 @hermes" /><button onClick={submitQuick}>추가</button></div>
    <div className="plan-stats">{stats.map(([label, value, color]) => <div key={String(label)}><span>{label}</span><strong style={{ color: String(color) }}>{value}</strong></div>)}</div>

    <section className="plan-section">
      <h2>📅 오늘 할 일</h2>
      <div className="plan-stack">
        {todayTasks.map((task, index) => <PlanTaskRow key={itemId(task, `today-${index}`)} task={task} openTask={openTask} toggleTask={toggleTask} />)}
        {!todayTasks.length && <div className="plan-empty">오늘 잡힌 작업이 없습니다</div>}
      </div>
    </section>

    <section className="plan-section">
      <h2 className="danger">⏰ 지연된 작업 <small>오늘로 당기거나 다시 잡으세요</small></h2>
      <div className="plan-stack">
        {overdue.map((task, index) => <div className="plan-row overdue" key={itemId(task, `overdue-${index}`)}>
          <button className="check" onClick={() => toggleTask(task)}>{isDone(task) ? '✓' : ''}</button>
          <span><b>{itemTitle(task, '작업')}</b><small>{formatDateChip(text(task.date))} · {text(task.category || task.project || task.source, '기본함')}</small></span>
          <button className="mini primaryish" onClick={() => patchTask(task, { date: today })}>오늘로</button>
          <button className="mini" onClick={() => patchTask(task, { date: tomorrow })}>내일로</button>
        </div>)}
        {!overdue.length && <div className="plan-empty success">✓ 지연된 작업 없음 - 깔끔하네요!</div>}
      </div>
    </section>

    <section className="plan-section">
      <h2 className="agent">🤖 에이전트가 끝냈어요 <small>검토하고 승인하세요</small></h2>
      <div className="plan-stack">
        {reviewRuns.map((run, index) => <div className="plan-row review-row" role="button" tabIndex={0} key={itemId(run, `run-${index}`)} onClick={() => openRun(run)} onKeyDown={(event) => { if (event.key === 'Enter') openRun(run); }}>
          <i>✦</i><span><b>{itemTitle(run, '에이전트 결과')}</b><small>{text(run.agent, 'default')} · 완료 · 검토 대기</small></span><button className="approve" onClick={(event) => { event.stopPropagation(); approveRun(run); }}>승인</button>
        </div>)}
        {!reviewRuns.length && <div className="plan-empty">검토할 에이전트 결과가 없습니다</div>}
      </div>
    </section>

    {!!suggestions.length && <section className="plan-section">
      <h2>💡 기본함에서 오늘로?</h2>
      <div className="plan-stack">
        {suggestions.map((task, index) => <div className="plan-row suggest-row" key={itemId(task, `suggest-${index}`)}>
          <span><b>{itemTitle(task, '작업')}</b></span><small>{text(task.category || task.project || task.source, '기본함')}</small><button className="mini" onClick={() => patchTask(task, { date: today })}>+ 오늘</button>
        </div>)}
      </div>
    </section>}
  </div>;
}

function PlanTaskRow({ task, openTask, toggleTask }: { task: Item; openTask: (task: Item) => void; toggleTask: (task: Item) => void }) {
  return <button className="plan-row" onClick={() => openTask(task)}>
    <i className="check" onClick={(event) => { event.stopPropagation(); toggleTask(task); }}>{isDone(task) ? '✓' : ''}</i>
    <span><b>{itemTitle(task, '작업')}</b><small>{text(task.time) ? formatTime(text(task.time)) : text(task.category || task.project || task.source, '기본함')}</small></span>
    {text(task.time) && <em>{formatTime(text(task.time))}</em>}
    <small>{text(task.category || task.project || task.source, '기본함')}</small>
  </button>;
}

function TaxonomyManager({ item, edit, hide }: { item: TaxonomyItem; edit: (item: TaxonomyItem) => void; hide: (item: TaxonomyItem) => void }) {
  return <div className="taxonomy-manager">
    <div><strong>{item.icon} {item.kind === 'tag' ? `#${item.label}` : item.label}</strong><span>{item.group}</span></div>
    <button onClick={() => edit(item)}>편집</button>
    <button onClick={() => hide(item)}>숨김</button>
  </div>;
}

function TaxonomyModal({ form, name, setName, groupName, setGroupName, icon, setIcon, close, submit }: { form: { kind: TaxonomyKind; group: string; editing?: TaxonomyItem }; name: string; setName: (value: string) => void; groupName: string; setGroupName: (value: string) => void; icon: string; setIcon: (value: string) => void; close: () => void; submit: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const emojiOptions = ['🚀', '⌛', '🏐', '💡', '📁', '📝', '💼', '🏃', '🔷', '💌', '🥺', '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥶', '🥵'];
  const categoryOptions = form.kind === 'list' ? ['🎓', '🏫', '💵', '🏌️', '📈', '👨‍💼', '🚀', '🥺', '📜', '⌛'] : ['🏷', '🔥', '✅', '⭐', '📌', '💡', '🧠', '⚡'];
  const title = form.kind === 'list' ? '폴더 편집' : '태그 편집';
  const placeholder = form.kind === 'list' ? '폴더 이름' : '태그 이름';
  return <div className="modal-backdrop taxonomy-backdrop" onMouseDown={close}>
    <div className="taxonomy-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <button aria-label="닫기" onClick={close} />
        <strong>{title}</strong>
        <span />
      </header>
      <div className="taxonomy-field">
        <button className="taxonomy-emoji" onClick={() => setPickerOpen((open) => !open)}>{icon || (form.kind === 'list' ? '📁' : '🏷')}</button>
        <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} placeholder={placeholder} autoFocus />
      </div>
      {pickerOpen && <div className="emoji-picker">
        <section><strong>자주 사용됨⌄</strong><div className="emoji-grid">{categoryOptions.map((emoji) => <button data-active={icon === emoji} key={`cat-${emoji}`} onClick={() => { setIcon(emoji); setPickerOpen(false); }}>{emoji}</button>)}</div></section>
        <section><strong>인물 &amp; 몸체⌄</strong><div className="emoji-grid">{emojiOptions.map((emoji) => <button data-active={icon === emoji} key={emoji} onClick={() => { setIcon(emoji); setPickerOpen(false); }}>{emoji}</button>)}</div></section>
      </div>}
      <input className="taxonomy-group-input" value={groupName} onChange={(event) => setGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} placeholder={form.kind === 'list' ? '리스트 그룹' : '태그 그룹'} />
      <footer>
        <span />
        <button onClick={close}>취소</button>
        <button className="primary" onClick={submit}>저장</button>
      </footer>
    </div>
  </div>;
}

function TaskListScreen({ tasks, quickText, setQuickText, submitQuick, applyRepeatTemplate, openTask, toggleTask, patchTask }: { tasks: Item[]; quickText: string; setQuickText: (value: string) => void; submitQuick: () => void; applyRepeatTemplate: (label: string) => void; openTask: (task: Item) => void; toggleTask: (task: Item) => void; patchTask: (task: Item, patch: Item) => void }) {
  const [inspectorTaskId, setInspectorTaskId] = useState('');
  const parsed = quickText ? parseQuick(quickText) : null;
  const active = tasks.filter((task) => !isDone(task));
  const overdue = active.filter((task) => {
    const date = text(task.date);
    return date && date < todayKey();
  });
  const upcoming = active.filter((task) => !overdue.includes(task));
  const completed = tasks.filter(isDone);
  const selectedTask = tasks.find((task, index) => itemId(task, `task-${index}`) === inspectorTaskId) || active[0] || completed[0];
  const selectedId = itemId(selectedTask || {}, '');
  useEffect(() => {
    if (!selectedTask && tasks.length) setInspectorTaskId(itemId(tasks[0], ''));
  }, [selectedTask, tasks]);
  const renderRows = (rows: Item[], prefix: string) => rows.map((task, index) => {
    const id = itemId(task, `${prefix}-${index}`);
    return <TaskRow key={id} task={task} selected={selectedId === id || (!selectedId && index === 0)} selectTask={() => setInspectorTaskId(id)} openTask={openTask} toggleTask={toggleTask} />;
  });
  const postponeOverdue = () => overdue.forEach((task) => patchTask(task, { date: todayKey() }));
  return <div className="list-screen task-list-screen screen-in">
    <section className="task-list-main">
      <div className="quick-row list-quick"><span>+</span><input value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitQuick(); }} placeholder="할 일 추가  ·  예: 내일 오후3시 롯데리아 #업무 !높음 매주 @hermes" /><button onClick={submitQuick}>추가</button></div>
      {parsed && quickText.trim() && <div className="quick-preview">{parsed.date && <span>📅 {parsed.date}</span>}{parsed.time && <span>🕑 {parsed.time}</span>}{parsed.repeat !== 'none' && <span>⟳ {parsed.repeat}</span>}{parsed.priority && <span>⚑ {parsed.priority}</span>}{parsed.tags.map((tag) => <span key={tag}>#{tag}</span>)}{parsed.owner === 'Agent' && <span>🤖 에이전트</span>}</div>}
      {!quickText.trim() && <div className="quick-spacer" />}
      <div className="repeat-chips"><span>반복 템플릿</span>{['매일 루틴', '매주 회의', '매월 정산', '평일 근무'].map((label) => <button key={label} onClick={() => applyRepeatTemplate(label)}><span>⟳</span>{label}</button>)}</div>
      {!!overdue.length && <section className="task-section"><header><button>⌄</button><strong>만료됨</strong><span>{overdue.length}</span><button className="postpone" onClick={postponeOverdue}>연기하다</button></header><div className="rows task-rows">{renderRows(overdue, 'overdue')}</div></section>}
      {!!upcoming.length && <section className="task-section"><header><button>⌄</button><strong>할 일</strong><span>{upcoming.length}</span></header><div className="rows task-rows">{renderRows(upcoming, 'active')}</div></section>}
      {!active.length && <div className="task-empty">표시할 작업이 없습니다 · 위에서 추가하세요</div>}
      {!!completed.length && <details className="completed-block"><summary>완료됨 {completed.length}</summary><div className="rows task-rows">{completed.map((task, index) => {
        const id = itemId(task, `done-${index}`);
        return <TaskRow key={id} task={task} selected={selectedId === id} selectTask={() => setInspectorTaskId(id)} openTask={openTask} toggleTask={toggleTask} />;
      })}</div></details>}
    </section>
    <TaskInspectorPane key={selectedId} task={selectedTask} patchTask={patchTask} toggleTask={toggleTask} openTask={openTask} close={() => setInspectorTaskId('')} />
  </div>;
}

function TaskRow({ task, selected, selectTask, openTask, toggleTask }: { task: Item; selected: boolean; selectTask: () => void; openTask: (task: Item) => void; toggleTask: (task: Item) => void }) {
  const tags = Array.isArray(task.tags) ? task.tags.map(String) : text(task.tags).split(',').filter(Boolean);
  const owner = taskOwner(task);
  const priority = text(task.priority || task.pri);
  const due = text(task.date);
  return <button className="row task-row" data-active={selected} data-done={isDone(task)} onClick={selectTask} onDoubleClick={() => openTask(task)}>
    <i onClick={(event) => { event.stopPropagation(); toggleTask(task); }}>{isDone(task) ? '✓' : ''}</i>
    <span className="task-copy">
      <b>{itemTitle(task, '작업')}</b>{text(task.repeat) && text(task.repeat) !== 'none' && <em title="반복">⟳</em>}
      <small className="task-meta">
        <mark>{text(task.category || task.project || task.source || task.list, '기본함')}</mark>
        {tags.map((tag) => <mark className="tag" key={tag}>#{tag}</mark>)}
        {owner !== 'Me' && <mark className={`owner ${owner.toLowerCase()}`}>{owner}</mark>}
      </small>
    </span>
    {due && <time className="task-due">{formatDateChip(due)}</time>}
    {priority && <strong className="priority">⚑</strong>}
  </button>;
}

function TaskInspectorPane({ task, patchTask, toggleTask, openTask, close }: { task?: Item; patchTask: (task: Item, patch: Item) => void; toggleTask: (task: Item) => void; openTask: (task: Item) => void; close: () => void }) {
  if (!task) return <aside className="task-inspector empty"><div>작업을 선택하세요</div></aside>;
  const tags = taskTags(task);
  const owner = taskOwner(task);
  return <aside className="task-inspector">
    <header>
      <button className="detail-check" data-done={isDone(task)} onClick={() => toggleTask(task)}>{isDone(task) ? '✓' : ''}</button>
      {text(task.date) ? <span className="inspector-date">📅 {formatDateChip(text(task.date))}</span> : <span className="inspector-date muted">날짜 없음</span>}
      <span />
      <button className="flag" data-active={!!text(task.priority)}>⚑</button>
      <button className="close" onClick={close}>×</button>
    </header>
    <input className="inspector-title" defaultValue={itemTitle(task, '')} onBlur={(event) => patchTask(task, { title: event.target.value })} placeholder="제목 없음" />
    <div className="inspector-meta">
      <button onClick={() => openTask(task)}>전체 편집</button>
      <span>{text(task.category || task.project || task.source || task.list, '기본함')}</span>
      {owner !== 'Me' && <span>{owner}</span>}
      {tags.map((tag) => <span key={tag}>#{tag}</span>)}
    </div>
    <textarea defaultValue={text(task.notes || task.description)} onBlur={(event) => patchTask(task, { notes: event.target.value })} placeholder="메모 추가" />
    <section className="subtask-box">
      <strong>0 완료된 할일</strong>
      <button>＋ 하위 할일 추가</button>
    </section>
    <footer>
      <span>{formatUpdatedStamp(text(task.updated || task.updatedAt || task.createdAt || task.time))}</span>
      <button>A</button>
      <button>💬</button>
      <button>⋯</button>
    </footer>
  </aside>;
}

function KanbanScreen({ tasks, openTask }: { tasks: Item[]; openTask: (task: Item) => void }) {
  const colDefs = [
    { key: 'todo', label: '기본', color: '#C7BCA6' },
    { key: 'doing', label: '진행 중', color: '#3B7DD8' },
    { key: 'review', label: '검토', color: '#E0913B' },
    { key: 'done', label: '완료', color: '#3E9B72' },
  ];
  const belongs = (task: Item, key: string) => {
    const status = text(task.status || task.state).toLowerCase();
    if (key === 'done') return isDone(task) || /done|complete|완료/.test(status);
    if (key === 'doing') return /doing|running|progress|진행/.test(status);
    if (key === 'review') return /review|검토|queued|대기/.test(status);
    return !isDone(task) && !/doing|running|progress|진행|review|검토|queued|대기|done|complete|완료/.test(status);
  };
  return <div className="kanban screen-in">
    {colDefs.map((col) => {
      const cards = tasks.filter((task) => belongs(task, col.key));
      return <section className="kanban-col" key={col.key}>
        <h3><i style={{ background: col.color }} /><strong>{col.label}</strong><span>{cards.length}</span></h3>
        <div>{cards.map((task, index) => {
          const owner = taskOwner(task);
          return <button className="kanban-card" key={`${col.key}-${itemId(task, String(index))}`} onClick={() => openTask(task)}>
            <strong>{itemTitle(task, '작업')}</strong>
            <p><span>{text(task.category || task.project || task.source || task.list, '📥 기본함')}</span>{text(task.date) && <small>{formatDateChip(text(task.date))}</small>}<em data-owner={owner.toLowerCase()}>{owner !== 'Me' ? owner : ''}</em></p>
          </button>;
        })}</div>
      </section>;
    })}
  </div>;
}

function MailScreen({ inbox, activeMailId, setActiveMailId, addTaskFromMail, archiveMail, delegateMail, toggleStar, gmailEmail, setGmailEmail, gmailPassword, setGmailPassword, mailSyncing, mailStatus, connectGmail }: { inbox: Item[]; activeMailId: string; setActiveMailId: (id: string) => void; addTaskFromMail: (mail: Item) => void; archiveMail: (mail: Item) => void; delegateMail: (mail: Item, reply?: boolean) => void; toggleStar: (mail: Item) => void; gmailEmail: string; setGmailEmail: (value: string) => void; gmailPassword: string; setGmailPassword: (value: string) => void; mailSyncing: boolean; mailStatus: string; connectGmail: () => void }) {
  const items = inbox;
  const active = items.find((mail, index) => itemId(mail, `mail-${index}`) === activeMailId) || items[0];
  const activeId = itemId(active || {}, '');
  const unread = items.filter((mail) => mail.unread !== false && !mail.read).length;
  const avatar = (mail: Item) => text(mail.from || mail.sender || mail.sourceLabel, 'H').trim().slice(0, 1).toUpperCase();
  return <div className="mail screen-in">
    <aside className="mail-list">
      <header><strong>✉️ 받은편지함</strong><em>{unread} 안 읽음</em><button onClick={connectGmail} disabled={mailSyncing}>⟳</button></header>
      <section className="gmail-connect">
        <label>Gmail 연결</label>
        <input value={gmailEmail} onChange={(event) => setGmailEmail(event.target.value)} placeholder="name@gmail.com" autoComplete="username" />
        <input value={gmailPassword} onChange={(event) => setGmailPassword(event.target.value)} placeholder="Google 앱 비밀번호" type="password" autoComplete="current-password" />
        <button onClick={connectGmail} disabled={mailSyncing}>{mailSyncing ? '동기화 중' : '연결 · 동기화'}</button>
        {mailStatus && <small>{mailStatus}</small>}
      </section>
      <div>
        {items.map((mail, index) => {
          const id = itemId(mail, `mail-${index}`);
          const from = text(mail.from || mail.sender || mail.sourceLabel, 'Hermes');
          const subject = text(mail.subject || mail.title, '메일');
          const preview = text(mail.preview || mail.body || mail.snippet, '메일 내용을 확인하세요.');
          const starred = !!(mail.star || mail.starred || mail.important);
          return <button className="mail-item" data-active={id === activeId} data-unread={mail.unread !== false && !mail.read} key={id} onClick={() => setActiveMailId(id)}>
            <i />
            <span className="mail-avatar">{avatar(mail)}</span>
            <span className="mail-copy">
              <span className="mail-line"><b>{from}</b><small>{starred && <mark>★</mark>}{text(mail.time || mail.createdAt, '방금')}</small></span>
              <strong>{subject}</strong>
              <em>{preview}</em>
            </span>
          </button>;
        })}
      </div>
    </aside>
    <article className="mail-reader">
      {active ? <div className="mail-reader-inner">
        <section className="mail-head">
          <div><h2>{text(active.subject || active.title, '메일을 선택하세요')}</h2><button aria-label="별표" onClick={() => toggleStar(active)}>{active.star || active.starred ? '★' : '☆'}</button></div>
          <footer><span className="mail-avatar large">{avatar(active)}</span><span><b>{text(active.from || active.sender || active.sourceLabel, 'Hermes')}</b><small>{text(active.email || active.addr || active.address, 'hermes@local')}</small></span><time>{text(active.time || active.createdAt, '방금')}</time></footer>
        </section>
        <div className="action-row mail-actions">
          <button onClick={() => addTaskFromMail(active)}>⊕ 작업으로 추가</button>
          <button className="delegate" onClick={() => delegateMail(active)}>⚡ 에이전트에 위임</button>
          <button onClick={() => delegateMail(active, true)}>✦ 답장 초안</button>
          <button className="archive" onClick={() => archiveMail(active)}>보관</button>
        </div>
        <section className="mail-body">{text(active.body || active.preview || active.snippet, '메일 내용을 작업, 위임, 답장 초안으로 전환할 수 있습니다.')}</section>
      </div> : <div className="mail-empty">메일을 선택하세요</div>}
    </article>
  </div>;
}

function NotesScreen({ docs, activeNoteId, setActiveNoteId, newNote }: { docs: Item[]; activeNoteId: string; setActiveNoteId: (id: string) => void; newNote: () => void }) {
  const active = docs.find((doc, index) => itemId(doc, `note-${index}`) === activeNoteId) || docs[0];
  return <div className="notes-editor screen-in">
    <aside className="note-list">
      <header><strong>📝 생각노트</strong><span>{docs.length}</span><button onClick={newNote}>+ 메모</button></header>
      <div>{docs.map((doc, index) => {
        const id = itemId(doc, `note-${index}`);
        return <button className="note-item" data-active={id === itemId(active || {}, '')} key={id} onClick={() => setActiveNoteId(id)}>
          <span><i>📄</i><b>{itemTitle(doc, '노트')}</b></span>
          <em>{text(doc.body || doc.summary || doc.extract || doc.excerpt, '내용 없음')}</em>
        </button>;
      })}</div>
    </aside>
    <section className="note-editor">
      {active ? <div><input value={itemTitle(active, '')} readOnly placeholder="제목 없음" /><small>{text(active.date || active.updated || active.tag, '방금 수정')}</small><textarea value={text(active.body || active.summary || active.extract || active.excerpt)} readOnly placeholder="백엔드에 저장된 노트를 선택하세요" /></div> : <p>메모를 선택하세요</p>}
    </section>
  </div>;
}

function ReviewScreen({ tasks, generateRetroDraft, createReviewGoal, saveRetro }: { tasks: Item[]; generateRetroDraft: (summary: { range: string; done: number; total: number; overdue: number; delegated: number; goals: string[] }) => Promise<string>; createReviewGoal: (title: string) => Promise<void>; saveRetro: (body: string) => void }) {
  const done = tasks.filter(isDone).length;
  const [goalInput, setGoalInput] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [retro, setRetro] = useState('');
  const range = weekRangeLabel();
  const goals = tasks
    .filter((task) => /goal|objective|목표/i.test(text(task.kind || task.type || task.list || task.category || task.project || (Array.isArray(task.tags) ? task.tags.join(' ') : task.tags))))
    .map((task) => ({ text: itemTitle(task, '목표'), done: isDone(task) }));
  const overdue = tasks.filter((task) => text(task.date) && text(task.date) < todayKey() && !isDone(task)).length;
  const delegated = tasks.filter((task) => taskOwner(task) === 'Agent' || taskOwner(task) === 'Hybrid').length;
  const kpis = [
    ['완료율', `${Math.round((done / Math.max(tasks.length, 1)) * 100)}%`, `${done}/${tasks.length} 완료`, '#2B2620'],
    ['완료', done, '이번 주', '#3E9B72'],
    ['지연', overdue, '정리 필요', '#C0533B'],
    ['위임', delegated, '에이전트', '#3E7A52'],
  ];
  const addGoal = async () => {
    const value = goalInput.trim();
    if (!value || savingGoal) return;
    setSavingGoal(true);
    try {
      await createReviewGoal(value);
      setGoalInput('');
    } finally {
      setSavingGoal(false);
    }
  };
  const generateRetro = async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const draft = await generateRetroDraft({
        range,
        done,
        total: tasks.length,
        overdue,
        delegated,
        goals: goals.map((goal) => `${goal.done ? '[완료]' : '[진행]'} ${goal.text}`),
      });
      setRetro(draft || '백엔드 회고 생성 결과가 비어 있습니다.');
    } catch (error) {
      setRetro(error instanceof Error ? `회고 생성 실패: ${error.message}` : '회고 생성 실패');
    } finally {
      setDrafting(false);
    }
  };
  return <div className="review-screen screen-in">
    <p className="review-range">{range} · 이번 주 목표와 KPI를 점검하고 회고를 남기세요.</p>
    <div className="review-kpis">{kpis.map(([label, value, sub, color]) => <div key={String(label)}><span>{label}</span><strong style={{ color: String(color) }}>{value}</strong><small>{sub}</small></div>)}</div>
    <section className="review-goals">
      <h2>🎯 이번 주 목표</h2>
      <div>
        {goals.map((goal, index) => <button className="review-goal" data-done={goal.done} key={`${goal.text}-${index}`}>
          <i>{goal.done ? '✓' : ''}</i><span>{goal.text}</span>
        </button>)}
        <label className="review-add"><span>+</span><input value={goalInput} disabled={savingGoal} onChange={(event) => setGoalInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addGoal(); }} placeholder={savingGoal ? '저장 중' : '목표 추가'} /></label>
      </div>
    </section>
    <section className="review-retro">
      <header><h2>📝 주간 회고</h2><span /><button className="primary" onClick={generateRetro} disabled={drafting}>{drafting ? '생성 중' : '자동 생성'}</button>{retro && <button onClick={() => saveRetro(retro)}>위키에 저장</button>}</header>
      {retro && <article>{retro}</article>}
    </section>
  </div>;
}

function wikiDetail(payload: ApiEnvelope) {
  const selected = obj(payload, 'selectedNote');
  if (Object.keys(selected).length) return selected;
  const index = obj(payload, 'wikiIndex');
  return obj(index, 'selectedNote');
}

function wikiBody(item: Item) {
  return text(item.content || item.body || item.markdown || item.summary || item.extract || item.excerpt, '');
}

function hasWikiFullBody(item: Item) {
  return Boolean(text(item.content || item.body || item.markdown || item.extract, ''));
}

function WikiArticle({ content }: { content: string }) {
  return <article>{content.split('\n').map((line, index) => {
    if (!line.trim()) return <br key={index} />;
    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)?.[0].length || 1;
      const body = line.replace(/^#{1,3}\s+/, '');
      return level === 1 ? <h1 key={index}>{body}</h1> : <h2 key={index}>{body}</h2>;
    }
    if (/^[-*]\s+/.test(line)) return <p className="wiki-bullet" key={index}>{line.replace(/^[-*]\s+/, '')}</p>;
    if (/^\d+\.\s+/.test(line)) return <p className="wiki-number" key={index}>{line}</p>;
    if (/^---$/.test(line.trim())) return <hr key={index} />;
    return <p key={index}>{line}</p>;
  })}</article>;
}

function WikiScreen({ wiki, docs, activeWikiId, setActiveWikiId, readerOpen, setReaderOpen, question, setQuestion, answer, sources, asking, ask }: { wiki: ApiEnvelope; docs: Item[]; activeWikiId: string; setActiveWikiId: (id: string) => void; readerOpen: boolean; setReaderOpen: (value: boolean) => void; question: string; setQuestion: (value: string) => void; answer: string; sources: Item[]; asking: boolean; ask: () => void }) {
  const [details, setDetails] = useState<Record<string, Item>>({});
  const [loadingPath, setLoadingPath] = useState('');
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const [graphPanning, setGraphPanning] = useState(false);
  const [openTreeGroups, setOpenTreeGroups] = useState<Set<string>>(() => new Set());
  const graphDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const graph = obj(wiki, 'graph');
  const graphNodesRaw = arr(graph, 'nodes');
  const graphEdges = arr(graph, 'edges');
  const wikiNotes = arr(wiki, 'notes').length ? arr(wiki, 'notes') : (arr(wiki, 'documents').length ? arr(wiki, 'documents') : docs);
  const list = wikiNotes;
  const selectedFromApi = wikiDetail(wiki);
  const activeBase = list.find((node, index) => itemId(node, `wiki-${index}`) === activeWikiId || text(node.path) === activeWikiId) || (Object.keys(selectedFromApi).length ? selectedFromApi : list[0]);
  const activePath = text(activeBase?.path || activeBase?.id || activeWikiId);
  const active = activePath && details[activePath] ? { ...activeBase, ...details[activePath] } : activeBase;

  useEffect(() => {
    if (!readerOpen || !activePath || hasWikiFullBody(active)) return;
    let cancelled = false;
    setLoadingPath(activePath);
    hermesApi.getWiki({ path: activePath })
      .then((payload) => {
        if (cancelled) return;
        const detail = wikiDetail(payload);
        if (Object.keys(detail).length) setDetails((current) => ({ ...current, [activePath]: detail }));
      })
      .catch((error) => setDetails((current) => ({ ...current, [activePath]: { ...active, content: `본문을 불러오지 못했습니다: ${error instanceof Error ? error.message : 'unknown error'}` } })))
      .finally(() => { if (!cancelled) setLoadingPath(''); });
    return () => { cancelled = true; };
  }, [activePath, readerOpen]);

  const colors: Record<string, string> = { 업무: 'var(--accent)', 주식: '#7C5CBF', 인생: '#C99A3B', 회고: '#3E9B72', 일기: '#3B7DD8', 기타: '#9A9080', '0_inbox': '#D7613D', '1_raw': '#C7963C', '2_wiki': '#3B7DD8', '3_output': '#3E9B72', '4_journal': '#7C6DD8', '5_conversation': '#A75F48', '6_agents': '#5D8A7D', '7_automation': '#8E7A58' };
  const folders = Array.from(new Set(list.map((node) => text(node.folder || node.tag || node.category || node.kind, '기타')))).slice(0, 12);
  const docGroups = folders.map((tag) => ({ tag, docs: list.filter((node) => text(node.folder || node.tag || node.category || node.kind, '기타') === tag) }));
  const graphGroups = Array.isArray(graph.groups) ? graph.groups.map(String).slice(0, 8) : Array.from(new Set(graphNodesRaw.map((node) => text(node.group, '기타')))).slice(0, 8);
  const graphNodes = (graphNodesRaw.length ? graphNodesRaw : list).map((node, index) => {
    const id = itemId(node, `wiki-${index}`);
    return {
      node,
      id,
      x: Number(node.x ?? 80 + (index % 18) * 46),
      y: Number(node.y ?? 80 + Math.floor(index / 18) * 34),
      r: Number(node.r ?? Math.min(10, 3.5 + Number(node.linkCount || 0) * 0.7)),
      label: text(node.label || node.title || node.path, '노트'),
      group: text(node.group || node.folder || node.kind, '기타'),
      linkCount: Number(node.linkCount || 0),
    };
  });
  const graphById = new Map(graphNodes.map((entry) => [entry.id, entry]));
  const activeGraphId = activePath || itemId(active || {}, '');
  const connected = new Set<string>();
  graphEdges.forEach((edge) => {
    if (text(edge.from) === activeGraphId) connected.add(text(edge.to));
    if (text(edge.to) === activeGraphId) connected.add(text(edge.from));
  });
  const graphViewBox = text(graph.viewBox, '0 0 960 620');
  const viewBoxParts = graphViewBox.split(/\s+/).map(Number);
  const graphBox = {
    x: Number.isFinite(viewBoxParts[0]) ? viewBoxParts[0] : 0,
    y: Number.isFinite(viewBoxParts[1]) ? viewBoxParts[1] : 0,
    width: Number.isFinite(viewBoxParts[2]) ? viewBoxParts[2] : 960,
    height: Number.isFinite(viewBoxParts[3]) ? viewBoxParts[3] : 620,
  };
  const clampGraphZoom = (value: number) => Math.min(3, Math.max(.45, value));
  const setClampedGraphZoom = (value: number) => setGraphZoom(clampGraphZoom(value));
  const resetGraphView = () => {
    setGraphZoom(1);
    setGraphPan({ x: 0, y: 0 });
  };
  const toggleTreeGroup = (tag: string) => {
    setOpenTreeGroups((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };
  const graphPoint = (event: { currentTarget: HTMLElement | SVGSVGElement; clientX: number; clientY: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: graphBox.x + ((event.clientX - rect.left) / rect.width) * graphBox.width,
      y: graphBox.y + ((event.clientY - rect.top) / rect.height) * graphBox.height,
    };
  };
  const zoomAt = (nextZoom: number, anchor: { x: number; y: number }) => {
    setGraphZoom((currentZoom) => {
      const clamped = clampGraphZoom(nextZoom);
      const ratio = clamped / currentZoom;
      setGraphPan((currentPan) => ({
        x: anchor.x - (anchor.x - currentPan.x) * ratio,
        y: anchor.y - (anchor.y - currentPan.y) * ratio,
      }));
      return clamped;
    });
  };
  const suggest = ['UniPort BM 요약', '트레이딩 규칙은?', '이번 주에 뭘 배웠지?'];
  return <div className="wiki screen-in">
    <div className="askbar"><div><span>H</span><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(); }} placeholder="위키에게 물어보세요 — AI가 쌓인 지식으로 답합니다" /></div><button disabled={asking} onClick={ask}>{asking ? '답변 중' : '질문'}</button></div>
    <div className="wiki-suggest">{suggest.map((item) => <button key={item} onClick={() => setQuestion(item)}>{item}</button>)}</div>
    {answer && <div className="wiki-answer"><span>H</span><p>{answer}{sources.length > 0 && <small>{sources.slice(0, 3).map((source) => text(source.title || source.path, '참조 문서')).join(' · ')}</small>}</p><button onClick={() => setQuestion('')}>✕</button></div>}
    <div className="wiki-main">
      <section className="wiki-graph-panel">
        <header><strong>🕸 지식 그래프</strong><small>{graphNodes.length}개 노트 · {graphEdges.length}개 링크</small><i />{graphGroups.slice(0, 5).map((tag) => <span className="wiki-legend" key={tag}><b style={{ background: colors[tag] || colors.기타 }} />{tag}</span>)}</header>
        <div className="wiki-graph-canvas" data-panning={graphPanning} onWheel={(event) => { event.preventDefault(); zoomAt(graphZoom * (event.deltaY > 0 ? .9 : 1.1), graphPoint(event)); }}>
          <div className="wiki-graph-controls" aria-label="그래프 확대 축소">
            <button aria-label="그래프 확대" onClick={() => setClampedGraphZoom(graphZoom * 1.18)}>+</button>
            <button aria-label="그래프 축소" onClick={() => setClampedGraphZoom(graphZoom / 1.18)}>−</button>
            <button aria-label="그래프 위치 초기화" onClick={resetGraphView}>⌂</button>
            <span>{Math.round(graphZoom * 100)}%</span>
          </div>
          <svg viewBox={graphViewBox} preserveAspectRatio="xMidYMid meet" onPointerDown={(event) => {
            const target = event.target as Element;
            if (target.closest('.wiki-svg-node')) return;
            graphDragRef.current = { x: event.clientX, y: event.clientY, panX: graphPan.x, panY: graphPan.y };
            setGraphPanning(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={(event) => {
            if (!graphDragRef.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setGraphPan({
              x: graphDragRef.current.panX + ((event.clientX - graphDragRef.current.x) * graphBox.width / rect.width),
              y: graphDragRef.current.panY + ((event.clientY - graphDragRef.current.y) * graphBox.height / rect.height),
            });
          }} onPointerUp={(event) => {
            graphDragRef.current = null;
            setGraphPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => {
            graphDragRef.current = null;
            setGraphPanning(false);
          }}>
            <rect className="wiki-graph-bg" x="0" y="0" width="100%" height="100%" />
            <g transform={`translate(${graphPan.x} ${graphPan.y}) scale(${graphZoom})`}>
              {graphEdges.map((edge, index) => {
                const from = graphById.get(text(edge.from));
                const to = graphById.get(text(edge.to));
                if (!from || !to) return null;
                const hot = from.id === activeGraphId || to.id === activeGraphId;
                return <line className="wiki-edge" data-hot={hot} key={text(edge.id, `edge-${index}`)} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
              })}
              {graphNodes.map((entry) => {
                const activeNode = entry.id === activeGraphId;
                const visibleLabel = activeNode || connected.has(entry.id) || entry.linkCount > 3;
                return <g className="wiki-svg-node" data-active={activeNode} data-connected={connected.has(entry.id)} key={entry.id} onClick={() => { setActiveWikiId(entry.id); setReaderOpen(true); }}>
                  <circle cx={entry.x} cy={entry.y} r={entry.r} fill={colors[entry.group] || colors.기타} />
                  <title>{entry.label}</title>
                  {visibleLabel && <text x={entry.x + entry.r + 5} y={entry.y + 4}>{entry.label.slice(0, 28)}</text>}
                </g>;
              })}
            </g>
          </svg>
          {readerOpen && active && <div className="wiki-reader"><header><div><strong>{itemTitle(active, 'Wiki 문서')}</strong><small>{text(active.folder || active.kind, '📄 문서')} · {text(active.updatedAt || active.date || active.tag || active.path, '위키 문서')}</small></div><button onClick={() => setReaderOpen(false)}>✕</button></header>{loadingPath === activePath && <div className="wiki-loading">본문 불러오는 중...</div>}<WikiArticle content={wikiBody(active) || '선택한 위키 문서의 본문입니다. 관련 작업과 런 결과가 이곳에 누적됩니다.'} /></div>}
        </div>
      </section>
      <aside className="wiki-side">
        <label><span>⌕</span><input placeholder="위키 내용 검색" /></label>
        <div className="tree"><h3>트리 구조</h3>{docGroups.map((group) => {
          const isOpen = openTreeGroups.has(group.tag);
          return <section key={group.tag} data-open={isOpen}>
            <button className="tree-group-toggle" aria-expanded={isOpen} onClick={() => toggleTreeGroup(group.tag)}>
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <b style={{ background: colors[group.tag] || colors.기타 }} />
              <strong>{group.tag}</strong>
              <small>{group.docs.length}</small>
            </button>
            {isOpen && group.docs.map((node, index) => {
              const originalIndex = list.findIndex((entry) => entry === node || itemId(entry, '') === itemId(node, ''));
              const id = itemId(node, `wiki-${originalIndex >= 0 ? originalIndex : index}`);
              const path = text(node.path || id, id);
              return <button data-active={path === activePath || id === activePath} key={id} onClick={() => { setActiveWikiId(path); setReaderOpen(true); }}><span>{text(node.kind) === 'diary' ? '📔' : '📄'} {itemTitle(node, 'Wiki 문서')}</span><small>{text(node.updatedAt || node.updated || node.date || node.path, '최근')}</small></button>;
            })}
          </section>;
        })}</div>
      </aside>
    </div>
  </div>;
}

function DiaryScreen({ docs, diaryText, setDiaryText, diaryMood, setDiaryMood, saveDiary }: { docs: Item[]; diaryText: string; setDiaryText: (value: string) => void; diaryMood: string; setDiaryMood: (value: string) => void; saveDiary: () => void }) {
  const diaryDocs = docs.filter((doc) => text(doc.kind).toLowerCase() === 'diary' || itemTitle(doc).includes('일기'));
  const past = diaryDocs;
  const prompts = ['오늘 가장 기억에 남는 일은?', '무엇을 배웠나?', '내일은 무엇을 다르게?', '감사한 것 3가지'];
  const stats = [
    ['🔥', '연속 기록', `${Math.max(1, diaryDocs.length)}일`],
    ['📔', '일기', `${past.length}개`],
    ['🙂', '기분', diaryMood || '미선택'],
  ];
  return <div className="diary-screen screen-in">
    <main>
      <div className="diary-inner">
        <div className="diary-stats">{stats.map(([icon, label, value]) => <div key={String(label)}><span>{icon} {label}</span><strong>{value}</strong></div>)}</div>
        <section className="diary-card">
          <header><h2>오늘의 일기</h2><span>{dateLabel()}</span></header>
          <p>저장하면 위키에 일기로 쌓여 질문 검색에 활용됩니다.</p>
          <label>오늘의 기분</label>
          <div className="diary-moods">{['😊', '😌', '😐', '😔', '😤', '🤔'].map((mood) => <button data-active={diaryMood === mood} key={mood} onClick={() => setDiaryMood(diaryMood === mood ? '' : mood)}>{mood}</button>)}</div>
          <textarea value={diaryText} onChange={(event) => setDiaryText(event.target.value)} placeholder="오늘 하루는 어땠나요? 무엇을 배웠고, 내일은 무엇을 다르게 할까요?" />
          <div className="diary-prompts">{prompts.map((prompt) => <button key={prompt} onClick={() => setDiaryText(`${diaryText}${diaryText ? '\n\n' : ''}· ${prompt}\n`)}>+ {prompt}</button>)}</div>
          <footer><span>매일 기록이 위키의 컨텍스트가 됩니다</span><button className="primary" onClick={saveDiary}>위키에 저장</button></footer>
        </section>
      </div>
    </main>
    <aside>
      <header><strong>지난 일기</strong><span>타임라인</span></header>
      <div className="diary-timeline">
        {past.map((entry, index) => {
          const body = text(entry.body || entry.summary || entry.excerpt, '기록된 일기');
          const mood = body.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u)?.[0] || '📔';
          const day = text(entry.date, addDaysKey(todayKey(), -index - 1)).slice(-2);
          return <button key={itemId(entry, `past-${index}`)} onClick={() => setDiaryText(body.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, ''))}>
            <i>{mood}</i><span><b>{Number(day) || index + 1}</b><small>{formatDateChip(text(entry.date, todayKey()))}</small><em>{body.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, '').slice(0, 72)}</em></span>
          </button>;
        })}
      </div>
    </aside>
  </div>;
}

function SearchScreen({ query, tasks, docs, openTask }: { query: string; tasks: Item[]; docs: Item[]; openTask: (task: Item) => void }) {
  const q = query.trim().toLowerCase();
  const match = (item: Item) => !q || [
    itemTitle(item),
    itemSub(item),
    text(item.body || item.summary || item.preview),
    text(item.category || item.project || item.source || item.list || item.tag),
    Array.isArray(item.tags) ? item.tags.join(' ') : text(item.tags),
  ].join(' ').toLowerCase().includes(q);
  const taskRows = tasks.filter(match).slice(0, 6);
  const docRows = docs.filter(match).slice(0, 6);
  const groups = [
    { title: '작업', icon: '☑', rows: taskRows, meta: (item: Item) => text(item.date) ? formatDateChip(text(item.date)) : text(item.category || item.project || item.source, '기본함'), onOpen: openTask },
    { title: '노트 · 위키', icon: '📄', rows: docRows, meta: (item: Item) => text(item.date || item.updated || item.tag, '문서'), onOpen: undefined },
  ].filter((group) => group.rows.length);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return <div className="search-screen screen-in">
    <p><b>"{query || '전체'}"</b> 검색 결과 {total}건</p>
    {groups.map((group) => <section className="search-group" key={group.title}>
      <h2>{group.title} · {group.rows.length}</h2>
      <div>{group.rows.map((row, index) => <button key={itemId(row, `${group.title}-${index}`)} onClick={() => group.onOpen?.(row)}>
        <span>{group.icon}</span><strong>{itemTitle(row, '결과')}</strong><em>{group.meta(row)}</em>
      </button>)}</div>
    </section>)}
    {!total && <div className="search-empty">결과가 없습니다</div>}
  </div>;
}

function AgentsScreen({ agents, runs, missionText, setMissionText, selectedAgentId, setSelectedAgentId, startPlan, openModal, openRun }: { agents: Item[]; runs: Item[]; missionText: string; setMissionText: (value: string) => void; selectedAgentId: string; setSelectedAgentId: (id: string) => void; startPlan: () => void; openModal: (modal: ModalId) => void; openRun: (run?: Item) => void }) {
  const examples = ['UniPort 경쟁사 3곳 리서치해서 위키에 정리', '이번 주 트레이딩 회고 문서 작성', '캐러셀 파이프라인 버그 정리 노트'];
  const agentEmoji = (agent: Item, fallback = '🤖') => text(agent.emoji || agent.icon, fallback);
  const statusLabel = (agent: Item) => /busy|running|작업/i.test(text(agent.status)) ? '작업중' : '대기';
  return <div className="agents screen-in">
    <section className="mission">
      <header><div>H</div><strong>새 미션 위임</strong><span>목표를 적으면 에이전트가 계획을 세웁니다</span></header>
      <textarea value={missionText} onChange={(event) => setMissionText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) startPlan(); }} placeholder="예: UniPort 경쟁사 3곳을 리서치해서 비교표로 위키에 정리해줘" />
      <footer>
        <b>담당</b>
        {agents.slice(0, 4).map((agent, index) => {
          const id = itemId(agent, `agent-${index}`);
          return <button className="agent-chip" data-active={selectedAgentId === id} key={id} onClick={() => setSelectedAgentId(id)}>{agentEmoji(agent)} {text(agent.name || agent.id, 'agent')}</button>;
        })}
        <span />
        <button className="primary" onClick={startPlan}>계획 세우기 →</button>
      </footer>
      <div className="mission-examples">{examples.map((example) => <button key={example} onClick={() => setMissionText(example)}>{example}</button>)}</div>
    </section>
    <div className="agents-heading"><strong>에이전트</strong><button onClick={() => openModal('agent')}>+ 새 에이전트</button></div>
    <div className="agent-grid">{agents.map((agent, index) => {
    const id = itemId(agent, `agent-${index}`);
    const activeCount = runs.filter((run) => text(run.agent) === text(agent.name || agent.id) && !/done|완료/i.test(text(run.status))).length;
    const doneCount = runs.filter((run) => text(run.agent) === text(agent.name || agent.id) && /done|완료/i.test(text(run.status))).length;
    return <article className="agent-card" data-active={selectedAgentId === id} key={id} onClick={() => setSelectedAgentId(id)}>
      <header><div className="agent-avatar">{agentEmoji(agent)}</div><span><h3>{text(agent.name || agent.id, 'agent')}</h3><small>{text(agent.model, 'Hermes')}</small></span><em>{statusLabel(agent)}</em></header>
      <p>{text(agent.role || agent.persona, '리서치·문서 — 자료 정리, 위키 작성, 분석을 담당.')}</p>
      <footer><span><small>진행 중</small><b>{activeCount}</b></span><span><small>완료</small><b>{doneCount}</b></span><i /><button onClick={(event) => { event.stopPropagation(); setSelectedAgentId(id); }}>선택</button></footer>
    </article>;
  })}</div>
    <section className="agent-runs"><h2>실행 / 검토</h2>{runs.slice(0, 6).map((run, index) => {
      const pct = /done|완료/i.test(text(run.status)) ? 100 : Number(run.pct || run.progress || 62);
      return <button className="run-row" key={itemId(run, `run-${index}`)} onClick={() => openRun(run)}>
        <header><span>{/done|완료/i.test(text(run.status)) ? '완료' : '진행'}</span><b>{text(run.title || run.goal, 'Hermes 실행')}</b><small>{text(run.agent, 'default')}</small></header>
        <div><i style={{ width: `${pct}%` }} /></div>
        <footer><span>{text(run.step, '컨텍스트 수집 중')}</span>{text(run.artifact || run.document) && <em>📄 {text(run.artifact || run.document)}</em>}</footer>
      </button>;
    })}{!runs.length && <div className="plan-empty">아직 실행한 미션이 없습니다 · 위에서 목표를 위임해보세요</div>}</section>
  </div>;
}

function SettingsScreen({ settings, setSettings, refresh }: { settings: DesktopSettingsState; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void> }) {
  const [apiBaseUrl, setApiBaseUrlInput] = useState(settings.apiBaseUrl);
  const [apiToken, setApiToken] = useState('');
  const [theme, setTheme] = useState<DesktopTheme>(settings.theme);
  async function save() {
    const next = await window.hermesDesktop?.saveSettings({ apiBaseUrl, apiToken, theme });
    if (next) setSettings(desktopSettingsState(next));
    await refresh();
  }
  return <div className="settings screen-in"><Panel title="Railway API"><label>API Base URL<input value={apiBaseUrl} onChange={(event) => setApiBaseUrlInput(event.target.value)} /></label><label>Bearer Token<input type="password" value={apiToken} onChange={(event) => setApiToken(event.target.value)} placeholder={settings.hasApiToken ? '저장됨 · 새 값 입력 시 교체' : '선택 사항'} /></label><button onClick={() => void save()}>저장하고 재연결</button></Panel><Panel title="테마"><div className="theme-row">{(['default', 'warm', 'dark', 'sage', 'mono'] as DesktopTheme[]).map((item) => <button data-active={theme === item} key={item} onClick={() => setTheme(item)}>{item}</button>)}</div></Panel></div>;
}

function LoginScreen() {
  return <div className="login screen-in"><div><div className="brand-mark large">H</div><h1>Hermes Tasks</h1><p>할 일·캘린더·에이전트가 한 화면에서 움직이는 개인 운영 콘솔.</p></div><form><input placeholder="이메일" /><input placeholder="비밀번호" type="password" /><button type="button">로그인</button><button type="button">Google로 계속</button><button type="button">Apple로 계속</button></form></div>;
}

function LoginOverlay({ email, setEmail, password, setPassword, submit }: { email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; submit: () => void }) {
  return <div className="login-overlay">
    <section className="login-card">
      <div className="login-brand">
        <div><span>H</span><strong>Hermes Tasks</strong></div>
        <h1>할 일·캘린더와<br />에이전트를<br />한 곳에서</h1>
        <p>작업을 위임하고, 일정을 공유하고,<br />위키에 지식을 쌓으세요.</p>
        <small>© 2026 Hermes OS</small>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <h2>로그인</h2>
        <p>계정에 로그인하고 이어서 작업하세요</p>
        <label>이메일</label>
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="yunseo@hermes.os" />
        <label>비밀번호</label>
        <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="••••••••" />
        <div><span>로그인 상태 유지</span><button type="button">비밀번호 찾기</button></div>
        <button className="primary" type="submit">로그인</button>
        <hr />
        <div className="social-row"><button type="button" onClick={submit}>Google</button><button type="button" onClick={submit}>Apple</button></div>
        <small>계정이 없으신가요? <button type="button" onClick={submit}>회원가입</button></small>
      </form>
    </section>
  </div>;
}

function ChatDrawer({ messages, input, setInput, send, runs, setChip, close, openRun }: { messages: Array<{ role: string; text: string }>; input: string; setInput: (value: string) => void; send: () => Promise<void>; runs: Item[]; setChip: (value: string) => void; close: () => void; openRun: (run?: Item) => void }) {
  return <aside className="chat">
    <header><div className="chat-mark">H</div><div><strong>Hermes 콘솔</strong><span>Railway stream</span></div><button onClick={close} aria-label="Hermes 콘솔 닫기">✕</button></header>
    <div className="chat-runs">{runs.slice(0, 2).map((run, index) => <button className="chat-run-card" key={itemId(run, `chat-run-${index}`)} onClick={() => openRun(run)}><b>{text(run.goal || run.title, 'Run')}</b><span>{text(run.status, 'running')} · {text(run.agent, 'default')}</span></button>)}</div>
    <div className="messages">{messages.map((message, index) => <div className={`message ${message.role}`} key={index}>{message.text || '응답 수신 중...'}</div>)}</div>
    <div className="chat-chips">{['오늘 할 일 정리해줘', 'UniPort 백로그 분배', '이번 주 회의 잡아줘'].map((chip) => <button key={chip} onClick={() => setChip(chip)}>{chip}</button>)}</div>
    <footer><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Hermes에게 작업 위임" /><button onClick={() => void send()}>전송</button></footer>
  </aside>;
}

function TaskDetailModal({ selectedTask, lists, patchTask, patchCalendarEvent, removeTask, removeCalendarEvent, toggleTask, close, delegate }: { selectedTask: Item; lists: TaxonomyItem[]; patchTask: (task: Item, patch: Item) => void; patchCalendarEvent: (task: Item, patch: Item) => void; removeTask: (task: Item) => void; removeCalendarEvent: (task: Item) => void; toggleTask: (task: Item) => void; close: () => void; delegate: () => void }) {
  const isEvent = isCalendarEventRecord(selectedTask);
  const patchItem = isEvent ? patchCalendarEvent : patchTask;
  const removeItem = isEvent ? removeCalendarEvent : removeTask;
  const calendar = calendarMetadata(selectedTask);
  const startDate = text(selectedTask.date || selectedTask.startDate || selectedTask.day, todayKey());
  const startTime = text(selectedTask.time || selectedTask.t);
  const endDate = calendar.endDate || startDate;
  const endTime = calendar.endTime;
  const hasDuration = Boolean(endTime || (calendar.endDate && calendar.endDate !== startDate));
  const [dateOpen, setDateOpen] = useState(false);
  const [dateMode, setDateMode] = useState<'date' | 'duration'>(() => (hasDuration ? 'duration' : 'date'));
  const repeat = calendar.repeat || text(selectedTask.repeat, 'none');
  const allDay = calendar.allDay;
  const listOptions = lists.length ? lists : [{ id: 'inbox', label: '기본함', icon: '📥', group: '리스트', kind: 'list' as TaxonomyKind }];
  const currentList = slugify(taskListName(selectedTask) || '기본함');
  const activeList = listOptions.find((option) => currentList === slugify(option.label) || currentList === slugify(option.id)) || listOptions[0];
  const pickerBase = new Date(`${startDate || todayKey()}T00:00:00`);
  const [pickerMonth, setPickerMonth] = useState(() => new Date(pickerBase.getFullYear(), pickerBase.getMonth(), 1));
  const pickerStart = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth(), 1);
  pickerStart.setDate(1 - pickerStart.getDay());
  const pickerCells = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(pickerStart);
    day.setDate(pickerStart.getDate() + index);
    const iso = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
    return { iso, day: day.getDate(), inMonth: day.getMonth() === pickerMonth.getMonth(), selected: iso === startDate };
  });
  const dateTitle = (() => {
    const date = new Date(`${startDate}T00:00:00`);
    const dayText = Number.isNaN(date.getTime()) ? startDate : `${date.getMonth() + 1}월 ${date.getDate()}일`;
    const prefix = startDate === todayKey() ? '오늘, ' : '';
    const timeText = allDay ? '' : startTime ? `, ${formatTime(startTime)}${endTime ? ` - ${formatTime(endTime)}` : ''}` : '';
    return `${prefix}${dayText}${timeText}`;
  })();
  const patchDate = (value: string) => patchItem(selectedTask, { date: value, startDate: value });
  const patchTime = (value: string) => patchItem(selectedTask, { time: value });
  const patchEnd = (patch: Item) => (isEvent ? patchCalendarEvent(selectedTask, patch) : patchTask(selectedTask, patch));
  const shiftPickerMonth = (amount: number) => setPickerMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  const openDateEditor = () => {
    setDateMode(hasDuration ? 'duration' : 'date');
    setDateOpen((open) => !open);
  };

  return <div className="modal-backdrop detail-backdrop" onMouseDown={close}>
    <div className="detail-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header className="detail-topline">
        {!isEvent && <button className="detail-check" data-done={isDone(selectedTask)} onClick={() => toggleTask(selectedTask)} aria-label="완료 토글">{isDone(selectedTask) ? '✓' : ''}</button>}
        <span className="detail-divider" />
        <button className="detail-date-trigger" onClick={openDateEditor}><span>▦</span>{dateTitle}</button>
        <button className="detail-flag" aria-label="우선순위" onClick={() => patchItem(selectedTask, { priority: text(selectedTask.priority) ? '' : 'P1' })}>⚐</button>
        <button className="detail-close" onClick={close}>✕</button>
      </header>
      <main className="detail-compose">
        <input className="detail-title-input" defaultValue={itemTitle(selectedTask, '')} onBlur={(event) => patchItem(selectedTask, { title: event.target.value })} placeholder="무엇을 하고 싶으신가요?" autoFocus />
        <textarea className="detail-notes-input" defaultValue={plainCalendarNotes(selectedTask)} onBlur={(event) => patchItem(selectedTask, { notes: event.target.value })} placeholder="설명 또는 메모 추가" />
      </main>
      <footer className="detail-bottomline">
        <button className="detail-list-pill" onClick={() => patchItem(selectedTask, { list: activeList.id, category: activeList.label, project: activeList.label })}><span>▣</span>{activeList.label}</button>
        <span />
        <button className="detail-tool" title="서식">A</button>
        <button className="detail-tool" title="댓글">▣</button>
        <button className="detail-tool" title="더보기">•••</button>
        {!isEvent && <button className="detail-tool detail-agent" title="에이전트에 위임" onClick={delegate}>⚡</button>}
        <button className="detail-delete" onClick={() => { removeItem(selectedTask); close(); }}>삭제</button>
      </footer>
      {dateOpen && <div className="detail-date-popover">
        <div className="detail-date-segment"><button data-active={dateMode === 'date'} onClick={() => setDateMode('date')}>날짜</button><button data-active={dateMode === 'duration'} onClick={() => setDateMode('duration')}>지속 시간</button></div>
        {dateMode === 'date' ? <>
          <div className="detail-date-presets"><button>☼</button><button>⌂</button><button>▣<small>+7</small></button><button>☾</button></div>
          <div className="detail-month-head"><strong>{pickerMonth.getFullYear()}년 {pickerMonth.getMonth() + 1}월</strong><span /><button onClick={() => shiftPickerMonth(-1)}>‹</button><button onClick={() => setPickerMonth(new Date(`${todayKey()}T00:00:00`))}>○</button><button onClick={() => shiftPickerMonth(1)}>›</button></div>
          <div className="detail-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="detail-date-grid">{pickerCells.map((cell) => <button data-muted={!cell.inMonth} data-active={cell.selected} key={cell.iso} onClick={() => patchDate(cell.iso)}>{cell.day}</button>)}</div>
          <button className="detail-date-row" onClick={() => setDateMode('duration')}><span>◷</span>{startTime ? formatTime(startTime) : '시간 추가'}<b>›</b></button>
          <button className="detail-date-row"><span>⏰</span>정각에<b>›</b></button>
          <button className="detail-date-row" onClick={() => patchEnd({ repeat: repeat === 'none' ? 'weekly' : 'none' })}><span>↻</span>{repeatLabel(repeat)}<b>›</b></button>
        </> : <>
          <div className="duration-grid">
            <label>시작</label><input defaultValue={startDate} onBlur={(event) => patchDate(event.target.value)} /><input defaultValue={startTime} onBlur={(event) => patchTime(event.target.value)} placeholder="오후 5:00" />
            <label>끝</label><input defaultValue={endDate} onBlur={(event) => patchEnd({ endDate: event.target.value })} /><input defaultValue={endTime} onBlur={(event) => patchEnd({ endTime: event.target.value })} placeholder="오후 6:00" />
            <label>전체</label><button className="duration-toggle" data-active={allDay} onClick={() => patchEnd({ allDay: !allDay, time: allDay ? startTime : '' })}><span /></button>
          </div>
          <button className="detail-date-row"><span>⏰</span>정각에<b>›</b></button>
          <button className="detail-date-row" onClick={() => patchEnd({ repeat: repeat === 'none' ? 'weekly' : 'none' })}><span>↻</span>{repeatLabel(repeat)}<b>›</b></button>
        </>}
        <footer><button onClick={() => { patchDate(''); patchTime(''); patchEnd({ endDate: '', endTime: '', repeat: 'none', allDay: false }); }}>삭제</button><button className="primary" onClick={() => setDateOpen(false)}>확인</button></footer>
      </div>}
    </div>
  </div>;
}

function Modal({ modal, setModal, newTitle, setNewTitle, newDesc, setNewDesc, newTask, createTask, lists, tags, agents, runs, selectedRun, selectedTask, patchTask, patchCalendarEvent, removeTask, removeCalendarEvent, toggleTask, delegateText, setDelegateText, delegateAgentId, setDelegateAgentId, startPlan, openRunArtifact, newAgentName, setNewAgentName, newAgentRole, setNewAgentRole, newAgentEmoji, setNewAgentEmoji, createAgent, settings, setSettings, refresh, loggedIn, setLoggedIn, loginEmail, setLoginEmail, loginPw, setLoginPw, prefs, updatePrefs }: { modal: ModalId; setModal: (modal: ModalId) => void; newTitle: string; setNewTitle: (value: string) => void; newDesc: string; setNewDesc: (value: string) => void; newTask: NewTaskControls; createTask: (extraNotes?: string) => Promise<void>; lists: TaxonomyItem[]; tags: TaxonomyItem[]; agents: Item[]; runs: Item[]; selectedRun?: Item; selectedTask?: Item; patchTask: (task: Item, patch: Item) => void; patchCalendarEvent: (task: Item, patch: Item) => void; removeTask: (task: Item) => void; removeCalendarEvent: (task: Item) => void; toggleTask: (task: Item) => void; delegateText: string; setDelegateText: (value: string) => void; delegateAgentId: string; setDelegateAgentId: (value: string) => void; startPlan: () => void; openRunArtifact: (run?: Item) => void; newAgentName: string; setNewAgentName: (value: string) => void; newAgentRole: string; setNewAgentRole: (value: string) => void; newAgentEmoji: string; setNewAgentEmoji: (value: string) => void; createAgent: () => void; settings: DesktopSettingsState; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; loggedIn: boolean; setLoggedIn: (value: boolean) => void; loginEmail: string; setLoginEmail: (value: string) => void; loginPw: string; setLoginPw: (value: string) => void; prefs: UiPreferences; updatePrefs: (value: UiPreferences) => Promise<void> }) {
  if (!modal) return null;
  if (modal === 'new') {
    return <div className="modal-backdrop new-task-backdrop" onMouseDown={() => setModal(null)}><NewTaskModal title={newTitle} setTitle={setNewTitle} desc={newDesc} setDesc={setNewDesc} controls={newTask} lists={lists} close={() => setModal(null)} submit={createTask} /></div>;
  }
  if (modal === 'settings') {
    return <SettingsOverlay settings={settings} setSettings={setSettings} refresh={refresh} close={() => setModal(null)} loggedIn={loggedIn} setLoggedIn={setLoggedIn} loginEmail={loginEmail} setLoginEmail={setLoginEmail} loginPw={loginPw} setLoginPw={setLoginPw} prefs={prefs} updatePrefs={updatePrefs} />;
  }
  if (modal === 'task' && selectedTask) {
    return <TaskDetailModal selectedTask={selectedTask} lists={lists} patchTask={patchTask} patchCalendarEvent={patchCalendarEvent} removeTask={removeTask} removeCalendarEvent={removeCalendarEvent} toggleTask={toggleTask} close={() => setModal(null)} delegate={() => { setDelegateText(itemTitle(selectedTask, '')); setModal('delegate'); }} />;
  }
  if (modal === 'delegate') {
    const visibleAgents = agents.slice(0, 4);
    return <div className="modal-backdrop delegate-backdrop" onMouseDown={() => setModal(null)}>
      <div className="delegate-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="delegate-title">⚡ 에이전트에 위임</div>
        <p>자연어로 지시하면 런이 생성되고 실시간으로 실행됩니다.</p>
        <label>담당 에이전트</label>
        <div className="delegate-agents">{visibleAgents.map((agent, index) => {
          const id = itemId(agent, `agent-${index}`);
          return <button data-active={delegateAgentId === id || (!delegateAgentId && index === 0)} key={id} onClick={() => setDelegateAgentId(id)}>{text(agent.emoji, '⚡')} {text(agent.name || agent.id, 'Hermes')}</button>;
        })}{!visibleAgents.length && <span className="delegate-empty">백엔드 에이전트를 불러오는 중입니다.</span>}</div>
        <textarea value={delegateText} onChange={(event) => setDelegateText(event.target.value)} placeholder="예: UniPort 개발 백로그를 우선순위별로 정리하고 이번 주 할 일로 분배해줘" />
        <footer>
          <span>결과는 캘린더·태스크에 자동 공유됩니다</span>
          <button onClick={() => setModal(null)}>취소</button>
          <button className="primary" onClick={startPlan}>위임하고 실행</button>
        </footer>
      </div>
    </div>;
  }
  if (modal === 'agent') {
    const emojiOptions = ['🤖', '🔎', '📋', '🧠', '⚡', '✍️', '📊', '🛠️'];
    return <div className="modal-backdrop agent-backdrop" onMouseDown={() => setModal(null)}>
      <div className="agent-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="agent-modal-title">새 에이전트 만들기</div>
        <label>아이콘</label>
        <div className="agent-emoji-grid">{emojiOptions.map((emoji) => <button data-active={newAgentEmoji === emoji} key={emoji} onClick={() => setNewAgentEmoji(emoji)}>{emoji}</button>)}</div>
        <input value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} placeholder="에이전트 이름 (예: 리서처)" />
        <textarea value={newAgentRole} onChange={(event) => setNewAgentRole(event.target.value)} placeholder="역할·담당 영역 (예: 시장 조사와 경쟁사 분석을 담당)" />
        <footer>
          <span />
          <button onClick={() => setModal(null)}>취소</button>
          <button className="primary" onClick={createAgent}>만들기</button>
        </footer>
      </div>
    </div>;
  }
  if (modal === 'run') {
    return <div className="modal-backdrop run-backdrop" onMouseDown={() => setModal(null)}>
      <div className="run-modal" onMouseDown={(event) => event.stopPropagation()}>
        <RunReport run={selectedRun || runs[0]} close={() => setModal(null)} openArtifact={openRunArtifact} />
      </div>
    </div>;
  }
  return null;
}

function NewTaskModal({ title, setTitle, desc, setDesc, controls, lists, close, submit }: { title: string; setTitle: (value: string) => void; desc: string; setDesc: (value: string) => void; controls: NewTaskControls; lists: TaxonomyItem[]; close: () => void; submit: (extraNotes?: string) => Promise<void> }) {
  const [pickerMonth, setPickerMonth] = useState(() => new Date(`${controls.date || todayKey()}T00:00:00`));
  const [checkItems, setCheckItems] = useState<string[]>([]);
  const [listQuery, setListQuery] = useState('');
  const [durationTimeMenu, setDurationTimeMenu] = useState<'start' | 'end' | null>(null);
  const checkRefs = useRef<Array<HTMLInputElement | null>>([]);
  const durationMenuRef = useRef<HTMLDivElement | null>(null);
  const pickerLabel = `${pickerMonth.getFullYear()}년 ${pickerMonth.getMonth() + 1}월`;
  const pickerStart = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth(), 1);
  pickerStart.setDate(1 - pickerStart.getDay());
  const pickerCells = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(pickerStart);
    day.setDate(pickerStart.getDate() + index);
    const iso = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
    return { iso, day: day.getDate(), inMonth: day.getMonth() === pickerMonth.getMonth(), today: iso === todayKey(), selected: iso === controls.date };
  });
  const timeSlots = Array.from({ length: 36 }, (_, index) => {
    const hour = 6 + Math.floor(index / 2);
    const minute = index % 2 ? '30' : '00';
    return `${String(hour).padStart(2, '0')}:${minute}`;
  });
  const durationTimeSlots = Array.from({ length: 48 }, (_, index) => {
    const hour = Math.floor(index / 2);
    const minute = index % 2 ? '30' : '00';
    return `${String(hour).padStart(2, '0')}:${minute}`;
  });
  const listOptions = lists.length ? lists : [{ id: 'inbox', label: '기본함', icon: '📥', group: '리스트', kind: 'list' as TaxonomyKind }];
  const ownerOptions = [['me', '나'], ['agent', '에이전트'], ['hybrid', '공동']];
  const repeatOptions = [['none', '안 함'], ['daily', '매일'], ['weekday', '평일'], ['weekly', '매주'], ['monthly', '매월']];
  const setQuickDate = (date: string) => {
    controls.setDate(date);
    setPickerMonth(new Date(`${date}T00:00:00`));
  };
  const shiftMonth = (amount: number) => setPickerMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  const startDuration = () => {
    const start = controls.date || todayKey();
    const startTime = controls.time || '18:00';
    const [hour, minute] = startTime.split(':').map(Number);
    controls.setMode('duration');
    controls.setDate(start);
    controls.setTime(startTime);
    controls.setEndDate(controls.endDate || start);
    controls.setEndTime(controls.endTime || `${String((hour + 1) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  };
  const dateChip = controls.date ? `${formatDateChip(controls.date)}${controls.time && !controls.allDay ? ` ${formatTime(controls.time)}` : ''}` : '날짜 추가';

  const activeList = listOptions.find((option) => slugify(option.id) === slugify(controls.list) || slugify(option.label) === slugify(controls.list)) || listOptions[0];
  const filteredListOptions = listOptions.filter((option) => {
    const query = listQuery.trim().toLowerCase();
    if (!query) return true;
    return `${option.label} ${option.group} ${option.id}`.toLowerCase().includes(query);
  });
  const checklistNotes = () => checkItems.map((item) => item.trim()).filter(Boolean).map((item) => `- [ ] ${item}`).join('\n');
  const submitTask = () => submit(checklistNotes());
  const addCheckItem = () => {
    controls.setDatePanel(false);
    controls.setListPanel(false);
    setCheckItems((current) => [...current, '']);
  };
  const updateCheckItem = (index: number, value: string) => {
    setCheckItems((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)));
  };
  const removeEmptyCheckItem = (index: number) => {
    setCheckItems((current) => current.length > 1 ? current.filter((_, itemIndex) => itemIndex !== index) : current);
  };
  const pickDurationTime = (target: 'start' | 'end', value: string) => {
    if (target === 'start') controls.setTime(value);
    else controls.setEndTime(value);
    controls.setAllDay(false);
    setDurationTimeMenu(null);
  };
  const durationTimeField = (target: 'start' | 'end', value: string, placeholder: string) => (
    <div className="duration-time-field">
      <input
        className="duration-time-input"
        value={value ? formatTime(value) : ''}
        onClick={() => setDurationTimeMenu(target)}
        onFocus={() => setDurationTimeMenu(target)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDurationTimeMenu(null);
        }}
        placeholder={placeholder}
        readOnly
      />
      {durationTimeMenu === target && <div className="duration-time-menu" ref={durationMenuRef}>
        {durationTimeSlots.map((slot) => {
          const active = value === slot;
          return <button type="button" data-active={active} key={slot} onClick={() => pickDurationTime(target, slot)}><span>{formatTime(slot)}</span><b>{active ? '✓' : ''}</b></button>;
        })}
      </div>}
    </div>
  );

  useEffect(() => {
    if (checkItems.length) checkRefs.current[checkItems.length - 1]?.focus();
  }, [checkItems.length]);
  useEffect(() => {
    if (!durationTimeMenu) return;
    requestAnimationFrame(() => {
      durationMenuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' });
    });
  }, [controls.endTime, controls.time, durationTimeMenu]);

  return <div className="new-task-popover" onMouseDown={(event) => event.stopPropagation()}>
    <div className="new-task-scroll">
      <div className="new-task-date-row">
        <button className="new-date-chip" data-has-date={!!controls.date} onClick={() => { controls.setDatePanel(!controls.datePanel); controls.setListPanel(false); }}>🗓 {dateChip}</button>
      </div>
      <div className="new-task-title-row">
        <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submitTask(); }} placeholder="무엇을 하고 싶으신가요?" />
        <button className="new-checklist-toggle" aria-label="할 일 추가" title="할 일 추가" onClick={addCheckItem}>☰</button>
      </div>
      <textarea className="new-task-desc" value={desc} onChange={(event) => setDesc(event.target.value)} placeholder="설명" />
      {checkItems.length > 0 && <div className="new-task-checklist">
        {checkItems.map((item, index) => <label className="new-task-check-row" key={index}>
          <input type="checkbox" tabIndex={-1} />
          <input
            ref={(element) => { checkRefs.current[index] = element; }}
            value={item}
            onChange={(event) => updateCheckItem(index, event.target.value)}
            onBlur={() => { if (!item.trim()) removeEmptyCheckItem(index); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setCheckItems((current) => [...current, '']);
              }
              if (event.key === 'Backspace' && !item) removeEmptyCheckItem(index);
            }}
            placeholder={'"엔터"를 눌러 할일 생성'}
          />
        </label>)}
      </div>}
      <div className="new-task-fill" />

      {controls.datePanel && <div className="new-panel">
        <div className="new-segment"><button data-active={controls.mode === 'date'} onClick={() => controls.setMode('date')}>날짜</button><button data-active={controls.mode === 'duration'} onClick={startDuration}>지속 시간</button></div>
        {controls.mode === 'date' ? <>
          <div className="picker-head"><strong>{pickerLabel}</strong><span /><button onClick={() => shiftMonth(-1)}>‹</button><button onClick={() => setQuickDate(todayKey())}>오늘</button><button onClick={() => shiftMonth(1)}>›</button></div>
          <div className="picker-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="picker-grid">{pickerCells.map((cell) => <button data-muted={!cell.inMonth} data-today={cell.today} data-active={cell.selected} key={cell.iso} onClick={() => setQuickDate(cell.iso)}>{cell.day}</button>)}</div>
          <NewAccordionRow label="시간" value={controls.allDay ? '종일' : controls.time ? formatTime(controls.time) : '없음'} panel="time" controls={controls} />
          {controls.subPanel === 'time' && <div className="sub-panel">
            <div className="all-day-row"><span>종일</span><button className="switch" data-active={controls.allDay} onClick={() => { controls.setAllDay(!controls.allDay); if (!controls.allDay) controls.setTime(''); }}><span /></button>{controls.time && <button onClick={() => controls.setTime('')}>지우기</button>}</div>
            <div className="time-grid">{timeSlots.map((slot) => <button data-active={controls.time === slot} key={slot} onClick={() => { controls.setTime(slot); controls.setAllDay(false); controls.setSubPanel(null); }}>{formatTime(slot)}</button>)}</div>
          </div>}
        </> : <div className="duration-grid">
          <span>시작</span><input value={controls.date} onChange={(event) => controls.setDate(event.target.value)} placeholder="YYYY-MM-DD" />{durationTimeField('start', controls.time, '시간')}
          <span>끝</span><input value={controls.endDate} onChange={(event) => controls.setEndDate(event.target.value)} placeholder="YYYY-MM-DD" />{durationTimeField('end', controls.endTime, '시간')}
          <span>종일</span><button className="switch" data-active={controls.allDay} onClick={() => controls.setAllDay(!controls.allDay)}><span /></button>
        </div>}
        <NewAccordionRow label="반복" value={repeatLabel(controls.repeat)} panel="repeat" controls={controls} />
        {controls.subPanel === 'repeat' && <div className="option-row">{repeatOptions.map(([value, label]) => <button data-active={controls.repeat === value} key={value} onClick={() => controls.setRepeat(value)}>{label}</button>)}</div>}
        <NewAccordionRow label="담당" value={ownerOptions.find(([value]) => value === controls.owner)?.[1] || '나'} panel="owner" controls={controls} />
        {controls.subPanel === 'owner' && <div className="option-row">{ownerOptions.map(([value, label]) => <button data-active={controls.owner === value} key={value} onClick={() => controls.setOwner(value)}>{label}</button>)}</div>}
      </div>}

    </div>
    <footer className="new-task-footer">
      <button className="new-list-button" onClick={() => { controls.setListPanel(!controls.listPanel); controls.setDatePanel(false); }}>{activeList?.icon || '📥'} {activeList?.label || '기본함'} ▾</button>
      <span />
    </footer>
    {controls.listPanel && <div className="new-list-panel">
      <label className="new-list-search"><span>⌕</span><input value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder="검색" autoFocus /></label>
      <div className="new-list-options">
        {filteredListOptions.map((option) => {
          const active = slugify(controls.list) === slugify(option.id) || slugify(controls.list) === slugify(option.label);
          return <button className="new-list-row" data-active={active} key={option.id} onClick={() => { controls.setList(option.id); controls.setListPanel(false); setListQuery(''); }}>
            <span className="new-list-icon">{option.icon}</span>
            <span className="new-list-label">{option.label}</span>
            <span className="new-list-state">{active ? '✓' : '›'}</span>
          </button>;
        })}
        {!filteredListOptions.length && <div className="new-list-empty">일치하는 리스트 없음</div>}
      </div>
    </div>}
  </div>;
}

function NewAccordionRow({ label, value, panel, controls }: { label: string; value: string; panel: string; controls: NewTaskControls }) {
  const active = controls.subPanel === panel;
  return <button className="new-accordion-row" onClick={() => controls.setSubPanel(active ? null : panel)}><b>{label}</b><em>{value}</em><i>{active ? '▾' : '›'}</i></button>;
}

function SettingsOverlay({ settings, setSettings, refresh, close, loggedIn, setLoggedIn, loginEmail, setLoginEmail, loginPw, setLoginPw, prefs, updatePrefs }: { settings: DesktopSettingsState; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; close: () => void; loggedIn: boolean; setLoggedIn: (value: boolean) => void; loginEmail: string; setLoginEmail: (value: string) => void; loginPw: string; setLoginPw: (value: string) => void; prefs: UiPreferences; updatePrefs: (value: UiPreferences) => Promise<void> }) {
  const themes: Array<[DesktopTheme, string, string]> = [
    ['default', 'Terracotta', '#D7613D'],
    ['warm', 'Warm', '#C95035'],
    ['dark', 'Dark', '#3F362F'],
    ['sage', 'Sage', '#4F7D68'],
    ['mono', 'Mono', '#3F3A34'],
  ];
  const prefRows: Array<[keyof typeof prefs, string, string]> = [
    ['notify', '리마인더 알림', '정각 일정·마감 작업 알림'],
    ['agentShare', '에이전트와 캘린더 공유', '위임 작업을 캘린더에 자동 표시'],
    ['weekStartMon', '주 시작을 월요일로', '캘린더 주간 뷰 기준 요일'],
  ];
  async function saveTheme(theme: DesktopTheme) {
    setSettings({ ...settings, theme });
    const next = await window.hermesDesktop?.saveSettings({ theme });
    if (next) setSettings(desktopSettingsState(next));
    await refresh();
  }
  const submitLogin = () => {
    setLoggedIn(true);
    setLoginPw('');
    close();
  };
  return <div className="settings-backdrop" onMouseDown={close}><div className="settings-overlay" onMouseDown={(event) => event.stopPropagation()}>
    <header><h2>설정</h2><button onClick={close}>✕</button></header>
    <div className="settings-body">
      <div className="settings-label">계정</div>
      <section className="account-box"><div className="avatar large">윤</div><div><strong>Yunseo</strong><span>{loggedIn ? 'yunseo@hermes.os' : '로그인이 필요합니다'}</span></div>{loggedIn ? <button onClick={() => setLoggedIn(false)}>로그아웃</button> : <button className="primary" onClick={submitLogin}>로그인</button>}</section>
      {!loggedIn && <section className="login-inline"><input value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin(); }} placeholder="yunseo@hermes.os" /><input value={loginPw} onChange={(event) => setLoginPw(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin(); }} type="password" placeholder="••••••••" /><button className="primary" onClick={submitLogin}>로그인</button></section>}
      <div className="settings-label">테마 · 강조 색상</div>
      <section className="theme-grid">{themes.map(([key, label, color]) => <button data-active={settings.theme === key} key={key} onClick={() => void saveTheme(key)}><span style={{ background: color }}>{settings.theme === key ? '✓' : ''}</span><b>{label}</b></button>)}</section>
      <section className="theme-preview"><span>H</span><b>선택한 색상이 버튼·강조·캘린더 전반에 즉시 적용됩니다</b></section>
      <div className="settings-label">환경설정</div>
      <section className="pref-box">{prefRows.map(([key, label, desc]) => <div key={key}><span><b>{label}</b><small>{desc}</small></span><button className="switch" data-active={prefs[key]} onClick={() => void updatePrefs({ ...prefs, [key]: !prefs[key] })}><span /></button></div>)}</section>
    </div>
    <footer><span>Hermes Tasks · v0.9 · 로컬 저장</span><button className="primary" onClick={close}>완료</button></footer>
  </div></div>;
}

function RunReport({ run: selected, close, openArtifact }: { run?: Item; close: () => void; openArtifact: (run?: Item) => void }) {
  if (!selected) {
    return <div className="run-report">
      <section className="run-head"><span>대기</span><div><strong>선택된 실행 없음</strong><small>백엔드 런을 선택하세요</small></div><button onClick={close}>✕</button></section>
    </div>;
  }
  const run = selected;
  const pct = /done|완료/i.test(text(run.status)) ? 100 : Number(run.pct || run.progress || 0);
  const steps = Array.isArray(run.steps) ? run.steps as Item[] : [];
  return <div className="run-report">
    <section className="run-head"><span>{pct >= 100 ? '완료' : '실행 중'}</span><div><strong>{text(run.title || run.goal, '런')}</strong><small>{text(run.agent, 'default')}</small></div><button onClick={close}>✕</button></section>
    <div className="run-progress"><span style={{ width: `${pct}%` }} /></div>
    <section className="run-timeline"><h3>실행 타임라인</h3>{steps.map((step, index) => <div className="run-step" key={index}><i data-active={index === steps.length - 1 && pct < 100} /><span><strong>{itemTitle(step, '단계')}</strong><small>{text(step.detail)}</small></span><em>{text(step.time)}</em></div>)}</section>
    <section className="run-artifact"><span>📄</span><div><strong>{text(run.artifact || run.document || run.goal, '실행 결과 정리')}</strong><small>위키 문서 · 완료 후 열기</small></div><button onClick={() => openArtifact(run)}>열기 →</button></section>
  </div>;
}

function Panel({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return <section className="panel" data-wide={wide}><h3>{title}</h3>{children}</section>;
}

function Rows({ items, action, onOpen, onToggle }: { items: Item[]; action: string; onOpen?: (item: Item) => void; onToggle?: (item: Item) => void }) {
  return <div className="rows">{items.map((item, index) => <button className="row" data-done={isDone(item)} key={index} onClick={() => onOpen?.(item)}>{onToggle && <i onClick={(event) => { event.stopPropagation(); onToggle(item); }}>{isDone(item) ? '✓' : ''}</i>}<span><b>{itemTitle(item, '항목')}</b><small>{itemSub(item, 'Hermes')}</small></span><em>{action}</em></button>)}</div>;
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return <div className="kpi"><span>{label}</span><strong>{value}</strong></div>;
}

function Legend() {
  return <div className="legend"><span className="me" />나<span className="agent" />에이전트<span className="hybrid" />공동</div>;
}

function Segment({ items, values, active, setActive }: { items: string[]; values?: string[]; active?: string; setActive?: (value: string) => void }) {
  return <div className="segment">{items.map((item, index) => <button data-active={(values?.[index] || item) === active || (!active && index === 0)} key={item} onClick={() => setActive?.(values?.[index] || item)}>{item}</button>)}</div>;
}

function Suggestion({ text: value }: { text: string }) {
  return <div className="suggestion"><b>🤖 제안</b><p>{value}</p><button>조사 시작</button><button>무시</button></div>;
}
