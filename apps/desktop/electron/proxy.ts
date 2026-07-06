import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import { handleLocalWikiRoute, isLocalWikiRoute } from './localWikiAsk.js';
import { handleLocalScheduleAskRoute, isLocalScheduleAskRoute } from './scheduleAsk.js';

export type ProxySettings = {
  apiBaseUrl: string;
  apiToken?: string;
};

export type ProxyOptions = {
  getSettings: () => ProxySettings;
  fetchImpl?: typeof fetch;
};

function isHopByHopHeader(header: string) {
  return [
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ].includes(header.toLowerCase());
}

function requestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function copyHeaders(headers: Headers, res: ServerResponse) {
  headers.forEach((value, key) => {
    if (!isHopByHopHeader(key)) res.setHeader(key, value);
  });
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,accept');
}

function targetUrl(baseUrl: string, requestUrl = '/') {
  const base = new URL(baseUrl.replace(/\/+$/g, ''));
  const source = new URL(requestUrl, 'http://127.0.0.1');
  return new URL(`${source.pathname}${source.search}`, base).toString();
}

export async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
) {
  setCorsHeaders(res);
  if (String(req.method || '').toUpperCase() === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!req.url?.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  if (process.env.WIKI_ASK_LOCAL === '1' && isLocalWikiRoute(req.method, req.url)) {
    const settings = options.getSettings();
    await handleLocalWikiRoute(req, res, {
      fetchImpl: options.fetchImpl,
      railwayBaseUrl: settings.apiBaseUrl,
      railwayApiToken: settings.apiToken,
    });
    return;
  }

  if (
    (process.env.AGENT_CALENDAR_SCHEDULE_ASK_LOCAL === '1' || process.env.SCHEDULE_ASK_LOCAL === '1')
    && isLocalScheduleAskRoute(req.method, req.url)
  ) {
    const settings = options.getSettings();
    await handleLocalScheduleAskRoute(req, res, {
      fetchImpl: options.fetchImpl,
      railwayBaseUrl: settings.apiBaseUrl,
      railwayApiToken: settings.apiToken,
    });
    return;
  }

  const settings = options.getSettings();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!isHopByHopHeader(key) && value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (settings.apiToken) headers.authorization = `Bearer ${settings.apiToken}`;

  try {
    const body = ['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())
      ? undefined
      : await requestBody(req);
    const response = await (options.fetchImpl || fetch)(targetUrl(settings.apiBaseUrl, req.url), {
      method: req.method,
      headers,
      body,
      // Node fetch requires this when a stream-like body is passed.
      duplex: body ? 'half' : undefined,
    } as RequestInit & { duplex?: 'half' });

    res.statusCode = response.status;
    res.statusMessage = response.statusText;
    copyHeaders(response.headers, res);
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(response.body as unknown as NodeJS.ReadableStream, res);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Agent Calendar Railway proxy failed',
    }));
  }
}

export function createApiProxyServer(options: ProxyOptions): Server {
  return http.createServer((req, res) => {
    void handleProxyRequest(req, res, options);
  });
}
