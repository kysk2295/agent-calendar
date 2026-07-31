import { resolvedExecutionEngineLabel } from './executionContracts';
import type { AgentMissionState, AgentTask, AgentTaskState } from './types';
import type {
  AgentResolvedExecutionEngine,
  AgentWorkCheckpoint,
} from './workConversationTypes';

type WorkerTone = 'active' | 'waiting' | 'blocked' | 'failed' | 'completed' | 'unknown';

export type AgentWorkerRow = Readonly<{
  id: string;
  name: string;
  workLabel: string;
  statusLabel: string;
  tone: WorkerTone;
  engineLabel: string;
  sessionId: string;
  detailLines: readonly string[];
}>;

type WorkerProjectionInput = Readonly<{
  mission: Readonly<{
    id: string;
    title: string;
    status: AgentMissionState;
    agentId?: string;
  }>;
  tasks: readonly Pick<AgentTask, 'id' | 'sessionId' | 'title' | 'status' | 'agent' | 'executionEngine'>[];
  checkpoints: readonly AgentWorkCheckpoint[];
  responsibleAgentName: string;
  resolvedExecutionEngine: AgentResolvedExecutionEngine | null;
  resolvedExecutionModel: string;
}>;

const UNKNOWN_EVIDENCE = '실행 근거 확인 필요 · 상세 기록이 아직 없습니다.';

function taskStatus(status: AgentTaskState): Readonly<{ label: string; tone: WorkerTone }> {
  switch (status) {
    case 'proposed': return { label: '승인 대기', tone: 'waiting' };
    case 'approved':
    case 'scheduled': return { label: '대기', tone: 'waiting' };
    case 'running': return { label: '진행 중', tone: 'active' };
    case 'blocked': return { label: '차단됨', tone: 'blocked' };
    case 'completed': return { label: '완료', tone: 'completed' };
    case 'failed': return { label: '실패', tone: 'failed' };
    case 'cancelled': return { label: '중단됨', tone: 'failed' };
  }
}

function missionStatus(status: AgentMissionState): Readonly<{ label: string; tone: WorkerTone }> {
  switch (status) {
    case 'draft': return { label: '계획 대기', tone: 'waiting' };
    case 'active': return { label: '진행 중', tone: 'active' };
    case 'paused': return { label: '일시정지', tone: 'waiting' };
    case 'completed': return { label: '완료', tone: 'completed' };
    case 'failed': return { label: '실패', tone: 'failed' };
    case 'cancelled': return { label: '중단됨', tone: 'failed' };
  }
}

function checkpointStatus(checkpoint: AgentWorkCheckpoint): Readonly<{ label: string; tone: WorkerTone }> {
  switch (checkpoint.kind) {
    case 'completion':
    case 'revision_completed': return { label: '완료', tone: 'completed' };
    case 'error': return { label: '실패', tone: 'failed' };
    case 'blocked': return { label: '차단됨', tone: 'blocked' };
    case 'approval_request': return { label: '승인 대기', tone: 'waiting' };
    case 'progress':
    case 'tool': return { label: '진행 기록 있음', tone: 'active' };
    default: return { label: '기록 확인', tone: 'unknown' };
  }
}

function engineEvidence(
  checkpoint: AgentWorkCheckpoint | undefined,
  fallbackEngine: AgentResolvedExecutionEngine | null = null,
  fallbackModel = '',
): string {
  const engine = checkpoint?.metadata.resolvedExecutionEngine || fallbackEngine;
  if (!engine) return '확인 필요';
  const model = checkpoint?.metadata.resolvedExecutionModel
    || fallbackModel;
  return `${resolvedExecutionEngineLabel(engine)}${model ? ` · ${model}` : ''}`;
}

function detailLines(checkpoints: readonly AgentWorkCheckpoint[]): readonly string[] {
  const lines = checkpoints
    .filter((checkpoint) => checkpoint.text.trim())
    .slice(-6)
    .map((checkpoint) => checkpoint.text.trim());
  return lines.length ? lines : [UNKNOWN_EVIDENCE];
}

function latestCheckpoint(checkpoints: readonly AgentWorkCheckpoint[]): AgentWorkCheckpoint | undefined {
  return checkpoints.reduce<AgentWorkCheckpoint | undefined>(
    (latest, checkpoint) => !latest || checkpoint.sequence >= latest.sequence ? checkpoint : latest,
    undefined,
  );
}

function latestEngineCheckpoint(checkpoints: readonly AgentWorkCheckpoint[]): AgentWorkCheckpoint | undefined {
  return latestCheckpoint(checkpoints.filter((checkpoint) => Boolean(checkpoint.metadata.resolvedExecutionEngine)));
}

function comparisonRows(input: WorkerProjectionInput): readonly AgentWorkerRow[] {
  const comparison = input.checkpoints.filter((checkpoint) => checkpoint.metadata.turnMode === 'comparison');
  if (!comparison.length) return [];
  const latestTurn = Math.max(...comparison.map((checkpoint) => checkpoint.metadata.turnIndex ?? 0));
  const current = comparison.filter((checkpoint) => (checkpoint.metadata.turnIndex ?? 0) === latestTurn);
  const targetIndexes = [...new Set(current.map((checkpoint) => checkpoint.metadata.turnTargetIndex ?? 0))].sort((a, b) => a - b);
  if (targetIndexes.length < 2) return [];
  return targetIndexes.map((targetIndex) => {
    const evidence = current.filter((checkpoint) => (checkpoint.metadata.turnTargetIndex ?? 0) === targetIndex);
    const latest = latestCheckpoint(evidence);
    const status = latest ? checkpointStatus(latest) : { label: '확인 필요', tone: 'unknown' as const };
    const engine = engineEvidence(latestEngineCheckpoint(evidence));
    return {
      id: `comparison-${latestTurn}-${targetIndex}`,
      name: engine === '확인 필요' ? `작업자 ${targetIndex + 1}` : engine.split(' · ')[0],
      workLabel: `비교 실행 ${targetIndex + 1}`,
      statusLabel: status.label,
      tone: status.tone,
      engineLabel: engine,
      sessionId: latest?.sessionId || '',
      detailLines: detailLines(evidence),
    };
  });
}

export function projectAgentWorkerRows(input: WorkerProjectionInput): readonly AgentWorkerRow[] {
  const comparison = comparisonRows(input);
  if (comparison.length) return comparison;

  if (input.tasks.length) {
    return input.tasks.map((task, index) => {
      const evidence = input.checkpoints.filter((checkpoint) => (
        checkpoint.metadata.taskId === task.id
        || (task.sessionId && checkpoint.sessionId === task.sessionId)
      ));
      const latest = latestCheckpoint(evidence);
      const status = taskStatus(task.status);
      return {
        id: `task-${task.id}`,
        name: task.agent && task.agent !== input.mission.agentId
          ? task.agent
          : input.responsibleAgentName || `작업자 ${index + 1}`,
        workLabel: task.title,
        statusLabel: status.label,
        tone: status.tone,
        engineLabel: engineEvidence(latestEngineCheckpoint(evidence)),
        sessionId: task.sessionId || latest?.sessionId || '',
        detailLines: detailLines(evidence),
      };
    });
  }

  const status = missionStatus(input.mission.status);
  return [{
    id: `mission-${input.mission.id}`,
    name: input.responsibleAgentName,
    workLabel: input.mission.title,
    statusLabel: status.label,
    tone: status.tone,
    engineLabel: engineEvidence(undefined, input.resolvedExecutionEngine, input.resolvedExecutionModel),
    sessionId: '',
    detailLines: detailLines(input.checkpoints),
  }];
}

type AgentWorkerStripProps = Readonly<{
  rows: readonly AgentWorkerRow[];
  openWorkerId: string | null;
  onOpen: (workerId: string) => void;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}>;

export function AgentWorkerStrip(props: AgentWorkerStripProps) {
  const openWorker = props.rows.find((row) => row.id === props.openWorkerId) || null;
  return (
    <section className="agent-worker-strip" aria-label="하위 작업자 상태">
      <header>
        <strong>작업자</strong>
        <span>{props.rows.length}개 실행 경로 · 상태는 실행 근거 기준</span>
      </header>
      <ul>
        {props.rows.map((row) => <li key={row.id}>
          <button type="button" aria-label={`${row.workLabel} 실행 상세 열기`} aria-expanded={openWorker?.id === row.id} onClick={() => props.onOpen(row.id)}>
            <span><strong>{row.workLabel}</strong><small>{row.name}</small></span>
            <span className="agent-worker-engine">실제 실행 <b>{row.engineLabel}</b></span>
            <span className="agent-worker-status" data-tone={row.tone}>{row.statusLabel}</span>
            <span className="agent-worker-detail-action">실행 상세 열기</span>
          </button>
        </li>)}
      </ul>
      {openWorker && <div className="agent-worker-detail-backdrop" onMouseDown={(event) => {
        if (event.currentTarget === event.target) props.onClose();
      }}>
        <aside className="agent-worker-detail" role="dialog" aria-modal="false" aria-labelledby="agent-worker-detail-title">
          <header>
            <span><small>Execution detail</small><h2 id="agent-worker-detail-title">{openWorker.workLabel}</h2></span>
            <button type="button" aria-label="실행 상세 닫기" onClick={props.onClose}>닫기</button>
          </header>
          <dl>
            <div><dt>작업자</dt><dd>{openWorker.name}</dd></div>
            <div><dt>상태</dt><dd>{openWorker.statusLabel}</dd></div>
            <div><dt>실제 실행</dt><dd>{openWorker.engineLabel}</dd></div>
          </dl>
          <section>
            <strong>실행 기록</strong>
            <div role="log" aria-live="off">{openWorker.detailLines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div>
          </section>
          <footer>
            {openWorker.sessionId
              ? <button type="button" onClick={() => props.onOpenSession(openWorker.sessionId)}>Task Session 전체 기록 열기</button>
              : <span>Task Session 확인 필요</span>}
          </footer>
        </aside>
      </div>}
    </section>
  );
}
