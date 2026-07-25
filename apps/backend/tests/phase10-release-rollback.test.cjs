'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  EXPECTED_SOURCE_REPO,
  PRODUCTION_ENVIRONMENT_ID,
  PRODUCTION_PROJECT_ID,
  PRODUCTION_SERVICE_ID,
  collectStagingDatabaseIsolationEvidence,
  evaluateRailwayPreflight,
  fetchRailwayDeploymentSnapshot,
  projectStagingDatabaseIsolationEvidence,
  rollbackRailwayDeployment,
  validateRailwayConfig,
  validateRollbackTarget,
} = require('../app/lib/railway-release-gate');

const ROOT_CONFIG = path.resolve(__dirname, '../../../railway.json');
const BACKEND_CONFIG = path.resolve(__dirname, '../railway.json');
const REHEARSAL_CLI = path.resolve(
  __dirname,
  '../tools/phase10-gateway-rollback-rehearsal.cjs',
);
const REHEARSAL_EVIDENCE = path.resolve(
  __dirname,
  '../../../docs/operations/evidence/2026-07-25-phase10-gateway-rollback.json',
);
const RELEASE_GATE_CLI = path.resolve(
  __dirname,
  '../../../scripts/railway-release-gate.cjs',
);
const EVALUATED_AT = '2026-07-25T10:15:00.000Z';
const CANDIDATE_COMMIT = 'b'.repeat(40);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validStatus() {
  return {
    id: PRODUCTION_PROJECT_ID,
    environments: {
      edges: [
        {
          node: {
            id: PRODUCTION_ENVIRONMENT_ID,
            name: 'production',
            serviceInstances: {
              edges: [{
                node: {
                  id: 'production-app-instance',
                  serviceId: PRODUCTION_SERVICE_ID,
                  source: { repo: EXPECTED_SOURCE_REPO },
                  latestDeployment: {
                    id: 'current-production',
                    status: 'SUCCESS',
                    meta: {
                      commitHash: 'd'.repeat(40),
                      repo: EXPECTED_SOURCE_REPO,
                    },
                  },
                },
              }, {
                node: {
                  id: 'production-postgres-instance',
                  serviceId: 'postgres-service',
                  serviceName: 'Postgres',
                  source: { image: 'postgres:18', repo: null },
                },
              }],
            },
          },
        },
        {
          node: {
            id: 'staging-environment',
            name: 'staging',
            serviceInstances: {
              edges: [{
                node: {
                  id: 'staging-app-instance',
                  serviceId: 'staging-service',
                  source: { repo: EXPECTED_SOURCE_REPO },
                  latestDeployment: {
                    id: 'candidate-deployment',
                    status: 'SUCCESS',
                    meta: {
                      commitHash: CANDIDATE_COMMIT,
                      repo: EXPECTED_SOURCE_REPO,
                    },
                  },
                },
              }, {
                node: {
                  id: 'staging-postgres-instance',
                  serviceId: 'postgres-service',
                  serviceName: 'Postgres',
                  source: { image: 'postgres:18', repo: null },
                },
              }],
            },
          },
        },
      ],
    },
  };
}

test('staging database isolation producer emits only exact candidate binding and endpoint fingerprints', async () => {
  const productionDatabaseUrl =
    'postgresql://production-user:production-secret@prod.internal:5432/agent_calendar';
  const stagingDatabaseUrl =
    'postgresql://staging-user:staging-secret@staging.internal:5432/agent_calendar';
  const projected = projectStagingDatabaseIsolationEvidence({
    status: validStatus(),
    productionVariables: { DATABASE_URL: productionDatabaseUrl },
    stagingVariables: { DATABASE_URL: stagingDatabaseUrl },
    capturedAt: '2026-07-25T10:03:00.000Z',
  });

  assert.equal(projected.kind, 'staging_database_isolation');
  assert.deepEqual(projected.binding, candidateBinding());
  assert.equal(projected.database.endpointsDistinct, true);
  assert.match(projected.database.productionEndpointFingerprint, /^[a-f0-9]{64}$/);
  assert.match(projected.database.stagingEndpointFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(
    projected.database.productionEndpointFingerprint,
    projected.database.stagingEndpointFingerprint,
  );
  assert.doesNotMatch(
    JSON.stringify(projected),
    /production-secret|staging-secret|prod\.internal|staging\.internal|production-user|staging-user/,
  );

  const calls = [];
  const collected = await collectStagingDatabaseIsolationEvidence({
    capturedAt: '2026-07-25T10:03:00.000Z',
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'status') {
        return { stdout: JSON.stringify(validStatus()), stderr: '' };
      }
      if (args.includes(PRODUCTION_ENVIRONMENT_ID)) {
        return { stdout: JSON.stringify({ DATABASE_URL: productionDatabaseUrl }), stderr: '' };
      }
      return { stdout: JSON.stringify({ DATABASE_URL: stagingDatabaseUrl }), stderr: '' };
    },
  });
  assert.deepEqual(collected, projected);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    command: 'railway',
    args: ['status', '--json'],
  });
  assert.deepEqual(calls[1], {
    command: 'railway',
    args: [
      'variable', 'list', '--json',
      '--project', PRODUCTION_PROJECT_ID,
      '--environment', PRODUCTION_ENVIRONMENT_ID,
      '--service', PRODUCTION_SERVICE_ID,
    ],
  });
  assert.deepEqual(calls[2], {
    command: 'railway',
    args: [
      'variable', 'list', '--json',
      '--project', PRODUCTION_PROJECT_ID,
      '--environment', 'staging-environment',
      '--service', 'staging-service',
    ],
  });
  assert.doesNotMatch(JSON.stringify(collected), /secret|internal|user/i);
});

function validDeployments() {
  return [
    {
      id: 'current-production',
      status: 'SUCCESS',
      canRollback: false,
      meta: { commitHash: 'd'.repeat(40), repo: EXPECTED_SOURCE_REPO },
    },
    {
      id: 'last-known-good',
      status: 'REMOVED',
      canRollback: true,
      meta: { commitHash: 'a'.repeat(40), repo: EXPECTED_SOURCE_REPO },
    },
  ];
}

function candidateBinding() {
  return {
    deploymentId: 'candidate-deployment',
    commit: CANDIDATE_COMMIT,
    environmentId: 'staging-environment',
    serviceId: 'staging-service',
  };
}

function validReadinessEvidence() {
  return {
    schemaVersion: 1,
    kind: 'gateway_readiness',
    capturedAt: '2026-07-25T10:00:00.000Z',
    binding: candidateBinding(),
    probe: {
      path: '/api/ready',
      httpStatus: 200,
      ok: true,
    },
    health: {
      path: '/api/health',
      httpStatus: 200,
      ok: true,
    },
    provenance: {
      path: '/api/gateway-status',
      httpStatus: 200,
      deploymentId: 'candidate-deployment',
      buildCommitPrefix: CANDIDATE_COMMIT.slice(0, 12),
    },
  };
}

function validSmokeEvidence() {
  return {
    schemaVersion: 2,
    kind: 'clean_account_ete',
    capturedAt: '2026-07-25T10:05:00.000Z',
    binding: candidateBinding(),
    identity: {
      provider: 'workos_authkit',
      liveTenant: true,
      injectedAdapter: false,
    },
    checks: {
      workspaceLogin: true,
      runnerEnrollment: true,
      engineAuthentication: true,
      delegatedWork: true,
      realtimeCheckpoints: true,
      calendarResult: true,
      reconnectRecovery: true,
    },
  };
}

function validStagingIsolationEvidence() {
  return {
    schemaVersion: 1,
    kind: 'staging_database_isolation',
    capturedAt: '2026-07-25T10:03:00.000Z',
    binding: candidateBinding(),
    database: {
      productionServiceInstanceId: 'production-postgres-instance',
      stagingServiceInstanceId: 'staging-postgres-instance',
      productionEndpointFingerprint: '1'.repeat(64),
      stagingEndpointFingerprint: '2'.repeat(64),
      endpointsDistinct: true,
    },
  };
}

function evaluateValidPreflight(patch = {}) {
  return evaluateRailwayPreflight({
    status: validStatus(),
    deployments: validDeployments(),
    expectedCommit: CANDIDATE_COMMIT,
    readinessEvidence: validReadinessEvidence(),
    smokeEvidence: validSmokeEvidence(),
    stagingIsolationEvidence: validStagingIsolationEvidence(),
    evaluatedAt: EVALUATED_AT,
    ...patch,
  });
}

test('Railway config uses current health, overlap, draining, and bounded restart policy', () => {
  for (const filePath of [ROOT_CONFIG, BACKEND_CONFIG]) {
    const config = readJson(filePath);
    const result = validateRailwayConfig(config);
    assert.equal(result.ok, true, `${path.basename(filePath)}: ${result.failures.join(',')}`);
    assert.equal(config.deploy.healthcheckPath, '/api/health');
    assert.equal(Number(config.deploy.healthcheckTimeout), 30);
    assert.equal(Number(config.deploy.overlapSeconds), 60);
    assert.equal(Number(config.deploy.drainingSeconds), 30);
    assert.equal(config.deploy.restartPolicyType, 'ON_FAILURE');
    assert.equal(Number(config.deploy.restartPolicyMaxRetries), 3);
  }
});

test('preflight fails closed without an isolated staging environment', () => {
  const status = validStatus();
  status.environments.edges = status.environments.edges.filter(
    (edge) => edge.node.name !== 'staging',
  );
  const result = evaluateRailwayPreflight({
    status,
    deployments: validDeployments(),
    expectedCommit: CANDIDATE_COMMIT,
    readinessEvidence: validReadinessEvidence(),
    smokeEvidence: validSmokeEvidence(),
    stagingIsolationEvidence: validStagingIsolationEvidence(),
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.includes('staging_environment_missing'), true);
  assert.equal(result.action, 'stop_release');
});

test('preflight fixes exact source, provenance, readiness, smoke, and rollback candidate', () => {
  const result = evaluateValidPreflight();
  assert.equal(result.ok, true);
  assert.equal(result.action, 'promote_candidate');
  assert.equal(result.candidateDeploymentId, 'candidate-deployment');
  assert.equal(result.lastKnownGoodDeploymentId, 'last-known-good');
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.verifiedAt, EVALUATED_AT);
  assert.equal(result.expiresAt, '2026-07-25T10:30:00.000Z');

  for (const patch of [
    { expectedCommit: 'c'.repeat(40) },
    { readinessEvidence: null },
    { smokeEvidence: null },
    { stagingIsolationEvidence: null },
  ]) {
    const failed = evaluateValidPreflight(patch);
    assert.equal(failed.ok, false);
    assert.equal(failed.action, 'stop_release');
  }
});

test('preflight rejects missing, mismatched, or shared staging database isolation evidence', () => {
  const missing = evaluateValidPreflight({ stagingIsolationEvidence: null });
  assert.equal(missing.ok, false);
  assert.equal(
    missing.failures.includes('staging_isolation_evidence_missing'),
    true,
  );

  const mismatched = validStagingIsolationEvidence();
  mismatched.binding.environmentId = 'another-environment';
  const mismatch = evaluateValidPreflight({ stagingIsolationEvidence: mismatched });
  assert.equal(mismatch.ok, false);
  assert.equal(
    mismatch.failures.includes('staging_isolation_evidence_mismatch'),
    true,
  );

  const shared = validStagingIsolationEvidence();
  shared.database.stagingEndpointFingerprint =
    shared.database.productionEndpointFingerprint;
  shared.database.endpointsDistinct = false;
  const sharedResult = evaluateValidPreflight({ stagingIsolationEvidence: shared });
  assert.equal(sharedResult.ok, false);
  assert.equal(
    sharedResult.failures.includes('staging_isolation_evidence_invalid'),
    true,
  );
});

test('preflight rejects readiness evidence that is stale or bound to another candidate', () => {
  const mismatched = validReadinessEvidence();
  mismatched.binding.deploymentId = 'another-deployment';
  const mismatchResult = evaluateValidPreflight({ readinessEvidence: mismatched });
  assert.equal(mismatchResult.ok, false);
  assert.equal(
    mismatchResult.failures.includes('candidate_readiness_evidence_mismatch'),
    true,
  );

  const stale = validReadinessEvidence();
  stale.capturedAt = '2026-07-25T09:44:59.000Z';
  const staleResult = evaluateValidPreflight({ readinessEvidence: stale });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.failures.includes('candidate_readiness_evidence_stale'), true);

  const future = validReadinessEvidence();
  future.capturedAt = '2026-07-25T10:20:01.000Z';
  const futureResult = evaluateValidPreflight({ readinessEvidence: future });
  assert.equal(futureResult.ok, false);
  assert.equal(futureResult.failures.includes('candidate_readiness_evidence_invalid'), true);

  const legacy = validReadinessEvidence();
  delete legacy.health;
  delete legacy.provenance;
  const legacyResult = evaluateValidPreflight({ readinessEvidence: legacy });
  assert.equal(legacyResult.ok, false);
  assert.equal(
    legacyResult.failures.includes('candidate_readiness_evidence_invalid'),
    true,
  );
});

test('preflight rejects incomplete clean-account ETE and ignores legacy boolean claims', () => {
  const incomplete = validSmokeEvidence();
  incomplete.checks.calendarResult = false;
  const incompleteResult = evaluateValidPreflight({ smokeEvidence: incomplete });
  assert.equal(incompleteResult.ok, false);
  assert.equal(
    incompleteResult.failures.includes('candidate_smoke_evidence_invalid'),
    true,
  );

  const fakeIdentity = validSmokeEvidence();
  fakeIdentity.identity.liveTenant = false;
  fakeIdentity.identity.injectedAdapter = true;
  const fakeIdentityResult = evaluateValidPreflight({ smokeEvidence: fakeIdentity });
  assert.equal(fakeIdentityResult.ok, false);
  assert.equal(
    fakeIdentityResult.failures.includes('candidate_smoke_evidence_invalid'),
    true,
  );

  const legacyEvidence = validSmokeEvidence();
  legacyEvidence.schemaVersion = 1;
  delete legacyEvidence.identity;
  const legacyEvidenceResult = evaluateValidPreflight({ smokeEvidence: legacyEvidence });
  assert.equal(legacyEvidenceResult.ok, false);
  assert.equal(
    legacyEvidenceResult.failures.includes('candidate_smoke_evidence_invalid'),
    true,
  );

  const legacyBooleanResult = evaluateRailwayPreflight({
    status: validStatus(),
    deployments: validDeployments(),
    expectedCommit: CANDIDATE_COMMIT,
    candidateReady: true,
    smokePassed: true,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(legacyBooleanResult.ok, false);
  assert.equal(
    legacyBooleanResult.failures.includes('candidate_readiness_evidence_missing'),
    true,
  );
  assert.equal(
    legacyBooleanResult.failures.includes('candidate_smoke_evidence_missing'),
    true,
  );
});

test('preflight result stays bounded and does not reflect evidence payload extras', () => {
  const readinessEvidence = validReadinessEvidence();
  readinessEvidence.secret = 'must-not-appear';
  readinessEvidence.workspaceId = 'workspace-private';
  const result = evaluateValidPreflight({ readinessEvidence });
  assert.equal(result.ok, true);
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /must-not-appear|workspace-private/);
  assert.deepEqual(Object.keys(result).sort(), [
    'action',
    'candidateCommit',
    'candidateDeploymentId',
    'expiresAt',
    'failures',
    'lastKnownGoodDeploymentId',
    'ok',
    'schemaVersion',
    'stagingEnvironmentId',
    'stagingServiceId',
    'verifiedAt',
  ]);
});

test('preflight CLI consumes evidence documents instead of operator boolean claims', () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'release-gate-'));
  const files = {
    status: path.join(tempDir, 'status.json'),
    deployments: path.join(tempDir, 'deployments.json'),
    readiness: path.join(tempDir, 'readiness.json'),
    smoke: path.join(tempDir, 'smoke.json'),
    isolation: path.join(tempDir, 'isolation.json'),
  };
  try {
    fs.writeFileSync(files.status, JSON.stringify(validStatus()));
    fs.writeFileSync(files.deployments, JSON.stringify(validDeployments()));
    fs.writeFileSync(files.readiness, JSON.stringify(validReadinessEvidence()));
    fs.writeFileSync(files.smoke, JSON.stringify(validSmokeEvidence()));
    fs.writeFileSync(files.isolation, JSON.stringify(validStagingIsolationEvidence()));
    const result = spawnSync(process.execPath, [
      RELEASE_GATE_CLI,
      'preflight',
      '--status-json', files.status,
      '--deployments-json', files.deployments,
      '--expected-commit', CANDIDATE_COMMIT,
      '--readiness-evidence-json', files.readiness,
      '--smoke-evidence-json', files.smoke,
      '--staging-isolation-evidence-json', files.isolation,
      '--evaluated-at', EVALUATED_AT,
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.schemaVersion, 3);

    const legacy = spawnSync(process.execPath, [
      RELEASE_GATE_CLI,
      'preflight',
      '--status-json', files.status,
      '--deployments-json', files.deployments,
      '--expected-commit', CANDIDATE_COMMIT,
      '--candidate-ready', 'true',
      '--smoke-passed', 'true',
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
    });
    assert.notEqual(legacy.status, 0);
    assert.match(legacy.stderr, /readiness-evidence-json/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rollback target must be the exact retained canRollback deployment', () => {
  const deployments = validDeployments();
  const accepted = validateRollbackTarget({
    deployments,
    targetDeploymentId: 'last-known-good',
    currentDeploymentId: 'current-production',
  });
  assert.equal(accepted.id, 'last-known-good');

  assert.throws(
    () => validateRollbackTarget({
      deployments,
      targetDeploymentId: 'current-production',
      currentDeploymentId: 'current-production',
    }),
    /current|rollback/i,
  );
  assert.throws(
    () => validateRollbackTarget({
      deployments,
      targetDeploymentId: 'unknown',
      currentDeploymentId: 'candidate-deployment',
    }),
    /listed|target/i,
  );
});

test('Railway rollback sends one exact GraphQL mutation without exposing the token', async () => {
  const calls = [];
  const result = await rollbackRailwayDeployment({
    apiToken: 'railway-secret-value',
    targetDeploymentId: 'last-known-good',
    deployments: validDeployments(),
    currentDeploymentId: 'current-production',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            data: {
              deploymentRollback: { id: 'rollback-deployment' },
            },
          };
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetDeploymentId, 'last-known-good');
  assert.equal(result.rollbackDeploymentId, 'rollback-deployment');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://backboard.railway.com/graphql/v2');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer railway-secret-value');
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.query, /mutation deploymentRollback/);
  assert.deepEqual(body.variables, { id: 'last-known-good' });
  assert.doesNotMatch(JSON.stringify(result), /railway-secret-value/);

  await assert.rejects(
    () => rollbackRailwayDeployment({
      apiToken: '',
      targetDeploymentId: 'last-known-good',
      deployments: validDeployments(),
      currentDeploymentId: 'current-production',
      fetchImpl: async () => {
        throw new Error('must not call');
      },
    }),
    /token/i,
  );
});

test('Railway Public API snapshot uses fixed selectors and projects only rollback evidence', async () => {
  const calls = [];
  const deployments = await fetchRailwayDeploymentSnapshot({
    apiToken: 'account-secret-value',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            data: {
              deployments: {
                edges: [
                  {
                    node: {
                      id: 'deployment-current',
                      status: 'SUCCESS',
                      createdAt: '2026-07-25T10:00:00.000Z',
                      canRollback: false,
                      meta: {
                        commitHash: 'd'.repeat(40),
                        repo: EXPECTED_SOURCE_REPO,
                        privateValue: 'must-not-appear',
                      },
                    },
                  },
                  {
                    node: {
                      id: 'deployment-retained',
                      status: 'REMOVED',
                      createdAt: '2026-07-24T10:00:00.000Z',
                      canRollback: true,
                      meta: {
                        commitHash: 'a'.repeat(40),
                        repo: EXPECTED_SOURCE_REPO,
                      },
                    },
                  },
                ],
              },
            },
          };
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://backboard.railway.com/graphql/v2');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer account-secret-value');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Project-Access-Token'), false);
  const request = JSON.parse(calls[0].options.body);
  assert.match(request.query, /query deployments/);
  assert.match(request.query, /canRollback/);
  assert.deepEqual(request.variables, {
    input: {
      projectId: PRODUCTION_PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
      serviceId: PRODUCTION_SERVICE_ID,
    },
    first: 20,
  });
  assert.deepEqual(deployments, [
    {
      id: 'deployment-current',
      status: 'SUCCESS',
      createdAt: '2026-07-25T10:00:00.000Z',
      canRollback: false,
      meta: { commitHash: 'd'.repeat(40), repo: EXPECTED_SOURCE_REPO },
    },
    {
      id: 'deployment-retained',
      status: 'REMOVED',
      createdAt: '2026-07-24T10:00:00.000Z',
      canRollback: true,
      meta: { commitHash: 'a'.repeat(40), repo: EXPECTED_SOURCE_REPO },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(deployments), /account-secret-value|must-not-appear/);
  assert.equal(validateRollbackTarget({
    deployments,
    targetDeploymentId: 'deployment-retained',
    currentDeploymentId: 'deployment-current',
  }).id, 'deployment-retained');
});

test('Railway Public API snapshot supports a Project Token without a bearer header', async () => {
  const calls = [];
  await fetchRailwayDeploymentSnapshot({
    projectToken: 'project-secret-value',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            data: {
              deployments: {
                edges: [{
                  node: {
                    id: 'deployment-project-token',
                    status: 'SUCCESS',
                    createdAt: '2026-07-25T10:00:00.000Z',
                    canRollback: false,
                    meta: {
                      commitHash: 'd'.repeat(40),
                      repo: EXPECTED_SOURCE_REPO,
                    },
                  },
                }],
              },
            },
          };
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['Project-Access-Token'], 'project-secret-value');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
});

test('Railway deployment snapshot fails closed before or after unsafe API boundaries', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not call');
  };
  await assert.rejects(
    () => fetchRailwayDeploymentSnapshot({ fetchImpl }),
    /token/i,
  );
  await assert.rejects(
    () => fetchRailwayDeploymentSnapshot({
      apiToken: 'account',
      projectToken: 'project',
      fetchImpl,
    }),
    /exactly one|token/i,
  );
  assert.equal(calls, 0);

  for (const patch of [
    { canRollback: undefined },
    { status: 'SUCCESS\nsecret' },
    { createdAt: 'yesterday' },
    { meta: { commitHash: 'short', repo: EXPECTED_SOURCE_REPO } },
    { meta: { commitHash: 'a'.repeat(40), repo: 'other/repo' } },
  ]) {
    await assert.rejects(
      () => fetchRailwayDeploymentSnapshot({
        apiToken: 'account',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              data: {
                deployments: {
                  edges: [{
                    node: {
                      id: 'deployment-invalid',
                      status: 'SUCCESS',
                      createdAt: '2026-07-25T10:00:00.000Z',
                      canRollback: true,
                      meta: {
                        commitHash: 'a'.repeat(40),
                        repo: EXPECTED_SOURCE_REPO,
                      },
                      ...patch,
                    },
                  }],
                },
              },
            };
          },
        }),
      }),
      /deployment snapshot/i,
    );
  }

  await assert.rejects(
    () => fetchRailwayDeploymentSnapshot({
      apiToken: 'account',
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { errors: [{ message: 'upstream-secret-detail' }] };
        },
      }),
    }),
    (error) => {
      assert.match(error.message, /snapshot request failed/i);
      assert.doesNotMatch(error.message, /upstream-secret-detail/);
      return true;
    },
  );
});

test('rollback mutation supports Project Token authentication without leaking it', async () => {
  const calls = [];
  const result = await rollbackRailwayDeployment({
    projectToken: 'project-rollback-secret',
    targetDeploymentId: 'last-known-good',
    deployments: validDeployments(),
    currentDeploymentId: 'current-production',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { data: { deploymentRollback: { id: 'rollback-project-token' } } };
        },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].options.headers['Project-Access-Token'], 'project-rollback-secret');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.doesNotMatch(JSON.stringify(result), /project-rollback-secret/);
});

test('snapshot CLI fails closed without an explicit Public API token', () => {
  const result = spawnSync(process.execPath, [
    RELEASE_GATE_CLI,
    'snapshot-deployments',
  ], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      RAILWAY_API_TOKEN: '',
      RAILWAY_PROJECT_TOKEN: '',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /token/i);
  assert.doesNotMatch(result.stderr, /Usage:/);
});

test('actual local Gateway readiness promotion failure restores the known-good process', () => {
  const beforeEvidence = fs.existsSync(REHEARSAL_EVIDENCE)
    ? fs.readFileSync(REHEARSAL_EVIDENCE, 'utf8')
    : null;
  const result = spawnSync(process.execPath, [REHEARSAL_CLI], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.knownGoodReadyBefore, true);
  assert.equal(report.candidateReadyBeforePromotion, true);
  assert.equal(report.candidateFailedAfterPromotion, true);
  assert.equal(report.knownGoodReadyAfterRollback, true);
  assert.equal(report.activeDeploymentAfterRollback, 'local-known-good');
  assert.equal(report.serversStopped, true);
  assert.doesNotMatch(result.stdout, /Bearer|token|\/Users\//i);

  const afterEvidence = fs.existsSync(REHEARSAL_EVIDENCE)
    ? fs.readFileSync(REHEARSAL_EVIDENCE, 'utf8')
    : null;
  assert.equal(afterEvidence, beforeEvidence);
});
