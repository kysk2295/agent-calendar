import type { PublicRunner } from '../runner/runnerApi';

export type OnboardingStepId = 'calendar' | 'wiki' | 'mail' | 'calendar_ai' | 'runner';
export type OnboardingActionKind = 'calendar_connect' | 'calendar_sync' | 'wiki_open' | 'mail_open' | 'calendar_ai_open' | 'runner_open';

export type OnboardingStep = Readonly<{
  id: OnboardingStepId;
  title: string;
  description: string;
  ready: boolean;
  statusLabel: string;
  actionLabel: string;
  actionKind: OnboardingActionKind;
  skipLabel: string;
  skipped?: boolean;
  /** Offered during setup but never blocks completion. */
  optional?: boolean;
}>;

export type OnboardingReadiness = Readonly<{
  steps: readonly OnboardingStep[];
  completedCount: number;
  allReady: boolean;
  nextStepId: OnboardingStepId;
  secondBrainSourceAvailable: boolean;
}>;

type SourceRecord = Readonly<Record<string, unknown>>;

type ReadinessInput = Readonly<{
  calendarSources?: readonly SourceRecord[];
  runners?: readonly PublicRunner[];
  knowledgeSources?: readonly SourceRecord[];
  /** Local vault scan payload (e.g. LLM_WIKI_VAULT / local-wiki status). */
  wiki?: SourceRecord;
  calendarAiConversationId?: string;
  calendarAiAvailable?: boolean;
  mailConnected?: boolean;
  skippedStepIds?: readonly OnboardingStepId[];
}>;

function value(source: SourceRecord, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = source[key];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }
  return '';
}

function knowledgeSourceIsReady(source: SourceRecord): boolean {
  const status = value(source, 'status').toLowerCase();
  const sourceKind = value(source, 'sourceKind', 'source_kind').toLowerCase();
  // Only complete Workspace knowledge rows count — not placeholders or empty labels.
  if (!['ready', 'active'].includes(status)) return false;
  if (!value(source, 'id')) return false;
  if (!value(source, 'path', 'label')) return false;
  if (sourceKind && !['cloud_indexed', 'private_local', 'legacy_wiki'].includes(sourceKind)) {
    return false;
  }
  return true;
}

function localWikiVaultIsReady(wiki: SourceRecord): boolean {
  return wiki.ok === true
    && value(wiki, 'source').toLowerCase() === 'local-wiki'
    && Boolean(value(wiki, 'wikiRoot'));
}

export function mergeCalendarSourceTruth<T extends SourceRecord>(
  current: readonly T[],
  source: T,
): T[] {
  const sourceId = value(source, 'id');
  if (!sourceId) return [...current];
  const index = current.findIndex((candidate) => value(candidate, 'id') === sourceId);
  if (index < 0) return [...current, source];
  return current.map((candidate, candidateIndex) => (
    candidateIndex === index ? source : candidate
  ));
}

export function buildOnboardingReadiness(input: ReadinessInput = {}): OnboardingReadiness {
  const calendarSources = input.calendarSources || [];
  const runners = input.runners || [];
  const knowledgeSources = input.knowledgeSources || [];
  const skippedStepIds = new Set(input.skippedStepIds || []);
  const googleCalendarSources = calendarSources.filter((source) => value(source, 'provider').toLowerCase() === 'google');
  const calendarConnected = googleCalendarSources.some((source) => value(source, 'status').toLowerCase() === 'connected');
  const calendarReady = googleCalendarSources.some((source) => (
    value(source, 'status').toLowerCase() === 'connected'
    && Boolean(value(source, 'lastSyncedAt', 'last_synced_at'))
  ));
  const activeRunners = runners.filter((runner) => String(runner.status || '').toLowerCase() === 'active');
  const activeRunnerConnected = activeRunners.some((runner) => String(runner.connectionState || '').toLowerCase() === 'connected');
  // Registration counts as setup progress; online/offline is reflected in status copy.
  const runnerReady = activeRunners.length > 0;
  const runnerEnrollmentPending = runners.some((runner) => String(runner.status || '').toLowerCase() === 'pending');
  const localWikiReady = localWikiVaultIsReady(input.wiki || {});
  const wikiSourceReady = localWikiReady || knowledgeSources.some(knowledgeSourceIsReady);
  const mailConnected = input.mailConnected === true;
  // Conversation id alone must never fake Calendar AI readiness. Runner is not required.
  const calendarAiExplicitlyAvailable = input.calendarAiAvailable === true;
  const calendarAiReady = calendarAiExplicitlyAvailable || calendarReady;

  const steps: OnboardingStep[] = [
    {
      id: 'calendar',
      title: '캘린더 동기화',
      description: '작업공간 로그인과 별도입니다. 브라우저에서 일정 권한을 승인하면 Google Calendar 일정을 가져옵니다.',
      ready: calendarReady || skippedStepIds.has('calendar'),
      skipped: skippedStepIds.has('calendar'),
      statusLabel: skippedStepIds.has('calendar') ? '내부 캘린더 사용' : calendarReady ? '동기화 완료' : calendarConnected ? '동기화 필요' : '연결 필요',
      actionLabel: calendarConnected ? '지금 동기화' : 'Google Calendar 연결',
      actionKind: calendarConnected ? 'calendar_sync' : 'calendar_connect',
      skipLabel: '내부 캘린더로 계속',
    },
    {
      id: 'wiki',
      title: '기록 연결 (선택)',
      description: wikiSourceReady
        ? localWikiReady
          ? '연결한 로컬 폴더의 기록을 사용합니다.'
          : '현재 Workspace에 연결된 지식 소스를 사용합니다.'
        : '로컬 폴더나 파일을 연결할 수 있습니다. 자료가 없다면 폴더 없이 계속해도 됩니다.',
      ready: wikiSourceReady || skippedStepIds.has('wiki'),
      skipped: skippedStepIds.has('wiki'),
      optional: true,
      statusLabel: skippedStepIds.has('wiki')
        ? '폴더 없이 계속'
        : wikiSourceReady
          ? localWikiReady ? '로컬 폴더 준비 완료' : '지식 소스 준비 완료'
          : '폴더 또는 파일 연결 안 됨',
      actionLabel: wikiSourceReady ? 'Wiki 열기' : 'Wiki 설정 열기',
      actionKind: 'wiki_open',
      skipLabel: '폴더 없이 계속',
    },
    {
      id: 'mail',
      title: 'Google 메일 (선택)',
      description: 'Gmail 읽기 권한은 Google Calendar 권한과 별도로 연결합니다. 메일은 나중에 연결해도 됩니다.',
      ready: mailConnected || skippedStepIds.has('mail'),
      skipped: skippedStepIds.has('mail'),
      optional: true,
      statusLabel: skippedStepIds.has('mail') ? '나중에 연결' : mailConnected ? '메일 연결 완료' : '메일 연결 안 됨',
      actionLabel: mailConnected ? '메일 화면 열기' : 'Google 메일 연결',
      actionKind: 'mail_open',
      skipLabel: 'Google 메일은 나중에 연결',
    },
    {
      id: 'calendar_ai',
      title: 'Calendar AI 확인',
      description: calendarAiReady
        ? calendarAiExplicitlyAvailable
          ? 'Calendar AI를 열어 일정에 관해 묻거나 작업을 맡길 수 있습니다.'
          : '연결된 일정에 대해 질문할 수 있습니다. 모델 실행 환경이 없으면 확인 가능한 일정 근거만 사용합니다.'
        : 'Calendar AI를 사용하려면 Google Calendar 동기화를 완료하거나 설정에서 로컬 또는 Workspace AI 실행 환경을 준비하세요.',
      ready: calendarAiReady || skippedStepIds.has('calendar_ai'),
      skipped: skippedStepIds.has('calendar_ai'),
      statusLabel: skippedStepIds.has('calendar_ai') ? '제한된 상태 확인' : calendarAiReady ? 'Calendar AI 사용 가능' : 'Calendar AI 준비 안 됨',
      actionLabel: 'Calendar AI 화면 열기',
      actionKind: 'calendar_ai_open',
      skipLabel: '제한된 상태로 계속',
    },
    {
      id: 'runner',
      title: '실행 컴퓨터 (선택)',
      description: runnerReady && !activeRunnerConnected
        ? '실행 컴퓨터 등록은 완료되었지만 현재 오프라인입니다. 에이전트 작업 전 연결 상태를 확인하세요. 일정과 AI 대화는 실행 컴퓨터 없이도 됩니다.'
        : '에이전트 작업을 내 컴퓨터에서 실행하려면 일회용 코드로 이 Workspace에 등록합니다. 일정과 AI 대화는 없어도 됩니다.',
      ready: runnerReady || skippedStepIds.has('runner'),
      skipped: skippedStepIds.has('runner'),
      optional: true,
      statusLabel: skippedStepIds.has('runner')
        ? '나중에 연결'
        : runnerReady
          ? activeRunnerConnected
            ? '실행 컴퓨터 등록 완료'
            : '실행 컴퓨터 등록 완료 · 현재 오프라인'
          : runnerEnrollmentPending
            ? '실행 컴퓨터 등록 확인 필요'
            : '실행 컴퓨터 등록 필요',
      actionLabel: runnerReady
        ? activeRunnerConnected ? '실행 컴퓨터 설정' : '연결 확인'
        : runnerEnrollmentPending
          ? '등록 계속'
          : '실행 컴퓨터 연결',
      actionKind: 'runner_open',
      skipLabel: '실행 컴퓨터 없이 계속',
    },
  ];
  const completedCount = steps.filter((step) => step.ready).length;
  const next = steps.find((step) => !step.ready) || steps[steps.length - 1];
  return {
    steps,
    completedCount,
    // An optional step is offered but never withholds 설정 완료.
    allReady: steps.every((step) => step.ready || step.optional === true),
    nextStepId: next.id,
    secondBrainSourceAvailable: calendarReady || wikiSourceReady || mailConnected,
  };
}
