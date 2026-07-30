import { isRunnerCurrentlyReady } from '../runner/runnerConnectionPresentation';
import type { PublicRunner, RunnerEngineCapability } from '../runner/runnerApi';

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

function engineIsReady(capability: RunnerEngineCapability): boolean {
  if (capability.available !== true) return false;
  const authStatus = String(capability.authStatus || '').toLowerCase();
  return ['ok', 'ready', 'authenticated', 'active'].includes(authStatus);
}

function runnerHasReadyEngine(runner: PublicRunner): boolean {
  const capabilities = runner.capabilities as { engines?: Record<string, RunnerEngineCapability> } | undefined;
  return Object.values(capabilities?.engines || {}).some(engineIsReady);
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
  const connectedRunners = runners.filter((runner) => (
    String(runner.status || '').toLowerCase() === 'active'
    && String(runner.connectionState || '').toLowerCase() === 'connected'
  ));
  const connectedRunnerHasReadyEngine = connectedRunners.some(runnerHasReadyEngine);
  const runnerReady = runners.some((runner) => isRunnerCurrentlyReady(runner) && runnerHasReadyEngine(runner));
  const wikiReady = knowledgeSources.some((source) => (
    ['active', 'ready'].includes(value(source, 'status').toLowerCase())
  ));
  // Calendar AI and Wiki AI answer through platform inference, so a Runner is no longer
  // part of their readiness.
  const calendarAiReady = input.calendarAiAvailable === true
    || Boolean(String(input.calendarAiConversationId || '').trim());

  const steps: OnboardingStep[] = [
    {
      id: 'calendar',
      title: '캘린더 동기화',
      description: 'Google Calendar 일정을 가져옵니다.',
      ready: calendarReady,
      statusLabel: calendarReady ? '동기화 완료' : calendarConnected ? '동기화 필요' : '연결 필요',
      actionLabel: calendarConnected ? '지금 동기화' : 'Google Calendar 연결',
      actionKind: calendarConnected ? 'calendar_sync' : 'calendar_connect',
    },
    {
      id: 'runner',
      title: 'Runner와 실행 엔진',
      description: '에이전트 작업을 내 컴퓨터에서 실행하려면 연결합니다. 일정과 AI 대화는 없어도 됩니다.',
      ready: runnerReady,
      optional: true,
      statusLabel: runnerReady
        ? '실행 준비 완료'
        : connectedRunners.length === 0
          ? 'Runner 연결 필요'
          : !connectedRunnerHasReadyEngine
            ? '실행 엔진 인증 필요'
            : '연결 테스트 필요',
      actionLabel: runnerReady
        ? 'Runner 설정'
        : connectedRunners.length === 0
          ? 'Runner 연결'
          : !connectedRunnerHasReadyEngine
            ? '엔진 인증 확인'
            : '연결 테스트',
      actionKind: 'runner_open',
    },
    {
      id: 'wiki',
      title: 'Wiki 지식 소스',
      description: 'Calendar AI가 참고할 문서를 연결합니다.',
      ready: wikiReady,
      statusLabel: wikiReady ? '지식 소스 준비 완료' : '소스 추가 필요',
      actionLabel: 'Wiki 열기',
      actionKind: 'wiki_open',
    },
    {
      id: 'calendar_ai',
      title: 'Calendar AI 확인',
      description: '일정을 묻고 작업을 맡길 수 있습니다.',
      ready: calendarAiReady,
      statusLabel: calendarAiReady ? '대화 준비 완료' : '확인 필요',
      actionLabel: 'Calendar AI 열기',
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
