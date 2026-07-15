import { useEffect, useRef, useState } from 'react';

import { missionStatusLabel } from './AgentOperationViews';
import { AgentWorkComposer } from './AgentWorkComposer';
import { AgentWorkDetails } from './AgentWorkDetails';
import { AgentWorkTimeline } from './AgentWorkTimeline';
import { preserveWorkClosingPhrase, responsibleAgentAssignmentCopy } from './workConversationPresentation';
import type { AgentMission, AgentReport, AgentTask, AgentTaskAction } from './types';
import type { AgentWorkConversationPage, AgentWorkDelivery } from './workConversationTypes';
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
  readonly onSendMessage: (text: string) => Promise<AgentWorkDelivery>;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'activate' | 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
  readonly liveTurn: AgentWorkLiveTurnState;
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
      ? '계획 전 · 다음 지시를 남기거나 실행 계획을 만들어 주세요.'
      : '계획 전 · 첫 지시를 남기거나 실행 계획을 만들어 주세요.';
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
  return (
    <main className="agent-work-conversation">
      <header className="agent-work-header">
        <button className="agent-work-back" type="button" aria-label="관제 홈으로 돌아가기" onClick={props.onBack}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m12.5 4-6 6 6 6" /></svg><span>관제 홈</span></button>
        <div className="agent-work-header-content">
          <span className="agent-work-kicker">작업 대화</span>
          <h1 ref={headingRef} tabIndex={-1}>{preserveWorkClosingPhrase(props.mission.title)}</h1>
          <div className="agent-work-status-line">
            <b className="agent-work-status-badge" data-status={statusTone}>{statusLabel}</b>
            <span className="agent-work-assignment"><span>담당 에이전트</span><strong>{props.responsibleAgentName}</strong></span>
            <span className="agent-work-assignment"><span>배정 이유</span><strong>{assignmentCopy}</strong></span>
          </div>
          <p className="agent-work-attention">{attention}</p>
        </div>
      </header>
      {actionReceipt && <p className="agent-work-action-status" role="status" aria-live="polite">{actionReceipt}</p>}
      <div className="agent-work-layout">
        <section className="agent-work-primary" aria-label="작업 대화">
          <AgentWorkTimeline checkpoints={props.conversation?.checkpoints || []} loading={props.loading} error={props.error} readOnly={props.aggregateStale || props.loading || Boolean(props.error)} tasks={props.tasks} reports={props.reports} currentResultReportId={props.conversation?.work.revision.currentResultReportId || ''} responsibleAgentName={props.responsibleAgentName} busy={props.busy} onTaskAction={taskAction} onOpenSession={props.onOpenSession} onReportFeedback={props.onReportFeedback} onFollowUpDecision={props.onFollowUpDecision} onRefresh={props.onRefresh} onRetry={retryConversation} liveTurn={props.liveTurn} />
          <AgentWorkComposer onSend={props.onSendMessage} streaming={props.liveTurn.active} />
        </section>
        {!props.loading && !props.error && !props.aggregateStale && <AgentWorkDetails mission={props.mission} tasks={props.tasks} responsibleAgentName={props.responsibleAgentName} assignmentCopy={assignmentCopy} resolvedExecutionEngine={props.conversation?.work.resolvedExecutionEngine || null} busy={props.busy} onPlanMission={props.onPlanMission} onApprovePlan={props.onApprovePlan} onMissionWorkAction={props.onMissionWorkAction} onTaskAction={taskAction} onRunTaskNow={props.onRunTaskNow} onOpenSession={props.onOpenSession} onRefresh={props.onRefresh} />}
      </div>
    </main>
  );
}
