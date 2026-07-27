import { useEffect, useState } from 'react';

import { agentTaskAppearance, agentTaskCause } from './agentTaskAppearance';
import { executionEngineLabel, resolvedExecutionEngineLabel } from './executionContracts';
import { deliverableFormatLabel, deliverableKindLabel, preserveWorkClosingPhrase } from './workConversationPresentation';
import type { AgentMission, AgentTask, AgentTaskAction } from './types';
import type {
  AgentEffectiveConfiguration,
  AgentEffectiveConfigurationHistory,
  AgentResolvedExecutionEngine,
} from './workConversationTypes';

type AgentWorkDetailsProps = {
  readonly mission: AgentMission;
  readonly tasks: readonly AgentTask[];
  readonly responsibleAgentName: string;
  readonly assignmentCopy: string;
  readonly resolvedExecutionEngine: AgentResolvedExecutionEngine | null;
  readonly effectiveConfiguration?: Readonly<{
    current: AgentEffectiveConfiguration | null;
    history: readonly AgentEffectiveConfigurationHistory[];
  }>;
  readonly busy: string;
  readonly onApprovePlan?: (missionId: string) => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onRunTaskNow?: (taskId: string) => Promise<void>;
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
  const [expanded, setExpanded] = useState(() => (
    typeof window !== 'undefined'
    && window.matchMedia('(min-width: 1121px)').matches
  ));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(min-width: 1121px)');
    const sync = () => setExpanded(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const proposed = props.tasks.filter((task) => task.status === 'proposed').length;
  const current = props.effectiveConfiguration?.current || null;
  const history = props.effectiveConfiguration?.history || [];
  const approvePlan = props.onApprovePlan;
  const runTaskNow = props.onRunTaskNow;
  const run = async (operation: () => Promise<unknown>) => { await operation(); await props.onRefresh(); };
  return (
    <aside className="agent-work-details">
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary aria-label="고급 작업 정보">작업 정보</summary><div className="agent-work-details-body">
        <dl><div><dt>담당 에이전트</dt><dd>{props.responsibleAgentName}</dd></div><div><dt>배정 이유</dt><dd>{props.assignmentCopy}</dd></div><div><dt>요청 방식</dt><dd>{props.mission.executionEngine === 'auto' ? '자동 선택' : `직접 지정 · ${executionEngineLabel(props.mission.executionEngine)}`}</dd></div><div><dt>실제 실행</dt><dd data-testid="agent-work-resolved-engine">{props.resolvedExecutionEngine ? resolvedExecutionEngineLabel(props.resolvedExecutionEngine) : '확인 불가'}</dd></div><div><dt>결과 형식</dt><dd>{deliverableKindLabel(props.mission.deliverable.kind)} · {deliverableFormatLabel(props.mission.deliverable.format)}</dd></div></dl>
        <section data-testid="agent-effective-configuration">
          <header><strong>현재 유효 구성</strong><span>{current?.executable ? '실행 가능' : '기본 거부'}</span></header>
          {current ? (
            <dl>
              <div><dt>엔진 / 모델</dt><dd>{current.engine.resolved || current.engine.requested}{current.engine.model ? ` · ${current.engine.model}` : ''}</dd></div>
              <div><dt>선택 이유</dt><dd>{current.engine.reason || '서버 정책'}</dd></div>
              <div><dt>Runner</dt><dd>{current.runner.ref} · catalog v{current.runner.catalogVersion}</dd></div>
              <div><dt>프로필</dt><dd>v{current.profile.version} · {current.profile.displayName}</dd></div>
              <div><dt>규칙</dt><dd>기본 거부 · 거부 우선</dd></div>
              <div><dt>허용 grant</dt><dd>{current.grants.allowed.map((entry) => `${entry.id}@${entry.version}`).join(', ') || '없음'}</dd></div>
              <div><dt>거부 grant</dt><dd>{current.grants.denied.join(', ') || '없음'}</dd></div>
              <div><dt>기억 범위</dt><dd>{current.memoryScopes.join(', ') || '없음'}</dd></div>
              <div><dt>승인 정책</dt><dd>grant 확대 및 외부 전달은 승인 필요</dd></div>
              <div><dt>Snapshot</dt><dd><code>{current.snapshotId}</code></dd></div>
            </dl>
          ) : <p>서버가 현재 유효 구성을 확인하지 못했습니다.</p>}
          {history.length > 0 && (
            <details>
              <summary>이 실행의 구성 기록 {history.length}개</summary>
              <ol>{history.map((entry) => (
                <li key={`${entry.jobRef}:${entry.turnIndex}`}>
                  <strong>Turn {entry.turnIndex} · profile v{entry.configuration.profile.version}</strong>
                  <span>{entry.configuration.engine.resolved || entry.configuration.engine.requested} · {entry.configuration.runner.ref}</span>
                  <span>{entry.configuration.grants.allowed.map((grant) => `${grant.id}@${grant.version}`).join(', ') || 'grant 없음'}</span>
                  <code>{entry.configuration.snapshotId}</code>
                </li>
              ))}</ol>
            </details>
          )}
        </section>
        {props.tasks.length > 0 && <section><header><strong>작업 단계</strong><span>{props.tasks.filter((task) => task.status === 'completed').length}/{props.tasks.length}</span></header>
          {proposed > 0 && approvePlan && <button className="agent-work-primary-action" type="button" disabled={props.busy === props.mission.id} onClick={() => void run(() => approvePlan(props.mission.id))}>전체 승인</button>}
          <div className="agent-work-task-list">{props.tasks.map((task) => { const action = taskAction(task); const appearance = agentTaskAppearance(task.status); return <article className="agent-work-task" data-tone={appearance.tone} key={task.id}><header><strong>{preserveWorkClosingPhrase(task.title)}</strong><span>{appearance.label}</span></header><p>{preserveWorkClosingPhrase(task.status === 'blocked' || task.status === 'failed' ? agentTaskCause(task) : task.reason || task.expectedOutput)}</p><footer>{task.sessionId && <button type="button" onClick={() => props.onOpenSession(task.sessionId)}>Task Session 열기</button>}{task.status === 'scheduled' && runTaskNow && <button type="button" disabled={props.busy === task.id} onClick={() => void run(() => runTaskNow(task.id))}>지금 실행</button>}{action && <button type="button" disabled={props.busy === task.id} onClick={() => void run(() => props.onTaskAction(task.id, action))}>{taskActionLabel(action)}</button>}</footer></article>; })}</div>
        </section>}
      </div></details>
    </aside>
  );
}
