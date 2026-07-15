import type { AgentDeliverable, AgentExecutionEngine, AgentMissionState } from './types';
import { AgentWorkParseError } from './workConversationError';
import type { AgentWorkConversationStatus } from './workConversationTypes';

export type WorkConversationContract = Readonly<{
  executionEngine: AgentExecutionEngine;
  deliverable: AgentDeliverable;
}>;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new AgentWorkParseError(field);
  return value;
}

export function text(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new AgentWorkParseError(field);
  return value;
}

export function optionalString(value: unknown, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new AgentWorkParseError(field);
  return value;
}

export function optionalIdentifier(value: unknown, field: string): string {
  return value === undefined ? '' : text(value, field);
}

export function timestamp(value: unknown, field: string, optional = false): string {
  if (optional && value === undefined) return '';
  const parsed = text(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(parsed);
  if (!match) throw new AgentWorkParseError(field);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText = '0', offsetMinuteText = '0'] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || Number.isNaN(Date.parse(parsed))) {
    throw new AgentWorkParseError(field);
  }
  return parsed;
}

export function stringList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new AgentWorkParseError(field);
  return value;
}

export function finiteNumber(value: unknown, field: string, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentWorkParseError(field);
  return value;
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new AgentWorkParseError(field);
  return value;
}

export function executionEngine(value: unknown, field: string): AgentExecutionEngine {
  switch (value) {
    case 'auto':
    case 'hermes':
    case 'local_llm':
    case 'codex': return value;
    default: throw new AgentWorkParseError(field);
  }
}

export function missionState(value: unknown): AgentMissionState {
  if (value === undefined) return 'draft';
  switch (value) {
    case 'draft': return 'draft';
    case 'active': return 'active';
    case 'paused': return 'paused';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: throw new AgentWorkParseError('work.status');
  }
}

export function conversationStatus(value: unknown): AgentWorkConversationStatus {
  if (value === undefined) return 'draft';
  switch (value) {
    case 'draft': return 'draft';
    case 'planning': return 'planning';
    case 'waiting_for_approval': return 'waiting_for_approval';
    default: throw new AgentWorkParseError('conversation.status');
  }
}

export function deliverable(value: unknown, field: string): AgentDeliverable {
  const source = record(value, field);
  let kind: AgentDeliverable['kind'];
  switch (source.kind) {
    case 'report':
    case 'document':
    case 'image':
    case 'file': kind = source.kind; break;
    default: throw new AgentWorkParseError(`${field}.kind`);
  }
  const format = source.format === undefined ? (kind === 'report' ? 'markdown' : '') : optionalString(source.format, `${field}.format`);
  return { kind, format };
}

function sameDeliverable(left: AgentDeliverable, right: AgentDeliverable): boolean {
  return left.kind === right.kind && left.format === right.format;
}

export function resolveWorkConversationContract(work: unknown, conversation: unknown): WorkConversationContract {
  const workSource = record(work, 'work');
  const conversationSource = record(conversation, 'conversation');
  const workEngine = workSource.executionEngine === undefined ? null : executionEngine(workSource.executionEngine, 'work.executionEngine');
  const conversationEngine = conversationSource.executionEngine === undefined ? null : executionEngine(conversationSource.executionEngine, 'conversation.executionEngine');
  if (workEngine && conversationEngine && workEngine !== conversationEngine) throw new AgentWorkParseError('conversation.executionEngine');
  const workDeliverable = workSource.deliverable === undefined ? null : deliverable(workSource.deliverable, 'work.deliverable');
  const conversationDeliverable = conversationSource.deliverable === undefined ? null : deliverable(conversationSource.deliverable, 'conversation.deliverable');
  if (workDeliverable && conversationDeliverable && !sameDeliverable(workDeliverable, conversationDeliverable)) {
    throw new AgentWorkParseError('conversation.deliverable');
  }
  return {
    executionEngine: workEngine || conversationEngine || 'hermes',
    deliverable: workDeliverable || conversationDeliverable || { kind: 'report', format: 'markdown' },
  };
}
