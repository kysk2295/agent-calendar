import type { PublicRunner } from '../runner/runnerApi';

export type OnboardingStepId = 'calendar' | 'runner' | 'wiki' | 'calendar_ai';
export type OnboardingActionKind = 'calendar_connect' | 'calendar_sync' | 'runner_open' | 'wiki_open' | 'calendar_ai_open';

export type OnboardingStep = Readonly<{
  id: OnboardingStepId;
  title: string;
  description: string;
  ready: boolean;
  statusLabel: string;
  actionLabel: string;
  actionKind: OnboardingActionKind;
  /** Offered during setup but never blocks completion. */
  optional?: boolean;
}>;

export type OnboardingReadiness = Readonly<{
  steps: readonly OnboardingStep[];
  completedCount: number;
  allReady: boolean;
  nextStepId: OnboardingStepId;
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
  const wikiReady = localWikiReady || knowledgeSources.some(knowledgeSourceIsReady);
  // Conversation id alone must never fake Calendar AI readiness. Runner is not required.
  const calendarAiExplicitlyAvailable = input.calendarAiAvailable === true;
  const calendarAiReady = calendarAiExplicitlyAvailable || calendarReady;

  const steps: OnboardingStep[] = [
    {
      id: 'calendar',
      title: '캘린더 동기화',
      description: '작업공간 로그인과 별도입니다. 브라우저에서 일정 권한을 승인하면 Google Calendar 일정을 가져옵니다.',
      ready: calendarReady,
      statusLabel: calendarReady ? '동기화 완료' : calendarConnected ? '동기화 필요' : '연결 필요',
      actionLabel: calendarConnected ? '지금 동기화' : 'Google Calendar 연결',
      actionKind: calendarConnected ? 'calendar_sync' : 'calendar_connect',
    },
    {
      id: 'runner',
      title: 'Runner / 실행 컴퓨터',
      description: runnerReady && !activeRunnerConnected
        ? '실행 컴퓨터의 Runner 등록은 완료되었지만 현재 오프라인입니다. 에이전트 작업 전 연결 상태를 확인하세요. 일정과 AI 대화는 Runner 없이도 됩니다.'
        : '에이전트 작업을 내 컴퓨터에서 실행하려면 Runner를 열고 일회용 코드로 이 Workspace에 등록합니다. 일정과 AI 대화는 없어도 됩니다.',
      ready: runnerReady,
      optional: true,
      statusLabel: runnerReady
        ? activeRunnerConnected
          ? 'Runner 등록 완료'
          : 'Runner 등록 완료 · 현재 오프라인'
        : runnerEnrollmentPending
          ? 'Runner 등록 확인 필요'
          : 'Runner 등록 필요',
      actionLabel: runnerReady
        ? activeRunnerConnected ? 'Runner 설정' : 'Runner 연결 확인'
        : runnerEnrollmentPending
          ? 'Runner 등록 계속'
          : 'Runner 등록 시작',
      actionKind: 'runner_open',
    },
    {
      id: 'wiki',
      title: 'Wiki 지식 소스',
      description: wikiReady
        ? localWikiReady
          ? 'LLM_WIKI_VAULT에 연결된 로컬 Vault를 사용합니다.'
          : '현재 Workspace에 연결된 지식 소스를 사용합니다.'
        : 'LLM_WIKI_VAULT에 실제 폴더 경로를 지정하거나 앱에서 파일을 추가하세요. 경로가 없거나 오프라인이면 준비되지 않습니다.',
      ready: wikiReady,
      statusLabel: wikiReady
        ? localWikiReady ? '로컬 Vault 준비 완료' : '지식 소스 준비 완료'
        : 'Vault 또는 소스 연결 필요',
      actionLabel: wikiReady ? 'Wiki 열기' : 'Wiki 설정 열기',
      actionKind: 'wiki_open',
    },
    {
      id: 'calendar_ai',
      title: 'Calendar AI 확인',
      description: calendarAiReady
        ? calendarAiExplicitlyAvailable
          ? 'Calendar AI를 열어 일정에 관해 묻거나 작업을 맡길 수 있습니다.'
          : '연결된 일정에 대해 질문할 수 있습니다. 모델 실행 환경이 없으면 확인 가능한 일정 근거만 사용합니다.'
        : 'Calendar AI를 사용하려면 Google Calendar 동기화를 완료하거나 설정에서 로컬 또는 Workspace AI 실행 환경을 준비하세요.',
      ready: calendarAiReady,
      statusLabel: calendarAiReady ? 'Calendar AI 사용 가능' : 'Calendar AI 준비 안 됨',
      actionLabel: 'Calendar AI 화면 열기',
      actionKind: 'calendar_ai_open',
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
  };
}
