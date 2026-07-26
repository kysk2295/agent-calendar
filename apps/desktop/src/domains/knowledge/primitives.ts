import type { KnowledgeEnvelope, KnowledgeItem } from './types';

export function isKnowledgeItem(value: unknown): value is KnowledgeItem {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isKnowledgeItemArray(value: unknown): value is KnowledgeItem[] {
  return Array.isArray(value) && value.every(isKnowledgeItem);
}

export function arrayFrom(payload: KnowledgeEnvelope | undefined, ...keys: string[]): KnowledgeItem[] {
  for (const key of keys) {
    const value = payload?.[key];
    if (isKnowledgeItemArray(value)) return value;
  }
  const data = payload?.data;
  if (isKnowledgeItem(data)) {
    const found = arrayFrom(data, ...keys);
    if (found.length) return found;
  }
  const state = payload?.state;
  if (isKnowledgeItem(state)) {
    const found = arrayFrom(state, ...keys);
    if (found.length) return found;
  }
  return [];
}

export function objectFrom(payload: KnowledgeEnvelope | undefined, key: string): KnowledgeEnvelope {
  const value = payload?.[key];
  if (isKnowledgeItem(value)) return value;
  const data = payload?.data;
  if (isKnowledgeItem(data)) return objectFrom(data, key);
  const state = payload?.state;
  if (isKnowledgeItem(state)) return objectFrom(state, key);
  return {};
}

export function knowledgeText(value: unknown, fallback = ''): string {
  return String(value || fallback);
}

export function knowledgeTitle(item: KnowledgeItem, fallback = '항목'): string {
  return knowledgeText(
    item.title || item.goal || item.name || item.subject || item.label || item.text || item.path,
    fallback,
  );
}
