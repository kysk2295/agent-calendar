'use strict';

const { readBearerToken } = require('./auth');
const {
  authenticateAccessToken,
  issueSessionForVerifiedSubject,
  logoutSession,
  refreshSession,
} = require('./workspace-auth-session');
const { isProductionWorkspaceAuth } = require('./workspace-request-context');
const { WorkspaceScopedProductService } = require('./workspace-scoped-product-service');
const { createWorkspaceSseHub } = require('./workspace-sse-hub');
const {
  completeDesktopLogin,
  selectDesktopWorkspace,
  startDesktopLogin,
} = require('./desktop-login-service');
const {
  createWorkosAuthKitAdapter,
  resolveWorkosConfig,
} = require('./workos-authkit-adapter');
const {
  createGoogleOAuthAdapter,
  resolveGoogleOAuthConfig,
} = require('./google-oauth-adapter');
const { dispatchProductionApi } = require('./production-gateway-dispatch');
const { WorkspaceIdempotencyStore } = require('./workspace-idempotency');
const {
  RunnerControl,
  runnerReleaseConfigurationFromEnv,
} = require('./runner-control');
const { DurableExecution } = require('./durable-execution');
const { UnifiedCalendar } = require('./unified-calendar');
const { KnowledgeService } = require('./knowledge-service');
const { CalendarAiService } = require('./calendar-ai-service');
const { createCalendarAiModelAdapter } = require('./calendar-ai-model-adapter');
const { createRunnerWorkspaceInferenceCompletion } = require('./calendar-ai-runner-adapter');
const { WorkspaceInferenceBroker } = require('./workspace-inference-broker');
const { ProviderAgentBridge } = require('./provider-agent-session-bridge');
const { WorkspaceAgentBuilderService } = require('./workspace-agent-builder-service');
const { WorkConversationChannelService } = require('./work-conversation-channel-service');
const { AutomationFederation } = require('./automation-federation');
const { RunnerAutomationSourceAdapter } = require('./runner-automation-source-adapter');
const { readProductionRequestBody } = require('./production-request-safety');

/**
 * Fail-closed Phase 1 authenticated route group.
 * HTTP body never establishes identity. Only an injected trusted identityVerifier
 * Adapter may return { provider, providerSubject }.
 * Desktop public login uses AuthKit exchange via desktop start/complete only.
 */

function publicErrorPayload(error, { production = true } = {}) {
  const code = error && error.code ? String(error.code) : 'phase1_error';
  let status = 500;
  if (error && typeof error.statusHint === 'number' && error.statusHint >= 400 && error.statusHint < 600) {
    status = error.statusHint;
  } else if (code === 'PAYLOAD_TOO_LARGE') {
    status = 413;
  } else if (code === 'REQUEST_BODY_TIMEOUT') {
    status = 408;
  } else if (
    code === 'INVALID_JSON'
    || code === 'VECTOR_LENGTH_INVALID'
    || code === 'REQUEST_BODY_FAILED'
    || code === 'REQUEST_BODY_ABORTED'
    || /PARAMS_REQUIRED|CODE_REQUIRED/i.test(code)
  ) {
    status = 400;
  } else if (/WORKOS_CONFIG_MISSING|WORKOS_SDK_UNAVAILABLE|WORKOS_AUTH_URL_INVALID|phase1_pool/i.test(code)) {
    status = 503;
  } else if (/FORBIDDEN|SELECTION_FORBIDDEN|SELECTION_INACTIVE/i.test(code)) {
    status = 403;
  } else if (
    /EXPIRED|INVALID|REVOKED|REPLAY|UNKNOWN|INACTIVE|NO_MEMBERSHIP|NOT_ISSUED|ROLE_MISMATCH|VERIFIER|UNTRUSTED|CONTENTION|MISMATCH|EXCHANGE|UNVERIFIED|USER_MISSING/i.test(code)
    || /forbidden|invalid|expired|revoked|replay|inactive|verifier|untrusted|mismatch/i.test(String(error && error.message || ''))
  ) {
    status = 401;
  }
  // Never echo raw DB / stack internals to clients.
  const safeMessage = production
    ? (status === 401 || status === 403
      ? 'unauthorized'
      : status === 400
        ? 'bad_request'
        : status === 503
          ? 'service_unavailable'
          : 'request_failed')
    : String(error && error.message ? error.message : error);
  return {
    status: status >= 400 ? status : 500,
    body: {
      ok: false,
      error: code || 'phase1_error',
      message: safeMessage,
    },
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isPhase1Path(pathname = '') {
  return pathname === '/api/phase1' || pathname.startsWith('/api/phase1/');
}

function isLegacyUnscopedProductPath(pathname = '') {
  if (!pathname.startsWith('/api/')) return false;
  if (isPhase1Path(pathname)) return false;
  if (pathname === '/api/health' || pathname === '/api/gateway-status') return false;
  if (pathname === '/api/relay' || pathname.startsWith('/api/relay/')) return false;
  if (pathname === '/api/telegram/webhook' || pathname.startsWith('/api/telegram/')) return false;
  return true;
}

function createPhase1Runtime({
  pool,
  sseHub,
  identityVerifier = null,
  authKit = undefined,
  workosConfig = undefined,
  calendarAiModelAdapter = undefined,
  workspaceInferenceBroker = undefined,
  calendarAiClock = undefined,
  automationAdapters = {},
  env = process.env,
} = {}) {
  if (!pool) throw new Error('createPhase1Runtime requires pool');
  let resolvedAuthKit = authKit;
  let resolvedWorkosConfig = workosConfig;
  if (resolvedAuthKit === undefined || resolvedWorkosConfig === undefined) {
    // Google is the product identity provider (ADR 0010). WorkOS stays selectable so an
    // existing deployment keeps working until its configuration is removed.
    const googleFromEnv = resolveGoogleOAuthConfig(env);
    const fromEnv = googleFromEnv || resolveWorkosConfig(env);
    if (resolvedWorkosConfig === undefined) {
      resolvedWorkosConfig = fromEnv
        ? { clientId: fromEnv.clientId, apiKeyConfigured: true }
        : null;
    }
    if (resolvedAuthKit === undefined) {
      try {
        resolvedAuthKit = googleFromEnv
          ? createGoogleOAuthAdapter(env)
          : createWorkosAuthKitAdapter(env);
      } catch {
        resolvedAuthKit = null;
      }
    }
  }
  // Explicit null from tests means unconfigured (fail closed).
  if (authKit === null) resolvedAuthKit = null;
  if (workosConfig === null) resolvedWorkosConfig = null;

  const hub = sseHub || createWorkspaceSseHub();
  const durableExecution = new DurableExecution({ pool, env, sseHub: hub });
  // Service-owned reaper + outbox drain (restart-safe; unref'd timers).
  if (!/^(0|false|off|no)$/i.test(String(env.DURABLE_EXECUTION_BACKGROUND_WORKERS || '1'))) {
    durableExecution.startBackgroundWorkers();
  }
  const unifiedCalendar = new UnifiedCalendar({ pool, env });
  // Calendar sync outbox + watch renewal workers (separate flag; unref'd; stopped in tests).
  if (!/^(0|false|off|no)$/i.test(String(
    env.UNIFIED_CALENDAR_BACKGROUND_WORKERS
    || env.CALENDAR_SYNC_BACKGROUND_WORKERS
    || '1',
  ))) {
    unifiedCalendar.startBackgroundWorkers();
  }
  const product = new WorkspaceScopedProductService({ pool, useAppRole: true, env });
  const providerAgentBridge = new ProviderAgentBridge({ pool, env });
  const agentBuilder = new WorkspaceAgentBuilderService({ pool });
  const workConversationChannels = new WorkConversationChannelService({ pool });
  const cloudModelAdapter = createCalendarAiModelAdapter({ env });
  const inferenceBroker = workspaceInferenceBroker || new WorkspaceInferenceBroker({
    pool,
    env,
    runnerComplete: createRunnerWorkspaceInferenceCompletion({
      pool,
      durableExecution,
      env,
    }),
    cloudComplete: (input) => cloudModelAdapter.complete(input),
  });
  const knowledge = new KnowledgeService({
    pool,
    env,
    durableExecution,
    legacyProduct: product,
    inferenceBroker,
  });
  const runnerAutomationAdapter = new RunnerAutomationSourceAdapter({ pool, env });
  const automationFederation = new AutomationFederation({
    pool,
    adapters: {
      hermes: runnerAutomationAdapter,
      ...automationAdapters,
    },
    env,
  });
  const calendarAi = new CalendarAiService({
    pool,
    product,
    unifiedCalendar,
    knowledge,
    automationFederation,
    durableExecution,
    modelAdapter: calendarAiModelAdapter || inferenceBroker,
    env,
    ...(calendarAiClock ? { clock: calendarAiClock } : {}),
  });
  const runnerReleaseConfiguration = runnerReleaseConfigurationFromEnv(env);
  return {
    pool,
    env,
    product,
    sseHub: hub,
    idempotency: new WorkspaceIdempotencyStore({ pool }),
    runnerControl: new RunnerControl({
      pool,
      env,
      releaseManifest: runnerReleaseConfiguration.releaseManifest,
      releaseTrustedPublicKeys: runnerReleaseConfiguration.trustedPublicKeys,
      releaseMinimumVersion: runnerReleaseConfiguration.minimumVersion,
    }),
    durableExecution,
    providerAgentBridge,
    agentBuilder,
    workConversationChannels,
    inferenceBroker,
    unifiedCalendar,
    knowledge,
    automationFederation,
    calendarAi,
    // Trusted Adapter only. null means public HTTP cannot issue sessions via /auth/session.
    identityVerifier: identityVerifier && typeof identityVerifier.verify === 'function'
      ? identityVerifier
      : null,
    authKit: resolvedAuthKit,
    workosConfig: resolvedWorkosConfig,
  };
}

async function readJsonBody(req, env = process.env) {
  const buffer = await readProductionRequestBody(req, env);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8') || '{}');
  } catch {
    const error = new Error('invalid_json');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

async function requireSession(runtime, req) {
  const token = readBearerToken(req.headers || {});
  return authenticateAccessToken(runtime.pool, token);
}

async function assertAgentSessionInWorkspace(pool, scope, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const result = await pool.query(
    `select id, mission_id, workspace_id from agent_sessions
     where id = $1 and workspace_id = $2
     limit 1`,
    [id, scope.workspaceId],
  );
  return result.rowCount ? result.rows[0] : null;
}

async function handlePhase1Request(req, res, requestUrl, runtime, { env = process.env } = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathname = requestUrl.pathname || '';
  const parts = pathname.replace(/^\/api\/phase1\/?/, '').split('/').filter(Boolean);
  const production = true;

  try {
    // Public Desktop AuthKit login (no session yet).
    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'desktop' && parts[2] === 'start') {
      const body = await readJsonBody(req, env);
      const started = await startDesktopLogin(runtime, {
        screenHint: body && body.screenHint,
      });
      sendJson(res, 200, started);
      return true;
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'desktop' && parts[2] === 'complete') {
      const body = await readJsonBody(req, env);
      // Ignore body identity fields as authority — completeDesktopLogin only uses AuthKit subject.
      const completed = await completeDesktopLogin(runtime, body || {});
      sendJson(res, 200, completed);
      return true;
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'desktop' && parts[2] === 'select-workspace') {
      const body = await readJsonBody(req, env);
      const selected = await selectDesktopWorkspace(runtime, body || {});
      sendJson(res, 200, selected);
      return true;
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'session') {
      const body = await readJsonBody(req, env);
      if (body && (body.userId || body.role)) {
        sendJson(res, 400, {
          ok: false,
          error: 'userId_and_role_not_accepted_from_body',
          message: 'bad_request',
        });
        return true;
      }
      // Public HTTP body cannot establish identity (providerSubject is not trusted).
      if (!runtime.identityVerifier) {
        sendJson(res, 503, {
          ok: false,
          error: 'identity_verifier_required',
          message: 'unauthorized',
        });
        return true;
      }
      const verified = await runtime.identityVerifier.verify(req, body);
      if (!verified || !verified.provider || !verified.providerSubject) {
        sendJson(res, 401, {
          ok: false,
          error: 'identity_untrusted',
          message: 'unauthorized',
        });
        return true;
      }
      // Ignore body.provider / body.providerSubject for identity — only Adapter result.
      const issued = await issueSessionForVerifiedSubject(runtime.pool, {
        provider: verified.provider,
        providerSubject: verified.providerSubject,
        workspaceId: body && body.workspaceId,
      });
      sendJson(res, 200, {
        ok: true,
        sessionId: issued.sessionId,
        userId: issued.userId,
        workspaceId: issued.workspaceId,
        role: issued.role,
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessExpiresAt: issued.accessExpiresAt,
        refreshExpiresAt: issued.refreshExpiresAt,
      });
      return true;
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'refresh') {
      const body = await readJsonBody(req, env);
      const issued = await refreshSession(runtime.pool, { refreshToken: body.refreshToken });
      sendJson(res, 200, {
        ok: true,
        sessionId: issued.sessionId,
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        accessExpiresAt: issued.accessExpiresAt,
        refreshExpiresAt: issued.refreshExpiresAt,
        workspaceId: issued.workspaceId,
      });
      return true;
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'logout') {
      const token = readBearerToken(req.headers || {});
      await logoutSession(runtime.pool, { accessToken: token });
      sendJson(res, 200, { ok: true });
      return true;
    }

    const session = await requireSession(runtime, req);
    const scope = session.scope;

    if (method === 'GET' && parts[0] === 'tasks' && parts.length === 1) {
      const tasks = await runtime.product.listTasks(scope);
      sendJson(res, 200, { ok: true, workspaceId: scope.workspaceId, tasks });
      return true;
    }

    if (method === 'GET' && parts[0] === 'tasks' && parts.length === 2) {
      const task = await runtime.product.getTaskById(scope, parts[1]);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'not_found', message: 'not_found' });
        return true;
      }
      sendJson(res, 200, { ok: true, workspaceId: scope.workspaceId, task });
      return true;
    }

    if (method === 'GET' && parts[0] === 'calendar-events' && parts.length === 1) {
      const events = await runtime.product.listCalendarEvents(scope);
      sendJson(res, 200, { ok: true, workspaceId: scope.workspaceId, events });
      return true;
    }

    if (method === 'GET' && parts[0] === 'calendar-events' && parts.length === 2) {
      const event = await runtime.product.getCalendarEventById(scope, parts[1]);
      if (!event) {
        sendJson(res, 404, { ok: false, error: 'not_found', message: 'not_found' });
        return true;
      }
      sendJson(res, 200, { ok: true, workspaceId: scope.workspaceId, event });
      return true;
    }

    if (method === 'GET' && parts[0] === 'wiki' && parts[1] === 'search') {
      const q = requestUrl.searchParams.get('q') || '';
      const mode = requestUrl.searchParams.get('mode') || 'keyword';
      let results;
      if (mode === 'vector') {
        const vectorParam = requestUrl.searchParams.get('vector');
        // Explicit vector list must be length 256 before hitting pgvector.
        if (vectorParam != null && String(vectorParam).trim() !== '') {
          const queryVector = String(vectorParam).split(',').map((n) => Number(n) || 0);
          if (queryVector.length !== 256) {
            sendJson(res, 400, {
              ok: false,
              error: 'VECTOR_LENGTH_INVALID',
              message: 'bad_request',
            });
            return true;
          }
          results = await runtime.product.searchWikiVector(scope, queryVector, { limit: 20 });
        } else {
          // Text query is hashed to a 256-d vector inside the service.
          results = await runtime.product.searchWikiVector(scope, q, { limit: 20 });
        }
      } else {
        results = await runtime.product.searchWiki(scope, q);
      }
      sendJson(res, 200, {
        ok: true,
        workspaceId: scope.workspaceId,
        query: q,
        mode,
        results,
      });
      return true;
    }

    // Real SSE text/event-stream (not JSON long-poll).
    if (method === 'GET' && parts[0] === 'agent-work' && parts[2] === 'stream') {
      const sessionId = parts[1];
      const owned = await assertAgentSessionInWorkspace(runtime.pool, scope, sessionId);
      if (!owned) {
        sendJson(res, 404, { ok: false, error: 'not_found', message: 'not_found' });
        return true;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }
      // Clients observe connection before the first event.
      res.write(`: connected workspace=${scope.workspaceId} session=${sessionId}\n\n`);
      // Subscribe so waiters exist for workspace-keyed trusted producers (RunnerControl later).
      const payload = await runtime.sseHub.subscribe(scope, `agent-session:${sessionId}`, {
        timeoutMs: Math.min(Number(requestUrl.searchParams.get('waitMs') || 15_000), 30_000),
      });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
      return true;
    }

    // JSON snapshot only (not SSE).
    if (method === 'GET' && parts[0] === 'agent-work' && parts[2] === 'events') {
      const sessionId = parts[1];
      const owned = await assertAgentSessionInWorkspace(runtime.pool, scope, sessionId);
      if (!owned) {
        sendJson(res, 404, { ok: false, error: 'not_found', message: 'not_found' });
        return true;
      }
      const events = await runtime.product.listAgentSessionEvents(scope, sessionId);
      sendJson(res, 200, {
        ok: true,
        workspaceId: scope.workspaceId,
        sessionId,
        events,
      });
      return true;
    }

    // Intentionally not a public user-session route: forging agent checkpoints is forbidden.
    // Future RunnerControl trusted producers use runtime.sseHub.publish in-process.
    if (parts[0] === 'agent-work' && parts[2] === 'publish') {
      sendJson(res, 404, {
        ok: false,
        error: 'phase1_route_not_found',
        message: 'not_found',
      });
      return true;
    }

    // Explicitly not the Calendar AI embedding cache evidence path.
    // Use schedule-assistant recordEmbeddingCacheKey with workspaceId instead.
    if (method === 'POST' && parts[0] === 'schedule' && parts[1] === 'embed-probe') {
      sendJson(res, 410, {
        ok: false,
        error: 'synthetic_embed_probe_removed',
        message: 'Use schedule-assistant embedding cache with workspaceId options; synthetic probe is not Calendar AI evidence.',
      });
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'phase1_route_not_found', message: 'not_found' });
    return true;
  } catch (error) {
    const pub = publicErrorPayload(error, { production });
    sendJson(res, pub.status, pub.body);
    return true;
  }
}

async function maybeHandlePhase1OrBlockLegacy(req, res, requestUrl, {
  env,
  runtime,
  legacyRelayHandler = null,
  operationsMonitor = null,
  requestSafety = null,
} = {}) {
  const pathname = requestUrl.pathname || '';
  if (isPhase1Path(pathname)) {
    if (!runtime || !runtime.pool) {
      sendJson(res, 503, { ok: false, error: 'phase1_pool_unavailable', message: 'request_failed' });
      return true;
    }
    return handlePhase1Request(req, res, requestUrl, runtime, { env });
  }
  // Production mode: every remaining /api/* path goes through the registry dispatch.
  // No fallthrough to global bearer + unscoped HermesStore product handlers.
  if (isProductionWorkspaceAuth(env)) {
    return dispatchProductionApi(req, res, requestUrl, {
      env,
      runtime,
      legacyRelayHandler,
      operationsMonitor,
      requestSafety,
    });
  }
  return false;
}

module.exports = {
  createPhase1Runtime,
  handlePhase1Request,
  isLegacyUnscopedProductPath,
  isPhase1Path,
  maybeHandlePhase1OrBlockLegacy,
  publicErrorPayload,
};
