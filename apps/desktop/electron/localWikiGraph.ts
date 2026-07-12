import path from 'node:path';

export type LocalWikiGraphNote = {
  id: string;
  path: string;
  folder: string;
  kind: string;
  title: string;
  body: string;
  updatedAt: string;
};

type LocalWikiLink = { raw: string; kind: 'embed' | 'wikilink' | 'markdown' };
type LocalWikiMaps = {
  byPath: Map<string, string>;
  byPathNoExt: Map<string, string>;
  byBasename: Map<string, string>;
  byTitle: Map<string, string>;
};

function normalizeWikiKey(value: string) {
  return value.trim().toLowerCase();
}

function stripMarkdownExtension(value: string) {
  return value.replace(/\.md$/i, '');
}

function toPosixPath(value: string) {
  return value.split(path.sep).join('/');
}

function cleanLocalWikiTarget(rawTarget = '') {
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

function extractLocalWikiLinks(markdown = '') {
  const links: LocalWikiLink[] = [];
  for (const match of markdown.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    links.push({ raw: match[1], kind: match[0].startsWith('!') ? 'embed' : 'wikilink' });
  }
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    links.push({ raw: match[1], kind: 'markdown' });
  }
  return links;
}

function buildLocalWikiMaps(notes: LocalWikiGraphNote[]): LocalWikiMaps {
  const maps: LocalWikiMaps = {
    byPath: new Map(),
    byPathNoExt: new Map(),
    byBasename: new Map(),
    byTitle: new Map(),
  };
  for (const note of notes) {
    maps.byPath.set(normalizeWikiKey(note.path), note.id);
    maps.byPathNoExt.set(normalizeWikiKey(stripMarkdownExtension(note.path)), note.id);
    const basename = stripMarkdownExtension(path.posix.basename(note.path));
    if (!maps.byBasename.has(normalizeWikiKey(basename))) maps.byBasename.set(normalizeWikiKey(basename), note.id);
    if (!maps.byTitle.has(normalizeWikiKey(note.title))) maps.byTitle.set(normalizeWikiKey(note.title), note.id);
  }
  return maps;
}

function resolveLocalWikiLink({ rawTarget, sourcePath, kind, maps }: { rawTarget: string; sourcePath: string; kind: LocalWikiLink['kind']; maps: LocalWikiMaps }) {
  const target = cleanLocalWikiTarget(rawTarget);
  if (!target || /^[a-z]+:/i.test(target)) return '';
  const ext = path.posix.extname(target).toLowerCase();
  if (ext && ext !== '.md') return '';

  const directCandidates: string[] = [];
  const sourceDir = path.posix.dirname(sourcePath);
  const normalizedTarget = toPosixPath(path.posix.normalize(target));
  if (target.includes('/')) {
    const relative = toPosixPath(path.posix.normalize(path.posix.join(sourceDir, target)));
    const rootCandidates = [normalizedTarget, `${stripMarkdownExtension(normalizedTarget)}.md`];
    const relativeCandidates = [relative, `${stripMarkdownExtension(relative)}.md`];
    directCandidates.push(...(kind === 'markdown' ? [...relativeCandidates, ...rootCandidates] : [...rootCandidates, ...relativeCandidates]));
  }
  directCandidates.push(target);
  directCandidates.push(`${stripMarkdownExtension(target)}.md`);

  for (const candidate of directCandidates) {
    const key = normalizeWikiKey(candidate);
    const pathMatch = maps.byPath.get(key) || maps.byPathNoExt.get(normalizeWikiKey(stripMarkdownExtension(candidate)));
    if (pathMatch) return pathMatch;
  }

  const titleMatch = maps.byTitle.get(normalizeWikiKey(stripMarkdownExtension(target)));
  if (titleMatch) return titleMatch;
  return maps.byBasename.get(normalizeWikiKey(stripMarkdownExtension(path.posix.basename(target)))) || '';
}

export function buildLocalWikiGraph(notes: LocalWikiGraphNote[]) {
  const maps = buildLocalWikiMaps(notes);
  const edgesById = new Map<string, { id: string; from: string; to: string; label: string }>();
  notes.forEach((note) => {
    extractLocalWikiLinks(note.body).forEach((link) => {
      const target = resolveLocalWikiLink({ rawTarget: link.raw, sourcePath: note.path, kind: link.kind, maps });
      if (!target || target === note.id) return;
      const id = [note.id, target].sort((left, right) => left.localeCompare(right)).join('<->');
      if (!edgesById.has(id)) edgesById.set(id, { id, from: note.id, to: target, label: link.kind });
    });
  });
  const groups = [...new Set(notes.map((note) => note.folder || note.path.split('/')[0] || 'root'))].sort((a, b) => a.localeCompare(b, 'ko'));

  return {
    nodes: notes.map((note) => ({
      id: note.id,
      path: note.path,
      title: note.title,
      folder: note.folder,
      kind: note.kind,
      updatedAt: note.updatedAt,
    })),
    edges: [...edgesById.values()],
    groups,
  };
}
