'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

const CHECKS = Object.freeze([
  Object.freeze({ id: 'backend_syntax', label: 'Backend syntax', npmScript: 'backend:check' }),
  Object.freeze({
    id: 'backend_isolation_auth',
    label: 'Backend Workspace isolation and auth',
    npmScript: 'test:backend:critical',
  }),
  Object.freeze({
    id: 'production_auth_mode_cutover',
    label: 'Production auth mode cutover',
    npmScript: 'test:production-auth-mode-cutover',
  }),
  Object.freeze({
    id: 'production_workspace_isolation',
    label: 'Production Workspace isolation',
    npmScript: 'verify:production-workspace-isolation',
  }),
  Object.freeze({ id: 'desktop_typecheck', label: 'Desktop typecheck', npmScript: 'typecheck' }),
  Object.freeze({
    id: 'first_user_journey_injected',
    label: 'First-user journey (injected AuthKit)',
    npmScript: 'verify:first-user-journey:injected',
  }),
]);

const EXTERNAL_GATES = Object.freeze([
  'railway_live_release_and_rollback',
  'external_penetration_test',
  'signed_notarized_desktop',
  'public_signed_runner_package',
  'external_operations_collector',
]);

function safeNonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function buildSummary({ results, startedAt, finishedAt, durationMs }) {
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const checks = CHECKS.map((check) => {
    const result = resultsById.get(check.id) || {};
    const status = result.status === 'pass' ? 'pass' : 'fail';
    return {
      id: check.id,
      status,
      exitCode: status === 'pass' ? 0 : safeNonNegativeInteger(result.exitCode, 1),
      durationMs: safeNonNegativeInteger(result.durationMs),
    };
  });
  const ok = checks.every((check) => check.status === 'pass');

  return {
    schemaVersion: 1,
    kind: 'production_readiness',
    scope: 'local_injected',
    ok,
    localReadiness: ok ? 'pass' : 'fail',
    productionReadiness: ok ? 'external_gates_pending' : 'local_checks_failed',
    startedAt,
    finishedAt,
    durationMs: safeNonNegativeInteger(durationMs),
    checks,
    externalGates: EXTERNAL_GATES.map((id) => ({ id, status: 'pending' })),
  };
}

function runCheck(check, { spawn = spawnSync, now = Date.now } = {}) {
  const started = now();
  process.stderr.write(`\n[production-readiness] RUN  ${check.label}\n`);

  let child;
  try {
    child = spawn('npm', ['run', check.npmScript], {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: ['inherit', 2, 2],
    });
  } catch {
    child = { status: 1 };
  }

  const durationMs = Math.max(0, now() - started);
  const exitCode = safeNonNegativeInteger(child && child.status, 1);
  const status = exitCode === 0 ? 'pass' : 'fail';
  process.stderr.write(
    `[production-readiness] ${status === 'pass' ? 'PASS' : 'FAIL'} ${check.label} (${durationMs}ms)\n`,
  );

  return { id: check.id, status, exitCode, durationMs };
}

function printHumanSummary(summary) {
  process.stderr.write('\nProduction readiness summary (local injected scope)\n');
  for (const check of summary.checks) {
    const definition = CHECKS.find((candidate) => candidate.id === check.id);
    process.stderr.write(
      `  ${check.status === 'pass' ? 'PASS' : 'FAIL'}  ${definition.label} (${check.durationMs}ms)\n`,
    );
  }
  process.stderr.write(`Local readiness: ${summary.localReadiness.toUpperCase()}\n`);
  process.stderr.write(
    `Production readiness: ${summary.productionReadiness}; ${summary.externalGates.length} external gates pending\n`,
  );
}

function main({ now = Date.now, clock = () => new Date().toISOString() } = {}) {
  const startedAt = clock();
  const started = now();
  const results = CHECKS.map((check) => runCheck(check, { now }));
  const finishedAt = clock();
  const summary = buildSummary({
    results,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, now() - started),
  });

  printHumanSummary(summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.ok ? 0 : 1;
}

module.exports = { CHECKS, EXTERNAL_GATES, buildSummary, main, printHumanSummary, runCheck };

if (require.main === module) {
  process.exitCode = main();
}
