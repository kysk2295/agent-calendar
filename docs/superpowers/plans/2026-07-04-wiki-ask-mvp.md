# Wiki Ask MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MVP Ask Wiki flow that searches the local LLM-Wiki markdown vault, sends the retrieved evidence to the existing Hermes OpenAI-compatible API, and returns a natural Korean answer with citations in the current desktop app.

**Architecture:** Keep the existing Electron + React/Vite app. Extend the Electron API proxy so `/api/wiki/ask` and `/api/wiki/search` can be handled locally, while all other `/api/*` routes continue to proxy to Railway. The local path scans markdown, builds heading-aware chunks, ranks them with dependency-free BM25-style scoring, then calls Hermes `/chat/completions`.

**Tech Stack:** Electron main process TypeScript, Node.js `fs/promises`, existing React UI, `node:test`, OpenAI-compatible Hermes API at `HERMES_API_BASE` with key from `HERMES_API_KEY` or `API_SERVER_KEY`.

---

## File Structure

- Create `electron/wikiTypes.ts`: shared `WikiChunk`, search request/result, ask response, and config types.
- Create `electron/wikiScanner.ts`: vault path resolution, markdown file discovery, frontmatter parsing, heading-aware chunking.
- Create `electron/wikiSearch.ts`: in-memory cached index, scope filtering, BM25-style scoring, per-file diversity.
- Create `electron/hermesChat.ts`: OpenAI-compatible `/chat/completions` client for Hermes answer generation.
- Create `electron/localWikiAsk.ts`: local `/api/wiki/search`, `/api/search`, `/api/wiki/ask`, and `/api/ask` handlers.
- Modify `electron/proxy.ts`: intercept local wiki routes before forwarding other API requests.
- Modify `src/App.tsx`: expose journal/raw toggles in Wiki UI and display fallback/engine status when returned.
- Modify `src/api/hermesApi.ts`: add `searchWiki` helper if UI uses a visible related-documents panel.
- Create `tests/wiki-scanner.test.mjs`: scanner and chunking contract.
- Create `tests/wiki-search.test.mjs`: scope filtering, ranking, diversity.
- Create `tests/wiki-local-ask.test.mjs`: proxy-level `/api/wiki/ask` test with fake Hermes fetch.
- Update `tests/railway-data-contract.test.mjs`: assert Ask Wiki can use local search + Hermes and does not require mock client answers.

## Configuration

Use these environment variables:

```bash
LLM_WIKI_VAULT="/Users/koyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki"
HERMES_API_BASE="http://127.0.0.1:8642/v1"
HERMES_API_KEY="..."
API_SERVER_KEY="..."
WIKI_ASK_LOCAL="1"
```

Default folder scope:

```ts
const DEFAULT_FOLDERS = ['2_wiki', '3_output', '5_conversation', '6_agents', '7_automation'];
```

`4_journal` is included only when `includeJournal: true`. `1_raw` is included only when `includeRaw: true`. `0_inbox` is excluded unless explicitly passed in `folders`.

---

### Task 1: Markdown Scanner

**Files:**
- Create: `electron/wikiTypes.ts`
- Create: `electron/wikiScanner.ts`
- Test: `tests/wiki-scanner.test.mjs`

- [ ] **Step 1: Write the failing scanner test**

Create `tests/wiki-scanner.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanWikiVault } from '../dist-electron/wikiScanner.js';

test('scanner creates heading-aware chunks and skips ignored files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await mkdir(path.join(root, '.obsidian'), { recursive: true });
    await writeFile(path.join(root, '.obsidian', 'ignored.md'), '# Ignored');
    await writeFile(path.join(root, '2_wiki', 'Market Flow Sentinel.md'), [
      '---',
      'title: Market Flow Sentinel',
      'tags: [trading, risk]',
      'updatedAt: 2026-07-04',
      '---',
      '# Market Flow Sentinel',
      'Intro text.',
      '## 리스크 관리 원칙',
      '손실 한도를 먼저 정하고 포지션을 잡는다.',
      '## 반복 실수',
      '확신이 강할 때 손절을 늦춘다.',
    ].join('\n'));

    const chunks = await scanWikiVault(root);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((chunk) => chunk.folder), ['2_wiki', '2_wiki', '2_wiki']);
    assert.equal(chunks[0].title, 'Market Flow Sentinel');
    assert.equal(chunks[1].heading, '리스크 관리 원칙');
    assert.deepEqual(chunks[1].headingPath, ['Market Flow Sentinel', '리스크 관리 원칙']);
    assert.match(chunks[1].text, /손실 한도/);
    assert.deepEqual(chunks[1].tags, ['trading', 'risk']);
    assert.equal(chunks[1].updatedAt, '2026-07-04');
    assert.equal(chunks.every((chunk) => !chunk.path.includes('.obsidian')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run build:electron && node --test tests/wiki-scanner.test.mjs
```

Expected: FAIL because `dist-electron/wikiScanner.js` does not exist.

- [ ] **Step 3: Add scanner types**

Create `electron/wikiTypes.ts`:

```ts
export type WikiChunk = {
  id: string;
  path: string;
  folder: string;
  title: string;
  heading: string;
  headingPath: string[];
  text: string;
  lineStart?: number;
  lineEnd?: number;
  tags?: string[];
  updatedAt?: string;
};

export type WikiSearchRequest = {
  query: string;
  limit?: number;
  includeJournal?: boolean;
  includeRaw?: boolean;
  folders?: string[];
};

export type WikiSearchResult = WikiChunk & {
  score: number;
  snippet: string;
};

export type WikiAskRequest = WikiSearchRequest & {
  question?: string;
  mode?: 'smart' | 'search';
};

export type WikiAskResponse = {
  ok: boolean;
  answer: string;
  sources: Array<Pick<WikiSearchResult, 'id' | 'path' | 'title' | 'heading' | 'snippet' | 'score'>>;
  search: {
    query: string;
    results: WikiSearchResult[];
  };
  engine: {
    provider: 'hermes';
    baseUrl: string;
    model?: string;
  };
  gatewayFallback: boolean;
};
```

- [ ] **Step 4: Implement scanner**

Create `electron/wikiScanner.ts`:

```ts
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WikiChunk } from './wikiTypes.js';

const IGNORED_DIRS = new Set(['.git', '.obsidian', 'attachments', 'images', 'assets', 'node_modules']);

function slugId(value: string) {
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
      meta[pair[1]] = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      meta[pair[1]] = value.replace(/^['"]|['"]$/g, '');
    }
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
    if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...await markdownFiles(root, path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(dir, entry.name));
  }
  return files;
}

export async function scanWikiVault(root: string): Promise<WikiChunk[]> {
  const files = await markdownFiles(root);
  const chunks: WikiChunk[] = [];
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
    const stack: Array<{ level: number; heading: string }> = [{ level: 1, heading: title }];
    let current = { heading: title, lineStart: 1, lines: [] as string[], path: [title] };

    const pushChunk = (lineEnd: number) => {
      const text = current.lines.join('\n').trim();
      if (!text) return;
      chunks.push({
        id: slugId(`${relativePath}#${current.path.join('/')}:${current.lineStart}`),
        path: relativePath.split(path.sep).join('/'),
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
      if (heading) {
        pushChunk(index);
        const level = heading[1].length;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, heading: heading[2].trim() });
        current = { heading: heading[2].trim(), lineStart: index + 1, lines: [], path: stack.map((entry) => entry.heading) };
      } else {
        current.lines.push(line);
      }
    });
    pushChunk(lines.length);
  }
  return chunks;
}
```

- [ ] **Step 5: Verify scanner passes**

Run:

```bash
npm run build:electron && node --test tests/wiki-scanner.test.mjs
```

Expected: PASS.

---

### Task 2: Search Index

**Files:**
- Create: `electron/wikiSearch.ts`
- Test: `tests/wiki-search.test.mjs`

- [ ] **Step 1: Write the failing search test**

Create `tests/wiki-search.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchWikiChunks } from '../dist-electron/wikiSearch.js';

const chunks = [
  { id: 'a1', path: '2_wiki/Market.md', folder: '2_wiki', title: 'Market', heading: '리스크 관리', headingPath: ['Market', '리스크 관리'], text: '투자에서 반복하는 실수는 손절을 늦추고 리스크 한도를 넘기는 것이다.' },
  { id: 'a2', path: '2_wiki/Market.md', folder: '2_wiki', title: 'Market', heading: '포지션', headingPath: ['Market', '포지션'], text: '포지션 크기는 변동성에 맞춘다.' },
  { id: 'b1', path: '4_journal/2026-07-04.md', folder: '4_journal', title: '일기', heading: '투자 감정', headingPath: ['일기', '투자 감정'], text: '오늘도 조급함 때문에 투자 결정을 서둘렀다.' },
  { id: 'c1', path: '1_raw/raw.md', folder: '1_raw', title: 'Raw', heading: 'Raw', headingPath: ['Raw'], text: '원본 로그 투자 실수' },
];

test('search ranks matching chunks and excludes journal/raw by default', () => {
  const results = searchWikiChunks(chunks, { query: '투자 반복 실수 리스크', limit: 8 });
  assert.equal(results[0].id, 'a1');
  assert.equal(results.some((result) => result.folder === '4_journal'), false);
  assert.equal(results.some((result) => result.folder === '1_raw'), false);
  assert.match(results[0].snippet, /투자/);
});

test('search includes journal and raw only when requested', () => {
  const results = searchWikiChunks(chunks, { query: '투자 실수 조급함 원본', limit: 8, includeJournal: true, includeRaw: true });
  assert.equal(results.some((result) => result.folder === '4_journal'), true);
  assert.equal(results.some((result) => result.folder === '1_raw'), true);
});
```

- [ ] **Step 2: Run the failing search test**

Run:

```bash
npm run build:electron && node --test tests/wiki-search.test.mjs
```

Expected: FAIL because `wikiSearch.js` does not exist.

- [ ] **Step 3: Implement dependency-free search**

Create `electron/wikiSearch.ts`:

```ts
import type { WikiChunk, WikiSearchRequest, WikiSearchResult } from './wikiTypes.js';

const DEFAULT_FOLDERS = ['2_wiki', '3_output', '5_conversation', '6_agents', '7_automation'];

function tokenize(value: string) {
  return value.toLowerCase().match(/[a-z0-9가-힣]+/g) || [];
}

function allowedFolders(request: WikiSearchRequest) {
  const folders = new Set(request.folders?.length ? request.folders : DEFAULT_FOLDERS);
  if (request.includeJournal) folders.add('4_journal');
  if (request.includeRaw) folders.add('1_raw');
  return folders;
}

function snippetFor(text: string, tokens: string[]) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const index = tokens.map((token) => lower.indexOf(token)).filter((pos) => pos >= 0).sort((a, b) => a - b)[0] || 0;
  return normalized.slice(Math.max(0, index - 60), index + 180);
}

export function searchWikiChunks(chunks: WikiChunk[], request: WikiSearchRequest): WikiSearchResult[] {
  const query = String(request.query || '').trim();
  if (!query) return [];
  const tokens = tokenize(query);
  const folders = allowedFolders(request);
  const docs = chunks.filter((chunk) => folders.has(chunk.folder));
  const docFreq = new Map<string, number>();
  docs.forEach((chunk) => {
    const unique = new Set(tokenize(`${chunk.title} ${chunk.heading} ${chunk.text}`));
    unique.forEach((token) => docFreq.set(token, (docFreq.get(token) || 0) + 1));
  });
  const scored = docs.map((chunk) => {
    const haystack = `${chunk.title} ${chunk.heading} ${chunk.headingPath.join(' ')} ${chunk.text}`;
    const docTokens = tokenize(haystack);
    const lengthNorm = Math.max(1, Math.sqrt(docTokens.length));
    const score = tokens.reduce((sum, token) => {
      const tf = docTokens.filter((item) => item === token).length;
      if (!tf) return sum;
      const idf = Math.log(1 + docs.length / (1 + (docFreq.get(token) || 0)));
      const headingBoost = tokenize(`${chunk.title} ${chunk.heading}`).includes(token) ? 1.7 : 1;
      return sum + (tf * idf * headingBoost) / lengthNorm;
    }, 0);
    return { ...chunk, score, snippet: snippetFor(chunk.text, tokens) };
  }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score);

  const perFile = new Map<string, number>();
  const diversified: WikiSearchResult[] = [];
  for (const result of scored) {
    const count = perFile.get(result.path) || 0;
    if (count >= 2) continue;
    perFile.set(result.path, count + 1);
    diversified.push(result);
    if (diversified.length >= (request.limit || 8)) break;
  }
  return diversified;
}
```

- [ ] **Step 4: Verify search passes**

Run:

```bash
npm run build:electron && node --test tests/wiki-search.test.mjs
```

Expected: PASS.

---

### Task 3: Hermes Chat Client

**Files:**
- Create: `electron/hermesChat.ts`
- Test: `tests/wiki-local-ask.test.mjs`

- [ ] **Step 1: Write the failing Hermes client test inside `tests/wiki-local-ask.test.mjs`**

Create `tests/wiki-local-ask.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askHermesWithSources } from '../dist-electron/hermesChat.js';

test('Hermes chat client sends OpenAI-compatible chat completion request', async () => {
  const calls = [];
  const answer = await askHermesWithSources({
    baseUrl: 'http://127.0.0.1:8642/v1',
    apiKey: 'secret',
    model: 'hermes',
    question: '투자에서 반복하는 실수는?',
    sources: [{ id: 'a1', path: '2_wiki/Market.md', title: 'Market', heading: '리스크', headingPath: ['Market', '리스크'], text: '손절을 늦춘다.', score: 1, snippet: '손절을 늦춘다.', folder: '2_wiki' }],
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: '기록을 보면 손절을 늦추는 패턴이 반복돼요.' } }], model: 'hermes-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(answer.answer, '기록을 보면 손절을 늦추는 패턴이 반복돼요.');
  assert.equal(answer.model, 'hermes-test');
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[1].content, /SOURCES/);
  assert.match(calls[0].body.messages[1].content, /2_wiki\/Market.md/);
});
```

- [ ] **Step 2: Run the failing Hermes client test**

Run:

```bash
npm run build:electron && node --test tests/wiki-local-ask.test.mjs
```

Expected: FAIL because `hermesChat.js` does not exist.

- [ ] **Step 3: Implement Hermes chat client**

Create `electron/hermesChat.ts`:

```ts
import type { WikiSearchResult } from './wikiTypes.js';

const SYSTEM_PROMPT = `너는 Ko Yunseo의 LLM-Wiki 기반 QA 엔진이다.

규칙:
- 반드시 제공된 SOURCES 안의 근거를 우선 사용한다.
- 모르는 내용은 모른다고 말한다.
- 근거가 부족하면 "위키 근거 부족"이라고 표시한다.
- 답변은 한국어로 한다.
- 사용자가 감정적/개인적 질문을 하면 인간적이고 직접적으로 답한다.
- 답변은 GPT에게 물어본 것처럼 자연스럽고 연결감 있게 작성한다.
- sources에 없는 사실은 추측이라고 표시한다.`;

export async function askHermesWithSources(options: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  question: string;
  sources: WikiSearchResult[];
  fetchImpl?: typeof fetch;
}) {
  const baseUrl = options.baseUrl.replace(/\/+$/g, '');
  const sourceText = options.sources.map((source, index) => [
    `[${index + 1}] ${source.title} — ${source.heading}`,
    `path: ${source.path}`,
    `score: ${source.score.toFixed(4)}`,
    source.text,
  ].join('\n')).join('\n\n---\n\n');
  const body = {
    model: options.model || 'hermes',
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `QUESTION:\n${options.question}\n\nSOURCES:\n${sourceText}` },
    ],
  };
  const response = await (options.fetchImpl || fetch)(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: Record<string, any>;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  if (!response.ok) throw new Error(`Hermes chat ${response.status}: ${raw.slice(0, 500)}`);
  const answer = String(payload.choices?.[0]?.message?.content || payload.answer || payload.text || '').trim();
  if (!answer) throw new Error('Hermes chat returned an empty answer');
  return { answer, model: String(payload.model || body.model), raw: payload };
}
```

- [ ] **Step 4: Verify Hermes client passes**

Run:

```bash
npm run build:electron && node --test tests/wiki-local-ask.test.mjs
```

Expected: PASS.

---

### Task 4: Local Wiki Ask HTTP Handler

**Files:**
- Create: `electron/localWikiAsk.ts`
- Modify: `electron/proxy.ts`
- Test: `tests/wiki-local-ask.test.mjs`

- [ ] **Step 1: Extend the failing proxy test**

Append to `tests/wiki-local-ask.test.mjs`:

```js
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiProxyServer } from '../dist-electron/proxy.js';

async function withProxy(fetchImpl, env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const server = createApiProxyServer({
    fetchImpl,
    getSettings: () => ({ apiBaseUrl: 'https://railway.example', apiToken: '' }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('proxy handles /api/wiki/ask locally with vault search and Hermes answer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-vault-'));
  try {
    await mkdir(path.join(root, '2_wiki'), { recursive: true });
    await writeFile(path.join(root, '2_wiki', 'Market.md'), '# Market\n\n## 리스크\n투자에서 반복하는 실수는 손절을 늦추는 것이다.');
    const hermesCalls = [];
    await withProxy(async (url, init) => {
      hermesCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ model: 'hermes-test', choices: [{ message: { content: '기록을 보면 손절을 늦추는 패턴이 반복돼요.' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, {
      WIKI_ASK_LOCAL: '1',
      LLM_WIKI_VAULT: root,
      HERMES_API_BASE: 'http://127.0.0.1:8642/v1',
      HERMES_API_KEY: 'secret',
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/wiki/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '투자에서 반복하는 실수는?', limit: 8 }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.gatewayFallback, false);
      assert.equal(payload.engine.provider, 'hermes');
      assert.match(payload.answer, /손절/);
      assert.equal(payload.sources[0].path, '2_wiki/Market.md');
    });
    assert.equal(hermesCalls.length, 1);
    assert.match(hermesCalls[0].body.messages[1].content, /투자에서 반복하는 실수/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing local ask test**

Run:

```bash
npm run build:electron && node --test tests/wiki-local-ask.test.mjs
```

Expected: FAIL because proxy forwards `/api/wiki/ask` instead of handling it locally.

- [ ] **Step 3: Implement local wiki handler**

Create `electron/localWikiAsk.ts`:

```ts
import { homedir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scanWikiVault } from './wikiScanner.js';
import { searchWikiChunks } from './wikiSearch.js';
import { askHermesWithSources } from './hermesChat.js';
import type { WikiAskRequest } from './wikiTypes.js';

const DEFAULT_VAULT = path.join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'LLM-Wiki');
let cache: { root: string; loadedAt: number; chunks: Awaited<ReturnType<typeof scanWikiVault>> } | null = null;

async function bodyJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function chunksForVault(root: string) {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.loadedAt < 30_000) return cache.chunks;
  const chunks = await scanWikiVault(root);
  cache = { root, loadedAt: now, chunks };
  return chunks;
}

export function isLocalWikiRoute(method = 'GET', requestUrl = '') {
  const pathName = new URL(requestUrl, 'http://127.0.0.1').pathname;
  return method.toUpperCase() === 'POST' && ['/api/wiki/search', '/api/search', '/api/wiki/ask', '/api/ask'].includes(pathName);
}

export async function handleLocalWikiRoute(req: IncomingMessage, res: ServerResponse, fetchImpl?: typeof fetch) {
  const pathName = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const request = await bodyJson(req) as WikiAskRequest;
  const query = String(request.query || request.question || '').trim();
  if (!query) {
    sendJson(res, 400, { ok: false, error: 'query or question is required' });
    return;
  }

  const root = process.env.LLM_WIKI_VAULT || DEFAULT_VAULT;
  const chunks = await chunksForVault(root);
  const results = searchWikiChunks(chunks, { ...request, query, limit: request.limit || 8 });

  if (pathName === '/api/wiki/search' || pathName === '/api/search') {
    sendJson(res, 200, { ok: true, query, results });
    return;
  }

  try {
    const baseUrl = process.env.HERMES_API_BASE || 'http://127.0.0.1:8642/v1';
    const apiKey = process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
    const hermes = await askHermesWithSources({
      baseUrl,
      apiKey,
      model: process.env.HERMES_MODEL || 'hermes',
      question: query,
      sources: results,
      fetchImpl,
    });
    sendJson(res, 200, {
      ok: true,
      answer: hermes.answer,
      sources: results.map(({ id, path, title, heading, snippet, score }) => ({ id, path, title, heading, snippet, score })),
      search: { query, results },
      engine: { provider: 'hermes', baseUrl, model: hermes.model },
      gatewayFallback: false,
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: true,
      answer: `검색 결과 기반 임시 답변입니다. Hermes 답변 생성에 실패했습니다: ${error instanceof Error ? error.message : 'unknown error'}`,
      sources: results.map(({ id, path, title, heading, snippet, score }) => ({ id, path, title, heading, snippet, score })),
      search: { query, results },
      engine: { provider: 'hermes', baseUrl: process.env.HERMES_API_BASE || 'http://127.0.0.1:8642/v1' },
      gatewayFallback: true,
    });
  }
}
```

- [ ] **Step 4: Intercept local wiki routes in proxy**

Modify `electron/proxy.ts`:

```ts
import { handleLocalWikiRoute, isLocalWikiRoute } from './localWikiAsk.js';
```

Inside `handleProxyRequest`, after the `/api/` 404 guard and before `const settings = options.getSettings();`, add:

```ts
  if (process.env.WIKI_ASK_LOCAL === '1' && isLocalWikiRoute(req.method, req.url)) {
    await handleLocalWikiRoute(req, res, options.fetchImpl);
    return;
  }
```

- [ ] **Step 5: Verify local ask passes**

Run:

```bash
npm run build:electron && node --test tests/wiki-local-ask.test.mjs
```

Expected: PASS.

---

### Task 5: Wiki UI Toggles and Answer Metadata

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/api/hermesApi.ts`
- Test: `tests/playwright-wiki-graph-ask.cjs`

- [ ] **Step 1: Update failing Playwright expectation**

In `tests/playwright-wiki-graph-ask.cjs`, make `/api/wiki/ask` return:

```js
await route.fulfill({ json: {
  ok: true,
  answer: `기록을 보면 ${body.question}는 UniPort 전략 문서와 연결됩니다.`,
  sources: [{ path: '2_wiki/uniport.md', title: 'UniPort 전략', heading: '개요', snippet: 'UniPort는 대학생 프로젝트를 운영하는 지식입니다.' }],
  engine: { provider: 'hermes', model: 'hermes-test' },
  gatewayFallback: false,
} });
```

Add assertions:

```js
assert.equal(calls.find((call) => call.path === '/api/wiki/ask')?.body.includeJournal, false);
assert.equal(calls.find((call) => call.path === '/api/wiki/ask')?.body.includeRaw, false);
assert.match(answer || '', /hermes-test|Hermes|UniPort 전략/);
```

- [ ] **Step 2: Run the failing UI test**

Run:

```bash
npm run dev
HERMES_UI_URL=http://127.0.0.1:5174/ node tests/playwright-wiki-graph-ask.cjs
```

Expected: FAIL because UI does not send `includeJournal` and `includeRaw` yet.

- [ ] **Step 3: Add UI state and request fields**

Modify `src/App.tsx` near existing wiki state:

```ts
const [wikiIncludeJournal, setWikiIncludeJournal] = useState(false);
const [wikiIncludeRaw, setWikiIncludeRaw] = useState(false);
```

Modify `askWiki()` payload:

```ts
const payload = await hermesApi.askWiki({
  question,
  path: activeWikiId,
  limit: 8,
  mode: 'wiki_qa',
  includeJournal: wikiIncludeJournal,
  includeRaw: wikiIncludeRaw,
});
```

Pass these to `WikiScreen`:

```tsx
includeJournal={wikiIncludeJournal}
setIncludeJournal={setWikiIncludeJournal}
includeRaw={wikiIncludeRaw}
setIncludeRaw={setWikiIncludeRaw}
```

- [ ] **Step 4: Add toggle controls to WikiScreen**

Extend `WikiScreen` props and add controls near `.wiki-suggest`:

```tsx
<div className="wiki-scope">
  <label><input type="checkbox" checked={includeJournal} onChange={(event) => setIncludeJournal(event.target.checked)} /> 일기 포함</label>
  <label><input type="checkbox" checked={includeRaw} onChange={(event) => setIncludeRaw(event.target.checked)} /> raw 포함</label>
</div>
```

When rendering answer, include engine/fallback text only if present in answer metadata. If metadata is not currently stored, add:

```ts
const [wikiAnswerMeta, setWikiAnswerMeta] = useState<Item>({});
```

And in `askWiki()`:

```ts
setWikiAnswerMeta(obj(payload, 'engine'));
```

- [ ] **Step 5: Verify UI test passes**

Run:

```bash
HERMES_UI_URL=http://127.0.0.1:5174/ node tests/playwright-wiki-graph-ask.cjs
npm run typecheck
```

Expected: PASS.

---

### Task 6: Live Verification Script

**Files:**
- Modify: `tests/wiki-ask-live-llm.cjs`

- [ ] **Step 1: Update live test target**

Modify `tests/wiki-ask-live-llm.cjs` so it can test either the app proxy or Hermes directly:

```js
const endpoint = process.env.WIKI_ASK_ENDPOINT || 'http://127.0.0.1:8642/api/wiki/ask';
```

Send:

```js
{
  question,
  limit: 8,
  includeJournal: process.env.INCLUDE_JOURNAL === '1',
  includeRaw: process.env.INCLUDE_RAW === '1',
  mode: 'smart'
}
```

Keep these assertions:

```js
assert.equal(payload.gatewayFallback, false);
assert.ok(payload.engine?.provider || payload.llm?.provider);
assert.ok(sources.length > 0);
```

- [ ] **Step 2: Verify against local Electron proxy**

Run Electron/dev with:

```bash
WIKI_ASK_LOCAL=1 \
LLM_WIKI_VAULT="/Users/koyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki" \
HERMES_API_BASE="http://127.0.0.1:8642/v1" \
HERMES_API_KEY="$HERMES_API_KEY" \
npm run electron:dev
```

Then run:

```bash
WIKI_ASK_ENDPOINT="http://127.0.0.1:<electron-proxy-port>/api/wiki/ask" node tests/wiki-ask-live-llm.cjs
```

Expected: PASS when Hermes API is running and has a valid key. FAIL with clear message when Hermes is unavailable.

---

## Final Verification

Run:

```bash
npm run build:electron
node --test tests/wiki-scanner.test.mjs tests/wiki-search.test.mjs tests/wiki-local-ask.test.mjs
npm run typecheck
HERMES_UI_URL=http://127.0.0.1:5174/ node tests/playwright-wiki-graph-ask.cjs
```

Manual smoke:

1. Start Hermes API server at `http://127.0.0.1:8642/v1`.
2. Start Electron with `WIKI_ASK_LOCAL=1`.
3. Open Wiki screen.
4. Ask: `내가 투자에서 반복하는 실수는 뭐야?`
5. Confirm answer is natural Korean, citations point to vault markdown, `gatewayFallback` is false.
6. Toggle `일기 포함`; ask about recent emotional pattern.
7. Confirm journal files appear only after the toggle is enabled.

## Commit Plan

Commit after each task:

```bash
git add electron/wikiTypes.ts electron/wikiScanner.ts tests/wiki-scanner.test.mjs
git commit -m "feat: scan llm wiki markdown chunks"

git add electron/wikiSearch.ts tests/wiki-search.test.mjs
git commit -m "feat: add local wiki search"

git add electron/hermesChat.ts tests/wiki-local-ask.test.mjs
git commit -m "feat: call hermes for wiki answers"

git add electron/localWikiAsk.ts electron/proxy.ts tests/wiki-local-ask.test.mjs
git commit -m "feat: serve local wiki ask through desktop proxy"

git add src/App.tsx src/api/hermesApi.ts tests/playwright-wiki-graph-ask.cjs
git commit -m "feat: add wiki ask scope controls"
```

## Risks

- Hermes API may return fallback-like text even when HTTP succeeds. The live test must require `gatewayFallback: false` or an engine/provider field.
- Apple iCloud path contains spaces. All path handling must use `path.join` and avoid shell interpolation in app code.
- Full vault scans may be slow. The MVP cache is 30 seconds; later work should add mtime-based incremental indexing or SQLite FTS5.
- Journal/raw privacy must stay opt-in.

