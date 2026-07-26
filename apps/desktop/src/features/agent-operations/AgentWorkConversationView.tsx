import { useEffect, useRef, useState } from 'react';

import { missionStatusLabel } from './AgentOperationViews';
import { AgentWorkComposer } from './AgentWorkComposer';
import { AgentWorkTimeline } from './AgentWorkTimeline';
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
} from './workConversationPresentation';
import type { AgentExecutionEngine, AgentMission, AgentReport, AgentTask, AgentTaskAction } from './types';
import type {
  AgentWorkComparisonTarget,
  AgentWorkConversationPage,
  AgentWorkDelivery,
} from './workConversationTypes';
import type { AgentWorkLiveTurnState } from './useAgentWorkLiveTurn';

type AgentWorkConversationViewProps = {
  readonly mission: AgentMission;
  readonly tasks: readonly AgentTask[];
  readonly reports: readonly AgentReport[];
  readonly responsibleAgentName: string;
  readonly provisional: boolean;
  readonly conversation: AgentWorkConversationPage | null;
  readonly loading: boolean;
  readonly error: string;
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
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
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
    case 'draft': return props.conversation?.checkpoints.length
      ? '대화 진행 · 다음 지시를 남기면 같은 작업에서 이어서 처리합니다.'
      : '준비됨 · 첫 지시를 남기면 담당 에이전트가 바로 시작합니다.';
    case 'active': return '진행 준비 · 다음 실행을 시작하거나 지시를 남길 수 있습니다.';
    case 'paused': return '일시정지 · 재개 전에 변경할 방향을 남겨 주세요.';
    case 'completed': return '결과 검토 · 현재 결과를 확인하거나 같은 목표로 수정을 요청하세요.';
    case 'failed': return '재시도 필요 · 실패 원인을 확인한 뒤 다시 시도해 주세요.';
    case 'cancelled': return '중단됨 · 기록을 검토하거나 별도 작업을 시작할 수 있습니다.';
  }
}

export function AgentWorkConversationView(props: AgentWorkConversationViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [actionReceipt, setActionReceipt] = useState('');
  const [telegramCopyState, setTelegramCopyState] = useState('');
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
  const runnerDefaultModel = modelCapabilities[activeEngine]?.defaultModel || '';
  const visibleEngine = resolvedEngine
    ? resolvedExecutionEngineLabel(resolvedEngine)
    : executionEngineLabel(activeEngine);
  const engineLabel = `${visibleEngine} · ${resolvedModel || activeModel || runnerDefaultModel || 'Runner 기본 모델'}`;
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
  useEffect(() => { headingRef.current?.focus(); }, [props.mission.id]);
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
              <span className="agent-work-assignment"><span>담당</span><strong>{props.responsibleAgentName}</strong></span>
              <span className="agent-work-session-engine"><span>실행</span><strong>{engineLabel}</strong></span>
              <span className="agent-work-assignment agent-work-assignment-reason"><span>배정</span><strong>{assignmentCopy}</strong></span>
            </div>
          </div>
          <p className="agent-work-attention">{attention}</p>
        </div>
      </header>
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
            refreshError={props.error && props.liveTurn.refreshFailed ? '메시지는 저장됐지만 최신 대화를 불러오지 못했습니다. 다시 시도해 주세요.' : ''}
          />
        </section>
      </div>
    </main>
  );
}
