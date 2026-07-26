'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough, Readable } = require('node:stream');
const test = require('node:test');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  configureProductionServerTimeouts,
  createProductionRequestSafety,
  readBoundedRequestBody,
} = require('../app/lib/production-request-safety');

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

function readyRuntime({ query } = {}) {
  return {
    pool: {
      async query(sql) {
        assert.match(String(sql), /select\s+1/i);
        if (query) return query(sql);
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

function productionEnv(overrides = {}) {
  return {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_OPERATIONS_TOKEN: 'o'.repeat(48),
    AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
    AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT: '8',
    AGENT_CALENDAR_REQUESTS_PER_WINDOW: '100',
    AGENT_CALENDAR_REQUEST_WINDOW_MS: '60000',
    AGENT_CALENDAR_JSON_BODY_MAX_BYTES: '1024',
    AGENT_CALENDAR_MULTIPART_BODY_MAX_BYTES: '1024',
    AGENT_CALENDAR_BODY_TIMEOUT_MS: '1000',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
    ...overrides,
  };
}

function requestChunkedJson(url, chunks) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
    }, (response) => {
      const body = [];
      response.on('data', (chunk) => body.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(body).toString('utf8') || '{}'),
        });
      });
    });
    request.on('error', reject);
    chunks.forEach((chunk) => request.write(chunk));
    request.end();
  });
}

test('bounded body reader rejects declared and streamed overflow and times out stalled bodies', async () => {
  const declared = Readable.from([Buffer.from('small')]);
  declared.headers = { 'content-length': '99' };
  await assert.rejects(
    readBoundedRequestBody(declared, { maxBytes: 8, timeoutMs: 100 }),
    (error) => error.code === 'PAYLOAD_TOO_LARGE' && error.statusHint === 413,
  );

  const streamed = Readable.from([Buffer.from('1234'), Buffer.from('5678'), Buffer.from('9')]);
  streamed.headers = {};
  await assert.rejects(
    readBoundedRequestBody(streamed, { maxBytes: 8, timeoutMs: 100 }),
    (error) => error.code === 'PAYLOAD_TOO_LARGE' && error.statusHint === 413,
  );

  const stalled = new PassThrough();
  stalled.headers = {};
  await assert.rejects(
    readBoundedRequestBody(stalled, { maxBytes: 8, timeoutMs: 10 }),
    (error) => error.code === 'REQUEST_BODY_TIMEOUT' && error.statusHint === 408,
  );
  stalled.destroy();
});

test('admission is isolated by opaque caller fingerprint and exposes aggregate-only evidence', () => {
  let now = 1_000;
  const safety = createProductionRequestSafety({
    now: () => now,
    maxInFlight: 3,
    requestsPerWindow: 2,
    windowMs: 60_000,
  });
  const callerA = {
    pathname: '/api/tasks',
    headers: { authorization: 'Bearer caller-A-secret' },
    remoteAddress: '10.0.0.1',
  };
  const callerB = {
    pathname: '/api/tasks',
    headers: { authorization: 'Bearer caller-B-secret' },
    remoteAddress: '10.0.0.1',
  };

  const first = safety.admit(callerA);
  assert.equal(first.ok, true);
  first.release();
  const second = safety.admit(callerA);
  assert.equal(second.ok, true);
  second.release();
  const limited = safety.admit(callerA);
  assert.deepEqual(
    { ok: limited.ok, status: limited.status, error: limited.error, retryAfterSeconds: limited.retryAfterSeconds },
    { ok: false, status: 429, error: 'request_rate_limited', retryAfterSeconds: 60 },
  );

  const isolated = safety.admit(callerB);
  assert.equal(isolated.ok, true);
  isolated.release();

  now += 60_001;
  const recovered = safety.admit(callerA);
  assert.equal(recovered.ok, true);
  recovered.release();

  const serialized = JSON.stringify(safety.snapshot());
  assert.doesNotMatch(serialized, /caller-A|caller-B|10\.0\.0\.1|secret/i);
  assert.deepEqual(Object.keys(safety.snapshot()).sort(), [
    'accepted',
    'inFlight',
    'rejectedCapacity',
    'rejectedRate',
    'schemaVersion',
  ].sort());
});

test('rotating untrusted bearer strings cannot bypass the remote connection allowance', () => {
  const safety = createProductionRequestSafety({
    maxInFlight: 4,
    requestsPerWindow: 100,
    remoteRequestsPerWindow: 2,
    windowMs: 60_000,
  });
  const attempt = (bearer, address) => {
    const admitted = safety.admit({
      pathname: '/api/tasks',
      headers: { authorization: `Bearer ${bearer}` },
      remoteAddress: address,
    });
    if (admitted.ok) admitted.release();
    return admitted;
  };

  assert.equal(attempt('rotated-one', '10.0.0.1').ok, true);
  assert.equal(attempt('rotated-two', '10.0.0.1').ok, true);
  const blocked = attempt('rotated-three', '10.0.0.1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.error, 'request_rate_limited');
  assert.equal(attempt('rotated-four', '10.0.0.2').ok, true);
});

test('caller fingerprint storage is bounded and stale buckets are reclaimed', () => {
  let now = 1_000;
  const safety = createProductionRequestSafety({
    now: () => now,
    maxInFlight: 4,
    requestsPerWindow: 100,
    remoteRequestsPerWindow: 100,
    maxTrackedFingerprints: 3,
    windowMs: 1_000,
  });
  const attempt = (bearer) => {
    const admitted = safety.admit({
      pathname: '/api/tasks',
      headers: { authorization: `Bearer ${bearer}` },
      remoteAddress: '10.0.0.1',
    });
    if (admitted.ok) admitted.release();
    return admitted;
  };

  assert.equal(attempt('caller-one').ok, true);
  assert.equal(attempt('caller-two').ok, true);
  const saturated = attempt('caller-three');
  assert.equal(saturated.ok, false);
  assert.equal(saturated.status, 503);
  assert.equal(saturated.error, 'gateway_over_capacity');

  now += 2_001;
  assert.equal(attempt('caller-three').ok, true);
});

test('global capacity fails fast, recovers exactly once, and leaves health available', () => {
  const safety = createProductionRequestSafety({
    maxInFlight: 1,
    requestsPerWindow: 100,
    windowMs: 60_000,
  });
  const first = safety.admit({
    pathname: '/api/ready',
    headers: { authorization: 'Bearer first' },
    remoteAddress: '10.0.0.1',
  });
  assert.equal(first.ok, true);

  const capacity = safety.admit({
    pathname: '/api/ready',
    headers: { authorization: 'Bearer second' },
    remoteAddress: '10.0.0.2',
  });
  assert.deepEqual(
    { ok: capacity.ok, status: capacity.status, error: capacity.error },
    { ok: false, status: 503, error: 'gateway_over_capacity' },
  );

  const health = safety.admit({
    pathname: '/api/health',
    headers: {},
    remoteAddress: '10.0.0.3',
  });
  assert.equal(health.ok, true);
  health.release();
  first.release();
  first.release();
  assert.equal(safety.snapshot().inFlight, 0);

  const recovered = safety.admit({
    pathname: '/api/ready',
    headers: { authorization: 'Bearer second' },
    remoteAddress: '10.0.0.2',
  });
  assert.equal(recovered.ok, true);
  recovered.release();
});

test('production server applies bounded connection timeouts', () => {
  const server = http.createServer();
  configureProductionServerTimeouts(server, productionEnv({
    AGENT_CALENDAR_REQUEST_TIMEOUT_MS: '12000',
    AGENT_CALENDAR_HEADERS_TIMEOUT_MS: '7000',
    AGENT_CALENDAR_KEEP_ALIVE_TIMEOUT_MS: '3000',
  }));
  assert.equal(server.requestTimeout, 12_000);
  assert.equal(server.headersTimeout, 7_000);
  assert.equal(server.keepAliveTimeout, 3_000);
  server.close();
});

test('real production Gateway rejects chunked overflow with 413 before AuthKit work', async () => {
  const authKitCalls = [];
  const runtime = readyRuntime();
  runtime.authKit = {
    async getAuthorizationUrl() {
      authKitCalls.push('authorization');
      return 'https://auth.example.test';
    },
  };
  const server = createRailwayGatewayServer({
    env: productionEnv({ AGENT_CALENDAR_JSON_BODY_MAX_BYTES: '1024' }),
    phase1Runtime: runtime,
    operationsLogger: () => {},
  });
  const baseUrl = await listen(server);
  try {
    const response = await requestChunkedJson(
      `${baseUrl}/api/phase1/auth/desktop/start`,
      ['{"screenHint":"', 'x'.repeat(1_100), '"}'],
    );
    assert.equal(response.status, 413);
    assert.equal(response.body.error, 'PAYLOAD_TOO_LARGE');
    assert.equal(authKitCalls.length, 0);
  } finally {
    await close(server);
  }
});

test('real production Gateway rate limits one caller without consuming another caller quota', async () => {
  const env = productionEnv({
    AGENT_CALENDAR_REQUESTS_PER_WINDOW: '2',
    AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT: '4',
  });
  const server = createRailwayGatewayServer({
    env,
    phase1Runtime: readyRuntime(),
    operationsLogger: () => {},
  });
  const baseUrl = await listen(server);
  try {
    const requestReady = (bearer) => fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    assert.equal((await requestReady('caller-A-secret')).status, 200);
    assert.equal((await requestReady('caller-A-secret')).status, 200);
    const limited = await requestReady('caller-A-secret');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await limited.json()).error, 'request_rate_limited');
    assert.equal((await requestReady('caller-B-secret')).status, 200);

    const operations = await fetch(`${baseUrl}/api/operations/status`, {
      headers: { authorization: `Bearer ${env.AGENT_CALENDAR_OPERATIONS_TOKEN}` },
    });
    assert.equal(operations.status, 200);
    const body = await operations.json();
    assert.equal(body.requestSafety.rejectedRate, 1);
    assert.doesNotMatch(JSON.stringify(body), /caller-A|caller-B|secret/i);
  } finally {
    await close(server);
  }
});

test('real production Gateway sheds excess concurrency while health stays live and recovers', async () => {
  let releaseProbe;
  let startedProbe;
  const probeStarted = new Promise((resolve) => {
    startedProbe = resolve;
  });
  const blockedProbe = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let probeCount = 0;
  const runtime = readyRuntime({
    query: async () => {
      probeCount += 1;
      if (probeCount === 1) {
        startedProbe();
        await blockedProbe;
      }
      return { rows: [{ ok: 1 }] };
    },
  });
  const server = createRailwayGatewayServer({
    env: productionEnv({
      AGENT_CALENDAR_REQUEST_MAX_IN_FLIGHT: '1',
      AGENT_CALENDAR_REQUESTS_PER_WINDOW: '100',
    }),
    phase1Runtime: runtime,
    operationsLogger: () => {},
  });
  const baseUrl = await listen(server);
  try {
    const first = fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer caller-A' },
    });
    await probeStarted;

    const capacity = await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer caller-B' },
    });
    assert.equal(capacity.status, 503);
    assert.equal((await capacity.json()).error, 'gateway_over_capacity');

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);

    releaseProbe();
    assert.equal((await first).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/ready`, {
      headers: { authorization: 'Bearer caller-B' },
    })).status, 200);
  } finally {
    releaseProbe();
    await close(server);
  }
});
