import { AgentWorkParseError } from './workConversationError';
import type {
  AgentAssignment,
  AgentResolvedExecutionEngine,
  AgentWorkCheckpoint,
  AgentWorkChannelEndpoint,
  AgentWorkConversation,
  AgentWorkConversationPage,
  AgentWorkCreateResponse,
  AgentWorkDelivery,
  AgentWorkMessageResponse,
  AgentWorkSummary,
} from './workConversationTypes';
import {
  parseApplicationMode,
  parseCheckpointKind,
  parseCheckpointMetadata,
  parseDeliveryStatus,
} from './workConversationVariants';
import {
  booleanValue,
  conversationStatus,
  executionEngine,
  finiteNumber,
  missionState,
  optionalIdentifier,
  optionalString,
  record,
  resolveWorkConversationContract,
  stringList,
  text,
  timestamp,
  type WorkConversationContract,
} from './workConversationValues';

export { AgentWorkParseError } from './workConversationError';

function assignment(value: unknown, agentId: string): AgentAssignment {
  if (value === undefined) return { kind: 'legacy', agentId };
  const reason = text(value, 'work.assignmentReason');
  if (reason === 'default:official') return { kind: 'default', agentId };
  if (reason === `explicit:${agentId}`) return { kind: 'explicit', agentId };
  if (reason === `keyword:${agentId}`) return { kind: 'keyword', agentId };
  throw new AgentWorkParseError('work.assignmentReason');
}

function resolvedExecutionEngine(value: unknown): AgentResolvedExecutionEngine | null {
  if (value === undefined || value === null || value === '') return null;
  switch (value) {
    case 'hermes': return 'hermes';
    case 'codex': return 'codex';
    case 'claude': return 'claude';
    case 'grok': return 'grok';
    case 'fake': return 'fake';
    // Requested-only / unknown as resolved: fail closed rather than inventing a label.
    case 'auto':
    case 'local_llm':
      throw new AgentWorkParseError('work.resolvedExecutionEngine');
    default: throw new AgentWorkParseError('work.resolvedExecutionEngine');
  }
}

function parseWork(value: unknown, contract: WorkConversationContract): AgentWorkSummary {
  const source = record(value, 'work');
  const agentId = text(source.agentId, 'work.agentId', 'default');
  return {
    id: text(source.id, 'work.id'),
    templateId: text(source.templateId, 'work.templateId', 'general-agent-work'),
    title: text(source.title, 'work.title'),
    objective: optionalString(source.objective, 'work.objective'),
    status: missionState(source.status),
    agentId,
    assignment: assignment(source.assignmentReason, agentId),
    executionEngine: contract.executionEngine,
    activeExecutionEngine: source.activeExecutionEngine === undefined
      ? contract.executionEngine
      : executionEngine(source.activeExecutionEngine, 'work.activeExecutionEngine'),
    resolvedExecutionEngine: resolvedExecutionEngine(source.resolvedExecutionEngine),
    activeExecutionModel: optionalString(source.activeExecutionModel, 'work.activeExecutionModel'),
    resolvedExecutionModel: optionalString(source.resolvedExecutionModel, 'work.resolvedExecutionModel'),
    deliverable: contract.deliverable,
    missionThreadId: text(source.missionThreadId, 'work.missionThreadId'),
    workConversationId: source.workConversationId === undefined ? text(source.missionThreadId, 'work.missionThreadId') : text(source.workConversationId, 'work.workConversationId'),
    revision: {
      revisionCounter: finiteNumber(source.revisionCounter, 'work.revisionCounter'),
      pendingRevisionId: optionalString(source.pendingRevisionId, 'work.pendingRevisionId'),
      currentResultReportId: optionalString(source.currentResultReportId, 'work.currentResultReportId'),
    },
    createdAt: timestamp(source.createdAt, 'work.createdAt', true),
    updatedAt: timestamp(source.updatedAt, 'work.updatedAt', true),
  };
}

function parseConversation(value: unknown, contract: WorkConversationContract): AgentWorkConversation {
  const source = record(value, 'conversation');
  if (source.type !== 'mission-thread') throw new AgentWorkParseError('conversation.type');
  return {
    id: text(source.id, 'conversation.id'),
    missionId: text(source.missionId, 'conversation.missionId'),
    taskId: optionalString(source.taskId, 'conversation.taskId'),
    type: 'mission-thread',
    title: text(source.title, 'conversation.title'),
    status: conversationStatus(source.status),
    pendingInstructions: stringList(source.pendingInstructions, 'conversation.pendingInstructions'),
    executionEngine: contract.executionEngine,
    deliverable: contract.deliverable,
    createdAt: timestamp(source.createdAt, 'conversation.createdAt', true),
    updatedAt: timestamp(source.updatedAt, 'conversation.updatedAt', true),
  };
}

function matchWorkConversation(work: AgentWorkSummary, conversation: AgentWorkConversation): void {
  if (conversation.missionId !== work.id || conversation.id !== work.missionThreadId || conversation.id !== work.workConversationId) {
    throw new AgentWorkParseError('conversation.identity');
  }
}

function parseCheckpoint(value: unknown): AgentWorkCheckpoint | null {
  const source = record(value, 'checkpoint');
  const kind = parseCheckpointKind(source.kind);
  if (!kind) return null;
  return {
    id: text(source.id, 'checkpoint.id'),
    sessionId: optionalString(source.sessionId, 'checkpoint.sessionId'),
    sequence: finiteNumber(source.sequence, 'checkpoint.sequence'),
    kind,
    text: optionalString(source.text, 'checkpoint.text'),
    metadata: parseCheckpointMetadata(source.metadata),
    createdAt: timestamp(source.createdAt, 'checkpoint.createdAt'),
  };
}

export function compareAgentWorkCheckpoints(left: AgentWorkCheckpoint, right: AgentWorkCheckpoint): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.sequence - right.sequence
    || left.id.localeCompare(right.id);
}

function requiredCheckpoint(value: unknown, field: string): AgentWorkCheckpoint {
  const parsed = parseCheckpoint(value);
  if (!parsed) throw new AgentWorkParseError(field);
  return parsed;
}

function parseChannelEndpoint(value: unknown): AgentWorkChannelEndpoint {
  const source = record(value, 'channel');
  if (source.channel !== 'telegram') throw new AgentWorkParseError('channel.channel');
  if (!['active', 'offline', 'revoked'].includes(String(source.status || ''))) {
    throw new AgentWorkParseError('channel.status');
  }
  if (!['unverified', 'owned', 'conflict'].includes(String(source.ingressOwnership || ''))) {
    throw new AgentWorkParseError('channel.ingressOwnership');
  }
  if (!['unverified', 'ready', 'conflict', 'stale'].includes(String(source.ingressReadiness || ''))) {
    throw new AgentWorkParseError('channel.ingressReadiness');
  }
  const ingressOwnership = source.ingressOwnership as AgentWorkChannelEndpoint['ingressOwnership'];
  const ingressReadiness = source.ingressReadiness as AgentWorkChannelEndpoint['ingressReadiness'];
  const validIngressState = (
    (ingressOwnership === 'unverified' && ingressReadiness === 'unverified')
    || (ingressOwnership === 'owned' && ['ready', 'stale'].includes(ingressReadiness))
    || (ingressOwnership === 'conflict' && ['conflict', 'stale'].includes(ingressReadiness))
  );
  if (!validIngressState) throw new AgentWorkParseError('channel.ingressReadiness');
  const ingressCheckedAt = source.ingressCheckedAt === null || source.ingressCheckedAt === undefined
    ? null
    : timestamp(source.ingressCheckedAt, 'channel.ingressCheckedAt');
  const expectsIngressTimestamp = ingressOwnership !== 'unverified' || ingressReadiness !== 'unverified';
  if (expectsIngressTimestamp !== (ingressCheckedAt !== null)) {
    throw new AgentWorkParseError('channel.ingressCheckedAt');
  }
  return {
    id: text(source.id, 'channel.id'),
    channel: 'telegram',
    status: source.status as AgentWorkChannelEndpoint['status'],
    runnerId: text(source.runnerId, 'channel.runnerId'),
    ingressOwnership,
    ingressReadiness,
    ingressCheckedAt,
    lastActivityAt: source.lastActivityAt === null || source.lastActivityAt === undefined
      ? null
      : timestamp(source.lastActivityAt, 'channel.lastActivityAt'),
  };
}

function parseSuccess(value: unknown): Readonly<Record<string, unknown>> {
  const source = record(value, 'response');
  if (source.ok !== true) throw new AgentWorkParseError('response.ok');
  return source;
}

export function parseAgentWorkConversationPage(value: unknown): AgentWorkConversationPage {
  const source = parseSuccess(value);
  if (!Array.isArray(source.checkpoints)) throw new AgentWorkParseError('checkpoints');
  if (source.nextCursor !== null && (typeof source.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,1000}$/.test(source.nextCursor))) {
    throw new AgentWorkParseError('nextCursor');
  }
  const contract = resolveWorkConversationContract(source.work, source.conversation);
  const work = parseWork(source.work, contract);
  const conversation = parseConversation(source.conversation, contract);
  matchWorkConversation(work, conversation);
  if (source.channels !== undefined && !Array.isArray(source.channels)) {
    throw new AgentWorkParseError('channels');
  }
  return {
    work,
    conversation,
    channels: (source.channels || []).map(parseChannelEndpoint),
    checkpoints: source.checkpoints.map(parseCheckpoint).filter((item): item is AgentWorkCheckpoint => item !== null).sort(compareAgentWorkCheckpoints),
    nextCursor: source.nextCursor,
  };
}

function parseDelivery(value: unknown): AgentWorkDelivery {
  const source = record(value, 'delivery');
  const status = parseDeliveryStatus(source.status, 'delivery.status');
  const appliedAt = timestamp(source.appliedAt, 'delivery.appliedAt', true);
  if (status === 'applied' && !appliedAt) throw new AgentWorkParseError('delivery.appliedAt');
  if (status !== 'applied' && appliedAt) throw new AgentWorkParseError('delivery.appliedAt');
  return {
    status,
    applicationMode: parseApplicationMode(source.applicationMode, 'delivery.applicationMode'),
    acceptedAt: timestamp(source.acceptedAt, 'delivery.acceptedAt'),
    ...(appliedAt ? { appliedAt } : {}),
    ...(source.targetTaskId === undefined ? {} : { targetTaskId: optionalIdentifier(source.targetTaskId, 'delivery.targetTaskId') }),
    ...(source.revisionId === undefined ? {} : { revisionId: optionalIdentifier(source.revisionId, 'delivery.revisionId') }),
  };
}

export function parseAgentWorkCreateResponse(value: unknown): AgentWorkCreateResponse {
  const source = parseSuccess(value);
  const contract = resolveWorkConversationContract(source.work, source.conversation);
  const work = parseWork(source.work, contract);
  const conversation = parseConversation(source.conversation, contract);
  const message = requiredCheckpoint(source.message, 'message');
  matchWorkConversation(work, conversation);
  if (message.sessionId !== conversation.id) throw new AgentWorkParseError('message.sessionId');
  return {
    work,
    conversation,
    message,
    idempotentReplay: booleanValue(source.idempotentReplay, 'idempotentReplay'),
  };
}

export function parseAgentWorkMessageResponse(value: unknown): AgentWorkMessageResponse {
  const source = parseSuccess(value);
  return {
    message: requiredCheckpoint(source.message, 'message'),
    delivery: parseDelivery(source.delivery),
    idempotentReplay: booleanValue(source.idempotentReplay, 'idempotentReplay'),
  };
}
