'use strict';

const crypto = require('node:crypto');
const { matchProductionRoute } = require('./production-route-registry');

const SAFE_REQUEST_ID = /^(?:[0-9a-f]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MIN_OPERATIONS_TOKEN_LENGTH = 32;
const MAX_OPERATIONS_TOKEN_LENGTH = 512;

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function configuredOperationsToken(env = process.env) {
  const token = String(env.AGENT_CALENDAR_OPERATIONS_TOKEN || '').trim();
  return token.length >= MIN_OPERATIONS_TOKEN_LENGTH && token.length <= MAX_OPERATIONS_TOKEN_LENGTH
    ? token
    : '';
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function readBearer(headers = {}) {
  const header = String(headers.authorization || headers.Authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function authorizeOperationsRequest(headers = {}, env = process.env) {
  const expected = configuredOperationsToken(env);
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'operations_auth_not_configured',
    };
  }
  const actual = readBearer(headers);
  const authorized = actual
    ? crypto.timingSafeEqual(hashSecret(actual), hashSecret(expected))
    : false;
  return authorized
    ? { ok: true, status: 200, error: null }
    : { ok: false, status: 401, error: 'operations_unauthorized' };
}

function safeRequestId(value, randomUUID = crypto.randomUUID) {
  const supplied = String(value || '').trim();
  return SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

function operationRouteLabel(method, pathname) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = String(pathname || '/');
  let matched = null;
  try {
    matched = matchProductionRoute(normalizedMethod, normalizedPath);
  } catch {
    matched = null;
  }
  if (matched && matched.route && matched.route.pathPattern) {
    return matched.route.pathPattern;
  }
  return normalizedPath.startsWith('/api/') ? '/api/unregistered' : '/non-api';
}

function statusClass(statusCode) {
  const safe = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : 500;
  return `${Math.floor(safe / 100)}xx`;
}

function percentile95(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(ordered.length * 0.95) - 1);
  return ordered[index];
}

function createProductionObservability({
  now = Date.now,
  randomUUID = crypto.randomUUID,
  maxSamples = 512,
  minimumSloSamples = 20,
  availabilityTarget = 0.995,
  p95TargetMs = 2_000,
} = {}) {
  const startedAtMs = now();
  const boundedSampleCount = Math.max(1, Math.min(10_000, Number(maxSamples) || 512));
  const boundedMinimum = Math.max(1, Math.min(boundedSampleCount, Number(minimumSloSamples) || 20));
  const aggregates = new Map();
  const samples = [];
  let activeRequests = 0;
  let totalRequests = 0;
  let serverErrors = 0;

  function beginRequest({ method, pathname, requestId } = {}) {
    const started = now();
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const route = operationRouteLabel(normalizedMethod, pathname);
    const correlationId = safeRequestId(requestId, randomUUID);
    let finished = false;
    let finishedLog = null;
    activeRequests += 1;

    return {
      requestId: correlationId,
      route,
      finish(statusCodeValue) {
        if (finished) return finishedLog;
        finished = true;
        activeRequests = Math.max(0, activeRequests - 1);
        totalRequests += 1;
        const safeStatus = Number.isInteger(statusCodeValue)
          && statusCodeValue >= 100
          && statusCodeValue <= 599
          ? statusCodeValue
          : 500;
        const requestStatusClass = statusClass(safeStatus);
        const durationMs = Math.max(0, Math.round(now() - started));
        if (safeStatus >= 500) serverErrors += 1;

        const aggregateKey = `${normalizedMethod}\n${route}\n${requestStatusClass}`;
        const existing = aggregates.get(aggregateKey) || {
          method: normalizedMethod,
          route,
          statusClass: requestStatusClass,
          count: 0,
          durationMsTotal: 0,
        };
        existing.count += 1;
        existing.durationMsTotal += durationMs;
        aggregates.set(aggregateKey, existing);

        samples.push({
          statusCode: safeStatus,
          durationMs,
        });
        if (samples.length > boundedSampleCount) {
          samples.splice(0, samples.length - boundedSampleCount);
        }

        finishedLog = {
          event: 'gateway_request',
          requestId: correlationId,
          method: normalizedMethod,
          route,
          statusCode: safeStatus,
          statusClass: requestStatusClass,
          durationMs,
        };
        return finishedLog;
      },
    };
  }

  function snapshot() {
    const durations = samples.map((sample) => sample.durationMs);
    const availabilityEligible = samples.filter((sample) => sample.statusCode < 400 || sample.statusCode >= 500);
    const good = availabilityEligible.filter((sample) => sample.statusCode < 400).length;
    const availability = availabilityEligible.length ? good / availabilityEligible.length : null;
    const p95Ms = percentile95(durations);
    const enoughSamples = availabilityEligible.length >= boundedMinimum;
    const availabilityMet = availability !== null && availability >= availabilityTarget;
    const latencyMet = p95Ms <= p95TargetMs;
    const sloState = enoughSamples
      ? (availabilityMet && latencyMet ? 'meeting' : 'breached')
      : 'insufficient_data';

    return {
      schemaVersion: 1,
      uptimeMs: Math.max(0, Math.round(now() - startedAtMs)),
      window: {
        maxSamples: boundedSampleCount,
        observedSamples: samples.length,
      },
      requests: {
        total: totalRequests,
        active: activeRequests,
        serverErrors,
        routes: [...aggregates.values()]
          .map((item) => ({ ...item }))
          .sort((a, b) => (
            a.route.localeCompare(b.route)
            || a.method.localeCompare(b.method)
            || a.statusClass.localeCompare(b.statusClass)
          )),
      },
      latency: {
        p95Ms,
        targetMs: p95TargetMs,
      },
      availability: {
        ratio: availability,
        target: availabilityTarget,
        eligibleSamples: availabilityEligible.length,
      },
      slo: {
        state: sloState,
        minimumSamples: boundedMinimum,
        availabilityMet: enoughSamples ? availabilityMet : null,
        latencyMet: enoughSamples ? latencyMet : null,
      },
    };
  }

  return {
    beginRequest,
    snapshot,
  };
}

async function boundedDatabaseProbe(pool, timeoutMs) {
  if (!pool || typeof pool.query !== 'function') return false;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const query = Promise.resolve(pool.query('select 1 as ok'))
      .then(() => true)
      .catch(() => false);
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeProductionReadiness({
  runtime,
  env = process.env,
  now = Date.now,
  databaseTimeoutMs = 1_500,
  requestSafety = null,
} = {}) {
  const checks = {
    workspaceAuth: String(env.WORKSPACE_AUTH_MODE || '').trim().toLowerCase() === 'production',
    database: await boundedDatabaseProbe(runtime && runtime.pool, databaseTimeoutMs),
    productRuntime: Boolean(
      runtime
      && runtime.product
      && runtime.runnerControl
      && runtime.durableExecution
      && runtime.unifiedCalendar
      && runtime.knowledge
      && runtime.automationFederation
      && runtime.calendarAi,
    ),
    authKit: Boolean(
      runtime
      && runtime.authKit
      && runtime.workosConfig
      && String(runtime.workosConfig.clientId || '').trim()
      && runtime.workosConfig.apiKeyConfigured === true,
    ),
    operationsAuth: Boolean(configuredOperationsToken(env)),
    requestLogging: envFlag(env.AGENT_CALENDAR_OBSERVABILITY_LOGS),
    ...(requestSafety ? {
      requestSafety: typeof requestSafety.admit === 'function'
        && typeof requestSafety.snapshot === 'function',
    } : {}),
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    status: ok ? 'ready' : 'not_ready',
    checkedAt: new Date(now()).toISOString(),
    checks,
  };
}

module.exports = {
  authorizeOperationsRequest,
  configuredOperationsToken,
  createProductionObservability,
  operationRouteLabel,
  probeProductionReadiness,
  safeRequestId,
};
