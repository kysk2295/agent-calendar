import { wikiBody } from './documents';
import { knowledgeText } from './primitives';
import type { KnowledgeItem } from './types';

export function stripFrontmatter(value: string): string {
  return value.replace(/^---\s*\n[\s\S]*?\n---\s*/u, '').trim();
}

export function journalBody(item: KnowledgeItem): string {
  return stripFrontmatter(wikiBody(item));
}

export function journalDateKey(item: KnowledgeItem, fallback = ''): string {
  const direct = knowledgeText(item.date || item.day || item.journalDate, '');
  if (/^\d{4}-\d{2}-\d{2}/.test(direct)) return direct.slice(0, 10);
  const bodyDate = wikiBody(item).match(
    /^---[\s\S]*?\bdate:\s*['"]?(\d{4}-\d{2}-\d{2})/mu,
  )?.[1];
  if (bodyDate) return bodyDate;
  const pathDate = [
    item.path,
    item.wikiPath,
    item.title,
    item.createdAt,
    item.updatedAt,
  ].map((value) => knowledgeText(value)).join(' ').match(/(20\d{2})[-_/](\d{2})[-_/](\d{2})/);
  if (pathDate) return `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`;
  const timestamp = knowledgeText(item.createdAt || item.updatedAt, '');
  if (/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return timestamp.slice(0, 10);
  return fallback;
}

export function journalTime(item: KnowledgeItem): number {
  const date = journalDateKey(item);
  const timestamp = date ? Date.parse(`${date}T00:00:00`) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
