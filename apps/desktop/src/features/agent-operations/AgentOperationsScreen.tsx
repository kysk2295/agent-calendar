import { useRef } from 'react';

import { AgentWorkWorkspace } from './AgentWorkWorkspace';
import type {
  AgentCreatedWork,
  AgentMissionCreateInput,
  AgentOperationsState,
  AgentRosterEntry,
  AgentTaskAction,
  HermesAutomationJob,
} from './types';

type AgentOperationsScreenProps = {
  readonly state: AgentOperationsState;
  readonly agents: readonly AgentRosterEntry[];
  readonly automationJobs: readonly HermesAutomationJob[];
  readonly error: string;
  readonly busy: string;
  readonly onRetry: () => Promise<boolean>;
  readonly onRefreshAgentOperations: () => Promise<boolean>;
  readonly onCreateMission: (input: AgentMissionCreateInput) => Promise<AgentCreatedWork | null>;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'activate' | 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onContinueSession: (sessionId: string, message: string) => Promise<boolean>;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
};

export function AgentOperationsScreen(props: AgentOperationsScreenProps) {
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const errorMessage = props.error.includes('새로고침')
    ? '작업은 완료됐지만 최신 작업 상태를 새로고침하지 못했습니다. 현재 화면과 입력은 그대로 유지됩니다.'
    : '작업 요청을 완료하지 못했습니다. 현재 화면과 입력은 그대로 유지됩니다.';
  const retry = async () => {
    const succeeded = await props.onRetry();
    requestAnimationFrame(() => (succeeded
      ? document.querySelector<HTMLElement>('.agent-work-header h1, .agent-control-head h1')
      : retryButtonRef.current)?.focus());
  };
  return (
    <div className="agent-operations-workspace screen-in">
      {props.error && <div className="agent-operations-error" role="alert"><span>{errorMessage}</span><button ref={retryButtonRef} type="button" disabled={props.busy === 'refresh'} onClick={() => void retry()}>다시 시도</button></div>}
      <AgentWorkWorkspace
        state={props.state}
        agents={props.agents}
        automationJobs={props.automationJobs}
        aggregateStale={Boolean(props.error)}
        busy={props.busy}
        onCreateMission={props.onCreateMission}
        onRefreshAgentOperations={props.onRefreshAgentOperations}
        onPlanMission={props.onPlanMission}
        onApprovePlan={props.onApprovePlan}
        onMissionWorkAction={props.onMissionWorkAction}
        onTaskAction={props.onTaskAction}
        onRunTaskNow={props.onRunTaskNow}
        onOpenSession={props.onOpenSession}
        onContinueSession={props.onContinueSession}
        onReportFeedback={props.onReportFeedback}
        onFollowUpDecision={props.onFollowUpDecision}
      />
    </div>
  );
}
