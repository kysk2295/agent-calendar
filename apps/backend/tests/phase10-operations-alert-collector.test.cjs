'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  collectOperationsWindow,
  evaluateOperationsAlertWindow,
  readCollectorState,
  writeCollectorState,
} = require('../app/lib/operations-alert-collector');

const COLLECTOR_CLI = path.resolve(
  __dirname,
  '../tools/phase10-operations-alert-collector.cjs',
);
const OPERATIONS_TOKEN = 'phase10-alert-collector-token-value-000000';
const OBSERVED_AT = '2026-07-25T04:00:00.000Z';

function operationWindow({
  ready = true,
  operationsStatus = 200,
  total = 100,
  accepted = total,
  errors = 0,
  p95Ms = 100,
  sloState = 'meeting',
  rejectedCapacity = 0,
  rejectedRate = 0,
} = {}) {
  return {
    ready: { networkOk: true, httpStatus: ready ? 200 : 503, ok: ready },
    operations: {
      networkOk: true,
      httpStatus: operationsStatus,
      ok: operationsStatus === 200,
      metrics: operationsStatus === 200 ? {
        requests: { total, serverErrors: errors },
        latency: { p95Ms, targetMs: 2_000 },
        slo: { state: sloState },
      } : null,
      requestSafety: operationsStatus === 200 ? {
        accepted,
        rejectedCapacity,
        rejectedRate,
      } : null,
    },
  };
}

function evaluate(previousState, current, minute) {
  return evaluateOperationsAlertWindow({
    previousState,
    current,
    observedAt: new Date(Date.parse(OBSERVED_AT) + minute * 60_000).toISOString(),
    rateRejectThreshold: 10,
  });
}

function jsonResponse(status, body) {
  return {
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('alert evaluator applies consecutive thresholds and emits raised/resolved transitions', () => {
  let state = evaluate(null, operationWindow(), 0).state;

  let result = evaluate(state, operationWindow({ ready: false }), 1);
  assert.deepEqual(result.evidence.alerts.active, []);
  state = result.state;

  result = evaluate(state, operationWindow({ ready: false }), 2);
  assert.deepEqual(result.evidence.alerts.transitions, [
    { id: 'deployment_readiness', severity: 'P1', type: 'raised' },
  ]);
  assert.deepEqual(result.evidence.alerts.active, [
    { id: 'deployment_readiness', severity: 'P1' },
  ]);
  state = result.state;

  result = evaluate(state, operationWindow(), 3);
  assert.deepEqual(result.evidence.alerts.transitions, [
    { id: 'deployment_readiness', severity: 'P1', type: 'resolved' },
  ]);
  assert.deepEqual(result.evidence.alerts.active, []);
});

test('alert evaluator covers SLO, 5xx, latency, auth, capacity, and rate rules', () => {
  let state = evaluate(null, operationWindow(), 0).state;
  let result;

  for (let minute = 1; minute <= 10; minute += 1) {
    result = evaluate(state, operationWindow({
      total: 100 + minute * 100,
      errors: minute * 2,
      p95Ms: 2_500,
      sloState: 'breached',
      rejectedCapacity: minute,
      rejectedRate: minute * 10,
    }), minute);
    state = result.state;
  }

  assert.deepEqual(result.evidence.alerts.active, [
    { id: 'availability_slo', severity: 'P1' },
    { id: 'capacity_pressure', severity: 'P1' },
    { id: 'latency_p95', severity: 'P2' },
    { id: 'rate_limit_spike', severity: 'P2' },
    { id: 'server_error_ratio', severity: 'P1' },
  ]);
  assert.deepEqual(result.evidence.metrics, {
    totalRequests: 1_100,
    serverErrors: 20,
    p95Ms: 2_500,
    targetMs: 2_000,
    sloState: 'breached',
    accepted: 1_100,
    rejectedCapacity: 10,
    rejectedRate: 100,
  });
  assert.equal(result.evidence.exitCode, 2);

  const unauthorized = evaluate(state, operationWindow({ operationsStatus: 401 }), 11);
  assert.ok(
    unauthorized.evidence.alerts.active.some((alert) => alert.id === 'collector_auth'),
  );
  assert.doesNotMatch(JSON.stringify(unauthorized), new RegExp(OPERATIONS_TOKEN));
});

test('counter reset establishes a new baseline without false delta alerts', () => {
  let state = evaluate(null, operationWindow({
    total: 1_000,
    errors: 50,
    rejectedCapacity: 20,
    rejectedRate: 200,
  }), 0).state;

  const result = evaluate(state, operationWindow({
    total: 1,
    errors: 0,
    rejectedCapacity: 0,
    rejectedRate: 0,
  }), 1);

  assert.equal(result.evidence.counters.reset, true);
  assert.equal(result.evidence.counters.deltaRequests, 0);
  assert.equal(result.evidence.counters.deltaServerErrors, 0);
  assert.deepEqual(result.evidence.alerts.active, []);
});

test('network and unexpected operations responses raise bounded gateway alerts', async () => {
  const current = await collectOperationsWindow({
    baseUrl: 'https://calendar.example.test',
    operationsToken: OPERATIONS_TOKEN,
    fetchImpl: async () => {
      throw new Error('private-network-detail');
    },
  });
  let result = evaluate(null, current, 0);
  result = evaluate(result.state, current, 1);
  assert.deepEqual(result.evidence.alerts.active, [
    { id: 'gateway_unreachable', severity: 'P1' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-network-detail|calendar\.example/i);

  const unexpected = operationWindow({ operationsStatus: 500 });
  result = evaluate(null, unexpected, 2);
  result = evaluate(result.state, unexpected, 3);
  assert.deepEqual(result.evidence.alerts.active, [
    { id: 'gateway_unreachable', severity: 'P1' },
  ]);
});

test('collector probes exact bounded surfaces without reflecting origin, token, or response extras', async () => {
  const calls = [];
  const current = await collectOperationsWindow({
    baseUrl: 'https://calendar.example.test',
    operationsToken: OPERATIONS_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const pathname = new URL(url).pathname;
      if (pathname === '/api/ready') {
        return jsonResponse(200, { ok: true, status: 'ready', private: 'do-not-copy' });
      }
      return jsonResponse(200, {
        ok: true,
        metrics: {
          requests: { total: 42, serverErrors: 1, routes: [{ route: '/secret' }] },
          latency: { p95Ms: 120, targetMs: 2_000 },
          slo: { state: 'meeting' },
        },
        requestSafety: {
          accepted: 40,
          rejectedCapacity: 1,
          rejectedRate: 2,
          private: 'do-not-copy',
        },
        private: 'do-not-copy',
      });
    },
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname).sort(), [
    '/api/operations/status',
    '/api/ready',
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(
    calls.find((call) => new URL(call.url).pathname === '/api/operations/status')
      .options.headers.Authorization,
    `Bearer ${OPERATIONS_TOKEN}`,
  );
  assert.deepEqual(current, operationWindow({
    total: 42,
    accepted: 40,
    errors: 1,
    p95Ms: 120,
    rejectedCapacity: 1,
    rejectedRate: 2,
  }));
  assert.doesNotMatch(
    JSON.stringify(current),
    /calendar\.example|do-not-copy|\/secret|phase10-alert/,
  );

  await assert.rejects(
    () => collectOperationsWindow({
      baseUrl: 'https://calendar.example.test',
      operationsToken: OPERATIONS_TOKEN,
      fetchImpl: async () => jsonResponse(200, { ok: true, padding: 'x'.repeat(70 * 1024) }),
    }),
    /operations collector probe failed/i,
  );
});

test('collector state is atomic owner-only and rejects corrupt, oversized, or symlink state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-alert-state-'));
  const statePath = path.join(directory, 'collector.json');
  const targetPath = path.join(directory, 'target.json');
  const symlinkPath = path.join(directory, 'state-link.json');
  const state = evaluate(null, operationWindow(), 0).state;

  try {
    assert.equal(readCollectorState(statePath), null);
    writeCollectorState(statePath, state);
    assert.deepEqual(readCollectorState(statePath), state);
    assert.equal(fs.statSync(statePath).mode & 0o077, 0);

    fs.writeFileSync(statePath, '{bad', { mode: 0o600 });
    assert.throws(() => readCollectorState(statePath), /collector state is invalid/i);

    fs.writeFileSync(statePath, 'x'.repeat(70 * 1024), { mode: 0o600 });
    assert.throws(() => readCollectorState(statePath), /collector state is invalid/i);

    fs.writeFileSync(targetPath, JSON.stringify(state), { mode: 0o600 });
    fs.symlinkSync(targetPath, symlinkPath);
    assert.throws(() => readCollectorState(symlinkPath), /collector state is invalid/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collector CLI requires explicit production inputs', () => {
  const result = spawnSync(process.execPath, [COLLECTOR_CLI], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--base-url is required/i);
  assert.doesNotMatch(result.stderr, /Usage:/);
});

test('collector observes a real local production-mode Gateway', async () => {
  const env = {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_OPERATIONS_TOKEN: OPERATIONS_TOKEN,
    AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
  };
  const server = createRailwayGatewayServer({
    env,
    phase1Runtime: {
      pool: { async query() { return { rows: [{ ok: 1 }] }; } },
      product: {},
      runnerControl: {},
      durableExecution: {},
      unifiedCalendar: {},
      knowledge: {},
      automationFederation: {},
      calendarAi: {},
      authKit: {},
      workosConfig: { clientId: 'fixture-client', apiKeyConfigured: true },
    },
    operationsLogger: () => {},
  });
  const baseUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });

  try {
    const current = await collectOperationsWindow({
      baseUrl,
      operationsToken: OPERATIONS_TOKEN,
      allowLoopbackHttp: true,
    });
    const result = evaluate(null, current, 0);
    assert.equal(current.ready.ok, true);
    assert.equal(current.operations.ok, true);
    assert.deepEqual(result.evidence.alerts.active, []);
    assert.equal(result.evidence.exitCode, 0);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('collector raises readiness P1 after two real unready Gateway windows', async () => {
  const env = {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_OPERATIONS_TOKEN: OPERATIONS_TOKEN,
    AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
  };
  const server = createRailwayGatewayServer({
    env,
    phase1Runtime: {
      pool: { async query() { return { rows: [{ ok: 1 }] }; } },
      product: {},
      runnerControl: {},
      durableExecution: {},
      unifiedCalendar: {},
      knowledge: {},
      automationFederation: {},
      calendarAi: {},
      authKit: {},
      workosConfig: { clientId: '', apiKeyConfigured: false },
    },
    operationsLogger: () => {},
  });
  const baseUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });

  try {
    let state = null;
    let result;
    for (let minute = 0; minute < 2; minute += 1) {
      const current = await collectOperationsWindow({
        baseUrl,
        operationsToken: OPERATIONS_TOKEN,
        allowLoopbackHttp: true,
      });
      result = evaluate(state, current, minute);
      state = result.state;
    }
    assert.deepEqual(result.evidence.alerts.transitions, [
      { id: 'deployment_readiness', severity: 'P1', type: 'raised' },
    ]);
    assert.equal(result.evidence.exitCode, 2);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
