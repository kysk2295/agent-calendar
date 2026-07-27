'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clientV1ContractManifest } = require('../app/lib/client-v1-contract');
const {
  buildRouteLifecycleReport,
} = require('../app/lib/route-lifecycle');

test('current client-v1 and route lifecycle evidence keeps Mobile entry blocked', () => {
  const report = buildRouteLifecycleReport({ asOf: '2026-07-27' });
  const operations = clientV1ContractManifest.families
    .flatMap((family) => family.operations);

  assert.equal(clientV1ContractManifest.contractId, 'client-v1');
  assert.ok(operations.some((entry) => entry.pathPattern === '/api/calendar/unified'));
  assert.equal(report.classificationComplete, true);
  assert.equal(report.mobileEntryReady, false);
  assert.ok(report.compatibilityRoutes.length > 0);
  assert.ok(report.removalCandidates.length > 0);
  assert.ok(report.mobileEntryBlockers.every((reason) => (
    reason.startsWith('compatibility_route_present:')
    || reason.startsWith('removal_candidate_present:')
  )));
});
