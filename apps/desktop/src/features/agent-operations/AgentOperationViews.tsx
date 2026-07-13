import { agentTaskAppearance } from './agentTaskAppearance';
import { compareAgentTasksBySchedule } from './agentOperations';
import type { AgentMission, AgentReport, AgentTask, AgentTaskAction } from './types';

export function missionStatusLabel(status: AgentMission['status']): string {
  switch (status) {
    case 'draft':
      return '초안';
    case 'active':
      return '운영 중';
    case 'paused':
      return '일시정지';
    case 'completed':
      return '완료';
    case 'failed':
      return '확인 필요';
    case 'cancelled':
      return '중단됨';
    default:
      return assertNever(status);
  }
}

function missionReportCadence(mission: AgentMission): string {
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const weekday = weekdays[mission.reportSchedule.weekday] || '금';
  const minute = String(mission.reportSchedule.minute).padStart(2, '0');
  return `매주 ${weekday}요일 ${mission.reportSchedule.hour}:${minute}`;
}

function taskAction(task: AgentTask): AgentTaskAction | null {
  switch (task.status) {
    case 'proposed':
      return 'approve';
    case 'scheduled':
    case 'running':
      return 'pause';
    case 'blocked':
      return 'resume';
    case 'failed':
      return 'retry';
    case 'approved':
    case 'completed':
    case 'cancelled':
      return null;
    default:
      return assertNever(task.status);
  }
}

function taskActionLabel(action: AgentTaskAction): string {
  switch (action) {
    case 'approve':
      return '승인';
    case 'pause':
      return '일시정지';
    case 'resume':
      return '재개';
    case 'cancel':
      return '취소';
    case 'retry':
      return '재시도';
    default:
      return assertNever(action);
  }
}

function taskScheduleLabel(task: AgentTask, timeZone: string): string {
  const value = task.scheduledAt || `${task.date || ''}T${task.time || '00:00'}:00`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '일정 미정';
  const options: Intl.DateTimeFormatOptions = {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  };
  try {
    return date.toLocaleString('ko-KR', options);
  } catch {
    return date.toLocaleString('ko-KR', { ...options, timeZone: 'Asia/Seoul' });
  }
}

function MissionTaskRow({
  task,
  index,
  timeZone,
  busy,
  onAction,
  onRunNow,
  onOpenSession,
}: {
  readonly task: AgentTask;
  readonly index: number;
  readonly timeZone: string;
  readonly busy: string;
  readonly onAction: (taskId: string, action: AgentTaskAction) => Promise<void>;
  readonly onRunNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const appearance = agentTaskAppearance(task.status);
  const action = taskAction(task);
  return (
    <article className="agent-operation-task" data-tone={appearance.tone} data-line={appearance.line}>
      <div className="agent-operation-task-rail">
        <span className="agent-operation-task-index" aria-label={`${index + 1}번째 작업`}>{index + 1}</span>
        <i aria-hidden="true" />
      </div>
      <div className="agent-operation-task-main">
        <header>
          <span className="agent-operation-task-status">{appearance.label}</span>
          <strong>{task.title}</strong>
          <small>{taskScheduleLabel(task, timeZone)} · {task.estimatedMinutes}분</small>
        </header>
        <p>{task.reason}</p>
        <div className="agent-operation-task-output"><span>기대 결과</span><strong>{task.expectedOutput}</strong></div>
        <footer className="agent-operation-task-actions">
          <span className="agent-operation-task-agent">{task.agent}</span>
          {task.pauseMode === 'next_checkpoint' && <span className="agent-operation-task-checkpoint">다음 체크포인트에서 일시정지</span>}
          {task.sessionId && <button aria-label={`${task.title} 세션 열기`} onClick={() => onOpenSession(task.sessionId)}>세션 열기</button>}
          {task.status === 'scheduled' && (
            <button className="run-now" disabled={busy === task.id} onClick={() => void onRunNow(task.id)}>
              {busy === task.id ? '실행 중' : '지금 실행'}
            </button>
          )}
          {action && (
            <button disabled={busy === task.id} onClick={() => void onAction(task.id, action)}>
              {busy === task.id ? '처리 중' : taskActionLabel(action)}
            </button>
          )}
          {['proposed', 'scheduled', 'blocked'].includes(task.status) && (
            <button className="danger" disabled={busy === task.id} onClick={() => void onAction(task.id, 'cancel')}>취소</button>
          )}
        </footer>
      </div>
    </article>
  );
}

export function MissionDetail({
  mission,
  tasks,
  busy,
  onPlanMission,
  onApprovePlan,
  onMissionWorkAction,
  onTaskAction,
  onRunTaskNow,
  onOpenSession,
}: {
  readonly mission: AgentMission;
  readonly tasks: readonly AgentTask[];
  readonly busy: string;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<void>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const orderedTasks = [...tasks].sort(compareAgentTasksBySchedule);
  const proposedCount = orderedTasks.filter((task) => task.status === 'proposed').length;
  const pausableCount = orderedTasks.filter((task) => ['scheduled', 'running'].includes(task.status)).length;
  const cancellableCount = orderedTasks.filter((task) => ['proposed', 'scheduled', 'running', 'blocked'].includes(task.status)).length;
  const budgetPercent = mission.policy.maxRuntimeMinutesPerWeek
    ? Math.min(100, Math.round((mission.budget.usedMinutes / mission.policy.maxRuntimeMinutesPerWeek) * 100))
    : 0;
  const completedCount = orderedTasks.filter((task) => task.status === 'completed').length;
  const cancelledCount = orderedTasks.filter((task) => task.status === 'cancelled').length;
  const focusTask = orderedTasks.find((task) => task.status === 'running')
    || orderedTasks.find((task) => ['scheduled', 'proposed', 'blocked', 'failed'].includes(task.status));
  const focusLabel = focusTask?.status === 'running'
    ? '현재 실행'
    : focusTask?.status === 'blocked'
      ? '확인 필요'
      : focusTask?.status === 'failed'
        ? '재시도 필요'
        : focusTask
          ? '다음 작업'
          : cancelledCount
            ? '작업 종료'
            : orderedTasks.length
              ? '작업 완료'
              : '다음 작업';
  const focusTitle = focusTask?.title
    || (cancelledCount ? `${completedCount}개 완료 · ${cancelledCount}개 취소` : orderedTasks.length ? '모든 작업 완료' : '계획을 기다리는 중');
  const progressPercent = orderedTasks.length ? Math.round((completedCount / orderedTasks.length) * 100) : 0;
  return (
    <div className="mission-contract">
      <header className="mission-contract-head">
        <div>
          <span className="mission-state" data-state={mission.status}>{missionStatusLabel(mission.status)}</span>
          <h2>{mission.title}</h2>
          <p>{mission.objective}</p>
          <small className="mission-owner">담당 에이전트 · <strong>{mission.agentId}</strong></small>
        </div>
        <div className="mission-contract-actions">
          {!tasks.length && <button className="primary" disabled={busy === mission.id} onClick={() => void onPlanMission(mission.id)}>계획 만들기</button>}
          {proposedCount > 0 && <button className="primary" disabled={busy === mission.id} onClick={() => void onApprovePlan(mission.id)}>계획 승인</button>}
          {mission.status === 'active' && pausableCount > 0 && <button disabled={busy === mission.id} onClick={() => void onMissionWorkAction(mission.id, 'pause')}>미션 일시정지</button>}
          {!['completed', 'cancelled'].includes(mission.status) && cancellableCount > 0 && <button className="danger" disabled={busy === mission.id} onClick={() => void onMissionWorkAction(mission.id, 'cancel')}>미션 중단</button>}
        </div>
      </header>
      <div className="mission-live-summary">
        <section><span>작업 진행</span><strong>{completedCount}/{orderedTasks.length || 0} 완료</strong><div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><i style={{ width: `${progressPercent}%` }} /></div></section>
        <section><span>{focusLabel}</span><strong>{focusTitle}</strong><small>{focusTask ? `${focusTask.agent} · ${taskScheduleLabel(focusTask, mission.timezone)}` : mission.agentId}</small></section>
        <section><span>담당 에이전트</span><strong>{mission.agentId}</strong><small>{missionStatusLabel(mission.status)}</small></section>
      </div>
      <div className="mission-contract-body">
        <section className="mission-work-plan">
          <header><div><strong>작업 타임라인</strong><span>에이전트가 만든 실행 순서</span></div><b>{orderedTasks.length}개</b></header>
          <div className="mission-task-list mission-task-timeline">
            {orderedTasks.map((task, index) => <MissionTaskRow key={task.id} task={task} index={index} timeZone={mission.timezone} busy={busy} onAction={onTaskAction} onRunNow={onRunTaskNow} onOpenSession={onOpenSession} />)}
            {!orderedTasks.length && <div className="agent-operation-empty">아직 제안된 작업이 없습니다.</div>}
          </div>
        </section>
        <aside className="mission-context-rail">
          <section className="mission-budget-context">
            <span>주간 예산</span>
            <strong>{mission.budget.usedMinutes} / {mission.policy.maxRuntimeMinutesPerWeek}분</strong>
            <div className="mission-budget" role="progressbar" aria-valuemin={0} aria-valuemax={mission.policy.maxRuntimeMinutesPerWeek} aria-valuenow={mission.budget.usedMinutes}><i style={{ width: `${budgetPercent}%` }} /></div>
            <small>{mission.budget.usedRuns} / {mission.policy.maxRunsPerWeek}회 실행</small>
          </section>
          <section><span>보고</span><strong>{missionReportCadence(mission)}</strong><small>{mission.timezone}</small></section>
          <section><span>컨텍스트</span><div className="mission-tags">{mission.sources.map((source) => <b key={source}>{source}</b>)}</div></section>
          <section className="mission-success-criteria"><span>성공 기준</span><ul>{mission.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></section>
          <section><span>금지 작업</span><div className="mission-tags danger">{mission.policy.forbiddenActions.map((forbiddenAction) => <b key={forbiddenAction}>{forbiddenAction}</b>)}</div></section>
        </aside>
      </div>
    </div>
  );
}

export function ReportsView({ reports, busy, onFeedback, onFollowUpDecision, onOpenSession }: { readonly reports: readonly AgentReport[]; readonly busy: string; readonly onFeedback: (reportId: string, useful: boolean) => Promise<void>; readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>; readonly onOpenSession: (sessionId: string) => void }) {
  if (!reports.length) return <div className="agent-operation-empty large">첫 보고가 생성되면 여기에 근거와 후속 제안이 표시됩니다.</div>;
  return (
    <div className="agent-report-list">
      {reports.map((report) => (
        <article className="agent-report-row" key={report.id}>
          <header><strong>{report.title}</strong><span>{report.deliveryStatus || report.status}</span></header>
          <ul>{report.findings.slice(0, 3).map((finding) => <li key={finding}>{finding}</li>)}</ul>
          <div className="agent-report-detail">
            <section>
              <span>근거</span>
              <div className="agent-report-evidence">
                {report.evidence.map((evidence) => /^https?:\/\//.test(evidence.url)
                  ? <a href={evidence.url} target="_blank" rel="noreferrer" key={`${evidence.label}-${evidence.url}`}>{evidence.label}</a>
                  : <b key={evidence.label}>{evidence.label}</b>)}
              </div>
            </section>
            <section>
              <span>다음 제안</span>
              {report.followUps.length
                ? report.followUps.map((followUp, index) => {
                  const decision = report.followUpDecisions.find((item) => item.index === index)?.decision;
                  return <article className="agent-report-followup" key={followUp.title}><strong>{followUp.title}</strong><span>{followUp.reason}</span><div>{decision && <b data-decision={decision}>{decision === 'approved' ? '승인됨' : '거절됨'}</b>}<button aria-label={`${followUp.title} 승인`} data-active={decision === 'approved'} disabled={busy === report.id} onClick={() => void onFollowUpDecision(report.id, index, 'approved')}>승인</button><button aria-label={`${followUp.title} 거절`} data-active={decision === 'rejected'} disabled={busy === report.id} onClick={() => void onFollowUpDecision(report.id, index, 'rejected')}>거절</button></div></article>;
                })
                : <p>추가 제안 없음</p>}
            </section>
          </div>
          {!!report.limitations.length && <p className="agent-report-limit">한계: {report.limitations.slice(0, 2).join(' · ')}</p>}
          <footer>
            <span>근거 {report.evidence.length}개 · {report.budget.usedMinutes}분</span>
            {report.sessionId && <button onClick={() => onOpenSession(report.sessionId)}>세션 보기</button>}
            <button data-active={report.useful === true} onClick={() => void onFeedback(report.id, true)}>도움됨</button>
            <button data-active={report.useful === false} onClick={() => void onFeedback(report.id, false)}>아쉬움</button>
          </footer>
        </article>
      ))}
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Agent Operations value: ${JSON.stringify(value)}`);
}
