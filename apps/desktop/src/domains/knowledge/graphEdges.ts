import { wikiBody } from './documents';
import { knowledgeText } from './primitives';
import type { KnowledgeItem } from './types';

export function stripWikiExtension(value: string): string {
  return value.replace(/\.md$/i, '');
}

export function wikiBasename(value: string): string {
  return stripWikiExtension(value.split('/').filter(Boolean).pop() || value);
}

export function cleanWikiTarget(rawTarget = ''): string {
  const target = String(rawTarget || '')
    .split('|')[0]
    .split('#')[0]
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  try {
    return decodeURIComponent(target);
  } catch (error) {
    if (error instanceof URIError) return target;
    throw error;
  }
}

export function buildWikiGraphFallbackEdges(nodes: KnowledgeItem[]): KnowledgeItem[] {
  const maps = {
    byPath: new Map<string, string>(),
    byPathNoExt: new Map<string, string>(),
    byBasename: new Map<string, string>(),
    byTitle: new Map<string, string>(),
  };
  nodes.forEach((node, index) => {
    const id = knowledgeText(
      node.path || node.wikiPath || node.id || node._id || node.key,
      `wiki-${index}`,
    );
    const pathValue = knowledgeText(
      node.path || node.wikiPath || node.id || node._id || node.key,
      id,
    );
    const titleValue = knowledgeText(node.title || node.label, '');
    maps.byPath.set(pathValue.toLowerCase(), id);
    maps.byPathNoExt.set(stripWikiExtension(pathValue).toLowerCase(), id);
    const basename = wikiBasename(pathValue).toLowerCase();
    if (!maps.byBasename.has(basename)) maps.byBasename.set(basename, id);
    if (titleValue && !maps.byTitle.has(titleValue.toLowerCase())) {
      maps.byTitle.set(titleValue.toLowerCase(), id);
    }
  });

  const edges = new Map<string, KnowledgeItem>();
  nodes.forEach((node, index) => {
    const from = knowledgeText(
      node.path || node.wikiPath || node.id || node._id || node.key,
      `wiki-${index}`,
    );
    const sourcePath = knowledgeText(
      node.path || node.wikiPath || node.id || node._id || node.key,
      from,
    );
    const sourceDir = sourcePath.includes('/')
      ? sourcePath.split('/').slice(0, -1).join('/')
      : '';
    for (const match of wikiBody(node).matchAll(
      /!?\[\[([^\]]+)\]\]|(?<!!)\[[^\]]+\]\(([^)]+)\)/g,
    )) {
      const rawTarget = cleanWikiTarget(match[1] || match[2] || '');
      if (!rawTarget || /^[a-z]+:/i.test(rawTarget)) continue;
      const ext = rawTarget.split('/').pop()?.match(/\.[^.]+$/)?.[0].toLowerCase() || '';
      if (ext && ext !== '.md') continue;
      const direct = stripWikiExtension(rawTarget);
      const relative = sourceDir
        ? `${sourceDir}/${rawTarget}`.replace(/\/+/g, '/')
        : rawTarget;
      const candidates = [
        rawTarget,
        `${direct}.md`,
        direct,
        relative,
        `${stripWikiExtension(relative)}.md`,
        stripWikiExtension(relative),
        wikiBasename(rawTarget),
      ];
      const to = candidates
        .map((candidate) => maps.byPath.get(candidate.toLowerCase())
          || maps.byPathNoExt.get(stripWikiExtension(candidate).toLowerCase())
          || maps.byTitle.get(stripWikiExtension(candidate).toLowerCase())
          || maps.byBasename.get(wikiBasename(candidate).toLowerCase())
          || '')
        .find(Boolean) || '';
      if (!to || to === from) continue;
      const pair = [from, to].sort().join('::');
      if (!edges.has(pair)) edges.set(pair, { id: `fallback-${pair}`, from, to });
    }
  });
  return [...edges.values()];
}
