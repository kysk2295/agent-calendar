import {
  arrayFrom,
  knowledgeText,
  knowledgeTitle,
  objectFrom,
} from './primitives';
import type { KnowledgeEnvelope, KnowledgeItem } from './types';

export function docIdentity(item: KnowledgeItem, fallback = ''): string {
  return knowledgeText(
    item.path || item.wikiPath || item.id || item._id || item.key || item.title,
    fallback,
  );
}

export function persistedDocumentIdentity(item: KnowledgeItem, fallback = ''): string {
  return knowledgeText(item.path || item.wikiPath || item.id || item._id || item.key, fallback);
}

export function createdDocumentFrom(payload: KnowledgeEnvelope): KnowledgeItem {
  const nested = objectFrom(payload, 'document');
  if (persistedDocumentIdentity(nested)) return nested;
  return persistedDocumentIdentity(payload) ? payload : {};
}

export function wikiDetail(payload: KnowledgeEnvelope): KnowledgeItem {
  const selected = objectFrom(payload, 'selectedNote');
  if (Object.keys(selected).length) return selected;
  return objectFrom(objectFrom(payload, 'wikiIndex'), 'selectedNote');
}

export function wikiList(payload: KnowledgeEnvelope): KnowledgeItem[] {
  const index = objectFrom(payload, 'wikiIndex');
  const graph = objectFrom(payload, 'graph');
  const indexGraph = objectFrom(index, 'graph');
  return [
    ...arrayFrom(payload, 'notes'),
    ...arrayFrom(payload, 'documents'),
    ...arrayFrom(index, 'notes'),
    ...arrayFrom(index, 'documents'),
    ...arrayFrom(graph, 'nodes'),
    ...arrayFrom(indexGraph, 'nodes'),
  ];
}

export function isJournalDoc(item: KnowledgeItem): boolean {
  const kind = knowledgeText(item.kind || item.type).toLowerCase();
  const haystack = [
    item.path,
    item.wikiPath,
    item.folder,
    item.group,
    item.category,
    item.tag,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].map((value) => knowledgeText(value).toLowerCase()).join(' ');
  return kind === 'diary'
    || kind === 'journal'
    || haystack.includes('4_journal')
    || haystack.includes('journal')
    || haystack.includes('diary')
    || knowledgeTitle(item).includes('일기');
}

export function mergeDocsByIdentity(
  primary: KnowledgeItem[],
  secondary: KnowledgeItem[],
): KnowledgeItem[] {
  const seen = new Set<string>();
  const merged: KnowledgeItem[] = [];
  [...primary, ...secondary].forEach((item, index) => {
    const key = docIdentity(item, `doc-${index}`);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

export function wikiJournalDocs(payload: KnowledgeEnvelope): KnowledgeItem[] {
  return mergeDocsByIdentity([], wikiList(payload).filter(isJournalDoc));
}

export function wikiBody(item: KnowledgeItem): string {
  return knowledgeText(
    item.content || item.body || item.markdown || item.summary || item.extract || item.excerpt,
    '',
  );
}

export function hasWikiFullBody(item: KnowledgeItem): boolean {
  return Boolean(knowledgeText(item.content || item.body || item.markdown || item.extract, ''));
}
