import { AgentWorkParseError } from './workConversationError';
import { timestamp } from './workConversationValues';
import type {
  AgentWorkApplicationMode,
  AgentWorkCheckpointApplicationMode,
  AgentWorkCheckpointKind,
  AgentWorkCheckpointMetadata,
  AgentWorkDeliveryStatus,
} from './workConversationTypes';

export function parseCheckpointKind(value: unknown): AgentWorkCheckpointKind | null {
  switch (value) {
    case 'user_message':
    case 'agent_message':
    case 'plan':
    case 'approval_request':
    case 'approval_response':
    case 'progress':
    case 'artifact':
    case 'error':
    case 'completion':
    case 'revision_started':
    case 'revision_completed':
    case 'blocked': return value;
    case 'tool_activity': return null;
    default: throw new AgentWorkParseError('checkpoint.kind');
  }
}

export function parseDeliveryStatus(value: unknown, field: string): AgentWorkDeliveryStatus {
  switch (value) {
    case 'accepted':
    case 'applied':
    case 'queued':
    case 'approval_required':
    case 'rejected': return value;
    default: throw new AgentWorkParseError(field);
  }
}

export function parseApplicationMode(value: unknown, field: string): AgentWorkApplicationMode {
  switch (value) {
    case 'mission_context':
    case 'next_attempt':
    case 'next_checkpoint':
    case 'state_transition':
    case 'unsupported_external_request':
    case 'revision':
    case 'follow_up_required': return value;
    default: throw new AgentWorkParseError(field);
  }
}

function parseCheckpointApplicationMode(value: unknown): AgentWorkCheckpointApplicationMode {
  switch (value) {
    case 'mission_context':
    case 'next_attempt':
    case 'next_checkpoint':
    case 'state_transition':
    case 'unsupported_external_request':
    case 'revision':
    case 'follow_up_required':
    case 'checkpoint_result':
    case 'applied_at_checkpoint': return value;
    default: throw new AgentWorkParseError('checkpoint.metadata.applicationMode');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new AgentWorkParseError('checkpoint.metadata');
  }
  return value;
}

function optionalString(source: Readonly<Record<string, unknown>>, key: string, allowEmpty = false): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new AgentWorkParseError(`checkpoint.metadata.${key}`);
  return value;
}

function optionalTimestamp(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = optionalString(source, key);
  return value === undefined ? undefined : timestamp(value, `checkpoint.metadata.${key}`);
}

function optionalNumber(source: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentWorkParseError(`checkpoint.metadata.${key}`);
  return value;
}

export function parseCheckpointMetadata(value: unknown): AgentWorkCheckpointMetadata {
  if (value === undefined) return {};
  const source = record(value);
  const deliveryStatus = source.deliveryStatus === undefined ? undefined : parseDeliveryStatus(source.deliveryStatus, 'checkpoint.metadata.deliveryStatus');
  const acceptedAt = optionalTimestamp(source, 'acceptedAt');
  const appliedAt = optionalTimestamp(source, 'appliedAt');
  const action = optionalString(source, 'action');
  const targetTaskId = optionalString(source, 'targetTaskId');
  const revisionId = optionalString(source, 'revisionId');
  const revisionNumber = optionalNumber(source, 'revisionNumber');
  const reportId = optionalString(source, 'reportId');
  const taskId = optionalString(source, 'taskId');
  const progress = optionalNumber(source, 'progress');
  const code = optionalString(source, 'code');
  const jobId = optionalString(source, 'jobId', true);
  if (deliveryStatus === 'applied' && !appliedAt) throw new AgentWorkParseError('checkpoint.metadata.appliedAt');
  if (deliveryStatus && deliveryStatus !== 'applied' && appliedAt) throw new AgentWorkParseError('checkpoint.metadata.appliedAt');
  return {
    ...(action !== undefined ? { action } : {}),
    ...(source.applicationMode === undefined ? {} : { applicationMode: parseCheckpointApplicationMode(source.applicationMode) }),
    ...(deliveryStatus !== undefined ? { deliveryStatus } : {}),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    ...(targetTaskId !== undefined ? { targetTaskId } : {}),
    ...(revisionId !== undefined ? { revisionId } : {}),
    ...(revisionNumber !== undefined ? { revisionNumber } : {}),
    ...(reportId !== undefined ? { reportId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
  };
}
