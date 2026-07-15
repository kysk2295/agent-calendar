import { missionStatusLabel } from './AgentOperationViews';
import { agentTaskAppearance, agentTaskCause } from './agentTaskAppearance';
import { hermesAutomationLastStatusLabel, hermesAutomationStatusLabel } from './hermesAutomation';
import type {
  AgentOperationsState,
  AgentRosterEntry,
  AgentTask,
  AgentTaskAction,
  HermesAutomationJob,
} from './types';

type AgentControlRoomBoardProps = {
  readonly state: AgentOperationsState;
  readonly agents: readonly AgentRosterEntry[];
  readonly automationJobs: readonly HermesAutomationJob[];
  readonly readOnly: boolean;
  readonly busy: string;
  readonly onOpenMission: (missionId: string, originKey: string) => void;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
};

type ActivityItem = {
  readonly id: string;
  readonly missionId: string;
  readonly timestamp: number;
  readonly time: string;
  readonly title: string;
  readonly meta: string;
  readonly tone: 'done' | 'run' | 'idea' | 'scheduled' | 'attention';
};

function dateValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function timeLabel(value: string): string {
  const timestamp = dateValue(value);
  if (!timestamp) return '예정';
  return new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function automationScheduleLabel(value: string): string {
  const schedule = value.trim();
  const cadence = schedule.match(/^every\s+(\d+)\s*([mhd])$/i);
  if (!cadence) return schedule || '일정 확인 필요';
  const unit = cadence[2].toLowerCase() === 'm' ? '분' : cadence[2].toLowerCase() === 'h' ? '시간' : '일';
  return `${cadence[1]}${unit}마다`;
}

function controlHomeMissionStatusLabel(status: Parameters<typeof missionStatusLabel>[0]): string {
  return status === 'draft' ? '대화 시작됨' : missionStatusLabel(status);
}

function activityItems(state: AgentOperationsState, jobs: readonly HermesAutomationJob[]): readonly ActivityItem[] {
  const tasks: ActivityItem[] = state.tasks
    .filter((task) => task.status !== 'proposed')
    .map((task) => {
      const appearance = agentTaskAppearance(task.status);
      return {
        id: `task:${task.id}`,
        missionId: task.missionId,
        timestamp: dateValue(task.scheduledAt),
        time: timeLabel(task.scheduledAt),
        title: `${task.title} ${appearance.label}`,
        meta: `${task.agent} · ${task.status === 'blocked' || task.status === 'failed' ? agentTaskCause(task) : task.expectedOutput || task.reason}`,
        tone: task.status === 'completed' ? 'done' : task.status === 'blocked' || task.status === 'failed' ? 'attention' : task.status === 'running' ? 'run' : 'scheduled',
      };
    });
  const reports: ActivityItem[] = state.reports.map((report) => ({
    id: `report:${report.id}`,
    missionId: report.missionId,
    timestamp: dateValue(report.updatedAt || report.createdAt),
    time: timeLabel(report.updatedAt || report.createdAt),
    title: report.title,
    meta: `작업 결과 · ${report.findings[0] || '결과를 확인할 수 있습니다'}`,
    tone: 'done',
  }));
  const missions: ActivityItem[] = state.missions.map((mission) => ({
    id: `mission:${mission.id}`,
    missionId: mission.id,
    timestamp: dateValue(mission.updatedAt || mission.createdAt),
    time: timeLabel(mission.updatedAt || mission.createdAt),
    title: mission.title,
    meta: `${mission.agentId} · ${controlHomeMissionStatusLabel(mission.status)}`,
    tone: mission.status === 'completed' ? 'done' : mission.status === 'draft' ? 'idea' : mission.status === 'failed' || mission.status === 'cancelled' ? 'attention' : 'run',
  }));
  const automations: ActivityItem[] = jobs.filter((job) => job.lastRunAt).map((job) => {
    const lastStatus = hermesAutomationLastStatusLabel(job.lastStatus);
    return {
      id: `automation:${job.id}`,
      missionId: '',
      timestamp: dateValue(job.lastRunAt),
      time: timeLabel(job.lastRunAt),
      title: `${job.name} 실행`,
      meta: `${job.agentId || 'Hermes'} · ${lastStatus}`,
      tone: lastStatus === '정상 완료' ? 'done' : lastStatus === '실패' ? 'attention' : lastStatus === '실행 중' ? 'run' : 'scheduled',
    };
  });
  return [...reports, ...tasks, ...missions, ...automations]
    .sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
    .slice(0, 8);
}

function AgentStatusCard({ agent, tasks }: { readonly agent: AgentRosterEntry; readonly tasks: readonly AgentTask[] }) {
  const running = tasks.filter((task) => task.status === 'running').length;
  const attention = tasks.filter((task) => ['blocked', 'failed'].includes(task.status)).length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const proposed = tasks.filter((task) => task.status === 'proposed').length;
  const stopped = agent.enabled === false || agent.status === '중지됨';
  const readyLabel = ['ready', 'idle', '준비됨'].includes(agent.status.toLowerCase()) ? '준비됨' : agent.status;
  const statusLabel = stopped ? '중지됨' : attention ? `확인 필요 · ${attention}건` : running ? `실행 중 · ${running}건` : readyLabel;
  return (
    <article className="agent-status-card">
      <header><span>{agent.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{agent.displayName}</strong><small data-tone={attention || stopped ? 'attention' : running ? 'running' : 'ready'}>{statusLabel}</small></div></header>
      <footer><span>완료 <b>{completed}건</b></span><span>진행 <b>{running}</b></span><span>제안 <b>{proposed}</b></span></footer>
    </article>
  );
}

function SchedulerStatusCard({ jobs }: { readonly jobs: readonly HermesAutomationJob[] }) {
  const active = jobs.filter((job) => job.status === 'active');
  const unknown = jobs.filter((job) => job.status === 'unknown');
  const next = [...active].filter((job) => dateValue(job.nextRunAt)).sort((left, right) => dateValue(left.nextRunAt) - dateValue(right.nextRunAt))[0];
  const scheduleStatus = next ? `다음 실행 ${timeLabel(next.nextRunAt)}` : active.length ? '다음 실행 확인 필요' : unknown.length ? '활성 여부 확인 필요' : '예약 없음';
  return (
    <article className="agent-status-card agent-scheduler-card">
      <header><span>↻</span><div><strong>스케줄러</strong><small data-tone={next ? 'running' : active.length || unknown.length ? 'attention' : 'ready'}>{scheduleStatus}</small></div></header>
      <footer>{next ? <><span><b>{next.name}</b></span><span>{next.schedule}</span></> : unknown.length && !active.length ? <span>상태 확인 필요 <b>{unknown.length}개</b></span> : <span>활성 자동화 <b>{active.length}개</b></span>}</footer>
    </article>
  );
}

function AutomationSummaryCard({ job }: { readonly job: HermesAutomationJob }) {
  const status = job.status === 'unknown' ? '활성 여부 확인 필요' : hermesAutomationStatusLabel(job.status);
  const lastRun = dateValue(job.lastRunAt) ? `${timeLabel(job.lastRunAt)} · ${hermesAutomationLastStatusLabel(job.lastStatus)}` : '실행 확인 필요';
  const nextRun = dateValue(job.nextRunAt) ? timeLabel(job.nextRunAt) : job.status === 'active' ? '실행 확인 필요' : '실행 없음';
  return (
    <article className="agent-automation-card" data-status={job.status}>
      <header><strong>{job.name}</strong><span>{status}</span></header>
      <p>{job.agentId || '담당 확인 필요'} · {automationScheduleLabel(job.schedule)}</p>
      <footer><span>최근 {lastRun}</span><span>다음 {nextRun}</span></footer>
    </article>
  );
}

export function AgentControlRoomBoard(props: AgentControlRoomBoardProps) {
  const running = props.state.tasks.filter((task) => ['running', 'blocked', 'failed', 'scheduled'].includes(task.status));
  const proposed = props.state.tasks.filter((task) => task.status === 'proposed');
  const recentWork = [...props.state.missions]
    .sort((left, right) => dateValue(right.updatedAt || right.createdAt) - dateValue(left.updatedAt || left.createdAt) || left.id.localeCompare(right.id))
    .slice(0, 4);
  const activity = activityItems(props.state, props.automationJobs);
  const visibleAutomations = [...props.automationJobs]
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || dateValue(left.nextRunAt) - dateValue(right.nextRunAt) || left.name.localeCompare(right.name))
    .slice(0, 4);
  return (
    <div className="agent-control-room-board">
      <section className="agent-status-grid" aria-label="에이전트 상태">
        {props.agents.map((agent) => <AgentStatusCard key={agent.id} agent={agent} tasks={props.state.tasks.filter((task) => task.agent === agent.id)} />)}
        {!!props.automationJobs.length && <SchedulerStatusCard jobs={props.automationJobs} />}
        {!props.agents.length && <p className="agent-control-empty">연결된 Hermes 에이전트가 없습니다.</p>}
      </section>

      {!!visibleAutomations.length && <section className="agent-automation-section" aria-label="기존 자동화">
        <header className="agent-control-section-title"><strong>기존 자동화</strong><span>{props.automationJobs.length}</span></header>
        <p className="agent-control-section-note">Hermes에 저장된 일정과 최근 실행 상태를 읽기 전용으로 표시합니다.</p>
        <div className="agent-automation-grid">{visibleAutomations.map((job) => <AutomationSummaryCard job={job} key={job.id} />)}</div>
        {props.automationJobs.length > visibleAutomations.length && <p className="agent-automation-more">외 {props.automationJobs.length - visibleAutomations.length}개 자동화가 연결되어 있습니다.</p>}
      </section>}

      <div className="agent-control-columns">
        <section className="agent-control-column">
          <header className="agent-control-section-title"><strong>진행 및 확인 필요</strong><span>{running.length}</span></header>
          <p className="agent-control-section-note">카드를 열어 진행 상황과 실패 원인을 확인하고 다음 행동을 선택하세요.</p>
          <div className="agent-running-list">
            {running.map((task) => {
              const appearance = agentTaskAppearance(task.status);
              return (
                <button className="agent-running-card" data-status={task.status} data-work-mission={task.missionId} data-work-origin={`running:${task.id}`} type="button" key={task.id} onClick={() => props.onOpenMission(task.missionId, `running:${task.id}`)}>
                  <span><strong>{task.title}</strong><small>{task.status === 'failed' ? '작업 열기 · 재시도 확인' : task.status === 'blocked' ? '작업 열기 · 해결 확인' : '작업 열기'} ›</small></span>
                  <p>{task.agent} · {task.status === 'blocked' || task.status === 'failed' ? agentTaskCause(task) : task.reason}</p>
                  <em>{appearance.label}</em>
                </button>
              );
            })}
            {!running.length && <p className="agent-control-empty">진행 중이거나 확인이 필요한 작업이 없습니다.</p>}
          </div>

          <header className="agent-control-section-title agent-control-section-gap"><strong>승인 대기</strong><span data-tone="attention">{proposed.length}</span></header>
          <div className="agent-approval-queue">
            {proposed.map((task) => (
              <article className="agent-approval-card" key={task.id}>
                <button className="agent-approval-open" data-work-mission={task.missionId} data-work-origin={`approval:${task.id}`} type="button" onClick={() => props.onOpenMission(task.missionId, `approval:${task.id}`)}>
                  <small><b>{task.agent}</b>의 제안 · {task.reason}</small>
                  <strong>{task.title}</strong>
                </button>
                <div><span>실행 계획</span><p>{task.expectedOutput || '결과 형식 확인 필요'} · {task.estimatedMinutes ? `예상 ${task.estimatedMinutes}분` : '예상 시간 미정'}</p></div>
                <footer>{!props.readOnly && <><button className="approve" type="button" disabled={props.busy === task.id} onClick={() => void props.onTaskAction(task.id, 'approve')}>✓ 승인</button><button type="button" disabled={props.busy === task.id} onClick={() => void props.onTaskAction(task.id, 'cancel')}>거절</button></>}<time>{timeLabel(task.dueAt || task.scheduledAt)}까지</time></footer>
              </article>
            ))}
            {!proposed.length && <p className="agent-control-empty">승인을 기다리는 제안이 없습니다.</p>}
          </div>
        </section>

        <section className="agent-control-column" aria-label="활동">
          <header className="agent-control-section-title" data-work-focus-fallback tabIndex={-1}><strong>최근 작업 대화</strong><span>{recentWork.length}</span></header>
          <p className="agent-control-section-note">저장된 위임 작업을 다시 열어 대화를 이어가거나 결과를 검토하세요.</p>
          <div className="agent-recent-work-list">
            {recentWork.map((mission) => (
              <button className="agent-recent-work-card" data-work-mission={mission.id} data-work-origin={`conversation:${mission.id}`} type="button" key={mission.id} onClick={() => props.onOpenMission(mission.id, `conversation:${mission.id}`)}>
                <span><strong>{mission.title}</strong><small>작업 대화 열기 ›</small></span>
                <p>{mission.agentId} · {controlHomeMissionStatusLabel(mission.status)}</p>
              </button>
            ))}
            {!recentWork.length && <p className="agent-control-empty">저장된 위임 작업이 없습니다.</p>}
          </div>

          <header className="agent-control-section-title agent-control-section-gap"><strong>최근 활동</strong></header>
          <div className="agent-activity-timeline">
            <b>최근</b>
            {activity.map((item) => (
              <button type="button" data-tone={item.tone} data-work-mission={item.missionId || undefined} data-work-origin={item.missionId ? `activity:${item.id}` : undefined} disabled={!item.missionId} key={item.id} onClick={() => item.missionId && props.onOpenMission(item.missionId, `activity:${item.id}`)}>
                <time>{item.time}</time><i aria-hidden="true">{item.tone === 'done' ? '✓' : item.tone === 'idea' || item.tone === 'attention' ? '!' : '◷'}</i><span><strong>{item.title}</strong><small>{item.meta}</small></span>
              </button>
            ))}
            {!activity.length && <p className="agent-control-empty">표시할 활동이 없습니다.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
