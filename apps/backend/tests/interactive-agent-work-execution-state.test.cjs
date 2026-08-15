'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeExecutionState,
  publicMissionRecord,
} = require('../app/lib/public-agent-records');

test('Agent Work execution statuses project to the normalized public contract', () => {
  const cases = new Map([
    [undefined, 'idle'],
    ['accepted', 'queued'],
    ['waiting_runner', 'queued'],
    ['offered', 'queued'],
    ['leased', 'running'],
    ['running', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ]);

  for (const [rawStatus, expected] of cases) {
    assert.equal(normalizeExecutionState(rawStatus), expected);
    assert.equal(
      publicMissionRecord({ id: `mission-${expected}`, executionState: rawStatus }).executionState,
      expected,
    );
  }

  assert.equal(
    publicMissionRecord({ id: 'mission-row-accepted', status: 'accepted' }).executionState,
    'queued',
  );
  assert.equal(
    publicMissionRecord({
      id: 'mission-explicit-running',
      status: 'accepted',
      executionState: 'running',
    }).executionState,
    'running',
  );
});
