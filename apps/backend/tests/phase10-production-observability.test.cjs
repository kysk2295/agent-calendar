'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  authorizeOperationsRequest,
  createProductionObservability,
  operationRouteLabel,
  probeProductionReadiness,
} = require('../app/lib/production-observability');
const { matchProductionRoute } = require('../app/lib/production-route-registry');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readyRuntime({ databaseError = null } = {}) {
  return {
    pool: {
      async query(sql) {
        assert.match(String(sql), /select\s+1/i);
        if (databaseError) throw databaseError;
        return { rows: [{ ok: 1 }] };
      },
    },
    product: {},
    runnerControl: {},
    durableExecution: {},
    unifiedCalendar: {},
    knowledge: {},
    automationFederation: {},
    calendarAi: {},
    authKit: {},
    workosConfig: {
      clientId: 'client_test',
      apiKeyConfigured: true,
    },
  };
}

function readyEnv() {
  return {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_OPERATIONS_TOKEN: 'o'.repeat(48),
    AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
  };
}

test('request monitor uses route templates, safe correlation IDs, and a bounded SLO window', () => {
  let now = 1_000;
  let uuidSequence = 0;
  const monitor = createProductionObservability({
    now: () => now,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
    minimumSloSamples: 2,
    maxSamples: 3,
  });

  const first = monitor.beginRequest({
    method: 'GET',
    pathname: '/api/runs/private-run-id',
    requestId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(first.requestId, '11111111-1111-4111-8111-111111111111');
  assert.equal(first.route, '/api/runs/:id');
  now += 120;
  const firstLog = first.finish(200);

  const second = monitor.beginRequest({
    method: 'GET',
    pathname: '/api/not-registered/workspace-secret',
    requestId: 'bad id with spaces',
  });
  assert.match(second.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(second.route, '/api/unregistered');
  now += 2_300;
  second.finish(503);
  second.finish(200);

  assert.deepEqual(
    Object.keys(firstLog).sort(),
    ['durationMs', 'event', 'method', 'requestId', 'route', 'statusClass', 'statusCode'].sort(),
  );
  assert.equal(firstLog.route, '/api/runs/:id');
  assert.doesNotMatch(JSON.stringify(firstLog), /private-run-id|workspace-secret/);

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.requests.total, 2);
  assert.equal(snapshot.requests.active, 0);
  assert.equal(snapshot.requests.serverErrors, 1);
  assert.equal(snapshot.latency.p95Ms, 2_300);
  assert.equal(snapshot.slo.state, 'breached');
  assert.doesNotMatch(JSON.stringify(snapshot), /private-run-id|workspace-secret|11111111/);
});

test('readiness separates liveness from production dependencies without leaking failures', async () => {
  const ready = await probeProductionReadiness({
    runtime: readyRuntime(),
    env: readyEnv(),
    now: () => Date.parse('2026-07-25T00:00:00.000Z'),
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(Object.values(ready.checks), [true, true, true, true, true, true]);

  const unavailable = await probeProductionReadiness({
    runtime: readyRuntime({ databaseError: new Error('postgres://secret@host/db') }),
    env: {
      ...readyEnv(),
      AGENT_CALENDAR_OPERATIONS_TOKEN: 'short',
      AGENT_CALENDAR_OBSERVABILITY_LOGS: '0',
    },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, 'not_ready');
  assert.equal(unavailable.checks.database, false);
  assert.equal(unavailable.checks.operationsAuth, false);
  assert.equal(unavailable.checks.requestLogging, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /postgres|secret|host/);
});

test('operations auth is separate, fail closed, and constant-shape', () => {
  const env = readyEnv();
  assert.deepEqual(authorizeOperationsRequest({}, env), {
    ok: false,
    status: 401,
    error: 'operations_unauthorized',
  });
  assert.deepEqual(
    authorizeOperationsRequest({ authorization: `Bearer ${env.AGENT_CALENDAR_OPERATIONS_TOKEN}` }, env),
    { ok: true, status: 200, error: null },
  );
  assert.deepEqual(authorizeOperationsRequest({ authorization: 'Bearer wrong' }, {}), {
    ok: false,
    status: 503,
    error: 'operations_auth_not_configured',
  });
});

test('production route inventory classifies readiness and private operations explicitly', () => {
  const ready = matchProductionRoute('GET', '/api/ready');
  const operations = matchProductionRoute('GET', '/api/operations/status');
  assert.equal(ready.route.class, 'public_infra');
  assert.equal(ready.route.action, 'readiness');
  assert.equal(operations.route.class, 'operations_private');
  assert.equal(operations.route.action, 'operations_status');
  assert.equal(operationRouteLabel('GET', '/api/runs/run-secret'), '/api/runs/:id');
  assert.equal(operationRouteLabel('GET', '/api/runs/%E0%A4%A'), '/api/unregistered');
});

test('real Gateway surface returns ready truth, protected metrics, and redacted logs', async () => {
  const logs = [];
  const env = readyEnv();
  const server = createRailwayGatewayServer({
    env,
    phase1Runtime: readyRuntime(),
    operationsLogger: (entry) => logs.push(entry),
  });
  const baseUrl = await listen(server);

  try {
    const health = await fetch(`${baseUrl}/api/health`, {
      headers: { 'x-request-id': '22222222-2222-4222-8222-222222222222' },
    });
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-request-id'), '22222222-2222-4222-8222-222222222222');
    assert.equal(healthBody.status, 'alive');
    assert.equal(healthBody.ready, undefined);

    const ready = await fetch(`${baseUrl}/api/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');

    const unauthorized = await fetch(`${baseUrl}/api/operations/status`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error, 'operations_unauthorized');

    const hiddenPath = 'workspace-secret-should-not-appear';
    const unregistered = await fetch(`${baseUrl}/api/not-registered/${hiddenPath}`);
    assert.equal(unregistered.status, 404);

    const authorized = await fetch(`${baseUrl}/api/operations/status`, {
      headers: {
        authorization: `Bearer ${env.AGENT_CALENDAR_OPERATIONS_TOKEN}`,
        cookie: 'session=secret-cookie',
      },
    });
    const status = await authorized.json();
    assert.equal(authorized.status, 200);
    assert.equal(status.ok, true);
    assert.equal(status.readiness.status, 'ready');
    assert.ok(status.metrics.requests.total >= 4);

    const serialized = JSON.stringify({ logs, status });
    assert.doesNotMatch(serialized, /workspace-secret-should-not-appear/);
    assert.doesNotMatch(serialized, /secret-cookie/);
    assert.doesNotMatch(serialized, new RegExp(env.AGENT_CALENDAR_OPERATIONS_TOKEN));
    assert.match(serialized, /\/api\/unregistered/);
  } finally {
    await close(server);
  }
});
