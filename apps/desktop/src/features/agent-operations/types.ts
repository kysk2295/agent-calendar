export type AgentMissionState = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type AgentTaskState =
  | 'proposed'
  | 'approved'
  | 'scheduled'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentTaskAction = 'approve' | 'pause' | 'resume' | 'cancel' | 'retry';
export type AgentTaskFailureCode = 'budget_exhausted' | 'relay_cancel_unconfirmed';

export type AgentExecutionEngine = 'auto' | 'hermes' | 'local_llm' | 'codex';
export type AgentDeliverableKind = 'report' | 'document' | 'image' | 'file';

export type AgentDeliverable = {
  readonly kind: AgentDeliverableKind;
  readonly format: string;
};

export type AgentMissionCreateInput = {
  readonly templateId: 'general-agent-work';
  readonly title: string;
  readonly objective: string;
  readonly agentId?: string;
  readonly executionEngine: AgentExecutionEngine;
  readonly deliverable: AgentDeliverable;
};

export type SessionEventKind =
  | 'agent_message'
  | 'user_message'
  | 'plan'
  | 'tool_activity'
  | 'progress'
  | 'approval_request'
  | 'approval_response'
  | 'artifact'
  | 'error'
  | 'completion';

export type AgentMissionPolicy = {
  readonly maxRunsPerWeek: number;
  readonly maxRuntimeMinutesPerWeek: number;
  readonly forbiddenActions: readonly string[];
};

export type AgentMissionBudget = {
  readonly usedRuns: number;
  readonly usedMinutes: number;
  readonly weekStartedAt: string;
};

export type AgentMission = {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly agentId: string;
  readonly executionEngine: AgentExecutionEngine;
  readonly deliverable: AgentDeliverable;
  readonly status: AgentMissionState;
  readonly timezone: string;
  readonly sources: readonly string[];
  readonly reportSchedule: {
    readonly weekday: number;
    readonly hour: number;
    readonly minute: number;
  };
  readonly policy: AgentMissionPolicy;
  readonly budget: AgentMissionBudget;
  readonly missionThreadId: string;
  readonly planSummary: string;
  readonly plannedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentTask = {
  readonly id: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: AgentTaskState;
  readonly agent: string;
  readonly origin: 'agent';
  readonly reason: string;
  readonly expectedOutput: string;
  readonly scheduledAt: string;
  readonly dueAt: string;
  readonly date: string;
  readonly time: string;
  readonly estimatedMinutes: number;
  readonly actionClass: string;
  readonly sourceRefs: readonly string[];
  readonly executionEngine: AgentExecutionEngine;
  readonly deliverable: AgentDeliverable;
  readonly blockedReason: string;
  readonly pauseMode: string;
  readonly failureCode?: AgentTaskFailureCode;
  readonly attempt: number;
  readonly reportId: string;
};

export type AgentSession = {
  readonly id: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly type: 'mission-thread' | 'task';
  readonly title: string;
  readonly status: string;
  readonly executionEngine: AgentExecutionEngine;
  readonly deliverable: AgentDeliverable;
  readonly pendingInstructions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentSessionEvent = {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: SessionEventKind;
  readonly text: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

export type AgentSessionDetail = AgentSession & {
  readonly events: readonly AgentSessionEvent[];
};

export type AgentEvidence = {
  readonly label: string;
  readonly url: string;
};

export type AgentFollowUpDecision = {
  readonly index: number;
  readonly title: string;
  readonly reason: string;
  readonly decision: 'approved' | 'rejected';
  readonly recordedAt: string;
};

export type AgentReport = {
  readonly id: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly findings: readonly string[];
  readonly evidence: readonly AgentEvidence[];
  readonly limitations: readonly string[];
  readonly followUps: readonly Readonly<{ title: string; reason: string }>[];
  readonly followUpDecisions: readonly AgentFollowUpDecision[];
  readonly budget: Readonly<{ usedRuns: number; usedMinutes: number }>;
  readonly deliveryStatus: string;
  readonly useful: boolean | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentOperationsDaemon = {
  readonly running: boolean;
  readonly lastRun: string | null;
  readonly lastError: string | null;
};

export type AgentOperationsState = {
  readonly missions: readonly AgentMission[];
  readonly tasks: readonly AgentTask[];
  readonly sessions: readonly AgentSession[];
  readonly reports: readonly AgentReport[];
  readonly daemon: AgentOperationsDaemon;
};

export type AgentRosterEntry = {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly enabled: boolean;
  readonly model: string;
  readonly role: string;
  readonly provider: string;
  readonly trustLevel: string;
  readonly allowedTaskClasses: readonly string[];
};

export type AgentTaskAppearance = {
  readonly label: string;
  readonly tone: 'amber' | 'blue' | 'green' | 'red' | 'neutral';
  readonly line: 'dashed' | 'solid';
};

export type HermesAutomationStatus = 'active' | 'paused' | 'failed' | 'unknown';

export type HermesAutomationJob = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly agentId: string;
  readonly schedule: string;
  readonly status: HermesAutomationStatus;
  readonly enabled: boolean | null;
  readonly source: string;
  readonly lastRunAt: string;
  readonly nextRunAt: string;
  readonly lastStatus: string;
};

export type HermesAutomationUpdateInput = {
  readonly name: string;
  readonly goal: string;
  readonly agentId: string;
  readonly schedule: string;
};

export type * from './workConversationTypes';
