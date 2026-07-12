import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { askHermesWithSources, askRailwayWithSources } from './hermesChat.js';
import { buildLocalWikiGraph } from './localWikiGraph.js';
import { scanWikiVaultIndex } from './wikiScanner.js';
import { searchWikiChunks } from './wikiSearch.js';
import type { WikiAskRequest } from './wikiTypes.js';

export { buildLocalWikiGraph } from './localWikiGraph.js';

const DEFAULT_VAULT = path.join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'LLM-Wiki');
const DEFAULT_RAILWAY_BASE_URL = 'https://hermes-os-production-e174.up.railway.app';

export class LocalWikiPathError extends Error {
  readonly name = 'LocalWikiPathError';

  constructor(readonly notePath: string) {
    super(`Invalid wiki note path: ${notePath}`);
  }
}

let cache: {
  root: string;
  loadedAt: number;
  index: Awaited<ReturnType<typeof scanWikiVaultIndex>>;
} | null = null;

async function requestJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function rootFromEnv() {
  return process.env.LLM_WIKI_VAULT || DEFAULT_VAULT;
}

function isWithinRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function safeNotePath(root: string, notePath = '') {
  const rootPath = await realpath(root);
  const normalized = notePath.replace(/^\/+/g, '');
  const absolutePath = path.resolve(rootPath, normalized);
  if (!isWithinRoot(rootPath, absolutePath)) throw new LocalWikiPathError(notePath);
  const resolvedPath = await realpath(absolutePath);
  if (!isWithinRoot(rootPath, resolvedPath)) throw new LocalWikiPathError(notePath);
  return resolvedPath;
}

async function readWikiNote(root: string, notePath: string) {
  const absolutePath = await safeNotePath(root, notePath);
  const body = await readFile(absolutePath, 'utf8');
  return body;
}

async function localWikiIndex(root: string, requestUrl = '') {
  const url = new URL(requestUrl || '/api/wiki', 'http://127.0.0.1');
  const selectedPath = url.searchParams.get('path') || '';
  const query = (url.searchParams.get('query') || '').trim().toLowerCase();
  const index = await indexForVault(root);
  let notes = [...index.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (query) {
    notes = notes.filter((note) => `${note.path} ${note.title} ${note.body}`.toLowerCase().includes(query));
  }
  const selectedBase = selectedPath
    ? notes.find((note) => note.path === selectedPath) || {
      id: selectedPath,
      path: selectedPath,
      wikiPath: selectedPath,
      folder: selectedPath.split('/')[0] || '',
      kind: selectedPath.split('/')[0] || '',
      title: path.basename(selectedPath, '.md'),
      body: '',
      excerpt: '',
      tags: [],
      updatedAt: '',
    }
    : undefined;
  const selectedNote = selectedBase ? {
    ...selectedBase,
    body: selectedPath ? await readWikiNote(root, selectedPath) : selectedBase.body,
  } : null;
  const graph = buildLocalWikiGraph(notes);
  return {
    ok: true,
    source: 'local-wiki',
    wikiRoot: root,
    vaultName: path.basename(root),
    notes,
    selectedNote,
    graph,
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function fallbackAnswerFor(error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (/timeout|timed out|시간 초과/i.test(message)) {
    return `Hermes가 시간 내 자연어 답변을 생성하지 못했어요. 검색 근거는 확보됐지만, 답변 생성은 실패했습니다: ${message}`;
  }
  return `Hermes가 자연어 답변을 생성하지 못했어요. 검색 근거는 확보됐지만, 답변 생성은 실패했습니다: ${message}`;
}

async function chunksForVault(root: string) {
  return (await indexForVault(root)).chunks;
}

async function indexForVault(root: string) {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.loadedAt < 30_000) return cache.index;
  const index = await scanWikiVaultIndex(root);
  cache = { root, loadedAt: now, index };
  return index;
}

export function isLocalWikiRoute(method = 'GET', requestUrl = '') {
  const pathName = new URL(requestUrl, 'http://127.0.0.1').pathname;
  if (method.toUpperCase() === 'GET' && pathName === '/api/wiki') return true;
  return method.toUpperCase() === 'POST'
    && ['/api/wiki/search', '/api/search', '/api/wiki/ask', '/api/ask'].includes(pathName);
}

export async function handleLocalWikiRoute(req: IncomingMessage, res: ServerResponse, options: {
  fetchImpl?: typeof fetch;
  railwayBaseUrl?: string;
  railwayApiToken?: string;
} = {}) {
  const pathName = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const root = rootFromEnv();
  if (req.method?.toUpperCase() === 'GET' && pathName === '/api/wiki') {
    sendJson(res, 200, await localWikiIndex(root, req.url));
    return;
  }

  const request = await requestJson(req) as WikiAskRequest;
  const query = String(request.query || request.question || '').trim();
  if (!query) {
    sendJson(res, 400, { ok: false, error: 'query or question is required' });
    return;
  }

  const chunks = await chunksForVault(root);
  const results = searchWikiChunks(chunks, { ...request, query, limit: request.limit || 8 });

  if (pathName === '/api/wiki/search' || pathName === '/api/search') {
    sendJson(res, 200, { ok: true, query, results });
    return;
  }

  const baseUrl = process.env.HERMES_API_BASE || 'http://127.0.0.1:8642/v1';
  const apiKey = process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
  const agent = process.env.HERMES_WIKI_AGENT || process.env.HERMES_MODEL || 'wiki-curator';
  const railwayBaseUrl = process.env.HERMES_RAILWAY_BASE_URL || options.railwayBaseUrl || DEFAULT_RAILWAY_BASE_URL;
  const railwayApiToken = process.env.HERMES_RAILWAY_API_TOKEN || options.railwayApiToken || '';
  const directHermes = process.env.WIKI_ASK_DIRECT_HERMES === '1';

  try {
    const hermes = directHermes
      ? await askHermesWithSources({
        baseUrl,
        apiKey,
        agent,
        model: agent,
        question: query,
        sources: results,
        fetchImpl: options.fetchImpl,
      })
      : await askRailwayWithSources({
        baseUrl: railwayBaseUrl,
        apiToken: railwayApiToken,
        agent,
        model: agent,
        question: query,
        sources: results,
        fetchImpl: options.fetchImpl,
      });
    sendJson(res, 200, {
      ok: true,
      answer: hermes.answer,
      sources: results.map(({ id, path, title, heading, snippet, score }) => ({ id, path, title, heading, snippet, score })),
      search: { query, results },
      engine: {
        provider: directHermes ? 'hermes' : 'railway-hermes',
        baseUrl: directHermes ? baseUrl : railwayBaseUrl,
        model: hermes.model,
        agent: hermes.agent,
        source: 'source' in hermes ? hermes.source : undefined,
      },
      gatewayFallback: 'gatewayFallback' in hermes ? hermes.gatewayFallback : false,
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: true,
      answer: fallbackAnswerFor(error),
      sources: results.map(({ id, path, title, heading, snippet, score }) => ({ id, path, title, heading, snippet, score })),
      search: { query, results },
      engine: {
        provider: directHermes ? 'hermes' : 'railway-hermes',
        baseUrl: directHermes ? baseUrl : railwayBaseUrl,
        model: agent,
        agent,
      },
      gatewayFallback: true,
    });
  }
}
