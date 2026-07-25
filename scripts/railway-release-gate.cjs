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

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    throw new Error(`${label} JSON is missing or invalid`);
  }
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
    const result = await fetchRailwayDeploymentSnapshot({
      apiToken: process.env.RAILWAY_API_TOKEN || '',
      projectToken: process.env.RAILWAY_PROJECT_TOKEN || '',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'snapshot-staging-isolation') {
    if (Object.keys(flags).length > 0) {
      throw new Error('snapshot-staging-isolation does not accept selector flags');
    }
    const result = await collectStagingDatabaseIsolationEvidence();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'preflight') {
    const result = evaluateRailwayPreflight({
      status: readJson(required(flags, 'status-json'), 'Railway status'),
      deployments: readJson(required(flags, 'deployments-json'), 'Railway deployments'),
      expectedCommit: required(flags, 'expected-commit'),
      readinessEvidence: readJson(
        required(flags, 'readiness-evidence-json'),
        'Candidate readiness evidence',
      ),
      smokeEvidence: readJson(
        required(flags, 'smoke-evidence-json'),
        'Candidate smoke evidence',
      ),
      stagingIsolationEvidence: readJson(
        required(flags, 'staging-isolation-evidence-json'),
        'Staging database isolation evidence',
      ),
      evaluatedAt: flags['evaluated-at'] || new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'rollback') {
    const targetDeploymentId = required(flags, 'target-deployment-id');
    if (required(flags, 'confirm') !== `ROLLBACK:${targetDeploymentId}`) {
      throw new Error('rollback confirmation must exactly match ROLLBACK:<deployment-id>');
    }
    const result = await rollbackRailwayDeployment({
      apiToken: process.env.RAILWAY_API_TOKEN || '',
      projectToken: process.env.RAILWAY_PROJECT_TOKEN || '',
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
    '  railway-release-gate.cjs rollback --deployments-json PATH',
    '    --current-deployment-id ID --target-deployment-id ID --confirm ROLLBACK:ID',
  ].join('\n'));
}

main().catch((error) => {
  process.stderr.write(`${error?.message || 'Railway release gate failed'}\n`);
  process.exitCode = 1;
});
