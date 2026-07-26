'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const util = require('node:util');

const execFileAsync = util.promisify(childProcess.execFile);
const PRODUCTION_PROJECT_ID = 'b64a9c8f-101e-4e08-9a7f-68fea0a4de9a';
const PRODUCTION_ENVIRONMENT_ID = '7629b09d-3447-4f74-9b06-2f9b8aafb80a';
const PRODUCTION_SERVICE_ID = 'b7bd75ff-cc24-4a6d-9387-1628fcaff9d6';
const EXPECTED_SOURCE_REPO = 'kysk2295/agent-calendar';
const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const BOUNDED_DEPLOYMENT_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const BOUNDED_DEPLOYMENT_STATUS = /^[A-Z][A-Z0-9_]{1,31}$/;
const DATABASE_ENDPOINT_FINGERPRINT = /^[a-f0-9]{64}$/;
const RELEASE_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;
const RELEASE_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const REQUIRED_CLEAN_ACCOUNT_CHECKS = [
  'workspaceLogin',
  'runnerEnrollment',
  'engineAuthentication',
  'delegatedWork',
  'realtimeCheckpoints',
  'calendarResult',
  'reconnectRecovery',
];

function validateRailwayConfig(config = {}) {
  const failures = [];
  const deploy = config && typeof config.deploy === 'object' ? config.deploy : {};
  if (deploy.healthcheckPath !== '/api/health') failures.push('healthcheck_path');
  if (Number(deploy.healthcheckTimeout) !== 30) failures.push('healthcheck_timeout');
  if (Number(deploy.overlapSeconds) !== 60) failures.push('overlap_seconds');
  if (Number(deploy.drainingSeconds) !== 30) failures.push('draining_seconds');
  if (deploy.restartPolicyType !== 'ON_FAILURE') failures.push('restart_policy');
  if (Number(deploy.restartPolicyMaxRetries) !== 3) failures.push('restart_retry_limit');
  return { ok: failures.length === 0, failures };
}

function environmentNodes(status = {}) {
  const edges = status?.environments?.edges;
  return Array.isArray(edges)
    ? edges.map((edge) => edge?.node).filter(Boolean)
    : [];
}

function serviceNodes(environment = {}) {
  const edges = environment?.serviceInstances?.edges;
  return Array.isArray(edges)
    ? edges.map((edge) => edge?.node).filter(Boolean)
    : [];
}

function findDatabaseService(environment = {}) {
  return serviceNodes(environment).find((service) => {
    const image = String(service?.source?.image || '').toLowerCase();
    const name = String(service?.serviceName || '').toLowerCase();
    return image.includes('postgres') || name === 'postgres' || name.includes('postgresql');
  }) || null;
}

function findEnvironment(status, predicate) {
  return environmentNodes(status).find(predicate) || null;
}

function deploymentCommit(deployment = {}) {
  return String(deployment?.meta?.commitHash || '').trim().toLowerCase();
}

function deploymentRepo(deployment = {}) {
  return String(deployment?.meta?.repo || '').trim();
}

function databaseEndpointFingerprint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('database_url_invalid');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname
    || !parsed.pathname
    || parsed.pathname === '/'
  ) {
    throw new Error('database_url_invalid');
  }
  const endpoint = [
    parsed.hostname.toLowerCase(),
    parsed.port || '5432',
    parsed.pathname.slice(1),
  ].join('\n');
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function variableValue(variables, name) {
  if (Array.isArray(variables)) {
    const entry = variables.find((candidate) => (
      candidate?.name === name || candidate?.key === name
    ));
    return String(entry?.value || '');
  }
  return String(variables?.[name] || '');
}

function projectStagingDatabaseIsolationEvidence({
  status = {},
  productionVariables = {},
  stagingVariables = {},
  capturedAt = new Date().toISOString(),
} = {}) {
  if (status?.id !== PRODUCTION_PROJECT_ID) throw new Error('railway_project_mismatch');
  if (exactIsoTime(capturedAt) === null) throw new Error('capture_time_invalid');
  const production = findEnvironment(
    status,
    (environment) => environment.id === PRODUCTION_ENVIRONMENT_ID
      || environment.name === 'production',
  );
  const staging = findEnvironment(status, (environment) => environment.name === 'staging');
  if (!production) throw new Error('production_environment_missing');
  if (!staging) throw new Error('staging_environment_missing');
  const productionService = serviceNodes(production)
    .find((service) => service.serviceId === PRODUCTION_SERVICE_ID);
  const stagingService = serviceNodes(staging)
    .find((service) => service.source?.repo === EXPECTED_SOURCE_REPO);
  const productionDatabaseService = findDatabaseService(production);
  const stagingDatabaseService = findDatabaseService(staging);
  if (!productionService) throw new Error('production_service_missing');
  if (!stagingService) throw new Error('staging_service_missing');
  if (!productionDatabaseService?.id) throw new Error('production_database_service_missing');
  if (!stagingDatabaseService?.id) throw new Error('staging_database_service_missing');
  const candidate = stagingService.latestDeployment;
  const commit = deploymentCommit(candidate);
  if (!candidate?.id || !FULL_COMMIT_SHA.test(commit)) {
    throw new Error('candidate_deployment_invalid');
  }
  const productionEndpointFingerprint = databaseEndpointFingerprint(
    variableValue(productionVariables, 'DATABASE_URL'),
  );
  const stagingEndpointFingerprint = databaseEndpointFingerprint(
    variableValue(stagingVariables, 'DATABASE_URL'),
  );
  return {
    schemaVersion: 1,
    kind: 'staging_database_isolation',
    capturedAt,
    binding: {
      deploymentId: candidate.id,
      commit,
      environmentId: staging.id,
      serviceId: stagingService.serviceId,
    },
    database: {
      productionServiceInstanceId: productionDatabaseService.id,
      stagingServiceInstanceId: stagingDatabaseService.id,
      productionEndpointFingerprint,
      stagingEndpointFingerprint,
      endpointsDistinct: (
        productionDatabaseService.id !== stagingDatabaseService.id
        && productionEndpointFingerprint !== stagingEndpointFingerprint
      ),
    },
  };
}

async function execRailwayJson(execFile, args) {
  let result;
  try {
    result = await execFile('railway', args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    throw new Error('railway_staging_isolation_snapshot_failed');
  }
  try {
    return JSON.parse(String(result?.stdout || ''));
  } catch {
    throw new Error('railway_staging_isolation_snapshot_failed');
  }
}

async function collectStagingDatabaseIsolationEvidence({
  capturedAt = new Date().toISOString(),
  execFile = execFileAsync,
} = {}) {
  const status = await execRailwayJson(execFile, ['status', '--json']);
  if (status?.id !== PRODUCTION_PROJECT_ID) throw new Error('railway_project_mismatch');
  const staging = findEnvironment(status, (environment) => environment.name === 'staging');
  if (!staging) throw new Error('staging_environment_missing');
  const stagingService = serviceNodes(staging)
    .find((service) => service.source?.repo === EXPECTED_SOURCE_REPO);
  if (!stagingService?.serviceId) throw new Error('staging_service_missing');
  const productionVariables = await execRailwayJson(execFile, [
    'variable', 'list', '--json',
    '--project', PRODUCTION_PROJECT_ID,
    '--environment', PRODUCTION_ENVIRONMENT_ID,
    '--service', PRODUCTION_SERVICE_ID,
  ]);
  const stagingVariables = await execRailwayJson(execFile, [
    'variable', 'list', '--json',
    '--project', PRODUCTION_PROJECT_ID,
    '--environment', staging.id,
    '--service', stagingService.serviceId,
  ]);
  return projectStagingDatabaseIsolationEvidence({
    status,
    productionVariables,
    stagingVariables,
    capturedAt,
  });
}

function railwayGraphqlHeaders({ apiToken = '', projectToken = '' } = {}) {
  const account = String(apiToken || '').trim();
  const project = String(projectToken || '').trim();
  if (Boolean(account) === Boolean(project)) {
    throw new Error('exactly one Railway Public API token is required');
  }
  return {
    ...(account ? { Authorization: `Bearer ${account}` } : {}),
    ...(project ? { 'Project-Access-Token': project } : {}),
    'Content-Type': 'application/json',
  };
}

function exactIsoTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function evidenceTiming(evidence, evaluatedAtMs) {
  const capturedAtMs = exactIsoTime(evidence?.capturedAt);
  if (capturedAtMs === null || evaluatedAtMs === null) return { valid: false, stale: false };
  if (capturedAtMs > evaluatedAtMs + RELEASE_EVIDENCE_MAX_FUTURE_SKEW_MS) {
    return { valid: false, stale: false };
  }
  if (evaluatedAtMs - capturedAtMs > RELEASE_EVIDENCE_MAX_AGE_MS) {
    return { valid: true, stale: true, capturedAtMs };
  }
  return { valid: true, stale: false, capturedAtMs };
}

function evidenceBindingMatches(evidence, expected) {
  const binding = evidence?.binding;
  return Boolean(
    binding
    && binding.deploymentId === expected.deploymentId
    && String(binding.commit || '').trim().toLowerCase() === expected.commit
    && binding.environmentId === expected.environmentId
    && binding.serviceId === expected.serviceId,
  );
}

function validateCandidateEvidence({
  evidence,
  kind,
  expectedBinding,
  evaluatedAtMs,
  failurePrefix,
  payloadValid,
  schemaVersion = 1,
}) {
  if (!evidence || typeof evidence !== 'object') {
    return {
      failures: [`${failurePrefix}_missing`],
      capturedAtMs: null,
    };
  }
  const failures = [];
  if (
    evidence.schemaVersion !== schemaVersion
    || evidence.kind !== kind
    || !payloadValid(evidence)
  ) {
    failures.push(`${failurePrefix}_invalid`);
  }
  if (!evidenceBindingMatches(evidence, expectedBinding)) {
    failures.push(`${failurePrefix}_mismatch`);
  }
  const timing = evidenceTiming(evidence, evaluatedAtMs);
  if (!timing.valid) {
    failures.push(`${failurePrefix}_invalid`);
  } else if (timing.stale) {
    failures.push(`${failurePrefix}_stale`);
  }
  return {
    failures: [...new Set(failures)],
    capturedAtMs: timing.capturedAtMs ?? null,
  };
}

function evaluateRailwayPreflight({
  status = {},
  deployments = [],
  expectedCommit = '',
  readinessEvidence = null,
  smokeEvidence = null,
  stagingIsolationEvidence = null,
  evaluatedAt = new Date().toISOString(),
} = {}) {
  const failures = [];
  const normalizedCommit = String(expectedCommit || '').trim().toLowerCase();
  if (!FULL_COMMIT_SHA.test(normalizedCommit)) failures.push('expected_commit_invalid');
  const evaluatedAtMs = exactIsoTime(evaluatedAt);
  if (evaluatedAtMs === null) failures.push('evaluation_time_invalid');

  const production = findEnvironment(
    status,
    (environment) => environment.id === PRODUCTION_ENVIRONMENT_ID
      || environment.name === 'production',
  );
  const staging = findEnvironment(status, (environment) => environment.name === 'staging');
  if (!production) failures.push('production_environment_missing');
  if (!staging) failures.push('staging_environment_missing');

  const productionService = production
    ? serviceNodes(production).find((service) => service.serviceId === PRODUCTION_SERVICE_ID)
    : null;
  const stagingService = staging
    ? serviceNodes(staging).find((service) => service.source?.repo === EXPECTED_SOURCE_REPO)
    : null;
  if (!productionService) failures.push('production_service_missing');
  if (productionService && productionService.source?.repo !== EXPECTED_SOURCE_REPO) {
    failures.push('production_source_repo_mismatch');
  }
  if (!stagingService) failures.push('staging_service_missing');
  const productionDatabaseService = production ? findDatabaseService(production) : null;
  const stagingDatabaseService = staging ? findDatabaseService(staging) : null;
  if (!productionDatabaseService) failures.push('production_database_service_missing');
  if (!stagingDatabaseService) failures.push('staging_database_service_missing');

  const candidate = stagingService?.latestDeployment || null;
  if (!candidate) failures.push('candidate_deployment_missing');
  if (candidate && deploymentCommit(candidate) !== normalizedCommit) {
    failures.push('candidate_commit_mismatch');
  }
  if (candidate && deploymentRepo(candidate) !== EXPECTED_SOURCE_REPO) {
    failures.push('candidate_source_repo_mismatch');
  }
  if (candidate && candidate.status !== 'SUCCESS') failures.push('candidate_not_success');

  const expectedBinding = {
    deploymentId: candidate?.id || '',
    commit: normalizedCommit,
    environmentId: staging?.id || '',
    serviceId: stagingService?.serviceId || '',
  };
  const readiness = validateCandidateEvidence({
    evidence: readinessEvidence,
    kind: 'gateway_readiness',
    expectedBinding,
    evaluatedAtMs,
    failurePrefix: 'candidate_readiness_evidence',
    payloadValid: (value) => (
      value.probe?.path === '/api/ready'
      && value.probe?.httpStatus === 200
      && value.probe?.ok === true
      && value.health?.path === '/api/health'
      && value.health?.httpStatus === 200
      && value.health?.ok === true
      && value.provenance?.path === '/api/gateway-status'
      && value.provenance?.httpStatus === 200
      && value.provenance?.deploymentId === value.binding?.deploymentId
      && /^[a-f0-9]{12,40}$/.test(value.provenance?.buildCommitPrefix || '')
      && String(value.binding?.commit || '').startsWith(value.provenance.buildCommitPrefix)
    ),
  });
  failures.push(...readiness.failures);

  const smoke = validateCandidateEvidence({
    evidence: smokeEvidence,
    kind: 'clean_account_ete',
    expectedBinding,
    evaluatedAtMs,
    failurePrefix: 'candidate_smoke_evidence',
    schemaVersion: 2,
    payloadValid: (value) => (
      value.checks
      && REQUIRED_CLEAN_ACCOUNT_CHECKS.every((name) => value.checks[name] === true)
      && value.identity?.provider === 'workos_authkit'
      && value.identity?.liveTenant === true
      && value.identity?.injectedAdapter === false
    ),
  });
  failures.push(...smoke.failures);

  const isolation = validateCandidateEvidence({
    evidence: stagingIsolationEvidence,
    kind: 'staging_database_isolation',
    expectedBinding,
    evaluatedAtMs,
    failurePrefix: 'staging_isolation_evidence',
    payloadValid: (value) => {
      const database = value.database;
      return Boolean(
        database
        && database.productionServiceInstanceId === productionDatabaseService?.id
        && database.stagingServiceInstanceId === stagingDatabaseService?.id
        && database.productionServiceInstanceId !== database.stagingServiceInstanceId
        && DATABASE_ENDPOINT_FINGERPRINT.test(
          database.productionEndpointFingerprint || '',
        )
        && DATABASE_ENDPOINT_FINGERPRINT.test(
          database.stagingEndpointFingerprint || '',
        )
        && database.productionEndpointFingerprint
          !== database.stagingEndpointFingerprint
        && database.endpointsDistinct === true
      );
    },
  });
  failures.push(...isolation.failures);

  const list = Array.isArray(deployments) ? deployments : [];
  const lastKnownGood = list.find((deployment) => (
    deployment.id !== productionService?.latestDeployment?.id
    && deployment.canRollback === true
    && deploymentRepo(deployment) === EXPECTED_SOURCE_REPO
    && FULL_COMMIT_SHA.test(deploymentCommit(deployment))
  )) || null;
  if (!lastKnownGood) failures.push('last_known_good_unavailable');

  const uniqueFailures = [...new Set(failures)];
  const ok = uniqueFailures.length === 0;
  const evidenceExpiryMs = Math.min(
    ...[readiness, smoke, isolation].map((entry) => (
      entry.capturedAtMs === null
        ? Number.POSITIVE_INFINITY
        : entry.capturedAtMs + RELEASE_EVIDENCE_MAX_AGE_MS
    )),
  );
  return {
    schemaVersion: 3,
    ok,
    action: ok ? 'promote_candidate' : 'stop_release',
    failures: uniqueFailures,
    candidateCommit: candidate ? deploymentCommit(candidate) : '',
    candidateDeploymentId: candidate?.id || '',
    lastKnownGoodDeploymentId: lastKnownGood?.id || '',
    stagingEnvironmentId: staging?.id || '',
    stagingServiceId: stagingService?.serviceId || '',
    verifiedAt: evaluatedAtMs === null ? '' : new Date(evaluatedAtMs).toISOString(),
    expiresAt: ok && Number.isFinite(evidenceExpiryMs)
      ? new Date(evidenceExpiryMs).toISOString()
      : '',
  };
}

function validateRollbackTarget({
  deployments = [],
  targetDeploymentId = '',
  currentDeploymentId = '',
} = {}) {
  const targetId = String(targetDeploymentId || '').trim();
  const currentId = String(currentDeploymentId || '').trim();
  if (!targetId) throw new Error('rollback target deployment ID is required');
  if (targetId === currentId) {
    throw new Error('current deployment cannot be selected as rollback target');
  }
  const target = (Array.isArray(deployments) ? deployments : [])
    .find((deployment) => deployment?.id === targetId);
  if (!target) throw new Error('rollback target must be an exact listed deployment');
  if (target.canRollback !== true) {
    throw new Error('rollback target is outside the retained canRollback window');
  }
  if (deploymentRepo(target) !== EXPECTED_SOURCE_REPO) {
    throw new Error('rollback target source repository mismatch');
  }
  if (!FULL_COMMIT_SHA.test(deploymentCommit(target))) {
    throw new Error('rollback target has no reproducible full commit provenance');
  }
  return target;
}

function projectDeploymentSnapshot(node) {
  const id = String(node?.id || '').trim();
  const status = String(node?.status || '').trim();
  const createdAt = String(node?.createdAt || '').trim();
  const commitHash = deploymentCommit(node);
  const repo = deploymentRepo(node);
  if (
    !BOUNDED_DEPLOYMENT_ID.test(id)
    || !BOUNDED_DEPLOYMENT_STATUS.test(status)
    || exactIsoTime(createdAt) === null
    || typeof node?.canRollback !== 'boolean'
    || !FULL_COMMIT_SHA.test(commitHash)
    || repo !== EXPECTED_SOURCE_REPO
  ) {
    throw new Error('Railway deployment snapshot contains an invalid deployment');
  }
  return {
    id,
    status,
    createdAt,
    canRollback: node.canRollback,
    meta: {
      commitHash,
      repo,
    },
  };
}

async function fetchRailwayDeploymentSnapshot({
  apiToken = '',
  projectToken = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const headers = railwayGraphqlHeaders({ apiToken, projectToken });
  if (typeof fetchImpl !== 'function') {
    throw new Error('Railway deployment snapshot requires fetch');
  }
  const query = [
    'query deployments($input: DeploymentListInput!, $first: Int) {',
    '  deployments(input: $input, first: $first) {',
    '    edges {',
    '      node {',
    '        id',
    '        status',
    '        createdAt',
    '        canRollback',
    '        meta',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  let response;
  try {
    response = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: {
          input: {
            projectId: PRODUCTION_PROJECT_ID,
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            serviceId: PRODUCTION_SERVICE_ID,
          },
          first: 20,
        },
      }),
    });
  } catch {
    throw new Error('Railway deployment snapshot request failed');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Railway deployment snapshot request failed');
  }
  const edges = body?.data?.deployments?.edges;
  if (!response.ok || body?.errors?.length || !Array.isArray(edges) || edges.length > 20) {
    throw new Error('Railway deployment snapshot request failed');
  }
  const deployments = edges.map((edge) => projectDeploymentSnapshot(edge?.node));
  if (new Set(deployments.map((deployment) => deployment.id)).size !== deployments.length) {
    throw new Error('Railway deployment snapshot contains duplicate deployments');
  }
  return deployments;
}

async function rollbackRailwayDeployment({
  apiToken = '',
  projectToken = '',
  targetDeploymentId = '',
  deployments = [],
  currentDeploymentId = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const headers = railwayGraphqlHeaders({ apiToken, projectToken });
  if (typeof fetchImpl !== 'function') throw new Error('Railway rollback requires fetch');
  const target = validateRollbackTarget({
    deployments,
    targetDeploymentId,
    currentDeploymentId,
  });
  const query = [
    'mutation deploymentRollback($id: String!) {',
    '  deploymentRollback(id: $id) {',
    '    id',
    '  }',
    '}',
  ].join('\n');
  const response = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables: { id: target.id },
    }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    throw new Error('Railway rollback returned invalid JSON');
  }
  if (!response.ok || body?.errors?.length || !body?.data?.deploymentRollback?.id) {
    throw new Error('Railway rollback request failed');
  }
  return {
    ok: true,
    targetDeploymentId: target.id,
    targetCommit: deploymentCommit(target),
    rollbackDeploymentId: String(body.data.deploymentRollback.id),
  };
}

module.exports = {
  EXPECTED_SOURCE_REPO,
  PRODUCTION_ENVIRONMENT_ID,
  PRODUCTION_PROJECT_ID,
  PRODUCTION_SERVICE_ID,
  RAILWAY_GRAPHQL_ENDPOINT,
  collectStagingDatabaseIsolationEvidence,
  evaluateRailwayPreflight,
  fetchRailwayDeploymentSnapshot,
  projectStagingDatabaseIsolationEvidence,
  rollbackRailwayDeployment,
  validateRailwayConfig,
  validateRollbackTarget,
};
