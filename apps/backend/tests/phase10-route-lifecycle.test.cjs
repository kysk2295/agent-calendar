'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { listProductionRoutes } = require('../app/lib/production-route-registry');
const {
  assertMobileEntryRouteLifecycle,
  assertRouteLifecycleClassified,
  assertRouteRemovalAllowed,
  buildRouteLifecycleReport,
} = require('../app/lib/route-lifecycle');

const CLI = path.resolve(__dirname, '../tools/phase10-route-lifecycle-audit.cjs');

test('every production route has one accountable lifecycle classification', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-25' });
  assert.equal(report.totalRoutes, listProductionRoutes().length);
  assert.equal(report.classifiedRoutes, report.totalRoutes);
  assert.deepEqual(report.unclassifiedRoutes, []);
  assert.deepEqual(report.stalePolicyEntries, []);
  assert.equal(report.classificationComplete, true);
  assert.equal(assertRouteLifecycleClassified(report), true);
  assert.deepEqual(report.testOnlyRoutes, []);

  const keys = report.routes.map((route) => route.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('compatibility routes have explicit replacements and removal dates', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-25' });
  const compatibility = report.routes.filter((route) => route.lifecycle === 'compatibility');
  assert.ok(compatibility.length >= 10);
  for (const route of compatibility) {
    assert.match(route.removeAfter, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(route.replacement.startsWith('/api/'));
    assert.notEqual(route.consumer, '');
  }

  const phase1Aliases = compatibility
    .filter((route) => route.key.includes(' /api/phase1/'))
    .map((route) => route.key);
  assert.ok(phase1Aliases.includes('GET /api/phase1/tasks'));
  assert.ok(phase1Aliases.includes('GET /api/phase1/calendar-events'));
  assert.ok(phase1Aliases.includes('GET /api/phase1/wiki/search'));
  assert.ok(phase1Aliases.includes('GET /api/phase1/agent-work/:sessionId/stream'));
});

test('Desktop has no production-disabled route dependencies', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-25' });
  assert.deepEqual(report.supportedClientDisabledRoutes, []);
  assert.deepEqual(
    report.routes
      .filter((route) => (
        route.lifecycle === 'stable-desktop'
        && ['scoped_product', 'auth_public', 'auth_session'].includes(route.class)
      ))
      .map((route) => route.key),
    [],
  );
  assert.equal(report.mobileEntryReady, false);
  assert.throws(
    () => assertMobileEntryRouteLifecycle(report),
    /compatibility_route_present/,
  );
});

test('route lifecycle fails closed on unclassified registry drift and stale policy entries', () => {
  const routes = listProductionRoutes();
  const drifted = routes.concat({
    method: 'POST',
    pathPattern: '/api/unowned/new-surface',
    class: 'scoped_product',
    persistence: 'write',
    action: 'unowned_new_surface',
    idempotent: true,
    role: 'owner',
  });
  const unclassified = buildRouteLifecycleReport({
    asOf: '2026-07-25',
    routes: drifted,
  });
  assert.deepEqual(unclassified.unclassifiedRoutes, ['POST /api/unowned/new-surface']);
  assert.throws(
    () => assertRouteLifecycleClassified(unclassified),
    /route_lifecycle_unclassified/,
  );

  const withoutPhase1Tasks = routes.filter(
    (route) => !(route.method === 'GET' && route.pathPattern === '/api/phase1/tasks'),
  );
  const stale = buildRouteLifecycleReport({
    asOf: '2026-07-25',
    routes: withoutPhase1Tasks,
  });
  assert.ok(stale.stalePolicyEntries.includes('GET /api/phase1/tasks'));
  assert.throws(
    () => assertRouteLifecycleClassified(stale),
    /route_lifecycle_stale_policy/,
  );
});

test('route removal requires an elapsed removal date and 28 observed zero-traffic days', () => {
  assert.equal(assertRouteRemovalAllowed('POST /api/tasks/share-draft', {
    asOf: '2026-11-30',
    zeroTrafficSince: '2026-10-01',
  }), true);

  assert.throws(
    () => assertRouteRemovalAllowed('POST /api/tasks/share-draft', {
      asOf: '2026-10-01',
      zeroTrafficSince: '2026-08-01',
    }),
    /removal_date_not_reached/,
  );
  assert.throws(
    () => assertRouteRemovalAllowed('POST /api/tasks/share-draft', {
      asOf: '2026-11-01',
      zeroTrafficSince: '2026-10-20',
    }),
    /zero_traffic_window_incomplete/,
  );
  assert.throws(
    () => assertRouteRemovalAllowed('GET /api/calendar/unified', {
      asOf: '2027-01-01',
      zeroTrafficSince: '2026-01-01',
    }),
    /stable_route_removal_forbidden/,
  );
  assert.throws(
    () => assertRouteRemovalAllowed('POST /api/phase1/agent-work/:sessionId/publish', {
      asOf: '2027-01-01',
      zeroTrafficSince: '2026-01-01',
    }),
    /security_tombstone_removal_forbidden/,
  );
});

test('retired calendar draft stays blocked until its removal date and traffic window pass', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-25' });
  const retired = report.routes.find((route) => route.key === 'POST /api/calendar/draft');
  assert.equal(retired.lifecycle, 'removal-candidate');
  assert.equal(retired.replacement, '/api/assistant/ingest');
  assert.equal(retired.removeAfter, '2026-10-31');
  assert.equal(retired.class, 'production_disabled');
});

test('retired global Agent Operations tick preserves server-owned scheduling', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-25' });
  const retired = report.routes.find((route) => route.key === 'POST /api/agent-operations/tick');
  assert.equal(retired.lifecycle, 'removal-candidate');
  assert.equal(retired.replacement, '/api/agent-operations/tasks/:id/run-now');
  assert.equal(retired.removeAfter, '2026-10-31');
  assert.equal(retired.class, 'production_disabled');
});

test('retired Workboard conversion routes delegated work through the review flow', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-25' });
  const retired = report.routes.find((route) => route.key === 'POST /api/workboard/convert');
  assert.equal(retired.lifecycle, 'removal-candidate');
  assert.equal(retired.replacement, '/api/agent-operations/work');
  assert.equal(retired.removeAfter, '2026-10-31');
  assert.equal(retired.class, 'production_disabled');
});

test('bounded route lifecycle CLI reports blockers and strict Mobile entry exits nonzero', () => {
  const normal = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(normal.status, 0, normal.stderr);
  const report = JSON.parse(normal.stdout);
  assert.equal(report.classificationComplete, true);
  assert.equal(report.mobileEntryReady, false);
  assert.deepEqual(report.supportedClientDisabledRoutes, []);
  assert.doesNotMatch(normal.stdout, /Bearer|token|workspaceId|userId|\/Users\//i);

  const strict = spawnSync(process.execPath, [CLI, '--require-mobile-entry'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(strict.status, 2);
  assert.equal(JSON.parse(strict.stdout).mobileEntryReady, false);
});
