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
type CompletionNotice = { task: Item; title: string } | null;
type AuthProvider = HermesAuthProvider;
type AuthProfileState = HermesAuthProfile;
type DesktopSettingsState = { apiBaseUrl: string; hasApiToken: boolean; theme: HermesDesktopSettings['theme']; authProfile: AuthProfileState | null; uiPreferences: UiPreferences };
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
  profileReadiness: ApiEnvelope;
  agentSourceStatus: ApiEnvelope;
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
  profileReadiness: {},
  agentSourceStatus: {},
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
const CALENDAR_META_MARKER = '[Agent Calendar]\n';
const DEFAULT_UI_PREFERENCES: UiPreferences = { notify: true, agentShare: true, weekStartMon: true };
const LOGO_SRC = '/agent-calendar-logo.png';
const IS_WIDGET_OVERLAY = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('overlay') === 'widgets';

if (IS_WIDGET_OVERLAY && typeof document !== 'undefined') {
  document.documentElement.dataset.overlay = 'widgets';
}

function LogoMark({ className = 'brand-mark' }: { className?: string }) {
  return <img className={className} src={LOGO_SRC} alt="" draggable={false} />;
}

function ChatIcon({ className = 'chat-fab-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7.5 8.25h9M7.5 12h6.25" />
      <path d="M5.75 18.5c-1.45 0-2.5-1.05-2.5-2.5V6.75c0-1.45 1.05-2.5 2.5-2.5h12.5c1.45 0 2.5 1.05 2.5 2.5V16c0 1.45-1.05 2.5-2.5 2.5h-6.8L7.6 21.1c-.82.55-1.85-.04-1.85-1.02V18.5Z" />
    </svg>
  );
}

type SystemIconName = 'calendar' | 'check' | 'google' | 'key' | 'mail' | 'orbit';

function SystemIcon({ name, className = 'system-icon' }: { name: SystemIconName; className?: string }) {
  const paths: Record<SystemIconName, JSX.Element> = {
    calendar: <><path d="M7.5 3.75v2.5M16.5 3.75v2.5M5.5 7.25h13" /><path d="M6.25 5.25h11.5c1.1 0 2 .9 2 2v10.5c0 1.1-.9 2-2 2H6.25c-1.1 0-2-.9-2-2V7.25c0-1.1.9-2 2-2Z" /><path d="M8 11.25h2.5M13.5 11.25H16M8 15h2.5" /></>,
    check: <path d="m6 12.4 3.3 3.35L18 7.25" />,
    google: <><path d="M19.2 12.2c0-.5 0-.9-.1-1.3H12v2.6h4.1c-.2.9-.7 1.7-1.5 2.2v1.8H17c1.4-1.3 2.2-3.1 2.2-5.3Z" /><path d="M12 19.5c2 0 3.7-.7 5-1.9l-2.4-1.8c-.7.4-1.5.7-2.6.7-1.9 0-3.5-1.3-4.1-3H5.4v1.9c1.2 2.4 3.7 4.1 6.6 4.1Z" /><path d="M7.9 13.4c-.2-.4-.2-.9-.2-1.4s.1-1 .2-1.4V8.7H5.4c-.5 1-.8 2.1-.8 3.3s.3 2.3.8 3.3l2.5-1.9Z" /><path d="M12 7.5c1.1 0 2 .4 2.8 1.1L17 6.4c-1.3-1.2-3-1.9-5-1.9-2.9 0-5.4 1.7-6.6 4.1l2.5 1.9c.6-1.7 2.2-3 4.1-3Z" /></>,
    key: <><path d="M14.25 9.75a3.75 3.75 0 1 0-2.5 3.54l2.06 2.06h2.44v2.4h2.5v-2.5L14 10.5c.16-.24.25-.5.25-.75Z" /><path d="M7.75 9.75h.01" /></>,
    mail: <><path d="M5.75 6.25h12.5c1.1 0 2 .9 2 2v7.5c0 1.1-.9 2-2 2H5.75c-1.1 0-2-.9-2-2v-7.5c0-1.1.9-2 2-2Z" /><path d="m5.5 8.25 6.5 4.5 6.5-4.5" /></>,
    orbit: <><path d="M12 12m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0" /><path d="M4.25 12c0-4.28 3.47-7.75 7.75-7.75S19.75 7.72 19.75 12 16.28 19.75 12 19.75 4.25 16.28 4.25 12Z" /><path d="M6.4 6.7c3.3-2.1 8.1-.7 10.7 3.1s2 8.6-1.3 10.7M17.6 17.3c-3.3 2.1-8.1.7-10.7-3.1s-2-8.6 1.3-10.7" /></>,
  };
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

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
  { title: 'AGENTS', items: [
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

function compactWikiSnippet(value: unknown, maxLength = 180) {
  const normalized = text(value).replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function wikiStreamCommand(question: string, sources: Item[]) {
  const context = sources.slice(0, 2).map((source, index) => {
    const title = text(source.title || source.path, '위키 문서');
    const heading = text(source.heading || source.headingPath, '근거');
    const snippet = compactWikiSnippet(source.snippet || source.text);
    return `[${index + 1}] ${title} / ${heading}: ${snippet}`;
  }).join('\n');
  return [
    '위키 큐레이터 답변.',
    '규칙: SOURCES만 사용. 한국어 한 문장, 120자 이하. 반드시 문장 끝에 [1]처럼 인용. 모르면 "위키 근거 부족".',
    '',
    `Q: ${question}`,
    '',
    `SOURCES:\n${context || '(검색된 근거 없음)'}`,
  ].join('\n');
}

function itemTitle(item: Item, fallback = '항목') {
  return text(item.title || item.goal || item.name || item.subject || item.label || item.text || item.path, fallback);
}

function itemSub(item: Item, fallback = 'Agent Calendar') {
  return text(item.date || item.due || item.status || item.agent || item.model || item.from || item.folder || item.source, fallback);
}

function docIdentity(item: Item, fallback = '') {
  return text(item.path || item.wikiPath || item.id || item._id || item.key || item.title, fallback);
}

function persistedDocumentIdentity(item: Item, fallback = '') {
  return text(item.path || item.wikiPath || item.id || item._id || item.key, fallback);
}

function createdDocumentFrom(payload: ApiEnvelope): Item {
  const nested = obj(payload, 'document');
  if (persistedDocumentIdentity(nested)) return nested;
  return persistedDocumentIdentity(payload) ? payload : {};
}

function agentIdentity(item: Item, fallback = '') {
  return text(item.id || item._id || item.key || item.name || item.displayName, fallback);
}

function createdAgentFrom(payload: ApiEnvelope): Item {
  const nested = obj(payload, 'agent');
  if (agentIdentity(nested)) return nested;
  return agentIdentity(payload) ? payload : {};
}

function runIdentity(item: Item, fallback = '') {
  return text(item.id || item._id || item.key || item.runId || item.title || item.goal, fallback);
}

function createdRunFrom(payload: ApiEnvelope): Item {
  const nested = obj(payload, 'run');
  if (runIdentity(nested)) return nested;
  return runIdentity(payload) ? payload : {};
}

function taxonomyIdentity(item: Item, fallback = '') {
  const parsed = parseTaxonomyRecord(item);
  return text(parsed?.recordId || itemId(item, ''), fallback);
}

function savedTaxonomyFrom(payload: ApiEnvelope): Item {
  const nested = responseTask(payload);
  if (nested && taxonomyIdentity(nested)) return nested;
  return taxonomyIdentity(payload) ? payload : {};
}

function objectValue(value: unknown): Item {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {};
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
  if (/agent|default|marketflow|stockagent|uniportpm|Hermes|Agent Calendar/i.test(owner)) return 'Agent';
  if (/hybrid|joint|공동/i.test(owner)) return 'Hybrid';
  return 'Me';
}

function profileReadinessEntries(payload: ApiEnvelope) {
  return arr(payload, 'requiredProfiles', 'profiles');
}

function profileEntryName(entry: Item) {
  return text(entry.profile || entry.name || entry.id || objectValue(entry.setup).profile, '').toLowerCase();
}

function agentProfileName(agent: Item) {
  const profile = objectValue(agent.profile);
  return text(agent.profileName || agent.profileId || profile.name || profile.profile || agent.name || agent.id, '').toLowerCase();
}

function mergeAgentsWithProfileReadiness(agents: Item[], readiness: ApiEnvelope) {
  const entries = profileReadinessEntries(readiness);
  if (!entries.length) return agents;
  const byProfile = new Map<string, Item>();
  entries.forEach((entry) => {
    const key = profileEntryName(entry);
    if (key) byProfile.set(key, entry);
  });
  return agents.map((agent) => {
    const key = agentProfileName(agent);
    const profileStatus = key ? byProfile.get(key) : undefined;
    if (!profileStatus) return agent;
    return {
      ...agent,
      hermesProfileName: profileEntryName(profileStatus) || key,
      hermesProfileStatus: text(profileStatus.status, ''),
      hermesProfilePresent: profileStatus.present,
      hermesProfileSetup: profileStatus.setup,
      hermesDashboardProfile: profileStatus,
    };
  });
}

function agentStatusLabel(agent: Item) {
  const raw = text(agent.hermesProfileStatus || agent.profileStatus || agent.status, '').toLowerCase();
  const present = agent.hermesProfilePresent;
  if (present === false || /missing|not-found|absent|누락|없음/.test(raw)) return '누락';
  if (/ready|준비/.test(raw)) return '준비됨';
  if (/busy|running|작업|executing/.test(raw)) return '작업중';
  if (/active|online|connected|활성/.test(raw)) return '활성';
  if (/idle|유휴/.test(raw)) return '유휴';
  if (/blocked|error|fail|오류/.test(raw)) return '확인 필요';
  return raw ? text(agent.hermesProfileStatus || agent.profileStatus || agent.status) : '상태 없음';
}

function agentDisplayName(agent: Item) {
  return text(agent.displayName || agent.name || agent.id || agent.hermesProfileName, 'agent');
}

function isAgentSelectable(agent: Item) {
  return agent.hermesProfilePresent !== false && !/missing|누락/i.test(text(agent.hermesProfileStatus || agent.status));
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

function quickDatePreset(kind: 'today' | 'tomorrow' | 'nextWeek' | 'evening', baseDate = todayKey()) {
  if (kind === 'tomorrow') return { date: addDaysKey(todayKey(), 1), time: '' };
  if (kind === 'nextWeek') return { date: addDaysKey(todayKey(), 7), time: '' };
  if (kind === 'evening') return { date: todayKey(), time: '18:00' };
  return { date: todayKey(), time: '' };
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
  const source = isCalendarEventRecord(item) ? 'event' as const : 'task' as const;
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
    list: text(item.category || item.project || item.list || item.source, 'Agent Calendar'),
    status,
    done: isDone(item),
    ...(durationMinutes ? { durationMinutes } : {}),
    source,
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
  const copyKeys = ['title', 'notes', 'description', 'date', 'time', 'endDate', 'endTime', 'allDay', 'owner', 'agent', 'status', 'lane', 'tags', 'repeat', 'repeatUntil', 'recurrence', 'priority', 'project', 'category', 'list', 'done', 'reminder', 'reminderAt'];
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
  if (!date && !time && (item.date === '' || item.time === '') && payload.due === undefined) payload.due = '';
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

function taskMatchesCreated(expected: Item, candidate: Item) {
  const expectedId = itemId(expected, '');
  const candidateId = itemId(candidate, '');
  if (expectedId && candidateId && expectedId === candidateId) return true;
  return itemTitle(expected, '') !== '' && itemTitle(expected, '') === itemTitle(candidate, '') && text(expected.date) === text(candidate.date);
}

function calendarEventMatchesCreated(expected: Item, candidate: Item) {
  const expectedId = itemId(expected, '');
  const candidateId = itemId(candidate, '');
  if (expectedId && candidateId && expectedId === candidateId) return true;
  const expectedDate = text(expected.startDate || expected.date);
  const candidateDate = text(candidate.startDate || candidate.date);
  return itemTitle(expected, '') !== '' && itemTitle(expected, '') === itemTitle(candidate, '') && expectedDate === candidateDate;
}

function taxonomyMatchesSaved(expected: TaxonomyItem, candidate: Item) {
  const parsed = parseTaxonomyRecord(candidate);
  if (!parsed || parsed.kind !== expected.kind) return false;
  if (expected.recordId && parsed.recordId && expected.recordId === parsed.recordId) return true;
  return slugify(parsed.id) === slugify(expected.id) || slugify(parsed.label) === slugify(expected.label);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    authProfile: settings.authProfile || null,
    uiPreferences: settings.uiPreferences || DEFAULT_UI_PREFERENCES,
  };
}

export function App() {
  const isWidgetOverlay = IS_WIDGET_OVERLAY;
  const [screen, setScreen] = useState<ScreenId>('calendar');
  const [activeNavKey, setActiveNavKey] = useState('calendar');
  const [modal, setModal] = useState<ModalId>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [settings, setSettings] = useState<DesktopSettingsState>({ apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app', hasApiToken: false, theme: 'default', authProfile: null, uiPreferences: DEFAULT_UI_PREFERENCES });
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(true);
  const hasHydratedRef = useRef(false);
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
  const [loginStatus, setLoginStatus] = useState('');
  const [authBusyProvider, setAuthBusyProvider] = useState<AuthProvider | null>(null);
  const [passwordAuthBusy, setPasswordAuthBusy] = useState(false);
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
  const [wikiAnswerMeta, setWikiAnswerMeta] = useState<Item>({});
  const [wikiAsking, setWikiAsking] = useState(false);
  const [wikiIncludeJournal, setWikiIncludeJournal] = useState(false);
  const [wikiIncludeRaw, setWikiIncludeRaw] = useState(false);
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
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice>(null);
  const widgetActionDrainRef = useRef(false);
  const optimisticRunsRef = useRef<Item[]>([]);
  const approvedRunIdsRef = useRef<Set<string>>(new Set());

  const baseTasks = state.tasks;
  const tasks = useMemo(() => [...baseTasks], [baseTasks]);
  const events = useMemo(() => [
    ...state.events
      .map((event) => ({ ...event, kind: 'calendar-event' })),
  ], [state.events]);
  const agents = useMemo(() => mergeAgentsWithProfileReadiness(state.agents, state.profileReadiness), [state.agents, state.profileReadiness]);
  const runs = state.runs;
  const selectedRun = runs.find((run, index) => itemId(run, `run-${index}`) === selectedRunId) || runs[0];
  const accountName = settings.authProfile?.name || 'Yunseo';
  const accountEmail = settings.authProfile?.email || 'yunseo@agent.calendar';
  const accountInitial = (accountName || accountEmail || 'A').trim().slice(0, 1).toUpperCase();
  const accountProviderLabel = settings.authProfile?.provider === 'google' ? 'Google 로그인' : settings.authProfile?.provider === 'password' ? '이메일 로그인' : 'Railway 연결';
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
        if (desktopSettings && !cancelled) {
          setSettings(desktopSettingsState(desktopSettings));
          setLoggedIn(Boolean(desktopSettings.authProfile));
          if (desktopSettings.authProfile?.email) setLoginEmail(desktopSettings.authProfile.email);
        }
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

  async function hydrate(options: { blocking?: boolean } = {}) {
    const blocking = options.blocking ?? !hasHydratedRef.current;
    if (blocking) setLoading(true);
    setApiError('');
    try {
      const optionalRequest = (label: string, request: Promise<ApiEnvelope>, fallback: ApiEnvelope = {}) => request.catch((error) => {
        setApiError(error instanceof Error ? error.message : `${label} 불러오기 실패`);
        return fallback;
      });
      const settingsRequest = optionalRequest('설정', hermesApi.getSettings());
      const automationRequest = optionalRequest('자동화', hermesApi.getAutomation());
      const usageRequest = optionalRequest('사용량', hermesApi.getUsage());
      const toolsRequest = optionalRequest('도구', hermesApi.getTools());
      const channelsRequest = optionalRequest('채널', hermesApi.getChannels());
      const chatRequest = optionalRequest('채팅', hermesApi.getChatMessages());
      const [dashboard, tasksPayload, eventsPayload, agentsPayload, wiki, inbox, automation, usage, tools, settingsPayload, channels, documentsPayload, chatPayload] = await Promise.all([
        hermesApi.getDashboardState(),
        hermesApi.getTasks(),
        hermesApi.getCalendarEvents(),
        hermesApi.getAgents(),
        hermesApi.getWiki(),
        hermesApi.getInbox(),
        automationRequest,
        usageRequest,
        toolsRequest,
        settingsRequest,
        channelsRequest,
        hermesApi.getDocuments(),
        chatRequest,
      ]);
      const rawTasks = arr(tasksPayload, 'tasks');
      const taxonomyRecords = rawTasks.filter(isTaxonomyRecord);
      const tasks = rawTasks.filter(isTaskRecord);
      const events = [
        ...arr(eventsPayload, 'events', 'calendarEvents').map(normalizeCalendarEvent),
        ...rawTasks.filter(isCalendarEventRecord).map(normalizeCalendarEvent),
      ];
      const agents = arr(agentsPayload, 'agents');
      const remoteRuns = arr(dashboard, 'runs');
      const seenRuns = new Set(remoteRuns.map((run, index) => itemId(run, `run-${index}`)));
      const runs = [
        ...optimisticRunsRef.current.filter((run, index) => !seenRuns.has(itemId(run, `optimistic-run-${index}`))),
        ...remoteRuns,
      ].filter((run, index) => {
        const id = itemId(run, `run-${index}`);
        return !approvedRunIdsRef.current.has(id) && !/approved|승인/i.test(text(run.status));
      });
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
        profileReadiness: obj(dashboard, 'profileReadiness'),
        agentSourceStatus: obj(dashboard, 'agentSourceStatus'),
      });
      setPrefs(settingsPreferences(settingsPayload));
      setSettings((current) => ({ ...current, uiPreferences: settingsPreferences(settingsPayload) }));
      if (remoteChat.length) {
        setChatMessages(remoteChat.slice(-40).map(toChatMessage).filter((message) => message.text));
      }
      hasHydratedRef.current = true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Railway API 응답 실패');
    } finally {
      if (blocking || !hasHydratedRef.current) setLoading(false);
    }
  }

  async function loginWithProvider(provider: AuthProvider) {
    setLoginStatus('');
    setAuthBusyProvider(provider);
    try {
      if (!window.hermesDesktop?.loginWithProvider) {
        setLoggedIn(true);
        setLoginPw('');
        setModal(null);
        return;
      }
      const next = await window.hermesDesktop.loginWithProvider(provider);
      setSettings(desktopSettingsState(next));
      setLoggedIn(Boolean(next.authProfile));
      if (next.authProfile?.email) setLoginEmail(next.authProfile.email);
      setLoginPw('');
      setModal(null);
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : '소셜 로그인을 완료하지 못했습니다.');
    } finally {
      setAuthBusyProvider(null);
    }
  }

  async function authenticateWithPassword(mode: 'login' | 'signup') {
    const email = loginEmail.trim();
    const password = loginPw;
    setLoginStatus('');
    setPasswordAuthBusy(true);
    try {
      if (!window.hermesDesktop) {
        setLoggedIn(true);
        setLoginPw('');
        setModal(null);
        return;
      }
      if (!email || !password) throw new Error('이메일과 비밀번호를 입력하세요.');
      const next = mode === 'signup'
        ? await window.hermesDesktop.signUpWithPassword({ email, password })
        : await window.hermesDesktop.loginWithPassword({ email, password });
      setSettings(desktopSettingsState(next));
      setLoggedIn(Boolean(next.authProfile));
      if (next.authProfile?.email) setLoginEmail(next.authProfile.email);
      setLoginPw('');
      setModal(null);
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : mode === 'signup' ? '회원가입에 실패했습니다.' : '로그인에 실패했습니다.');
    } finally {
      setPasswordAuthBusy(false);
    }
  }

  async function logout() {
    try {
      const next = await window.hermesDesktop?.logoutAuth();
      if (next) setSettings(desktopSettingsState(next));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '로그아웃 상태 저장 실패');
    }
    setLoggedIn(false);
    setLoginPw('');
    setModal(null);
  }

  async function waitForCreatedTaskInBackend(expected: Item) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt) await wait(800);
      const payload = await hermesApi.getTasks();
      const tasks = arr(payload, 'tasks').filter(isTaskRecord);
      if (tasks.some((candidate) => taskMatchesCreated(expected, candidate))) return true;
    }
    return false;
  }

  async function waitForCreatedCalendarEventInBackend(expected: Item) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt) await wait(800);
      const payload = await hermesApi.getCalendarEvents();
      const events = arr(payload, 'events', 'calendarEvents').map(normalizeCalendarEvent);
      if (events.some((candidate) => calendarEventMatchesCreated(expected, candidate))) return true;
    }
    return false;
  }

  async function waitForSavedTaxonomyInBackend(expected: TaxonomyItem) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt) await wait(800);
      const payload = await hermesApi.getTasks();
      const records = arr(payload, 'tasks').filter(isTaxonomyRecord);
      if (records.some((candidate) => taxonomyMatchesSaved(expected, candidate))) return true;
    }
    return false;
  }

  async function persistCreatedTask(task: Item, source: 'task' | 'calendar' = 'task', options: { requireHydrated?: boolean } = {}) {
    let created = false;
    try {
      if (source === 'calendar') {
        const response = await hermesApi.createCalendarEvent(calendarEventPayload(task));
        const createdEvent = responseCalendarEvent(response) || task;
        if (options.requireHydrated) {
          const visible = await waitForCreatedCalendarEventInBackend(createdEvent);
          if (!visible) {
            setApiError('생성한 일정을 캘린더에서 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
            return false;
          }
        }
        created = true;
      } else {
        const response = await hermesApi.createTask(desktopTaskPayload(task));
        const createdTask = responseTask(response) || task;
        if (options.requireHydrated) {
          const visible = await waitForCreatedTaskInBackend(createdTask);
          if (!visible) {
            setApiError('생성한 작업을 목록에서 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
            return false;
          }
        }
        created = true;
      }
      await hydrate();
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '작업 생성 실패');
      return options.requireHydrated ? false : created;
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
      allDay: newAllDay,
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
    const created = await persistCreatedTask(
      screen === 'calendar' ? { ...task, kind: 'calendar-event', type: 'calendar-event' } : task,
      screen === 'calendar' ? 'calendar' : 'task',
      { requireHydrated: true },
    );
    if (!created) return;
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
  }

  async function createQuickTask(rawTitle: string, fallbackDate?: string, options: { owner?: string; status?: string; source?: 'task' | 'calendar'; requireHydrated?: boolean } = {}) {
    const parsed = parseQuick(rawTitle, fallbackDate);
    const targetList = activeListForNewTask(false);
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
      const created = await persistCreatedTask(eventTask, 'calendar', { requireHydrated: options.requireHydrated });
      return created ? eventTask : null;
    }
    const created = await persistCreatedTask(task, 'task', { requireHydrated: options.requireHydrated });
    return created ? task : null;
  }

  function submitQuick(fallbackDate?: string) {
    const value = quickText.trim();
    if (!value) return;
    void createQuickTask(value, fallbackDate, { requireHydrated: true }).then((created) => {
      if (!created) return;
      setQuickText((current) => (current.trim() === value ? '' : current));
    });
  }

  function patchItemsById(items: Item[], id: string, patch: Item) {
    let changed = false;
    const next = items.map((item, index) => {
      const keys = new Set([
        itemId(item, ''),
        itemId(item, `task-${index}`),
        itemId(item, `event-${index}`),
        text(item.taskId),
      ].filter(Boolean));
      if (!keys.has(id)) return item;
      changed = true;
      return { ...item, ...patch };
    });
    return changed ? next : items;
  }

  function applyOptimisticTaskPatch(id: string, patch: Item) {
    setState((current) => ({
      ...current,
      tasks: patchItemsById(current.tasks, id, patch),
    }));
  }

  function applyOptimisticEventPatch(id: string, patch: Item) {
    setState((current) => ({
      ...current,
      events: patchItemsById(current.events, id, patch),
    }));
  }

  async function patchTask(task: Item, patch: Item, options: { afterPersist?: () => void } = {}) {
    const id = itemId(task, '');
    if (!id) return false;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 작업만 수정할 수 있습니다.');
      return false;
    }
    const snapshot = { ...task, ...patch };
    applyOptimisticTaskPatch(id, snapshot);
    try {
      await hermesApi.updateTask(id, taskPayload(snapshot));
      options.afterPersist?.();
      await hydrate();
      return true;
    } catch (error) {
      applyOptimisticTaskPatch(id, task);
      setApiError(error instanceof Error ? error.message : '작업 업데이트 실패');
      return false;
    }
  }

  async function patchCalendarEvent(task: Item, patch: Item) {
    const id = itemId(task, '');
    if (!id) return false;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 일정만 수정할 수 있습니다.');
      return false;
    }
    const snapshot = { ...task, ...patch, kind: 'calendar-event', type: 'calendar-event' };
    applyOptimisticEventPatch(id, snapshot);
    try {
      await hermesApi.updateCalendarEvent(id, calendarEventPayload(snapshot));
      await hydrate();
      return true;
    } catch (error) {
      applyOptimisticEventPatch(id, task);
      setApiError(error instanceof Error ? error.message : '일정 업데이트 실패');
      return false;
    }
  }

  async function toggleTask(task: Item) {
    const done = !isDone(task);
    const ok = await patchTask(task, { status: done ? 'Done' : 'Planned', done }, {
      afterPersist: () => setCompletionNotice(done ? { task, title: itemTitle(task, '작업') } : null),
    });
    if (!ok) return;
  }

  function undoCompletion() {
    if (!completionNotice) return;
    patchTask(completionNotice.task, { status: 'Planned', done: false });
    setCompletionNotice(null);
  }

  function widgetScreen(value: unknown): ScreenId {
    const screen = text(value);
    if (['calendar', 'today', 'next7', 'tasks', 'agents', 'widgets'].includes(screen)) return screen as ScreenId;
    return 'today';
  }

  async function handleWidgetAction(action: HermesWidgetAction) {
    switch (action.type) {
    case 'toggleTask': {
      const id = text(action.taskID);
      if (!id) return;
      const task = tasks.find((item, index) => itemId(item, `task-${index}`) === id);
      const event = events.find((item, index) => itemId(item, `event-${index}`) === id);
      const done = typeof action.done === 'boolean' ? action.done : !isDone(task || event || {});
      if (action.source === 'event' || event) {
        const snapshot = { ...(event || {}), id, status: done ? 'Done' : 'Planned', done, kind: 'calendar-event', type: 'calendar-event' };
        await hermesApi.updateCalendarEvent(id, calendarEventPayload(snapshot));
        await hydrate();
        return;
      }
      if (task || action.source === 'task') {
        const snapshot = { ...(task || {}), id, status: done ? 'Done' : 'Planned', done };
        await hermesApi.updateTask(id, taskPayload(snapshot));
        await hydrate();
        return;
      }
      return;
    }
    case 'openDate':
      if (action.date) setCalDate(action.date);
      openScreen('calendar');
      return;
    case 'openScreen':
      openScreen(widgetScreen(action.screen));
      return;
    case 'openTask': {
      const id = text(action.taskID);
      if (!id) return;
      const task = tasks.find((item, index) => itemId(item, `task-${index}`) === id);
      const event = events.find((item, index) => itemId(item, `event-${index}`) === id);
      const item = task || event;
      if (item) {
        setSelectedTaskId(id);
        const date = widgetItemDate(item);
        if (date) setCalDate(date);
        openScreen(event ? 'calendar' : date === todayKey() ? 'today' : 'tasks');
        setModal('task');
      }
      return;
    }
    case 'openRun':
      if (action.runID) setSelectedRunId(action.runID);
      openScreen('agents');
      setModal('run');
      return;
    default:
      return;
    }
  }

  async function drainWidgetActions() {
    if (loading || widgetActionDrainRef.current || !window.hermesDesktop?.readWidgetActions) return;
    widgetActionDrainRef.current = true;
    const completed: string[] = [];
    try {
      const actions = await window.hermesDesktop.readWidgetActions();
      for (const action of actions.sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)))) {
        if (!action.id) continue;
        completed.push(action.id);
        try {
          await handleWidgetAction(action);
        } catch (error) {
          console.warn('Agent Calendar widget action failed', action, error);
        }
      }
      if (completed.length) await window.hermesDesktop?.clearWidgetActions(completed);
    } catch (error) {
      console.warn('Agent Calendar widget action drain failed', error);
    } finally {
      widgetActionDrainRef.current = false;
    }
  }

  async function removeTask(task: Item) {
    const id = itemId(task, '');
    if (!id) return false;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 작업만 삭제할 수 있습니다.');
      return false;
    }
    try {
      await hermesApi.deleteTask(id);
      await hydrate();
      setSelectedTaskId('');
      setModal(null);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '작업 삭제 실패');
      return false;
    }
  }

  async function removeCalendarEvent(task: Item) {
    const id = itemId(task, '');
    if (!id) return false;
    if (!shouldPersistTask(id)) {
      setApiError('서버에 저장된 일정만 삭제할 수 있습니다.');
      return false;
    }
    try {
      await hermesApi.deleteCalendarEvent(id);
      await hydrate();
      setSelectedTaskId('');
      setModal(null);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '일정 삭제 실패');
      return false;
    }
  }

  function openTask(task: Item) {
    setSelectedTaskId(itemId(task, ''));
    setModal('task');
  }

  function openDoc(doc: Item) {
    setActiveWikiId(docIdentity(doc, itemId(doc, '')));
    setWikiReaderOpen(true);
    openScreen('wiki');
  }

  function openRun(run?: Item) {
    if (run) setSelectedRunId(itemId(run, ''));
    setModal('run');
  }

  function addOptimisticRun(run: Item) {
    const id = itemId(run, '');
    if (!id) return;
    optimisticRunsRef.current = [run, ...optimisticRunsRef.current.filter((item, index) => itemId(item, `run-${index}`) !== id)];
    setState((current) => ({
      ...current,
      runs: [run, ...current.runs.filter((item, index) => itemId(item, `run-${index}`) !== id)],
    }));
  }

  async function startPlan(goal: string, agentId = selectedAgentId) {
    const textValue = goal.trim();
    if (!textValue) return;
    try {
      const task = await createQuickTask(textValue, todayKey(), { owner: 'Agent', status: 'Doing', source: 'task' });
      if (!task) return;
      const runPayload = await hermesApi.launchMission({
        templateId: 'product-build',
        goal: textValue,
        agentId,
        source: 'desktop-mission',
      });
      const run = createdRunFrom(runPayload);
      if (!runIdentity(run)) throw new Error('미션 실행 응답이 비어 있습니다.');
      setModal(null);
      addOptimisticRun(run);
      openRun(run);
      openScreen('agents');
      void hydrate();
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '미션 실행 실패');
    }
  }

  async function createAgent() {
    const name = newAgentName.trim();
    if (!name) return;
    const optimisticAgent = {
      id: slugify(name) || `agent-${Date.now()}`,
      name,
      displayName: name,
      emoji: newAgentEmoji,
      role: newAgentRole || '사용자 정의 에이전트',
      status: 'ready',
      source: 'hermes-desktop',
    };
    const previousAgents = state.agents;
    setState((current) => ({ ...current, agents: [optimisticAgent, ...current.agents] }));
    try {
      const payload = await hermesApi.createAgent({
        name,
        displayName: name,
        emoji: newAgentEmoji,
        role: newAgentRole || '사용자 정의 에이전트',
        source: 'hermes-desktop',
      });
      const created = createdAgentFrom(payload);
      if (!agentIdentity(created)) throw new Error('에이전트 생성 응답이 비어 있습니다.');
      setState((current) => ({
        ...current,
        agents: [created, ...current.agents.filter((agent, index) => itemId(agent, `agent-${index}`) !== optimisticAgent.id)],
      }));
      setNewAgentName('');
      setNewAgentRole('');
      setNewAgentEmoji('🤖');
      setModal(null);
      await hydrate();
    } catch (error) {
      setState((current) => ({ ...current, agents: previousAgents }));
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
      setChatInput((current) => current || message);
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
    setWikiAnswerMeta({});
    try {
      const searchPayload = await hermesApi.searchWiki({
        question,
        path: activeWikiId,
        limit: 8,
        includeJournal: wikiIncludeJournal,
        includeRaw: wikiIncludeRaw,
      });
      const searchData = obj(searchPayload, 'data');
      const sources = arr(searchPayload, 'results', 'sources', 'citations').length
        ? arr(searchPayload, 'results', 'sources', 'citations')
        : arr(searchData, 'results', 'sources', 'citations');
      setWikiAnswerSources(sources);
      setWikiAnswerMeta({ provider: 'railway-hermes', agent: 'wiki-curator', model: 'wiki-curator', source: 'stream', gatewayFallback: false });

      const response = await hermesApi.streamChat({
        message: wikiStreamCommand(question, sources),
        view: 'wiki',
        agent: 'wiki-curator',
        agentId: 'wiki-curator',
        model: 'wiki-curator',
        mode: 'wiki_qa_fast',
      });
      if (!response.ok || !response.body) throw new Error(`wiki stream ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedAnswer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const event = block.split('\n').find((line) => line.startsWith('event:'))?.replace(/^event:\s*/, '').trim() || '';
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n').trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as { text?: string; error?: string; gatewayFallback?: boolean; source?: string; run?: { model?: string; agent?: string } };
            if (parsed.gatewayFallback !== undefined || parsed.source || parsed.run?.model) {
              setWikiAnswerMeta((current) => ({
                ...current,
                gatewayFallback: parsed.gatewayFallback ?? current.gatewayFallback,
                source: parsed.source || text(current.source, 'stream'),
                model: parsed.run?.model || text(current.model, 'wiki-curator'),
              }));
            }
            if (parsed.error) throw new Error(parsed.error);
            if (event === 'delta' && parsed.text) {
              streamedAnswer += parsed.text;
              setWikiAnswer(streamedAnswer);
            }
            if (event === 'done' && parsed.text) {
              streamedAnswer = parsed.text;
              setWikiAnswer(streamedAnswer);
            }
          } catch (parseError) {
            if (parseError instanceof Error && parseError.message) throw parseError;
          }
        }
      }
      if (!streamedAnswer.trim()) setWikiAnswer('위키 큐레이터 답변 본문이 비어 있습니다.');
    } catch (error) {
      setWikiAnswer(error instanceof Error ? `위키 답변 실패: ${error.message}` : '위키 답변 실패');
    } finally {
      setWikiAsking(false);
    }
  }

  function dismissWikiAnswer() {
    setWikiQuestion('');
    setWikiAnswer('');
    setWikiAnswerSources([]);
    setWikiAnswerMeta({});
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
    if (!value) return false;
    try {
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
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '목표 저장 실패');
      return false;
    }
  }

  async function saveDocument(body: Record<string, unknown>) {
    const payload = await hermesApi.createDocument({
      ...body,
      date: text(body.date, todayKey()),
      source: text(body.source, 'hermes-desktop'),
      });
    const doc = createdDocumentFrom(payload);
    const docId = persistedDocumentIdentity(doc);
    if (!docId) throw new Error('문서 저장 응답이 비어 있습니다.');
    setActiveNoteId(docId);
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
    const previousInbox = state.inbox;
    setState((current) => ({
      ...current,
      inbox: current.inbox.map((item, index) => itemId(item, `mail-${index}`) === id ? { ...item, actionStatus: '기본함에 추가됨' } : item),
    }));
    try {
      await hermesApi.runInboxCommand(id, 'task', { message: itemTitle(mail, '메일 작업') });
      await hydrate();
    } catch (error) {
      setState((current) => ({ ...current, inbox: previousInbox }));
      setApiError(error instanceof Error ? error.message : '메일 작업 추가 실패');
    }
  }

  async function archiveMail(mail: Item) {
    const id = itemId(mail, '');
    if (!id) return;
    const previousInbox = state.inbox;
    const previousActiveMailId = activeMailId;
    setState((current) => ({ ...current, inbox: current.inbox.filter((item, index) => itemId(item, `mail-${index}`) !== id) }));
    setActiveMailId('');
    try {
      await hermesApi.runInboxCommand(id, 'archive');
      await hydrate();
    } catch (error) {
      setState((current) => ({ ...current, inbox: previousInbox }));
      setActiveMailId(previousActiveMailId);
      setApiError(error instanceof Error ? error.message : '메일 보관 실패');
    }
  }

  async function toggleMailStar(mail: Item) {
    const id = itemId(mail, '');
    if (!id) return;
    const next = !(mail.star || mail.starred || mail.important);
    const previousInbox = state.inbox;
    setState((current) => ({
      ...current,
      inbox: current.inbox.map((item, index) => {
        const itemKey = itemId(item, `mail-${index}`);
        if (itemKey !== id) return item;
        return { ...item, star: next, starred: next, important: next };
      }),
    }));
    try {
      await hermesApi.runInboxCommand(id, next ? 'star' : 'unstar');
      await hydrate();
    } catch (error) {
      setState((current) => ({ ...current, inbox: previousInbox }));
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
      const syncedCount = synced.imported ?? synced.count ?? synced.total;
      const hasSyncedCount = syncedCount !== undefined && syncedCount !== null && syncedCount !== '';
      if (!syncedItems.length && !hasSyncedCount) throw new Error('Gmail 동기화 응답이 비어 있습니다.');
      if (syncedItems.length) {
        setState((current) => ({ ...current, inbox: syncedItems }));
        setActiveMailId(itemId(syncedItems[0], ''));
      }
      setGmailPassword('');
      setMailStatus(`Gmail 동기화 완료 · ${syncedItems.length || text(syncedCount, '0')}개`);
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
        body: `🤖 ${text(run.agent, 'Agent Calendar')} 실행 결과\n\n[목표]\n${text(run.goal || run.title, title)}\n\n[상태]\n${text(run.status, 'running')} · ${text(run.step, '실행 타임라인을 확인하세요.')}`,
        tag: '업무',
        kind: 'doc',
        source: 'hermes-desktop-run-artifact',
        runId,
      });
      const doc = createdDocumentFrom(payload);
      const docId = persistedDocumentIdentity(doc);
      if (!docId) throw new Error('실행 결과 문서를 찾을 수 없습니다.');
      setActiveWikiId(docId);
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
    const previousRuns = state.runs;
    approvedRunIdsRef.current.add(id);
    setState((current) => ({
      ...current,
      runs: current.runs.filter((item, index) => itemId(item, `run-${index}`) !== id),
    }));
    try {
      await hermesApi.approveRun(id);
      await hydrate();
    } catch (error) {
      const message = error instanceof Error ? error.message : '실행 승인 실패';
      if (/404/.test(message)) {
        setApiError('');
        return;
      }
      approvedRunIdsRef.current.delete(id);
      setState((current) => ({ ...current, runs: previousRuns }));
      setApiError(message);
    }
  }

  async function updatePrefs(nextPrefs: UiPreferences) {
    const previousPrefs = prefs;
    setPrefs(nextPrefs);
    setSettings((current) => ({ ...current, uiPreferences: nextPrefs }));
    try {
      const payload = await hermesApi.saveSettings({ uiPreferences: nextPrefs });
      const directPrefs = obj(payload, 'uiPreferences');
      const nestedPrefs = obj(obj(payload, 'settings'), 'uiPreferences');
      if (Object.keys(directPrefs).length || Object.keys(nestedPrefs).length) {
        const updated = settingsPreferences(payload);
        setPrefs(updated);
        setSettings((current) => ({ ...current, uiPreferences: updated }));
      }
    } catch (error) {
      setPrefs(previousPrefs);
      setSettings((current) => ({ ...current, uiPreferences: previousPrefs }));
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
      id: item.recordId || `taxonomy-${item.kind}-${slugify(item.id || item.label)}`,
      title: `__agents_calendar_${item.kind}:${item.label}`,
      label: item.label,
      name: item.label,
      slug: item.id,
      icon: item.icon,
      group: item.group,
      kind: 'taxonomy',
      type: 'taxonomy',
      taxonomyKind: item.kind,
      source: TAXONOMY_SOURCE,
      project: 'Agent Calendar Metadata',
      status: hidden ? 'Hidden' : 'Active',
      tags: ['hermes-meta'],
      hidden,
      notes: JSON.stringify(payload),
    };
  }

  function applyOptimisticTaxonomy(item: TaxonomyItem, hidden = false) {
    const record = taxonomyPayload(item, hidden);
    const targetKey = `${item.kind}:${slugify(item.id || item.label)}`;
    setState((current) => ({
      ...current,
      taxonomy: [
        ...current.taxonomy.filter((entry) => {
          const parsed = parseTaxonomyRecord(entry);
          if (!parsed) return true;
          if (item.recordId && parsed.recordId === item.recordId) return false;
          return `${parsed.kind}:${slugify(parsed.id || parsed.label)}` !== targetKey;
        }),
        record,
      ],
    }));
  }

  async function updateTaxonomy(item: TaxonomyItem) {
    let response: ApiEnvelope;
    if (item.recordId && shouldPersistTask(item.recordId)) {
      response = await hermesApi.updateTask(item.recordId, taxonomyPayload(item));
    } else {
      response = await hermesApi.createTask(taxonomyPayload(item));
    }
    if (!taxonomyIdentity(savedTaxonomyFrom(response))) {
      const visible = await waitForSavedTaxonomyInBackend(item);
      if (!visible) throw new Error('리스트/태그 저장 응답이 비어 있습니다.');
    }
    await hydrate();
  }

  async function hideTaxonomy(item: TaxonomyItem) {
    const hiddenItem = { ...item, hidden: true };
    const previousTaxonomy = state.taxonomy;
    const previousScreen = screen;
    const previousActiveNavKey = activeNavKey;
    openScreen('tasks');
    applyOptimisticTaxonomy(hiddenItem, true);
    try {
      if (item.recordId && shouldPersistTask(item.recordId)) {
        await hermesApi.updateTask(item.recordId, taxonomyPayload(hiddenItem, true));
      } else {
        await hermesApi.createTask(taxonomyPayload(hiddenItem, true));
      }
      await hydrate();
    } catch (error) {
      setState((current) => ({ ...current, taxonomy: previousTaxonomy }));
      setScreen(previousScreen);
      setActiveNavKey(previousActiveNavKey);
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
    const previousTaxonomy = state.taxonomy;
    openScreen('tasks', taxonomyNavKey(item.kind, item.id));
    applyOptimisticTaxonomy(item);
    try {
      await updateTaxonomy(item);
      setModal(null);
      setTaxonomyForm(null);
      setTaxonomyName('');
      setTaxonomyGroupName('');
      setTaxonomyIcon('');
    } catch (error) {
      setState((current) => ({ ...current, taxonomy: previousTaxonomy }));
      setModal('taxonomy');
      setApiError(error instanceof Error ? error.message : '리스트/태그 저장 실패');
    }
  }

  function listForValue(value: string) {
    return listDefinitions.find((entry) => slugify(entry.id) === slugify(value) || slugify(entry.label) === slugify(value));
  }

  function activeListForNewTask(useDraftList = true) {
    if (activeNavKey.startsWith('list:') && activeNavKey !== 'list:notes' && activeNavKey !== 'list:someday') {
      return findTaxonomy('list', activeNavKey);
    }
    if (!useDraftList) return undefined;
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
  const diaryDocs = useMemo(() => {
    return mergeDocsByIdentity(state.docs, wikiJournalDocs(state.wiki));
  }, [state.docs, state.wiki]);
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
        console.warn('Agent Calendar widget snapshot save failed', error);
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [apiError, events, loading, runs, tasks]);

  useEffect(() => {
    if (isWidgetOverlay) return;
    if (!window.hermesDesktop?.readWidgetActions) return;
    const timer = setInterval(() => {
      void drainWidgetActions();
    }, 1200);
    const dispose = window.hermesDesktop.onWidgetActionsAvailable?.(() => {
      void drainWidgetActions();
    });
    void drainWidgetActions();
    return () => {
      clearInterval(timer);
      dispose?.();
    };
  }, [events, isWidgetOverlay, loading, runs, tasks]);

  useEffect(() => {
    if (!completionNotice) return undefined;
    const timer = window.setTimeout(() => setCompletionNotice(null), 4600);
    return () => window.clearTimeout(timer);
  }, [completionNotice]);

  if (isWidgetOverlay) {
    return (
      <div className="app-root widget-overlay-root" data-theme={settings.theme}>
        {loading ? <Loading /> : <WidgetsScreen tasks={tasks} events={events} runs={runs} />}
      </div>
    );
  }

  return (
    <div className="app-root" data-theme={settings.theme}>
      <aside className="sidebar">
        <div className="brand">
          <LogoMark />
          <div>
            <div className="brand-title">Agent Calendar</div>
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
          {settings.authProfile?.picture ? <img className="avatar" src={settings.authProfile.picture} alt="" /> : <span className="avatar">{accountInitial}</span>}
          <span><strong>{accountName}</strong><small>{apiError ? 'Railway 확인 필요' : accountProviderLabel}</small></span>
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
            {screen === 'today' && <TodayScreen tasks={tasks} runs={runs} approveRun={approveRun} quickText={quickText} setQuickText={setQuickText} submitQuick={() => submitQuick(todayKey())} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} openRun={openRun} />}
            {screen === 'tasks' && selectedTaxonomy && <TaxonomyManager item={selectedTaxonomy} edit={(item) => openTaxonomyForm(item.kind, item.group, item)} hide={(item) => void hideTaxonomy(item)} />}
            {(screen === 'tasks' || screen === 'next7' || screen === 'someday') && <TaskListScreen tasks={filteredTasks} quickText={quickText} setQuickText={setQuickText} submitQuick={() => submitQuick(screen === 'next7' ? todayKey() : undefined)} applyRepeatTemplate={(label) => {
              const templates: Record<string, string> = { '매일 루틴': '매일 ', '매주 회의': '매주 ', '매월 정산': '매월 ', '평일 근무': '근무 평일 ' };
              setQuickText(templates[label] || '');
            }} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} />}
            {screen === 'kanban' && <KanbanScreen tasks={filteredTasks} openTask={openTask} />}
            {screen === 'mail' && <MailScreen inbox={mailItems} activeMailId={activeMailId} setActiveMailId={setActiveMailId} addTaskFromMail={(mail) => { void addTaskFromMail(mail); }} archiveMail={(mail) => { void archiveMail(mail); }} delegateMail={(mail, reply) => { setDelegateText(reply ? `아래 메일에 대한 정중한 답장 초안을 작성해줘.\n\n${itemTitle(mail, '메일')}` : `다음 메일을 처리해줘.\n\n${itemTitle(mail, '메일')}`); setModal('delegate'); }} toggleStar={(mail) => { void toggleMailStar(mail); }} gmailEmail={gmailEmail} setGmailEmail={setGmailEmail} gmailPassword={gmailPassword} setGmailPassword={setGmailPassword} mailSyncing={mailSyncing} mailStatus={mailStatus} connectGmail={connectGmail} />}
            {screen === 'notes' && <NotesScreen docs={docs} activeNoteId={activeNoteId} setActiveNoteId={setActiveNoteId} newNote={createNote} />}
            {screen === 'review' && <ReviewScreen tasks={tasks} patchTask={patchTask} generateRetroDraft={generateRetroDraft} createReviewGoal={createReviewGoal} saveRetro={saveRetro} />}
            {screen === 'wiki' && <WikiScreen wiki={state.wiki} docs={docs} activeWikiId={activeWikiId} setActiveWikiId={setActiveWikiId} readerOpen={wikiReaderOpen} setReaderOpen={setWikiReaderOpen} question={wikiQuestion} setQuestion={setWikiQuestion} answer={wikiAnswer} sources={wikiAnswerSources} answerMeta={wikiAnswerMeta} includeJournal={wikiIncludeJournal} setIncludeJournal={setWikiIncludeJournal} includeRaw={wikiIncludeRaw} setIncludeRaw={setWikiIncludeRaw} asking={wikiAsking} ask={askWiki} dismissAnswer={dismissWikiAnswer} />}
            {screen === 'diary' && <DiaryScreen docs={diaryDocs} diaryText={diaryText} setDiaryText={setDiaryText} diaryMood={diaryMood} setDiaryMood={setDiaryMood} saveDiary={saveDiary} />}
            {screen === 'search' && <SearchScreen query={query} setQuery={setQuery} tasks={tasks} docs={docs} openTask={openTask} openDoc={openDoc} />}
            {screen === 'agents' && <AgentsScreen agents={agents} runs={runs} missionText={missionText} setMissionText={setMissionText} selectedAgentId={selectedAgentId} setSelectedAgentId={setSelectedAgentId} startPlan={() => startPlan(missionText)} openModal={setModal} openRun={openRun} />}
            {screen === 'widgets' && <WidgetsScreen tasks={tasks} events={events} runs={runs} />}
            {screen === 'settings' && <SettingsScreen settings={settings} setSettings={setSettings} refresh={hydrate} />}
            {screen === 'login' && <LoginScreen email={loginEmail} setEmail={setLoginEmail} password={loginPw} setPassword={setLoginPw} loginWithProvider={loginWithProvider} authBusyProvider={authBusyProvider} passwordAuthBusy={passwordAuthBusy} loginStatus={loginStatus} authenticateWithPassword={authenticateWithPassword} />}
          </section>
        )}
      </main>

      <button className="chat-fab" data-active={chatOpen} onClick={() => setChatOpen((open) => !open)} aria-label={chatOpen ? 'Agent Calendar 콘솔 닫기' : 'Agent Calendar 콘솔 열기'} title="Agent Calendar 콘솔">
        <ChatIcon />
      </button>
      {completionNotice && <CompletionToast title={completionNotice.title} undo={undoCompletion} close={() => setCompletionNotice(null)} />}
      {chatOpen && <ChatDrawer messages={chatMessages} input={chatInput} setInput={setChatInput} send={sendChat} runs={runs} setChip={setChatInput} close={() => setChatOpen(false)} openRun={openRun} />}
      {modal === 'taxonomy' && taxonomyForm && <TaxonomyModal form={taxonomyForm} name={taxonomyName} setName={setTaxonomyName} groupName={taxonomyGroupName} setGroupName={setTaxonomyGroupName} icon={taxonomyIcon} setIcon={setTaxonomyIcon} close={() => { setTaxonomyForm(null); setModal(null); }} submit={() => void createTaxonomy()} />}
      <Modal modal={modal} setModal={setModal} newTitle={newTitle} setNewTitle={setNewTitle} newDesc={newDesc} setNewDesc={setNewDesc} newTask={newTaskControls} createTask={createTask} lists={listDefinitions} tags={tagDefinitions} agents={agents} runs={runs} selectedRun={selectedRun} selectedTask={selectedTask} patchTask={patchTask} patchCalendarEvent={patchCalendarEvent} removeTask={removeTask} removeCalendarEvent={removeCalendarEvent} toggleTask={toggleTask} delegateText={delegateText} setDelegateText={setDelegateText} delegateAgentId={delegateAgentId} setDelegateAgentId={setDelegateAgentId} startPlan={() => startPlan(delegateText, delegateAgentId)} openRunArtifact={openRunArtifact} approveRun={approveRun} newAgentName={newAgentName} setNewAgentName={setNewAgentName} newAgentRole={newAgentRole} setNewAgentRole={setNewAgentRole} newAgentEmoji={newAgentEmoji} setNewAgentEmoji={setNewAgentEmoji} createAgent={createAgent} settings={settings} setSettings={setSettings} refresh={hydrate} setApiError={setApiError} loggedIn={loggedIn} setLoggedIn={setLoggedIn} logout={logout} loginEmail={loginEmail} setLoginEmail={setLoginEmail} loginPw={loginPw} setLoginPw={setLoginPw} prefs={prefs} updatePrefs={updatePrefs} />
      {!loggedIn && <LoginOverlay email={loginEmail} setEmail={setLoginEmail} password={loginPw} setPassword={setLoginPw} authenticateWithPassword={authenticateWithPassword} loginWithProvider={loginWithProvider} authBusyProvider={authBusyProvider} passwordAuthBusy={passwordAuthBusy} loginStatus={loginStatus} />}
    </div>
  );
}

function Loading() {
  return <div className="loading"><span />Railway gateway에서 상태를 불러오는 중</div>;
}

function CompletionToast({ title, undo, close }: { title: string; undo: () => void; close: () => void }) {
  return <div className="completion-toast" role="status" aria-live="polite">
    <span>✓</span>
    <strong>작업이 완료되었습니다.</strong>
    <em>{title}</em>
    <button onClick={undo}>되돌리기</button>
    <button className="toast-close" onClick={close} aria-label="완료 알림 닫기">×</button>
  </div>;
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
      <LogoMark />
      <div><strong>Agent Calendar 위젯</strong><span>macOS 데스크톱 위젯 · 알림 센터</span></div>
    </header>
    <div className="widgets-layout">
      <section className="widget-card widget-month" aria-label="월 캘린더 Large 위젯">
        <header><strong>{dateMeta.month}월</strong><span>{dateMeta.year}</span><LogoMark className="widget-logo-mark" /></header>
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
            <p>{nextEvent ? `${formatTime(widgetItemTime(nextEvent))} · ${text(nextEvent.category || nextEvent.project || nextEvent.list, 'Agent Calendar')}` : '시간 지정 일정이 없습니다'}</p>
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
    <div className="quick-row plan-quick"><span>+</span><input value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitQuick(); }} placeholder="오늘 할 일 추가  ·  예: 오후3시 롯데리아 #업무 !높음 @agent" /><button onClick={submitQuick}>추가</button></div>
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
        {reviewRuns.map((run, index) => {
          const runWithId: Item = { ...run, id: itemId(run, `run-${index}`) };
          return <div className="plan-row review-row" role="button" tabIndex={0} key={itemId(runWithId, `run-${index}`)} onClick={() => openRun(runWithId)} onKeyDown={(event) => { if (event.key === 'Enter') openRun(runWithId); }}>
            <i>✦</i><span><b>{itemTitle(runWithId, '에이전트 결과')}</b><small>{text(runWithId['agent'], 'default')} · 완료 · 검토 대기</small></span><button className="approve" onClick={(event) => { event.stopPropagation(); approveRun(runWithId); }}>승인</button>
          </div>;
        })}
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

function TaskListScreen({ tasks, quickText, setQuickText, submitQuick, applyRepeatTemplate, openTask, toggleTask, patchTask }: { tasks: Item[]; quickText: string; setQuickText: (value: string) => void; submitQuick: () => void; applyRepeatTemplate: (label: string) => void; openTask: (task: Item) => void; toggleTask: (task: Item) => void; patchTask: (task: Item, patch: Item) => boolean | Promise<boolean> }) {
  const [inspectorTaskId, setInspectorTaskId] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const inspectorClosed = inspectorTaskId === '__closed__';
  const parsed = quickText ? parseQuick(quickText) : null;
  const active = tasks.filter((task) => !isDone(task));
  const overdue = active.filter((task) => {
    const date = text(task.date);
    return date && date < todayKey();
  });
  const upcoming = active.filter((task) => !overdue.includes(task));
  const completed = tasks.filter(isDone);
  const selectedTask = inspectorClosed ? undefined : tasks.find((task, index) => itemId(task, `task-${index}`) === inspectorTaskId) || active[0] || completed[0];
  const selectedId = itemId(selectedTask || {}, '');
  useEffect(() => {
    if (!inspectorClosed && !selectedTask && tasks.length) setInspectorTaskId(itemId(tasks[0], ''));
  }, [inspectorClosed, selectedTask, tasks]);
  const renderRows = (rows: Item[], prefix: string) => rows.map((task, index) => {
    const id = itemId(task, `${prefix}-${index}`);
    return <TaskRow key={id} task={task} selected={selectedId === id || (!selectedId && index === 0)} selectTask={() => setInspectorTaskId(id)} openTask={openTask} toggleTask={toggleTask} />;
  });
  const toggleSection = (key: string) => setCollapsedSections((current) => ({ ...current, [key]: !current[key] }));
  const postponeOverdue = () => overdue.forEach((task) => patchTask(task, { date: todayKey() }));
  return <div className="list-screen task-list-screen screen-in">
    <section className="task-list-main">
      <div className="quick-row list-quick"><span>+</span><input value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitQuick(); }} placeholder="할 일 추가  ·  예: 내일 오후3시 롯데리아 #업무 !높음 매주 @agent" /><button onClick={submitQuick}>추가</button></div>
      {parsed && quickText.trim() && <div className="quick-preview">{parsed.date && <span>📅 {parsed.date}</span>}{parsed.time && <span>🕑 {parsed.time}</span>}{parsed.repeat !== 'none' && <span>⟳ {parsed.repeat}</span>}{parsed.priority && <span>⚑ {parsed.priority}</span>}{parsed.tags.map((tag) => <span key={tag}>#{tag}</span>)}{parsed.owner === 'Agent' && <span>🤖 에이전트</span>}</div>}
      {!quickText.trim() && <div className="quick-spacer" />}
      <div className="repeat-chips"><span>반복 템플릿</span>{['매일 루틴', '매주 회의', '매월 정산', '평일 근무'].map((label) => <button key={label} onClick={() => applyRepeatTemplate(label)}><span>⟳</span>{label}</button>)}</div>
      {!!overdue.length && <section className="task-section" data-collapsed={!!collapsedSections.overdue}><header><button onClick={() => toggleSection('overdue')}>{collapsedSections.overdue ? '›' : '⌄'}</button><strong>만료됨</strong><span>{overdue.length}</span><button className="postpone" onClick={postponeOverdue}>연기하다</button></header>{!collapsedSections.overdue && <div className="rows task-rows">{renderRows(overdue, 'overdue')}</div>}</section>}
      {!!upcoming.length && <section className="task-section" data-collapsed={!!collapsedSections.upcoming}><header><button onClick={() => toggleSection('upcoming')}>{collapsedSections.upcoming ? '›' : '⌄'}</button><strong>할 일</strong><span>{upcoming.length}</span></header>{!collapsedSections.upcoming && <div className="rows task-rows">{renderRows(upcoming, 'active')}</div>}</section>}
      {!active.length && <div className="task-empty">표시할 작업이 없습니다 · 위에서 추가하세요</div>}
      {!!completed.length && <details className="completed-block"><summary>완료됨 {completed.length}</summary><div className="rows task-rows">{completed.map((task, index) => {
        const id = itemId(task, `done-${index}`);
        return <TaskRow key={id} task={task} selected={selectedId === id} selectTask={() => setInspectorTaskId(id)} openTask={openTask} toggleTask={toggleTask} />;
      })}</div></details>}
    </section>
    <TaskInspectorPane key={selectedId || 'closed'} task={selectedTask} patchTask={patchTask} toggleTask={toggleTask} openTask={openTask} close={() => setInspectorTaskId('__closed__')} />
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

function TaskInspectorPane({ task, patchTask, toggleTask, openTask, close }: { task?: Item; patchTask: (task: Item, patch: Item) => boolean | Promise<boolean>; toggleTask: (task: Item) => void; openTask: (task: Item) => void; close: () => void }) {
  const [toolPanel, setToolPanel] = useState<'subtask' | 'format' | 'comment' | 'more' | null>(null);
  const [subtaskText, setSubtaskText] = useState('');
  const [commentText, setCommentText] = useState('');
  if (!task) return <aside className="task-inspector empty"><div>작업을 선택하세요</div></aside>;
  const tags = taskTags(task);
  const owner = taskOwner(task);
  const notes = text(task.notes || task.description);
  const subtaskMatches = notes.match(/- \[[ xX]\] /g) || [];
  const doneSubtasks = notes.match(/- \[[xX]\] /g) || [];
  const appendNotes = (addition: string) => patchTask(task, { notes: [notes.trim(), addition.trim()].filter(Boolean).join('\n') });
  const addSubtask = async () => {
    const value = subtaskText.trim();
    if (!value) return;
    const updated = await Promise.resolve(appendNotes(`- [ ] ${value}`));
    if (!updated) return;
    setSubtaskText('');
    setToolPanel(null);
  };
  const addComment = async () => {
    const value = commentText.trim();
    if (!value) return;
    const updated = await Promise.resolve(appendNotes(`[댓글] ${value}`));
    if (!updated) return;
    setCommentText('');
    setToolPanel(null);
  };
  return <aside className="task-inspector">
    <header>
      <button className="detail-check" data-done={isDone(task)} onClick={() => toggleTask(task)}>{isDone(task) ? '✓' : ''}</button>
      {text(task.date) ? <span className="inspector-date">📅 {formatDateChip(text(task.date))}</span> : <span className="inspector-date muted">날짜 없음</span>}
      <span />
      <button className="flag" data-active={!!text(task.priority)} onClick={() => patchTask(task, { priority: text(task.priority) ? '' : 'P1' })}>⚑</button>
      <button className="close" onClick={close}>×</button>
    </header>
    <input className="inspector-title" defaultValue={itemTitle(task, '')} onBlur={(event) => patchTask(task, { title: event.target.value })} placeholder="제목 없음" />
    <div className="inspector-meta">
      <button onClick={() => openTask(task)}>전체 편집</button>
      <span>{text(task.category || task.project || task.source || task.list, '기본함')}</span>
      {owner !== 'Me' && <span>{owner}</span>}
      {tags.map((tag) => <span key={tag}>#{tag}</span>)}
    </div>
    <textarea defaultValue={notes} onBlur={(event) => patchTask(task, { notes: event.target.value })} placeholder="메모 추가" />
    <section className="subtask-box">
      <strong>{doneSubtasks.length} / {subtaskMatches.length} 완료된 할일</strong>
      <button onClick={() => setToolPanel(toolPanel === 'subtask' ? null : 'subtask')}>＋ 하위 할일 추가</button>
    </section>
    {toolPanel && <section className="inspector-tool-panel">
      {toolPanel === 'subtask' && <>
        <strong>하위 할일</strong>
        <div><input value={subtaskText} onChange={(event) => setSubtaskText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addSubtask(); }} placeholder="하위 할일 입력" autoFocus /><button onClick={() => void addSubtask()}>추가</button></div>
      </>}
      {toolPanel === 'format' && <>
        <strong>서식 추가</strong>
        <div className="tool-chip-row"><button onClick={() => appendNotes('## 소제목')}>제목</button><button onClick={() => appendNotes('- 항목')}>목록</button><button onClick={() => appendNotes('```\\n코드\\n```')}>코드</button></div>
      </>}
      {toolPanel === 'comment' && <>
        <strong>댓글</strong>
        <div><input value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addComment(); }} placeholder="댓글 입력" autoFocus /><button onClick={() => void addComment()}>남기기</button></div>
      </>}
      {toolPanel === 'more' && <>
        <strong>빠른 작업</strong>
        <div className="tool-chip-row"><button onClick={() => patchTask(task, { date: todayKey() })}>오늘로</button><button onClick={() => patchTask(task, { date: addDaysKey(todayKey(), 1) })}>내일로</button><button onClick={() => patchTask(task, { repeat: text(task.repeat) === 'weekly' ? 'none' : 'weekly' })}>{text(task.repeat) === 'weekly' ? '반복 해제' : '매주 반복'}</button></div>
      </>}
    </section>}
    <footer>
      <span>{formatUpdatedStamp(text(task.updated || task.updatedAt || task.createdAt || task.time))}</span>
      <button data-active={toolPanel === 'format'} onClick={() => setToolPanel(toolPanel === 'format' ? null : 'format')}>A</button>
      <button data-active={toolPanel === 'comment'} onClick={() => setToolPanel(toolPanel === 'comment' ? null : 'comment')}>💬</button>
      <button data-active={toolPanel === 'more'} onClick={() => setToolPanel(toolPanel === 'more' ? null : 'more')}>⋯</button>
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
          const from = text(mail.from || mail.sender || mail.sourceLabel, 'Agent Calendar');
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
          <div><h2>{text(active.subject || active.title, '메일을 선택하세요')}</h2><button aria-label="별표" onClick={() => toggleStar(active)}>{active.star || active.starred || active.important ? '★' : '☆'}</button></div>
          <footer><span className="mail-avatar large">{avatar(active)}</span><span><b>{text(active.from || active.sender || active.sourceLabel, 'Agent Calendar')}</b><small>{text(active.email || active.addr || active.address, 'agents@calendar.local')}</small></span><time>{text(active.time || active.createdAt, '방금')}</time></footer>
        </section>
        <div className="action-row mail-actions">
          <button onClick={() => addTaskFromMail(active)}>⊕ 작업으로 추가</button>
          <button className="delegate" onClick={() => delegateMail(active)}>⚡ 에이전트에 위임</button>
          <button onClick={() => delegateMail(active, true)}>✦ 답장 초안</button>
          <button className="archive" onClick={() => archiveMail(active)}>보관</button>
          {text(active.actionStatus) && <span>{text(active.actionStatus)}</span>}
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

function ReviewScreen({ tasks, patchTask, generateRetroDraft, createReviewGoal, saveRetro }: { tasks: Item[]; patchTask: (task: Item, patch: Item) => void; generateRetroDraft: (summary: { range: string; done: number; total: number; overdue: number; delegated: number; goals: string[] }) => Promise<string>; createReviewGoal: (title: string) => Promise<boolean>; saveRetro: (body: string) => void }) {
  const done = tasks.filter(isDone).length;
  const [goalInput, setGoalInput] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [retro, setRetro] = useState('');
  const range = weekRangeLabel();
  const goals = tasks
    .filter((task) => /goal|objective|목표/i.test(text(task.kind || task.type || task.list || task.category || task.project || (Array.isArray(task.tags) ? task.tags.join(' ') : task.tags))))
    .map((task) => ({ task, text: itemTitle(task, '목표'), done: isDone(task) }));
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
      const created = await createReviewGoal(value);
      if (created) setGoalInput('');
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
      setRetro((current) => current || (error instanceof Error ? `회고 생성 실패: ${error.message}` : '회고 생성 실패'));
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
        {goals.map((goal, index) => <button className="review-goal" data-done={goal.done} key={`${goal.text}-${index}`} onClick={() => patchTask(goal.task, { status: goal.done ? 'Planned' : 'Done', done: !goal.done })}>
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

function wikiList(payload: ApiEnvelope) {
  const index = obj(payload, 'wikiIndex');
  const graph = obj(payload, 'graph');
  const indexGraph = obj(index, 'graph');
  return [
    ...arr(payload, 'notes'),
    ...arr(payload, 'documents'),
    ...arr(index, 'notes'),
    ...arr(index, 'documents'),
    ...arr(graph, 'nodes'),
    ...arr(indexGraph, 'nodes'),
  ];
}

function isJournalDoc(item: Item) {
  const kind = text(item.kind || item.type).toLowerCase();
  const haystack = [
    item.path,
    item.wikiPath,
    item.folder,
    item.group,
    item.category,
    item.tag,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].map((value) => text(value).toLowerCase()).join(' ');
  return kind === 'diary'
    || kind === 'journal'
    || haystack.includes('4_journal')
    || haystack.includes('journal')
    || haystack.includes('diary')
    || itemTitle(item).includes('일기');
}

function wikiJournalDocs(payload: ApiEnvelope) {
  return mergeDocsByIdentity([], wikiList(payload).filter(isJournalDoc));
}

function mergeDocsByIdentity(primary: Item[], secondary: Item[]) {
  const seen = new Set<string>();
  const merged: Item[] = [];
  [...primary, ...secondary].forEach((item, index) => {
    const key = docIdentity(item, `doc-${index}`);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

function wikiBody(item: Item) {
  return text(item.content || item.body || item.markdown || item.summary || item.extract || item.excerpt, '');
}

function stripFrontmatter(value: string) {
  return value.replace(/^---\s*\n[\s\S]*?\n---\s*/u, '').trim();
}

function journalBody(item: Item) {
  return stripFrontmatter(wikiBody(item));
}

function journalDateKey(item: Item, fallback = '') {
  const direct = text(item.date || item.day || item.journalDate, '');
  if (/^\d{4}-\d{2}-\d{2}/.test(direct)) return direct.slice(0, 10);
  const bodyDate = wikiBody(item).match(/^---[\s\S]*?\bdate:\s*['"]?(\d{4}-\d{2}-\d{2})/mu)?.[1];
  if (bodyDate) return bodyDate;
  const pathDate = [
    item.path,
    item.wikiPath,
    item.title,
    item.createdAt,
    item.updatedAt,
  ].map((value) => text(value)).join(' ').match(/(20\d{2})[-_/](\d{2})[-_/](\d{2})/);
  if (pathDate) return `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`;
  const timestamp = text(item.createdAt || item.updatedAt, '');
  if (/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return timestamp.slice(0, 10);
  return fallback;
}

function journalTime(item: Item) {
  const date = journalDateKey(item);
  const timestamp = date ? Date.parse(`${date}T00:00:00`) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
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

function WikiScreen({ wiki, docs, activeWikiId, setActiveWikiId, readerOpen, setReaderOpen, question, setQuestion, answer, sources, answerMeta, includeJournal, setIncludeJournal, includeRaw, setIncludeRaw, asking, ask, dismissAnswer }: { wiki: ApiEnvelope; docs: Item[]; activeWikiId: string; setActiveWikiId: (id: string) => void; readerOpen: boolean; setReaderOpen: (value: boolean) => void; question: string; setQuestion: (value: string) => void; answer: string; sources: Item[]; answerMeta: Item; includeJournal: boolean; setIncludeJournal: (value: boolean) => void; includeRaw: boolean; setIncludeRaw: (value: boolean) => void; asking: boolean; ask: () => void; dismissAnswer: () => void }) {
  const [details, setDetails] = useState<Record<string, Item>>({});
  const [loadingPath, setLoadingPath] = useState('');
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const [graphPanning, setGraphPanning] = useState(false);
  const [treeQuery, setTreeQuery] = useState('');
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
  const treeNeedle = treeQuery.trim().toLowerCase();
  const matchesTreeQuery = (node: Item) => !treeNeedle || [
    itemTitle(node, ''),
    text(node.path || node.wikiPath || node.folder || node.kind),
    wikiBody(node),
  ].join(' ').toLowerCase().includes(treeNeedle);
  const docGroups = folders
    .map((tag) => ({ tag, docs: list.filter((node) => text(node.folder || node.tag || node.category || node.kind, '기타') === tag && matchesTreeQuery(node)) }))
    .filter((group) => group.docs.length);
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
  const engineLabel = text(answerMeta.agent || answerMeta.model || answerMeta.provider, '');
  const fallbackLabel = answerMeta.gatewayFallback === true ? '검색 fallback' : '';
  return <div className="wiki screen-in">
    <div className="askbar"><div><span>H</span><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(); }} placeholder="위키에게 물어보세요 — AI가 쌓인 지식으로 답합니다" /></div><button disabled={asking} onClick={ask}>{asking ? '답변 중' : '질문'}</button></div>
    <div className="wiki-suggest">{suggest.map((item) => <button key={item} onClick={() => setQuestion(item)}>{item}</button>)}</div>
    <div className="wiki-scope">
      <label><input type="checkbox" checked={includeJournal} onChange={(event) => setIncludeJournal(event.target.checked)} /> 일기 포함</label>
      <label><input type="checkbox" checked={includeRaw} onChange={(event) => setIncludeRaw(event.target.checked)} /> raw 포함</label>
    </div>
    {answer && <div className="wiki-answer"><span>H</span><p>{answer}{sources.length > 0 && <small>{sources.slice(0, 3).map((source) => text(source.title || source.path, '참조 문서')).join(' · ')}</small>}{(engineLabel || fallbackLabel) && <small>{[engineLabel, fallbackLabel].filter(Boolean).join(' · ')}</small>}</p><button onClick={dismissAnswer}>✕</button></div>}
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
          <svg className="wiki-graph-svg" viewBox={graphViewBox} preserveAspectRatio="xMidYMid meet" onPointerDown={(event) => {
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
            <g className="wiki-graph-viewport" transform={`translate(${graphPan.x} ${graphPan.y}) scale(${graphZoom})`}>
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
        <label><span>⌕</span><input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="위키 내용 검색" /></label>
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
  const [wikiDetails, setWikiDetails] = useState<Record<string, Item>>({});
  const diarySummaries = useMemo(() => docs.filter(isJournalDoc), [docs]);
  useEffect(() => {
    let cancelled = false;
    const targets = diarySummaries
      .filter((entry, index) => {
        const path = text(entry.path || entry.wikiPath, '');
        const key = docIdentity(entry, `past-${index}`);
        return path && !hasWikiFullBody(entry) && !wikiDetails[key] && !wikiDetails[path];
      })
      .slice(0, 20);
    targets.forEach((entry, index) => {
      const path = text(entry.path || entry.wikiPath, '');
      const key = docIdentity(entry, path || `past-${index}`);
      hermesApi.getWiki({ path })
        .then((payload) => {
          if (cancelled) return;
          const detail = wikiDetail(payload);
          if (!Object.keys(detail).length) return;
          setWikiDetails((current) => current[key] || current[path] ? current : { ...current, [key]: detail, [path]: detail });
        })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [diarySummaries, wikiDetails]);
  const diaryDocs = diarySummaries
    .map((entry, index) => {
      const path = text(entry.path || entry.wikiPath, '');
      const key = docIdentity(entry, path || `past-${index}`);
      return wikiDetails[key] || wikiDetails[path] ? { ...entry, ...(wikiDetails[key] || wikiDetails[path]) } : entry;
    })
    .sort((a, b) => journalTime(b) - journalTime(a));
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
          const body = journalBody(entry) || '기록된 일기';
          const mood = body.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u)?.[0] || '📔';
          const dateKey = journalDateKey(entry, addDaysKey(todayKey(), -index - 1));
          const day = dateKey.slice(-2);
          return <button key={itemId(entry, `past-${index}`)} onClick={() => setDiaryText(body.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, ''))}>
            <i>{mood}</i><span><b>{Number(day) || index + 1}</b><small>{formatDateChip(dateKey)}</small><em>{body.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, '').slice(0, 72)}</em></span>
          </button>;
        })}
      </div>
    </aside>
  </div>;
}

function SearchScreen({ query, setQuery, tasks, docs, openTask, openDoc }: { query: string; setQuery: (value: string) => void; tasks: Item[]; docs: Item[]; openTask: (task: Item) => void; openDoc: (doc: Item) => void }) {
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
    { title: '노트 · 위키', icon: '📄', rows: docRows, meta: (item: Item) => text(item.date || item.updated || item.tag, '문서'), onOpen: openDoc },
  ].filter((group) => group.rows.length);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return <div className="search-screen screen-in">
    <label className="search-input"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색어 입력" autoFocus /></label>
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
  const selectableAgents = agents.filter(isAgentSelectable);
  const currentAgentNames = new Set(agents.flatMap((agent) => [
    agentDisplayName(agent),
    text(agent.hermesProfileName || agentProfileName(agent)),
    text(agent.name),
    text(agent.id),
  ].filter(Boolean)));
  const visibleRuns = runs.filter((run) => currentAgentNames.has(text(run.agent)));
  return <div className="agents screen-in">
    <section className="mission">
      <header><div>H</div><strong>새 미션 위임</strong><span>목표를 적으면 에이전트가 계획을 세웁니다</span></header>
      <textarea value={missionText} onChange={(event) => setMissionText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) startPlan(); }} placeholder="예: UniPort 경쟁사 3곳을 리서치해서 비교표로 위키에 정리해줘" />
      <footer>
        <b>담당</b>
        {selectableAgents.slice(0, 4).map((agent, index) => {
          const id = itemId(agent, `agent-${index}`);
          return <button className="agent-chip" data-active={selectedAgentId === id} key={id} onClick={() => setSelectedAgentId(id)}>{agentEmoji(agent)} {agentDisplayName(agent)}</button>;
        })}
        <span />
        <button className="primary" onClick={startPlan}>계획 세우기 →</button>
      </footer>
      <div className="mission-examples">{examples.map((example) => <button key={example} onClick={() => setMissionText(example)}>{example}</button>)}</div>
    </section>
    <div className="agents-heading"><strong>에이전트</strong><button onClick={() => openModal('agent')}>+ 새 에이전트</button></div>
    <div className="agent-grid">{agents.map((agent, index) => {
    const id = itemId(agent, `agent-${index}`);
    const name = agentDisplayName(agent);
    const profileName = text(agent.hermesProfileName || agentProfileName(agent), name);
    const activeCount = runs.filter((run) => [name, profileName, text(agent.name), text(agent.id)].includes(text(run.agent)) && !/done|완료/i.test(text(run.status))).length;
    const doneCount = runs.filter((run) => [name, profileName, text(agent.name), text(agent.id)].includes(text(run.agent)) && /done|완료/i.test(text(run.status))).length;
    const selectable = isAgentSelectable(agent);
    return <article className="agent-card" data-active={selectedAgentId === id} data-selectable={selectable} key={id} onClick={() => { if (selectable) setSelectedAgentId(id); }}>
      <header><div className="agent-avatar">{agentEmoji(agent)}</div><span><h3>{name}</h3><small>{text(agent.model, 'Agent Calendar')}</small></span><em>{agentStatusLabel(agent)}</em></header>
      <p>{text(agent.role || agent.persona, '리서치·문서 — 자료 정리, 위키 작성, 분석을 담당.')}</p>
      <footer><span><small>진행 중</small><b>{activeCount}</b></span><span><small>완료</small><b>{doneCount}</b></span><i /><button disabled={!selectable} onClick={(event) => { event.stopPropagation(); if (selectable) setSelectedAgentId(id); }}>{selectable ? '선택' : '설정 필요'}</button></footer>
    </article>;
  })}</div>
    <section className="agent-runs"><h2>실행 / 검토</h2>{visibleRuns.slice(0, 6).map((run, index) => {
      const pct = /done|완료/i.test(text(run.status)) ? 100 : Number(run.pct || run.progress || 62);
      return <button className="run-row" key={itemId(run, `run-${index}`)} onClick={() => openRun(run)}>
        <header><span>{/done|완료/i.test(text(run.status)) ? '완료' : '진행'}</span><b>{text(run.title || run.goal, 'Agent Calendar 실행')}</b><small>{text(run.agent, 'default')}</small></header>
        <div><i style={{ width: `${pct}%` }} /></div>
        <footer><span>{text(run.step, '컨텍스트 수집 중')}</span>{text(run.artifact || run.document) && <em>📄 {text(run.artifact || run.document)}</em>}</footer>
      </button>;
    })}{!visibleRuns.length && <div className="plan-empty">아직 실행한 미션이 없습니다 · 위에서 목표를 위임해보세요</div>}</section>
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

function LoginScreen({ email, setEmail, password, setPassword, loginWithProvider, authBusyProvider, passwordAuthBusy, loginStatus, authenticateWithPassword }: { email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; loginWithProvider: (provider: AuthProvider) => void; authBusyProvider: AuthProvider | null; passwordAuthBusy: boolean; loginStatus: string; authenticateWithPassword: (mode: 'login' | 'signup') => void }) {
  return <AgentCalendarLoginExperience mode="page" email={email} setEmail={setEmail} password={password} setPassword={setPassword} authenticateWithPassword={authenticateWithPassword} loginWithProvider={loginWithProvider} authBusyProvider={authBusyProvider} passwordAuthBusy={passwordAuthBusy} loginStatus={loginStatus} />;
}

function LoginOverlay({ email, setEmail, password, setPassword, authenticateWithPassword, loginWithProvider, authBusyProvider, passwordAuthBusy, loginStatus }: { email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; authenticateWithPassword: (mode: 'login' | 'signup') => void; loginWithProvider: (provider: AuthProvider) => void; authBusyProvider: AuthProvider | null; passwordAuthBusy: boolean; loginStatus: string }) {
  return <AgentCalendarLoginExperience mode="overlay" email={email} setEmail={setEmail} password={password} setPassword={setPassword} authenticateWithPassword={authenticateWithPassword} loginWithProvider={loginWithProvider} authBusyProvider={authBusyProvider} passwordAuthBusy={passwordAuthBusy} loginStatus={loginStatus} />;
}

function AgentCalendarLoginExperience({ mode, email, setEmail, password, setPassword, authenticateWithPassword, loginWithProvider, authBusyProvider, passwordAuthBusy, loginStatus }: { mode: 'overlay' | 'page'; email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; authenticateWithPassword: (mode: 'login' | 'signup') => void; loginWithProvider: (provider: AuthProvider) => void; authBusyProvider: AuthProvider | null; passwordAuthBusy: boolean; loginStatus: string }) {
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [recoverySent, setRecoverySent] = useState(false);
  const googleBusy = authBusyProvider === 'google';
  const passwordLabel = authMode === 'signup' ? '계정 만들기' : '로그인';
  return <div className={mode === 'overlay' ? 'login-overlay' : 'login screen-in'}>
    <section className="login-card">
      <aside className="login-splash" aria-label="Agent Calendar splash">
        <div className="splash-orbit" aria-hidden="true">
          <SystemIcon name="orbit" className="splash-orbit-icon" />
          <span className="orbit-node large" />
          <span className="orbit-node medium" />
          <span className="orbit-node small" />
          <span className="orbit-center"><LogoMark className="orbit-logo" /></span>
        </div>
        <span className="splash-kicker">Agent Calendar</span>
        <h1>일은 나눠서,<br />하루는 한눈에.</h1>
        <p>할 일을 에이전트에게 넘기고, 진행과 결과를 같은 캘린더에서 받아보세요.</p>
      </aside>

      <form className="login-form" onSubmit={(event) => { event.preventDefault(); authenticateWithPassword(authMode); }}>
        <div className="login-form-brand">
          <LogoMark className="login-brand-mark" />
          <span><strong>Agent Calendar</strong><small>에이전트 캘린더</small></span>
        </div>
        <h2>{authMode === 'signup' ? '계정을 만들어 시작하세요' : '다시 만나서 반가워요'}</h2>
        <p>{authMode === 'signup' ? '이메일과 비밀번호로 Agent Calendar 계정을 만드세요' : '계정으로 로그인하고 이어서 계획하세요'}</p>

        <label htmlFor="hermes-login-email">이메일</label>
        <div className="login-field">
          <SystemIcon name="mail" />
          <input id="hermes-login-email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" type="email" />
        </div>

        <label htmlFor="hermes-login-password">비밀번호</label>
        <div className="login-field">
          <SystemIcon name="key" />
          <input id="hermes-login-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="••••••••" />
        </div>

        <div className="login-options">
          <label><input type="checkbox" defaultChecked />로그인 상태 유지</label>
          <button type="button" onClick={() => setRecoverySent(true)}>비밀번호를 잊으셨나요?</button>
        </div>
        {recoverySent && <div className="login-recovery">복구 링크 안내를 준비했습니다. 저장된 계정 메일을 확인하세요.</div>}
        {loginStatus && <div className="login-status" role="status">{loginStatus}</div>}
        <button className="primary login-submit" type="submit" disabled={passwordAuthBusy}><SystemIcon name="check" />{passwordAuthBusy ? '처리 중' : passwordLabel}</button>
        <button className="login-mode-toggle" type="button" onClick={() => setAuthMode(authMode === 'signup' ? 'login' : 'signup')}>
          {authMode === 'signup' ? '이미 계정이 있나요? 로그인' : '계정이 없나요? 회원가입'}
        </button>
        <div className="login-divider"><span />또는<span /></div>
        <div className="social-row">
          <button type="button" onClick={() => loginWithProvider('google')} disabled={Boolean(authBusyProvider)}><SystemIcon name="google" />{googleBusy ? 'Google 로그인 중' : 'Google로 계속하기'}</button>
        </div>
      </form>
    </section>
  </div>;
}

function ChatDrawer({ messages, input, setInput, send, runs, setChip, close, openRun }: { messages: Array<{ role: string; text: string }>; input: string; setInput: (value: string) => void; send: () => Promise<void>; runs: Item[]; setChip: (value: string) => void; close: () => void; openRun: (run?: Item) => void }) {
  return <aside className="chat">
    <header><LogoMark className="chat-mark" /><div><strong>Agent Calendar 콘솔</strong><span>Railway stream</span></div><button onClick={close} aria-label="Agent Calendar 콘솔 닫기">✕</button></header>
    <div className="chat-runs">{runs.slice(0, 2).map((run, index) => <button className="chat-run-card" key={itemId(run, `chat-run-${index}`)} onClick={() => openRun(run)}><b>{text(run.goal || run.title, 'Run')}</b><span>{text(run.status, 'running')} · {text(run.agent, 'default')}</span></button>)}</div>
    <div className="messages">{messages.map((message, index) => <div className={`message ${message.role}`} key={index}>{message.text || '응답 수신 중...'}</div>)}</div>
    <div className="chat-chips">{['오늘 할 일 정리해줘', 'UniPort 백로그 분배', '이번 주 회의 잡아줘'].map((chip) => <button key={chip} onClick={() => setChip(chip)}>{chip}</button>)}</div>
    <footer><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Agent Calendar에게 작업 위임" /><button onClick={() => void send()}>전송</button></footer>
  </aside>;
}

function TaskDetailModal({ selectedTask, lists, patchTask, patchCalendarEvent, removeTask, removeCalendarEvent, toggleTask, close, delegate }: { selectedTask: Item; lists: TaxonomyItem[]; patchTask: (task: Item, patch: Item) => boolean | Promise<boolean>; patchCalendarEvent: (task: Item, patch: Item) => boolean | Promise<boolean>; removeTask: (task: Item) => boolean | Promise<boolean>; removeCalendarEvent: (task: Item) => boolean | Promise<boolean>; toggleTask: (task: Item) => void; close: () => void; delegate: () => void }) {
  const isEvent = isCalendarEventRecord(selectedTask);
  const selectedId = itemId(selectedTask, '');
  const [completionOverride, setCompletionOverride] = useState<{ id: string; done: boolean } | null>(null);
  const [completionPulse, setCompletionPulse] = useState(false);
  const detailTask = completionOverride?.id === selectedId
    ? { ...selectedTask, status: completionOverride.done ? 'Done' : 'Planned', done: completionOverride.done }
    : selectedTask;
  const patchItem = isEvent ? patchCalendarEvent : patchTask;
  const removeItem = isEvent ? removeCalendarEvent : removeTask;
  const calendar = calendarMetadata(detailTask);
  const startDate = text(detailTask.date || detailTask.startDate || detailTask.day, '');
  const startTime = text(detailTask.time || detailTask.t);
  const endDate = calendar.endDate || startDate;
  const endTime = calendar.endTime;
  const hasDuration = Boolean(endTime || (calendar.endDate && calendar.endDate !== startDate));
  const [dateOpen, setDateOpen] = useState(false);
  const [dateMode, setDateMode] = useState<'date' | 'duration'>(() => (hasDuration ? 'duration' : 'date'));
  const [durationDraft, setDurationDraft] = useState({ date: startDate, time: startTime, endDate, endTime });
  const [listOpen, setListOpen] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const [toolPanel, setToolPanel] = useState<'format' | 'comment' | 'more' | null>(null);
  const [commentText, setCommentText] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const repeat = calendar.repeat || text(detailTask.repeat, 'none');
  const allDay = calendar.allDay;
  const reminder = text(detailTask.reminder || detailTask.reminderAt);
  const [reminderOn, setReminderOn] = useState(!!reminder);
  const listOptions = lists.length ? lists : [{ id: 'inbox', label: '기본함', icon: '📥', group: '리스트', kind: 'list' as TaxonomyKind }];
  const currentList = slugify(taskListName(detailTask) || '기본함');
  const activeList = listOptions.find((option) => currentList === slugify(option.label) || currentList === slugify(option.id)) || listOptions[0];
  const filteredLists = listOptions.filter((option) => {
    const query = listQuery.trim().toLowerCase();
    if (!query) return true;
    return `${option.label} ${option.group} ${option.id}`.toLowerCase().includes(query);
  });
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
    if (!startDate) return '날짜 없음';
    const date = new Date(`${startDate}T00:00:00`);
    const dayText = Number.isNaN(date.getTime()) ? startDate : `${date.getMonth() + 1}월 ${date.getDate()}일`;
    const prefix = startDate === todayKey() ? '오늘, ' : '';
    const timeText = allDay ? '' : startTime ? `, ${formatTime(startTime)}${endTime ? ` - ${formatTime(endTime)}` : ''}` : '';
    return `${prefix}${dayText}${timeText}`;
  })();
  const patchDate = (value: string) => patchItem(detailTask, { date: value, startDate: value });
  const patchTime = (value: string) => patchItem(detailTask, { time: value });
  const patchEnd = (patch: Item) => (isEvent ? patchCalendarEvent(detailTask, patch) : patchTask(detailTask, patch));
  const clearDate = () => {
    setDurationDraft({ date: '', time: '', endDate: '', endTime: '' });
    patchItem(detailTask, { date: '', startDate: '', time: '', endDate: '', endTime: '', repeat: 'none', allDay: false });
  };
  const commitDurationDraft = (patch: Partial<typeof durationDraft> = {}) => {
    const next = { ...durationDraft, ...patch };
    setDurationDraft(next);
    patchItem(detailTask, { date: next.date, startDate: next.date, time: next.time, endDate: next.endDate, endTime: next.endTime });
  };
  const notes = plainCalendarNotes(detailTask);
  const appendDetailNotes = (addition: string) => patchItem(detailTask, { notes: [notes.trim(), addition.trim()].filter(Boolean).join('\n') });
  const addDetailComment = async () => {
    const value = commentText.trim();
    if (!value) return;
    const ok = await Promise.resolve(appendDetailNotes(`[댓글] ${value}`));
    if (!ok) return;
    setCommentText('');
    setToolPanel(null);
  };
  const toggleReminder = async () => {
    const next = !reminderOn;
    const ok = await Promise.resolve(patchEnd({ reminder: next ? 'at_time' : '', reminderAt: next ? 'at_time' : '' }));
    if (ok) setReminderOn(next);
  };
  const toggleDetailCompletion = async () => {
    const done = !isDone(detailTask);
    if (isEvent) {
      setCompletionOverride(selectedId ? { id: selectedId, done } : null);
      setCompletionPulse(true);
      const ok = await Promise.resolve(patchCalendarEvent(detailTask, { status: done ? 'Done' : 'Planned', done }));
      setCompletionPulse(false);
      if (!ok) setCompletionOverride(null);
      return;
    }
    toggleTask(detailTask);
  };
  const applyDatePreset = (kind: 'today' | 'tomorrow' | 'nextWeek' | 'evening') => {
    const preset = quickDatePreset(kind, startDate);
    setPickerMonth(new Date(`${preset.date}T00:00:00`));
    patchItem(detailTask, {
      date: preset.date,
      startDate: preset.date,
      time: preset.time || (kind === 'evening' ? '18:00' : ''),
      allDay: kind !== 'evening',
    });
  };
  const shiftPickerMonth = (amount: number) => setPickerMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  const openDateEditor = () => {
    setDateMode(hasDuration ? 'duration' : 'date');
    setDateOpen((open) => !open);
  };
  const confirmDateEditor = () => {
    if (dateMode === 'duration') commitDurationDraft();
    setDateOpen(false);
  };
  const closeDetailFloaters = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.detail-date-popover, .detail-date-trigger, .detail-list-popover, .detail-list-pill, .detail-tool-popover, .detail-tool')) return;
    setDateOpen(false);
    setListOpen(false);
    setToolPanel(null);
  };
  const deleteSelected = async () => {
    setDeleteError('');
    setDeleting(true);
    const ok = await Promise.resolve(removeItem(selectedTask));
    setDeleting(false);
    if (!ok) setDeleteError(isEvent ? '일정 삭제 실패' : '작업 삭제 실패');
  };
  useEffect(() => {
    setDurationDraft({ date: startDate, time: startTime, endDate, endTime });
  }, [endDate, endTime, startDate, startTime]);
  useEffect(() => {
    setCompletionOverride(null);
    setCompletionPulse(false);
  }, [selectedId]);

  return <div className="modal-backdrop detail-backdrop" onMouseDown={close}>
    <div
      className="detail-modal"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseDownCapture={(event) => closeDetailFloaters(event.target)}
      onFocusCapture={(event) => closeDetailFloaters(event.target)}
    >
      <header className="detail-topline">
        <button className="detail-check" data-done={isDone(detailTask)} data-completing={completionPulse} onClick={() => void toggleDetailCompletion()} aria-label="완료 토글">{isDone(detailTask) ? '✓' : ''}</button>
        <span className="detail-divider" />
        <span className="detail-status" data-done={isDone(detailTask)}>{isDone(detailTask) ? '완료됨' : '진행 중'}</span>
        <button className="detail-date-trigger" onClick={openDateEditor}><span>▦</span>{dateTitle}</button>
        <button className="detail-flag" aria-label="우선순위" onClick={() => patchItem(detailTask, { priority: text(detailTask.priority) ? '' : 'P1' })}>⚐</button>
        <button className="detail-close" onClick={close}>✕</button>
      </header>
      <main className="detail-compose" data-done={isDone(detailTask)}>
        <input className="detail-title-input" defaultValue={itemTitle(detailTask, '')} onBlur={(event) => patchItem(detailTask, { title: event.target.value })} placeholder="무엇을 하고 싶으신가요?" autoFocus />
        <textarea className="detail-notes-input" defaultValue={notes} onBlur={(event) => patchItem(detailTask, { notes: event.target.value })} placeholder="설명 또는 메모 추가" />
      </main>
      <footer className="detail-bottomline">
        <button className="detail-list-pill" onClick={() => setListOpen((open) => !open)}><span>{activeList.icon || '▣'}</span>{activeList.label}<b>▾</b></button>
        <span />
        <button className="detail-tool" data-active={toolPanel === 'format'} title="서식" onClick={() => setToolPanel(toolPanel === 'format' ? null : 'format')}>A</button>
        <button className="detail-tool" data-active={toolPanel === 'comment'} title="댓글" onClick={() => setToolPanel(toolPanel === 'comment' ? null : 'comment')}>▣</button>
        <button className="detail-tool" data-active={toolPanel === 'more'} title="더보기" onClick={() => setToolPanel(toolPanel === 'more' ? null : 'more')}>•••</button>
        {!isEvent && <button className="detail-tool detail-agent" title="에이전트에 위임" onClick={delegate}>⚡</button>}
        <button className="detail-delete" disabled={deleting} onClick={() => void deleteSelected()}>{deleting ? '삭제 중' : '삭제'}</button>
      </footer>
      {deleteError && <div className="detail-error">{deleteError}</div>}
      {toolPanel && <div className="detail-tool-popover">
        {toolPanel === 'format' && <><strong>서식 추가</strong><div className="tool-chip-row"><button onClick={() => appendDetailNotes('## 소제목')}>제목</button><button onClick={() => appendDetailNotes('- 항목')}>목록</button><button onClick={() => appendDetailNotes('```\\n코드\\n```')}>코드</button></div></>}
        {toolPanel === 'comment' && <><strong>댓글</strong><div><input value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addDetailComment(); }} placeholder="댓글 입력" autoFocus /><button onClick={() => void addDetailComment()}>남기기</button></div></>}
        {toolPanel === 'more' && <><strong>빠른 작업</strong><div className="tool-chip-row"><button onClick={() => patchDate(todayKey())}>오늘로</button><button onClick={() => patchDate(addDaysKey(todayKey(), 1))}>내일로</button><button onClick={() => patchEnd({ repeat: repeat === 'weekly' ? 'none' : 'weekly' })}>{repeat === 'weekly' ? '반복 해제' : '매주 반복'}</button></div></>}
      </div>}
      {listOpen && <div className="detail-list-popover">
        <label className="new-list-search"><span>⌕</span><input value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder="검색" autoFocus /></label>
        <div className="new-list-options">
          {filteredLists.map((option) => {
            const active = slugify(activeList.id) === slugify(option.id) || slugify(activeList.label) === slugify(option.label);
            return <button className="new-list-row" data-active={active} key={option.id} onClick={async () => {
              const ok = await Promise.resolve(patchItem(detailTask, { list: option.id, category: option.label, project: option.label }));
              if (!ok) return;
              setListOpen(false);
              setListQuery('');
            }}>
              <span className="new-list-icon">{option.icon}</span>
              <span className="new-list-label">{option.label}</span>
              <span className="new-list-state">{active ? '✓' : '›'}</span>
            </button>;
          })}
          {!filteredLists.length && <div className="new-list-empty">일치하는 리스트 없음</div>}
        </div>
      </div>}
      {dateOpen && <div className="detail-date-popover">
        <div className="detail-date-segment"><button data-active={dateMode === 'date'} onClick={() => setDateMode('date')}>날짜</button><button data-active={dateMode === 'duration'} onClick={() => setDateMode('duration')}>지속 시간</button></div>
        {dateMode === 'date' ? <>
          <div className="detail-date-presets">
            <button title="오늘" onClick={() => applyDatePreset('today')}>☼</button>
            <button title="내일" onClick={() => applyDatePreset('tomorrow')}>⌂</button>
            <button title="다음 주" onClick={() => applyDatePreset('nextWeek')}>▣<small>+7</small></button>
            <button title="오늘 저녁" onClick={() => applyDatePreset('evening')}>☾</button>
          </div>
          <div className="detail-month-head"><strong>{pickerMonth.getFullYear()}년 {pickerMonth.getMonth() + 1}월</strong><span /><button onClick={() => shiftPickerMonth(-1)}>‹</button><button onClick={() => setPickerMonth(new Date(`${todayKey()}T00:00:00`))}>○</button><button onClick={() => shiftPickerMonth(1)}>›</button></div>
          <div className="detail-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="detail-date-grid">{pickerCells.map((cell) => <button data-muted={!cell.inMonth} data-active={cell.selected} key={cell.iso} onClick={() => patchDate(cell.iso)}>{cell.day}</button>)}</div>
          <button className="detail-date-row" onClick={() => setDateMode('duration')}><span>◷</span>{startTime ? formatTime(startTime) : '시간 추가'}<b>›</b></button>
          <button className="detail-date-row" data-active={reminderOn} onClick={toggleReminder}><span>⏰</span>{reminderOn ? '정각 알림 켜짐' : '정각에'}<b>{reminderOn ? '✓' : '›'}</b></button>
          <button className="detail-date-row" onClick={() => patchEnd({ repeat: repeat === 'none' ? 'weekly' : 'none' })}><span>↻</span>{repeatLabel(repeat)}<b>›</b></button>
        </> : <>
          <div className="duration-grid">
            <label>시작</label><input value={durationDraft.date} onChange={(event) => setDurationDraft((current) => ({ ...current, date: event.target.value }))} /><input value={durationDraft.time} onChange={(event) => setDurationDraft((current) => ({ ...current, time: event.target.value }))} placeholder="오후 5:00" />
            <label>끝</label><input value={durationDraft.endDate} onChange={(event) => setDurationDraft((current) => ({ ...current, endDate: event.target.value }))} /><input value={durationDraft.endTime} onChange={(event) => setDurationDraft((current) => ({ ...current, endTime: event.target.value }))} placeholder="오후 6:00" />
            <label>전체</label><button className="duration-toggle" data-active={allDay} onClick={() => patchEnd({ allDay: !allDay, time: allDay ? startTime : '' })}><span /></button>
          </div>
          <button className="detail-date-row" data-active={reminderOn} onClick={toggleReminder}><span>⏰</span>{reminderOn ? '정각 알림 켜짐' : '정각에'}<b>{reminderOn ? '✓' : '›'}</b></button>
          <button className="detail-date-row" onClick={() => patchEnd({ repeat: repeat === 'none' ? 'weekly' : 'none' })}><span>↻</span>{repeatLabel(repeat)}<b>›</b></button>
        </>}
        <footer><button onClick={clearDate}>삭제</button><button className="primary" onClick={confirmDateEditor}>확인</button></footer>
      </div>}
    </div>
  </div>;
}

function Modal({ modal, setModal, newTitle, setNewTitle, newDesc, setNewDesc, newTask, createTask, lists, tags, agents, runs, selectedRun, selectedTask, patchTask, patchCalendarEvent, removeTask, removeCalendarEvent, toggleTask, delegateText, setDelegateText, delegateAgentId, setDelegateAgentId, startPlan, openRunArtifact, approveRun, newAgentName, setNewAgentName, newAgentRole, setNewAgentRole, newAgentEmoji, setNewAgentEmoji, createAgent, settings, setSettings, refresh, setApiError, loggedIn, setLoggedIn, logout, loginEmail, setLoginEmail, loginPw, setLoginPw, prefs, updatePrefs }: { modal: ModalId; setModal: (modal: ModalId) => void; newTitle: string; setNewTitle: (value: string) => void; newDesc: string; setNewDesc: (value: string) => void; newTask: NewTaskControls; createTask: (extraNotes?: string) => Promise<void>; lists: TaxonomyItem[]; tags: TaxonomyItem[]; agents: Item[]; runs: Item[]; selectedRun?: Item; selectedTask?: Item; patchTask: (task: Item, patch: Item) => boolean | Promise<boolean>; patchCalendarEvent: (task: Item, patch: Item) => boolean | Promise<boolean>; removeTask: (task: Item) => boolean | Promise<boolean>; removeCalendarEvent: (task: Item) => boolean | Promise<boolean>; toggleTask: (task: Item) => void; delegateText: string; setDelegateText: (value: string) => void; delegateAgentId: string; setDelegateAgentId: (value: string) => void; startPlan: () => void; openRunArtifact: (run?: Item) => void; approveRun: (run: Item) => void; newAgentName: string; setNewAgentName: (value: string) => void; newAgentRole: string; setNewAgentRole: (value: string) => void; newAgentEmoji: string; setNewAgentEmoji: (value: string) => void; createAgent: () => void; settings: DesktopSettingsState; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; setApiError: (value: string) => void; loggedIn: boolean; setLoggedIn: (value: boolean) => void; logout: () => Promise<void>; loginEmail: string; setLoginEmail: (value: string) => void; loginPw: string; setLoginPw: (value: string) => void; prefs: UiPreferences; updatePrefs: (value: UiPreferences) => Promise<void> }) {
  if (!modal) return null;
  if (modal === 'new') {
    return <div className="modal-backdrop new-task-backdrop" onMouseDown={() => setModal(null)}><NewTaskModal title={newTitle} setTitle={setNewTitle} desc={newDesc} setDesc={setNewDesc} controls={newTask} lists={lists} close={() => setModal(null)} submit={createTask} /></div>;
  }
  if (modal === 'settings') {
    return <SettingsOverlay settings={settings} setSettings={setSettings} refresh={refresh} setApiError={setApiError} close={() => setModal(null)} loggedIn={loggedIn} setLoggedIn={setLoggedIn} logout={logout} loginEmail={loginEmail} setLoginEmail={setLoginEmail} loginPw={loginPw} setLoginPw={setLoginPw} prefs={prefs} updatePrefs={updatePrefs} />;
  }
  if (modal === 'task' && selectedTask) {
    return <TaskDetailModal selectedTask={selectedTask} lists={lists} patchTask={patchTask} patchCalendarEvent={patchCalendarEvent} removeTask={removeTask} removeCalendarEvent={removeCalendarEvent} toggleTask={toggleTask} close={() => setModal(null)} delegate={() => { setDelegateText(itemTitle(selectedTask, '')); setModal('delegate'); }} />;
  }
  if (modal === 'delegate') {
    const visibleAgents = agents.filter(isAgentSelectable).slice(0, 4);
    return <div className="modal-backdrop delegate-backdrop" onMouseDown={() => setModal(null)}>
      <div className="delegate-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="delegate-title">⚡ 에이전트에 위임</div>
        <p>자연어로 지시하면 런이 생성되고 실시간으로 실행됩니다.</p>
        <label>담당 에이전트</label>
        <div className="delegate-agents">{visibleAgents.map((agent, index) => {
          const id = itemId(agent, `agent-${index}`);
          return <button data-active={delegateAgentId === id || (!delegateAgentId && index === 0)} key={id} onClick={() => setDelegateAgentId(id)}>{text(agent.emoji, '⚡')} {agentDisplayName(agent)}</button>;
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
        <RunReport run={selectedRun || runs[0]} close={() => setModal(null)} openArtifact={openRunArtifact} approveRun={approveRun} />
      </div>
    </div>;
  }
  return null;
}

type ChecklistDraftItem = { text: string; done: boolean };

function NewTaskModal({ title, setTitle, desc, setDesc, controls, lists, close, submit }: { title: string; setTitle: (value: string) => void; desc: string; setDesc: (value: string) => void; controls: NewTaskControls; lists: TaxonomyItem[]; close: () => void; submit: (extraNotes?: string) => Promise<void> }) {
  const [pickerMonth, setPickerMonth] = useState(() => new Date(`${controls.date || todayKey()}T00:00:00`));
  const [checkItems, setCheckItems] = useState<ChecklistDraftItem[]>([]);
  const [listQuery, setListQuery] = useState('');
  const [timeMenu, setTimeMenu] = useState<'date' | 'start' | 'end' | null>(null);
  const [durationDateMenu, setDurationDateMenu] = useState<'start' | 'end' | null>(null);
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
  const timeSlots = Array.from({ length: 48 }, (_, index) => {
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
  const checklistNotes = () => checkItems
    .map((item) => ({ ...item, text: item.text.trim() }))
    .filter((item) => item.text)
    .map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`)
    .join('\n');
  const submitTask = () => submit(checklistNotes());
  const applyPreset = (kind: 'today' | 'tomorrow' | 'nextWeek' | 'evening') => {
    const preset = quickDatePreset(kind, controls.date);
    setQuickDate(preset.date);
    controls.setTime(preset.time);
    controls.setAllDay(kind !== 'evening');
    controls.setSubPanel(null);
  };
  const addCheckItem = () => {
    controls.setDatePanel(false);
    controls.setListPanel(false);
    setCheckItems((current) => [...current, { text: '', done: false }]);
  };
  const updateCheckItem = (index: number, value: string) => {
    setCheckItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, text: value } : item)));
  };
  const toggleCheckItem = (index: number, done: boolean) => {
    setCheckItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, done } : item)));
  };
  const removeEmptyCheckItem = (index: number) => {
    setCheckItems((current) => current.length > 1 ? current.filter((_, itemIndex) => itemIndex !== index) : current);
  };
  const pickTime = (target: 'date' | 'start' | 'end', value: string) => {
    if (target === 'end') controls.setEndTime(value);
    else controls.setTime(value);
    controls.setAllDay(false);
    setTimeMenu(null);
    setDurationDateMenu(null);
    if (target === 'date') controls.setSubPanel(null);
    if (target === 'end') {
      controls.setSubPanel(null);
      controls.setDatePanel(false);
    }
  };
  const openDurationDateMenu = (target: 'start' | 'end') => {
    const value = target === 'start' ? controls.date : controls.endDate;
    setTimeMenu(null);
    setDurationDateMenu(target);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) setPickerMonth(new Date(`${value}T00:00:00`));
  };
  const pickDurationDate = (target: 'start' | 'end', value: string) => {
    if (target === 'start') controls.setDate(value);
    else controls.setEndDate(value);
    setPickerMonth(new Date(`${value}T00:00:00`));
    setDurationDateMenu(null);
  };
  const durationDatePicker = (target: 'start' | 'end', value: string) => (
    <div className="duration-date-dialog">
      <div className="picker-head"><strong>{pickerLabel}</strong><span /><button onClick={() => shiftMonth(-1)}>‹</button><button onClick={() => pickDurationDate(target, todayKey())}>오늘</button><button onClick={() => shiftMonth(1)}>›</button></div>
      <div className="picker-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="picker-grid">{pickerCells.map((cell) => <button data-date={cell.iso} data-muted={!cell.inMonth} data-today={cell.today} data-active={cell.iso === value} key={cell.iso} onClick={() => pickDurationDate(target, cell.iso)}>{cell.day}</button>)}</div>
    </div>
  );
  const durationDateField = (target: 'start' | 'end', value: string, setValue: (value: string) => void) => (
    <div className="duration-date-field">
      <input
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setPickerMonth(new Date(`${event.target.value}T00:00:00`));
        }}
        onClick={() => openDurationDateMenu(target)}
        onFocus={() => openDurationDateMenu(target)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDurationDateMenu(null);
        }}
        placeholder="YYYY-MM-DD"
      />
      {durationDateMenu === target && durationDatePicker(target, value)}
    </div>
  );
  const closeDurationFloaters = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.duration-date-field, .duration-time-field, .duration-time-menu')) return;
    setDurationDateMenu(null);
    if (timeMenu === 'start' || timeMenu === 'end') setTimeMenu(null);
  };
  const closeNewTaskFloaters = (target: EventTarget | null) => {
    closeDurationFloaters(target);
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.new-panel, .new-date-chip, .new-list-panel, .new-list-button')) return;
    controls.setDatePanel(false);
    controls.setListPanel(false);
    controls.setSubPanel(null);
  };
  const timeMenuList = (target: 'date' | 'start' | 'end', value: string, className = '') => (
    <div className={`duration-time-menu ${className}`} ref={durationMenuRef}>
      {timeSlots.map((slot) => {
        const active = value === slot;
        return <button type="button" data-active={active} key={slot} onClick={() => pickTime(target, slot)}><span>{formatTime(slot)}</span><b>{active ? '✓' : ''}</b></button>;
      })}
    </div>
  );
  const durationTimeField = (target: 'start' | 'end', value: string, placeholder: string) => (
    <div className="duration-time-field">
      <input
        className="duration-time-input"
        value={value ? formatTime(value) : ''}
        onClick={() => { setTimeMenu(target); setDurationDateMenu(null); }}
        onFocus={() => { setTimeMenu(target); setDurationDateMenu(null); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setTimeMenu(null);
        }}
        placeholder={placeholder}
        readOnly
      />
      {timeMenu === target && timeMenuList(target, value)}
    </div>
  );

  useEffect(() => {
    if (checkItems.length) checkRefs.current[checkItems.length - 1]?.focus();
  }, [checkItems.length]);
  useEffect(() => {
    if (!timeMenu) return;
    requestAnimationFrame(() => {
      durationMenuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center' });
    });
  }, [controls.endTime, controls.time, timeMenu]);

  return <div
    className="new-task-popover"
    onMouseDown={(event) => event.stopPropagation()}
    onMouseDownCapture={(event) => closeNewTaskFloaters(event.target)}
    onFocusCapture={(event) => closeNewTaskFloaters(event.target)}
  >
    <div className="new-task-scroll">
      <div className="new-task-date-row">
        <button className="new-date-chip" data-has-date={!!controls.date} onClick={() => { controls.setDatePanel(!controls.datePanel); controls.setListPanel(false); }}>🗓 {dateChip}</button>
        <button className="new-close" aria-label="닫기" onClick={close}>✕</button>
      </div>
      <div className="new-task-title-row">
        <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submitTask(); }} placeholder="무엇을 하고 싶으신가요?" />
        <button className="new-checklist-toggle" aria-label="할 일 추가" title="할 일 추가" onClick={addCheckItem}>☰</button>
      </div>
      <textarea className="new-task-desc" value={desc} onChange={(event) => setDesc(event.target.value)} placeholder="설명" />
      {checkItems.length > 0 && <div className="new-task-checklist">
        {checkItems.map((item, index) => <label className="new-task-check-row" key={index}>
          <input type="checkbox" checked={item.done} onChange={(event) => toggleCheckItem(index, event.target.checked)} tabIndex={-1} />
          <input
            ref={(element) => { checkRefs.current[index] = element; }}
            value={item.text}
            onChange={(event) => updateCheckItem(index, event.target.value)}
            onBlur={() => { if (!item.text.trim()) removeEmptyCheckItem(index); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setCheckItems((current) => [...current, { text: '', done: false }]);
              }
              if (event.key === 'Backspace' && !item.text) removeEmptyCheckItem(index);
            }}
            placeholder={'"엔터"를 눌러 할일 생성'}
          />
        </label>)}
      </div>}
      <div className="new-task-fill" />

      {controls.datePanel && <div className="new-panel">
        <div className="new-segment"><button data-active={controls.mode === 'date'} onClick={() => controls.setMode('date')}>날짜</button><button data-active={controls.mode === 'duration'} onClick={startDuration}>지속 시간</button></div>
        {controls.mode === 'date' ? <>
          <div className="quick-date-presets">
            <button title="오늘" onClick={() => applyPreset('today')}>☼</button>
            <button title="내일" onClick={() => applyPreset('tomorrow')}>⌂</button>
            <button title="다음 주" onClick={() => applyPreset('nextWeek')}>▣<small>+7</small></button>
            <button title="오늘 저녁" onClick={() => applyPreset('evening')}>☾</button>
          </div>
          <div className="picker-head"><strong>{pickerLabel}</strong><span /><button onClick={() => shiftMonth(-1)}>‹</button><button onClick={() => setQuickDate(todayKey())}>오늘</button><button onClick={() => shiftMonth(1)}>›</button></div>
          <div className="picker-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="picker-grid">{pickerCells.map((cell) => <button data-date={cell.iso} data-muted={!cell.inMonth} data-today={cell.today} data-active={cell.selected} key={cell.iso} onClick={() => setQuickDate(cell.iso)}>{cell.day}</button>)}</div>
          <NewAccordionRow label="시간" value={controls.allDay ? '종일' : controls.time ? formatTime(controls.time) : '없음'} panel="time" controls={controls} />
          {controls.subPanel === 'time' && <div className="sub-panel">
            <div className="all-day-row"><span>종일</span><button className="switch" data-active={controls.allDay} onClick={() => { controls.setAllDay(!controls.allDay); if (!controls.allDay) controls.setTime(''); }}><span /></button>{controls.time && <button onClick={() => controls.setTime('')}>지우기</button>}</div>
            {timeMenuList('date', controls.time, 'date-time-menu')}
          </div>}
        </> : <div className="duration-grid">
          <span>시작</span>{durationDateField('start', controls.date, controls.setDate)}{durationTimeField('start', controls.time, '시간')}
          <span>끝</span>{durationDateField('end', controls.endDate, controls.setEndDate)}{durationTimeField('end', controls.endTime, '시간')}
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
      <button className="new-submit" disabled={!title.trim()} onClick={submitTask} aria-label="작업 만들기">↑</button>
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

function SettingsOverlay({ settings, setSettings, refresh, setApiError, close, loggedIn, setLoggedIn, logout, loginEmail, setLoginEmail, loginPw, setLoginPw, prefs, updatePrefs }: { settings: DesktopSettingsState; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; setApiError: (value: string) => void; close: () => void; loggedIn: boolean; setLoggedIn: (value: boolean) => void; logout: () => Promise<void>; loginEmail: string; setLoginEmail: (value: string) => void; loginPw: string; setLoginPw: (value: string) => void; prefs: UiPreferences; updatePrefs: (value: UiPreferences) => Promise<void> }) {
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
    try {
      const next = await window.hermesDesktop?.saveSettings({ theme });
      if (next) {
        setSettings(desktopSettingsState(next));
      } else {
        const payload = await hermesApi.saveSettings({ theme });
        setSettings({ ...settings, theme: text(payload.theme || obj(payload, 'settings').theme, theme) as DesktopTheme });
      }
      await refresh();
    } catch (error) {
      setSettings(settings);
      setApiError(error instanceof Error ? error.message : '테마 저장 실패');
      console.warn('Agent Calendar theme save failed', error);
    }
  }
  const submitLogin = () => {
    setLoggedIn(true);
    setLoginPw('');
    close();
  };
  const accountName = settings.authProfile?.name || 'Yunseo';
  const accountEmail = settings.authProfile?.email || 'yunseo@agent.calendar';
  const accountInitial = (accountName || accountEmail || 'A').trim().slice(0, 1).toUpperCase();
  return <div className="settings-backdrop" onMouseDown={close}><div className="settings-overlay" onMouseDown={(event) => event.stopPropagation()}>
    <header><h2>설정</h2><button onClick={close}>✕</button></header>
    <div className="settings-body">
      <div className="settings-label">계정</div>
      <section className="account-box">{settings.authProfile?.picture ? <img className="avatar large" src={settings.authProfile.picture} alt="" /> : <div className="avatar large">{accountInitial}</div>}<div><strong>{accountName}</strong><span>{loggedIn ? accountEmail : '로그인이 필요합니다'}</span></div>{loggedIn ? <button onClick={() => void logout()}>로그아웃</button> : <button className="primary" onClick={submitLogin}>로그인</button>}</section>
      {!loggedIn && <section className="login-inline"><input value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin(); }} placeholder="yunseo@agent.calendar" /><input value={loginPw} onChange={(event) => setLoginPw(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin(); }} type="password" placeholder="••••••••" /><button className="primary" onClick={submitLogin}>로그인</button></section>}
      <div className="settings-label">테마 · 강조 색상</div>
      <section className="theme-grid">{themes.map(([key, label, color]) => <button data-active={settings.theme === key} key={key} onClick={() => void saveTheme(key)}><span style={{ background: color }}>{settings.theme === key ? '✓' : ''}</span><b>{label}</b></button>)}</section>
      <section className="theme-preview"><span>H</span><b>선택한 색상이 버튼·강조·캘린더 전반에 즉시 적용됩니다</b></section>
      <div className="settings-label">환경설정</div>
      <section className="pref-box">{prefRows.map(([key, label, desc]) => <div className="pref-row" key={key}><span className="pref-copy"><b>{label}</b><small>{desc}</small></span><button className="switch" data-active={prefs[key]} onClick={() => void updatePrefs({ ...prefs, [key]: !prefs[key] })}><span /></button></div>)}</section>
    </div>
    <footer><span>Agent Calendar · v0.9 · 로컬 저장</span><button className="primary" onClick={close}>완료</button></footer>
  </div></div>;
}

function RunReport({ run: selected, close, openArtifact, approveRun }: { run?: Item; close: () => void; openArtifact: (run?: Item) => void; approveRun: (run: Item) => void }) {
  if (!selected) {
    return <div className="run-report">
      <section className="run-head"><span>대기</span><div><strong>선택된 실행 없음</strong><small>백엔드 런을 선택하세요</small></div><button onClick={close}>✕</button></section>
    </div>;
  }
  const run = selected;
  const pct = /done|완료/i.test(text(run.status)) ? 100 : Number(run.pct || run.progress || 0);
  const steps = Array.isArray(run.steps) ? run.steps as Item[] : [];
  const canApprove = pct >= 100 && !/approved|승인/i.test(text(run.status));
  return <div className="run-report">
    <section className="run-head"><span>{pct >= 100 ? '완료' : '실행 중'}</span><div><strong>{text(run.title || run.goal, '런')}</strong><small>{text(run.agent, 'default')}</small></div>{canApprove && <button className="run-approve" onClick={() => approveRun(run)}>승인</button>}<button className="run-close" onClick={close}>✕</button></section>
    <div className="run-progress"><span style={{ width: `${pct}%` }} /></div>
    <section className="run-timeline"><h3>실행 타임라인</h3>{steps.map((step, index) => <div className="run-step" key={index}><i data-active={index === steps.length - 1 && pct < 100} /><span><strong>{itemTitle(step, '단계')}</strong><small>{text(step.detail)}</small></span><em>{text(step.time)}</em></div>)}</section>
    <section className="run-artifact"><span>📄</span><div><strong>{text(run.artifact || run.document || run.goal, '실행 결과 정리')}</strong><small>위키 문서 · 완료 후 열기</small></div><button onClick={() => openArtifact(run)}>열기 →</button></section>
  </div>;
}

function Panel({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return <section className="panel" data-wide={wide}><h3>{title}</h3>{children}</section>;
}

function Rows({ items, action, onOpen, onToggle }: { items: Item[]; action: string; onOpen?: (item: Item) => void; onToggle?: (item: Item) => void }) {
  return <div className="rows">{items.map((item, index) => <button className="row" data-done={isDone(item)} key={index} onClick={() => onOpen?.(item)}>{onToggle && <i onClick={(event) => { event.stopPropagation(); onToggle(item); }}>{isDone(item) ? '✓' : ''}</i>}<span><b>{itemTitle(item, '항목')}</b><small>{itemSub(item, 'Agent Calendar')}</small></span><em>{action}</em></button>)}</div>;
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
  const [state, setState] = useState<'idle' | 'started' | 'dismissed'>('idle');
  if (state === 'dismissed') return null;
  return <div className="suggestion" data-state={state}>
    <b>🤖 제안</b>
    <p>{state === 'started' ? `조사 대기열에 추가됨 · ${value}` : value}</p>
    <button onClick={() => setState('started')} disabled={state === 'started'}>{state === 'started' ? '시작됨' : '조사 시작'}</button>
    <button onClick={() => setState('dismissed')}>무시</button>
  </div>;
}
