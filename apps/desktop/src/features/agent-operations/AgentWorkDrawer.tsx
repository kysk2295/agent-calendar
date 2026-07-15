import { useState } from 'react';

import { agentTaskAppearance } from './agentTaskAppearance';
import { executionEngineLabel } from './executionContracts';
import { missionStatusLabel } from './AgentOperationViews';
import { safeEvidenceHref } from './workResultPresentation';
import type { AgentMission, AgentReport, AgentTask, AgentTaskAction } from './types';

type AgentWorkDrawerProps = {
  readonly mission: AgentMission | undefined;
  readonly tasks: readonly AgentTask[];
  readonly reports: readonly AgentReport[];
  readonly activeSessionId: string;
  readonly busy: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'activate' | 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<void>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onContinueSession: (sessionId: string, message: string) => Promise<boolean>;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
};

function taskAction(task: AgentTask): AgentTaskAction | null {
  switch (task.status) {
    case 'proposed': return 'approve';
    case 'scheduled':
    case 'running': return 'pause';
    case 'blocked': return 'resume';
    case 'failed': return 'retry';
    case 'approved':
    case 'completed':
    case 'cancelled': return null;
  }
}

function taskActionLabel(action: AgentTaskAction): string {
  switch (action) {
    case 'approve': return '승인';
    case 'pause': return '일시정지';
    case 'resume': return '재개';
    case 'cancel': return '취소';
    case 'retry': return '재시도';
  }
}

function DrawerTask({ task, busy, onTaskAction, onRunTaskNow, onOpenSession }: {
  readonly task: AgentTask;
  readonly busy: string;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<void>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const appearance = agentTaskAppearance(task.status);
  const action = taskAction(task);
  return (
    <article className="agent-drawer-task" data-tone={appearance.tone}>
      <header><strong>{task.title}</strong><span>{appearance.label}</span></header>
      <p>{task.reason}</p><small>{task.agent} · 예상 {task.estimatedMinutes || 30}분 · {task.expectedOutput}</small>
      <footer>{task.sessionId && <button type="button" onClick={() => onOpenSession(task.sessionId)}>상세 대화</button>}{task.status === 'scheduled' && <button type="button" disabled={busy === task.id} onClick={() => void onRunTaskNow(task.id)}>지금 실행</button>}{action && <button type="button" disabled={busy === task.id} onClick={() => void onTaskAction(task.id, action)}>{taskActionLabel(action)}</button>}</footer>
    </article>
  );
}

function DrawerReport({ report, busy, onOpenSession, onReportFeedback, onFollowUpDecision }: {
  readonly report: AgentReport;
  readonly busy: string;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
}) {
  return (
    <article className="agent-drawer-report">
      <header><span>작업 결과</span><strong>{report.title}</strong></header>
      {!!report.findings.length && <ul>{report.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>}
      {!!report.evidence.length && <div className="agent-drawer-links">{report.evidence.map((evidence) => { const href = safeEvidenceHref(evidence.url); return href ? <a href={href} target="_blank" rel="noopener noreferrer" key={`${evidence.label}-${evidence.url}`}>{evidence.label}</a> : <span key={`${evidence.label}-${evidence.url}`}>{evidence.label}</span>; })}</div>}
      {!!report.limitations.length && <p><b>확인할 점</b> {report.limitations.join(' · ')}</p>}
      {report.followUps.map((followUp, index) => {
        const recorded = report.followUpDecisions.find((decision) => decision.index === index);
        return <section className="agent-drawer-followup" key={`${followUp.title}-${index}`}><div><strong>{followUp.title}</strong><p>{followUp.reason}</p></div><footer><button type="button" aria-label={`${followUp.title} 승인`} aria-pressed={recorded?.decision === 'approved'} data-active={recorded?.decision === 'approved'} disabled={busy === report.id} onClick={() => void onFollowUpDecision(report.id, index, 'approved')}>승인</button><button type="button" aria-label={`${followUp.title} 거절`} aria-pressed={recorded?.decision === 'rejected'} data-active={recorded?.decision === 'rejected'} disabled={busy === report.id} onClick={() => void onFollowUpDecision(report.id, index, 'rejected')}>거절</button></footer></section>;
      })}
      <footer>{report.sessionId && <button type="button" onClick={() => onOpenSession(report.sessionId)}>결과 이어서 작업하기</button>}<span>이 결과가 도움이 됐나요?</span><button type="button" aria-pressed={report.useful === true} disabled={busy === report.id} onClick={() => void onReportFeedback(report.id, true)}>도움 됨</button><button type="button" aria-pressed={report.useful === false} disabled={busy === report.id} onClick={() => void onReportFeedback(report.id, false)}>개선 필요</button></footer>
    </article>
  );
}

export function AgentWorkDrawer(props: AgentWorkDrawerProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const proposed = props.tasks.filter((task) => task.status === 'proposed').length;
  const completed = props.tasks.filter((task) => task.status === 'completed').length;
  const submit = async () => {
    const next = message.trim();
    if (!next || !props.activeSessionId || sending) return;
    setSending(true);
    try { if (await props.onContinueSession(props.activeSessionId, next)) setMessage(''); } finally { setSending(false); }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };
  const mission = props.mission;
  if (!props.open || !mission) return null;
  return (
    <section className="agent-work-legacy-panel" aria-label="기존 작업 스레드">
          <header className="agent-work-legacy-head"><div><span>{mission.agentId} · {executionEngineLabel(mission.executionEngine)}</span><button type="button" aria-label="작업 스레드 닫기" onClick={props.onClose}>×</button></div><h2>{mission.title}</h2><p><b>{missionStatusLabel(mission.status)}</b><span>{completed}/{props.tasks.length} 완료</span><span>실행 {mission.budget.usedRuns}회</span></p></header>
          <div className="agent-work-legacy-thread">
            <article className="agent-drawer-message me"><small>나</small><p>{mission.objective}</p></article>
            <article className="agent-drawer-message agent"><small>Hermes</small>{!props.tasks.length ? <><p>요청을 실행 계획으로 정리할 준비가 됐습니다.</p><button className="primary" type="button" disabled={props.busy === mission.id} onClick={() => void props.onPlanMission(mission.id)}>계획 만들기</button></> : <><header><strong>실행 계획</strong><span>{completed}/{props.tasks.length} 완료</span>{proposed > 0 && <button type="button" disabled={props.busy === mission.id} onClick={() => void props.onApprovePlan(mission.id)}>전체 승인</button>}</header><div className="agent-drawer-tasks">{props.tasks.map((task) => <DrawerTask key={task.id} task={task} busy={props.busy} onTaskAction={props.onTaskAction} onRunTaskNow={props.onRunTaskNow} onOpenSession={props.onOpenSession} />)}</div><footer>{mission.status === 'active' && <button type="button" onClick={() => void props.onMissionWorkAction(mission.id, 'pause')}>전체 일시정지</button>}{mission.status === 'paused' && <button type="button" onClick={() => void props.onMissionWorkAction(mission.id, 'activate')}>재개</button>} {!['completed', 'cancelled'].includes(mission.status) && <button type="button" onClick={() => void props.onMissionWorkAction(mission.id, 'cancel')}>작업 중단</button>}</footer></>}</article>
            {props.reports.map((report) => <article className="agent-drawer-message agent" key={report.id}><small>Hermes</small><DrawerReport report={report} busy={props.busy} onOpenSession={props.onOpenSession} onReportFeedback={props.onReportFeedback} onFollowUpDecision={props.onFollowUpDecision} /></article>)}
          </div>
          <div className="agent-work-legacy-composer"><textarea aria-label="작업 스레드 메시지" value={message} disabled={!props.activeSessionId} onChange={(event) => setMessage(event.target.value)} onKeyDown={keyDown} placeholder={props.activeSessionId ? '지시나 답변을 보내세요' : '작업 세션이 시작되면 후속 지시를 보낼 수 있습니다'} /><button type="button" aria-label="후속 지시 보내기" disabled={!message.trim() || !props.activeSessionId || sending} onClick={() => void submit()}>↑</button></div>
    </section>
  );
}
