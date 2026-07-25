import { useEffect, useState } from 'react';

import { agentTaskAppearance, agentTaskCause } from './agentTaskAppearance';
import { executionEngineLabel, resolvedExecutionEngineLabel } from './executionContracts';
import { deliverableFormatLabel, deliverableKindLabel, preserveWorkClosingPhrase } from './workConversationPresentation';
import type { AgentMission, AgentTask, AgentTaskAction } from './types';
import type { AgentResolvedExecutionEngine } from './workConversationTypes';

type AgentWorkDetailsProps = {
  readonly mission: AgentMission;
  readonly tasks: readonly AgentTask[];
  readonly responsibleAgentName: string;
  readonly assignmentCopy: string;
  readonly resolvedExecutionEngine: AgentResolvedExecutionEngine | null;
  readonly busy: string;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'activate' | 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onRefresh: () => Promise<unknown>;
};

function taskAction(task: AgentTask): AgentTaskAction | null {
  switch (task.status) {
    case 'proposed': return 'approve';
    case 'scheduled':
    case 'running': return 'pause';
    case 'blocked': return task.failureCode === 'budget_exhausted' ? null : 'resume';
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

export function AgentWorkDetails(props: AgentWorkDetailsProps) {
  const [expanded, setExpanded] = useState(() => window.matchMedia('(min-width: 1121px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1121px)');
    const sync = () => setExpanded(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const proposed = props.tasks.filter((task) => task.status === 'proposed').length;
  const run = async (operation: () => Promise<unknown>) => { await operation(); await props.onRefresh(); };
  return (
    <aside className="agent-work-details">
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary aria-label="고급 작업 정보">작업 정보</summary><div className="agent-work-details-body">
        <dl><div><dt>담당 에이전트</dt><dd>{props.responsibleAgentName}</dd></div><div><dt>배정 이유</dt><dd>{props.assignmentCopy}</dd></div><div><dt>요청 방식</dt><dd>{props.mission.executionEngine === 'auto' ? '자동 선택' : `직접 지정 · ${executionEngineLabel(props.mission.executionEngine)}`}</dd></div><div><dt>실제 실행</dt><dd data-testid="agent-work-resolved-engine">{props.resolvedExecutionEngine ? resolvedExecutionEngineLabel(props.resolvedExecutionEngine) : '확인 불가'}</dd></div><div><dt>결과 형식</dt><dd>{deliverableKindLabel(props.mission.deliverable.kind)} · {deliverableFormatLabel(props.mission.deliverable.format)}</dd></div></dl>
        <section><header><strong>실행 계획</strong><span>{props.tasks.filter((task) => task.status === 'completed').length}/{props.tasks.length}</span></header>
          {!props.tasks.length && <button className="agent-work-primary-action" type="button" disabled={props.busy === props.mission.id} onClick={() => void run(() => props.onPlanMission(props.mission.id))}>계획 만들기</button>}
          {proposed > 0 && <button className="agent-work-primary-action" type="button" disabled={props.busy === props.mission.id} onClick={() => void run(() => props.onApprovePlan(props.mission.id))}>전체 승인</button>}
          <div className="agent-work-task-list">{props.tasks.map((task) => { const action = taskAction(task); const appearance = agentTaskAppearance(task.status); return <article className="agent-work-task" data-tone={appearance.tone} key={task.id}><header><strong>{preserveWorkClosingPhrase(task.title)}</strong><span>{appearance.label}</span></header><p>{preserveWorkClosingPhrase(task.status === 'blocked' || task.status === 'failed' ? agentTaskCause(task) : task.reason || task.expectedOutput)}</p><footer>{task.sessionId && <button type="button" onClick={() => props.onOpenSession(task.sessionId)}>Task Session 열기</button>}{task.status === 'scheduled' && <button type="button" disabled={props.busy === task.id} onClick={() => void run(() => props.onRunTaskNow(task.id))}>지금 실행</button>}{action && <button type="button" disabled={props.busy === task.id} onClick={() => void run(() => props.onTaskAction(task.id, action))}>{taskActionLabel(action)}</button>}</footer></article>; })}</div>
          <footer className="agent-work-mission-actions">{props.mission.status === 'active' && <button type="button" onClick={() => void run(() => props.onMissionWorkAction(props.mission.id, 'pause'))}>전체 일시정지</button>}{props.mission.status === 'paused' && <button type="button" onClick={() => void run(() => props.onMissionWorkAction(props.mission.id, 'activate'))}>재개</button>}{!['completed', 'cancelled'].includes(props.mission.status) && <button type="button" onClick={() => void run(() => props.onMissionWorkAction(props.mission.id, 'cancel'))}>작업 중단</button>}</footer>
        </section>
      </div></details>
    </aside>
  );
}
