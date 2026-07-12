import crypto from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WikiChunk } from './wikiTypes.js';

const IGNORED_DIRS = new Set(['.git', '.obsidian', 'attachments', 'images', 'assets', 'node_modules']);

export type WikiNote = {
  readonly id: string;
  readonly path: string;
  readonly wikiPath: string;
  readonly folder: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly excerpt: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
};

export type WikiVaultIndex = {
  readonly chunks: WikiChunk[];
  readonly notes: WikiNote[];
};

function chunkId(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function parseFrontmatter(raw: string) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const meta: Record<string, unknown> = {};
  if (!match) return { meta, body: raw };

  match[1].split('\n').forEach((line) => {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) return;
    const value = pair[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[pair[1]] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      return;
    }
    meta[pair[1]] = value.replace(/^['"]|['"]$/g, '');
  });

  return { meta, body: raw.slice(match[0].length) };
}

function titleFor(filePath: string, meta: Record<string, unknown>, lines: string[]) {
  const h1 = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim();
  return String(meta.title || h1 || path.basename(filePath, '.md'));
}

function tagsFor(meta: Record<string, unknown>) {
  return Array.isArray(meta.tags) ? meta.tags.map(String) : [];
}

async function markdownFiles(root: string, dir = ''): Promise<string[]> {
  const absolute = path.join(root, dir);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...await markdownFiles(root, path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(dir, entry.name));
  }

  return files;
}

export async function scanWikiVaultIndex(root: string): Promise<WikiVaultIndex> {
  const files = await markdownFiles(root);
  const chunks: WikiChunk[] = [];
  const notes: WikiNote[] = [];

  for (const relativePath of files.sort()) {
    const absolutePath = path.join(root, relativePath);
    const fileStat = await stat(absolutePath);
    const raw = await readFile(absolutePath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const lines = body.split(/\r?\n/);
    const title = titleFor(relativePath, meta, lines);
    const folder = relativePath.split(path.sep)[0] || '';
    const tags = tagsFor(meta);
    const updatedAt = String(meta.updatedAt || meta.updated || meta.date || fileStat.mtime.toISOString());
    const wikiPath = relativePath.split(path.sep).join('/');
    notes.push({
      id: wikiPath,
      path: wikiPath,
      wikiPath,
      folder,
      kind: folder,
      title,
      body,
      excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 240),
      tags,
      updatedAt,
    });
    const stack: Array<{ level: number; heading: string }> = [{ level: 1, heading: title }];
    let current = { heading: title, lineStart: 1, lines: [] as string[], path: [title] };

    const pushChunk = (lineEnd: number) => {
      const text = current.lines.join('\n').trim();
      if (!text) return;
      chunks.push({
        id: chunkId(`${relativePath}#${current.path.join('/')}:${current.lineStart}`),
        path: wikiPath,
        folder,
        title,
        heading: current.heading,
        headingPath: current.path,
        text,
        lineStart: current.lineStart,
        lineEnd,
        tags,
        updatedAt,
      });
    };

    lines.forEach((line, index) => {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (!heading) {
        current.lines.push(line);
        return;
      }

      pushChunk(index);
      const level = heading[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, heading: heading[2].trim() });
      current = {
        heading: heading[2].trim(),
        lineStart: index + 1,
        lines: [],
        path: stack.map((entry) => entry.heading),
      };
    });
    pushChunk(lines.length);
  }

  return { chunks, notes };
}

export async function scanWikiVault(root: string): Promise<WikiChunk[]> {
  return (await scanWikiVaultIndex(root)).chunks;
}
