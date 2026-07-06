const fs = require('node:fs');
const path = require('node:path');

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function dateStamp(value = new Date(), timeZone = 'Asia/Seoul') {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureWikiStructure(wikiRoot) {
  [
    '1_raw/documents',
    '1_raw/documents/assets',
    '2_wiki/dev-tasks',
    '3_output',
    '3_output/visual-briefs',
    '5_conversation/agent-runs',
    '5_conversation/handovers',
    '6_agents/profiles',
    '6_agents/rules',
    '6_agents/skills',
    '6_agents/model-presets',
    '7_automation/schedules',
    '7_automation/failures',
  ].forEach((dir) => ensureDir(path.join(wikiRoot, dir)));

  const logPath = path.join(wikiRoot, 'log.md');
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '# 변경 이력\n\n| 날짜 | 인텐트 | 대상 |\n|------|--------|------|\n', 'utf8');
  }
}

const WIKI_SKIP_DIRS = new Set(['.git', '.obsidian', '.secrets', '.trash', 'node_modules']);
const WIKI_SKIP_FILES = new Set(['log.md']);
const WIKI_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf', '.heic', '.vtt', '.csv', '.json']);

function toPosixPath(value = '') {
  return String(value || '').split(path.sep).join('/');
}

function normalizeKey(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function stripMarkdownExtension(value = '') {
  return String(value || '').replace(/\.md$/i, '');
}

function walkWikiFiles(wikiRoot) {
  if (!wikiRoot || !fs.existsSync(wikiRoot)) return [];
  const files = [];
  const visit = (absoluteDir, relativeDir = '') => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (WIKI_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(path.join(absoluteDir, entry.name), relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (WIKI_SKIP_FILES.has(toPosixPath(relativePath))) continue;
      files.push({
        absolutePath: path.join(absoluteDir, entry.name),
        relativePath: toPosixPath(relativePath),
      });
    }
  };
  visit(wikiRoot);
  return files;
}

function parseFrontmatter(markdown = '') {
  if (!markdown.startsWith('---\n')) return {};
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return {};
  const frontmatter = {};
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return frontmatter;
}

function withoutFrontmatter(markdown = '') {
  if (!markdown.startsWith('---\n')) return markdown;
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return markdown;
  return markdown.slice(end + 4).replace(/^\s+/, '');
}

function firstMarkdownHeading(markdown = '') {
  const match = withoutFrontmatter(markdown).match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function titleFromNote({ markdown, relativePath }) {
  const frontmatter = parseFrontmatter(markdown);
  return frontmatter.title || firstMarkdownHeading(markdown) || path.basename(relativePath, '.md');
}

function excerptFromMarkdown(markdown = '') {
  return withoutFrontmatter(markdown)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('---'))
    .join(' ')
    .replace(/!\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .slice(0, 260);
}

function cleanLinkTarget(rawTarget = '') {
  const target = String(rawTarget || '')
    .split('|')[0]
    .split('#')[0]
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function extractLinkTargets(markdown = '') {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    targets.push({ raw: match[1], type: match[0].startsWith('!') ? 'embed' : 'wikilink' });
  }
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    targets.push({ raw: match[1], type: 'markdown' });
  }
  return targets;
}

function buildNoteMaps(notes) {
  const maps = {
    byPath: new Map(),
    byPathNoExt: new Map(),
    byBasename: new Map(),
    byTitle: new Map(),
  };
  for (const note of notes) {
    maps.byPath.set(normalizeKey(note.path), note.path);
    maps.byPathNoExt.set(normalizeKey(stripMarkdownExtension(note.path)), note.path);
    const basename = stripMarkdownExtension(path.posix.basename(note.path));
    if (!maps.byBasename.has(normalizeKey(basename))) maps.byBasename.set(normalizeKey(basename), note.path);
    if (!maps.byTitle.has(normalizeKey(note.title))) maps.byTitle.set(normalizeKey(note.title), note.path);
  }
  return maps;
}

function resolveNoteLink({ rawTarget, sourcePath, maps }) {
  const target = cleanLinkTarget(rawTarget);
  if (!target || /^[a-z]+:/i.test(target)) return null;
  const ext = path.posix.extname(target).toLowerCase();
  if (ext && ext !== '.md') return null;
  const directCandidates = [];
  const sourceDir = path.posix.dirname(sourcePath);
  const normalizedTarget = toPosixPath(path.posix.normalize(target));
  if (target.includes('/')) {
    directCandidates.push(normalizedTarget);
    directCandidates.push(`${stripMarkdownExtension(normalizedTarget)}.md`);
    const relative = toPosixPath(path.posix.normalize(path.posix.join(sourceDir, target)));
    directCandidates.push(relative);
    directCandidates.push(`${stripMarkdownExtension(relative)}.md`);
  }
  directCandidates.push(target);
  directCandidates.push(`${stripMarkdownExtension(target)}.md`);
  for (const candidate of directCandidates) {
    const pathMatch = maps.byPath.get(normalizeKey(candidate)) || maps.byPathNoExt.get(normalizeKey(stripMarkdownExtension(candidate)));
    if (pathMatch) return pathMatch;
  }
  const titleMatch = maps.byTitle.get(normalizeKey(stripMarkdownExtension(target)));
  if (titleMatch) return titleMatch;
  return maps.byBasename.get(normalizeKey(stripMarkdownExtension(path.posix.basename(target)))) || null;
}

function buildWikiTree(notes) {
  const folderCounts = new Map();
  for (const note of notes) {
    const parts = note.path.split('/').slice(0, -1);
    for (let index = 0; index < parts.length; index += 1) {
      const folderPath = parts.slice(0, index + 1).join('/');
      folderCounts.set(folderPath, (folderCounts.get(folderPath) || 0) + 1);
    }
  }
  const folderItems = [...folderCounts.entries()].map(([folderPath, count]) => ({
    id: `folder:${folderPath}`,
    kind: 'folder',
    path: folderPath,
    label: path.posix.basename(folderPath),
    depth: folderPath.split('/').length - 1,
    count,
  }));
  const noteItems = notes.map((note) => ({
    id: `note:${note.path}`,
    kind: 'note',
    path: note.path,
    label: note.title,
    depth: Math.max(0, note.path.split('/').length - 1),
    updatedAt: note.updatedAt,
    bytes: note.bytes,
  }));
  return [...folderItems, ...noteItems].sort((a, b) => (
    a.path.localeCompare(b.path, 'ko') || (a.kind === 'folder' ? -1 : 1)
  ));
}

function buildWikiGraph(notes, edges) {
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const groups = [...new Set(notes.map((note) => note.path.split('/')[0] || 'root'))].sort((a, b) => a.localeCompare(b, 'ko'));
  const groupIndex = new Map(groups.map((group, index) => [group, index]));
  const offsets = new Map();
  const centerX = 480;
  const centerY = 310;
  const nodes = notes
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path, 'ko'))
    .map((note) => {
      const group = note.path.split('/')[0] || 'root';
      const index = offsets.get(group) || 0;
      offsets.set(group, index + 1);
      const baseAngle = ((groupIndex.get(group) || 0) / Math.max(groups.length, 1)) * Math.PI * 2;
      const angle = baseAngle + index * 2.399963229728653;
      const radius = 68 + Math.sqrt(index + 1) * 22;
      const linkCount = degree.get(note.path) || 0;
      return {
        id: note.path,
        path: note.path,
        label: note.title,
        group,
        x: Math.round(centerX + Math.cos(angle) * radius),
        y: Math.round(centerY + Math.sin(angle) * radius),
        r: Math.min(9, 3.5 + linkCount * 0.7),
        linkCount,
      };
    });
  return {
    nodes,
    edges: edges.map((edge) => ({ ...edge, id: `${edge.from}->${edge.to}` })),
    groups,
    viewBox: '0 0 960 620',
  };
}

function buildWikiIndex({ wikiRoot, selectedPath = '', query = '', now = new Date() } = {}) {
  const files = walkWikiFiles(wikiRoot);
  const markdownFiles = files.filter((file) => path.extname(file.relativePath).toLowerCase() === '.md');
  const totalAssets = files.filter((file) => WIKI_ASSET_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase())).length;
  const notes = markdownFiles.map((file) => {
    const stat = fs.statSync(file.absolutePath);
    const markdown = fs.readFileSync(file.absolutePath, 'utf8');
    const title = titleFromNote({ markdown, relativePath: file.relativePath });
    return {
      path: file.relativePath,
      title,
      folder: path.posix.dirname(file.relativePath) === '.' ? '' : path.posix.dirname(file.relativePath),
      updatedAt: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
      bytes: stat.size,
      excerpt: excerptFromMarkdown(markdown),
      content: markdown,
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path, 'ko'));
  const maps = buildNoteMaps(notes);
  const edgesById = new Map();
  const unresolvedLinks = [];
  for (const note of notes) {
    for (const target of extractLinkTargets(note.content)) {
      const resolved = resolveNoteLink({ rawTarget: target.raw, sourcePath: note.path, maps });
      if (!resolved) {
        const cleanTarget = cleanLinkTarget(target.raw);
        if (cleanTarget) unresolvedLinks.push({ from: note.path, target: cleanTarget, type: target.type });
        continue;
      }
      if (resolved === note.path) continue;
      const id = `${note.path}->${resolved}`;
      if (!edgesById.has(id)) edgesById.set(id, { from: note.path, to: resolved, type: target.type });
    }
  }
  const edges = [...edgesById.values()];
  const selected = maps.byPath.get(normalizeKey(selectedPath))
    || maps.byPathNoExt.get(normalizeKey(stripMarkdownExtension(selectedPath)))
    || notes[0]?.path
    || '';
  const selectedNoteBase = notes.find((note) => note.path === selected) || notes[0] || null;
  const selectedNote = selectedNoteBase ? {
    ...selectedNoteBase,
    content: selectedNoteBase.content,
    outgoingLinks: edges
      .filter((edge) => edge.from === selectedNoteBase.path)
      .map((edge) => {
        const note = notes.find((item) => item.path === edge.to);
        return { path: edge.to, title: note?.title || edge.to, type: edge.type };
      }),
  } : null;
  const backlinks = selectedNote ? edges
    .filter((edge) => edge.to === selectedNote.path)
    .map((edge) => {
      const note = notes.find((item) => item.path === edge.from);
      return { path: edge.from, title: note?.title || edge.from, type: edge.type };
    }) : [];
  const noteSummaries = notes.map(({ content, ...note }) => note);
  const needle = String(query || '').trim().toLowerCase();
  const searchResults = needle
    ? noteSummaries.filter((note) => [note.title, note.path, note.excerpt].some((value) => String(value || '').toLowerCase().includes(needle))).slice(0, 50)
    : [];
  return {
    vaultName: path.basename(wikiRoot),
    wikiRoot,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    totalNotes: notes.length,
    totalAssets,
    topFolders: [...new Set(notes.map((note) => note.path.split('/')[0] || 'root'))].sort((a, b) => a.localeCompare(b, 'ko')),
    tree: buildWikiTree(noteSummaries),
    notes: noteSummaries,
    recent: noteSummaries.slice(0, 24),
    selectedNote,
    backlinks,
    unresolvedLinks: unresolvedLinks.slice(0, 200),
    searchResults,
    graph: buildWikiGraph(noteSummaries, edges),
  };
}

function resolveEditableWikiNotePath({ wikiRoot, notePath = '' } = {}) {
  const normalized = path.posix.normalize(toPosixPath(notePath).replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error('Invalid wiki note path');
  }
  if (path.extname(normalized).toLowerCase() !== '.md') {
    throw new Error('Only Markdown wiki notes can be edited');
  }
  const absolutePath = path.resolve(wikiRoot, normalized);
  const rootPath = path.resolve(wikiRoot);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('Wiki note path escapes the vault');
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error('Wiki note not found');
  }
  return {
    absolutePath,
    relativePath: normalized,
  };
}

function writeWikiNote({ wikiRoot, notePath = '', content = '', now = new Date() } = {}) {
  ensureWikiStructure(wikiRoot);
  const target = resolveEditableWikiNotePath({ wikiRoot, notePath });
  const text = String(content ?? '');
  fs.writeFileSync(target.absolutePath, text, 'utf8');
  const stat = fs.statSync(target.absolutePath);
  return {
    path: target.relativePath,
    absolutePath: target.absolutePath,
    bytes: stat.size,
    updatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

function formatList(items = []) {
  if (!items.length) return '- No runtime log yet';
  return items.map((item) => `- ${item}`).join('\n');
}

function formatMission(run) {
  if (!run.mission) return '';
  const successCriteria = formatList(run.successCriteria || []);
  const stopConditions = formatList(run.stopConditions || []);
  return `## Mission\n\n` +
    `- id: ${run.mission.id}\n` +
    `- label: ${run.mission.label}\n` +
    `- duration_hours: ${run.mission.durationHours}\n` +
    `- cadence: ${run.mission.cadence}\n` +
    `- wiki_write_back: ${run.mission.wikiWriteBack || run.wikiWriteBack || ''}\n\n` +
    `### Success Criteria\n\n${successCriteria}\n\n` +
    `### Stop Conditions\n\n${stopConditions}\n\n`;
}

function formatSourceDocument(run) {
  const document = run.sourceDocument || {};
  const documentId = run.documentId || document.id || '';
  const documentTitle = document.title || '';
  const documentPath = run.sourceDocumentPath || document.wikiPath || '';
  if (!documentId && !documentTitle && !documentPath) return '';
  return `## Source document\n\n` +
    `- id: ${documentId || 'unknown'}\n` +
    `- title: ${documentTitle || 'unknown'}\n` +
    `- path: ${documentPath || 'unknown'}\n\n`;
}

function writeAgentRun({ wikiRoot, run }) {
  ensureWikiStructure(wikiRoot);
  const date = dateStamp(run.createdAt || new Date());
  const relativePath = run.file || `5_conversation/agent-runs/${date}-${slugify(run.name || run.id, 'agent-run')}.md`;
  const absolutePath = path.join(wikiRoot, relativePath);
  ensureDir(path.dirname(absolutePath));

  const content = `---\n` +
    `type: agent-run\n` +
    `date: ${date}\n` +
    `status: ${run.status || 'running'}\n` +
    `source: ${run.source || 'web'}\n` +
    `agent: ${run.agent || 'Hermes'}\n` +
    `model: ${run.model || 'Recommended'}\n` +
    `no_approval: ${run.noApproval !== false}\n` +
    `---\n\n` +
    `# ${run.name || run.id}\n\n` +
    `## Goal\n\n${run.goal || 'No goal provided'}\n\n` +
    formatSourceDocument(run) +
    formatMission(run) +
    `## Runtime Logs\n\n${formatList(run.logs)}\n\n` +
    `## Resume\n\n` +
    `- Continue from this run file before starting related work.\n` +
    `- Promote repeated successful steps to 6_agents/skills after reviewer pass.\n`;

  fs.writeFileSync(absolutePath, content, 'utf8');
  return { relativePath, absolutePath };
}

function writeDocumentAsset({ wikiRoot, filename, bytes, createdAt = new Date() }) {
  ensureWikiStructure(wikiRoot);
  const safeFilename = path.basename(String(filename || 'telegram-file.bin'));
  const relativePath = `1_raw/documents/assets/${dateStamp(createdAt)}-${slugify(safeFilename, 'telegram-file')}${path.extname(safeFilename) || ''}`;
  const absolutePath = path.join(wikiRoot, relativePath);
  ensureDir(path.dirname(absolutePath));
  fs.writeFileSync(absolutePath, bytes);
  return { relativePath, absolutePath };
}

function writeDocumentIngest({ wikiRoot, document }) {
  ensureWikiStructure(wikiRoot);
  const relativePath = document.wikiPath || `1_raw/documents/${dateStamp(document.createdAt || new Date())}-${slugify(document.title, 'document')}.md`;
  const absolutePath = path.join(wikiRoot, relativePath);
  ensureDir(path.dirname(absolutePath));
  const tags = Array.isArray(document.tags) ? document.tags.join(', ') : '';
  const content = `---\n` +
    `type: source-document\n` +
    `date: ${dateStamp(document.createdAt || new Date())}\n` +
    `status: ${document.ocrStatus || 'pending'}\n` +
    `source: hermes-documents\n` +
    `filename: ${document.filename || ''}\n` +
    `mime_type: ${document.mimeType || ''}\n` +
    `source_label: ${document.sourceLabel || document.source || ''}\n` +
    `original_file: ${document.originalFilePath || ''}\n` +
    `---\n\n` +
    `# ${document.title || document.filename || 'Untitled document'}\n\n` +
    `## Source\n\n` +
    `- filename: ${document.filename || ''}\n` +
    `- mime_type: ${document.mimeType || ''}\n` +
    `- bytes: ${document.size || 0}\n` +
    `- origin: ${document.sourceLabel || document.source || 'unknown'}\n` +
    `- original_file: ${document.originalFilePath || 'not stored'}\n` +
    `- tags: ${tags || 'none'}\n\n` +
    `## Extracted Text\n\n${document.extractedText || '_No extracted text yet._'}\n\n` +
    `## Agent Actions\n\n` +
    `- Ask an agent to analyze this document from Hermes OS.\n` +
    `- Save experiment plans and conclusions as linked agent-run files.\n`;
  fs.writeFileSync(absolutePath, content, 'utf8');
  return { relativePath, absolutePath };
}

function writeSkillDocument({ wikiRoot, candidate }) {
  ensureWikiStructure(wikiRoot);
  const relativePath = `6_agents/skills/${slugify(candidate.name, 'skill')}.md`;
  const absolutePath = path.join(wikiRoot, relativePath);
  ensureDir(path.dirname(absolutePath));

  const content = `---\n` +
    `type: agent-skill\n` +
    `name: ${candidate.name}\n` +
    `score: ${candidate.score}\n` +
    `status: promoted\n` +
    `---\n\n` +
    `# ${candidate.name}\n\n` +
    `## Evidence\n\n${candidate.evidence}\n\n` +
    `## Usage Rule\n\n` +
    `Use this skill when a future Hermes run matches the same task pattern and has compatible inputs.\n\n` +
    `## Reviewer Gate\n\n` +
    `A reviewer agent must confirm the output before this skill changes long-term wiki knowledge.\n`;

  fs.writeFileSync(absolutePath, content, 'utf8');
  return relativePath;
}

function writeContextBrief({ wikiRoot, brief }) {
  ensureWikiStructure(wikiRoot);
  const generatedAt = brief.generatedAt || new Date().toISOString();
  const date = dateStamp(generatedAt);
  const time = new Date(generatedAt).toISOString().slice(11, 19).replace(/:/g, '');
  const relativePath = `5_conversation/handovers/${date}-hermes-os-resume-brief-${time}.md`;
  const absolutePath = path.join(wikiRoot, relativePath);
  ensureDir(path.dirname(absolutePath));
  const content = `---\n` +
    `type: handover\n` +
    `date: ${date}\n` +
    `source: hermes-os\n` +
    `status: current\n` +
    `---\n\n` +
    `${brief.markdown || '# Hermes OS Resume Brief'}\n`;
  fs.writeFileSync(absolutePath, content, 'utf8');
  return { relativePath, absolutePath };
}

function writeVisualBrief({ wikiRoot, brief, generatedAt = new Date().toISOString() }) {
  ensureWikiStructure(wikiRoot);
  const date = dateStamp(generatedAt);
  const slug = slugify(brief.slug || brief.title || 'visual-brief', 'visual-brief');
  const baseName = `${date}-${slug}`;
  const relativeDir = '3_output/visual-briefs';
  const svgPath = `${relativeDir}/${baseName}.svg`;
  const markdownPath = `${relativeDir}/${baseName}.md`;
  const absoluteSvgPath = path.join(wikiRoot, svgPath);
  const absoluteMarkdownPath = path.join(wikiRoot, markdownPath);
  ensureDir(path.dirname(absoluteSvgPath));

  fs.writeFileSync(absoluteSvgPath, brief.svg || '', 'utf8');
  const content = `---\n` +
    `type: visual-brief\n` +
    `date: ${date}\n` +
    `status: ${brief.status || 'unknown'}\n` +
    `source: hermes-os\n` +
    `---\n\n` +
    `# ${brief.title || 'Hermes Visual Brief'}\n\n` +
    `![[${path.basename(svgPath)}]]\n\n` +
    `${brief.markdown || ''}\n`;
  fs.writeFileSync(absoluteMarkdownPath, content, 'utf8');
  return {
    svgPath,
    markdownPath,
    absoluteSvgPath,
    absoluteMarkdownPath,
  };
}

function labelFromHandoverFilename(filename) {
  const base = filename.replace(/\.md$/i, '');
  const match = base.match(/^(\d{4}-\d{2}-\d{2})-(.*)$/);
  if (!match) return base.replace(/-/g, ' ');
  return `${match[1]} ${match[2].replace(/-/g, ' ')}`;
}

function listContextHandovers({ wikiRoot, limit = 10 } = {}) {
  ensureWikiStructure(wikiRoot);
  const handoverDir = path.join(wikiRoot, '5_conversation', 'handovers');
  const items = fs.readdirSync(handoverDir)
    .filter((filename) => /^\d{4}-\d{2}-\d{2}-hermes-os-resume-brief-.*\.md$/.test(filename))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Number(limit) || 10))
    .map((filename) => {
      const absolutePath = path.join(handoverDir, filename);
      const stat = fs.statSync(absolutePath);
      return {
        file: `5_conversation/handovers/${filename}`,
        label: labelFromHandoverFilename(filename),
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      };
    });
  return { items };
}

function appendWikiLog({ wikiRoot, date = dateStamp(), intent, message }) {
  ensureWikiStructure(wikiRoot);
  fs.appendFileSync(path.join(wikiRoot, 'log.md'), `| ${date} | ${intent} | ${message} |\n`, 'utf8');
}

module.exports = {
  appendWikiLog,
  buildWikiIndex,
  dateStamp,
  ensureWikiStructure,
  listContextHandovers,
  slugify,
  writeAgentRun,
  writeContextBrief,
  writeDocumentAsset,
  writeDocumentIngest,
  writeWikiNote,
  writeSkillDocument,
  writeVisualBrief,
};
