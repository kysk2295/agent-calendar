'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.csv', '.tsv', '.html', '.htm',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.yaml', '.yml', '.toml',
]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 20;

function safeHandle(sourceId, relativePath, stat) {
  return `rch_${crypto.createHash('sha256')
    .update(`${sourceId}\0${relativePath}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function excerptFor(content, query) {
  const normalized = content.toLocaleLowerCase('und');
  const needle = query.toLocaleLowerCase('und');
  const index = normalized.indexOf(needle);
  const start = Math.max(0, (index >= 0 ? index : 0) - 100);
  return content.slice(start, start + 280).replace(/\s+/g, ' ').trim();
}

function matches(content, query) {
  const haystack = content.toLocaleLowerCase('und');
  const tokens = query
    .toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}._-]{2,}/gu) || [];
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function sourceFiles(sourcePath) {
  const rootStat = fs.lstatSync(sourcePath);
  if (rootStat.isSymbolicLink()) return [];
  if (rootStat.isFile()) return [{ absolutePath: sourcePath, relativePath: path.basename(sourcePath), stat: rootStat }];
  if (!rootStat.isDirectory()) return [];
  const files = [];
  const stack = [{ absolutePath: sourcePath, relativePath: '' }];
  while (stack.length && files.length < MAX_FILES) {
    const current = stack.pop();
    const entries = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith('.')) continue;
      const absolutePath = path.join(current.absolutePath, entry.name);
      const relativePath = path.join(current.relativePath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ absolutePath, relativePath });
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push({ absolutePath, relativePath, stat: fs.statSync(absolutePath) });
      }
    }
  }
  return files;
}

async function run({
  jobPayload = {},
  knowledgeSources = [],
  signal,
  onCheckpoint = async () => {},
} = {}) {
  if (jobPayload.kind !== 'knowledge_search') {
    return {
      ok: false,
      errorCode: 'KNOWLEDGE_JOB_INVALID',
      errorMessage: 'knowledge engine accepts only knowledge_search jobs',
      retryable: false,
    };
  }
  const query = String(jobPayload.query || '').trim();
  const allowed = new Set(
    Array.isArray(jobPayload.sourceIds) ? jobPayload.sourceIds.map(String) : [],
  );
  if (!query || !allowed.size) {
    return {
      ok: false,
      errorCode: 'KNOWLEDGE_QUERY_INVALID',
      errorMessage: 'query and sourceIds are required',
      retryable: false,
    };
  }

  await onCheckpoint({ phase: 'progress', text: 'Searching authorized local knowledge' });
  const hits = [];
  for (const source of knowledgeSources) {
    if (signal?.aborted) {
      return { ok: false, errorCode: 'cancelled', errorMessage: 'cancelled', retryable: false };
    }
    const sourceId = String(source.sourceId || '');
    if (!allowed.has(sourceId)) continue;
    let files;
    try {
      files = sourceFiles(String(source.path || ''));
    } catch {
      continue;
    }
    for (const file of files) {
      if (hits.length >= MAX_RESULTS) break;
      if (file.stat.size > MAX_FILE_BYTES) continue;
      let content;
      try {
        content = fs.readFileSync(file.absolutePath, 'utf8');
      } catch {
        continue;
      }
      if (!matches(content, query)) continue;
      hits.push({
        sourceId,
        title: path.basename(file.relativePath),
        excerpt: excerptFor(content, query),
        runnerContentHandle: safeHandle(sourceId, file.relativePath, file.stat),
        chunkIndex: 0,
      });
    }
  }

  const evidence = { kind: 'knowledge_search_evidence', query, hits };
  return {
    ok: true,
    summary: JSON.stringify({ kind: 'knowledge_search_result', hitCount: hits.length, hits }),
    artifacts: [{
      name: 'knowledge-search-evidence',
      contentType: 'application/json',
      content: JSON.stringify(evidence),
    }],
  };
}

module.exports = {
  run,
};
