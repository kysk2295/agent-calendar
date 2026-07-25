'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MIN_OPERATIONS_TOKEN_LENGTH = 32;
const MAX_OPERATIONS_TOKEN_LENGTH = 512;
const SLO_STATES = new Set(['insufficient_data', 'meeting', 'breached']);

const ALERT_RULES = Object.freeze({
  availability_slo: { severity: 'P1', threshold: 2 },
  capacity_pressure: { severity: 'P1', threshold: 2 },
  collector_auth: { severity: 'P1', threshold: 1 },
  deployment_readiness: { severity: 'P1', threshold: 2 },
  gateway_unreachable: { severity: 'P1', threshold: 2 },
  latency_p95: { severity: 'P2', threshold: 10 },
  rate_limit_spike: { severity: 'P2', threshold: 2 },
  server_error_ratio: { severity: 'P1', threshold: 5 },
});
const ALERT_IDS = Object.freeze(Object.keys(ALERT_RULES).sort());

function fail(message = 'operations collector input is invalid') {
  throw new Error(message);
}

function normalizeBaseUrl(value, allowLoopbackHttp) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    fail('operations collector base URL is invalid');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && loopback)) {
    fail('operations collector base URL must use HTTPS');
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    fail('operations collector base URL is invalid');
  }
  return parsed.origin;
}

function normalizeOperationsToken(value) {
  const token = String(value || '').trim();
  if (token.length < MIN_OPERATIONS_TOKEN_LENGTH || token.length > MAX_OPERATIONS_TOKEN_LENGTH) {
    fail('operations collector token is invalid');
  }
  return token;
}

async function fetchJsonProbe(origin, pathname, headers, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${origin}${pathname}`, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { networkOk: false, httpStatus: 0, body: null };
  }

  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
    fail('operations collector probe failed');
  }

  let text;
  try {
    text = await response.text();
  } catch {
    fail('operations collector probe failed');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    fail('operations collector probe failed');
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail('operations collector probe failed');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('operations collector probe failed');
  }

  return {
    networkOk: true,
    httpStatus: Number(response.status),
    body,
  };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function projectOperationsBody(probe) {
  const ok = probe.networkOk
    && probe.httpStatus === 200
    && probe.body
    && probe.body.ok === true;
  if (!ok) {
    return {
      networkOk: probe.networkOk,
      httpStatus: probe.httpStatus,
      ok: false,
      metrics: null,
      requestSafety: null,
    };
  }

  const total = nonNegativeInteger(probe.body?.metrics?.requests?.total);
  const serverErrors = nonNegativeInteger(probe.body?.metrics?.requests?.serverErrors);
  const p95Ms = finiteNonNegative(probe.body?.metrics?.latency?.p95Ms);
  const targetMs = finiteNonNegative(probe.body?.metrics?.latency?.targetMs);
  const sloState = String(probe.body?.metrics?.slo?.state || '');
  const accepted = nonNegativeInteger(probe.body?.requestSafety?.accepted);
  const rejectedCapacity = nonNegativeInteger(probe.body?.requestSafety?.rejectedCapacity);
  const rejectedRate = nonNegativeInteger(probe.body?.requestSafety?.rejectedRate);
  if (
    total === null
    || serverErrors === null
    || p95Ms === null
    || targetMs === null
    || !SLO_STATES.has(sloState)
    || accepted === null
    || rejectedCapacity === null
    || rejectedRate === null
  ) {
    fail('operations collector probe failed');
  }

  return {
    networkOk: true,
    httpStatus: 200,
    ok: true,
    metrics: {
      requests: { total, serverErrors },
      latency: { p95Ms, targetMs },
      slo: { state: sloState },
    },
    requestSafety: {
      accepted,
      rejectedCapacity,
      rejectedRate,
    },
  };
}

async function collectOperationsWindow({
  baseUrl = '',
  operationsToken = '',
  allowLoopbackHttp = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = normalizeBaseUrl(baseUrl, allowLoopbackHttp);
  const token = normalizeOperationsToken(operationsToken);
  if (typeof fetchImpl !== 'function') fail('operations collector requires fetch');

  const [readyProbe, operationsProbe] = await Promise.all([
    fetchJsonProbe(
      origin,
      '/api/ready',
      { Accept: 'application/json' },
      fetchImpl,
    ),
    fetchJsonProbe(
      origin,
      '/api/operations/status',
      { Accept: 'application/json', Authorization: `Bearer ${token}` },
      fetchImpl,
    ),
  ]);

  return {
    ready: {
      networkOk: readyProbe.networkOk,
      httpStatus: readyProbe.httpStatus,
      ok: Boolean(
        readyProbe.networkOk
        && readyProbe.httpStatus === 200
        && readyProbe.body
        && readyProbe.body.ok === true,
      ),
    },
    operations: projectOperationsBody(operationsProbe),
  };
}

function normalizeObservedAt(value) {
  const text = String(value || '');
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    fail('operations collector observedAt is invalid');
  }
  return text;
}

function emptyStreaks() {
  return Object.fromEntries(ALERT_IDS.map((id) => [id, 0]));
}

function normalizeCounters(value = {}) {
  const counters = {
    totalRequests: nonNegativeInteger(value.totalRequests),
    serverErrors: nonNegativeInteger(value.serverErrors),
    rejectedCapacity: nonNegativeInteger(value.rejectedCapacity),
    rejectedRate: nonNegativeInteger(value.rejectedRate),
  };
  if (Object.values(counters).some((item) => item === null)) {
    fail('collector state is invalid');
  }
  return counters;
}

function normalizeCollectorState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    fail('collector state is invalid');
  }
  const observedAt = normalizeObservedAt(value.observedAt);
  const counters = normalizeCounters(value.counters);
  const streaks = emptyStreaks();
  for (const id of ALERT_IDS) {
    const streak = nonNegativeInteger(value.streaks?.[id]);
    if (streak === null || streak > 1_000_000) fail('collector state is invalid');
    streaks[id] = streak;
  }
  if (!Array.isArray(value.activeAlertIds)) fail('collector state is invalid');
  const activeAlertIds = [...new Set(value.activeAlertIds.map((id) => String(id)))].sort();
  if (activeAlertIds.some((id) => !ALERT_RULES[id])) fail('collector state is invalid');
  return {
    schemaVersion: 1,
    observedAt,
    counters,
    streaks,
    activeAlertIds,
  };
}

function currentCounters(current) {
  if (!current?.operations?.ok) return null;
  return {
    totalRequests: current.operations.metrics.requests.total,
    serverErrors: current.operations.metrics.requests.serverErrors,
    rejectedCapacity: current.operations.requestSafety.rejectedCapacity,
    rejectedRate: current.operations.requestSafety.rejectedRate,
  };
}

function evaluateOperationsAlertWindow({
  previousState = null,
  current,
  observedAt,
  rateRejectThreshold = 100,
} = {}) {
  const timestamp = normalizeObservedAt(observedAt);
  if (!current || typeof current !== 'object' || !current.ready || !current.operations) {
    fail('operations collector window is invalid');
  }
  const previous = previousState === null ? null : normalizeCollectorState(previousState);
  const currentCounterValues = currentCounters(current);
  const previousCounters = previous?.counters || null;
  const counterReset = Boolean(
    currentCounterValues
    && previousCounters
    && (
      currentCounterValues.totalRequests < previousCounters.totalRequests
      || currentCounterValues.serverErrors < previousCounters.serverErrors
      || currentCounterValues.rejectedCapacity < previousCounters.rejectedCapacity
      || currentCounterValues.rejectedRate < previousCounters.rejectedRate
    )
  );
  const hasDelta = Boolean(currentCounterValues && previousCounters && !counterReset);
  const deltas = {
    deltaRequests: hasDelta
      ? currentCounterValues.totalRequests - previousCounters.totalRequests
      : 0,
    deltaServerErrors: hasDelta
      ? currentCounterValues.serverErrors - previousCounters.serverErrors
      : 0,
    deltaRejectedCapacity: hasDelta
      ? currentCounterValues.rejectedCapacity - previousCounters.rejectedCapacity
      : 0,
    deltaRejectedRate: hasDelta
      ? currentCounterValues.rejectedRate - previousCounters.rejectedRate
      : 0,
  };
  const operationsUsable = current.operations.networkOk === true
    && current.operations.httpStatus === 200
    && current.operations.ok === true;
  const safeRateThreshold = Number.isSafeInteger(rateRejectThreshold) && rateRejectThreshold >= 1
    ? rateRejectThreshold
    : 100;
  const conditions = {
    gateway_unreachable: current.ready.networkOk === false
      || current.operations.networkOk === false
      || (
        current.operations.networkOk === true
        && ![200, 401, 403, 503].includes(current.operations.httpStatus)
      ),
    collector_auth: current.operations.networkOk === true
      ? [401, 403, 503].includes(current.operations.httpStatus)
      : null,
    deployment_readiness: current.ready.networkOk === true ? current.ready.ok !== true : null,
    availability_slo: operationsUsable
      ? current.operations.metrics.slo.state === 'breached'
      : null,
    latency_p95: operationsUsable
      ? current.operations.metrics.latency.p95Ms > current.operations.metrics.latency.targetMs
      : null,
    server_error_ratio: hasDelta && deltas.deltaRequests > 0
      ? deltas.deltaServerErrors / deltas.deltaRequests > 0.01
      : (hasDelta ? false : null),
    capacity_pressure: hasDelta ? deltas.deltaRejectedCapacity > 0 : null,
    rate_limit_spike: hasDelta ? deltas.deltaRejectedRate >= safeRateThreshold : null,
  };

  const priorStreaks = previous?.streaks || emptyStreaks();
  const priorActive = new Set(previous?.activeAlertIds || []);
  const streaks = {};
  const active = new Set(priorActive);
  const transitions = [];

  for (const id of ALERT_IDS) {
    const condition = conditions[id];
    const rule = ALERT_RULES[id];
    if (condition === null) {
      streaks[id] = priorStreaks[id] || 0;
      continue;
    }
    streaks[id] = condition ? Math.min(1_000_000, (priorStreaks[id] || 0) + 1) : 0;
    if (condition && streaks[id] >= rule.threshold && !active.has(id)) {
      active.add(id);
      transitions.push({ id, severity: rule.severity, type: 'raised' });
    } else if (!condition && active.has(id)) {
      active.delete(id);
      transitions.push({ id, severity: rule.severity, type: 'resolved' });
    }
  }

  const activeAlertIds = [...active].sort();
  const nextCounters = currentCounterValues || previousCounters || {
    totalRequests: 0,
    serverErrors: 0,
    rejectedCapacity: 0,
    rejectedRate: 0,
  };
  const state = {
    schemaVersion: 1,
    observedAt: timestamp,
    counters: nextCounters,
    streaks,
    activeAlertIds,
  };
  const activeAlerts = activeAlertIds.map((id) => ({
    id,
    severity: ALERT_RULES[id].severity,
  }));
  const metrics = operationsUsable ? {
    totalRequests: current.operations.metrics.requests.total,
    serverErrors: current.operations.metrics.requests.serverErrors,
    p95Ms: current.operations.metrics.latency.p95Ms,
    targetMs: current.operations.metrics.latency.targetMs,
    sloState: current.operations.metrics.slo.state,
    accepted: current.operations.requestSafety.accepted,
    rejectedCapacity: current.operations.requestSafety.rejectedCapacity,
    rejectedRate: current.operations.requestSafety.rejectedRate,
  } : null;

  return {
    state,
    evidence: {
      schemaVersion: 1,
      kind: 'operations_alert_window',
      observedAt: timestamp,
      readiness: {
        httpStatus: Number(current.ready.httpStatus) || 0,
        ok: current.ready.ok === true,
      },
      operations: {
        httpStatus: Number(current.operations.httpStatus) || 0,
        ok: current.operations.ok === true,
      },
      metrics,
      counters: {
        reset: counterReset,
        ...deltas,
      },
      alerts: {
        active: activeAlerts,
        transitions: transitions.sort((a, b) => a.id.localeCompare(b.id)),
      },
      exitCode: activeAlerts.some((alert) => alert.severity === 'P1') ? 2 : 0,
    },
  };
}

function readCollectorState(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('collector state is invalid');
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_DOCUMENT_BYTES) {
    fail('collector state is invalid');
  }
  if ((stats.mode & 0o077) !== 0) fail('collector state is invalid');

  let parsed;
  try {
    const text = fs.readFileSync(resolved, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) fail('collector state is invalid');
    parsed = JSON.parse(text);
  } catch {
    fail('collector state is invalid');
  }
  return normalizeCollectorState(parsed);
}

function writeCollectorState(filePath, state) {
  const normalized = normalizeCollectorState(state);
  const resolved = path.resolve(String(filePath || ''));
  const directory = path.dirname(resolved);
  const name = path.basename(resolved);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
    fail('collector state is invalid');
  }

  try {
    const existing = fs.lstatSync(resolved);
    if (!existing.isFile() || existing.isSymbolicLink()) fail('collector state is invalid');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  const temporary = path.join(directory, `.${name}.${process.pid}.${Date.now()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } catch {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(temporary);
    } catch {}
    fail('collector state write failed');
  }
}

module.exports = {
  collectOperationsWindow,
  evaluateOperationsAlertWindow,
  readCollectorState,
  writeCollectorState,
};
