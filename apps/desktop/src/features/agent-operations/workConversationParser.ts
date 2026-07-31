import { AgentWorkParseError } from './workConversationError';
import type {
  AgentAssignment,
  AgentResolvedExecutionEngine,
  AgentWorkCheckpoint,
  AgentWorkCheckpointOrigin,
  AgentWorkChannelEndpoint,
  AgentWorkConversation,
  AgentWorkConversationPage,
  AgentWorkComparisonAdoption,
  AgentWorkComparisonOutcome,
  AgentWorkHandoff,
  AgentWorkHandoffGraph,
  AgentWorkProviderSession,
  AgentWorkProviderSessionTransition,
  AgentEffectiveConfiguration,
  AgentEffectiveConfigurationHistory,
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
  const legacyOrigin = kind === 'user_message' || kind === 'approval_response' ? 'user' : 'agent';
  const origin = source.origin === undefined ? legacyOrigin : String(source.origin);
  if (!['agent', 'calendar', 'desktop', 'execution', 'telegram', 'user'].includes(origin)) {
    throw new AgentWorkParseError('checkpoint.origin');
  }
  return {
    id: text(source.id, 'checkpoint.id'),
    sessionId: optionalString(source.sessionId, 'checkpoint.sessionId'),
    sequence: finiteNumber(source.sequence, 'checkpoint.sequence'),
    kind,
    text: optionalString(source.text, 'checkpoint.text'),
    origin: origin as AgentWorkCheckpointOrigin,
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

function effectiveConfiguration(value: unknown): AgentEffectiveConfiguration {
  const source = record(value, 'effectiveConfiguration');
  const engineSource = record(source.engine, 'effectiveConfiguration.engine');
  const runnerSource = record(source.runner, 'effectiveConfiguration.runner');
  const profileSource = record(source.profile, 'effectiveConfiguration.profile');
  const rulesSource = record(source.rules, 'effectiveConfiguration.rules');
  const grantsSource = record(source.grants, 'effectiveConfiguration.grants');
  const approvalSource = record(source.approvalPolicy, 'effectiveConfiguration.approvalPolicy');
  if (source.schemaVersion !== 1
    || !/^ecfg_[a-f0-9]{32}$/.test(String(source.snapshotId || ''))
    || !/^runner_[a-f0-9]{16}$/.test(String(runnerSource.ref || ''))
    || !/^cat_[a-f0-9]{24}$/.test(String(runnerSource.catalogRevision || ''))
    || rulesSource.defaultDeny !== true
    || rulesSource.denyOverAllow !== true
    || approvalSource.grantExpansion !== 'required'
    || approvalSource.externalDelivery !== 'required'
    || !Array.isArray(grantsSource.allowed)) {
    throw new AgentWorkParseError('effectiveConfiguration');
  }
  const allowed = grantsSource.allowed.map((valueEntry) => {
    const entry = record(valueEntry, 'effectiveConfiguration.grants.allowed');
    if (!['tool', 'skill'].includes(String(entry.kind || ''))
      || !/^(tool|skill):[a-z0-9][a-z0-9._/-]{0,118}$/.test(String(entry.id || ''))) {
      throw new AgentWorkParseError('effectiveConfiguration.grants.allowed');
    }
    return {
      id: String(entry.id),
      version: finiteNumber(entry.version, 'effectiveConfiguration.grants.allowed.version'),
      kind: entry.kind as 'tool' | 'skill',
      externalDelivery: booleanValue(
        entry.externalDelivery,
        'effectiveConfiguration.grants.allowed.externalDelivery',
      ),
    };
  });
  return {
    schemaVersion: 1,
    snapshotId: String(source.snapshotId),
    executable: booleanValue(source.executable, 'effectiveConfiguration.executable'),
    engine: {
      requested: optionalString(engineSource.requested, 'effectiveConfiguration.engine.requested'),
      resolved: optionalString(engineSource.resolved, 'effectiveConfiguration.engine.resolved'),
      model: optionalString(engineSource.model, 'effectiveConfiguration.engine.model'),
      reason: optionalString(engineSource.reason, 'effectiveConfiguration.engine.reason'),
    },
    runner: {
      ref: String(runnerSource.ref),
      catalogId: text(runnerSource.catalogId, 'effectiveConfiguration.runner.catalogId'),
      catalogVersion: finiteNumber(
        runnerSource.catalogVersion,
        'effectiveConfiguration.runner.catalogVersion',
      ),
      catalogRevision: String(runnerSource.catalogRevision),
    },
    profile: {
      agentId: text(profileSource.agentId, 'effectiveConfiguration.profile.agentId'),
      displayName: text(profileSource.displayName, 'effectiveConfiguration.profile.displayName'),
      version: finiteNumber(profileSource.version, 'effectiveConfiguration.profile.version'),
    },
    rules: {
      defaultDeny: true,
      denyOverAllow: true,
      profileInstructionsApplied: booleanValue(
        rulesSource.profileInstructionsApplied,
        'effectiveConfiguration.rules.profileInstructionsApplied',
      ),
    },
    grants: {
      allowed,
      denied: stringList(grantsSource.denied, 'effectiveConfiguration.grants.denied'),
      approvalRequired: stringList(
        grantsSource.approvalRequired,
        'effectiveConfiguration.grants.approvalRequired',
      ),
    },
    memoryScopes: stringList(source.memoryScopes, 'effectiveConfiguration.memoryScopes'),
    approvalPolicy: {
      grantExpansion: 'required',
      externalDelivery: 'required',
    },
    requiredCapabilities: stringList(
      source.requiredCapabilities,
      'effectiveConfiguration.requiredCapabilities',
    ),
  };
}

function effectiveConfigurationHistory(value: unknown): AgentEffectiveConfigurationHistory {
  const source = record(value, 'effectiveConfiguration.history');
  if (!/^job_[a-f0-9]{16}$/.test(String(source.jobRef || ''))) {
    throw new AgentWorkParseError('effectiveConfiguration.history.jobRef');
  }
  return {
    jobRef: String(source.jobRef),
    turnIndex: finiteNumber(source.turnIndex, 'effectiveConfiguration.history.turnIndex'),
    createdAt: timestamp(source.createdAt, 'effectiveConfiguration.history.createdAt'),
    configuration: effectiveConfiguration(source.configuration),
  };
}

function parseSuccess(value: unknown): Readonly<Record<string, unknown>> {
  const source = record(value, 'response');
  if (source.ok !== true) throw new AgentWorkParseError('response.ok');
  return source;
}

function parseHandoff(value: unknown): AgentWorkHandoff {
  const source = record(value, 'handoffGraph.handoffs');
  const grants = record(source.effectiveGrants, 'handoffGraph.handoffs.effectiveGrants');
  const budget = record(source.effectiveBudget, 'handoffGraph.handoffs.effectiveBudget');
  const terminalAt = source.terminalAt === null || source.terminalAt === undefined
    ? null
    : timestamp(source.terminalAt, 'handoffGraph.handoffs.terminalAt');
  return {
    id: text(source.id, 'handoffGraph.handoffs.id'),
    clientRequestId: text(source.clientRequestId, 'handoffGraph.handoffs.clientRequestId'),
    parentMissionId: text(source.parentMissionId, 'handoffGraph.handoffs.parentMissionId'),
    parentHandoffId: optionalString(source.parentHandoffId, 'handoffGraph.handoffs.parentHandoffId'),
    parentTaskId: optionalString(source.parentTaskId, 'handoffGraph.handoffs.parentTaskId'),
    rootAgentId: text(source.rootAgentId, 'handoffGraph.handoffs.rootAgentId'),
    delegatorAgentId: text(source.delegatorAgentId, 'handoffGraph.handoffs.delegatorAgentId'),
    receiverAgentId: text(source.receiverAgentId, 'handoffGraph.handoffs.receiverAgentId'),
    depth: finiteNumber(source.depth, 'handoffGraph.handoffs.depth'),
    lineage: stringList(source.lineage, 'handoffGraph.handoffs.lineage'),
    effectiveGrants: {
      allow: stringList(grants.allow, 'handoffGraph.handoffs.effectiveGrants.allow'),
      deny: stringList(grants.deny, 'handoffGraph.handoffs.effectiveGrants.deny'),
    },
    effectiveBudget: {
      maxRuns: finiteNumber(budget.maxRuns, 'handoffGraph.handoffs.effectiveBudget.maxRuns'),
      maxMinutes: finiteNumber(budget.maxMinutes, 'handoffGraph.handoffs.effectiveBudget.maxMinutes'),
      maxCostUsd: finiteNumber(budget.maxCostUsd, 'handoffGraph.handoffs.effectiveBudget.maxCostUsd'),
    },
    status: text(source.status, 'handoffGraph.handoffs.status'),
    resultProjection: record(source.resultProjection, 'handoffGraph.handoffs.resultProjection'),
    cancellationRequested: booleanValue(
      source.cancellationRequested,
      'handoffGraph.handoffs.cancellationRequested',
    ),
    cancellationReason: optionalString(
      source.cancellationReason,
      'handoffGraph.handoffs.cancellationReason',
    ),
    executionJobId: text(source.executionJobId, 'handoffGraph.handoffs.executionJobId'),
    createdAt: timestamp(source.createdAt, 'handoffGraph.handoffs.createdAt'),
    updatedAt: timestamp(source.updatedAt, 'handoffGraph.handoffs.updatedAt'),
    terminalAt,
  };
}

function parseHandoffGraph(value: unknown, work: AgentWorkSummary): AgentWorkHandoffGraph {
  if (value === undefined) {
    return {
      rootMissionId: work.id,
      rootAgentId: work.agentId,
      maxDepth: 0,
      maxFanOut: 0,
      handoffs: [],
    };
  }
  const source = record(value, 'handoffGraph');
  if (!Array.isArray(source.handoffs)) throw new AgentWorkParseError('handoffGraph.handoffs');
  return {
    rootMissionId: text(source.rootMissionId, 'handoffGraph.rootMissionId'),
    rootAgentId: text(source.rootAgentId, 'handoffGraph.rootAgentId'),
    maxDepth: finiteNumber(source.maxDepth, 'handoffGraph.maxDepth'),
    maxFanOut: finiteNumber(source.maxFanOut, 'handoffGraph.maxFanOut'),
    handoffs: source.handoffs.map(parseHandoff),
  };
}

function parseProviderSession(value: unknown): AgentWorkProviderSession {
  const source = record(value, 'providerSessions');
  return {
    id: text(source.id, 'providerSessions.id'),
    workspaceId: text(source.workspaceId, 'providerSessions.workspaceId'),
    agentId: optionalString(source.agentId, 'providerSessions.agentId'),
    runnerId: text(source.runnerId, 'providerSessions.runnerId'),
    workConversationId: text(source.workConversationId, 'providerSessions.workConversationId'),
    provider: text(source.provider, 'providerSessions.provider'),
    engine: text(source.engine, 'providerSessions.engine'),
    externalSessionId: optionalString(source.externalSessionId, 'providerSessions.externalSessionId'),
    status: text(source.status, 'providerSessions.status'),
    title: optionalString(source.title, 'providerSessions.title'),
    parentProviderSessionId: optionalString(
      source.parentProviderSessionId,
      'providerSessions.parentProviderSessionId',
    ),
    generation: finiteNumber(source.generation, 'providerSessions.generation'),
    lineage: stringList(source.lineage, 'providerSessions.lineage'),
    transitionAction: text(source.transitionAction, 'providerSessions.transitionAction'),
  };
}

function parseProviderSessionTransition(value: unknown): AgentWorkProviderSessionTransition {
  const source = record(value, 'providerSessionTransitions');
  if (!['rebind', 'new_session', 'fork'].includes(String(source.action || ''))) {
    throw new AgentWorkParseError('providerSessionTransitions.action');
  }
  return {
    id: text(source.id, 'providerSessionTransitions.id'),
    action: source.action as AgentWorkProviderSessionTransition['action'],
    sourceProviderSessionId: optionalString(
      source.sourceProviderSessionId,
      'providerSessionTransitions.sourceProviderSessionId',
    ),
    targetProviderSessionId: text(
      source.targetProviderSessionId,
      'providerSessionTransitions.targetProviderSessionId',
    ),
    executionJobId: text(source.executionJobId, 'providerSessionTransitions.executionJobId'),
    clientRequestId: text(source.clientRequestId, 'providerSessionTransitions.clientRequestId'),
    createdAt: timestamp(source.createdAt, 'providerSessionTransitions.createdAt'),
  };
}

function parseComparisonOutcome(value: unknown): AgentWorkComparisonOutcome {
  const source = record(value, 'comparison.outcomes');
  return {
    reportId: text(source.reportId, 'comparison.outcomes.reportId'),
    jobId: text(source.jobId, 'comparison.outcomes.jobId'),
    executionEngine: text(source.executionEngine, 'comparison.outcomes.executionEngine'),
    requestedModel: optionalString(source.requestedModel, 'comparison.outcomes.requestedModel'),
    summary: optionalString(source.summary, 'comparison.outcomes.summary'),
    durationMs: finiteNumber(source.durationMs, 'comparison.outcomes.durationMs'),
    costUsd: finiteNumber(source.costUsd, 'comparison.outcomes.costUsd'),
    evidenceCount: finiteNumber(source.evidenceCount, 'comparison.outcomes.evidenceCount'),
    turnIndex: finiteNumber(source.turnIndex, 'comparison.outcomes.turnIndex'),
    turnTargetIndex: finiteNumber(source.turnTargetIndex, 'comparison.outcomes.turnTargetIndex'),
  };
}

function parseComparisonAdoption(value: unknown): AgentWorkComparisonAdoption {
  const source = record(value, 'comparison.adoptions');
  return {
    id: text(source.id, 'comparison.adoptions.id'),
    reportId: text(source.reportId, 'comparison.adoptions.reportId'),
    previousReportId: optionalString(source.previousReportId, 'comparison.adoptions.previousReportId'),
    selectionVersion: finiteNumber(source.selectionVersion, 'comparison.adoptions.selectionVersion'),
    outcome: record(source.outcome, 'comparison.adoptions.outcome'),
    createdAt: timestamp(source.createdAt, 'comparison.adoptions.createdAt'),
  };
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
  const effectiveSource = source.effectiveConfiguration === undefined
    ? {}
    : record(source.effectiveConfiguration, 'effectiveConfiguration');
  if (effectiveSource.history !== undefined && !Array.isArray(effectiveSource.history)) {
    throw new AgentWorkParseError('effectiveConfiguration.history');
  }
  if (source.providerSessions !== undefined && !Array.isArray(source.providerSessions)) {
    throw new AgentWorkParseError('providerSessions');
  }
  if (source.providerSessionTransitions !== undefined
    && !Array.isArray(source.providerSessionTransitions)) {
    throw new AgentWorkParseError('providerSessionTransitions');
  }
  const comparisonSource = source.comparison === undefined
    ? {}
    : record(source.comparison, 'comparison');
  if (comparisonSource.outcomes !== undefined && !Array.isArray(comparisonSource.outcomes)) {
    throw new AgentWorkParseError('comparison.outcomes');
  }
  if (comparisonSource.adoptions !== undefined && !Array.isArray(comparisonSource.adoptions)) {
    throw new AgentWorkParseError('comparison.adoptions');
  }
  const providerSessions = (source.providerSessions || []).map(parseProviderSession);
  const transitions = (source.providerSessionTransitions || []).map(parseProviderSessionTransition);
  const activeProviderSessionId = optionalString(
    source.activeProviderSessionId,
    'activeProviderSessionId',
  ) || transitions.at(-1)?.targetProviderSessionId
    || providerSessions.find((session) => session.status === 'active')?.id
    || '';
  return {
    work,
    conversation,
    channels: (source.channels || []).map(parseChannelEndpoint),
    checkpoints: source.checkpoints.map(parseCheckpoint).filter((item): item is AgentWorkCheckpoint => item !== null).sort(compareAgentWorkCheckpoints),
    effectiveConfiguration: {
      current: effectiveSource.current === undefined || effectiveSource.current === null
        ? null
        : effectiveConfiguration(effectiveSource.current),
      history: (effectiveSource.history || []).map(effectiveConfigurationHistory),
    },
    handoffGraph: parseHandoffGraph(source.handoffGraph, work),
    activeProviderSessionId,
    providerSessions,
    providerSessionTransitions: transitions,
    comparison: {
      currentResultReportId: optionalString(
        comparisonSource.currentResultReportId,
        'comparison.currentResultReportId',
      ) || work.revision.currentResultReportId,
      outcomes: (comparisonSource.outcomes || []).map(parseComparisonOutcome),
      adoptions: (comparisonSource.adoptions || []).map(parseComparisonAdoption),
    },
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
