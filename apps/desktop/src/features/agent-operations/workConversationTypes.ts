import type { AgentDeliverable, AgentExecutionEngine, AgentMissionState } from './types';

export type AgentWorkCheckpointKind =
  | 'user_message'
  | 'agent_message'
  | 'plan'
  | 'approval_request'
  | 'approval_response'
  | 'progress'
  | 'tool'
  | 'artifact'
  | 'error'
  | 'completion'
  | 'revision_started'
  | 'revision_completed'
  | 'blocked';

export type AgentWorkDeliveryStatus =
  | 'accepted'
  | 'applied'
  | 'queued'
  | 'approval_required'
  | 'rejected';

export type AgentWorkApplicationMode =
  | 'mission_context'
  | 'next_attempt'
  | 'next_checkpoint'
  | 'state_transition'
  | 'unsupported_external_request'
  | 'revision'
  | 'follow_up_required';

export type AgentWorkCheckpointApplicationMode = AgentWorkApplicationMode
  | 'checkpoint_result'
  | 'applied_at_checkpoint';

export type AgentWorkCheckpointOrigin =
  | 'agent'
  | 'calendar'
  | 'desktop'
  | 'execution'
  | 'telegram'
  | 'user';

export type AgentAssignment =
  | Readonly<{ kind: 'explicit'; agentId: string }>
  | Readonly<{ kind: 'keyword'; agentId: string }>
  | Readonly<{ kind: 'default'; agentId: string }>
  | Readonly<{ kind: 'legacy'; agentId: string }>;

/** Actual engine that ran (or will run) — never the requested `auto` selector. */
export type AgentResolvedExecutionEngine = 'hermes' | 'codex' | 'claude' | 'grok' | 'fake';

export type AgentWorkRevisionState = {
  readonly revisionCounter: number;
  readonly pendingRevisionId: string;
  readonly currentResultReportId: string;
};

export type AgentWorkConversationStatus =
  | 'draft'
  | 'planning'
  | 'waiting_for_approval';

export type AgentWorkSummary = {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly objective: string;
  readonly status: AgentMissionState;
  readonly agentId: string;
  readonly assignment: AgentAssignment;
  readonly executionEngine: AgentExecutionEngine;
  readonly activeExecutionEngine: AgentExecutionEngine;
  readonly resolvedExecutionEngine: AgentResolvedExecutionEngine | null;
  readonly activeExecutionModel: string;
  readonly resolvedExecutionModel: string;
  readonly deliverable: AgentDeliverable;
  readonly missionThreadId: string;
  readonly workConversationId: string;
  readonly revision: AgentWorkRevisionState;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentWorkConversation = {
  readonly id: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly type: 'mission-thread';
  readonly title: string;
  readonly status: AgentWorkConversationStatus;
  readonly pendingInstructions: readonly string[];
  readonly executionEngine: AgentExecutionEngine;
  readonly deliverable: AgentDeliverable;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentWorkCheckpointMetadata = {
  readonly action?: string;
  readonly applicationMode?: AgentWorkCheckpointApplicationMode;
  readonly deliveryStatus?: AgentWorkDeliveryStatus;
  readonly acceptedAt?: string;
  readonly appliedAt?: string;
  readonly targetTaskId?: string;
  readonly revisionId?: string;
  readonly revisionNumber?: number;
  readonly reportId?: string;
  readonly taskId?: string;
  readonly progress?: number;
  readonly code?: string;
  readonly jobId?: string;
  readonly providerSessionId?: string;
  readonly requestedExecutionModel?: string;
  readonly resolvedExecutionModel?: string;
  readonly resolvedExecutionEngine?: AgentResolvedExecutionEngine;
  readonly turnIndex?: number;
  readonly turnTargetIndex?: number;
  readonly turnMode?: 'single' | 'comparison';
};

export type AgentWorkCheckpoint = {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: AgentWorkCheckpointKind;
  readonly text: string;
  readonly origin: AgentWorkCheckpointOrigin;
  readonly metadata: AgentWorkCheckpointMetadata;
  readonly createdAt: string;
};

export type AgentWorkChannelEndpoint = {
  readonly id: string;
  readonly channel: 'telegram';
  readonly status: 'active' | 'offline' | 'revoked';
  readonly runnerId: string;
  readonly ingressOwnership: 'unverified' | 'owned' | 'conflict';
  readonly ingressReadiness: 'unverified' | 'ready' | 'conflict' | 'stale';
  readonly ingressCheckedAt: string | null;
  readonly lastActivityAt: string | null;
};

export type AgentEffectiveCapability = {
  readonly id: string;
  readonly version: number;
  readonly kind: 'tool' | 'skill';
  readonly externalDelivery: boolean;
};

export type AgentEffectiveConfiguration = {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly executable: boolean;
  readonly engine: {
    readonly requested: string;
    readonly resolved: string;
    readonly model: string;
    readonly reason: string;
  };
  readonly runner: {
    readonly ref: string;
    readonly catalogId: string;
    readonly catalogVersion: number;
    readonly catalogRevision: string;
  };
  readonly profile: {
    readonly agentId: string;
    readonly displayName: string;
    readonly version: number;
  };
  readonly rules: {
    readonly defaultDeny: true;
    readonly denyOverAllow: true;
    readonly profileInstructionsApplied: boolean;
  };
  readonly grants: {
    readonly allowed: readonly AgentEffectiveCapability[];
    readonly denied: readonly string[];
    readonly approvalRequired: readonly string[];
  };
  readonly memoryScopes: readonly string[];
  readonly approvalPolicy: {
    readonly grantExpansion: 'required';
    readonly externalDelivery: 'required';
  };
  readonly requiredCapabilities: readonly string[];
};

export type AgentEffectiveConfigurationHistory = {
  readonly jobRef: string;
  readonly turnIndex: number;
  readonly createdAt: string;
  readonly configuration: AgentEffectiveConfiguration;
};

export type AgentWorkGrantSet = {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
};

export type AgentWorkBudget = {
  readonly maxRuns: number;
  readonly maxMinutes: number;
  readonly maxCostUsd: number;
};

export type AgentWorkHandoff = {
  readonly id: string;
  readonly clientRequestId: string;
  readonly parentMissionId: string;
  readonly parentHandoffId: string;
  readonly parentTaskId: string;
  readonly rootAgentId: string;
  readonly delegatorAgentId: string;
  readonly receiverAgentId: string;
  readonly depth: number;
  readonly lineage: readonly string[];
  readonly effectiveGrants: AgentWorkGrantSet;
  readonly effectiveBudget: AgentWorkBudget;
  readonly status: string;
  readonly resultProjection: Readonly<Record<string, unknown>>;
  readonly cancellationRequested: boolean;
  readonly cancellationReason: string;
  readonly executionJobId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
};

export type AgentWorkHandoffGraph = {
  readonly rootMissionId: string;
  readonly rootAgentId: string;
  readonly maxDepth: number;
  readonly maxFanOut: number;
  readonly handoffs: readonly AgentWorkHandoff[];
};

export type AgentWorkProviderSession = {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly runnerId: string;
  readonly workConversationId: string;
  readonly provider: string;
  readonly engine: string;
  readonly externalSessionId: string;
  readonly status: string;
  readonly title: string;
  readonly parentProviderSessionId: string;
  readonly generation: number;
  readonly lineage: readonly string[];
  readonly transitionAction: string;
};

export type AgentWorkProviderSessionTransition = {
  readonly id: string;
  readonly action: 'rebind' | 'new_session' | 'fork';
  readonly sourceProviderSessionId: string;
  readonly targetProviderSessionId: string;
  readonly executionJobId: string;
  readonly clientRequestId: string;
  readonly createdAt: string;
};

export type AgentWorkComparisonOutcome = {
  readonly reportId: string;
  readonly jobId: string;
  readonly executionEngine: string;
  readonly requestedModel: string;
  readonly summary: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly evidenceCount: number;
  readonly turnIndex: number;
  readonly turnTargetIndex: number;
};

export type AgentWorkComparisonAdoption = {
  readonly id: string;
  readonly reportId: string;
  readonly previousReportId: string;
  readonly selectionVersion: number;
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

export type AgentWorkComparisonState = {
  readonly currentResultReportId: string;
  readonly outcomes: readonly AgentWorkComparisonOutcome[];
  readonly adoptions: readonly AgentWorkComparisonAdoption[];
};

export type AgentWorkConversationPage = {
  readonly work: AgentWorkSummary;
  readonly conversation: AgentWorkConversation;
  readonly channels: readonly AgentWorkChannelEndpoint[];
  readonly checkpoints: readonly AgentWorkCheckpoint[];
  readonly effectiveConfiguration: {
    readonly current: AgentEffectiveConfiguration | null;
    readonly history: readonly AgentEffectiveConfigurationHistory[];
  };
  readonly handoffGraph: AgentWorkHandoffGraph;
  readonly activeProviderSessionId: string;
  readonly providerSessions: readonly AgentWorkProviderSession[];
  readonly providerSessionTransitions: readonly AgentWorkProviderSessionTransition[];
  readonly comparison: AgentWorkComparisonState;
  readonly nextCursor: string | null;
};

export type AgentWorkDelivery = {
  readonly status: AgentWorkDeliveryStatus;
  readonly applicationMode: AgentWorkApplicationMode;
  readonly acceptedAt: string;
  readonly appliedAt?: string;
  readonly targetTaskId?: string;
  readonly revisionId?: string;
};

export type AgentWorkCreateRequest = {
  readonly clientRequestId: string;
  readonly templateId?: 'general-agent-work' | 'weekly-opportunity-brief';
  readonly title: string;
  readonly objective: string;
  readonly initialMessage: string;
  readonly agentId?: string;
  readonly executionEngine?: AgentExecutionEngine;
  readonly requestedModel?: string;
  readonly deliverable?: AgentDeliverable;
};

export type AgentWorkCreateDraft = Omit<AgentWorkCreateRequest, 'clientRequestId'>;

export type AgentWorkComparisonTarget = Readonly<{
  readonly executionEngine: Extract<AgentExecutionEngine, 'codex' | 'claude' | 'grok' | 'hermes'>;
  readonly requestedModel?: string;
}>;

export type AgentWorkMessageRequest = {
  readonly clientMessageId: string;
  readonly text: string;
  readonly executionEngine?: AgentExecutionEngine;
  readonly requestedModel?: string;
  readonly comparisonTargets?: readonly AgentWorkComparisonTarget[];
};

export type AgentWorkLiveTurnRequest =
  | Readonly<{ initial: true }>
  | Readonly<{
    clientMessageId: string;
    text: string;
    executionEngine?: AgentExecutionEngine;
    requestedModel?: string;
    comparisonTargets?: readonly AgentWorkComparisonTarget[];
  }>;

export type AgentWorkLiveCheckpoint = Pick<
  AgentWorkCheckpoint,
  'id' | 'sessionId' | 'sequence' | 'kind' | 'text' | 'metadata' | 'createdAt'
>;

export type AgentWorkLiveEvent =
  | Readonly<{ type: 'accepted'; delivery: AgentWorkDelivery; idempotentReplay: boolean }>
  | Readonly<{ type: 'delta'; text: string }>
  | Readonly<{ type: 'checkpoint'; checkpoint: AgentWorkLiveCheckpoint }>
  | Readonly<{ type: 'error'; code: string; message: string }>
  | Readonly<{ type: 'done'; idempotentReplay: boolean }>;

export type AgentWorkCreateResponse = {
  readonly work: AgentWorkSummary;
  readonly conversation: AgentWorkConversation;
  readonly message: AgentWorkCheckpoint;
  readonly idempotentReplay: boolean;
};

export type AgentWorkMessageResponse = {
  readonly message: AgentWorkCheckpoint;
  readonly delivery: AgentWorkDelivery;
  readonly idempotentReplay: boolean;
};

export type AgentCreatedWork = {
  readonly id: string;
  readonly conversationId: string;
  readonly idempotentReplay: boolean;
};
