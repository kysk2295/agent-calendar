import type {
  AgentCreatedWork,
  AgentWorkCheckpoint,
  AgentWorkConversationPage,
  AgentWorkCreateDraft,
  AgentWorkCreateRequest,
  AgentWorkCreateResponse,
  AgentWorkMessageRequest,
  AgentWorkMessageResponse,
} from './workConversationTypes';
import { compareAgentWorkCheckpoints } from './workConversationParser';

export type AgentWorkConversationPageFetcher = (
  missionId: string,
  options: Readonly<{ cursor?: string; limit: number; signal?: AbortSignal }>,
) => Promise<AgentWorkConversationPage>;

export class AgentWorkPaginationError extends Error {
  readonly code: 'cursor_cycle' | 'identity_changed';

  constructor(code: 'cursor_cycle' | 'identity_changed') {
    super(code === 'cursor_cycle' ? 'Agent Work cursor cycle detected' : 'Agent Work identity changed between pages');
    this.name = 'AgentWorkPaginationError';
    this.code = code;
  }
}

export function agentWorkPollDelay(options: Readonly<{ visible: boolean; terminal: boolean }>): number {
  if (!options.visible) return 15_000;
  return options.terminal ? 10_000 : 2_000;
}

export function agentWorkAggregateFingerprint(page: AgentWorkConversationPage): string {
  const actionableCheckpoints = page.checkpoints
    .filter((checkpoint) => checkpoint.metadata.taskId
      || checkpoint.metadata.reportId
      || checkpoint.metadata.revisionId
      || checkpoint.metadata.targetTaskId
      || checkpoint.kind === 'revision_started'
      || checkpoint.kind === 'revision_completed')
    .map((checkpoint) => [
      checkpoint.id,
      checkpoint.kind,
      checkpoint.metadata.taskId || '',
      checkpoint.metadata.reportId || '',
      checkpoint.metadata.revisionId || '',
      checkpoint.metadata.targetTaskId || '',
    ].join(':'));
  return [
    page.work.status,
    page.work.revision.revisionCounter,
    page.work.revision.pendingRevisionId,
    page.work.revision.currentResultReportId,
    ...actionableCheckpoints,
  ].join('|');
}

export async function loadCompleteAgentWorkConversation(
  missionId: string,
  fetchPage: AgentWorkConversationPageFetcher,
  signal?: AbortSignal,
): Promise<AgentWorkConversationPage> {
  const checkpoints = new Map<string, AgentWorkCheckpoint>();
  const seenCursors = new Set<string>();
  let firstPage: AgentWorkConversationPage | null = null;
  let cursor: string | null = null;

  for (;;) {
    signal?.throwIfAborted();
    if (cursor) seenCursors.add(cursor);
    const page = await fetchPage(missionId, { ...(cursor ? { cursor } : {}), limit: 200, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (!firstPage) firstPage = page;
    if (page.work.id !== firstPage.work.id || page.conversation.id !== firstPage.conversation.id) {
      throw new AgentWorkPaginationError('identity_changed');
    }
    for (const checkpoint of page.checkpoints) {
      if (!checkpoints.has(checkpoint.id)) checkpoints.set(checkpoint.id, checkpoint);
    }
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) throw new AgentWorkPaginationError('cursor_cycle');
    cursor = page.nextCursor;
  }

  if (!firstPage) throw new AgentWorkPaginationError('identity_changed');
  return {
    ...firstPage,
    checkpoints: [...checkpoints.values()].sort(compareAgentWorkCheckpoints),
    nextCursor: null,
  };
}

export type AgentWorkTransport = {
  readonly createAgentWork: (request: AgentWorkCreateRequest) => Promise<AgentWorkCreateResponse>;
  readonly sendAgentWorkMessage: (missionId: string, request: AgentWorkMessageRequest) => Promise<AgentWorkMessageResponse>;
};

export type AgentWorkClient = {
  readonly create: (draft: AgentWorkCreateDraft) => Promise<AgentWorkCreateResponse>;
  readonly send: (
    missionId: string,
    text: string,
    executionEngine?: AgentWorkMessageRequest['executionEngine'],
    requestedModel?: string,
    comparisonTargets?: AgentWorkMessageRequest['comparisonTargets'],
  ) => Promise<AgentWorkMessageResponse>;
};

export type AgentWorkClientOptions = {
  readonly transport: AgentWorkTransport;
  readonly createId: () => string;
};

function draftKey(draft: AgentWorkCreateDraft): string {
  return [
    draft.templateId || 'general-agent-work',
    draft.title.trim(),
    draft.objective.trim(),
    draft.initialMessage.trim(),
    draft.agentId || '',
    draft.executionEngine || 'auto',
    draft.requestedModel || '',
    draft.deliverable?.kind || 'report',
    draft.deliverable?.format || 'markdown',
  ].join('\u0000');
}

function createRequest(draft: AgentWorkCreateDraft, clientRequestId: string): AgentWorkCreateRequest {
  return {
    clientRequestId,
    templateId: draft.templateId || 'general-agent-work',
    title: draft.title.trim(),
    objective: draft.objective.trim(),
    initialMessage: draft.initialMessage.trim(),
    ...(draft.agentId ? { agentId: draft.agentId } : {}),
    executionEngine: draft.executionEngine || 'auto',
    ...(draft.requestedModel ? { requestedModel: draft.requestedModel } : {}),
    deliverable: draft.deliverable || { kind: 'report', format: 'markdown' },
  };
}

export function createdWorkIdentity(response: AgentWorkCreateResponse): AgentCreatedWork {
  return {
    id: response.work.id,
    conversationId: response.conversation.id,
    idempotentReplay: response.idempotentReplay,
  };
}

export function createAgentWorkClient(options: AgentWorkClientOptions): AgentWorkClient {
  const pendingCreateIds = new Map<string, string>();
  const pendingMessageIds = new Map<string, string>();
  return {
    create: async (draft) => {
      const key = draftKey(draft);
      const clientRequestId = pendingCreateIds.get(key) || options.createId();
      pendingCreateIds.set(key, clientRequestId);
      const response = await options.transport.createAgentWork(createRequest(draft, clientRequestId));
      pendingCreateIds.delete(key);
      return response;
    },
    send: async (missionId, value, executionEngine, requestedModel, comparisonTargets) => {
      const text = value.trim();
      const model = String(requestedModel || '').trim();
      const targets = comparisonTargets?.map((target) => ({
        executionEngine: target.executionEngine,
        ...(target.requestedModel?.trim() ? { requestedModel: target.requestedModel.trim() } : {}),
      }));
      const key = `${missionId}\u0000${executionEngine || ''}\u0000${model}\u0000${JSON.stringify(targets || [])}\u0000${text}`;
      const clientMessageId = pendingMessageIds.get(key) || options.createId();
      pendingMessageIds.set(key, clientMessageId);
      const response = await options.transport.sendAgentWorkMessage(missionId, {
        clientMessageId,
        text,
        ...(executionEngine ? { executionEngine } : {}),
        ...(model ? { requestedModel: model } : {}),
        ...(targets?.length ? { comparisonTargets: targets } : {}),
      });
      pendingMessageIds.delete(key);
      return response;
    },
  };
}
