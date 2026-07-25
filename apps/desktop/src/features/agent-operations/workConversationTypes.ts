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
  readonly resolvedExecutionEngine: AgentResolvedExecutionEngine | null;
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
};

export type AgentWorkCheckpoint = {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: AgentWorkCheckpointKind;
  readonly text: string;
  readonly metadata: AgentWorkCheckpointMetadata;
  readonly createdAt: string;
};

export type AgentWorkConversationPage = {
  readonly work: AgentWorkSummary;
  readonly conversation: AgentWorkConversation;
  readonly checkpoints: readonly AgentWorkCheckpoint[];
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
  readonly deliverable?: AgentDeliverable;
};

export type AgentWorkCreateDraft = Omit<AgentWorkCreateRequest, 'clientRequestId'>;

export type AgentWorkMessageRequest = {
  readonly clientMessageId: string;
  readonly text: string;
};

export type AgentWorkLiveTurnRequest =
  | Readonly<{ initial: true }>
  | Readonly<{ clientMessageId: string; text: string }>;

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
