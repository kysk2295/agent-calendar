import type {
  AgentWorkApplicationMode,
  AgentWorkCheckpointKind,
  AgentWorkDelivery,
  AgentWorkDeliveryStatus,
  AgentWorkLiveEvent,
} from './workConversationTypes';

const DELIVERY_STATUSES = new Set<AgentWorkDeliveryStatus>([
  'accepted', 'applied', 'queued', 'approval_required', 'rejected',
]);
const APPLICATION_MODES = new Set<AgentWorkApplicationMode>([
  'mission_context', 'next_attempt', 'next_checkpoint', 'state_transition',
  'unsupported_external_request', 'revision', 'follow_up_required',
]);
const CHECKPOINT_KINDS = new Set<AgentWorkCheckpointKind>([
  'user_message', 'agent_message', 'plan', 'approval_request', 'approval_response',
  'progress', 'tool', 'artifact', 'error', 'completion', 'revision_started', 'revision_completed', 'blocked',
]);

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function text(value: unknown, maximum = 8_000): string | null {
  return typeof value === 'string' && value.length <= maximum ? value : null;
}

function delivery(value: unknown): AgentWorkDelivery | null {
  const source = record(value);
  const status = text(source?.status, 64) as AgentWorkDeliveryStatus | null;
  const applicationMode = text(source?.applicationMode, 80) as AgentWorkApplicationMode | null;
  const acceptedAt = text(source?.acceptedAt, 80);
  if (!status || !applicationMode || !acceptedAt || !DELIVERY_STATUSES.has(status) || !APPLICATION_MODES.has(applicationMode)) return null;
  const appliedAt = text(source?.appliedAt, 80);
  const targetTaskId = text(source?.targetTaskId, 160);
  const revisionId = text(source?.revisionId, 160);
  return {
    status,
    applicationMode,
    acceptedAt,
    ...(appliedAt ? { appliedAt } : {}),
    ...(targetTaskId ? { targetTaskId } : {}),
    ...(revisionId ? { revisionId } : {}),
  };
}

function checkpoint(value: unknown): Extract<AgentWorkLiveEvent, { type: 'checkpoint' }>['checkpoint'] | null {
  const source = record(value);
  const id = text(source?.id, 160);
  const sessionId = text(source?.sessionId, 160);
  const kind = text(source?.kind, 80) as AgentWorkCheckpointKind | null;
  const message = text(source?.text);
  const createdAt = text(source?.createdAt, 80);
  if (!id || !sessionId || !kind || !message || !createdAt || !CHECKPOINT_KINDS.has(kind)) return null;
  const sequence = Number(source?.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) return null;
  const metadata = record(source?.metadata) || {};
  return { id, sessionId, kind, text: message, createdAt, sequence, metadata };
}

function parseEvent(name: string, raw: string): AgentWorkLiveEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const source = record(payload);
  if (!source) return null;
  if (name === 'accepted') {
    const accepted = delivery(source.delivery);
    return accepted && typeof source.idempotentReplay === 'boolean'
      ? { type: 'accepted', delivery: accepted, idempotentReplay: source.idempotentReplay }
      : null;
  }
  if (name === 'delta') {
    const value = text(source.text);
    return value ? { type: 'delta', text: value } : null;
  }
  if (name === 'checkpoint') {
    const value = checkpoint(source.checkpoint);
    return value ? { type: 'checkpoint', checkpoint: value } : null;
  }
  if (name === 'error') {
    const code = text(source.code, 120);
    const message = text(source.message);
    return code && message ? { type: 'error', code, message } : null;
  }
  return name === 'done' && typeof source.idempotentReplay === 'boolean'
    ? { type: 'done', idempotentReplay: source.idempotentReplay }
    : null;
}

async function consumeBlock(block: string, onEvent: (event: AgentWorkLiveEvent) => Promise<void> | void): Promise<void> {
  const lines = block.split('\n');
  const name = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim() || 'message';
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trimStart()).join('\n');
  if (!data) return;
  const event = parseEvent(name, data);
  if (event) await onEvent(event);
}

export async function consumeAgentWorkLiveSse(response: Response, onEvent: (event: AgentWorkLiveEvent) => Promise<void> | void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let separator = pending.indexOf('\n\n');
    while (separator >= 0) {
      await consumeBlock(pending.slice(0, separator), onEvent);
      pending = pending.slice(separator + 2);
      separator = pending.indexOf('\n\n');
    }
    if (done) break;
  }
  if (pending.trim()) await consumeBlock(pending, onEvent);
}
