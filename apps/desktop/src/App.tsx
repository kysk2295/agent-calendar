import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsClockwise,
  Books,
  CalendarBlank,
  CalendarDots,
  CaretLeft,
  CaretRight,
  ChartBar,
  ChatCircleDots,
  Columns,
  DesktopTower,
  EnvelopeSimple,
  GearSix,
  ListBullets,
  MagnifyingGlass,
  Notebook,
  Plus,
  Robot,
  SquaresFour,
  Sun,
  Tag,
  Tray,
  X,
  type Icon,
} from '@phosphor-icons/react';
import { hermesApi, setApiBaseUrl, setApiProxyConnection, type ApiEnvelope } from './api/hermesApi';
import { createAgentWork } from './api/agentWorkApiClient';
import {
  agentDisplayName,
  agentProfileName,
  agentSourceKind,
  agentStatusLabel,
  isAgentSelectable,
  mergeAgentsWithProfileReadiness,
} from './domains/agent-work/agentRoster';
import {
  calendarAiMessageFromDone,
  normalizeCalendarChatHistory,
  normalizeScheduleIngestResponse,
  optimisticMailTaskUpdate,
  scheduleDraftRegistrationItem,
  selectedScheduleDrafts,
  type ChatMessage,
  type CalendarAiActionDraft,
  type ScheduleDraft,
} from './domains/communication/communication';
import {
  applyWikiStreamBlock,
  createdDocumentFrom,
  docIdentity,
  mergeDocsByIdentity,
  parseKnowledgeV2Answer,
  parseKnowledgeV2Job,
  persistedDocumentIdentity,
  wikiJournalDocs,
} from './domains/knowledge/knowledge';
import { AgentOperationsScreen } from './features/agent-operations/AgentOperationsScreen';
import { HermesAutomationDashboard } from './features/agent-operations/HermesAutomationDashboard';
import {
  EMPTY_AGENT_OPERATIONS_STATE,
  parseAgentOperationsEnvelope,
  parseAgentSessionEnvelope,
} from './features/agent-operations/agentOperations';
import { agentTaskCalendarRecord } from './features/agent-operations/agentTaskAppearance';
import {
  parseConnectedAutomations,
  parseConnectedAutomationSources,
} from './features/agent-operations/hermesAutomation';
import { TaskSessionPanel } from './features/agent-operations/TaskSessionPanel';
import type {
  AgentCatalogRequest,
  AgentBuilderLifecycle,
  AgentBuilderTestRequest,
  AgentDirectoryMutationInput,
  AgentExecutionEngine,
  AgentOperationsState,
  AgentMissionCreateInput,
  AgentRosterEntry,
  AgentProfileVersion,
  ConnectedAutomationSource,
  AgentSessionDetail,
  AgentTaskAction,
  HermesAutomationJob,
  HermesAutomationUpdateInput,
  ProviderAgentSession,
  ProviderSessionCatalogRequest,
  ProviderSessionImportResult,
} from './features/agent-operations/types';
import './features/agent-operations/agent-operations.css';
import './features/agent-operations/agent-workspace.css';
import { useAgentCalendarDeepLink } from './features/agent-operations/useAgentCalendarDeepLink';
import { consumeConsoleChatStream } from './features/chat/consoleChatStream';
import { ChatDrawer } from './features/communication/ChatDrawer';
import { MailScreen } from './features/communication/MailScreen';
import {
  coverageSummary,
  mapUnifiedEntriesToCalendarEvents,
  monthSourceBadge,
} from './domains/work-management/unifiedCalendarPresentation';
import { DiaryScreen, NotesScreen, ReviewScreen, WikiScreen } from './features/knowledge';
import {
  APP_TIME_ZONE,
  TAXONOMY_SOURCE,
  addDaysKey,
  addMonthsKey,
  calendarEventMatchesCreated,
  calendarEventPayload,
  calendarMetadata,
  calendarNotes,
  dateLabel,
  desktopTaskPayload,
  fallbackAnswer,
  formatDateChip,
  formatTime,
  formatUpdatedStamp,
  isCalendarEventRecord,
  isDone,
  isTaskRecord,
  isTaxonomyRecord,
  normalizeCalendarEvent,
  parseQuick,
  parseTaxonomyRecord,
  plainCalendarNotes,
  quickDatePreset,
  repeatLabel,
  responseCalendarEvent,
  responseTask,
  scheduleItemDate,
  shouldPersistTask,
  taskDataSummary,
  taskListName,
  taskMatchesCreated,
  taskOwner,
  taskPayload,
  taskTags,
  taxonomyMatchesSaved,
  taxonomyNavKey,
  todayKey,
  todayMetaLabel,
  weekRangeLabel,
  type TaxonomyItem,
  type TaxonomyKind,
} from './domains/work-management/workManagement';
import {
  DEFAULT_UI_PREFERENCES,
  persistUiPreferences,
  readUiPreferences,
  type UiPreferences,
} from './features/settings/uiPreferences';
import { WorkspaceInferencePolicyPanel } from './features/settings/WorkspaceInferencePolicyPanel';
import { OnboardingGuide } from './features/onboarding/OnboardingGuide';
import { buildOnboardingReadiness } from './features/onboarding/onboardingReadiness';
import {
  INITIAL_DESKTOP_CONNECTIVITY,
  beginConnectivityRetry,
  connectivityPresentation,
  markConnectivityOffline,
  markConnectivityOnline,
  offlineRetryDelayMs,
  settleRecoveredConnectivity,
} from './features/connectivity/desktopConnectivity';
import {
  createWorkspaceHydrationCoordinator,
  type WorkspaceHydrationCoordinator,
  type WorkspaceSessionLease,
} from './features/connectivity/workspaceHydrationCoordinator';
import { parseWorkspacePresentationSnapshot } from './features/connectivity/workspaceSnapshot';
import { RunnerSetupPanel } from './features/runner/RunnerSetupPanel';
import type { PublicRunner } from './features/runner/runnerApi';

type ScreenId = 'onboarding' | 'calendar' | 'today' | 'next7' | 'tasks' | 'kanban' | 'mail' | 'notes' | 'someday' | 'review' | 'wiki' | 'diary' | 'search' | 'agents' | 'automation' | 'widgets' | 'settings' | 'login' | 'runner';
type ModalId = 'task' | 'new' | 'delegate' | 'run' | 'agent' | 'settings' | 'taxonomy' | null;
type Item = Record<string, unknown>;
type NavIconName = 'calendar' | 'today' | 'next7' | 'inbox' | 'mail' | 'board' | 'review' | 'wiki' | 'diary' | 'agent' | 'runner' | 'automation' | 'widget' | 'list' | 'tag';
type NavItem = { id: ScreenId; icon: NavIconName; label: string; navKey?: string };
type NavGroup = { title: string; kind?: 'list' | 'tag'; group?: string; items: NavItem[] };
type CompletionNotice = { task: Item; title: string } | null;
type AutomationMutationOutcome = { approvalId?: string };
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
  reminderOn: boolean;
  setReminderOn: (value: boolean) => void;
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
  gatewayStatus: ApiEnvelope;
  profileReadiness: ApiEnvelope;
  agentSourceStatus: ApiEnvelope;
};

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
  gatewayStatus: {},
  profileReadiness: {},
  agentSourceStatus: {},
};

const INITIAL_DESKTOP_RELEASE_STATUS: HermesDesktopReleaseStatus = {
  supported: false,
  phase: 'unsupported',
  currentVersion: '',
  availableVersion: null,
  progressPercent: null,
  checkedAt: null,
  message: '업데이트 확인은 설치된 Desktop 앱에서 사용할 수 있습니다.',
};

const screenMeta: Record<ScreenId, { title: string; sub: string }> = {
  onboarding: { title: '시작 가이드', sub: '캘린더 · Runner · Wiki · Calendar AI' },
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
  automation: { title: '자동화', sub: 'Runner 연결 · 일정 · 실행 관리' },
  widgets: { title: '위젯', sub: 'macOS 데스크톱 위젯 미리보기' },
  settings: { title: '설정', sub: '' },
  runner: { title: 'Runner 설정', sub: '계정 바인딩 · 소유자 확인' },
  login: { title: '로그인', sub: '' },
};

const LOGO_SRC = './agent-calendar-logo.png';
const IS_WIDGET_OVERLAY = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('overlay') === 'widgets';

if (IS_WIDGET_OVERLAY && typeof document !== 'undefined') {
  document.documentElement.dataset.overlay = 'widgets';
}

function LogoMark({ className = 'brand-mark' }: { className?: string }) {
  return <img className={className} src={LOGO_SRC} alt="" draggable={false} />;
}

const navIcons: Record<NavIconName, Icon> = {
  calendar: CalendarBlank,
  today: Sun,
  next7: CalendarDots,
  inbox: Tray,
  mail: EnvelopeSimple,
  board: Columns,
  review: ChartBar,
  wiki: Books,
  diary: Notebook,
  agent: Robot,
  runner: DesktopTower,
  automation: ArrowsClockwise,
  widget: SquaresFour,
  list: ListBullets,
  tag: Tag,
};

function NavIcon({ name }: { name: NavIconName }) {
  const IconComponent = navIcons[name];
  return <IconComponent className="nav-icon" size={16} weight="regular" aria-hidden="true" />;
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

type DateRowIconName = 'time' | 'reminder' | 'repeat';

function DateRowIcon({ name }: { name: DateRowIconName }) {
  const paths: Record<DateRowIconName, JSX.Element> = {
    time: <><circle cx="12" cy="12" r="8.25" /><path d="M12 7.6v4.8l3.15 1.85" /></>,
    reminder: <><path d="M7.05 7.15a7 7 0 1 1 9.9 9.9a7 7 0 0 1-9.9-9.9Z" /><path d="M8 3.8 4.9 6.25M16 3.8l3.1 2.45M9.45 20.15h5.1M12 8.15v4.35l2.7 1.55" /></>,
    repeat: <><path d="M17.25 7.5H8.8a4.3 4.3 0 0 0-4.3 4.3c0 1.55.82 2.9 2.05 3.65" /><path d="m14.9 4.95 2.65 2.55-2.65 2.55" /><path d="M6.75 16.5h8.45a4.3 4.3 0 0 0 4.3-4.3c0-1.55-.82-2.9-2.05-3.65" /><path d="m9.1 19.05-2.65-2.55L9.1 13.95" /></>,
  };
  return <svg className={`date-row-icon date-row-icon-${name}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

const primaryNavItems: NavItem[] = [
  { id: 'calendar', icon: 'calendar', label: '캘린더' },
  { id: 'agents', icon: 'agent', label: '에이전트' },
  { id: 'automation', icon: 'automation', label: '자동화' },
];

const secondaryNavItems: NavItem[] = [
  { id: 'today', icon: 'today', label: '오늘' },
  { id: 'next7', icon: 'next7', label: '다음 7일' },
  { id: 'tasks', icon: 'inbox', label: '기본함' },
  { id: 'mail', icon: 'mail', label: '메일함' },
  { id: 'kanban', icon: 'board', label: '칸반 보드' },
  { id: 'wiki', icon: 'wiki', label: '위키' },
  { id: 'review', icon: 'review', label: '주간 회고' },
  { id: 'diary', icon: 'diary', label: '일기' },
  { id: 'runner', icon: 'runner', label: 'Runner 설정' },
  { id: 'widgets', icon: 'widget', label: '위젯' },
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

function itemSub(item: Item, fallback = 'Agent Calendar') {
  return text(item.date || item.due || item.status || item.agent || item.model || item.from || item.folder || item.source, fallback);
}

function agentIdentity(item: Item, fallback = '') {
  return text(item.id || item._id || item.key || item.name || item.displayName, fallback);
}

function createdAgentFrom(payload: ApiEnvelope): Item {
  const nested = obj(payload, 'agent');
  if (agentIdentity(nested)) return nested;
  const profileRequest = obj(payload, 'profileRequest');
  if (agentIdentity(profileRequest)) {
    return {
      ...profileRequest,
      id: agentIdentity(profileRequest),
      status: 'pending',
      pending: true,
      source: 'profile-request',
    };
  }
  return agentIdentity(payload) ? payload : {};
}

function agentBuilderLifecycleFrom(item: Item): AgentBuilderLifecycle | undefined {
  const source = obj(item, 'lifecycle');
  const state = text(source.state);
  const origin = text(source.origin);
  if (!['draft', 'tested', 'active'].includes(state)
    || !['legacy', 'manual', 'one_line'].includes(origin)) return undefined;
  const lastTestSource = obj(source, 'lastTest');
  const lastTest = text(lastTestSource.id)
    ? {
      id: text(lastTestSource.id),
      revision: Math.max(0, Number(lastTestSource.revision) || 0),
      status: text(lastTestSource.status),
      summary: text(lastTestSource.summary),
      durationMs: Math.max(0, Number(lastTestSource.durationMs) || 0),
    }
    : null;
  return {
    origin: origin as AgentBuilderLifecycle['origin'],
    state: state as AgentBuilderLifecycle['state'],
    revision: Math.max(1, Number(source.revision) || 1),
    reviewedRevision: Math.max(0, Number(source.reviewedRevision) || 0),
    testedRevision: Math.max(0, Number(source.testedRevision) || 0),
    activeVersion: Math.max(0, Number(source.activeVersion) || 0),
    request: text(source.request),
    lastTest,
    reviewedAt: text(source.reviewedAt) || null,
    activatedAt: text(source.activatedAt) || null,
  };
}

function agentBuilderTestFrom(payload: ApiEnvelope): AgentBuilderTestRequest | null {
  const source = obj(payload, 'request');
  if (!text(source.id)) return null;
  return {
    id: text(source.id),
    agentId: text(source.agentId),
    revision: Math.max(1, Number(source.revision) || 1),
    runnerId: text(source.runnerId),
    provider: text(source.provider),
    status: text(source.status),
    passed: source.passed === true,
    summary: text(source.summary),
    durationMs: Math.max(0, Number(source.durationMs) || 0),
    errorCode: text(source.errorCode),
    createdAt: text(source.createdAt) || null,
    terminalAt: text(source.terminalAt) || null,
  };
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

function itemId(item: Item, fallback: string) {
  return text(item.id || item._id || item.key || item.path, fallback);
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[:/#?&]/g, '-');
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stringList(payload: ApiEnvelope, key: string) {
  const direct = payload[key];
  if (Array.isArray(direct)) return direct.map(String);
  const data = obj(payload, 'data');
  const nested = data[key];
  return Array.isArray(nested) ? nested.map(String) : [];
}

function loadKnowledgeDocument(path: string) {
  return hermesApi.getWiki({ path });
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

function desktopSettingsSignedIn(settings: HermesDesktopSettings): boolean {
  if (settings.session) return settings.session.signedIn === true;
  return Boolean(settings.hasSession || settings.authProfile);
}

export function App() {
  const isWidgetOverlay = IS_WIDGET_OVERLAY;
  const [screen, setScreen] = useState<ScreenId>('calendar');
  const [activeNavKey, setActiveNavKey] = useState('calendar');
  const [secondaryNavOpen, setSecondaryNavOpen] = useState(false);
  const [modal, setModal] = useState<ModalId>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [agentOperations, setAgentOperations] = useState<AgentOperationsState>(EMPTY_AGENT_OPERATIONS_STATE);
  const [calendarSources, setCalendarSources] = useState<Item[]>([]);
  const [calendarCoverageNote, setCalendarCoverageNote] = useState('');
  const [connectedAutomationSources, setConnectedAutomationSources] = useState<readonly ConnectedAutomationSource[]>([]);
  const [automationRunners, setAutomationRunners] = useState<readonly PublicRunner[]>([]);
  const [agentOperationsError, setAgentOperationsError] = useState('');
  const [agentOperationsBusy, setAgentOperationsBusy] = useState('');
  const agentOperationsRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [selectedAgentSessionId, setSelectedAgentSessionId] = useState('');
  const [agentSessionDetail, setAgentSessionDetail] = useState<AgentSessionDetail | null>(null);
  const [agentSessionLoading, setAgentSessionLoading] = useState(false);
  const [agentSessionMessageBusy, setAgentSessionMessageBusy] = useState(false);
  const [settings, setSettings] = useState<DesktopSettingsState>({ apiBaseUrl: 'https://hermes-os-production-e174.up.railway.app', hasApiToken: false, theme: 'default', authProfile: null, uiPreferences: DEFAULT_UI_PREFERENCES });
  const [apiError, setApiError] = useState('');
  const [desktopConnectivity, setDesktopConnectivity] = useState(INITIAL_DESKTOP_CONNECTIVITY);
  const [desktopReleaseStatus, setDesktopReleaseStatus] = useState(INITIAL_DESKTOP_RELEASE_STATUS);
  const [desktopReleaseBusy, setDesktopReleaseBusy] = useState<'' | 'check' | 'download' | 'install'>('');
  const [desktopReleaseError, setDesktopReleaseError] = useState('');
  const [desktopRecoveryStatus, setDesktopRecoveryStatus] = useState<HermesDesktopRecoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const hasHydratedRef = useRef(false);
  const localUiPreferencesRef = useRef<UiPreferences | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newRepeat, setNewRepeat] = useState('none');
  const [newReminderOn, setNewReminderOn] = useState(false);
  const [newOwner, setNewOwner] = useState('me');
  const [newList, setNewList] = useState('inbox');
  const [newAllDay, setNewAllDay] = useState(false);
  const [newDatePanel, setNewDatePanel] = useState(false);
  const [newListPanel, setNewListPanel] = useState(false);
  const [newSubPanel, setNewSubPanel] = useState<string | null>(null);
  const [newMode, setNewMode] = useState<'date' | 'duration'>('date');
  const [newEndDate, setNewEndDate] = useState('');
  const [newEndTime, setNewEndTime] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authPhase, setAuthPhase] = useState<'idle' | 'opening' | 'waiting' | 'completing' | 'error'>('idle');
  const [prefs, setPrefs] = useState<UiPreferences>(DEFAULT_UI_PREFERENCES);
  const [quickText, setQuickText] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [calView, setCalView] = useState<'month' | 'week' | 'day'>('month');
  const [calDate, setCalDate] = useState(todayKey());
  const [placingTaskId, setPlacingTaskId] = useState('');
  const [activeMailId, setActiveMailId] = useState('');
  const [mailLoadError, setMailLoadError] = useState('');
  const [activeNoteId, setActiveNoteId] = useState('');
  const [wikiQuestion, setWikiQuestion] = useState('');
  const [wikiAnswer, setWikiAnswer] = useState('');
  const [wikiAnswerSources, setWikiAnswerSources] = useState<Item[]>([]);
  const [wikiAnswerMeta, setWikiAnswerMeta] = useState<Item>({});
  const [wikiAsking, setWikiAsking] = useState(false);
  const [wikiSourceBusy, setWikiSourceBusy] = useState(false);
  const [wikiSourceMessage, setWikiSourceMessage] = useState('');
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
  const [chatAttachment, setChatAttachment] = useState<File | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [calendarAiConversationId, setCalendarAiConversationId] = useState('');
  const [calendarAiMemories, setCalendarAiMemories] = useState<Item[]>([]);
  const [calendarAiMemoryOpen, setCalendarAiMemoryOpen] = useState(false);
  const [calendarAiActionBusyId, setCalendarAiActionBusyId] = useState('');
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingMessage, setOnboardingMessage] = useState('');
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice>(null);
  const widgetActionDrainRef = useRef(false);
  const optimisticRunsRef = useRef<Item[]>([]);
  const approvedRunIdsRef = useRef<Set<string>>(new Set());
  const workspaceHydrationCoordinatorRef = useRef<WorkspaceHydrationCoordinator | null>(null);
  const workspaceSessionResolutionRef = useRef(0);
  if (!workspaceHydrationCoordinatorRef.current) {
    workspaceHydrationCoordinatorRef.current = createWorkspaceHydrationCoordinator();
  }
  const workspaceHydrationCoordinator = workspaceHydrationCoordinatorRef.current;

  function resetWorkspaceClientState() {
    workspaceSessionResolutionRef.current += 1;
    workspaceHydrationCoordinator.clearSession();
    setState(EMPTY_STATE);
    setAgentOperations(EMPTY_AGENT_OPERATIONS_STATE);
    setCalendarSources([]);
    setCalendarCoverageNote('');
    setConnectedAutomationSources([]);
    setAutomationRunners([]);
    setAgentOperationsError('');
    setAgentOperationsBusy('');
    setSelectedAgentSessionId('');
    setAgentSessionDetail(null);
    setAgentSessionLoading(false);
    setAgentSessionMessageBusy(false);
    setChatMessages([]);
    setCalendarAiConversationId('');
    setCalendarAiMemories([]);
    setWikiAnswer('');
    setWikiAnswerSources([]);
    setWikiAnswerMeta({});
    setCompletionNotice(null);
    setDesktopConnectivity(INITIAL_DESKTOP_CONNECTIVITY);
    optimisticRunsRef.current = [];
    approvedRunIdsRef.current = new Set();
    hasHydratedRef.current = false;
  }

  async function restoreWorkspacePresentationSnapshot(session: WorkspaceSessionLease): Promise<boolean> {
    if (!window.hermesDesktop?.readWorkspaceSnapshot) return false;
    const cached = await window.hermesDesktop.readWorkspaceSnapshot().catch(() => null);
    if (!workspaceHydrationCoordinator.isSessionCurrent(session)) return false;
    if (!cached) return false;
    const snapshot = parseWorkspacePresentationSnapshot(cached.data);
    if (!snapshot) return false;
    const cachedState = snapshot.state as AppState;
    setState(cachedState);
    setAgentOperations(snapshot.agentOperations as AgentOperationsState);
    setCalendarSources(snapshot.calendarSources as Item[]);
    setCalendarCoverageNote(snapshot.calendarCoverageNote);
    setConnectedAutomationSources(snapshot.connectedAutomationSources as ConnectedAutomationSource[]);
    setAutomationRunners(snapshot.automationRunners as PublicRunner[]);
    setCalendarAiMemories(snapshot.calendarAiMemories as Item[]);
    setCalendarAiConversationId(snapshot.calendarAiConversationId);
    setChatMessages(snapshot.chatMessages as ChatMessage[]);
    setDesktopConnectivity(markConnectivityOnline(
      INITIAL_DESKTOP_CONNECTIVITY,
      cached.savedAt,
    ));
    hasHydratedRef.current = true;
    setLoading(false);
    return true;
  }

  async function startSignedInWorkspace(): Promise<void> {
    const resolution = workspaceSessionResolutionRef.current + 1;
    workspaceSessionResolutionRef.current = resolution;
    workspaceHydrationCoordinator.beginSessionTransition();
    const status = await window.hermesDesktop?.getSessionStatus().catch(() => null);
    if (workspaceSessionResolutionRef.current !== resolution) return;
    if (!status?.signedIn || !status.sessionId) {
      resetWorkspaceClientState();
      setLoggedIn(false);
      setLoading(false);
      return;
    }
    const session = workspaceHydrationCoordinator.activateSession(status.sessionId);
    const restored = await restoreWorkspacePresentationSnapshot(session);
    if (!workspaceHydrationCoordinator.isSessionCurrent(session)) return;
    await hydrate({ blocking: !restored });
  }

  const baseTasks = state.tasks;
  const agentCalendarTasks = useMemo(() => {
    const missionTitles = new Map(agentOperations.missions.map((mission) => [mission.id, mission.title]));
    return agentOperations.tasks.map((task): Item => ({
      ...agentTaskCalendarRecord(task),
      agentMissionTitle: missionTitles.get(task.missionId) || '',
    }));
  }, [agentOperations.missions, agentOperations.tasks]);
  const tasks = useMemo(() => {
    const agentTaskIds = new Set(agentCalendarTasks.map((task) => text(task.id)));
    return [
      ...baseTasks.filter((task) => !agentTaskIds.has(text(task.id))),
      ...agentCalendarTasks,
    ];
  }, [agentCalendarTasks, baseTasks]);
  const events = useMemo(() => [
    ...state.events
      .map((event) => ({ ...event, kind: 'calendar-event' })),
  ], [state.events]);
  const agents = useMemo(() => mergeAgentsWithProfileReadiness(state.agents, state.profileReadiness), [state.agents, state.profileReadiness]);
  const agentRoster = useMemo<AgentRosterEntry[]>(() => agents.map((agent, index) => ({
    id: itemId(agent, `agent-${index}`),
    displayName: agentDisplayName(agent),
    status: agentStatusLabel(agent),
    enabled: agent.enabled !== false,
    model: text(agent.model || agent.defaultExecutionEngine, 'Recommended'),
    role: text(agent.role || agent.persona),
    provider: text(agent.provider || agent.runtime || agent.source, agentSourceKind(agent) === 'native' ? 'agent-calendar' : '연결 정보 없음'),
    trustLevel: text(agent.trustLevel || agent.trust, '확인 필요'),
    allowedTaskClasses: stringList(agent, 'allowedTaskClasses'),
    responsibility: text(agent.responsibility || agent.persona),
    instructions: text(agent.instructions),
    responseStyle: text(agent.responseStyle || agent.style),
    specialties: stringList(agent, 'specialties').length
      ? stringList(agent, 'specialties')
      : stringList(agent, 'allowedTaskClasses'),
    memories: stringList(agent, 'memories'),
    profileVersion: Math.max(1, Number(agent.profileVersion) || 1),
    lifecycle: agentBuilderLifecycleFrom(agent),
    sourceKind: agentSourceKind(agent),
    externalAgentId: text(agent.externalAgentId || agent.profileId || agent.profileName),
    connectionStatus: text(agent.connectionStatus || agent.hermesProfileStatus || agent.status),
    defaultExecutionEngine: (['auto', 'codex', 'claude', 'grok', 'hermes', 'local_llm'].includes(text(agent.defaultExecutionEngine).toLowerCase())
      ? text(agent.defaultExecutionEngine).toLowerCase()
      : 'auto') as AgentExecutionEngine,
    defaultRunnerId: text(agent.defaultRunnerId),
    emoji: text(agent.emoji),
  })), [agents]);
  const hermesAutomationJobs = useMemo(() => parseConnectedAutomations(state.automation), [state.automation]);
  const onboardingReadiness = useMemo(() => buildOnboardingReadiness({
    calendarSources,
    runners: automationRunners,
    knowledgeSources: arr(state.wiki, 'sources'),
    calendarAiConversationId,
    calendarAiAvailable: state.settings.calendarAiAvailable === true
      || text(state.settings.calendarAiMode) === 'cloud_model',
  }), [
    automationRunners,
    calendarAiConversationId,
    calendarSources,
    state.settings,
    state.wiki,
  ]);
  const onboardingState = obj(state.settings, 'onboarding');
  const onboardingStatus = text(onboardingState.status);
  const onboardingPending = !['completed', 'dismissed'].includes(onboardingStatus);
  const runs = state.runs;
  const selectedRun = runs.find((run, index) => itemId(run, `run-${index}`) === selectedRunId) || runs[0];
  const accountName = settings.authProfile?.name || 'Yunseo';
  const accountEmail = settings.authProfile?.email || 'yunseo@agent.calendar';
  const accountInitial = (accountName || accountEmail || 'A').trim().slice(0, 1).toUpperCase();
  const accountProviderLabel = settings.authProfile?.provider === 'authkit'
    ? 'AuthKit 로그인'
    : settings.authProfile?.provider === 'google'
      ? 'Google 로그인'
      : settings.authProfile?.provider === 'password'
        ? '이메일 로그인'
        : '세션 없음';
  const connectivityCopy = connectivityPresentation(
    desktopConnectivity,
    (value) => new Intl.DateTimeFormat('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value)),
  );
  const showDesktopConnectivity = loggedIn && [
    'offline',
    'reconnecting',
    'recovered',
  ].includes(desktopConnectivity.status);
  const showGlobalApiBanner = Boolean(
    apiError
    && screen !== 'agents'
    && !['offline', 'reconnecting'].includes(desktopConnectivity.status),
  );
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
      items: entries.map((entry) => ({ id: 'tasks' as ScreenId, navKey: taxonomyNavKey('list', entry.id), icon: 'list' as const, label: entry.label })),
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
      items: entries.map((entry) => ({ id: 'tasks' as ScreenId, navKey: taxonomyNavKey('tag', entry.id), icon: 'tag' as const, label: entry.label })),
    }));
    if (!dynamicListGroups.some((group) => group.group === '리스트')) dynamicListGroups.push({ title: '리스트', kind: 'list', group: '리스트', items: [] });
    if (!dynamicTagGroups.length) dynamicTagGroups.push({ title: '태그', kind: 'tag', group: '태그', items: [] });
    return [...dynamicListGroups, ...dynamicTagGroups];
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
        const proxyConnection = await window.hermesDesktop.getHermesConnection();
        if (desktopSettings && !cancelled) {
          localUiPreferencesRef.current = readUiPreferences(desktopSettings);
          setSettings(desktopSettingsState(desktopSettings));
          const signedIn = desktopSettingsSignedIn(desktopSettings);
          setLoggedIn(signedIn);
          setApiProxyConnection(proxyConnection);
          if (signedIn) {
            await startSignedInWorkspace();
          } else {
            resetWorkspaceClientState();
            setLoading(false);
          }
          return;
        }
        setApiProxyConnection(proxyConnection);
        if (!cancelled) setLoading(false);
      } catch (error) {
        if (!cancelled) {
          setApiError(error instanceof Error ? error.message : 'Electron 설정을 불러오지 못했습니다.');
          setLoading(false);
        }
      }
    }
    void boot();
    const offSession = window.hermesDesktop?.onAuthSessionChanged?.((next) => {
      if (cancelled) return;
      const signedIn = desktopSettingsSignedIn(next);
      setSettings(desktopSettingsState(next));
      setLoggedIn(signedIn);
      setAuthBusy(false);
      setAuthPhase('idle');
      setLoginStatus('');
      if (signedIn) {
        void startSignedInWorkspace();
      } else {
        resetWorkspaceClientState();
        setLoading(false);
      }
    });
    const offError = window.hermesDesktop?.onAuthLoginError?.((error) => {
      if (cancelled) return;
      setAuthBusy(false);
      setAuthPhase('error');
      setLoginStatus(error?.message || '로그인에 실패했습니다.');
    });
    return () => {
      cancelled = true;
      offSession?.();
      offError?.();
    };
  }, []);

  useEffect(() => {
    const bridge = window.hermesDesktop;
    if (!bridge) return undefined;
    let cancelled = false;
    void Promise.all([
      bridge.getDesktopReleaseStatus(),
      bridge.consumeDesktopRecoveryStatus(),
    ]).then(([releaseStatus, recoveryStatus]) => {
      if (cancelled) return;
      setDesktopReleaseStatus(releaseStatus);
      if (recoveryStatus.phase !== 'none') {
        setDesktopRecoveryStatus(recoveryStatus);
      }
    }).catch(() => {
      if (!cancelled) {
        setDesktopReleaseError('업데이트 상태를 불러오지 못했습니다.');
      }
    });
    const offRelease = bridge.onDesktopReleaseStatus((releaseStatus) => {
      if (!cancelled) setDesktopReleaseStatus(releaseStatus);
    });
    return () => {
      cancelled = true;
      offRelease();
    };
  }, []);

  async function runDesktopReleaseAction(action: 'check' | 'download' | 'install') {
    const bridge = window.hermesDesktop;
    if (!bridge || desktopReleaseBusy) return;
    setDesktopReleaseBusy(action);
    setDesktopReleaseError('');
    try {
      const next = action === 'check'
        ? await bridge.checkDesktopRelease()
        : action === 'download'
          ? await bridge.downloadDesktopRelease()
          : await bridge.installDesktopRelease();
      setDesktopReleaseStatus(next);
    } catch (error) {
      setDesktopReleaseError(
        error instanceof Error ? error.message : '업데이트 작업을 완료하지 못했습니다.',
      );
    } finally {
      setDesktopReleaseBusy('');
    }
  }

  // Live refresh: while Agent Ops is open, poll Workspace Runner + mission aggregate so
  // enrollment/connect and durable checkpoints appear without a manual page reload.
  useEffect(() => {
    if (screen !== 'agents' || !loggedIn) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await refreshAgentOperations();
      } catch {
        /* keep prior state; next tick retries */
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [screen, loggedIn]);

  useEffect(() => {
    if (!loggedIn) return undefined;
    const markBrowserOffline = () => {
      setDesktopConnectivity((current) => markConnectivityOffline(current, {
        at: new Date().toISOString(),
        message: '네트워크 연결이 끊겼습니다.',
      }));
    };
    const retryWhenBrowserReturns = () => {
      setDesktopConnectivity((current) => beginConnectivityRetry(current));
      void hydrate({ blocking: false });
    };
    window.addEventListener('offline', markBrowserOffline);
    window.addEventListener('online', retryWhenBrowserReturns);
    return () => {
      window.removeEventListener('offline', markBrowserOffline);
      window.removeEventListener('online', retryWhenBrowserReturns);
    };
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn || desktopConnectivity.status !== 'offline') return undefined;
    const timer = window.setTimeout(() => {
      setDesktopConnectivity((current) => beginConnectivityRetry(current));
      void hydrate({ blocking: false });
    }, offlineRetryDelayMs(desktopConnectivity.retryAttempt));
    return () => window.clearTimeout(timer);
  }, [
    desktopConnectivity.retryAttempt,
    desktopConnectivity.status,
    loggedIn,
  ]);

  useEffect(() => {
    if (desktopConnectivity.status !== 'recovered') return undefined;
    const timer = window.setTimeout(() => {
      setDesktopConnectivity((current) => settleRecoveredConnectivity(current));
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [desktopConnectivity.status]);

  async function hydrate(options: { blocking?: boolean } = {}) {
    const hydrationTicket = window.hermesDesktop
      ? workspaceHydrationCoordinator.beginCurrentHydration()
      : null;
    if (window.hermesDesktop && !hydrationTicket) return;
    const isHydrationCurrent = () => (
      !hydrationTicket || workspaceHydrationCoordinator.isCurrent(hydrationTicket)
    );
    const blocking = options.blocking ?? !hasHydratedRef.current;
    if (blocking) setLoading(true);
    setApiError('');
    setAgentOperationsError('');
    try {
      let gatewayStatus: ApiEnvelope;
      try {
        gatewayStatus = await hermesApi.getGatewayStatus();
      } catch (error) {
        if (!isHydrationCurrent()) return;
        const message = error instanceof Error
          ? error.message
          : 'Railway 연결을 확인하지 못했습니다.';
        setDesktopConnectivity((current) => markConnectivityOffline(current, {
          at: new Date().toISOString(),
          message,
        }));
        setApiError(message);
        return;
      }
      const optionalRequest = (label: string, request: Promise<ApiEnvelope>, fallback: ApiEnvelope = {}, options: { quiet?: boolean } = {}) => request.catch((error) => {
        if (!isHydrationCurrent()) return fallback;
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code || '')
          : '';
        // Never surface explicit production_disabled connector contracts as a global hydrate banner.
        if (code === 'production_disabled' || options.quiet) {
          return fallback;
        }
        setApiError(error instanceof Error ? error.message : `${label} 불러오기 실패`);
        return fallback;
      });
      const settingsRequest = optionalRequest('설정', hermesApi.getSettings(), {}, { quiet: true });
      const dashboardRequest = optionalRequest('상태', hermesApi.getDashboardState());
      const tasksRequest = optionalRequest('작업', hermesApi.getTasks());
      const now = new Date();
      const fromIso = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const toIso = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59).toISOString();
      const eventsRequest = hermesApi.getUnifiedCalendar({ from: fromIso, to: toIso })
        .then((payload) => payload)
        .catch(() => hermesApi.getCalendarEvents());
      const calendarSourcesRequest = optionalRequest('캘린더 소스', hermesApi.getCalendarSources(), { sources: [] }, { quiet: true });
      const agentsRequest = optionalRequest('에이전트', hermesApi.getAgents());
      const wikiRequest = optionalRequest('위키', hermesApi.getWiki(), state.wiki);
      const inboxRequest = hermesApi.getMailMessages()
        .then((payload) => {
          if (isHydrationCurrent()) setMailLoadError('');
          return payload;
        })
        .catch((error) => {
          if (!isHydrationCurrent()) return { ok: false, items: state.inbox };
          const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: string }).code || '')
            : '';
          // Production Workspace mode disables mail connectors explicitly — do not block hydrate.
          if (code === 'production_disabled') {
            setMailLoadError('');
            return { ok: false, items: [], productionDisabled: true };
          }
          const message = error instanceof Error ? error.message : '메일함 불러오기 실패';
          setMailLoadError(message);
          setApiError(message);
          return { ok: false, items: state.inbox };
        });
      const documentsRequest = optionalRequest('문서', hermesApi.getDocuments());
      const automationRequest = optionalRequest(
        '자동화',
        hermesApi.listConnectedAutomations(),
        { automations: [] },
        { quiet: true },
      );
      const automationSourcesRequest = optionalRequest(
        '자동화 소스',
        hermesApi.listAutomationSources(),
        { sources: [] },
        { quiet: true },
      );
      const automationRunnersRequest = optionalRequest(
        'Runner',
        hermesApi.listRunners(),
        { runners: [] },
        { quiet: true },
      );
      const usageRequest = optionalRequest('사용량', hermesApi.getUsage());
      const toolsRequest = optionalRequest('도구', hermesApi.getTools());
      const channelsRequest = optionalRequest('채널', hermesApi.getChannels());
      const chatRequest = optionalRequest('채팅', hermesApi.getChatMessages());
      const calendarAiMemoryRequest = optionalRequest('개인 기억', hermesApi.listCalendarAiMemories(), { memories: [] }, { quiet: true });
      const agentOperationsRequest = hermesApi.getAgentOperations()
        .then(parseAgentOperationsEnvelope)
        .then((next) => {
          if (!isHydrationCurrent()) return null;
          setAgentOperations(next);
          return next;
        })
        .catch((error) => {
          if (isHydrationCurrent()) {
            setAgentOperationsError(error instanceof Error ? error.message : 'Agent Operations 불러오기 실패');
          }
          return null;
        });
      const [dashboard, tasksPayload, eventsPayload, agentsPayload, wiki, inbox, automation, automationSourcesPayload, automationRunnersPayload, usage, tools, settingsPayload, channels, documentsPayload, chatPayload, calendarSourcesPayload, calendarAiMemoryPayload] = await Promise.all([
        dashboardRequest,
        tasksRequest,
        eventsRequest,
        agentsRequest,
        wikiRequest,
        inboxRequest,
        automationRequest,
        automationSourcesRequest,
        automationRunnersRequest,
        usageRequest,
        toolsRequest,
        settingsRequest,
        channelsRequest,
        documentsRequest,
        chatRequest,
        calendarSourcesRequest,
        calendarAiMemoryRequest,
      ]);
      if (!isHydrationCurrent()) return;
      const rawTasks = arr(tasksPayload, 'tasks');
      const taxonomyRecords = rawTasks.filter(isTaxonomyRecord);
      const tasks = rawTasks.filter(isTaskRecord);
      const unifiedEntries = Array.isArray((eventsPayload as { entries?: unknown[] })?.entries)
        ? (eventsPayload as { entries: Array<Record<string, unknown>> }).entries
        : null;
      const events = unifiedEntries
        ? mapUnifiedEntriesToCalendarEvents(unifiedEntries as never).map(normalizeCalendarEvent)
        : [
          ...arr(eventsPayload, 'events', 'calendarEvents').map(normalizeCalendarEvent),
          ...rawTasks.filter(isCalendarEventRecord).map(normalizeCalendarEvent),
        ];
      const coverage = Array.isArray((eventsPayload as { coverage?: unknown[] })?.coverage)
        ? (eventsPayload as { coverage: Array<Record<string, unknown>> }).coverage
        : [];
      const nextSources = arr(calendarSourcesPayload, 'sources');
      const nextCoverageNote = coverageSummary((coverage || []) as never);
      const nextAutomationSources = parseConnectedAutomationSources(arr(automationSourcesPayload, 'sources'));
      const nextAutomationRunners = arr(automationRunnersPayload, 'runners') as PublicRunner[];
      setCalendarSources(nextSources as Item[]);
      setCalendarCoverageNote(nextCoverageNote);
      setConnectedAutomationSources(nextAutomationSources);
      setAutomationRunners(nextAutomationRunners);
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
      const scheduleChat = remoteChat.filter((message) => text(message.target) === 'calendar');
      const normalizedScheduleChat = normalizeCalendarChatHistory(remoteChat);
      const nextConversationId = text(chatPayload.conversationId);
      const nextCalendarAiMemories = arr(calendarAiMemoryPayload, 'memories');
      const nextState: AppState = {
        tasks,
        events,
        agents,
        runs,
        docs,
        inbox: inboxItems,
        automation: arr(automation, 'automations'),
        channels: arr(channels, 'channels'),
        sessions: arr(dashboard, 'sessions'),
        tools: arr(tools, 'tools', 'skills', 'toolsets'),
        chatMessages: scheduleChat,
        taxonomy: taxonomyRecords,
        wiki,
        settings: settingsPayload,
        usage,
        gatewayStatus,
        profileReadiness: obj(dashboard, 'profileReadiness'),
        agentSourceStatus: obj(dashboard, 'agentSourceStatus'),
      };
      setCalendarAiConversationId(nextConversationId);
      setCalendarAiMemories(nextCalendarAiMemories);
      setState(nextState);
      const hydratedOnboarding = obj(settingsPayload, 'onboarding');
      const hydratedOnboardingStatus = text(hydratedOnboarding.status);
      if (
        !hasHydratedRef.current
        && !['completed', 'dismissed'].includes(hydratedOnboardingStatus)
      ) {
        setScreen('onboarding');
        setActiveNavKey('onboarding');
      }
      const hydratedPreferences = localUiPreferencesRef.current || readUiPreferences(settingsPayload);
      setPrefs(hydratedPreferences);
      setSettings((current) => ({ ...current, uiPreferences: hydratedPreferences }));
      setChatMessages(normalizedScheduleChat);
      hasHydratedRef.current = true;
      let synchronizedAt = new Date().toISOString();
      if (window.hermesDesktop?.saveWorkspaceSnapshot) {
        try {
          if (!hydrationTicket) return;
          const persisted = await window.hermesDesktop.saveWorkspaceSnapshot({
            sessionId: hydrationTicket.sessionId,
            generation: hydrationTicket.generation,
            data: {
              presentationSchemaVersion: 1,
              state: nextState,
              agentOperations,
              calendarSources: nextSources,
              calendarCoverageNote: nextCoverageNote,
              connectedAutomationSources: nextAutomationSources,
              automationRunners: nextAutomationRunners,
              calendarAiMemories: nextCalendarAiMemories,
              calendarAiConversationId: nextConversationId,
              chatMessages: normalizedScheduleChat,
            },
          });
          if (!isHydrationCurrent()) return;
          synchronizedAt = persisted.savedAt;
        } catch {
          if (isHydrationCurrent()) {
            setApiError('오프라인 보관본을 안전하게 저장하지 못했습니다.');
          }
        }
        void agentOperationsRequest.then((next) => {
          if (!next || !hydrationTicket || !isHydrationCurrent()) return;
          void window.hermesDesktop?.saveWorkspaceSnapshot({
            sessionId: hydrationTicket.sessionId,
            generation: hydrationTicket.generation,
            data: {
              presentationSchemaVersion: 1,
              state: nextState,
              agentOperations: next,
              calendarSources: nextSources,
              calendarCoverageNote: nextCoverageNote,
              connectedAutomationSources: nextAutomationSources,
              automationRunners: nextAutomationRunners,
              calendarAiMemories: nextCalendarAiMemories,
              calendarAiConversationId: nextConversationId,
              chatMessages: normalizedScheduleChat,
            },
          }).catch(() => {
            if (isHydrationCurrent()) {
              setApiError('오프라인 보관본을 안전하게 저장하지 못했습니다.');
            }
          });
        });
      }
      if (!isHydrationCurrent()) return;
      setDesktopConnectivity((current) => markConnectivityOnline(
        current,
        synchronizedAt,
      ));
    } catch (error) {
      if (isHydrationCurrent()) {
        setApiError(error instanceof Error ? error.message : 'Railway API 응답 실패');
      }
    } finally {
      if (isHydrationCurrent() && (blocking || !hasHydratedRef.current)) setLoading(false);
    }
  }

  async function loginWithAuthKit() {
    setLoginStatus('');
    setAuthBusy(true);
    setAuthPhase('opening');
    try {
      if (!window.hermesDesktop?.loginWithAuthKit) {
        setLoginStatus('Electron 로그인 브리지가 없습니다.');
        setAuthPhase('error');
        return;
      }
      setAuthPhase('waiting');
      const next = await window.hermesDesktop.loginWithAuthKit();
      setSettings(desktopSettingsState(next));
      const signedIn = desktopSettingsSignedIn(next);
      setLoggedIn(signedIn);
      setAuthPhase('idle');
      setModal(null);
      if (signedIn) {
        await startSignedInWorkspace();
      }
    } catch (error) {
      setAuthPhase('error');
      setLoginStatus(error instanceof Error ? error.message : 'AuthKit 로그인을 완료하지 못했습니다.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    try {
      const next = await window.hermesDesktop?.logoutAuth();
      if (next) setSettings(desktopSettingsState(next));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '로그아웃 상태 저장 실패');
    }
    resetWorkspaceClientState();
    setLoggedIn(false);
    setAuthPhase('idle');
    setLoginStatus('');
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
    let created: Item | null = null;
    try {
      if (source === 'calendar') {
        const response = await hermesApi.createCalendarEvent(calendarEventPayload(task));
        const createdEvent = responseCalendarEvent(response) || task;
        if (options.requireHydrated) {
          const visible = await waitForCreatedCalendarEventInBackend(createdEvent);
          if (!visible) {
            setApiError('생성한 일정을 캘린더에서 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
            return null;
          }
        }
        created = createdEvent;
      } else {
        const response = await hermesApi.createTask(desktopTaskPayload(task));
        const createdTask = responseTask(response) || task;
        if (options.requireHydrated) {
          const visible = await waitForCreatedTaskInBackend(createdTask);
          if (!visible) {
            setApiError('생성한 작업을 목록에서 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
            return null;
          }
        }
        created = createdTask;
      }
      await hydrate();
      return created;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '작업 생성 실패');
      return options.requireHydrated ? null : created;
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
      ...(newReminderOn ? { reminder: 'at_time', reminderAt: 'at_time' } : {}),
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
    setNewReminderOn(false);
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
      return created;
    }
    const created = await persistCreatedTask(task, 'task', { requireHydrated: options.requireHydrated });
    return created;
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
    const isExternal = text(task.sourceKind) === 'external_calendar'
      || text(task.provider) === 'google'
      || text(task.source) === 'google';
    const isAgent = text(task.sourceKind) === 'agent_work'
      || text(task.source) === 'agent-work'
      || text(task.origin) === 'agent';
    if (isAgent || task.writable === false) {
      setApiError('읽기 전용 일정은 수정할 수 없습니다.');
      return false;
    }
    if (isExternal) {
      const providerEventId = text(task.providerEventId || task.entryId || id);
      const sourceId = text(task.sourceId);
      if (!providerEventId || !sourceId) {
        setApiError('외부 일정 식별자가 없어 수정할 수 없습니다.');
        return false;
      }
      const snapshot: Item = { ...task, ...patch, kind: 'calendar-event', type: 'calendar-event' };
      const date = text(snapshot.date || snapshot.startDate);
      const time = text(snapshot.time);
      const startsAt = text(snapshot.startsAt) || (date && time ? `${date}T${time}:00.000Z` : date ? `${date}T00:00:00.000Z` : '');
      const endsAt = text(snapshot.endsAt) || (date && time ? `${date}T${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}${time.slice(2)}:00.000Z` : startsAt);
      applyOptimisticEventPatch(id, snapshot);
      try {
        // Success only after provider reconcile (mutation receipt path).
        await hermesApi.updateExternalCalendarEvent(providerEventId, {
          sourceId,
          title: itemTitle(snapshot, text(task.title)),
          startsAt,
          endsAt,
          ifMatch: text(task.etag),
          idempotencyKey: `ext-upd-${providerEventId}-${Date.now()}`,
        });
        await hydrate({ blocking: false });
        return true;
      } catch (error) {
        applyOptimisticEventPatch(id, task);
        setApiError(error instanceof Error ? error.message : '외부 일정 업데이트 실패');
        return false;
      }
    }
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
    const sessionId = text(task.sessionId);
    if (text(task.origin) === 'agent' && sessionId) {
      void openAgentSession(sessionId);
      return;
    }
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
    let task: Item | null = null;
    try {
      task = await createQuickTask(textValue, todayKey(), { owner: 'Agent', status: 'Doing', source: 'task' });
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
      const taskId = itemId(task || {}, '');
      if (taskId) {
        try {
          await hermesApi.deleteTask(taskId);
          await hydrate();
        } catch (rollbackError) {
          const message = rollbackError instanceof Error ? rollbackError.message : '생성 작업 롤백 실패';
          setApiError(`미션 실행 실패 · ${message}`);
          return;
        }
      }
      setApiError(error instanceof Error ? error.message : '미션 실행 실패');
    }
  }

  async function refreshAgentOperations() {
    if (agentOperationsRefreshPromiseRef.current) return agentOperationsRefreshPromiseRef.current;
    const request = (async () => {
      const [operationsPayload, runnersPayload] = await Promise.all([
        hermesApi.getAgentOperations(),
        hermesApi.listRunners(),
      ]);
      const next = parseAgentOperationsEnvelope(operationsPayload);
      setAgentOperations(next);
      setAutomationRunners(arr(runnersPayload, 'runners') as PublicRunner[]);
    })();
    agentOperationsRefreshPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (agentOperationsRefreshPromiseRef.current === request) agentOperationsRefreshPromiseRef.current = null;
    }
  }

  async function retryAgentOperations(): Promise<boolean> {
    setAgentOperationsBusy('refresh');
    try {
      await refreshAgentOperations();
      setAgentOperationsError('');
      return true;
    } catch {
      setAgentOperationsError('최신 작업 상태를 불러오지 못했습니다.');
      return false;
    } finally {
      setAgentOperationsBusy('');
    }
  }

  async function refreshHermesAutomations(): Promise<void> {
    const [sourcesPayload, automationsPayload, runnersPayload] = await Promise.all([
      hermesApi.listAutomationSources(),
      hermesApi.listConnectedAutomations(),
      hermesApi.listRunners(),
    ]);
    setConnectedAutomationSources(parseConnectedAutomationSources(arr(sourcesPayload, 'sources')));
    setAutomationRunners(arr(runnersPayload, 'runners') as PublicRunner[]);
    setState((current) => ({ ...current, automation: arr(automationsPayload, 'automations') }));
  }

  function automationRequestId(operation: string, identity = ''): string {
    const nonce = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `desktop-${operation}-${identity || 'new'}-${nonce}`;
  }

  async function applyAutomationChange(input: {
    sourceId: string;
    operation: 'create' | 'update' | 'pause' | 'resume' | 'run';
    automationId?: string;
    expectedRevision?: string;
    values?: Record<string, unknown>;
  }): Promise<AutomationMutationOutcome> {
    const result = await hermesApi.requestAutomationChange({
      sourceId: input.sourceId,
      operation: input.operation,
      automationId: input.automationId || '',
      expectedRevision: input.expectedRevision || '',
      input: input.values || {},
      requestId: automationRequestId(input.operation, input.automationId),
    });
    const change = obj(result, 'change');
    if (text(change.status) === 'pending_approval') {
      const changeId = itemId(change, '');
      if (!changeId) throw new Error('승인할 자동화 변경을 찾지 못했습니다.');
      return { approvalId: changeId };
    }
    const receipt = obj(result, 'receipt');
    const status = text(receipt.status);
    if (status && status !== 'succeeded') {
      await refreshHermesAutomations();
      if (status === 'unknown') throw new Error('출처 응답이 확정되지 않았습니다. 출처에서 상태를 확인해 주세요.');
      if (status === 'conflict') throw new Error('출처의 자동화가 먼저 변경되었습니다. 최신 상태를 확인해 주세요.');
      throw new Error(text(receipt.errorMessage, '출처에서 자동화 변경을 적용하지 못했습니다.'));
    }
    return {};
  }

  async function connectAutomationSource(input: {
    runnerId: string;
    adapterKind: string;
    displayName: string;
  }): Promise<void> {
    const result = await hermesApi.connectAutomationSource({
      ...input,
      requestId: automationRequestId('connect', input.runnerId),
      connectionRef: { runnerId: input.runnerId },
    });
    const sourceId = itemId(obj(result, 'source'), '');
    if (!sourceId) throw new Error('연결된 자동화 소스를 확인하지 못했습니다.');
    await hermesApi.syncAutomationSource(sourceId);
  }

  async function syncAutomationSource(sourceId: string): Promise<void> {
    await hermesApi.syncAutomationSource(sourceId);
  }

  async function approveConnectedAutomationChange(changeId: string): Promise<void> {
    const result = await hermesApi.approveAutomationChange(changeId, {
      requestId: automationRequestId('approve', changeId),
    });
    const receipt = obj(result, 'receipt');
    const status = text(receipt.status);
    if (status && status !== 'succeeded') {
      await refreshHermesAutomations();
      if (status === 'unknown') throw new Error('출처 응답이 확정되지 않았습니다. 출처에서 상태를 확인해 주세요.');
      if (status === 'conflict') throw new Error('출처의 자동화가 먼저 변경되었습니다. 최신 상태를 확인해 주세요.');
      throw new Error(text(receipt.errorMessage, '출처에서 승인한 변경을 적용하지 못했습니다.'));
    }
  }

  async function createConnectedAutomation(input: HermesAutomationUpdateInput & { sourceId: string }): Promise<AutomationMutationOutcome> {
    return applyAutomationChange({
      sourceId: input.sourceId,
      operation: 'create',
      values: {
        name: input.name,
        goal: input.goal,
        agentId: input.agentId,
        schedule: input.schedule,
      },
    });
  }

  async function updateConnectedAutomation(job: HermesAutomationJob, input: HermesAutomationUpdateInput): Promise<AutomationMutationOutcome> {
    return applyAutomationChange({
      sourceId: job.sourceId,
      automationId: job.id,
      expectedRevision: job.sourceRevision,
      operation: 'update',
      values: input,
    });
  }

  async function setConnectedAutomationEnabled(job: HermesAutomationJob, enabled: boolean): Promise<AutomationMutationOutcome> {
    return applyAutomationChange({
      sourceId: job.sourceId,
      automationId: job.id,
      expectedRevision: job.sourceRevision,
      operation: enabled ? 'resume' : 'pause',
    });
  }

  async function runConnectedAutomation(job: HermesAutomationJob): Promise<AutomationMutationOutcome> {
    return applyAutomationChange({
      sourceId: job.sourceId,
      automationId: job.id,
      expectedRevision: job.sourceRevision,
      operation: 'run',
    });
  }

  async function runAgentOperation<T>(busyKey: string, operation: () => Promise<T>): Promise<T | null> {
    setAgentOperationsBusy(busyKey);
    setAgentOperationsError('');
    try {
      try {
        const result = await operation();
        try {
          await refreshAgentOperations();
        } catch (error) {
          const message = error instanceof Error ? error.message : '화면 새로고침 실패';
          setAgentOperationsError(`작업은 완료됐지만 화면 새로고침에 실패했습니다 · ${message}`);
        }
        return result;
      } catch (error) {
        setAgentOperationsError(error instanceof Error ? error.message : 'Agent Operations 요청 실패');
        return null;
      }
    } finally {
      setAgentOperationsBusy('');
    }
  }

  async function openAgentSession(sessionId: string) {
    if (!sessionId) return;
    openScreen('agents');
    setSelectedAgentSessionId(sessionId);
    setAgentSessionDetail((current) => current?.id === sessionId ? current : null);
    setAgentSessionLoading(true);
    setAgentOperationsError('');
    try {
      const detail = parseAgentSessionEnvelope(await hermesApi.getAgentSession(sessionId));
      if (!detail) throw new Error('Task Session 응답이 비어 있습니다.');
      setAgentSessionDetail(detail);
    } catch (error) {
      setAgentOperationsError(error instanceof Error ? error.message : 'Task Session 불러오기 실패');
    } finally {
      setAgentSessionLoading(false);
    }
  }

  async function continueAgentSession(sessionId: string, message: string) {
    if (!sessionId) return false;
    setAgentSessionMessageBusy(true);
    setAgentOperationsError('');
    try {
      await hermesApi.sendAgentSessionMessage(sessionId, message);
      await Promise.all([
        refreshAgentOperations(),
        openAgentSession(sessionId),
      ]);
      return true;
    } catch (error) {
      setAgentOperationsError(error instanceof Error ? error.message : 'Task Session 메시지 전송 실패');
      return false;
    } finally {
      setAgentSessionMessageBusy(false);
    }
  }

  function closeAgentSession() {
    setSelectedAgentSessionId('');
    setAgentSessionDetail(null);
  }

  async function createAgentMission(input: AgentMissionCreateInput) {
    return runAgentOperation('create', () => createAgentWork(input));
  }

  async function planAgentMission(missionId: string) {
    await runAgentOperation(missionId, () => hermesApi.planAgentMission(missionId));
  }

  async function approveAgentMissionPlan(missionId: string) {
    await runAgentOperation(missionId, async () => {
      const proposedTasks = agentOperations.tasks.filter((task) => (
        task.missionId === missionId && task.status === 'proposed'
      ));
      await Promise.all(proposedTasks.map((task) => hermesApi.transitionAgentTask(task.id, 'approve')));
      return hermesApi.activateAgentMission(missionId);
    });
  }

  async function transitionAgentOperationTask(taskId: string, action: AgentTaskAction) {
    const succeeded = (await runAgentOperation(taskId, () => hermesApi.transitionAgentTask(taskId, action))) !== null;
    const selectedTask = agentOperations.tasks.find((task) => task.id === taskId);
    if (selectedTask?.sessionId === selectedAgentSessionId) {
      await openAgentSession(selectedAgentSessionId);
    }
    return succeeded;
  }

  async function runAgentOperationTaskNow(taskId: string) {
    await runAgentOperation(taskId, () => hermesApi.runAgentTaskNow(taskId));
    const selectedTask = agentOperations.tasks.find((task) => task.id === taskId);
    if (selectedTask?.sessionId === selectedAgentSessionId) {
      await openAgentSession(selectedAgentSessionId);
    }
  }

  async function transitionAgentMissionWork(missionId: string, action: 'activate' | 'pause' | 'cancel') {
    await runAgentOperation(missionId, () => action === 'activate'
      ? hermesApi.activateAgentMission(missionId)
      : hermesApi.transitionAgentMission(missionId, action));
  }

  async function recordAgentReportFeedback(reportId: string, useful: boolean) {
    await runAgentOperation(reportId, () => hermesApi.recordAgentReportFeedback(reportId, useful));
  }

  async function recordAgentFollowUpDecision(reportId: string, index: number, decision: 'approved' | 'rejected') {
    await runAgentOperation(reportId, () => hermesApi.recordAgentFollowUpDecision(reportId, index, decision));
  }

  async function createWorkspaceAgent(input: AgentDirectoryMutationInput): Promise<boolean> {
    try {
      const payload = await hermesApi.createAgent({ ...input });
      const created = createdAgentFrom(payload);
      const createdId = agentIdentity(created);
      if (!createdId) throw new Error('에이전트 생성 응답이 비어 있습니다.');
      setState((current) => ({
        ...current,
        agents: [created, ...current.agents.filter((agent) => agentIdentity(agent) !== createdId)],
      }));
      await hydrate({ blocking: false });
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 생성 실패');
      return false;
    }
  }

  async function updateWorkspaceAgent(agentId: string, input: AgentDirectoryMutationInput): Promise<boolean> {
    try {
      const payload = await hermesApi.updateAgent(agentId, { ...input });
      const updated = createdAgentFrom(payload);
      if (!agentIdentity(updated)) throw new Error('에이전트 수정 응답이 비어 있습니다.');
      setState((current) => ({
        ...current,
        agents: current.agents.map((agent) => agentIdentity(agent) === agentId ? updated : agent),
      }));
      await hydrate({ blocking: false });
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 수정 실패');
      return false;
    }
  }

  function applyWorkspaceAgentPayload(payload: ApiEnvelope): Item | null {
    const agent = createdAgentFrom(payload);
    const id = agentIdentity(agent);
    if (!id) return null;
    setState((current) => ({
      ...current,
      agents: [agent, ...current.agents.filter((entry) => agentIdentity(entry) !== id)],
    }));
    return agent;
  }

  async function createWorkspaceAgentBuilderDraft(request: string): Promise<boolean> {
    try {
      const payload = await hermesApi.createAgentBuilderDraft({ request });
      if (!applyWorkspaceAgentPayload(payload)) throw new Error('에이전트 초안 응답이 비어 있습니다.');
      await hydrate({ blocking: false });
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 초안 생성 실패');
      return false;
    }
  }

  async function reviewWorkspaceAgentBuilderDraft(agentId: string, expectedRevision: number): Promise<boolean> {
    try {
      const payload = await hermesApi.reviewAgentBuilderDraft(agentId, { expectedRevision });
      if (!applyWorkspaceAgentPayload(payload)) throw new Error('에이전트 검토 응답이 비어 있습니다.');
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 검토 실패');
      return false;
    }
  }

  async function testWorkspaceAgentBuilderDraft(
    agentId: string,
    expectedRevision: number,
  ): Promise<AgentBuilderTestRequest | null> {
    try {
      const payload = await hermesApi.startAgentBuilderTest(agentId, {
        expectedRevision,
        timeoutMs: 30_000,
      });
      applyWorkspaceAgentPayload(payload);
      const request = agentBuilderTestFrom(payload);
      if (!request) throw new Error('에이전트 테스트 응답이 비어 있습니다.');
      return request;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 테스트 실패');
      return null;
    }
  }

  async function refreshWorkspaceAgentBuilderTest(
    agentId: string,
    requestId: string,
  ): Promise<AgentBuilderTestRequest | null> {
    try {
      const payload = await hermesApi.getAgentBuilderTest(agentId, requestId);
      applyWorkspaceAgentPayload(payload);
      return agentBuilderTestFrom(payload);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 테스트 상태 조회 실패');
      return null;
    }
  }

  async function cancelWorkspaceAgentBuilderTest(agentId: string, requestId: string): Promise<boolean> {
    try {
      const payload = await hermesApi.cancelAgentBuilderTest(agentId, requestId);
      applyWorkspaceAgentPayload(payload);
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 테스트 취소 실패');
      return false;
    }
  }

  async function activateWorkspaceAgentBuilderProfile(
    agentId: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<boolean> {
    try {
      const payload = await hermesApi.activateAgentBuilderProfile(agentId, {
        expectedRevision,
        requestId,
      });
      if (!applyWorkspaceAgentPayload(payload)) throw new Error('에이전트 활성화 응답이 비어 있습니다.');
      await hydrate({ blocking: false });
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 활성화 실패');
      return false;
    }
  }

  async function loadWorkspaceAgentProfileVersions(agentId: string): Promise<readonly AgentProfileVersion[]> {
    try {
      const payload = await hermesApi.listAgentProfileVersions(agentId);
      return arr(payload, 'versions').map((version) => ({
        agentId: text(version.agentId, agentId),
        profileVersion: Math.max(1, Number(version.profileVersion) || 1),
        profileSnapshot: obj(version, 'profileSnapshot'),
        testEvidence: obj(version, 'testEvidence'),
        activatedAt: text(version.activatedAt),
        historicalJobs: arr(version, 'historicalJobs').map((job) => ({
          id: text(job.id),
          name: text(job.name),
          profileVersion: Math.max(1, Number(job.profileVersion) || 1),
        })),
      }));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '프로필 버전 기록 조회 실패');
      return [];
    }
  }

  async function requestAgentCatalog(input: Readonly<{
    runnerId: string;
    provider: string;
    consent: true;
  }>): Promise<AgentCatalogRequest | null> {
    try {
      const payload = await hermesApi.requestAgentCatalog({ ...input });
      return obj(payload, 'request') as unknown as AgentCatalogRequest;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 목록 요청 실패');
      return null;
    }
  }

  async function getAgentCatalogRequest(requestId: string): Promise<AgentCatalogRequest | null> {
    try {
      const payload = await hermesApi.getAgentCatalogRequest(requestId);
      return obj(payload, 'request') as unknown as AgentCatalogRequest;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 목록 확인 실패');
      return null;
    }
  }

  async function importAgentCatalogEntry(
    requestId: string,
    input: Readonly<{ externalAgentId: string; defaultExecutionEngine: AgentExecutionEngine }>,
  ): Promise<boolean> {
    try {
      const payload = await hermesApi.importAgentCatalogEntry(requestId, { ...input });
      const imported = createdAgentFrom(payload);
      const importedId = agentIdentity(imported);
      if (!importedId) throw new Error('가져온 에이전트 응답이 비어 있습니다.');
      setState((current) => ({
        ...current,
        agents: [imported, ...current.agents.filter((agent) => agentIdentity(agent) !== importedId)],
      }));
      await hydrate({ blocking: false });
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 가져오기 실패');
      return false;
    }
  }

  async function listProviderAgentSessions(
    agentId: string,
    search: string,
    archived: boolean,
  ): Promise<readonly ProviderAgentSession[]> {
    try {
      const payload = await hermesApi.listProviderAgentSessions(agentId, { search, archived });
      return arr(payload, 'sessions') as unknown as ProviderAgentSession[];
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 세션 조회 실패');
      return [];
    }
  }

  async function requestProviderSessionCatalog(
    agentId: string,
    input: Readonly<{ runnerId: string; consent: true }>,
  ): Promise<ProviderSessionCatalogRequest | null> {
    try {
      const payload = await hermesApi.requestProviderSessionCatalog(agentId, { ...input });
      return obj(payload, 'request') as unknown as ProviderSessionCatalogRequest;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '기존 세션 목록 요청 실패');
      return null;
    }
  }

  async function importProviderSessionCatalogEntry(
    agentId: string,
    requestId: string,
    externalSessionId: string,
  ): Promise<ProviderSessionImportResult | null> {
    try {
      const payload = await hermesApi.importProviderSessionCatalogEntry(
        agentId,
        requestId,
        { externalSessionId },
      );
      const session = obj(payload, 'session') as unknown as ProviderAgentSession;
      const missionId = text(payload.missionId);
      const workConversationId = text(payload.workConversationId);
      if (!session.id || !missionId || !workConversationId) {
        throw new Error('가져온 provider 세션 응답이 비어 있습니다.');
      }
      await hydrate({ blocking: false });
      return { session, missionId, workConversationId };
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '기존 provider 세션 가져오기 실패');
      return null;
    }
  }

  async function updateProviderAgentSession(
    sessionId: string,
    patch: Readonly<{ title?: string; archived?: boolean }>,
  ): Promise<ProviderAgentSession | null> {
    try {
      const payload = await hermesApi.updateProviderAgentSession(sessionId, { ...patch });
      return obj(payload, 'session') as unknown as ProviderAgentSession;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '에이전트 세션 수정 실패');
      return null;
    }
  }

  async function createAgent() {
    const name = newAgentName.trim();
    if (!name) return;
    const succeeded = await createWorkspaceAgent({
      displayName: name,
      role: newAgentRole || '사용자 정의 에이전트',
      responsibility: '',
      instructions: '',
      specialties: [],
      responseStyle: '',
      memories: [],
      sourceKind: 'native',
      provider: 'agent-calendar',
      externalAgentId: '',
      defaultExecutionEngine: 'auto',
      defaultRunnerId: '',
    });
    if (succeeded) {
      setNewAgentName('');
      setNewAgentRole('');
      setNewAgentEmoji('🤖');
      setModal(null);
    }
  }

  async function registerScheduleDrafts(drafts: ScheduleDraft[]) {
    const selected = selectedScheduleDrafts(drafts);
    if (!selected.length) return;
    const registered: ScheduleDraft[] = [];
    for (const draft of selected) {
      const item = scheduleDraftRegistrationItem(draft);
      const ok = draft.kind === 'event'
        ? await persistCreatedTask(item, 'calendar')
        : await persistCreatedTask(item, 'task');
      if (ok) registered.push(draft);
    }
    if (registered.length) {
      const summary = registered.map((draft) => `${draft.date}${draft.start ? ` ${draft.start}` : ''} ${draft.title}`).join('\n');
      setChatMessages((current) => [...current, { role: 'assistant', text: `${registered.length}건 등록했어요.\n${summary}` }]);
    }
  }

  async function askData(question: string, attachment: File | null = chatAttachment) {
    const scheduleItems = [...tasks, ...events.map((event) => ({ ...event, kind: 'calendar-event', type: 'calendar-event' }))];
    const computed = taskDataSummary(question, scheduleItems);
    const userText = attachment ? `${question || '사진에서 일정 추출해줘'}\n첨부: ${attachment.name}` : question;
    const waitingText = attachment
      ? '이미지에서 일정과 시간을 분석하고 있어요. 최대 3분 정도 걸릴 수 있습니다.'
      : '';
    setChatInput('');
    setChatAttachment(null);
    setChatMessages((current) => [...current, { role: 'user', text: userText }, { role: 'assistant', text: waitingText }]);
    const localAnswer = fallbackAnswer(question, computed);
    try {
      let payload: ApiEnvelope;
      if (attachment) {
        const formData = new FormData();
        formData.append('text', question);
        formData.append('image', attachment);
        payload = await hermesApi.ingestSchedule(formData);
      } else {
        payload = await hermesApi.askSchedule({
          question,
          filters: {
            from: computed.from || undefined,
            to: computed.to || undefined,
          },
        });
      }
      const data = obj(payload, 'data');
      const search = obj(payload, 'search');
      if (attachment || text(search.intent || payload.search && (payload.search as Item).intent) === 'ingest') {
        const { drafts, warnings, conflicts, summary } = normalizeScheduleIngestResponse(payload);
        setChatMessages((current) => current.map((message, index) => (
          index === current.length - 1 ? { ...message, text: summary, drafts, warnings, conflicts } : message
        )));
        return;
      }
      const answer = text(payload.answer || payload.text || data.answer || data.text).trim();
      setChatMessages((current) => current.map((message, index) => (
        index === current.length - 1 ? { ...message, text: answer || localAnswer } : message
      )));
    } catch {
      setChatMessages((current) => current.map((message, index) => (
        index === current.length - 1
          ? {
            ...message,
            text: attachment
              ? '이미지 분석을 완료하지 못했어요. 잠시 후 다시 시도하거나 더 선명한 이미지를 첨부해 주세요.'
              : localAnswer,
          }
          : message
      )));
    }
  }

  async function sendChat(messageOverride = '') {
    const message = (messageOverride || chatInput).trim();
    if (!message && !chatAttachment) return;
    if (!messageOverride && chatAttachment) {
      await askData(message, chatAttachment);
      return;
    }
    setChatBusy(true);
    setChatInput('');
    setChatMessages((current) => [...current, { role: 'user', text: message }, { role: 'assistant', text: '' }]);
    try {
      const response = await hermesApi.streamChat({
        message,
        view: 'calendar',
        agent: 'default',
        agentId: 'default',
        conversationId: calendarAiConversationId || undefined,
        requestId: crypto.randomUUID(),
      });
      await consumeConsoleChatStream(response, (answer) => {
        setChatMessages((current) => current.map((item, index) => (
          index === current.length - 1 ? { ...item, text: answer } : item
        )));
      }, (done) => {
        const next = calendarAiMessageFromDone(done);
        setCalendarAiConversationId(text(done.conversationId));
        setChatMessages((current) => current.map((item, index) => (
          index === current.length - 1 ? { ...item, ...next, text: next.text || item.text } : item
        )));
        if (next.mode?.startsWith('memory_')) {
          void hermesApi.listCalendarAiMemories().then((payload) => setCalendarAiMemories(arr(payload, 'memories')));
        }
      });
    } catch {
      setChatInput((current) => current.trim() ? current : message);
      setChatMessages((current) => current.map((item, index) => (
        index === current.length - 1
          ? {
            ...item,
            text: item.text.trim()
              ? `${item.text}\n\n응답이 중단되었습니다. 입력창의 질문으로 다시 시도해 주세요.`
              : '실시간 응답을 받지 못했습니다. 입력창의 질문으로 다시 시도해 주세요.',
          }
          : item
      )));
    } finally {
      setChatBusy(false);
    }
  }

  async function updateCalendarAiMemory(id: string, value: string) {
    const payload = await hermesApi.updateCalendarAiMemory(id, { value });
    const memory = obj(payload, 'memory');
    setCalendarAiMemories((current) => current.map((item) => (
      text(item.id) === id ? { ...item, ...memory } : item
    )));
  }

  async function forgetCalendarAiMemory(id: string) {
    const payload = await hermesApi.forgetCalendarAiMemory(id);
    const memory = obj(payload, 'memory');
    setCalendarAiMemories((current) => current.map((item) => (
      text(item.id) === id ? { ...item, ...memory } : item
    )));
  }

  async function purgeCalendarAiMemory(id: string) {
    await hermesApi.purgeCalendarAiMemory(id);
    setCalendarAiMemories((current) => current.filter((item) => text(item.id) !== id));
  }

  async function actOnCalendarAiDraft(
    draft: CalendarAiActionDraft,
    action: 'approve' | 'revise' | 'cancel',
    input: Record<string, unknown> = {},
  ) {
    setCalendarAiActionBusyId(draft.id);
    try {
      let payload: ApiEnvelope;
      if (action === 'revise') {
        payload = await hermesApi.reviseCalendarAiAction(draft.id, input);
      } else if (action === 'cancel') {
        payload = await hermesApi.cancelCalendarAiAction(draft.id);
      } else {
        const changed = Object.entries(input).some(([key, value]) => (
          value !== undefined && value !== draft.input[key]
        ));
        if (changed) await hermesApi.reviseCalendarAiAction(draft.id, input);
        payload = await hermesApi.approveCalendarAiAction(draft.id, crypto.randomUUID());
      }
      const actionDraft = obj(payload, 'actionDraft');
      const responseDraft = Object.keys(actionDraft).length ? actionDraft : obj(payload, 'draft');
      setChatMessages((current) => current.map((message) => (
        message.actionDraft?.id === draft.id
          ? {
            ...message,
            actionDraft: {
              id: text(responseDraft.id, draft.id),
              actionKind: text(responseDraft.actionKind, draft.actionKind),
              status: text(responseDraft.status, draft.status),
              input: obj(responseDraft, 'input'),
            },
          }
          : message
      )));
      if (action === 'approve') await hydrate({ blocking: false });
    } catch (error) {
      setChatMessages((current) => [...current, {
        role: 'assistant',
        text: error instanceof Error ? `작업을 처리하지 못했습니다: ${error.message}` : '작업을 처리하지 못했습니다.',
      }]);
    } finally {
      setCalendarAiActionBusyId('');
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
      if (state.wiki.knowledgeV2 === true) {
        const requestId = crypto.randomUUID();
        const payload = await hermesApi.askKnowledge({
          question,
          requestId,
          waitForRunnerMs: 0,
        });
        let presentation = parseKnowledgeV2Answer(payload);
        setWikiAnswer(presentation.answer);
        setWikiAnswerSources(presentation.sources);
        setWikiAnswerMeta(presentation.meta);
        if (presentation.jobId && text(presentation.meta.answerStatus) === 'pending') {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const job = await hermesApi.getKnowledgeSearchJob(presentation.jobId);
            presentation = parseKnowledgeV2Job(job);
            setWikiAnswer(presentation.answer);
            setWikiAnswerSources(presentation.sources);
            setWikiAnswerMeta(presentation.meta);
            if (text(presentation.meta.answerStatus) !== 'pending') break;
          }
        }
        return;
      }
      let streamState = {
        answer: '',
        sources: [] as Item[],
        meta: { provider: 'railway-hermes', agent: 'wikicurator', model: 'wikicurator', source: 'stream', gatewayFallback: false } as Item,
      };
      setWikiAnswerMeta(streamState.meta);

      const response = await hermesApi.streamChat({
        message: question,
        requestId: crypto.randomUUID(),
        view: 'wiki',
        agent: 'wikicurator',
        agentId: 'wikicurator',
        mode: 'wiki_qa_fast',
        limit: 8,
        includeJournal: wikiIncludeJournal,
        includeRaw: wikiIncludeRaw,
      });
      if (!response.ok || !response.body) throw new Error(`wiki stream ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consumeWikiBlock = (block: string) => {
        streamState = applyWikiStreamBlock(streamState, block);
        setWikiAnswer(streamState.answer);
        setWikiAnswerSources(streamState.sources);
        setWikiAnswerMeta(streamState.meta);
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer = `${buffer}${decoder.decode(value, { stream: !done })}`.replace(/\r\n/g, '\n');
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          consumeWikiBlock(block);
        }
        if (done) break;
      }
      if (buffer.trim()) consumeWikiBlock(buffer);
      if (!streamState.answer.trim()) setWikiAnswer('위키 큐레이터 답변 본문이 비어 있습니다.');
    } catch (error) {
      setWikiAnswer(error instanceof Error ? `위키 답변 실패: ${error.message}` : '위키 답변 실패');
    } finally {
      setWikiAsking(false);
    }
  }

  async function refreshKnowledgeSources() {
    const payload = await hermesApi.getKnowledgeSources();
    const sources = arr(payload, 'sources');
    setState((current) => ({
      ...current,
      wiki: {
        ...current.wiki,
        knowledgeV2: true,
        sources,
      },
    }));
  }

  async function syncCalendarSources() {
    setOnboardingMessage('');
    try {
      const list = await hermesApi.getCalendarSources();
      const sources = Array.isArray((list as { sources?: unknown[] })?.sources)
        ? (list as { sources: Array<Record<string, unknown>> }).sources
        : calendarSources;
      const now = new Date();
      const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59).toISOString();
      for (const source of sources) {
        const id = itemId(source as Item, '');
        const status = text((source as Item).status);
        if (id && (status === 'connected' || status === 'error' || status === 'syncing')) {
          await hermesApi.syncCalendarSource(id, { full: false, rangeStart, rangeEnd });
        }
      }
      await hydrate({ blocking: false });
      setOnboardingMessage('캘린더 동기화 상태를 확인했습니다.');
    } catch (error) {
      const message = error instanceof Error ? error.message : '캘린더 동기화 실패';
      setApiError(message);
      setOnboardingMessage(message);
    }
  }

  async function connectGoogleCalendar() {
    if (onboardingBusy) return;
    setOnboardingBusy(true);
    setOnboardingMessage('Google 로그인 창을 여는 중입니다.');
    try {
      if (!window.hermesDesktop?.connectGoogleCalendar) {
        throw new Error('Google Calendar 연결은 데스크톱 앱에서 사용할 수 있습니다.');
      }
      const result = await window.hermesDesktop.connectGoogleCalendar();
      await hydrate({ blocking: false });
      setOnboardingMessage(
        result.sync.ok
          ? 'Google Calendar 동기화가 완료되었습니다.'
          : result.sync.error || 'Google Calendar는 연결되었지만 첫 동기화에 실패했습니다.',
      );
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Google Calendar 연결에 실패했습니다.';
      setOnboardingMessage(
        raw.includes('Google Calendar 연결을 사용할 수 없습니다')
          ? 'Google Calendar 연결을 사용할 수 없습니다. 관리자 설정을 확인하세요.'
          : raw,
      );
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function saveOnboardingStatus(status: 'dismissed' | 'completed') {
    if (onboardingBusy) return;
    setOnboardingBusy(true);
    setOnboardingMessage('');
    try {
      const timestamp = new Date().toISOString();
      const onboarding = {
        version: 1,
        status,
        ...(status === 'completed' ? { completedAt: timestamp } : { dismissedAt: timestamp }),
      };
      const next = await hermesApi.saveSettings({ onboarding });
      setState((current) => ({ ...current, settings: next }));
      openScreen('calendar');
    } catch (error) {
      setOnboardingMessage(error instanceof Error ? error.message : '시작 가이드 상태 저장 실패');
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function addCloudKnowledgeFile(file: File) {
    if (wikiSourceBusy) return;
    setWikiSourceBusy(true);
    setWikiSourceMessage('');
    try {
      const created = await hermesApi.createKnowledgeSource({
        sourceKind: 'cloud_indexed',
        label: file.name,
        path: file.name,
        cloudOptIn: true,
      });
      const source = obj(created, 'source');
      const sourceId = text(source.id);
      if (!sourceId) throw new Error('지식 소스 ID가 반환되지 않았습니다.');
      await hermesApi.ingestKnowledge({
        sourceId,
        title: file.name,
        path: file.name,
        content: await file.text(),
      });
      await refreshKnowledgeSources();
      setWikiSourceMessage(`${file.name} 암호화 색인이 완료되었습니다.`);
    } catch (error) {
      setWikiSourceMessage(error instanceof Error ? error.message : '지식 파일 추가 실패');
    } finally {
      setWikiSourceBusy(false);
    }
  }

  async function revokeKnowledgeSource(sourceId: string) {
    if (!sourceId || wikiSourceBusy) return;
    setWikiSourceBusy(true);
    setWikiSourceMessage('');
    try {
      await hermesApi.revokeKnowledgeSource(sourceId);
      await refreshKnowledgeSources();
      setWikiSourceMessage('지식 소스 연결을 해제했습니다.');
    } catch (error) {
      setWikiSourceMessage(error instanceof Error ? error.message : '지식 소스 연결 해제 실패');
    } finally {
      setWikiSourceBusy(false);
    }
  }

  async function resolveKnowledgeEvidence(handle: string) {
    return hermesApi.resolveKnowledgeEvidence(handle);
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
    // Agent Ops must re-read Workspace Runner connected/capability state when entered
    // (Runner Setup connects after the last hydrate; header cannot stay on stale runner_required).
    if (nextScreen === 'agents') {
      void refreshAgentOperations().catch(() => undefined);
    }
    // Calendar projection appears only after completion — rehydrate events without full blocking load.
    if (nextScreen === 'calendar' || nextScreen === 'today') {
      void hydrate({ blocking: false });
    }
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
      inbox: optimisticMailTaskUpdate(current.inbox, id),
    }));
    try {
      await hermesApi.createTask({
        title: itemTitle(mail, '메일 작업'),
        status: 'Planned',
        owner: 'Me',
        list: 'inbox',
        source: 'desktop-mail',
        sourceMailId: id,
      });
      await hydrate();
    } catch (error) {
      setState((current) => ({ ...current, inbox: previousInbox }));
      setApiError(error instanceof Error ? error.message : '메일 작업 추가 실패');
    }
  }

  async function openRunArtifact(run?: Item) {
    if (!run) return;
    const artifactId = text(run.artifactPath || run.documentPath || run.documentId || run.artifactId, '');
    const document = state.docs.find((item) => {
      const id = persistedDocumentIdentity(item);
      return Boolean(artifactId && (id === artifactId || text(item.path || item.wikiPath) === artifactId));
    });
    const docId = persistedDocumentIdentity(document || {}, artifactId);
    if (!docId) {
      setApiError('실행 결과 문서를 찾을 수 없습니다.');
      return;
    }
    setActiveWikiId(docId);
    setWikiReaderOpen(true);
    openScreen('wiki');
    setModal(null);
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
      const desktopApi = window.hermesDesktop;
      const updated = await persistUiPreferences({
        preferences: nextPrefs,
        saveLocal: desktopApi ? (payload) => desktopApi.saveSettings(payload) : undefined,
        saveRemote: (payload) => hermesApi.saveSettings(payload),
      });
      localUiPreferencesRef.current = desktopApi ? updated : null;
      setPrefs(updated);
      setSettings((current) => ({ ...current, uiPreferences: updated }));
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
    () => [...primaryNavItems, ...secondaryNavItems, ...navGroups.flatMap((group) => group.items)]
      .find((item) => (item.navKey || item.id) === activeNavKey),
    [activeNavKey, navGroups],
  );
  const secondaryNavActive = secondaryNavItems.some((item) => (item.navKey || item.id) === activeNavKey)
    || activeNavKey.startsWith('list:')
    || activeNavKey.startsWith('tag:');
  useEffect(() => {
    if (secondaryNavActive) setSecondaryNavOpen(true);
  }, [secondaryNavActive]);
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
  const selectedAgentSessionTask = agentSessionDetail
    ? agentOperations.tasks.find((task) => task.id === agentSessionDetail.taskId)
    : undefined;
  const selectedAgentSessionMission = agentSessionDetail
    ? agentOperations.missions.find((mission) => mission.id === agentSessionDetail.missionId)
    : undefined;
  const countForNav = (item: NavItem) => {
    const key = item.navKey || item.id;
    const end = addDaysKey(todayKey(), 7);
    if (key === 'today') return tasks.filter((task) => text(task.date) === todayKey() && !isDone(task)).length;
    if (key === 'next7') return tasks.filter((task) => text(task.date) && text(task.date) >= todayKey() && text(task.date) <= end && !isDone(task)).length;
    if (key === 'mail') return mailItems.length;
    if (key === 'agents') return runs.length;
    if (key === 'automation') return hermesAutomationJobs.length;
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
    reminderOn: newReminderOn,
    setReminderOn: setNewReminderOn,
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

  useAgentCalendarDeepLink(loggedIn && !loading && !isWidgetOverlay, openAgentSession);

  if (isWidgetOverlay) {
    return (
      <div className="app-root widget-overlay-root" data-theme={settings.theme}>
        {loading ? <Loading /> : <WidgetsScreen tasks={tasks} events={events} runs={runs} />}
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="app-root login-root" data-theme={settings.theme}>
        <LoginScreen loginWithAuthKit={loginWithAuthKit} authBusy={authBusy} authPhase={authPhase} loginStatus={loginStatus} />
      </div>
    );
  }

  return (
    <div className="app-root" data-theme={settings.theme}>
      <aside className="sidebar">
        <div className="brand">
          <LogoMark />
          <div className="brand-title">Agent Calendar</div>
        </div>
        <button className="sidebar-search" onClick={() => openScreen('search')}>
          <MagnifyingGlass size={15} weight="regular" aria-hidden="true" />
          <span>검색</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="nav">
          <div className="nav-primary">
            {primaryNavItems.map((item) => {
              const count = countForNav(item);
              return <button className="nav-item" data-active={activeNavKey === (item.navKey || item.id)} key={item.navKey || item.id} onClick={() => openScreen(item.id, item.navKey || item.id)}>
                <span><NavIcon name={item.icon} />{item.label}</span>
                {count > 0 && <em>{count}</em>}
              </button>;
            })}
          </div>
          <details
            className="nav-more"
            open={secondaryNavOpen}
            onToggle={(event) => setSecondaryNavOpen(event.currentTarget.open)}
          >
            <summary>
              <CaretRight size={13} weight="bold" aria-hidden="true" />
              <span>작업공간</span>
            </summary>
            <div className="nav-more-items">
              {secondaryNavItems.map((item) => {
                const count = countForNav(item);
                return <button className="nav-item" data-active={activeNavKey === (item.navKey || item.id)} key={item.navKey || item.id} onClick={() => openScreen(item.id, item.navKey || item.id)}>
                  <span><NavIcon name={item.icon} />{item.label}</span>
                  {count > 0 && <em>{count}</em>}
                </button>;
              })}
            </div>
            <div className="nav-taxonomy-groups">
              {navGroups.map((group, groupIndex) => (
                <div key={group.title || `smart-${groupIndex}`}>
                  {group.title && <div className="nav-title"><span>{group.title}</span>{group.kind ? <button title={`${group.kind === 'list' ? '리스트' : '태그'} 추가`} onClick={() => openTaxonomyForm(group.kind as TaxonomyKind, group.group)}>+</button> : null}</div>}
                  {group.items.map((item) => {
                    const count = countForNav(item);
                    return <button className="nav-item" data-active={activeNavKey === (item.navKey || item.id)} key={item.navKey || item.id} onClick={() => openScreen(item.id, item.navKey || item.id)}>
                      <span><NavIcon name={item.icon} />{item.label}</span>
                      {count > 0 && <em>{count}</em>}
                    </button>;
                  })}
                  {group.kind === 'tag' && !group.items.length && <button className="nav-item empty-taxonomy" onClick={() => openTaxonomyForm('tag', group.group)}><span><Plus className="nav-icon" size={16} weight="regular" aria-hidden="true" />태그 만들기</span></button>}
                </div>
              ))}
            </div>
          </details>
        </nav>
        <button className="profile" data-testid="open-settings" onClick={() => setModal('settings')}>
          {settings.authProfile?.picture ? <img className="avatar" src={settings.authProfile.picture} alt="" /> : <span className="avatar">{accountInitial}</span>}
          <span><strong>{accountName}</strong><small>{showDesktopConnectivity ? '연결 확인 필요' : showGlobalApiBanner ? 'Railway 확인 필요' : accountProviderLabel}</small></span>
          <GearSix className="profile-settings-icon" size={16} weight="regular" aria-hidden="true" />
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="screen-heading"><strong>{selectedMeta.title}</strong></div>
          <div className="topbar-actions">
            {onboardingPending && screen !== 'onboarding' && (
              <button
                type="button"
                className="onboarding-return"
                data-testid="onboarding-return"
                onClick={() => openScreen('onboarding')}
              >
                설정 계속
              </button>
            )}
            <button className="chat-fab" data-active={chatOpen} onClick={() => setChatOpen((open) => !open)} aria-label={chatOpen ? '캘린더 AI 닫기' : '캘린더 AI 열기'} title="캘린더 AI">
              <ChatCircleDots className="chat-fab-icon" size={16} weight="regular" aria-hidden="true" />
              <span>캘린더 AI</span>
            </button>
          </div>
        </header>
        {desktopRecoveryStatus && (
          <div
            className="desktop-recovery-notice"
            data-testid="desktop-recovery-notice"
            data-phase={desktopRecoveryStatus.phase}
            role="status"
          >
            <span>
              <strong>{desktopRecoveryStatus.phase === 'halted' ? '안전 복구 모드' : '앱 복구 완료'}</strong>
              <small>{desktopRecoveryStatus.message}</small>
            </span>
            <button type="button" onClick={() => setDesktopRecoveryStatus(null)}>확인</button>
          </div>
        )}
        {showDesktopConnectivity && (
          <div
            className="desktop-connectivity"
            data-testid="desktop-connectivity"
            data-state={desktopConnectivity.status}
            role={desktopConnectivity.status === 'offline' ? 'alert' : 'status'}
            aria-live="polite"
          >
            <i aria-hidden="true" />
            <strong>{connectivityCopy.title}</strong>
            <span>{connectivityCopy.detail}</span>
            {connectivityCopy.actionLabel && (
              <button
                type="button"
                onClick={() => {
                  setDesktopConnectivity((current) => beginConnectivityRetry(current));
                  void hydrate({ blocking: false });
                }}
              >
                {connectivityCopy.actionLabel}
              </button>
            )}
          </div>
        )}
        {showGlobalApiBanner && <div className="api-banner"><strong>Railway API 확인 필요</strong><span>{apiError}</span><button onClick={() => void hydrate()}>재시도</button></div>}
        {loading ? <Loading /> : (
          <section className="content">
            {screen === 'calendar' && <CalendarScreen tasks={scheduledTaskItems} events={events} openNewTask={openNewTask} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} patchCalendarEvent={patchCalendarEvent} calView={calView} setCalView={setCalView} calDate={calDate} setCalDate={setCalDate} placingTaskId={placingTaskId} setPlacingTaskId={setPlacingTaskId} calendarSources={calendarSources} coverageNote={calendarCoverageNote} onConnectGoogle={connectGoogleCalendar} connectionBusy={onboardingBusy} connectionMessage={onboardingMessage} onSyncSources={syncCalendarSources} onCreateExternalGoogle={async () => {
              try {
                let googleSource = calendarSources.find((source) => text(source.provider) === 'google' && text(source.status) === 'connected');
                if (!googleSource) {
                  const list = await hermesApi.getCalendarSources();
                  const sources = Array.isArray((list as { sources?: unknown[] })?.sources)
                    ? (list as { sources: Item[] }).sources
                    : [];
                  googleSource = sources.find((source) => text(source.provider) === 'google' && text(source.status) === 'connected');
                }
                const sourceId = itemId(googleSource || {}, '');
                if (!sourceId) throw new Error('연결된 Google 소스가 없습니다');
                const day = calDate || todayKey();
                // Use a wall-clock hour visible in day view (07–22).
                const startsAt = `${day}T10:00:00.000Z`;
                const endsAt = `${day}T11:00:00.000Z`;
                // Success is only shown after provider reconcile + local projection hydrate.
                const result = await hermesApi.createExternalCalendarEvent({
                  sourceId,
                  title: 'Google external create',
                  startsAt,
                  endsAt,
                  allDay: false,
                  timezone: 'Asia/Seoul',
                  idempotencyKey: `ete-ext-create-${day}-${Date.now()}`,
                });
                if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false) {
                  throw new Error('외부 일정 생성 실패');
                }
                await hydrate({ blocking: false });
              } catch (error) {
                setApiError(error instanceof Error ? error.message : '외부 일정 생성 실패');
              }
            }} />}
            {screen === 'today' && <TodayScreen tasks={tasks} runs={runs} approveRun={approveRun} quickText={quickText} setQuickText={setQuickText} submitQuick={() => submitQuick(todayKey())} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} openRun={openRun} />}
            {screen === 'tasks' && selectedTaxonomy && <TaxonomyManager item={selectedTaxonomy} edit={(item) => openTaxonomyForm(item.kind, item.group, item)} hide={(item) => void hideTaxonomy(item)} />}
            {(screen === 'tasks' || screen === 'next7' || screen === 'someday') && <TaskListScreen tasks={filteredTasks} quickText={quickText} setQuickText={setQuickText} submitQuick={() => submitQuick(screen === 'next7' ? todayKey() : undefined)} applyRepeatTemplate={(label) => {
              const templates: Record<string, string> = { '매일 루틴': '매일 ', '매주 회의': '매주 ', '매월 정산': '매월 ', '평일 근무': '근무 평일 ' };
              setQuickText(templates[label] || '');
            }} openTask={openTask} toggleTask={toggleTask} patchTask={patchTask} />}
            {screen === 'kanban' && <KanbanScreen tasks={filteredTasks} openTask={openTask} />}
            {screen === 'mail' && <MailScreen inbox={mailItems} activeMailId={activeMailId} setActiveMailId={setActiveMailId} addTaskFromMail={(mail) => { void addTaskFromMail(mail); }} delegateMail={(mail, reply) => { setDelegateText(reply ? `아래 메일에 대한 정중한 답장 초안을 작성해줘.\n\n${itemTitle(mail, '메일')}` : `다음 메일을 처리해줘.\n\n${itemTitle(mail, '메일')}`); setModal('delegate'); }} mailLoadError={mailLoadError} reloadMail={() => { void hydrate({ blocking: false }); }} />}
            {screen === 'notes' && <NotesScreen docs={docs} activeNoteId={activeNoteId} setActiveNoteId={setActiveNoteId} newNote={createNote} />}
            {screen === 'review' && <ReviewScreen tasks={tasks} patchTask={patchTask} generateRetroDraft={generateRetroDraft} createReviewGoal={createReviewGoal} saveRetro={saveRetro} />}
            {screen === 'wiki' && <WikiScreen wiki={state.wiki} docs={docs} activeWikiId={activeWikiId} setActiveWikiId={setActiveWikiId} readerOpen={wikiReaderOpen} setReaderOpen={setWikiReaderOpen} question={wikiQuestion} setQuestion={setWikiQuestion} answer={wikiAnswer} sources={wikiAnswerSources} answerMeta={wikiAnswerMeta} includeJournal={wikiIncludeJournal} setIncludeJournal={setWikiIncludeJournal} includeRaw={wikiIncludeRaw} setIncludeRaw={setWikiIncludeRaw} asking={wikiAsking} ask={askWiki} dismissAnswer={dismissWikiAnswer} loadDocument={loadKnowledgeDocument} knowledgeV2={state.wiki.knowledgeV2 === true} knowledgeSources={arr(state.wiki, 'sources')} sourceBusy={wikiSourceBusy} sourceMessage={wikiSourceMessage} addCloudFile={addCloudKnowledgeFile} revokeSource={revokeKnowledgeSource} resolveEvidence={resolveKnowledgeEvidence} />}
            {screen === 'diary' && <DiaryScreen docs={diaryDocs} diaryText={diaryText} setDiaryText={setDiaryText} diaryMood={diaryMood} setDiaryMood={setDiaryMood} saveDiary={saveDiary} loadDocument={loadKnowledgeDocument} />}
            {screen === 'search' && <SearchScreen query={query} setQuery={setQuery} tasks={tasks} docs={docs} openTask={openTask} openDoc={openDoc} />}
            {screen === 'agents' && <AgentOperationsScreen state={agentOperations} agents={agentRoster} runners={automationRunners} automationJobs={hermesAutomationJobs} controlPlaneBaseUrl={settings.apiBaseUrl} error={agentOperationsError} busy={agentOperationsBusy} onRetry={retryAgentOperations} onRefreshAgentOperations={retryAgentOperations} onCreateAgent={createWorkspaceAgent} onUpdateAgent={updateWorkspaceAgent} onCreateBuilderDraft={createWorkspaceAgentBuilderDraft} onReviewBuilderDraft={reviewWorkspaceAgentBuilderDraft} onTestBuilderDraft={testWorkspaceAgentBuilderDraft} onRefreshBuilderTest={refreshWorkspaceAgentBuilderTest} onCancelBuilderTest={cancelWorkspaceAgentBuilderTest} onActivateBuilderProfile={activateWorkspaceAgentBuilderProfile} onListAgentProfileVersions={loadWorkspaceAgentProfileVersions} onRequestAgentCatalog={requestAgentCatalog} onGetAgentCatalogRequest={getAgentCatalogRequest} onImportAgentCatalogEntry={importAgentCatalogEntry} onListProviderAgentSessions={listProviderAgentSessions} onRequestProviderSessionCatalog={requestProviderSessionCatalog} onImportProviderSessionCatalogEntry={importProviderSessionCatalogEntry} onUpdateProviderAgentSession={updateProviderAgentSession} onCreateMission={createAgentMission} onPlanMission={planAgentMission} onApprovePlan={approveAgentMissionPlan} onMissionWorkAction={transitionAgentMissionWork} onTaskAction={transitionAgentOperationTask} onRunTaskNow={runAgentOperationTaskNow} onOpenSession={(sessionId) => void openAgentSession(sessionId)} onContinueSession={continueAgentSession} onReportFeedback={recordAgentReportFeedback} onFollowUpDecision={recordAgentFollowUpDecision} />}
            {screen === 'automation' && (
              <HermesAutomationDashboard
                sources={connectedAutomationSources}
                runners={automationRunners}
                jobs={hermesAutomationJobs}
                agents={agentRoster}
                onRefresh={refreshHermesAutomations}
                onConnect={connectAutomationSource}
                onSync={syncAutomationSource}
                onCreate={createConnectedAutomation}
                onUpdate={updateConnectedAutomation}
                onSetEnabled={setConnectedAutomationEnabled}
                onRun={runConnectedAutomation}
                onApprove={approveConnectedAutomationChange}
              />
            )}
            {screen === 'widgets' && <WidgetsScreen tasks={tasks} events={events} runs={runs} />}
            {screen === 'onboarding' && (
              <OnboardingGuide
                readiness={onboardingReadiness}
                busy={onboardingBusy || wikiSourceBusy}
                message={onboardingMessage || wikiSourceMessage}
                onConnectCalendar={connectGoogleCalendar}
                onSyncCalendar={syncCalendarSources}
                onOpenRunner={() => openScreen('runner')}
                onOpenWiki={() => openScreen('wiki')}
                onOpenCalendarAi={() => {
                  openScreen('calendar');
                  setChatOpen(true);
                }}
                onAddKnowledgeFile={addCloudKnowledgeFile}
                onDismiss={() => saveOnboardingStatus('dismissed')}
                onComplete={() => saveOnboardingStatus('completed')}
              />
            )}
            {screen === 'settings' && <SettingsScreen settings={settings} gatewayStatus={state.gatewayStatus} setSettings={setSettings} refresh={hydrate} openRunnerSetup={() => openScreen('runner')} openOnboarding={() => openScreen('onboarding')} desktopReleaseStatus={desktopReleaseStatus} desktopReleaseBusy={desktopReleaseBusy} desktopReleaseError={desktopReleaseError} onCheckDesktopRelease={() => void runDesktopReleaseAction('check')} onDownloadDesktopRelease={() => void runDesktopReleaseAction('download')} onInstallDesktopRelease={() => void runDesktopReleaseAction('install')} />}
            {screen === 'runner' && (
              <RunnerSetupPanel
                workspaceLabel={settings.authProfile?.email || settings.authProfile?.name || accountName || 'Workspace'}
                controlPlaneBaseUrl={settings.apiBaseUrl}
                onReadyCalendar={() => openScreen('calendar')}
              />
            )}
            {screen === 'login' && <LoginScreen loginWithAuthKit={loginWithAuthKit} authBusy={authBusy} authPhase={authPhase} loginStatus={loginStatus} />}
          </section>
        )}
      </main>

      {completionNotice && <CompletionToast title={completionNotice.title} undo={undoCompletion} close={() => setCompletionNotice(null)} />}
      {selectedAgentSessionId && !agentSessionDetail && (
        <div className="task-session-backdrop">
          <section className="task-session-status" role="dialog" aria-modal="true" aria-label="Task Session 상태">
            <strong>{agentSessionLoading ? 'Task Session을 불러오는 중' : 'Task Session을 열지 못했습니다.'}</strong>
            {!agentSessionLoading && <p>{agentOperationsError}</p>}
            <div>
              {!agentSessionLoading && <button onClick={() => void openAgentSession(selectedAgentSessionId)}>다시 시도</button>}
              <button onClick={closeAgentSession}>닫기</button>
            </div>
          </section>
        </div>
      )}
      {agentSessionDetail && (
        <TaskSessionPanel
          detail={agentSessionDetail}
          sessions={agentOperations.sessions}
          task={selectedAgentSessionTask}
          mission={selectedAgentSessionMission}
          busy={agentOperationsBusy}
          sending={agentSessionMessageBusy || agentSessionLoading}
          onClose={closeAgentSession}
          onOpenSession={(sessionId) => void openAgentSession(sessionId)}
          onSendMessage={(message) => continueAgentSession(selectedAgentSessionId, message)}
          onTaskAction={transitionAgentOperationTask}
        />
      )}
      {chatOpen && <ChatDrawer messages={chatMessages} input={chatInput} setInput={setChatInput} attachment={chatAttachment} setAttachment={setChatAttachment} send={sendChat} busy={chatBusy} setChip={setChatInput} close={() => setChatOpen(false)} registerDrafts={registerScheduleDrafts} memories={calendarAiMemories} memoryOpen={calendarAiMemoryOpen} toggleMemory={() => setCalendarAiMemoryOpen((open) => !open)} updateMemory={updateCalendarAiMemory} forgetMemory={forgetCalendarAiMemory} purgeMemory={purgeCalendarAiMemory} actOnDraft={actOnCalendarAiDraft} actionBusyId={calendarAiActionBusyId} />}
      {modal === 'taxonomy' && taxonomyForm && <TaxonomyModal form={taxonomyForm} name={taxonomyName} setName={setTaxonomyName} groupName={taxonomyGroupName} setGroupName={setTaxonomyGroupName} icon={taxonomyIcon} setIcon={setTaxonomyIcon} close={() => { setTaxonomyForm(null); setModal(null); }} submit={() => void createTaxonomy()} />}
      <Modal modal={modal} setModal={setModal} newTitle={newTitle} setNewTitle={setNewTitle} newDesc={newDesc} setNewDesc={setNewDesc} newTask={newTaskControls} createTask={createTask} lists={listDefinitions} tags={tagDefinitions} agents={agents} runs={runs} selectedRun={selectedRun} selectedTask={selectedTask} patchTask={patchTask} patchCalendarEvent={patchCalendarEvent} removeTask={removeTask} removeCalendarEvent={removeCalendarEvent} toggleTask={toggleTask} delegateText={delegateText} setDelegateText={setDelegateText} delegateAgentId={delegateAgentId} setDelegateAgentId={setDelegateAgentId} startPlan={() => startPlan(delegateText, delegateAgentId)} openRunArtifact={openRunArtifact} approveRun={approveRun} newAgentName={newAgentName} setNewAgentName={setNewAgentName} newAgentRole={newAgentRole} setNewAgentRole={setNewAgentRole} newAgentEmoji={newAgentEmoji} setNewAgentEmoji={setNewAgentEmoji} createAgent={createAgent} settings={settings} gatewayStatus={state.gatewayStatus} setSettings={setSettings} refresh={hydrate} setApiError={setApiError} loggedIn={loggedIn} setLoggedIn={setLoggedIn} logout={logout} loginWithAuthKit={loginWithAuthKit} authBusy={authBusy} authPhase={authPhase} loginStatus={loginStatus} prefs={prefs} updatePrefs={updatePrefs} openOnboarding={() => { setModal(null); openScreen('onboarding'); }} desktopReleaseStatus={desktopReleaseStatus} desktopReleaseBusy={desktopReleaseBusy} desktopReleaseError={desktopReleaseError} onCheckDesktopRelease={() => void runDesktopReleaseAction('check')} onDownloadDesktopRelease={() => void runDesktopReleaseAction('download')} onInstallDesktopRelease={() => void runDesktopReleaseAction('install')} />
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
      <span>월 캘린더, Large</span>
      <span>오늘 — Medium</span>
      <span>다음 일정 · 에이전트 상태, Small</span>
    </footer>
  </div>;
}

function CalendarScreen({ tasks, events, openNewTask, openTask, toggleTask, patchTask, patchCalendarEvent, calView, setCalView, calDate, setCalDate, placingTaskId, setPlacingTaskId, calendarSources = [], coverageNote = '', onConnectGoogle, connectionBusy = false, connectionMessage = '', onSyncSources, onCreateExternalGoogle }: { tasks: Item[]; events: Item[]; openNewTask: (date?: string, time?: string) => void; openTask: (task: Item) => void; toggleTask: (task: Item) => void; patchTask: (task: Item, patch: Item) => void; patchCalendarEvent: (task: Item, patch: Item) => void; calView: 'month' | 'week' | 'day'; setCalView: (view: 'month' | 'week' | 'day') => void; calDate: string; setCalDate: (date: string) => void; placingTaskId: string; setPlacingTaskId: (id: string) => void; calendarSources?: Item[]; coverageNote?: string; onConnectGoogle?: () => Promise<void>; connectionBusy?: boolean; connectionMessage?: string; onSyncSources?: () => Promise<void>; onCreateExternalGoogle?: () => Promise<void> }) {
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const [draggingItem, setDraggingItem] = useState<Item | null>(null);
  const [ownerView, setOwnerView] = useState<'me' | 'agents' | 'combined'>('combined');
  const allCalendarItems: Item[] = [
    ...events.map((event) => ({ ...event, kind: 'calendar-event', type: 'calendar-event' })),
    ...tasks.map((task) => ({ ...task, kind: text(task.kind || 'scheduled-task') })),
  ];
  const calendarItems = allCalendarItems.filter((item) => {
    if (ownerView === 'combined') return true;
    const isAgentTask = text(item.origin) === 'agent';
    return ownerView === 'agents' ? isAgentTask : !isAgentTask;
  });
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
  const hasConnectedGoogle = calendarSources.some((source) => text(source.provider) === 'google' && text(source.status) === 'connected');
  const sourceSummary = hasConnectedGoogle ? 'Google Calendar 연결됨' : '외부 캘린더 없음';
  const entrySourceBadge = (item: Item) => {
    if (text(item.sourceLabel)) return text(item.sourceLabel);
    if (text(item.sourceKind) === 'agent_work' || text(item.source) === 'agent-work' || text(item.origin) === 'agent') return 'Agent';
    if (text(item.provider) === 'google' || text(item.source) === 'google') return 'Google';
    if (isCalendarEventRecord(item)) return 'Internal';
    return '';
  };
  const isReadOnlyEntry = (item: Item) => item.writable === false
    || text(item.origin) === 'agent'
    || text(item.sourceKind) === 'agent_work'
    || text(item.source) === 'agent-work';
  const canDragEntry = (item: Item) => !isReadOnlyEntry(item) && text(item.origin) !== 'agent';
  const calendarItemClass = (item: Item) => [
    isCalendarEventRecord(item) ? 'calendar-event-pill' : 'scheduled-task-pill',
    `owner-${taskOwner(item).toLowerCase()}`,
    isDone(item) ? 'status-done' : 'status-open',
    isRangePill(item) ? 'range-pill' : '',
    isRangePill(item) && text(item._calendarDate) === text(item._rangeStart) ? 'range-start' : '',
    isRangePill(item) && text(item._calendarDate) === text(item._rangeEnd) ? 'range-end' : '',
    text(item.origin) === 'agent' ? 'agent-task-pill' : '',
    text(item.origin) === 'agent' && text(item.agentTaskState) ? `agent-task-${text(item.agentTaskState)}` : '',
    text(item.provider) === 'google' || text(item.source) === 'google' ? 'source-google' : '',
    text(item.sourceKind) === 'agent_work' || text(item.source) === 'agent-work' ? 'source-agent-work' : '',
    isReadOnlyEntry(item) ? 'calendar-readonly' : '',
  ].filter(Boolean).join(' ');
  const calendarPillContent = (item: Item, fallback: string) => {
    const range = isRangePill(item);
    const rangeStart = text(item._calendarDate) === text(item._rangeStart);
    const rangeEnd = text(item._calendarDate) === text(item._rangeEnd);
    const endTime = calendarMetadata(item).endTime || text(item.endTime);
    const timeValue = range && rangeEnd ? text(endTime || item.time || item.t) : text(item.time || item.t);
    const showTitle = !range || rangeStart;
    const showTime = !!timeValue && (!range || rangeEnd);
    const agentLabel = text(item.agentTaskLabel);
    const visibleAgentLabel = [agentLabel, text(item.agent), text(item.agentTaskEngineLabel)].filter(Boolean).join(' · ');
    const badge = monthSourceBadge({
      sourceKind: text(item.sourceKind),
      provider: text(item.provider || item.source),
      sourceLabel: entrySourceBadge(item),
    });
    return <>
      {showTitle && badge && <em className="source-badge" data-source-badge={badge}>{badge}</em>}
      <span>{showTitle ? itemTitle(item, fallback) : '\u00A0'}</span>
      {showTitle && visibleAgentLabel && <i>{visibleAgentLabel}</i>}
      {showTime && <b>{formatTime(timeValue)}</b>}
    </>;
  };
  const calendarItemDescription = (item: Item) => [
    itemTitle(item, '에이전트 작업'),
    text(item.agentTaskLabel),
    text(item.agent) && `담당 ${text(item.agent)}`,
    text(item.agentTaskEngineLabel) && `실행 엔진 ${text(item.agentTaskEngineLabel)}`,
    text(item.agentMissionTitle) && `미션 ${text(item.agentMissionTitle)}`,
    text(item.expectedOutput) && `기대 결과 ${text(item.expectedOutput)}`,
    text(item.dueAt) && `마감 ${text(item.dueAt)}`,
    text(item.blockedReason) && `차단 원인 ${text(item.blockedReason)}`,
  ].filter(Boolean).join(' · ');
  const patchDraggedItem = (item: Item, targetDate: string, targetTime?: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return;
    if (isReadOnlyEntry(item)) return;
    const originalStart = itemStartDate(item) || targetDate;
    const originalEnd = itemEndDate(item, originalStart);
    const rangeLength = Math.max(1, rangeDates(originalStart, originalEnd).length);
    const offset = Math.max(0, Math.min(Number(item._rangeOffset || 0) || 0, rangeLength - 1));
    const nextStart = addDaysKey(targetDate, -offset);
    const patch: Item = { date: nextStart, startDate: nextStart };
    if (typeof targetTime === 'string') patch.time = targetTime;
    if (rangeLength > 1) patch.endDate = addDaysKey(nextStart, rangeLength - 1);
    else if (text(item.endDate || calendarMetadata(item).endDate)) patch.endDate = nextStart;
    if (isCalendarEventRecord(item)) patchCalendarEvent(item, patch);
    else patchTask(item, patch);
  };
  const beginDrag = (event: React.DragEvent, item: Item) => {
    if (!canDragEntry(item)) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    setDraggingItem(item);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId(item, ''));
  };
  const dropOnCalendar = (event: React.DragEvent, date: string, time?: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (draggingItem) patchDraggedItem(draggingItem, date, time);
    setDraggingItem(null);
  };
  const allowCalendarDrop = (event: React.DragEvent) => {
    if (!draggingItem) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
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
    return matched.slice(0, 6);
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
  return <div className="calendar screen-in" data-dragging={!!draggingItem} data-testid="unified-calendar">
    <div className="screen-toolbar calendar-toolbar">
      <div className="calendar-period">
        <h2>{label}</h2>
        <Legend />
      </div>
      <div className="calendar-toolbar-actions">
        <div className="agent-calendar-filter" aria-label="캘린더 담당자 필터">
          <Segment items={['나', '에이전트', '전체']} active={ownerView} setActive={(value) => setOwnerView(value as 'me' | 'agents' | 'combined')} values={['me', 'agents', 'combined']} />
        </div>
        <Segment items={['월', '주', '일']} active={calView} setActive={(value) => setCalView(value as 'month' | 'week' | 'day')} values={['month', 'week', 'day']} />
        <button className="calendar-today" onClick={() => { setCalDate(todayKey()); setPlacingTaskId(''); }}>오늘</button>
        <div className="calendar-navigation" aria-label="캘린더 기간 이동">
          <button aria-label="이전 기간" title="이전 기간" onClick={() => shiftCalendar(-1)}>
            <CaretLeft size={14} weight="bold" aria-hidden="true" />
          </button>
          <button aria-label="다음 기간" title="다음 기간" onClick={() => shiftCalendar(1)}>
            <CaretRight size={14} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
    <div className="unified-calendar-sources" data-testid="calendar-sources" aria-label="통합 캘린더 소스">
      <div className="unified-calendar-sources-meta">
        <CalendarDots className="calendar-source-icon" size={15} weight="regular" aria-hidden="true" />
        <span data-testid="calendar-source-summary">{sourceSummary}</span>
        <span data-testid="calendar-coverage-note" data-coverage={coverageNote.includes('불완전') ? 'incomplete' : coverageNote.includes('완료') ? 'complete' : 'none'}>{coverageNote || '커버리지 대기'}</span>
      </div>
      <div className="unified-calendar-sources-actions">
        {!hasConnectedGoogle && onConnectGoogle && (
          <button type="button" data-testid="calendar-connect-google" disabled={connectionBusy} onClick={() => { void onConnectGoogle(); }}>
            {connectionBusy ? 'Google 로그인 대기 중' : 'Google Calendar 연결'}
          </button>
        )}
        {hasConnectedGoogle && onSyncSources && (
          <button type="button" data-testid="calendar-sync-sources" onClick={() => { void onSyncSources(); }}>소스 동기화</button>
        )}
        {hasConnectedGoogle && onCreateExternalGoogle && (
          <button type="button" data-testid="calendar-external-create" onClick={() => { void onCreateExternalGoogle(); }}>Google 일정 추가</button>
        )}
      </div>
      {connectionMessage && <p className="calendar-source-message" role="status">{connectionMessage}</p>}
      {calendarSources.length > 0 && (
        <ul className="unified-calendar-source-list" data-testid="calendar-source-list">
          {calendarSources.map((source, index) => {
            const id = itemId(source, `src-${index}`);
            const status = text(source.status, 'unknown');
            const lastSync = text(source.lastSyncedAt || source.last_synced_at);
            return (
              <li key={id} data-source-id={id} data-source-status={status} data-provider={text(source.provider)}>
                <span className="source-pill">{text(source.label || source.provider || 'source')}</span>
                <span className="source-status">{status === 'connected' ? '연결됨' : status}</span>
                {lastSync && <span className="source-freshness">동기화 {lastSync.slice(0, 19)}</span>}
                {source.writable === false && <span className="source-ro">읽기 전용</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
    {calView === 'month' && <div className="month-grid">
      {weekdays.map((day) => <div className="weekday" key={day}>{day}</div>)}
      {cells.map((cell) => <button className="day-cell" data-date={cell.date} data-muted={!cell.inMonth} data-today={cell.today} data-selected={cell.selected} key={cell.date} onDragOver={allowCalendarDrop} onDrop={(event) => dropOnCalendar(event, cell.date)} onClick={() => openNewTask(cell.date)}>
        <strong onClick={(event) => { event.stopPropagation(); setCalDate(cell.date); setCalView('day'); }}>{cell.day}</strong>
        {cell.items.map((item, index) => <span className={`event-pill ${calendarItemClass(item)}`} draggable={canDragEntry(item)} data-source-kind={text(item.sourceKind || item.source)} aria-label={text(item.origin) === 'agent' ? calendarItemDescription(item) : undefined} title={text(item.origin) === 'agent' ? calendarItemDescription(item) : undefined} key={`${cell.day}-${index}`} onDragStart={(event) => beginDrag(event, item)} onDragEnd={() => setDraggingItem(null)} onClick={(event) => { event.stopPropagation(); openTask(item); }}>{calendarPillContent(item, isCalendarEventRecord(item) ? '일정' : '작업')}</span>)}
      </button>)}
    </div>}
    {calView === 'week' && <div className="week-grid">
      {weekCells.map((cell) => <section className="week-col" data-today={cell.today} data-selected={cell.selected} key={cell.date}>
        <button className="week-head" onClick={() => { setCalDate(cell.date); setCalView('day'); }}><span>{cell.weekday}</span><strong>{cell.day}</strong></button>
        <div className="week-events" onDragOver={allowCalendarDrop} onDrop={(event) => dropOnCalendar(event, cell.date)} onClick={() => openNewTask(cell.date)}>
          {cell.items.map((item, index) => <button className={`week-event ${calendarItemClass(item)}`} draggable={canDragEntry(item)} data-source-kind={text(item.sourceKind || item.source)} aria-label={text(item.origin) === 'agent' ? calendarItemDescription(item) : undefined} title={text(item.origin) === 'agent' ? calendarItemDescription(item) : undefined} key={`${cell.date}-${index}`} onDragStart={(event) => beginDrag(event, item)} onDragEnd={() => setDraggingItem(null)} onClick={(event) => { event.stopPropagation(); openTask(item); }}><small>{[entrySourceBadge(item), text(item.agentTaskLabel), text(item.agent), text(item.agentTaskEngineLabel), text(item.time || item.t, index % 2 ? '오후 2:00' : '오전 9:00')].filter(Boolean).join(' · ')}</small>{itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}</button>)}
        </div>
      </section>)}
    </div>}
    {calView === 'day' && <div className="day-schedule">
      <div className="day-hours">
        {hours.map((row) => <button className="hour-row" data-placing={!!placingTask} key={row.time} onDragOver={allowCalendarDrop} onDrop={(event) => dropOnCalendar(event, dayDate, row.time)} onClick={() => {
          if (placingTask) {
            patchTask(placingTask, { date: dayDate, time: row.time });
            setPlacingTaskId('');
          } else {
            openNewTask(dayDate, row.time);
          }
        }}>
          <span>{formatTime(row.time).replace(':00', '시')}</span>
          <div>{row.items.map((item, index) => <em className={calendarItemClass(item)} draggable={canDragEntry(item)} data-source-kind={text(item.sourceKind || item.source)} aria-label={text(item.origin) === 'agent' ? calendarItemDescription(item) : undefined} title={text(item.origin) === 'agent' ? calendarItemDescription(item) : undefined} key={`${row.time}-${index}`} onDragStart={(event) => beginDrag(event, item)} onDragEnd={() => setDraggingItem(null)} onClick={(event) => { event.stopPropagation(); openTask(item); }}><b>{formatTime(text(item.time || item.t, row.time))}</b> {entrySourceBadge(item) && <small className="source-badge">{entrySourceBadge(item)}</small>} {itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}{text(item.agentTaskLabel) && <small> · {[text(item.agentTaskLabel), text(item.agent), text(item.agentTaskEngineLabel)].filter(Boolean).join(' · ')}</small>}</em>)}</div>
        </button>)}
      </div>
      <aside className="day-side">
        <h3>{dayDateObj.getMonth() + 1}월 {dayDateObj.getDate()}일 ({weekdays[dayDateObj.getDay()]})</h3>
        <p>{placingTask ? `"${itemTitle(placingTask, '작업')}" 배치할 시간 슬롯을 선택하세요` : <>하루 종일 · 시간 미지정 <span>· "시간 잡기"로 타임블록</span></>}</p>
        {allDayItems.slice(0, 4).map((item, index) => <div className="day-all-day" data-event={isCalendarEventRecord(item)} data-done={isDone(item)} data-source-kind={text(item.sourceKind || item.source)} role="button" tabIndex={0} key={index} onClick={() => openTask(item)} onKeyDown={(event) => { if (event.key === 'Enter') openTask(item); }}>
          {!isCalendarEventRecord(item) && <i onClick={(event) => { event.stopPropagation(); toggleTask(item); }}>{isDone(item) ? '✓' : ''}</i>}<span>{entrySourceBadge(item) ? `[${entrySourceBadge(item)}] ` : ''}{itemTitle(item, isCalendarEventRecord(item) ? '일정' : '작업')}</span>{!isCalendarEventRecord(item) && <b onClick={(event) => { event.stopPropagation(); setPlacingTaskId(itemId(item, `day-${index}`)); }}>⏰ 시간 잡기</b>}
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
  const stats: ReadonlyArray<[string, number, 'danger' | 'success' | 'neutral' | 'warning']> = [
    ['지연', overdue.length, overdue.length ? 'danger' : 'success'],
    ['오늘 할 일', todayTasks.length, 'neutral'],
    ['검토 대기', reviewRuns.length, reviewRuns.length ? 'warning' : 'success'],
  ];
  return <div className="plan-screen screen-in">
    <div className="quick-row plan-quick"><span>+</span><input value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitQuick(); }} placeholder="오늘 할 일 추가  ·  예: 오후3시 롯데리아 #업무 !높음 @agent" /><button onClick={submitQuick}>추가</button></div>
    <div className="plan-stats">{stats.map(([label, value, tone]) => <div key={label}><span>{label}</span><strong data-tone={tone}>{value}</strong></div>)}</div>

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
    { key: 'todo', label: '기본', tone: 'neutral' },
    { key: 'doing', label: '진행 중', tone: 'active' },
    { key: 'review', label: '검토', tone: 'warning' },
    { key: 'done', label: '완료', tone: 'success' },
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
        <h3><i data-tone={col.tone} /><strong>{col.label}</strong><span>{cards.length}</span></h3>
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
  const selectedAgentReady = selectableAgents.some((agent, index) => itemId(agent, `agent-${index}`) === selectedAgentId);
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
        <button className="primary" disabled={!selectedAgentReady} onClick={startPlan}>계획 세우기 →</button>
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
      <p>{text(agent.role || agent.persona, '리서치와 문서 정리, 위키 작성, 분석을 담당.')}</p>
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

function DeploymentStatus({ status }: { status: ApiEnvelope }) {
  const commit = text(status.buildCommit, '확인 중');
  const deploymentId = text(status.deploymentId, '확인 중');
  const accessMode = text(status.runtimeAccessMode, 'offline');
  const accessLabel = accessMode === 'relay' ? 'Relay 연결' : accessMode === 'direct' ? '직접 연결' : 'Runtime 오프라인';
  const reachable = status.effectiveRuntimeReachable === true;
  const desktopBuildId = __AGENT_CALENDAR_BUILD_ID__;
  const revisionMatches = commit !== '확인 중' && desktopBuildId !== 'development' && commit === desktopBuildId;
  return <section className="deployment-status" data-reachable={reachable} data-revision-match={revisionMatches}>
    <span><i /><b>{reachable ? accessLabel : 'Runtime 확인 필요'}</b></span>
    <dl><div><dt>Git commit</dt><dd>{commit}</dd></div><div><dt>Desktop build</dt><dd>{desktopBuildId}</dd></div><div><dt>Railway deployment</dt><dd>{deploymentId}</dd></div></dl>
    {!revisionMatches && <p className="deployment-revision-warning">버전 불일치 · 데스크톱과 Railway를 같은 커밋으로 다시 배포하세요.</p>}
  </section>;
}

function DesktopReleasePanel({
  status,
  busy,
  error,
  onCheck,
  onDownload,
  onInstall,
}: {
  status: HermesDesktopReleaseStatus;
  busy: '' | 'check' | 'download' | 'install';
  error: string;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const working = Boolean(busy) || ['checking', 'downloading', 'installing'].includes(status.phase);
  const versionCopy = status.availableVersion
    ? `${status.currentVersion || '현재 버전'} → ${status.availableVersion}`
    : status.currentVersion || '버전 확인 중';
  return (
    <div
      className="desktop-release-panel"
      data-testid="desktop-release-panel"
      data-phase={status.phase}
    >
      <div className="desktop-release-copy">
        <span><b>{versionCopy}</b><small>{status.message}</small></span>
        {typeof status.progressPercent === 'number' && (
          <progress max="100" value={status.progressPercent}>
            {status.progressPercent}%
          </progress>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="desktop-release-actions">
        <button
          type="button"
          data-testid="desktop-release-check"
          disabled={!status.supported || working}
          onClick={onCheck}
        >
          {busy === 'check' || status.phase === 'checking' ? '확인 중…' : '업데이트 확인'}
        </button>
        {status.phase === 'available' && (
          <button
            type="button"
            className="primary"
            data-testid="desktop-release-download"
            disabled={working}
            onClick={onDownload}
          >
            {busy === 'download' ? '다운로드 중…' : '다운로드'}
          </button>
        )}
        {status.phase === 'ready' && (
          <button
            type="button"
            className="primary"
            data-testid="desktop-release-install"
            disabled={working}
            onClick={onInstall}
          >
            설치하고 다시 열기
          </button>
        )}
      </div>
    </div>
  );
}

function SettingsScreen({ settings, gatewayStatus, setSettings, refresh, openRunnerSetup, openOnboarding, desktopReleaseStatus, desktopReleaseBusy, desktopReleaseError, onCheckDesktopRelease, onDownloadDesktopRelease, onInstallDesktopRelease }: { settings: DesktopSettingsState; gatewayStatus: ApiEnvelope; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; openRunnerSetup?: () => void; openOnboarding?: () => void; desktopReleaseStatus: HermesDesktopReleaseStatus; desktopReleaseBusy: '' | 'check' | 'download' | 'install'; desktopReleaseError: string; onCheckDesktopRelease: () => void; onDownloadDesktopRelease: () => void; onInstallDesktopRelease: () => void }) {
  const [apiBaseUrl, setApiBaseUrlInput] = useState(settings.apiBaseUrl);
  const [theme, setTheme] = useState<DesktopTheme>(settings.theme);
  const isProductionDesktop = Boolean(window.hermesDesktop);
  async function save() {
    // Production never accepts a Railway bearer from the renderer — Workspace app session
    // is attached by the Electron proxy from the secure session store.
    const next = await window.hermesDesktop?.saveSettings({ apiBaseUrl, theme });
    if (next) setSettings(desktopSettingsState(next));
    await refresh();
  }
  return (
    <div className="settings screen-in">
      <Panel title="연결">
        <label>API Base URL<input value={apiBaseUrl} onChange={(event) => setApiBaseUrlInput(event.target.value)} /></label>
        {isProductionDesktop ? (
          <p className="settings-session-note" data-testid="production-session-auth-note">
            인증은 AuthKit 작업공간 세션으로 처리됩니다. Bearer 토큰은 설정에 저장되지 않으며 렌더러에 노출되지 않습니다.
          </p>
        ) : (
          <p className="settings-session-note">브라우저 미리보기 · Electron에서 AuthKit 세션이 연결됩니다.</p>
        )}
        <button onClick={() => void save()}>저장하고 재연결</button>
      </Panel>
      <Panel title="Runner">
        <p className="settings-session-note">
          Workspace에 바인딩된 실행 호스트를 등록합니다. 계정 로그인 · 소유자 지문 확인 · 호스트 측 제공자 자격 증명.
        </p>
        <button type="button" data-testid="settings-open-runner" onClick={() => openRunnerSetup?.()}>Runner 설정 열기</button>
      </Panel>
      <Panel title="AI 실행">
        <WorkspaceInferencePolicyPanel
          loadSettings={() => hermesApi.getSettings()}
          saveSettings={(payload) => hermesApi.saveSettings(payload)}
        />
      </Panel>
      <Panel title="시작 가이드">
        <p className="settings-session-note">캘린더, Runner, Wiki, Calendar AI의 연결 상태를 다시 확인합니다.</p>
        <button type="button" data-testid="settings-open-onboarding" onClick={() => openOnboarding?.()}>시작 가이드 다시 열기</button>
      </Panel>
      <Panel title="배포 상태"><DeploymentStatus status={gatewayStatus} /></Panel>
      <Panel title="Desktop 업데이트">
        <DesktopReleasePanel
          status={desktopReleaseStatus}
          busy={desktopReleaseBusy}
          error={desktopReleaseError}
          onCheck={onCheckDesktopRelease}
          onDownload={onDownloadDesktopRelease}
          onInstall={onInstallDesktopRelease}
        />
      </Panel>
      <Panel title="테마">
        <div className="theme-row">
          {(['default', 'warm', 'dark', 'sage', 'mono'] as DesktopTheme[]).map((item) => (
            <button data-active={theme === item} key={item} onClick={() => setTheme(item)}>{item}</button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function LoginScreen({
  loginWithAuthKit,
  authBusy,
  authPhase,
  loginStatus,
}: {
  loginWithAuthKit: () => void;
  authBusy: boolean;
  authPhase: 'idle' | 'opening' | 'waiting' | 'completing' | 'error';
  loginStatus: string;
}) {
  return (
    <AgentCalendarLoginExperience
      mode="page"
      loginWithAuthKit={loginWithAuthKit}
      authBusy={authBusy}
      authPhase={authPhase}
      loginStatus={loginStatus}
    />
  );
}

function AgentCalendarLoginExperience({
  mode,
  loginWithAuthKit,
  authBusy,
  authPhase,
  loginStatus,
}: {
  mode: 'overlay' | 'page';
  loginWithAuthKit: () => void;
  authBusy: boolean;
  authPhase: 'idle' | 'opening' | 'waiting' | 'completing' | 'error';
  loginStatus: string;
}) {
  const phaseLabel = authPhase === 'opening'
    ? '브라우저를 여는 중…'
    : authPhase === 'waiting'
      ? '브라우저에서 로그인을 완료하세요'
      : authPhase === 'completing'
        ? '세션을 확인하는 중…'
        : authPhase === 'error'
          ? '로그인에 문제가 있습니다'
          : 'Google 또는 이메일 매직 링크로 계속하세요';
  const buttonLabel = authBusy
    ? (authPhase === 'waiting' ? '브라우저에서 계속…' : '로그인 중…')
    : 'AuthKit으로 계속하기';

  return (
    <div className={mode === 'overlay' ? 'login-overlay' : 'login screen-in'} data-auth-phase={authPhase}>
      <section className="login-card login-card-authkit login-workspace-entry" aria-busy={authBusy || undefined}>
        <div className="login-form" role="form" aria-labelledby="authkit-login-title">
          <div className="login-form-brand">
            <LogoMark className="login-brand-mark" />
            <span><strong>Agent Calendar</strong></span>
          </div>
          <h2 id="authkit-login-title">작업공간 로그인</h2>
          <p className="login-lede">{phaseLabel}</p>

          {loginStatus && (
            <div className="login-status" role="alert" aria-live="assertive">{loginStatus}</div>
          )}
          {!loginStatus && authBusy && (
            <div className="login-status login-status-progress" role="status" aria-live="polite">{phaseLabel}</div>
          )}

          <button
            className="primary login-submit login-authkit"
            type="button"
            onClick={() => loginWithAuthKit()}
            disabled={authBusy}
            aria-disabled={authBusy}
          >
            {buttonLabel}
          </button>

          <p className="login-boundary-note">세션은 이 기기에서 암호화됩니다.</p>
        </div>
      </section>
    </div>
  );
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
    if (!startDate) return '날짜';
    const date = new Date(`${startDate}T00:00:00`);
    const dayText = Number.isNaN(date.getTime()) ? startDate : `${date.getMonth() + 1}월 ${date.getDate()}일`;
    const prefix = startDate === todayKey() ? '오늘, ' : startDate === addDaysKey(todayKey(), 1) ? '내일, ' : '';
    const timeText = allDay ? '' : startTime ? `, ${formatTime(startTime)}${endTime ? ` - ${formatTime(endTime)}` : ''}` : '';
    return `${prefix}${dayText}${timeText}`;
  })();
  const patchDate = (value: string) => patchItem(detailTask, { date: value, startDate: value });
  const patchTime = (value: string) => patchItem(detailTask, { time: value });
  const patchEnd = (patch: Item) => (isEvent ? patchCalendarEvent(detailTask, patch) : patchTask(detailTask, patch));
  const clearDate = () => {
    setDurationDraft({ date: '', time: '', endDate: '', endTime: '' });
    setDateMode('date');
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
    setToolPanel(null);
    setListOpen(false);
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
        <button className="detail-date-trigger" data-open={dateOpen} aria-expanded={dateOpen} onClick={openDateEditor}><SystemIcon name="calendar" className="detail-date-icon" />{dateTitle}</button>
        <button className="detail-flag" aria-label="우선순위" onClick={() => patchItem(detailTask, { priority: text(detailTask.priority) ? '' : 'P1' })}>⚐</button>
        <button className="detail-delete" disabled={deleting} onClick={() => void deleteSelected()} aria-label="삭제" title="삭제">{deleting ? '삭제 중' : '삭제'}</button>
        <button className="detail-close" onClick={close}>✕</button>
      </header>
      <main className="detail-compose" data-done={isDone(detailTask)}>
        <div className="detail-title-row">
          <input className="detail-title-input" defaultValue={itemTitle(detailTask, '')} onBlur={(event) => patchItem(detailTask, { title: event.target.value })} placeholder="무엇을 하고 싶으신가요?" autoFocus />
          <button className="detail-checklist-toggle" aria-label="상세 메뉴" title="상세 메뉴" onClick={() => setToolPanel(toolPanel === 'more' ? null : 'more')}>☰</button>
        </div>
        <textarea className="detail-notes-input" defaultValue={notes} onBlur={(event) => patchItem(detailTask, { notes: event.target.value })} placeholder="설명 또는 메모 추가" />
      </main>
      <footer className="detail-bottomline">
        <button className="detail-list-pill" onClick={() => setListOpen((open) => !open)}><span>{activeList.icon || '▣'}</span>{activeList.label}<b>▾</b></button>
        <button className="detail-tool" data-active={toolPanel === 'format'} title="서식" aria-label="서식" onClick={() => setToolPanel(toolPanel === 'format' ? null : 'format')}><b>B</b></button>
        <button className="detail-tool" data-active={toolPanel === 'comment'} title="댓글" aria-label="댓글" onClick={() => setToolPanel(toolPanel === 'comment' ? null : 'comment')}>◌</button>
        {!isEvent && <button className="detail-tool detail-agent" title="위임" aria-label="위임" onClick={delegate}>↗</button>}
        <button className="detail-tool" data-active={toolPanel === 'more'} title="더보기" aria-label="더보기" onClick={() => setToolPanel(toolPanel === 'more' ? null : 'more')}>•••</button>
        <span />
        <button className="detail-submit" onClick={close} aria-label="닫기">↑</button>
      </footer>
      {deleteError && <div className="detail-error">{deleteError}</div>}
      {toolPanel && <div className="detail-tool-popover">
        {toolPanel === 'format' && <><strong>서식 추가</strong><div className="tool-chip-row"><button onClick={() => appendDetailNotes('## 소제목')}>제목</button><button onClick={() => appendDetailNotes('- 항목')}>목록</button><button onClick={() => appendDetailNotes('```\\n코드\\n```')}>코드</button></div></>}
        {toolPanel === 'comment' && <><strong>댓글</strong><div><input value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addDetailComment(); }} placeholder="댓글 입력" autoFocus /><button onClick={() => void addDetailComment()}>남기기</button></div></>}
        {toolPanel === 'more' && <><strong>빠른 작업</strong><div className="tool-chip-row"><button onClick={() => patchDate(todayKey())}>오늘로</button><button onClick={() => patchDate(addDaysKey(todayKey(), 1))}>내일로</button><button onClick={() => patchEnd({ repeat: repeat === 'weekly' ? 'none' : 'weekly' })}>{repeat === 'weekly' ? '반복 해제' : '매주 반복'}</button>{!isEvent && <button onClick={delegate}>위임</button>}<button className="danger" disabled={deleting} onClick={() => void deleteSelected()}>{deleting ? '삭제 중' : '삭제'}</button></div></>}
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
          <button className="detail-date-row" data-kind="time" onClick={() => setDateMode('duration')}><DateRowIcon name="time" />{startTime ? formatTime(startTime) : '시간 추가'}<b>›</b></button>
          <button className="detail-date-row" data-kind="reminder" data-active={reminderOn} data-removable={reminderOn} onClick={toggleReminder} aria-label={reminderOn ? '알림 해제' : '정각에'}><DateRowIcon name="reminder" />{reminderOn ? '알림' : '정각에'}<b>{reminderOn ? '×' : '›'}</b></button>
          <button className="detail-date-row" data-kind="repeat" data-active={repeat !== 'none'} data-removable={repeat !== 'none'} onClick={() => patchEnd({ repeat: repeat === 'none' ? 'weekly' : 'none', recurrence: repeat === 'none' ? 'weekly' : '' })} aria-label={repeat === 'none' ? '반복' : '반복 해제'}><DateRowIcon name="repeat" />{repeat === 'none' ? '반복' : repeatLabel(repeat)}<b>{repeat === 'none' ? '›' : '×'}</b></button>
        </> : <>
          <div className="duration-grid">
            <label>시작</label><input value={durationDraft.date} onChange={(event) => setDurationDraft((current) => ({ ...current, date: event.target.value }))} /><input value={durationDraft.time} onChange={(event) => setDurationDraft((current) => ({ ...current, time: event.target.value }))} placeholder="오후 5:00" />
            <label>끝</label><input value={durationDraft.endDate} onChange={(event) => setDurationDraft((current) => ({ ...current, endDate: event.target.value }))} /><input value={durationDraft.endTime} onChange={(event) => setDurationDraft((current) => ({ ...current, endTime: event.target.value }))} placeholder="오후 6:00" />
            <label>전체</label><span className="duration-spacer" /><button className="duration-toggle" data-active={allDay} onClick={() => patchEnd({ allDay: !allDay, time: allDay ? startTime : '' })}><span /></button>
          </div>
          <button className="detail-date-row" data-kind="reminder" data-active={reminderOn} data-removable={reminderOn} onClick={toggleReminder} aria-label={reminderOn ? '알림 해제' : '정각에'}><DateRowIcon name="reminder" />{reminderOn ? '알림' : '정각에'}<b>{reminderOn ? '×' : '›'}</b></button>
          <button className="detail-date-row" data-kind="repeat" data-active={repeat !== 'none'} data-removable={repeat !== 'none'} onClick={() => patchEnd({ repeat: repeat === 'none' ? 'weekly' : 'none', recurrence: repeat === 'none' ? 'weekly' : '' })} aria-label={repeat === 'none' ? '반복' : '반복 해제'}><DateRowIcon name="repeat" />{repeat === 'none' ? '반복' : repeatLabel(repeat)}<b>{repeat === 'none' ? '›' : '×'}</b></button>
        </>}
        <footer><button onClick={clearDate}>삭제</button><button className="primary" onClick={confirmDateEditor}>확인</button></footer>
      </div>}
    </div>
  </div>;
}

function Modal({ modal, setModal, newTitle, setNewTitle, newDesc, setNewDesc, newTask, createTask, lists, tags, agents, runs, selectedRun, selectedTask, patchTask, patchCalendarEvent, removeTask, removeCalendarEvent, toggleTask, delegateText, setDelegateText, delegateAgentId, setDelegateAgentId, startPlan, openRunArtifact, approveRun, newAgentName, setNewAgentName, newAgentRole, setNewAgentRole, newAgentEmoji, setNewAgentEmoji, createAgent, settings, gatewayStatus, setSettings, refresh, setApiError, loggedIn, setLoggedIn, logout, loginWithAuthKit, authBusy, authPhase, loginStatus, prefs, updatePrefs, openOnboarding, desktopReleaseStatus, desktopReleaseBusy, desktopReleaseError, onCheckDesktopRelease, onDownloadDesktopRelease, onInstallDesktopRelease }: { modal: ModalId; setModal: (modal: ModalId) => void; newTitle: string; setNewTitle: (value: string) => void; newDesc: string; setNewDesc: (value: string) => void; newTask: NewTaskControls; createTask: (extraNotes?: string) => Promise<void>; lists: TaxonomyItem[]; tags: TaxonomyItem[]; agents: Item[]; runs: Item[]; selectedRun?: Item; selectedTask?: Item; patchTask: (task: Item, patch: Item) => boolean | Promise<boolean>; patchCalendarEvent: (task: Item, patch: Item) => boolean | Promise<boolean>; removeTask: (task: Item) => boolean | Promise<boolean>; removeCalendarEvent: (task: Item) => boolean | Promise<boolean>; toggleTask: (task: Item) => void; delegateText: string; setDelegateText: (value: string) => void; delegateAgentId: string; setDelegateAgentId: (value: string) => void; startPlan: () => void; openRunArtifact: (run?: Item) => void; approveRun: (run: Item) => void; newAgentName: string; setNewAgentName: (value: string) => void; newAgentRole: string; setNewAgentRole: (value: string) => void; newAgentEmoji: string; setNewAgentEmoji: (value: string) => void; createAgent: () => void; settings: DesktopSettingsState; gatewayStatus: ApiEnvelope; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; setApiError: (value: string) => void; loggedIn: boolean; setLoggedIn: (value: boolean) => void; logout: () => Promise<void>; loginWithAuthKit: () => void; authBusy: boolean; authPhase: 'idle' | 'opening' | 'waiting' | 'completing' | 'error'; loginStatus: string; prefs: UiPreferences; updatePrefs: (value: UiPreferences) => Promise<void>; openOnboarding: () => void; desktopReleaseStatus: HermesDesktopReleaseStatus; desktopReleaseBusy: '' | 'check' | 'download' | 'install'; desktopReleaseError: string; onCheckDesktopRelease: () => void; onDownloadDesktopRelease: () => void; onInstallDesktopRelease: () => void }) {
  if (!modal) return null;
  if (modal === 'new') {
    return <div className="modal-backdrop new-task-backdrop" onMouseDown={() => setModal(null)}><NewTaskModal title={newTitle} setTitle={setNewTitle} desc={newDesc} setDesc={setNewDesc} controls={newTask} lists={lists} close={() => setModal(null)} submit={createTask} /></div>;
  }
  if (modal === 'settings') {
    return <SettingsOverlay settings={settings} gatewayStatus={gatewayStatus} setSettings={setSettings} refresh={refresh} setApiError={setApiError} close={() => setModal(null)} loggedIn={loggedIn} setLoggedIn={setLoggedIn} logout={logout} loginWithAuthKit={loginWithAuthKit} authBusy={authBusy} authPhase={authPhase} loginStatus={loginStatus} prefs={prefs} updatePrefs={updatePrefs} openOnboarding={openOnboarding} desktopReleaseStatus={desktopReleaseStatus} desktopReleaseBusy={desktopReleaseBusy} desktopReleaseError={desktopReleaseError} onCheckDesktopRelease={onCheckDesktopRelease} onDownloadDesktopRelease={onDownloadDesktopRelease} onInstallDesktopRelease={onInstallDesktopRelease} />;
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
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
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
  const submitTask = async () => {
    if (submittingRef.current || !title.trim()) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await submit(checklistNotes());
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const applyPreset = (kind: 'today' | 'tomorrow' | 'nextWeek' | 'evening') => {
    const preset = quickDatePreset(kind, controls.date);
    setQuickDate(preset.date);
    controls.setTime(preset.time);
    controls.setAllDay(kind !== 'evening');
    controls.setSubPanel(null);
  };
  const clearNewDate = () => {
    controls.setDate('');
    controls.setTime('');
    controls.setEndDate('');
    controls.setEndTime('');
    controls.setAllDay(false);
    controls.setRepeat('none');
    controls.setReminderOn(false);
    controls.setSubPanel(null);
    controls.setMode('date');
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
          <div className="picker-head"><strong>{pickerLabel}</strong><span /><button onClick={() => shiftMonth(-1)}>‹</button><button onClick={() => setQuickDate(todayKey())}>○</button><button onClick={() => shiftMonth(1)}>›</button></div>
          <div className="picker-weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="picker-grid">{pickerCells.map((cell) => <button data-date={cell.iso} data-muted={!cell.inMonth} data-today={cell.today} data-active={cell.selected} key={cell.iso} onClick={() => setQuickDate(cell.iso)}>{cell.day}</button>)}</div>
          <button className="new-date-control-row" data-kind="time" onClick={() => controls.setSubPanel(controls.subPanel === 'time' ? null : 'time')}><DateRowIcon name="time" />{controls.allDay ? '종일' : controls.time ? formatTime(controls.time) : '시간 추가'}<b>›</b></button>
          {controls.subPanel === 'time' && <div className="sub-panel">
            <div className="all-day-row"><span>종일</span><button className="switch" data-active={controls.allDay} onClick={() => { controls.setAllDay(!controls.allDay); if (!controls.allDay) controls.setTime(''); }}><span /></button>{controls.time && <button onClick={() => controls.setTime('')}>지우기</button>}</div>
            {timeMenuList('date', controls.time, 'date-time-menu')}
          </div>}
          <button className="new-date-control-row" data-kind="reminder" data-active={controls.reminderOn} data-removable={controls.reminderOn} onClick={() => controls.setReminderOn(!controls.reminderOn)} aria-label={controls.reminderOn ? '알림 해제' : '정각에'}><DateRowIcon name="reminder" />{controls.reminderOn ? '알림' : '정각에'}<b>{controls.reminderOn ? '×' : '›'}</b></button>
          <button className="new-date-control-row" data-kind="repeat" data-active={controls.repeat !== 'none'} data-removable={controls.repeat !== 'none'} onClick={() => controls.setRepeat(controls.repeat === 'none' ? 'weekly' : 'none')} aria-label={controls.repeat === 'none' ? '반복' : '반복 해제'}><DateRowIcon name="repeat" />{controls.repeat === 'none' ? '반복' : repeatLabel(controls.repeat)}<b>{controls.repeat === 'none' ? '›' : '×'}</b></button>
        </> : <div className="duration-grid">
          <span>시작</span>{durationDateField('start', controls.date, controls.setDate)}{durationTimeField('start', controls.time, '시간')}
          <span>끝</span>{durationDateField('end', controls.endDate, controls.setEndDate)}{durationTimeField('end', controls.endTime, '시간')}
          <span>전체</span><span className="duration-spacer" /><button className="duration-toggle" data-active={controls.allDay} onClick={() => controls.setAllDay(!controls.allDay)}><span /></button>
        </div>}
        {controls.mode === 'duration' && <>
          <button className="new-date-control-row" data-kind="reminder" data-active={controls.reminderOn} data-removable={controls.reminderOn} onClick={() => controls.setReminderOn(!controls.reminderOn)} aria-label={controls.reminderOn ? '알림 해제' : '정각에'}><DateRowIcon name="reminder" />{controls.reminderOn ? '알림' : '정각에'}<b>{controls.reminderOn ? '×' : '›'}</b></button>
          <button className="new-date-control-row" data-kind="repeat" data-active={controls.repeat !== 'none'} data-removable={controls.repeat !== 'none'} onClick={() => controls.setRepeat(controls.repeat === 'none' ? 'weekly' : 'none')} aria-label={controls.repeat === 'none' ? '반복' : '반복 해제'}><DateRowIcon name="repeat" />{controls.repeat === 'none' ? '반복' : repeatLabel(controls.repeat)}<b>{controls.repeat === 'none' ? '›' : '×'}</b></button>
        </>}
        <footer className="new-date-footer"><button onClick={clearNewDate}>삭제</button><button className="primary" onClick={() => controls.setDatePanel(false)}>확인</button></footer>
      </div>}

    </div>
    <footer className="new-task-footer">
      <button className="new-list-button" onClick={() => { controls.setListPanel(!controls.listPanel); controls.setDatePanel(false); }}>{activeList?.icon || '📥'} {activeList?.label || '기본함'} ▾</button>
      <span />
      <button className="new-submit" disabled={!title.trim() || submitting} onClick={() => void submitTask()} aria-label="작업 만들기">↑</button>
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

function SettingsOverlay({ settings, gatewayStatus, setSettings, refresh, setApiError, close, loggedIn, setLoggedIn, logout, loginWithAuthKit, authBusy, authPhase, loginStatus, prefs, updatePrefs, openOnboarding, desktopReleaseStatus, desktopReleaseBusy, desktopReleaseError, onCheckDesktopRelease, onDownloadDesktopRelease, onInstallDesktopRelease }: { settings: DesktopSettingsState; gatewayStatus: ApiEnvelope; setSettings: (settings: DesktopSettingsState) => void; refresh: () => Promise<void>; setApiError: (value: string) => void; close: () => void; loggedIn: boolean; setLoggedIn: (value: boolean) => void; logout: () => Promise<void>; loginWithAuthKit: () => void; authBusy: boolean; authPhase: 'idle' | 'opening' | 'waiting' | 'completing' | 'error'; loginStatus: string; prefs: UiPreferences; updatePrefs: (value: UiPreferences) => Promise<void>; openOnboarding: () => void; desktopReleaseStatus: HermesDesktopReleaseStatus; desktopReleaseBusy: '' | 'check' | 'download' | 'install'; desktopReleaseError: string; onCheckDesktopRelease: () => void; onDownloadDesktopRelease: () => void; onInstallDesktopRelease: () => void }) {
  type SettingsPaneId = 'account' | 'ai' | 'theme' | 'runtime' | 'release' | 'preferences';
  const [activeSettingsPane, setActiveSettingsPane] = useState<SettingsPaneId>('account');
  const settingsPanes: ReadonlyArray<{ id: SettingsPaneId; label: string; description: string }> = [
    { id: 'account', label: '계정', description: '현재 작업공간과 로그인 세션을 관리합니다.' },
    { id: 'ai', label: 'AI 실행', description: 'Calendar AI와 Wiki AI가 실행될 위치를 선택합니다.' },
    { id: 'theme', label: '화면', description: '이 기기에서 사용할 화면 테마를 선택합니다.' },
    { id: 'runtime', label: 'Runtime', description: 'Desktop과 서버 배포의 연결 상태를 확인합니다.' },
    { id: 'release', label: '업데이트', description: '새 Desktop 버전을 확인하고 설치합니다.' },
    { id: 'preferences', label: '알림', description: '일정과 에이전트 작업의 기본 알림을 설정합니다.' },
  ];
  const themes: Array<[DesktopTheme, string]> = [
    ['default', 'Terracotta'],
    ['warm', 'Warm'],
    ['dark', 'Dark'],
    ['sage', 'Sage'],
    ['mono', 'Mono'],
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
  const accountName = settings.authProfile?.name || 'Operator';
  const accountEmail = settings.authProfile?.email || '';
  const accountInitial = (accountName || accountEmail || 'A').trim().slice(0, 1).toUpperCase();
  const activePane = settingsPanes.find((pane) => pane.id === activeSettingsPane) || settingsPanes[0];
  return <div className="settings-backdrop" onMouseDown={close}>
    <div className="settings-overlay" onMouseDown={(event) => event.stopPropagation()}>
      <aside className="settings-sidebar">
        <button className="settings-sidebar-title" type="button" onClick={close}>
          <CaretLeft size={15} weight="bold" aria-hidden="true" />
          <LogoMark />
          <strong>Agent Calendar</strong>
        </button>
        <nav aria-label="설정 영역">
          <button
            className="settings-nav-button settings-setup-guide-button"
            type="button"
            data-testid="settings-open-onboarding"
            onClick={openOnboarding}
          >
            <span><strong>시작 설정</strong><small>연결 항목 확인</small></span>
          </button>
          {settingsPanes.map((pane) => (
            <button
              className="settings-nav-button"
              type="button"
              key={pane.id}
              data-testid={`settings-nav-${pane.id}`}
              data-active={activeSettingsPane === pane.id}
              onClick={() => setActiveSettingsPane(pane.id)}
            >
              {pane.label}
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-account">
          {settings.authProfile?.picture
            ? <img className="avatar" src={settings.authProfile.picture} alt="" />
            : <span className="avatar">{accountInitial}</span>}
          <span><strong>{accountName}</strong><small>{accountEmail || '세션 활성'}</small></span>
        </div>
      </aside>

      <div className="settings-main">
        <header>
          <div><h2>{activePane.label}</h2><p>{activePane.description}</p></div>
          <button aria-label="설정 닫기" onClick={close}><X size={16} weight="regular" aria-hidden="true" /></button>
        </header>
        <div className="settings-body">
          {activeSettingsPane === 'account' && <section className="settings-section" id="settings-account" aria-labelledby="settings-account-title">
            <div className="settings-section-head"><h3 id="settings-account-title">작업공간 계정</h3><p>이 기기에 연결된 현재 세션입니다.</p></div>
            <div className="account-box">{settings.authProfile?.picture ? <img className="avatar large" src={settings.authProfile.picture} alt="" /> : <div className="avatar large">{accountInitial}</div>}<div><strong>{accountName}</strong><span>{loggedIn ? (accountEmail || '세션 활성') : '로그인이 필요합니다'}</span></div>{loggedIn ? <button onClick={() => void logout()}>로그아웃</button> : <button className="primary" onClick={() => loginWithAuthKit()} disabled={authBusy}>{authBusy ? '로그인 중…' : 'AuthKit으로 계속하기'}</button>}</div>
            {!loggedIn && <div className="login-inline authkit-inline"><p>시스템 브라우저에서 Google 또는 이메일로 로그인합니다.</p>{loginStatus ? <div className="login-status" role="alert">{loginStatus}</div> : null}<button className="primary" onClick={() => loginWithAuthKit()} disabled={authBusy}>{authBusy ? '브라우저에서 계속…' : '로그인'}</button></div>}
          </section>}

          {activeSettingsPane === 'theme' && <section className="settings-section" id="settings-theme" aria-labelledby="settings-theme-title">
            <div className="settings-section-head"><h3 id="settings-theme-title">테마</h3><p>선택한 테마는 이 기기에 바로 적용됩니다.</p></div>
            <div className="settings-theme-list">{themes.map(([key, label]) => <button data-active={settings.theme === key} key={key} onClick={() => void saveTheme(key)}><i data-theme-swatch={key} /><span><b>{label}</b><small>{settings.theme === key ? '사용 중' : ''}</small></span></button>)}</div>
          </section>}

          {activeSettingsPane === 'ai' && <section className="settings-section" id="settings-ai" aria-labelledby="settings-ai-title">
            <div className="settings-section-head"><h3 id="settings-ai-title">Workspace AI 실행</h3><p>Calendar AI와 Wiki AI는 같은 정책을 사용하며 다른 작업공간의 Runner를 사용하지 않습니다.</p></div>
            <WorkspaceInferencePolicyPanel
              loadSettings={() => hermesApi.getSettings()}
              saveSettings={(payload) => hermesApi.saveSettings(payload)}
            />
          </section>}

          {activeSettingsPane === 'runtime' && <section className="settings-section" id="settings-runtime" aria-labelledby="settings-runtime-title">
            <div className="settings-section-head"><h3 id="settings-runtime-title">연결 상태</h3><p>Desktop과 Gateway가 같은 배포를 보고 있는지 확인합니다.</p></div>
            <DeploymentStatus status={gatewayStatus} />
          </section>}

          {activeSettingsPane === 'release' && <section className="settings-section" id="settings-release" aria-labelledby="settings-release-title">
            <div className="settings-section-head"><h3 id="settings-release-title">Desktop 업데이트</h3><p>새 버전은 확인한 뒤 직접 설치합니다.</p></div>
            <DesktopReleasePanel
              status={desktopReleaseStatus}
              busy={desktopReleaseBusy}
              error={desktopReleaseError}
              onCheck={onCheckDesktopRelease}
              onDownload={onDownloadDesktopRelease}
              onInstall={onInstallDesktopRelease}
            />
          </section>}

          {activeSettingsPane === 'preferences' && <section className="settings-section" id="settings-preferences" aria-labelledby="settings-pref-title">
            <div className="settings-section-head"><h3 id="settings-pref-title">알림 및 일정</h3><p>이 기기에서 사용할 기본 동작입니다.</p></div>
            <div className="pref-box">{prefRows.map(([key, label, desc]) => <div className="pref-row" key={key}><span className="pref-copy"><b>{label}</b><small>{desc}</small></span><button className="switch" aria-label={`${label} ${prefs[key] ? '끄기' : '켜기'}`} data-active={prefs[key]} onClick={() => void updatePrefs({ ...prefs, [key]: !prefs[key] })}><span /></button></div>)}</div>
          </section>}
        </div>
      </div>
    </div>
  </div>;
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
