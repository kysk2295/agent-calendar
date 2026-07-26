'use strict';

const { readBearerToken } = require('./auth');
const { authenticateAccessToken } = require('./workspace-auth-session');
const {
  matchProductionRoute,
  isMutatingMethod,
  allowsLegacyProductFallthrough,
} = require('./production-route-registry');
const {
  WorkspaceIdempotencyStore,
  readIdempotencyKey,
} = require('./workspace-idempotency');
const {
  handleScopedProductRoute,
  productionDisabled,
  sendJson,
} = require('./production-product-routes');
const {
  handleRunnerUserRoute,
  handleRunnerDeviceRoute,
} = require('./production-runner-routes');
const {
  handleExecutionDeviceRouteWithPath,
} = require('./production-execution-routes');
const {
  authorizeOperationsRequest,
  probeProductionReadiness,
} = require('./production-observability');
const { readProductionRequestBody } = require('./production-request-safety');
const { parseScheduleIngestRequest } = require('./workspace-schedule-ingest');
const {
  applyClientV1ResponseHeaders,
  assertClientV1Contract,
  clientV1ContractManifest,
} = require('./client-v1-contract');

assertClientV1Contract();

/**
 * Public infra status: no tenant product data, no global store dump.
 */
function buildPublicGatewayStatus(env = {}) {
  return {
    ok: true,
    mode: 'production',
    service: 'agent-calendar-gateway',
    authMode: 'production',
    runtimeReachable: false,
    effectiveRuntimeReachable: false,
    runtimeAccessMode: 'offline',
    buildCommit: String(
      env.SOURCE_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || env.RAILWAY_GIT_COMMIT || '',
    ).slice(0, 12),
    deploymentId: String(env.RAILWAY_DEPLOYMENT_ID || ''),
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

function publicError(error) {
  const code = error && error.code ? String(error.code) : 'request_failed';
  let status = 500;
  if (error && typeof error.statusHint === 'number') status = error.statusHint;
  else if (code === 'PAYLOAD_TOO_LARGE') status = 413;
  else if (code === 'REQUEST_BODY_TIMEOUT') status = 408;
  else if (
    code === 'INVALID_JSON'
    || code === 'VECTOR_LENGTH_INVALID'
    || code === 'REQUEST_BODY_FAILED'
    || code === 'REQUEST_BODY_ABORTED'
  ) status = 400;
  else if (code === 'ROLE_FORBIDDEN' || /FORBIDDEN/i.test(code)) status = 403;
  else if (
    /EXPIRED|INVALID|REVOKED|REPLAY|UNKNOWN|INACTIVE|NO_MEMBERSHIP|NOT_ISSUED|ROLE_MISMATCH|VERIFIER|UNTRUSTED|UNAUTHORIZED/i.test(code)
    || /forbidden|invalid|expired|revoked|unauthorized/i.test(String(error && error.message || ''))
  ) {
    status = 401;
  }
  return {
    status,
    body: {
      ok: false,
      error: code,
      message: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 400 ? 'bad_request' : 'request_failed',
    },
  };
}

/**
 * Production-mode single composition dispatcher for non-/api/phase1 paths.
 * Never falls through to legacy unscoped product handlers.
 * @returns {Promise<true>} always handled
 */
async function dispatchProductionApi(req, res, requestUrl, {
  env,
  runtime,
  legacyRelayHandler,
  operationsMonitor,
  requestSafety,
} = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathname = requestUrl.pathname || '';
  const matched = matchProductionRoute(method, pathname);

  if (!matched) {
    sendJson(res, 404, {
      ok: false,
      error: 'production_route_unregistered',
      message: 'not_found',
      mode: 'production',
      path: pathname,
    });
    return true;
  }

  const { route, params } = matched;

  if (route.class === 'public_infra') {
    if (route.action === 'client_v1_contract') {
      applyClientV1ResponseHeaders(res);
      sendJson(res, 200, clientV1ContractManifest);
      return true;
    }
    if (route.action === 'gateway_status') {
      sendJson(res, 200, buildPublicGatewayStatus(env));
      return true;
    }
    if (route.action === 'health') {
      sendJson(res, 200, { ok: true, status: 'alive', mode: 'production' });
      return true;
    }
    if (route.action === 'readiness') {
      const readiness = await probeProductionReadiness({ runtime, env, requestSafety });
      sendJson(res, readiness.ok ? 200 : 503, {
        ok: readiness.ok,
        status: readiness.status,
        mode: 'production',
        checkedAt: readiness.checkedAt,
      });
      return true;
    }
    sendJson(res, 200, { ok: true, mode: 'production' });
    return true;
  }

  if (route.class === 'operations_private') {
    const authorization = authorizeOperationsRequest(req.headers || {}, env);
    if (!authorization.ok) {
      if (authorization.status === 401) res.setHeader('www-authenticate', 'Bearer');
      sendJson(res, authorization.status, {
        ok: false,
        error: authorization.error,
        message: authorization.status === 401 ? 'unauthorized' : 'service_unavailable',
      });
      return true;
    }
    if (!operationsMonitor || typeof operationsMonitor.snapshot !== 'function') {
      sendJson(res, 503, {
        ok: false,
        error: 'operations_monitor_unavailable',
        message: 'service_unavailable',
      });
      return true;
    }
    const readiness = await probeProductionReadiness({ runtime, env, requestSafety });
    sendJson(res, 200, {
      ok: true,
      readiness,
      metrics: operationsMonitor.snapshot(),
      requestSafety: requestSafety && typeof requestSafety.snapshot === 'function'
        ? requestSafety.snapshot()
        : null,
    });
    return true;
  }

  if (route.class === 'production_disabled') {
    if (route.action === 'agent_work_publish_forbidden') {
      sendJson(res, 404, { ok: false, error: 'phase1_route_not_found', message: 'not_found' });
      return true;
    }
    if (route.action === 'embed_probe_removed') {
      sendJson(res, 410, {
        ok: false,
        error: 'synthetic_embed_probe_removed',
        message: 'removed',
      });
      return true;
    }
    productionDisabled(res, route.action);
    return true;
  }

  if (route.class === 'runner_device') {
    let body = {};
    if (isMutatingMethod(method)) {
      try {
        body = await readJsonBody(req, env);
      } catch (error) {
        const pub = publicError(error);
        sendJson(res, pub.status, pub.body);
        return true;
      }
    }
    if (!runtime || !runtime.runnerControl) {
      sendJson(res, 503, {
        ok: false,
        error: 'runner_control_unavailable',
        message: 'service_unavailable',
      });
      return true;
    }
    // Phase 3 execution routes need exact pathname for device signature verification.
    const action = String(route.action || '');
    if (action === 'runner_device_next_offer'
      || action === 'runner_device_lease'
      || action === 'runner_device_event'
      || action === 'runner_device_provider_session_bind'
      || action === 'runner_device_artifact'
      || action === 'runner_device_complete'
      || action === 'runner_device_fail'
      || action === 'runner_device_cancel_ack'
      || action === 'runner_device_attempt_heartbeat'
      || action === 'runner_device_connector_next'
      || action === 'runner_device_connector_complete'
      || action === 'runner_device_connector_fail'
      || action === 'runner_device_telegram_bind'
      || action === 'runner_device_telegram_status'
      || action === 'runner_device_telegram_inbound'
      || action === 'runner_device_telegram_next'
      || action === 'runner_device_telegram_ack') {
      await handleExecutionDeviceRouteWithPath({
        res,
        route,
        body,
        headers: req.headers || {},
        runtime,
        pathname,
      });
      return true;
    }
    await handleRunnerDeviceRoute({
      res,
      route,
      body,
      headers: req.headers || {},
      runtime,
    });
    return true;
  }

  if (route.class === 'provider_webhook') {
    if (route.action === 'calendar_google_webhook' && runtime && runtime.unifiedCalendar) {
      try {
        // Public webhook: channel id + token digest authority only.
        // Never trusts body workspace/source, never issues user sessions, never grants membership.
        // Push schedules reconcile only — not event payload and not a substitute for scoped_product auth.
        let ignoredBody = null;
        try {
          // Drain body so attackers cannot rely on unconsumed payload side effects; still ignored.
          ignoredBody = await readJsonBody(req, env).catch(() => null);
        } catch {
          ignoredBody = null;
        }
        void ignoredBody;
        const result = await runtime.unifiedCalendar.handleGoogleWebhook(req.headers || {});
        sendJson(res, 200, {
          ok: true,
          reconcile: true,
          requestId: result.requestId,
          // Never return workspaceId or secrets on public webhook response.
          userAuthorized: false,
        });
      } catch (error) {
        const code = error && error.code ? String(error.code) : 'webhook_error';
        const status = error && error.statusHint ? error.statusHint : 401;
        sendJson(res, status, { ok: false, error: code, message: status === 401 ? 'unauthorized' : 'request_failed' });
      }
      return true;
    }
    if (typeof legacyRelayHandler === 'function') {
      const handled = await legacyRelayHandler(req, res, requestUrl, { env, runtime, route, params });
      if (handled) return true;
    }
    sendJson(res, 401, {
      ok: false,
      error: 'provider_auth_required',
      message: 'unauthorized',
      action: route.action,
    });
    return true;
  }

  if (route.class === 'auth_public' || route.class === 'auth_session') {
    sendJson(res, 404, { ok: false, error: 'auth_route_not_found', message: 'not_found' });
    return true;
  }

  if (route.class === 'legacy_only') {
    sendJson(res, 401, {
      ok: false,
      error: 'workspace_auth_required',
      message: 'unauthorized',
      mode: 'production',
    });
    return true;
  }

  if (route.class !== 'scoped_product') {
    sendJson(res, 404, {
      ok: false,
      error: 'production_route_unhandled_class',
      class: route.class,
      message: 'not_found',
    });
    return true;
  }

  if (!runtime || !runtime.pool || !runtime.product) {
    sendJson(res, 503, {
      ok: false,
      error: 'phase1_pool_unavailable',
      message: 'service_unavailable',
    });
    return true;
  }

  let body = {};
  if (isMutatingMethod(method)) {
    try {
      if (route.action === 'assistant_ingest_scoped') {
        body = parseScheduleIngestRequest({
          buffer: await readProductionRequestBody(req, env),
          contentType: req.headers && req.headers['content-type'],
        });
      } else {
        body = await readJsonBody(req, env);
      }
    } catch (error) {
      const pub = publicError(error);
      sendJson(res, pub.status, pub.body);
      return true;
    }
  }

  let session;
  try {
    const token = readBearerToken(req.headers || {});
    session = await authenticateAccessToken(runtime.pool, token);
  } catch {
    sendJson(res, 401, {
      ok: false,
      error: 'workspace_auth_required',
      message: 'unauthorized',
      mode: 'production',
    });
    return true;
  }

  const scope = session.scope;

  if (route.role === 'owner' && String(scope.role || '').toLowerCase() !== 'owner') {
    sendJson(res, 403, {
      ok: false,
      error: 'ROLE_FORBIDDEN',
      message: 'forbidden',
      requiredRole: 'owner',
    });
    return true;
  }

  const query = Object.fromEntries(requestUrl.searchParams.entries());
  const idempotencyKey = readIdempotencyKey(req.headers || {});
  const needsIdempotency = isMutatingMethod(method) && route.idempotent && idempotencyKey;

  let idempo = null;
  if (needsIdempotency) {
    if (!runtime.idempotency) {
      runtime.idempotency = new WorkspaceIdempotencyStore({ pool: runtime.pool });
    }
    try {
      const begin = await runtime.idempotency.begin(scope, {
        idempotencyKey,
        method,
        path: pathname,
        body,
        route: route.pathPattern,
        action: route.action,
      });
      if (begin.kind === 'replay') {
        sendJson(res, begin.status, begin.body);
        return true;
      }
      if (begin.kind === 'conflict') {
        sendJson(res, begin.status, begin.body);
        return true;
      }
      if (begin.kind === 'in_progress') {
        const replayed = await runtime.idempotency.awaitReplay(scope, {
          idempotencyKey,
          route: route.pathPattern,
          action: route.action,
        });
        // awaitReplay always returns 200 replay or 409 in_progress — never null/500.
        sendJson(res, replayed.status, replayed.body);
        return true;
      }
      if (begin.kind === 'execute') {
        idempo = begin;
      }
    } catch (error) {
      // Concurrent idempotency insert races must not surface as opaque 500s.
      if (error && (error.code === '23505' || /duplicate|unique/i.test(String(error.message || '')))) {
        sendJson(res, 409, {
          ok: false,
          error: 'idempotency_in_progress',
          message: 'duplicate request in progress',
        });
        return true;
      }
      const pub = publicError(error);
      sendJson(res, pub.status, pub.body);
      return true;
    }
  }

  // Buffer JSON for idempotency without breaking streaming handlers.
  let capturedStatus = 200;
  let capturedBody = null;
  if (idempo && !String(route.persistence || '').includes('stream')) {
    const originalWriteHead = res.writeHead.bind(res);
    const originalEnd = res.end.bind(res);
    const chunks = [];
    res.writeHead = (code, ...rest) => {
      capturedStatus = code;
      return originalWriteHead(code, ...rest);
    };
    const originalWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return originalWrite(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const raw = Buffer.concat(chunks).toString('utf8');
      try { capturedBody = JSON.parse(raw || '{}'); } catch { capturedBody = { raw }; }
      return originalEnd(chunk, ...rest);
    };
  }

  try {
    // Runner user routes take precedence when action matches.
    if (String(route.action || '').startsWith('runners_')) {
      const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || '127.0.0.1'}`;
      await handleRunnerUserRoute({
        res,
        route,
        params,
        body,
        scope,
        runtime,
        controlPlaneBaseUrl: baseUrl,
      });
    } else {
      await handleScopedProductRoute({
        req,
        res,
        method,
        pathname,
        params,
        route,
        body,
        query,
        scope,
        runtime,
      });
    }
    if (idempo && capturedBody) {
      if (capturedStatus >= 400) await idempo.fail(capturedStatus, capturedBody);
      else await idempo.complete(capturedStatus, capturedBody);
    }
  } catch (error) {
    if (idempo) {
      try {
        await idempo.fail(error.statusHint || 500, {
          ok: false,
          error: error.code || 'request_failed',
        });
      } catch { /* ignore */ }
    }
    if (!res.headersSent) {
      const pub = publicError(error);
      sendJson(res, pub.status, pub.body);
    }
  }
  return true;
}

module.exports = {
  allowsLegacyProductFallthrough,
  buildPublicGatewayStatus,
  dispatchProductionApi,
  publicError,
};
