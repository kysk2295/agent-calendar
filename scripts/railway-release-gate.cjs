#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  collectCandidateReadinessEvidence,
} = require('../apps/backend/app/lib/candidate-readiness-evidence');
const {
  collectStagingDatabaseIsolationEvidence,
  evaluateRailwayPreflight,
  fetchRailwayDeploymentSnapshot,
  rollbackRailwayDeployment,
} = require('../apps/backend/app/lib/railway-release-gate');

function parseArgs(values) {
  const [command, ...rest] = values;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid release gate argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  return { command, flags };
}

function required(flags, name) {
  const value = String(flags[name] || '').trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function rejectUnsupportedFlags(command, flags, allowed) {
  const unsupported = Object.keys(flags).find((name) => !allowed.has(name));
  if (unsupported) {
    throw new Error(`${command} received an unsupported flag: --${unsupported}`);
  }
}

function railwayPublicApiCredentials(command) {
  const apiToken = String(process.env.RAILWAY_API_TOKEN || '').trim();
  const projectToken = String(process.env.RAILWAY_PROJECT_TOKEN || '').trim();
  if (Boolean(apiToken) === Boolean(projectToken)) {
    throw new Error(
      `${command} requires exactly one of RAILWAY_API_TOKEN or `
      + 'RAILWAY_PROJECT_TOKEN; no Railway API request was made',
    );
  }
  return { apiToken, projectToken };
}

async function withRailwayCliCredentials(credentials, action) {
  const previousApiToken = process.env.RAILWAY_API_TOKEN;
  const previousCliToken = process.env.RAILWAY_TOKEN;
  if (credentials.apiToken) {
    process.env.RAILWAY_API_TOKEN = credentials.apiToken;
    delete process.env.RAILWAY_TOKEN;
  } else {
    delete process.env.RAILWAY_API_TOKEN;
    process.env.RAILWAY_TOKEN = credentials.projectToken;
  }
  try {
    return await action();
  } finally {
    if (previousApiToken === undefined) delete process.env.RAILWAY_API_TOKEN;
    else process.env.RAILWAY_API_TOKEN = previousApiToken;
    if (previousCliToken === undefined) delete process.env.RAILWAY_TOKEN;
    else process.env.RAILWAY_TOKEN = previousCliToken;
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    throw new Error(`${label} JSON is missing or invalid`);
  }
}

function readPreflightInput(command, flags) {
  const paths = {
    status: required(flags, 'status-json'),
    deployments: required(flags, 'deployments-json'),
    expectedCommit: required(flags, 'expected-commit'),
    readinessEvidence: required(flags, 'readiness-evidence-json'),
    smokeEvidence: required(flags, 'smoke-evidence-json'),
    stagingIsolationEvidence: required(flags, 'staging-isolation-evidence-json'),
  };
  rejectUnsupportedFlags(command, flags, new Set([
    'status-json',
    'deployments-json',
    'expected-commit',
    'readiness-evidence-json',
    'smoke-evidence-json',
    'staging-isolation-evidence-json',
    'evaluated-at',
  ]));
  return {
    status: readJson(paths.status, 'Railway status'),
    deployments: readJson(paths.deployments, 'Railway deployments'),
    expectedCommit: paths.expectedCommit,
    readinessEvidence: readJson(
      paths.readinessEvidence,
      'Candidate readiness evidence',
    ),
    smokeEvidence: readJson(paths.smokeEvidence, 'Candidate smoke evidence'),
    stagingIsolationEvidence: readJson(
      paths.stagingIsolationEvidence,
      'Staging database isolation evidence',
    ),
    evaluatedAt: flags['evaluated-at'] || new Date().toISOString(),
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'probe-readiness') {
    const allowed = new Set(['base-url', 'binding-json']);
    if (Object.keys(flags).some((name) => !allowed.has(name))) {
      throw new Error('probe-readiness received an unsupported flag');
    }
    const result = await collectCandidateReadinessEvidence({
      baseUrl: required(flags, 'base-url'),
      binding: readJson(required(flags, 'binding-json'), 'Candidate binding'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'snapshot-deployments') {
    if (Object.keys(flags).length > 0) {
      throw new Error('snapshot-deployments does not accept selector flags');
    }
    const credentials = railwayPublicApiCredentials(command);
    const result = await fetchRailwayDeploymentSnapshot({
      ...credentials,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'snapshot-staging-isolation') {
    if (Object.keys(flags).length > 0) {
      throw new Error('snapshot-staging-isolation does not accept selector flags');
    }
    const credentials = railwayPublicApiCredentials(command);
    const result = await withRailwayCliCredentials(
      credentials,
      () => collectStagingDatabaseIsolationEvidence(),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'preflight' || command === 'dry-run') {
    const result = evaluateRailwayPreflight(readPreflightInput(command, flags));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'rollback') {
    const targetDeploymentId = required(flags, 'target-deployment-id');
    if (required(flags, 'confirm') !== `ROLLBACK:${targetDeploymentId}`) {
      throw new Error('rollback confirmation must exactly match ROLLBACK:<deployment-id>');
    }
    const credentials = railwayPublicApiCredentials(command);
    const result = await rollbackRailwayDeployment({
      ...credentials,
      targetDeploymentId,
      deployments: readJson(required(flags, 'deployments-json'), 'Railway deployments'),
      currentDeploymentId: required(flags, 'current-deployment-id'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error([
    'Usage:',
    '  railway-release-gate.cjs probe-readiness --base-url HTTPS_URL --binding-json PATH',
    '  railway-release-gate.cjs snapshot-deployments',
    '  railway-release-gate.cjs snapshot-staging-isolation',
    '  railway-release-gate.cjs preflight --status-json PATH --deployments-json PATH',
    '    --expected-commit SHA --readiness-evidence-json PATH --smoke-evidence-json PATH',
    '    --staging-isolation-evidence-json PATH',
    '  railway-release-gate.cjs dry-run --status-json PATH --deployments-json PATH',
    '    --expected-commit SHA --readiness-evidence-json PATH --smoke-evidence-json PATH',
    '    --staging-isolation-evidence-json PATH [--evaluated-at ISO_TIMESTAMP]',
    '  railway-release-gate.cjs rollback --deployments-json PATH',
    '    --current-deployment-id ID --target-deployment-id ID --confirm ROLLBACK:ID',
  ].join('\n'));
}

main().catch((error) => {
  process.stderr.write(`${error?.message || 'Railway release gate failed'}\n`);
  process.exitCode = 1;
});
