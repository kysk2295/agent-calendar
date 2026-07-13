import type { AgentEvidence, AgentFollowUpDecision, AgentReport } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function evidenceValue(value: unknown): AgentEvidence | null {
  if (typeof value === 'string') return { label: value, url: '' };
  if (!isRecord(value)) return null;
  const label = stringValue(value.label || value.title || value.url);
  return label ? { label, url: stringValue(value.url) } : null;
}

function decisionValue(value: unknown): AgentFollowUpDecision | null {
  if (!isRecord(value) || !['approved', 'rejected'].includes(stringValue(value.decision))) return null;
  return {
    index: numberValue(value.index),
    title: stringValue(value.title),
    reason: stringValue(value.reason),
    decision: value.decision === 'approved' ? 'approved' : 'rejected',
    recordedAt: stringValue(value.recordedAt),
  };
}

export function parseAgentReport(value: unknown): AgentReport | null {
  if (!isRecord(value) || !stringValue(value.id)) return null;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.map(evidenceValue).filter((item): item is AgentEvidence => item !== null)
    : [];
  const followUps = Array.isArray(value.followUps)
    ? value.followUps.filter(isRecord).map((item) => ({ title: stringValue(item.title), reason: stringValue(item.reason) })).filter((item) => item.title)
    : [];
  const followUpDecisions = Array.isArray(value.followUpDecisions)
    ? value.followUpDecisions.map(decisionValue).filter((item): item is AgentFollowUpDecision => item !== null)
    : [];
  const budget = isRecord(value.budget) ? value.budget : {};
  return {
    id: stringValue(value.id), missionId: stringValue(value.missionId), sessionId: stringValue(value.sessionId), taskId: stringValue(value.taskId),
    title: stringValue(value.title, 'Agent Report'), status: stringValue(value.status, 'ready'), findings: stringArray(value.findings),
    evidence, limitations: stringArray(value.limitations), followUps, followUpDecisions,
    budget: { usedRuns: numberValue(budget.usedRuns), usedMinutes: numberValue(budget.usedMinutes) },
    deliveryStatus: stringValue(value.deliveryStatus), useful: typeof value.useful === 'boolean' ? value.useful : null,
    createdAt: stringValue(value.createdAt), updatedAt: stringValue(value.updatedAt),
  };
}
