import { deliveryCopy, preserveWorkClosingPhrase } from './workConversationPresentation';
import { currentAgentReportId, isDeliverableArtifactHref, safeEvidenceHref } from './workResultPresentation';
import type { AgentReport, AgentTask, AgentTaskAction } from './types';
import type { AgentWorkCheckpoint } from './workConversationTypes';
import type { AgentWorkLiveTurnState } from './useAgentWorkLiveTurn';

type AgentWorkTimelineProps = {
  readonly checkpoints: readonly AgentWorkCheckpoint[];
  readonly loading: boolean;
  readonly error: string;
  readonly readOnly: boolean;
  readonly tasks: readonly AgentTask[];
  readonly reports: readonly AgentReport[];
  readonly currentResultReportId: string;
  readonly responsibleAgentName: string;
  readonly busy: string;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
  readonly onRefresh: () => Promise<unknown>;
  readonly onRetry: () => Promise<void>;
  readonly liveTurn: AgentWorkLiveTurnState;
};

function checkpointLabel(kind: AgentWorkCheckpoint['kind']): string {
  switch (kind) {
    case 'user_message': return '나';
    case 'agent_message': return '담당 에이전트';
    case 'plan': return '실행 계획';
    case 'approval_request': return '승인 요청';
    case 'approval_response': return '승인 응답';
    case 'progress': return '진행';
    case 'tool': return '도구 실행';
    case 'artifact': return '산출물';
    case 'error': return '오류';
    case 'completion': return '결과';
    case 'revision_started': return '수정 차수 시작';
    case 'revision_completed': return '수정 차수 완료';
    case 'blocked': return '막힘';
  }
}

function timeLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '';
  return new Date(timestamp).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function checkpointText(checkpoint: AgentWorkCheckpoint): string {
  const text = checkpoint.text.trim();
  if (!['agent_message', 'plan'].includes(checkpoint.kind) || !text.startsWith('{')) return checkpoint.text;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return checkpoint.text;
    const summary = (value as Readonly<Record<string, unknown>>)['summary'];
    return typeof summary === 'string' && summary.trim() ? summary.trim() : checkpoint.text;
  } catch {
    return checkpoint.text;
  }
}

type AgentCheckpointResultProps = Readonly<{
  report: AgentReport;
  current: boolean;
  readOnly: boolean;
  onOpenSession: (sessionId: string) => void;
  onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
  onRefresh: () => Promise<unknown>;
}>;

function AgentCheckpointResult(props: AgentCheckpointResultProps) {
  const run = async (operation: () => Promise<unknown>) => {
    await operation();
    await props.onRefresh();
  };
  return (
    <div className="agent-checkpoint-result" data-current={props.current}>
      <strong>{props.current ? '현재 결과' : '이전 결과'} · {props.report.title}</strong>
      {props.report.findings.length > 0 && <ul>{props.report.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>}
      {props.report.evidence.length > 0 && <div className="agent-work-evidence">{props.report.evidence.map((item) => {
        const href = safeEvidenceHref(item.url);
        return href
          ? <a className={isDeliverableArtifactHref(href) ? 'agent-work-artifact' : undefined} href={href} target="_blank" rel="noopener noreferrer" key={`${item.label}-${item.url}`}>{isDeliverableArtifactHref(href) ? `${item.label} 열기` : item.label}</a>
          : <span className="agent-work-evidence-blocked" key={`${item.label}-${item.url}`}>차단됨 · {item.label}</span>;
      })}</div>}
      {props.report.limitations.length > 0 && <p className="agent-work-result-limitations">확인할 점 · {props.report.limitations.join(' · ')}</p>}
      {props.report.followUps.map((followUp, index) => {
        const decision = props.report.followUpDecisions.find((item) => item.index === index)?.decision;
        return <div className="agent-work-follow-up" key={`${followUp.title}-${index}`}><span><strong>{followUp.title}</strong><small>{followUp.reason}</small></span>{!props.readOnly && <><button type="button" aria-label={`${followUp.title} 승인`} aria-pressed={decision === 'approved'} onClick={() => void run(() => props.onFollowUpDecision(props.report.id, index, 'approved'))}>승인</button><button type="button" aria-label={`${followUp.title} 거절`} aria-pressed={decision === 'rejected'} onClick={() => void run(() => props.onFollowUpDecision(props.report.id, index, 'rejected'))}>거절</button></>}</div>;
      })}
      <footer className="agent-work-result-actions">
        {props.report.sessionId && <button type="button" onClick={() => props.onOpenSession(props.report.sessionId)}>Task Session 열기</button>}
        {!props.readOnly && <><span>도움이 됐나요?</span><button type="button" aria-pressed={props.report.useful === true} onClick={() => void run(() => props.onReportFeedback(props.report.id, true))}>도움 됨</button><button type="button" aria-pressed={props.report.useful === false} onClick={() => void run(() => props.onReportFeedback(props.report.id, false))}>개선 필요</button></>}
      </footer>
    </div>
  );
}

export function AgentWorkTimeline(props: AgentWorkTimelineProps) {
  const currentReportId = currentAgentReportId(props.reports, props.currentResultReportId);
  const visibleCheckpoints = props.checkpoints.filter((checkpoint) => {
    const text = checkpoint.text.trim();
    if (text.toLowerCase() === '[redacted-command]') return false;
    if (checkpoint.kind === 'plan' && /^planning mission:/i.test(text)) return false;
    if (checkpoint.kind === 'approval_response' && /^(?:pause|resume|cancel|retry|approve):\s*[\w-]+\s*(?:→|->)\s*[\w-]+$/i.test(text)) return false;
    return true;
  });
  const resultCheckpointByReportId = new Map<string, string>();
  for (const checkpoint of visibleCheckpoints) {
    if (checkpoint.metadata.reportId) resultCheckpointByReportId.set(checkpoint.metadata.reportId, checkpoint.id);
  }
  return (
    <section className="agent-work-timeline" aria-label="작업 대화 타임라인" aria-busy={props.loading} aria-live="polite">
      {props.loading && !visibleCheckpoints.length && <p className="agent-work-state">작업 대화를 불러오는 중입니다.</p>}
      {props.error && <div className="agent-work-state agent-work-state-error" role="alert"><p>작업 대화를 불러오지 못했습니다. 현재 작업과 작성 중인 내용은 그대로 유지됩니다.</p><button type="button" onClick={() => void props.onRetry()}>다시 시도</button></div>}
      {!props.loading && !props.error && !visibleCheckpoints.length && <p className="agent-work-state">아직 체크포인트가 없습니다. 아래 입력창에서 <span className="agent-work-nowrap">첫 지시를</span> 남길 수 있습니다.</p>}
      {visibleCheckpoints.map((checkpoint) => {
        const displayedText = checkpointText(checkpoint);
        const task = checkpoint.metadata.taskId ? props.tasks.find((item) => item.id === checkpoint.metadata.taskId) : undefined;
        const report = checkpoint.metadata.reportId && resultCheckpointByReportId.get(checkpoint.metadata.reportId) === checkpoint.id
          ? props.reports.find((item) => item.id === checkpoint.metadata.reportId)
          : undefined;
        const approvalAvailable = !props.readOnly && checkpoint.kind === 'approval_request' && task?.status === 'proposed' && checkpoint.metadata.applicationMode !== 'unsupported_external_request';
        const delivery = checkpoint.metadata.deliveryStatus && checkpoint.metadata.applicationMode
          ? deliveryCopy(checkpoint.metadata.deliveryStatus, checkpoint.metadata.applicationMode).split('. ', 2)
          : null;
        return <article className="agent-checkpoint" data-kind={checkpoint.kind} key={checkpoint.id}>
          <header><span>{checkpointLabel(checkpoint.kind)}</span><time dateTime={checkpoint.createdAt}>{timeLabel(checkpoint.createdAt)}</time></header>
          <p>{preserveWorkClosingPhrase(displayedText)}</p>
          {delivery && <small className="agent-checkpoint-delivery"><span>{delivery[0]}</span>{delivery[1] && <span className="agent-checkpoint-delivery-outcome">{delivery[1]}</span>}</small>}
          {checkpoint.kind === 'approval_request' && task && <div className="agent-checkpoint-approval"><dl><div><dt>영향</dt><dd>{task.expectedOutput}</dd></div><div><dt>범위</dt><dd>{task.reason}</dd></div><div><dt>담당 에이전트</dt><dd>{props.responsibleAgentName}</dd></div></dl>{approvalAvailable && <div><button type="button" disabled={props.busy === task.id} onClick={() => void props.onTaskAction(task.id, 'approve')}>이 제안 승인</button><button type="button" disabled={props.busy === task.id} onClick={() => void props.onTaskAction(task.id, 'cancel')}>이 제안 거절</button></div>}</div>}
          {report && <AgentCheckpointResult report={report} current={report.id === currentReportId} readOnly={props.readOnly} onOpenSession={props.onOpenSession} onReportFeedback={props.onReportFeedback} onFollowUpDecision={props.onFollowUpDecision} onRefresh={props.onRefresh} />}
          {checkpoint.metadata.progress !== undefined && <progress className="agent-checkpoint-progress" aria-label={`진행률 ${checkpoint.metadata.progress}%`} max={100} value={Math.max(0, Math.min(100, checkpoint.metadata.progress))} />}
          {checkpoint.metadata.revisionNumber !== undefined && <small>수정 차수 {checkpoint.metadata.revisionNumber}</small>}
        </article>;
      })}
      {(props.liveTurn.active || props.liveTurn.text || props.liveTurn.error) && <article className="agent-checkpoint agent-work-live-turn" data-kind={props.liveTurn.error ? 'error' : 'agent_message'} aria-live={props.liveTurn.error ? 'assertive' : 'polite'} role={props.liveTurn.error ? 'alert' : undefined}>
        <header><span>{props.liveTurn.error ? '오류' : '담당 에이전트'}</span><time>{props.liveTurn.error ? '응답 연결 실패' : '응답 중'}</time></header>
        {props.liveTurn.error ? <>
          {props.liveTurn.text && <p className="agent-work-live-partial"><strong>부분 응답</strong>{preserveWorkClosingPhrase(props.liveTurn.text)}</p>}
          <p className="agent-work-live-error-copy">{props.liveTurn.error}</p>
        </> : <p>{preserveWorkClosingPhrase(props.liveTurn.text || '응답을 받고 있습니다.')}</p>}
      </article>}
    </section>
  );
}
