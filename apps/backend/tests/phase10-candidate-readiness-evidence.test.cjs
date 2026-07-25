'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  collectCandidateReadinessEvidence,
} = require('../app/lib/candidate-readiness-evidence');

const RELEASE_GATE_CLI = path.resolve(
  __dirname,
  '../../../scripts/railway-release-gate.cjs',
);
const CAPTURED_AT = '2026-07-25T13:00:00.000Z';
const COMMIT = 'c'.repeat(40);

function binding() {
  return {
    deploymentId: 'candidate-deployment',
    commit: COMMIT,
    environmentId: 'staging-environment',
    serviceId: 'staging-service',
  };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function successfulFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname === '/api/gateway-status') {
      return jsonResponse(200, {
        buildCommit: COMMIT.slice(0, 12),
        deploymentId: 'candidate-deployment',
      });
    }
    return jsonResponse(200, { ok: true });
  };
}

test('candidate readiness producer probes exact public paths and emits bounded evidence', async () => {
  const calls = [];
  const evidence = await collectCandidateReadinessEvidence({
    baseUrl: 'https://staging.example.test',
    binding: binding(),
    fetchImpl: successfulFetch(calls),
    clock: () => new Date(CAPTURED_AT),
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname).sort(), [
    '/api/gateway-status',
    '/api/health',
    '/api/ready',
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Accept, 'application/json');
  }
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    kind: 'gateway_readiness',
    capturedAt: CAPTURED_AT,
    binding: binding(),
    probe: { path: '/api/ready', httpStatus: 200, ok: true },
    health: { path: '/api/health', httpStatus: 200, ok: true },
    provenance: {
      path: '/api/gateway-status',
      httpStatus: 200,
      deploymentId: 'candidate-deployment',
      buildCommitPrefix: COMMIT.slice(0, 12),
    },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /staging\.example\.test/);
});

test('candidate readiness producer fails closed for URL, provenance, and readiness drift', async () => {
  await assert.rejects(
    () => collectCandidateReadinessEvidence({
      baseUrl: 'http://staging.example.test',
      binding: binding(),
      fetchImpl: successfulFetch(),
    }),
    /HTTPS/i,
  );
  await assert.rejects(
    () => collectCandidateReadinessEvidence({
      baseUrl: 'https://staging.example.test/private-value',
      binding: binding(),
      fetchImpl: successfulFetch(),
    }),
    (error) => {
      assert.match(error.message, /base URL/i);
      assert.doesNotMatch(error.message, /private-value|staging\.example/i);
      return true;
    },
  );

  const cases = [
    {
      response(pathname) {
        return pathname === '/api/gateway-status'
          ? jsonResponse(200, { buildCommit: 'a'.repeat(12), deploymentId: 'candidate-deployment' })
          : jsonResponse(200, { ok: true });
      },
    },
    {
      response(pathname) {
        return pathname === '/api/gateway-status'
          ? jsonResponse(200, { buildCommit: COMMIT.slice(0, 12), deploymentId: 'other-deployment' })
          : jsonResponse(200, { ok: true });
      },
    },
    {
      response(pathname) {
        if (pathname === '/api/gateway-status') {
          return jsonResponse(200, {
            buildCommit: COMMIT.slice(0, 12),
            deploymentId: 'candidate-deployment',
          });
        }
        return pathname === '/api/health'
          ? jsonResponse(503, { ok: false })
          : jsonResponse(200, { ok: true });
      },
    },
    {
      response(pathname) {
        if (pathname === '/api/gateway-status') {
          return jsonResponse(200, {
            buildCommit: COMMIT.slice(0, 12),
            deploymentId: 'candidate-deployment',
          });
        }
        return pathname === '/api/ready'
          ? jsonResponse(401, { ok: false, secret: 'must-not-leak' })
          : jsonResponse(200, { ok: true });
      },
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () => collectCandidateReadinessEvidence({
        baseUrl: 'https://staging.example.test',
        binding: binding(),
        fetchImpl: async (url) => item.response(new URL(url).pathname),
      }),
      (error) => {
        assert.match(error.message, /candidate readiness probe failed/i);
        assert.doesNotMatch(error.message, /private-value|must-not-leak|staging\.example/i);
        return true;
      },
    );
  }

  await assert.rejects(
    () => collectCandidateReadinessEvidence({
      baseUrl: 'https://staging.example.test',
      binding: binding(),
      fetchImpl: async () => {
        throw new Error('network-secret-detail');
      },
    }),
    (error) => {
      assert.match(error.message, /candidate readiness probe failed/i);
      assert.doesNotMatch(error.message, /network-secret-detail/);
      return true;
    },
  );

  await assert.rejects(
    () => collectCandidateReadinessEvidence({
      baseUrl: 'https://staging.example.test',
      binding: binding(),
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/api/gateway-status') {
          return jsonResponse(200, {
            buildCommit: COMMIT.slice(0, 12),
            deploymentId: 'candidate-deployment',
          });
        }
        if (pathname === '/api/health') {
          return jsonResponse(200, { ok: true, padding: 'x'.repeat(70 * 1024) });
        }
        return jsonResponse(200, { ok: true });
      },
    }),
    /candidate readiness probe failed/i,
  );
});

test('candidate readiness producer observes a real local Gateway', async () => {
  const server = createRailwayGatewayServer({
    env: {
      WORKSPACE_AUTH_MODE: 'production',
      SOURCE_COMMIT: COMMIT,
      RAILWAY_DEPLOYMENT_ID: 'candidate-deployment',
      AGENT_CALENDAR_OPERATIONS_TOKEN: 'phase10-operations-fixture-value-000000',
      AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
    },
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
    const evidence = await collectCandidateReadinessEvidence({
      baseUrl,
      binding: binding(),
      allowLoopbackHttp: true,
      clock: () => new Date(CAPTURED_AT),
    });
    assert.equal(evidence.probe.ok, true);
    assert.equal(evidence.health.ok, true);
    assert.equal(evidence.provenance.deploymentId, 'candidate-deployment');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('readiness CLI requires an HTTPS base URL and binding document', () => {
  const result = spawnSync(process.execPath, [
    RELEASE_GATE_CLI,
    'probe-readiness',
  ], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--base-url is required/i);
  assert.doesNotMatch(result.stderr, /Usage:/);
});
