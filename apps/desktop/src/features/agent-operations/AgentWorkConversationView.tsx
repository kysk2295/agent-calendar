import { useEffect, useRef, useState } from 'react';

import { missionStatusLabel } from './AgentOperationViews';
import { AgentWorkComposer } from './AgentWorkComposer';
import { AgentWorkDetails } from './AgentWorkDetails';
import { AgentWorkTimeline } from './AgentWorkTimeline';
import { AgentWorkerStrip, projectAgentWorkerRows } from './AgentWorkerStrip';
import { executionEngineLabel, resolvedExecutionEngineLabel } from './executionContracts';
import {
  engineAuthenticationPresentation,
  engineModels,
  type PublicRunner,
  type RunnerEngineModels,
} from '../runner/runnerApi';
import {
  preserveWorkClosingPhrase,
  responsibleAgentAssignmentCopy,
  telegramIngressOwnershipLabel,
  telegramIngressReadinessLabel,
  wikiArchiveStatusLabel,
} from './workConversationPresentation';
import type {
  AgentDirectoryMutationInput,
  AgentExecutionEngine,
  AgentMission,
  AgentReport,
  AgentRosterEntry,
  AgentTask,
  AgentTaskAction,
} from './types';
import type {
  AgentWorkComparisonTarget,
  AgentWorkConversationPage,
  AgentWorkDelivery,
} from './workConversationTypes';
import type { AgentWorkLiveTurnState } from './useAgentWorkLiveTurn';
import { AgentWorkDelegationPanel } from './AgentWorkDelegationPanel';

type AgentWorkConversationViewProps = {
  readonly mission: AgentMission;
  readonly tasks: readonly AgentTask[];
  readonly reports: readonly AgentReport[];
  readonly responsibleAgentName: string;
  readonly responsibleAgent?: AgentRosterEntry | null;
  readonly provisional: boolean;
  readonly conversation: AgentWorkConversationPage | null;
  readonly loading: boolean;
  readonly error: string;
  readonly operationError?: string;
  readonly aggregateStale: boolean;
  readonly busy: string;
  readonly onBack: () => void;
  readonly onRefresh: () => Promise<boolean>;
  readonly onSendMessage: (
    text: string,
    executionEngine: AgentExecutionEngine | undefined,
    requestedModel: string,
    comparisonTargets?: readonly AgentWorkComparisonTarget[],
  ) => Promise<AgentWorkDelivery>;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'activate' | 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
  readonly onPinAgentMemory?: (agentId: string, input: AgentDirectoryMutationInput) => Promise<boolean>;
  readonly liveTurn: AgentWorkLiveTurnState;
  readonly runners: readonly PublicRunner[];
  readonly controlPlaneBaseUrl: string;
};

function attentionSummary(props: AgentWorkConversationViewProps): string {
  if (props.aggregateStale) return '상태 확인 필요 · 최신 작업 상태를 불러올 때까지 작업 제어는 잠시 숨겨집니다.';
  if (props.error) return '확인 필요 · 작업 대화를 다시 불러와 주세요.';
  if (props.loading) return '불러오는 중 · 이전 작업 기록을 확인하고 있습니다.';
  if (props.tasks.some((task) => task.status === 'proposed')) return '승인 필요 · 제안의 범위와 결과를 검토해 주세요.';
  if (props.tasks.some((task) => task.status === 'blocked')) return '확인 필요 · 막힌 이유를 확인하고 안전한 다음 행동을 선택해 주세요.';
  if (props.tasks.some((task) => task.status === 'failed')) return '재시도 필요 · 실패 원인을 확인한 뒤 다시 시도해 주세요.';
  if (props.tasks.some((task) => task.status === 'running')) return '진행 중 · 현재 실행을 지켜보거나 새 지시를 남길 수 있습니다.';
  switch (props.mission.status) {
    case 'draft': return '계획 필요 · 요청을 작업 단계로 정리한 뒤 검토하고 시작하세요.';
    case 'active': return '진행 준비 · 다음 실행을 시작하거나 지시를 남길 수 있습니다.';
    case 'paused': return '일시정지 · 재개 전에 변경할 방향을 남겨 주세요.';
    case 'completed': {
      if (props.mission.wikiArchive?.status === 'written') {
        return '결과 검토 · 위키 보관본과 기억 후보를 확인하세요.';
      }
      if (props.mission.proposedMemoryPins?.length) {
        return '결과 검토 · 기억에 남길 후보를 확인한 뒤 필요한 것만 고정하세요.';
      }
      return '결과 검토 · 현재 결과를 확인하거나 같은 목표로 수정을 요청하세요.';
    }
    case 'failed': return '재시도 필요 · 실패 원인을 확인한 뒤 다시 시도해 주세요.';
    case 'cancelled': return '중단됨 · 기록을 검토하거나 별도 작업을 시작할 수 있습니다.';
  }
}

function nextActionLabel(props: AgentWorkConversationViewProps): string {
  if (props.aggregateStale) return '최신 상태 확인';
  if (props.error) return '작업 대화 다시 불러오기';
  if (props.loading || props.provisional) return '위임 작업 상태 확인';
  if (props.tasks.some((task) => task.status === 'proposed')) return '계획 검토 후 승인';
  if (props.tasks.some((task) => task.status === 'blocked')) return '막힌 이유 확인';
  if (props.tasks.some((task) => task.status === 'failed')) return '실패 원인 확인 후 재시도';
  if (props.tasks.some((task) => task.status === 'scheduled')) return '다음 단계 실행';
  if (props.tasks.some((task) => task.status === 'running')) return '진행 확인 또는 추가 지시';
  if (props.mission.status === 'draft' && props.tasks.length === 0) return '계획 만들기';
  switch (props.mission.status) {
    case 'active': return '추가 지시 남기기';
    case 'paused': return '방향 확인 후 재개';
    case 'completed': return '결과 검토 또는 수정 요청';
    case 'failed': return '실패 원인 확인 후 재시도';
    case 'cancelled': return '기록 검토';
    case 'draft': return '계획 검토';
  }
}

export function AgentWorkConversationView(props: AgentWorkConversationViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [actionReceipt, setActionReceipt] = useState('');
  const [nextActionError, setNextActionError] = useState('');
  const [telegramCopyState, setTelegramCopyState] = useState('');
  const [openWorkerId, setOpenWorkerId] = useState<string | null>(null);
  const [pinReceipt, setPinReceipt] = useState('');
  const [pinnedMemoryKeys, setPinnedMemoryKeys] = useState<readonly string[]>([]);
  const assignmentCopy = props.conversation
    ? responsibleAgentAssignmentCopy(props.conversation.work.assignment)
    : '배정 이유 확인 중 · 작업 정보를 불러오고 있습니다.';
  const hasConversationHistory = Boolean(props.conversation?.checkpoints.length);
  const taskAttentionStatus = props.tasks.some((task) => task.status === 'failed')
    ? { label: '재시도 필요', tone: 'failed' }
    : props.tasks.some((task) => task.status === 'blocked')
      ? { label: '확인 필요', tone: 'blocked' }
      : null;
  const statusLabel = taskAttentionStatus?.label || (props.provisional
    ? '불러오는 중'
    : props.mission.status === 'draft' && hasConversationHistory
      ? '대화 진행'
      : missionStatusLabel(props.mission.status));
  const statusTone = taskAttentionStatus?.tone || props.mission.status;
  const attention = attentionSummary(props);
  const resolvedEngine = props.conversation?.work.resolvedExecutionEngine;
  const activeEngine = props.conversation?.work.activeExecutionEngine
    || (resolvedEngine === 'fake' ? 'auto' : resolvedEngine)
    || props.mission.executionEngine;
  const activeModel = props.conversation?.work.activeExecutionModel || '';
  const resolvedModel = props.conversation?.work.resolvedExecutionModel || '';
  const modelCapabilities = ['codex', 'claude', 'grok', 'hermes'].reduce<Record<string, RunnerEngineModels>>(
    (result, engine) => ({ ...result, [engine]: engineModels(props.runners || [], engine) }),
    {},
  );
  const availableEngines = (['codex', 'claude', 'grok', 'hermes'] as const).filter((engine) => (
    (props.runners || []).some((runner) => {
      if (runner.status !== 'active' || runner.connectionState !== 'connected') return false;
      const capabilities = runner.capabilities as { engines?: Record<string, Parameters<typeof engineAuthenticationPresentation>[0]> } | undefined;
      return engineAuthenticationPresentation(capabilities?.engines?.[engine]).ready;
    })
  ));
  const requestedEngine = props.conversation?.work.executionEngine || props.mission.executionEngine;
  const requestedEngineLabel = requestedEngine === 'auto'
    ? '자동 선택'
    : `직접 지정 · ${executionEngineLabel(requestedEngine)}`;
  const actualEngineLabel = resolvedEngine
    ? `${resolvedExecutionEngineLabel(resolvedEngine)}${resolvedModel ? ` · ${resolvedModel}` : ''}`
    : '확인 불가';
  const nextAction = nextActionLabel(props);
  const workerRows = projectAgentWorkerRows({
    mission: props.mission,
    tasks: props.tasks,
    checkpoints: props.conversation?.checkpoints || [],
    responsibleAgentName: props.responsibleAgentName,
    resolvedExecutionEngine: resolvedEngine || null,
    resolvedExecutionModel: resolvedModel,
  });
  const proposedCount = props.tasks.filter((task) => task.status === 'proposed').length;
  const blockedTask = props.tasks.find((task) => task.status === 'blocked');
  const failedTask = props.tasks.find((task) => task.status === 'failed');
  const scheduledTask = props.tasks.find((task) => task.status === 'scheduled');
  const nextActionDisabled = Boolean(props.busy) || props.loading || props.aggregateStale || Boolean(props.error) || props.liveTurn.active;
  const telegramEndpoint = props.conversation?.channels?.find((endpoint) => endpoint.channel === 'telegram');
  const telegramRunner = telegramEndpoint
    ? props.runners.find((runner) => runner.id === telegramEndpoint.runnerId)
    : null;
  const telegramRunnerName = telegramRunner?.hostMetadata
    && typeof telegramRunner.hostMetadata.hostName === 'string'
    ? telegramRunner.hostMetadata.hostName
    : telegramEndpoint?.runnerId || '';
  const telegramIngressLabel = telegramEndpoint
    ? telegramIngressOwnershipLabel(telegramEndpoint.ingressOwnership)
    : '';
  const telegramReadinessLabel = telegramEndpoint
    ? telegramIngressReadinessLabel(
      telegramEndpoint.ingressReadiness,
      telegramEndpoint.status,
      telegramRunner?.connectionState === 'connected',
    )
    : '';
  const telegramCheckedAt = telegramEndpoint?.ingressCheckedAt
    ? new Date(telegramEndpoint.ingressCheckedAt).toLocaleString('ko-KR')
    : '아직 없음';
  const telegramCommand = [
    'agent-calendar-runner telegram-bind',
    `--base-url '${(props.controlPlaneBaseUrl || '<GATEWAY_URL>').replace(/'/g, "'\\''")}'`,
    `--work-conversation-id '${(props.conversation?.conversation.id || '').replace(/'/g, "'\\''")}'`,
    "--chat-id '<TELEGRAM_CHAT_ID>'",
    '--bot-token-env AGENT_CALENDAR_TELEGRAM_BOT_TOKEN',
    `--engine ${activeEngine === 'local_llm' ? 'auto' : activeEngine}`,
  ].join(' ');
  useEffect(() => {
    headingRef.current?.focus();
    setOpenWorkerId(null);
    setPinnedMemoryKeys([]);
    setPinReceipt('');
  }, [props.mission.id]);
  const pinMemory = async (pin: string) => {
    const agent = props.responsibleAgent;
    if (!agent || !props.onPinAgentMemory) {
      setPinReceipt('담당 에이전트 프로필을 찾을 수 없어 기억을 고정하지 못했습니다.');
      return;
    }
    const existing = agent.memories || [];
    if (existing.some((item) => item.trim() === pin.trim())) {
      setPinnedMemoryKeys((current) => current.includes(pin) ? current : [...current, pin]);
      setPinReceipt('이미 에이전트 기억에 있는 항목입니다.');
      return;
    }
    const input: AgentDirectoryMutationInput = {
      displayName: agent.displayName,
      role: agent.role,
      responsibility: agent.responsibility || '',
      instructions: agent.instructions || '',
      responseStyle: agent.responseStyle || '',
      specialties: [...(agent.specialties || [])],
      memories: [...existing, pin],
      sourceKind: agent.sourceKind === 'connected' ? 'connected' : 'native',
      provider: agent.provider || '',
      externalAgentId: agent.externalAgentId || '',
      defaultExecutionEngine: agent.defaultExecutionEngine || 'auto',
      defaultRunnerId: agent.defaultRunnerId || '',
    };
    setPinReceipt('기억을 고정하는 중…');
    const ok = await props.onPinAgentMemory(agent.id, input);
    if (ok) {
      setPinnedMemoryKeys((current) => current.includes(pin) ? current : [...current, pin]);
      setPinReceipt('담당 에이전트 기억에 추가했습니다. 다음 위임부터 반영됩니다.');
    } else {
      setPinReceipt('기억 고정에 실패했습니다. 에이전트 프로필에서 직접 추가해 주세요.');
    }
  };
  const taskAction = async (taskId: string, action: AgentTaskAction) => {
    const label = action === 'approve' ? '승인' : action === 'cancel' ? '거절' : action === 'pause' ? '일시정지' : action === 'resume' ? '재개' : '재시도';
    setActionReceipt(`${label} 요청을 처리하고 있습니다.`);
    try {
      const succeeded = await props.onTaskAction(taskId, action);
      setActionReceipt(succeeded ? `${label} 처리가 완료됐습니다.` : `${label} 요청을 완료하지 못했습니다. 다시 시도해 주세요.`);
      return succeeded;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      setActionReceipt(`${label} 요청을 완료하지 못했습니다. 다시 시도해 주세요.`);
      return false;
    }
  };
  const runNextAction = async (operation: () => Promise<void>) => {
    setNextActionError('');
    try {
      await operation();
      if (!(await props.onRefresh())) {
        setNextActionError('요청 후 최신 작업 대화를 불러오지 못했습니다. 다시 시도해 주세요.');
      }
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      setNextActionError(error.message || '다음 행동을 처리하지 못했습니다. 다시 시도해 주세요.');
    }
  };
  const retryConversation = async () => {
    const succeeded = await props.onRefresh();
    requestAnimationFrame(() => (succeeded
      ? headingRef.current
      : headingRef.current?.closest('.agent-work-conversation')?.querySelector<HTMLElement>('.agent-work-state-error button'))?.focus());
  };
  const copyTelegramCommand = async () => {
    try {
      await navigator.clipboard.writeText(telegramCommand);
      setTelegramCopyState('설정 명령을 복사했습니다.');
    } catch {
      setTelegramCopyState('복사하지 못했습니다. 명령을 직접 선택해 주세요.');
    }
  };
  return (
    <main className="agent-work-conversation">
      <header className="agent-work-header">
        <button className="agent-work-back" type="button" aria-label="관제 홈으로 돌아가기" onClick={props.onBack}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m12.5 4-6 6 6 6" /></svg><span>관제 홈</span></button>
        <div className="agent-work-session-bar">
          <div className="agent-work-header-content">
            <h1 ref={headingRef} tabIndex={-1}>{preserveWorkClosingPhrase(props.mission.title)}</h1>
            <div className="agent-work-status-line">
              <b className="agent-work-status-badge" data-status={statusTone}>{statusLabel}</b>
              {props.mission.delegationMode && (
                <span className="agent-work-assignment" data-testid="agent-work-delegation-mode">
                  <span>모드</span>
                  <strong>{props.mission.delegationMode === 'mode_b' ? 'Mode B · 역할 지정' : 'Mode A · 목표만'}</strong>
                </span>
              )}
              <span className="agent-work-assignment"><span>담당</span><strong>{props.responsibleAgentName}</strong></span>
              <span className="agent-work-next-action"><span>다음 행동</span><strong>{nextAction}</strong></span>
              <span className="agent-work-assignment agent-work-assignment-reason"><span>배정</span><strong>{assignmentCopy}</strong></span>
            </div>
          </div>
          <p className="agent-work-attention">{attention}</p>
          <div className="agent-work-next-action-controls">
            {props.mission.status === 'draft' && props.tasks.length === 0 && !props.loading && !props.error && (
              <button type="button" aria-label="위임 작업 계획 만들기" disabled={nextActionDisabled} onClick={() => void runNextAction(() => props.onPlanMission(props.mission.id))}>계획 만들기</button>
            )}
            {proposedCount > 0 && (
              <button type="button" aria-label="위임 작업 계획 승인" disabled={nextActionDisabled} onClick={() => void runNextAction(() => props.onApprovePlan(props.mission.id))}>계획 승인하고 시작</button>
            )}
            {props.mission.status === 'paused' && (
              <button type="button" aria-label="위임 작업 재개" disabled={nextActionDisabled} onClick={() => void runNextAction(() => props.onMissionWorkAction(props.mission.id, 'activate'))}>위임 작업 재개</button>
            )}
            {blockedTask && (
              <button type="button" aria-label="막힌 작업 단계 재개" disabled={nextActionDisabled || props.busy === blockedTask.id} onClick={() => void runNextAction(async () => { await props.onTaskAction(blockedTask.id, 'resume'); })}>막힌 단계 재개</button>
            )}
            {failedTask && (
              <button type="button" aria-label="실패한 작업 단계 재시도" disabled={nextActionDisabled || props.busy === failedTask.id} onClick={() => void runNextAction(async () => { await props.onTaskAction(failedTask.id, 'retry'); })}>실패한 단계 재시도</button>
            )}
            {scheduledTask && (
              <button type="button" aria-label="다음 작업 단계 지금 실행" disabled={nextActionDisabled || props.busy === scheduledTask.id} onClick={() => void runNextAction(() => props.onRunTaskNow(scheduledTask.id))}>다음 단계 지금 실행</button>
            )}
          </div>
          {nextActionError && <p className="agent-work-next-action-error" role="alert">{nextActionError}</p>}
          {!nextActionError && props.operationError && <p className="agent-work-next-action-error" role="alert">{props.operationError}</p>}
          <details className="agent-work-execution-details">
            <summary>실행 정보</summary>
            <div>
              <span><small>요청</small><strong>{requestedEngineLabel}</strong></span>
              <span><small>실제 실행</small><strong>{actualEngineLabel}</strong></span>
            </div>
          </details>
        </div>
      </header>
      <AgentWorkerStrip
        rows={workerRows}
        openWorkerId={openWorkerId}
        onOpen={setOpenWorkerId}
        onClose={() => setOpenWorkerId(null)}
        onOpenSession={props.onOpenSession}
      />
      {actionReceipt && <p className="agent-work-action-status" role="status" aria-live="polite">{actionReceipt}</p>}
      <details className="agent-work-telegram" data-testid="agent-work-telegram">
        <summary>
          <span>
            <strong>Telegram에서 이어가기</strong>
            <small>이 Work Conversation의 지시와 결과를 Telegram에서도 같은 순서로 봅니다.</small>
          </span>
          <b>{telegramEndpoint ? 'Runner에 등록됨' : '설정 필요'}</b>
        </summary>
        <div className="agent-work-telegram-body">
          {telegramEndpoint ? (
            <dl>
              <div><dt>Runner</dt><dd>{telegramRunnerName}</dd></div>
              <div><dt>운영 준비</dt><dd>{telegramReadinessLabel}</dd></div>
              <div><dt>Telegram 수신</dt><dd>{telegramIngressLabel}</dd></div>
              <div><dt>최근 수신 확인</dt><dd>{telegramCheckedAt}</dd></div>
            </dl>
          ) : (
            <>
              <ol>
                <li>Runner 호스트에 <code>AGENT_CALENDAR_TELEGRAM_BOT_TOKEN</code>을 설정합니다.</li>
                <li>아래 명령의 <code>TELEGRAM_CHAT_ID</code>를 본인 chat id로 바꿉니다.</li>
                <li>명령을 한 번 실행한 뒤 Runner 데몬을 계속 실행합니다.</li>
              </ol>
              <div className="agent-work-telegram-command">
                <code>{telegramCommand}</code>
                <button type="button" onClick={() => void copyTelegramCommand()}>명령 복사</button>
              </div>
              {telegramCopyState && <p role="status" aria-live="polite">{telegramCopyState}</p>}
            </>
          )}
          <p className="agent-work-telegram-boundary">
            Bot token과 chat id는 Runner에만 저장됩니다. Bot 수신 주체는 하나여야 합니다.
            기존 Hermes poller가 같은 Bot을 사용 중이면 전용 Bot을 사용하거나 안전하게 수신 주체를 전환하세요.
          </p>
        </div>
      </details>
      {(props.mission.wikiArchive || (props.mission.proposedMemoryPins?.length || 0) > 0) && (
        <section className="agent-work-archive-panel" aria-label="완료 보관과 기억 후보" data-testid="agent-work-archive-panel">
          {props.mission.wikiArchive && (
            <div className="agent-work-archive-row" data-status={props.mission.wikiArchive.status}>
              <strong>{wikiArchiveStatusLabel(props.mission.wikiArchive.status)}</strong>
              {props.mission.wikiArchive.status === 'written' && props.mission.wikiArchive.relativePath ? (
                <code>{props.mission.wikiArchive.relativePath}</code>
              ) : props.mission.wikiArchive.status === 'pending_local' ? (
                <span>완료 결과는 작업 대화에 안전하게 남아 있습니다. Wiki에서 로컬 폴더를 연결하면 같은 결과를 보관합니다.</span>
              ) : props.mission.wikiArchive.status === 'skipped_no_wiki' ? (
                <span>실행 컴퓨터(또는 Gateway)에 위키 루트가 설정되면 다음 완료부터 자동 보관됩니다.</span>
              ) : (
                <span>작업 결과는 대화에 남아 있습니다. 위키 설정을 확인한 뒤 필요하면 수동으로 복사하세요.</span>
              )}
            </div>
          )}
          {(props.mission.proposedMemoryPins?.length || 0) > 0 && (
            <div className="agent-work-memory-pins">
              <strong>기억 후보</strong>
              <p>자동으로 저장되지 않습니다. 담당 에이전트에 남길 항목만 고정하세요.</p>
              <ul>
                {props.mission.proposedMemoryPins!.map((pin) => {
                  const pinned = pinnedMemoryKeys.includes(pin) || Boolean(props.responsibleAgent?.memories?.includes(pin));
                  return (
                    <li key={pin}>
                      <span>{pin}</span>
                      <button
                        type="button"
                        disabled={pinned || !props.onPinAgentMemory || !props.responsibleAgent || Boolean(props.busy)}
                        onClick={() => void pinMemory(pin)}
                      >
                        {pinned ? '고정됨' : '기억에 고정'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {pinReceipt && <p role="status" aria-live="polite">{pinReceipt}</p>}
            </div>
          )}
        </section>
      )}
      {props.conversation && (
        <div
          data-handoff-count={props.conversation.handoffGraph.handoffs.length}
          data-provider-session-count={props.conversation.providerSessions.length}
          data-comparison-count={props.conversation.comparison.outcomes.length}
        >
          <AgentWorkDelegationPanel
            missionId={props.mission.id}
            conversation={props.conversation}
            disabled={props.aggregateStale || props.loading || Boolean(props.error)}
            onRefresh={props.onRefresh}
          />
        </div>
      )}
      <AgentWorkDetails
        mission={props.mission}
        tasks={props.tasks}
        responsibleAgentName={props.responsibleAgentName}
        assignmentCopy={assignmentCopy}
        resolvedExecutionEngine={props.conversation?.work.resolvedExecutionEngine || null}
        effectiveConfiguration={props.conversation?.effectiveConfiguration}
        busy={props.busy}
        onTaskAction={props.onTaskAction}
        onOpenSession={props.onOpenSession}
        onRefresh={props.onRefresh}
      />
      <div className="agent-work-layout">
        <section className="agent-work-primary" aria-label="작업 대화">
          <AgentWorkTimeline checkpoints={props.conversation?.checkpoints || []} loading={props.loading} error={props.error} readOnly={props.aggregateStale || props.loading || Boolean(props.error)} tasks={props.tasks} reports={props.reports} currentResultReportId={props.conversation?.work.revision.currentResultReportId || ''} responsibleAgentName={props.responsibleAgentName} busy={props.busy} onTaskAction={taskAction} onOpenSession={props.onOpenSession} onReportFeedback={props.onReportFeedback} onFollowUpDecision={props.onFollowUpDecision} onRefresh={props.onRefresh} onRetry={retryConversation} liveTurn={props.liveTurn} />
          <AgentWorkComposer
            onSend={props.onSendMessage}
            activeEngine={activeEngine}
            activeModel={activeModel}
            modelCapabilities={modelCapabilities}
            availableEngines={availableEngines}
            streaming={props.liveTurn.active}
            running={props.mission.status === 'active' || props.tasks.some((task) => task.status === 'running')}
            refreshError={props.error && props.liveTurn.refreshFailed ? '메시지는 저장됐지만 최신 대화를 불러오지 못했습니다. 다시 시도해 주세요.' : ''}
          />
        </section>
      </div>
    </main>
  );
}
