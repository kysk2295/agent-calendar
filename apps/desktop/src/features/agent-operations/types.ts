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

export type AgentExecutionEngine = 'auto' | 'hermes' | 'local_llm' | 'codex' | 'claude' | 'grok';
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
  /** Production mode: execution requires a Workspace Runner (not Hermes global scheduler). */
  readonly mode?: string | null;
};

export type AgentOperationsRunner = {
  readonly connected: boolean;
  readonly status: string;
  readonly message?: string | null;
};

export type AgentOperationsState = {
  readonly missions: readonly AgentMission[];
  readonly tasks: readonly AgentTask[];
  readonly sessions: readonly AgentSession[];
  readonly reports: readonly AgentReport[];
  readonly daemon: AgentOperationsDaemon;
  readonly runner?: AgentOperationsRunner | null;
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
  readonly responsibility?: string;
  readonly instructions?: string;
  readonly specialties?: readonly string[];
  readonly sourceKind?: 'native' | 'connected';
  readonly externalAgentId?: string;
  readonly connectionStatus?: string;
  readonly defaultExecutionEngine?: AgentExecutionEngine;
  readonly defaultRunnerId?: string;
  readonly emoji?: string;
};

export type AgentDirectoryMutationInput = {
  readonly displayName: string;
  readonly role: string;
  readonly responsibility: string;
  readonly instructions: string;
  readonly specialties: readonly string[];
  readonly sourceKind: 'native' | 'connected';
  readonly provider: string;
  readonly externalAgentId: string;
  readonly defaultExecutionEngine: AgentExecutionEngine;
  readonly defaultRunnerId: string;
};

export type AgentCatalogEntry = {
  readonly provider: string;
  readonly externalAgentId: string;
  readonly displayName: string;
  readonly description: string;
  readonly sourceKind: string;
  readonly capability: string;
  readonly modifiedAt?: string;
  readonly status?: string;
};

export type AgentCatalogRequest = {
  readonly id: string;
  readonly runnerId: string;
  readonly provider: string;
  readonly kind: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | string;
  readonly entries: readonly AgentCatalogEntry[];
  readonly errorCode: string;
  readonly errorMessage: string;
};

export type ProviderSessionCatalogEntry = {
  readonly provider: string;
  readonly externalSessionId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly status: string;
  readonly sourceKind: string;
  readonly capability: string;
};

export type ProviderSessionCatalogRequest = Omit<AgentCatalogRequest, 'entries'> & {
  readonly entries: readonly ProviderSessionCatalogEntry[];
};

export type ProviderAgentSession = {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runnerId: string;
  readonly missionId: string;
  readonly workConversationId: string;
  readonly engine: string;
  readonly provider: string;
  readonly externalAgentId: string;
  readonly externalSessionId: string;
  readonly status: string;
  readonly title: string;
  readonly lastErrorCode: string;
};

export type ProviderSessionImportResult = {
  readonly session: ProviderAgentSession;
  readonly missionId: string;
  readonly workConversationId: string;
};

export type AgentTaskAppearance = {
  readonly label: string;
  readonly tone: 'amber' | 'blue' | 'green' | 'red' | 'neutral';
  readonly line: 'dashed' | 'solid';
};

export type HermesAutomationStatus = 'active' | 'paused' | 'failed' | 'unknown';

export type AutomationCapabilities = {
  readonly list: boolean;
  readonly create: boolean;
  readonly update: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly run: boolean;
  readonly delete: boolean;
};

export type ConnectedAutomationSource = {
  readonly id: string;
  readonly runnerId: string;
  readonly adapterKind: string;
  readonly displayName: string;
  readonly status: 'connected' | 'disconnected' | 'stale' | 'error';
  readonly capabilities: AutomationCapabilities;
  readonly lastSyncedAt: string;
  readonly staleAfter: string;
};

export type AutomationChangeReceipt = {
  readonly id: string;
  readonly status: 'succeeded' | 'failed' | 'unknown' | 'conflict';
  readonly operation: string;
  readonly sourceRevision: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly createdAt: string;
};

export type HermesAutomationJob = {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly name: string;
  readonly description: string;
  readonly agentId: string;
  readonly schedule: string;
  readonly status: HermesAutomationStatus;
  readonly enabled: boolean | null;
  readonly source: string;
  readonly sourceStatus: string;
  readonly sourceRevision: string;
  readonly capabilities: AutomationCapabilities;
  readonly lastReceipt: AutomationChangeReceipt | null;
  readonly lastSyncedAt: string;
  readonly staleAfter: string;
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

export type AutomationCreateInput = HermesAutomationUpdateInput & {
  readonly sourceId: string;
};

export type * from './workConversationTypes';
