import type { AgentTask, AgentTaskAppearance, AgentTaskState } from './types';

export function agentTaskAppearance(state: AgentTaskState): AgentTaskAppearance {
  switch (state) {
    case 'proposed':
      return { label: '에이전트 제안', tone: 'amber', line: 'dashed' };
    case 'approved':
    case 'scheduled':
      return { label: '예약됨', tone: 'blue', line: 'solid' };
    case 'running':
      return { label: '실행 중', tone: 'blue', line: 'solid' };
    case 'completed':
      return { label: '보고 완료', tone: 'green', line: 'solid' };
    case 'blocked':
      return { label: '차단됨', tone: 'red', line: 'solid' };
    case 'failed':
      return { label: '실패', tone: 'red', line: 'solid' };
    case 'cancelled':
      return { label: '취소됨', tone: 'neutral', line: 'solid' };
    default:
      return assertNever(state);
  }
}

export function agentTaskCalendarRecord(task: AgentTask): Readonly<Record<string, unknown>> {
  const appearance = agentTaskAppearance(task.status);
  return {
    ...task,
    owner: 'Agent',
    kind: 'agent-task',
    type: 'agent-task',
    source: 'agent-operations',
    agentTaskState: task.status,
    agentTaskTone: appearance.tone,
    agentTaskLine: appearance.line,
    agentTaskLabel: appearance.label,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Agent Task state: ${JSON.stringify(value)}`);
}
