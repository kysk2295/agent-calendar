import { useMemo, useState } from 'react';

import { compareAgentTasksBySchedule } from './agentOperations';
import { MissionDetail, ReportsView, missionStatusLabel } from './AgentOperationViews';
import type {
  AgentOperationsState,
  AgentRosterEntry,
  AgentTaskAction,
} from './types';

type AgentOperationsTab = 'missions' | 'agents' | 'reports';

type AgentOperationsScreenProps = {
  readonly state: AgentOperationsState;
  readonly agents: readonly AgentRosterEntry[];
  readonly error: string;
  readonly busy: string;
  readonly onCreateMission: () => Promise<void>;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<void>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
};

const TAB_LABELS: Readonly<Record<AgentOperationsTab, string>> = {
  missions: '미션',
  agents: '에이전트',
  reports: '보고서',
};
const TABS = ['missions', 'agents', 'reports'] as const;

export function AgentOperationsScreen(props: AgentOperationsScreenProps) {
  const [activeTab, setActiveTab] = useState<AgentOperationsTab>('missions');
  const [selectedMissionId, setSelectedMissionId] = useState('');
  const selectedMission = props.state.missions.find((mission) => mission.id === selectedMissionId)
    || props.state.missions[0];
  const missionTasks = useMemo(
    () => selectedMission ? props.state.tasks.filter((task) => task.missionId === selectedMission.id).sort(compareAgentTasksBySchedule) : [],
    [props.state.tasks, selectedMission],
  );

  return (
    <div className="agent-operations-workspace screen-in">
      <div className="agent-operations-tabs" role="tablist" aria-label="Agent Operations views">
        {TABS.map((tab) => (
          <button role="tab" aria-selected={activeTab === tab} data-active={activeTab === tab} key={tab} onClick={() => setActiveTab(tab)}>
            {TAB_LABELS[tab]}
          </button>
        ))}
        <span className="agent-daemon" data-running={props.state.daemon.running}>{props.state.daemon.running ? '스케줄러 온라인' : '스케줄러 일시정지'}</span>
      </div>
      {props.error && <div className="agent-operations-error" role="status">{props.error}</div>}

      {activeTab === 'missions' && (
        <div className="agent-missions-layout">
          <aside className="agent-mission-list">
            <header><strong>미션</strong><button disabled={props.busy === 'create'} onClick={() => void props.onCreateMission()}>새 미션</button></header>
            {props.state.missions.map((mission) => {
              const tasks = props.state.tasks.filter((task) => task.missionId === mission.id).sort(compareAgentTasksBySchedule);
              const completed = tasks.filter((task) => task.status === 'completed').length;
              const nextTask = tasks.find((task) => task.status === 'running')
                || tasks.find((task) => ['scheduled', 'proposed', 'blocked', 'failed'].includes(task.status));
              return (
                <button className="agent-mission-item" data-active={selectedMission?.id === mission.id} key={mission.id} onClick={() => setSelectedMissionId(mission.id)}>
                  <span className="agent-mission-item-head"><strong>{mission.title}</strong><b>{missionStatusLabel(mission.status)}</b></span>
                  <span>{mission.agentId} · {tasks.length ? `${completed}/${tasks.length} 완료` : '계획 전'}</span>
                  {nextTask && <small>{nextTask.status === 'running' ? '실행 중' : nextTask.status === 'blocked' ? '확인 필요' : nextTask.status === 'failed' ? '재시도 필요' : '다음'} · {nextTask.title}</small>}
                </button>
              );
            })}
            {!props.state.missions.length && (
              <div className="agent-mission-template">
                <strong>Weekly Opportunity Brief</strong>
                <span>bizconsultant · 금요일 16:00</span>
                <button disabled={props.busy === 'create'} onClick={() => void props.onCreateMission()}>미션 만들기</button>
              </div>
            )}
          </aside>
          {selectedMission
            ? <MissionDetail mission={selectedMission} tasks={missionTasks} busy={props.busy} onPlanMission={props.onPlanMission} onApprovePlan={props.onApprovePlan} onMissionWorkAction={props.onMissionWorkAction} onTaskAction={props.onTaskAction} onRunTaskNow={props.onRunTaskNow} onOpenSession={props.onOpenSession} />
            : <div className="agent-operation-empty large">미션을 만들면 자율 작업 계약이 여기에 표시됩니다.</div>}
        </div>
      )}

      {activeTab === 'agents' && (
        <div className="agent-roster-list">
          {props.agents.map((agent) => {
            const tasks = props.state.tasks.filter((task) => task.agent === agent.id);
            const taskIds = new Set(tasks.map((task) => task.id));
            const reports = props.state.reports.filter((report) => taskIds.has(report.taskId));
            const ratedReports = reports.filter((report) => report.useful !== null);
            const usefulRate = ratedReports.length
              ? `${Math.round((ratedReports.filter((report) => report.useful).length / ratedReports.length) * 100)}%`
              : '평가 없음';
            const activeMissions = props.state.missions.filter((mission) => mission.agentId === agent.id && mission.status === 'active').length;
            return (
              <article className="agent-roster-row" key={agent.id}>
                <span className="agent-roster-mark">{agent.displayName.slice(0, 1).toUpperCase()}</span>
                <div className="agent-roster-main"><strong>{agent.displayName}</strong><span>{agent.role || agent.model}</span></div>
                <div className="agent-roster-context"><span>{agent.provider}</span><span>신뢰 · {agent.trustLevel}</span><div className="mission-tags">{agent.allowedTaskClasses.map((taskClass) => <b key={taskClass}>{taskClass}</b>)}{!agent.allowedTaskClasses.length && <b>허용 작업 미설정</b>}</div></div>
                <span className="agent-roster-status">{agent.status}</span>
                <div className="agent-roster-metrics"><b>{tasks.filter((task) => task.status === 'running').length} 실행 · {tasks.filter((task) => task.status === 'completed').length} 완료</b><span>활성 미션 {activeMissions} · 보고 유용성 {usefulRate}</span></div>
              </article>
            );
          })}
        </div>
      )}

      {activeTab === 'reports' && <ReportsView reports={props.state.reports} busy={props.busy} onFeedback={props.onReportFeedback} onFollowUpDecision={props.onFollowUpDecision} onOpenSession={props.onOpenSession} />}
    </div>
  );
}
