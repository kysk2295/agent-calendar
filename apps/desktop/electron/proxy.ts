import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL, URL } from 'node:url';
import { handleLocalWikiRoute, isLocalWikiRoute, LocalWikiPathError } from './localWikiAsk.js';
import { handleLocalScheduleAskRoute, isLocalScheduleAskRoute } from './scheduleAsk.js';
import {
  CLIENT_CONTRACT_HEADER,
  CLIENT_IDEMPOTENCY_KEY_HEADER,
  CLIENT_REQUEST_ID_HEADER,
} from './clientContract.js';

export type ProxySettings = {
  apiBaseUrl: string;
  /** @deprecated Prefer getAccessToken for production authenticated routes. */
  apiToken?: string;
};

export type ProxyOptions = {
  readonly allowedDevOrigin?: string;
  readonly credential: string;
  readonly getSettings: () => ProxySettings;
  /** Secure session access token (refreshes as needed). Never read from renderer. */
  readonly getAccessToken?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
};

export type ProxyRendererTrustOptions = {
  readonly allowedDevOrigin?: string;
  readonly packagedIndexPath: string;
};

export const PROXY_CREDENTIAL_HEADER = 'x-agent-calendar-proxy-credential';
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const CORS_ALLOWED_HEADERS = [
  'accept',
  'content-type',
  'last-event-id',
  CLIENT_CONTRACT_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_IDEMPOTENCY_KEY_HEADER,
  PROXY_CREDENTIAL_HEADER,
] as const;
const ALLOWED_METHOD_SET = new Set<string>(ALLOWED_METHODS);
const CORS_ALLOWED_HEADER_SET = new Set<string>(CORS_ALLOWED_HEADERS);
const UPSTREAM_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'last-event-id',
  'range',
  CLIENT_CONTRACT_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_IDEMPOTENCY_KEY_HEADER,
]);
const EXCLUDED_RESPONSE_HEADERS = new Set(['connection', 'content-length', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'vary']);

export function isTrustedProxyRendererUrl(senderUrl: string, options: ProxyRendererTrustOptions): boolean {
  const packagedUrl = pathToFileURL(options.packagedIndexPath).href;
  const packagedOverlayUrl = new URL(packagedUrl);
  packagedOverlayUrl.searchParams.set('overlay', 'widgets');
  const packagedRecoveryUrl = new URL(packagedUrl);
  packagedRecoveryUrl.searchParams.set('recovery', 'manual');
  if (
    senderUrl === packagedUrl
    || senderUrl === packagedOverlayUrl.href
    || senderUrl === packagedRecoveryUrl.href
  ) return true;
  if (!options.allowedDevOrigin) return false;
  try {
    const sender = new URL(senderUrl);
    const allowedDev = new URL(options.allowedDevOrigin);
    return sender.origin === allowedDev.origin
      && (sender.protocol === 'http:' || sender.protocol === 'https:');
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function requestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('aborted', () => reject(new Error('Renderer request was aborted')));
    req.on('error', reject);
  });
}

function copyHeaders(headers: Headers, res: ServerResponse) {
  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (!EXCLUDED_RESPONSE_HEADERS.has(normalized) && !normalized.startsWith('access-control-')) {
      res.setHeader(key, value);
    }
  });
}

function requestHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : value || '';
}

function isAllowedOrigin(origin: string, allowedDevOrigin?: string): boolean {
  return origin === 'null' || origin === 'file://' || Boolean(allowedDevOrigin && origin === allowedDevOrigin);
}

function setVaryOrigin(res: ServerResponse) {
  res.setHeader('vary', 'Origin');
}

function setAllowedCorsOrigin(res: ServerResponse, origin: string) {
  setVaryOrigin(res);
  res.setHeader('access-control-allow-origin', origin);
}

function writeJsonError(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error }));
}

function credentialsMatch(expected: string, presented: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const presentedDigest = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

function preflightAllowed(req: IncomingMessage): boolean {
  const method = requestHeader(req, 'access-control-request-method').toUpperCase();
  const requestedHeaders = requestHeader(req, 'access-control-request-headers')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  return ALLOWED_METHOD_SET.has(method)
    && requestedHeaders.includes(PROXY_CREDENTIAL_HEADER)
    && requestedHeaders.every((header) => CORS_ALLOWED_HEADER_SET.has(header));
}

function upstreamHeaders(req: IncomingMessage, ownerToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!UPSTREAM_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (ownerToken) headers.authorization = `Bearer ${ownerToken}`;
  return headers;
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
  setVaryOrigin(res);
  const method = String(req.method || '').toUpperCase();
  if (!req.url?.startsWith('/api/')) {
    writeJsonError(res, 404, 'Not found');
    return;
  }

  const origin = requestHeader(req, 'origin');
  if (origin && !isAllowedOrigin(origin, options.allowedDevOrigin)) {
    writeJsonError(res, 403, 'Proxy origin forbidden');
    return;
  }

  if (method === 'OPTIONS') {
    if (!origin || !preflightAllowed(req)) {
      writeJsonError(res, 403, 'Proxy preflight forbidden');
      return;
    }
    setAllowedCorsOrigin(res, origin);
    res.setHeader('access-control-allow-methods', ALLOWED_METHODS.join(','));
    res.setHeader('access-control-allow-headers', CORS_ALLOWED_HEADERS.join(','));
    res.setHeader('access-control-max-age', '600');
    res.writeHead(204);
    res.end();
    return;
  }

  if (!credentialsMatch(options.credential, requestHeader(req, PROXY_CREDENTIAL_HEADER))) {
    if (origin) setAllowedCorsOrigin(res, origin);
    writeJsonError(res, 401, 'Proxy authentication required');
    return;
  }
  if (origin) setAllowedCorsOrigin(res, origin);

  const settings = options.getSettings();
  let ownerToken: string | undefined;
  if (options.getAccessToken) {
    // Production path: Authorization comes only from the secure session manager.
    try {
      ownerToken = (await options.getAccessToken()) || undefined;
    } catch {
      ownerToken = undefined;
    }
  } else {
    // Legacy personal-beta harnesses without a session manager may still pass apiToken.
    ownerToken = settings.apiToken || undefined;
  }

  if (process.env.WIKI_ASK_LOCAL === '1' && isLocalWikiRoute(req.method, req.url)) {
    try {
      await handleLocalWikiRoute(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(error instanceof LocalWikiPathError ? 400 : 500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Agent Calendar local wiki failed',
      }));
    }
    return;
  }

  if (
    (process.env.AGENT_CALENDAR_SCHEDULE_ASK_LOCAL === '1' || process.env.SCHEDULE_ASK_LOCAL === '1')
    && isLocalScheduleAskRoute(req.method, req.url)
  ) {
    await handleLocalScheduleAskRoute(req, res, {
      fetchImpl: options.fetchImpl,
      railwayBaseUrl: settings.apiBaseUrl,
      railwayApiToken: ownerToken,
    });
    return;
  }

  const headers = upstreamHeaders(req, ownerToken);
  const upstreamController = new AbortController();
  const abortUpstream = () => {
    if (!upstreamController.signal.aborted) upstreamController.abort();
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abortUpstream();
  };
  req.once('aborted', abortUpstream);
  res.once('close', abortOnResponseClose);

  try {
    const body = ['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())
      ? undefined
      : await requestBody(req);
    const doFetch = async (token?: string) => (options.fetchImpl || fetch)(targetUrl(settings.apiBaseUrl, req.url), {
      method: req.method,
      headers: upstreamHeaders(req, token),
      body,
      signal: upstreamController.signal,
      // Node fetch requires this when a stream-like body is passed.
      duplex: body ? 'half' : undefined,
    } as RequestInit & { duplex?: 'half' });

    let response = await doFetch(ownerToken);
    // On 401, force a single-flight refresh via getAccessToken({force}) if available.
    if (response.status === 401 && options.getAccessToken) {
      try {
        const refreshed = await options.getAccessToken();
        if (refreshed && refreshed !== ownerToken) {
          response = await doFetch(refreshed);
        }
      } catch {
        // keep original 401
      }
    }

    res.statusCode = response.status;
    res.statusMessage = response.statusText;
    copyHeaders(response.headers, res);
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(response.body as unknown as NodeJS.ReadableStream, res);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Agent Calendar Railway proxy failed',
    }));
  } finally {
    req.off('aborted', abortUpstream);
    res.off('close', abortOnResponseClose);
  }
}

export function createApiProxyServer(options: ProxyOptions): Server {
  return http.createServer((req, res) => {
    void handleProxyRequest(req, res, options);
  });
}
