'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHECKS,
  EXTERNAL_GATES,
  buildSummary,
} = require('./production-readiness.cjs');

test('CHECKS includes the production auth cutover and Workspace isolation gates', () => {
  assert.deepEqual(CHECKS, [
    { id: 'backend_syntax', label: 'Backend syntax', npmScript: 'backend:check' },
    {
      id: 'backend_isolation_auth',
      label: 'Backend Workspace isolation and auth',
      npmScript: 'test:backend:critical',
    },
    {
      id: 'production_auth_mode_cutover',
      label: 'Production auth mode cutover',
      npmScript: 'test:production-auth-mode-cutover',
    },
    {
      id: 'production_workspace_isolation',
      label: 'Production Workspace isolation',
      npmScript: 'verify:production-workspace-isolation',
    },
    { id: 'desktop_typecheck', label: 'Desktop typecheck', npmScript: 'typecheck' },
    {
      id: 'first_user_journey_injected',
      label: 'First-user journey (injected AuthKit)',
      npmScript: 'verify:first-user-journey:injected',
    },
  ]);
});

test('buildSummary emits the fixed secret-free local readiness contract', () => {
  const secret = 'sk_do_not_copy_this_value';
  const results = CHECKS.map((check, index) => ({
    id: check.id,
    status: 'pass',
    exitCode: 0,
    durationMs: index + 1,
    stdout: secret,
    stderr: secret,
    env: { WORKOS_API_KEY: secret },
    error: new Error(secret),
  }));

  const summary = buildSummary({
    results,
    startedAt: '2026-07-31T00:00:00.000Z',
    finishedAt: '2026-07-31T00:00:01.000Z',
    durationMs: 1000,
  });

  assert.deepEqual(Object.keys(summary), [
    'schemaVersion',
    'kind',
    'scope',
    'ok',
    'localReadiness',
    'productionReadiness',
    'startedAt',
    'finishedAt',
    'durationMs',
    'checks',
    'externalGates',
  ]);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.kind, 'production_readiness');
  assert.equal(summary.scope, 'local_injected');
  assert.equal(summary.ok, true);
  assert.equal(summary.localReadiness, 'pass');
  assert.equal(summary.productionReadiness, 'external_gates_pending');
  assert.deepEqual(summary.checks.map((check) => check.id), CHECKS.map((check) => check.id));
  assert.ok(summary.checks.every((check) => (
    Object.keys(check).join(',') === 'id,status,exitCode,durationMs'
  )));
  assert.deepEqual(summary.externalGates, EXTERNAL_GATES.map((id) => ({ id, status: 'pending' })));
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test('buildSummary aggregates failures without marking external gates complete', () => {
  const results = CHECKS.map((check, index) => ({
    id: check.id,
    status: index === 1 ? 'fail' : 'pass',
    exitCode: index === 1 ? 7 : 0,
    durationMs: 5,
  }));

  const summary = buildSummary({
    results,
    startedAt: '2026-07-31T00:00:00.000Z',
    finishedAt: '2026-07-31T00:00:01.000Z',
    durationMs: 1000,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.localReadiness, 'fail');
  assert.equal(summary.productionReadiness, 'local_checks_failed');
  assert.equal(summary.checks[1].exitCode, 7);
  assert.ok(summary.externalGates.every((gate) => gate.status === 'pending'));
});
