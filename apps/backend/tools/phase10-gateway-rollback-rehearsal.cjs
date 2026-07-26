#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const {
  EXPECTED_SOURCE_REPO,
  rollbackRailwayDeployment,
} = require('../app/lib/railway-release-gate');

function parseArgs(values) {
  const args = { writeEvidence: false };
  for (const value of values) {
    if (value === '--write-evidence') args.writeEvidence = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function productionEnv() {
  return {
    WORKSPACE_AUTH_MODE: 'production',
    AGENT_CALENDAR_OPERATIONS_TOKEN: 'phase10-operations-fixture-value-000000',
    AGENT_CALENDAR_OBSERVABILITY_LOGS: '1',
  };
}

function productionRuntime(readiness) {
  return {
    pool: {
      async query() {
        if (!readiness.ready) throw new Error('fixture database unavailable');
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
      clientId: 'fixture-client',
      apiKeyConfigured: true,
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : 0);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function probe(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const knownGoodReadiness = { ready: true };
  const candidateReadiness = { ready: true };
  const env = productionEnv();
  const knownGoodServer = createRailwayGatewayServer({
    env,
    phase1Runtime: productionRuntime(knownGoodReadiness),
    operationsLogger: () => {},
  });
  const candidateServer = createRailwayGatewayServer({
    env,
    phase1Runtime: productionRuntime(candidateReadiness),
    operationsLogger: () => {},
  });
  let activeDeployment = 'local-known-good';
  let knownGoodBase = '';
  let candidateBase = '';
  const proxy = http.createServer(async (req, res) => {
    try {
      const target = activeDeployment === 'local-candidate'
        ? candidateBase
        : knownGoodBase;
      const response = await fetch(`${target}${req.url || '/'}`, {
        method: req.method || 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
        'content-length': body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"local_proxy_failed"}');
    }
  });

  let report = {
    schemaVersion: 1,
    rehearsal: 'phase10_gateway_blue_green_rollback',
    generatedAt: new Date().toISOString(),
    ok: false,
    knownGoodReadyBefore: false,
    candidateReadyBeforePromotion: false,
    candidateFailedAfterPromotion: false,
    knownGoodReadyAfterRollback: false,
    activeDeploymentAfterRollback: '',
    rollbackApiObserved: false,
    serversStopped: false,
  };

  try {
    const knownGoodPort = await listen(knownGoodServer);
    const candidatePort = await listen(candidateServer);
    const proxyPort = await listen(proxy);
    knownGoodBase = `http://127.0.0.1:${knownGoodPort}`;
    candidateBase = `http://127.0.0.1:${candidatePort}`;
    const proxyBase = `http://127.0.0.1:${proxyPort}`;

    const knownGoodBefore = await probe(proxyBase, '/api/ready');
    const candidateBefore = await probe(candidateBase, '/api/ready');
    report.knownGoodReadyBefore = knownGoodBefore.status === 200
      && knownGoodBefore.body?.ok === true;
    report.candidateReadyBeforePromotion = candidateBefore.status === 200
      && candidateBefore.body?.ok === true;

    const deployments = [
      {
        id: 'local-current-production',
        status: 'SUCCESS',
        canRollback: false,
        meta: { commitHash: '3'.repeat(40), repo: EXPECTED_SOURCE_REPO },
      },
      {
        id: 'local-known-good',
        status: 'REMOVED',
        canRollback: true,
        meta: {
          commitHash: '1'.repeat(40),
          repo: EXPECTED_SOURCE_REPO,
        },
      },
    ];
    activeDeployment = 'local-candidate';
    const promoted = await probe(proxyBase, '/api/ready');
    if (promoted.status !== 200 || promoted.body?.ok !== true) {
      throw new Error('local candidate promotion failed');
    }

    candidateReadiness.ready = false;
    const degraded = await probe(proxyBase, '/api/ready');
    report.candidateFailedAfterPromotion = degraded.status === 503
      && degraded.body?.ok === false;

    const rollback = await rollbackRailwayDeployment({
      apiToken: 'local-rehearsal-value',
      targetDeploymentId: 'local-known-good',
      deployments,
      currentDeploymentId: 'local-candidate',
      fetchImpl: async () => {
        activeDeployment = 'local-known-good';
        return {
          ok: true,
          async json() {
            return {
              data: {
                deploymentRollback: { id: 'local-rollback-result' },
              },
            };
          },
        };
      },
    });
    report.rollbackApiObserved = rollback.ok === true;
    const restored = await probe(proxyBase, '/api/ready');
    report.knownGoodReadyAfterRollback = restored.status === 200
      && restored.body?.ok === true;
    report.activeDeploymentAfterRollback = activeDeployment;
  } finally {
    await Promise.all([
      close(proxy),
      close(candidateServer),
      close(knownGoodServer),
    ]);
    report.serversStopped = !proxy.listening
      && !candidateServer.listening
      && !knownGoodServer.listening;
  }

  report.ok = Boolean(
    report.knownGoodReadyBefore
    && report.candidateReadyBeforePromotion
    && report.candidateFailedAfterPromotion
    && report.knownGoodReadyAfterRollback
    && report.activeDeploymentAfterRollback === 'local-known-good'
    && report.rollbackApiObserved
    && report.serversStopped,
  );
  if (args.writeEvidence && report.ok) {
    const evidencePath = path.resolve(
      __dirname,
      '../../../docs/operations/evidence/2026-07-25-phase10-gateway-rollback.json',
    );
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: false,
    error: String(error?.message || 'gateway_rollback_rehearsal_failed'),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
