'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');

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

function percentile95(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0;
}

function readyRuntime({ query } = {}) {
  return {
    pool: {
      async query() {
        if (query) return query();
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
      clientId: 'client_rehearsal',
      apiKeyConfigured: true,
    },
  };
}

function productionEnv(overrides = {}) {
  return {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_OPERATIONS_TOKEN: 'operation-rehearsal-token-value-000000000000',
    AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
    AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT: '64',
    AGENT_CALENDAR_REQUESTS_PER_WINDOW: '5',
    AGENT_CALENDAR_REQUEST_WINDOW_MS: '60000',
    AGENT_CALENDAR_JSON_BODY_MAX_BYTES: '1024',
    AGENT_CALENDAR_MULTIPART_BODY_MAX_BYTES: '2048',
    AGENT_CALENDAR_BODY_TIMEOUT_MS: '1000',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
    ...overrides,
  };
}

async function runConcurrentReady(baseUrl, count, concurrency) {
  const durations = [];
  const statuses = [];
  let next = 0;
  const worker = async (workerIndex) => {
    while (next < count) {
      const index = next;
      next += 1;
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/api/ready`, {
        headers: { authorization: `Bearer load-caller-${workerIndex}-${index}` },
      });
      durations.push(performance.now() - startedAt);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  return { durations, statuses };
}

function requestChunkedOverflow(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
      });
    });
    request.on('error', reject);
    request.write('{"screenHint":"');
    request.write('x'.repeat(1_100));
    request.end('"}');
  });
}

async function runPrimaryScenario() {
  const env = productionEnv();
  const server = createRailwayGatewayServer({
    env,
    phase1Runtime: readyRuntime(),
    operationsLogger: () => {},
  });
  const baseUrl = await listen(server);
  try {
    const load = await runConcurrentReady(baseUrl, 100, 20);
    assert.equal(load.statuses.filter((status) => status === 200).length, 100);

    const overflow = await requestChunkedOverflow(
      `${baseUrl}/api/phase1/auth/desktop/start`,
    );
    assert.equal(overflow.status, 413);
    assert.equal(overflow.body.error, 'PAYLOAD_TOO_LARGE');

    const rateStatuses = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${baseUrl}/api/ready`, {
        headers: { authorization: 'Bearer rate-rehearsal-caller' },
      });
      rateStatuses.push({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      });
      await response.arrayBuffer();
    }
    assert.deepEqual(rateStatuses.map((item) => item.status), [200, 200, 200, 200, 200, 429]);

    const isolated = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer isolated-rehearsal-caller' },
    });
    assert.equal(isolated.status, 200);
    await isolated.arrayBuffer();

    const operations = await fetch(`${baseUrl}/api/operations/status`, {
      headers: { authorization: `Bearer ${env.AGENT_CALENDAR_OPERATIONS_TOKEN}` },
    });
    assert.equal(operations.status, 200);
    const operationsBody = await operations.json();
    assert.equal(operationsBody.requestSafety.rejectedRate, 1);

    return {
      normalLoad: {
        requests: 100,
        concurrency: 20,
        successful: 100,
        p95ClientMs: Math.round(percentile95(load.durations)),
        maxClientMs: Math.round(Math.max(...load.durations)),
        gatewayP95Ms: operationsBody.metrics.latency.p95Ms,
      },
      bodyLimit: {
        streamedChunked: true,
        status: overflow.status,
        error: overflow.body.error,
      },
      rateIsolation: {
        acceptedBeforeLimit: 5,
        limitedStatus: rateStatuses.at(-1).status,
        retryAfterSeconds: Number(rateStatuses.at(-1).retryAfter),
        isolatedCallerStatus: isolated.status,
      },
      requestSafety: operationsBody.requestSafety,
    };
  } finally {
    await close(server);
  }
}

async function runCapacityScenario() {
  let releaseProbe;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let queryCount = 0;
  const server = createRailwayGatewayServer({
    env: productionEnv({
      AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT: '1',
      AGENT_CALENDAR_REQUESTS_PER_WINDOW: '100',
    }),
    phase1Runtime: readyRuntime({
      query: async () => {
        queryCount += 1;
        if (queryCount === 1) {
          markStarted();
          await blocked;
        }
        return { rows: [{ ok: 1 }] };
      },
    }),
    operationsLogger: () => {},
  });
  const baseUrl = await listen(server);
  try {
    const first = fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer capacity-first' },
    });
    await started;
    const rejected = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer capacity-second' },
    });
    const rejectedBody = await rejected.json();
    const health = await fetch(`${baseUrl}/api/health`);
    await health.arrayBuffer();

    releaseProbe();
    const firstResponse = await first;
    await firstResponse.arrayBuffer();
    const recovered = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer capacity-second' },
    });
    await recovered.arrayBuffer();

    assert.equal(rejected.status, 503);
    assert.equal(rejectedBody.error, 'gateway_over_capacity');
    assert.equal(health.status, 200);
    assert.equal(firstResponse.status, 200);
    assert.equal(recovered.status, 200);
    return {
      rejectedStatus: rejected.status,
      rejectedError: rejectedBody.error,
      healthStatusDuringPressure: health.status,
      originalStatusAfterRelease: firstResponse.status,
      recoveredStatus: recovered.status,
    };
  } finally {
    releaseProbe();
    await close(server);
  }
}

async function main() {
  const primary = await runPrimaryScenario();
  const capacity = await runCapacityScenario();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    primary,
    capacity,
    redaction: {
      aggregateOnly: true,
      tokenValuesAbsent: true,
      networkAddressesAbsent: true,
      workspaceIdentifiersAbsent: true,
    },
  };
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /operation-rehearsal-token|load-caller|rate-rehearsal|capacity-first|127\.0\.0\.1/i);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
