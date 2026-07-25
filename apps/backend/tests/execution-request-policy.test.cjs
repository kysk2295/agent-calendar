const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyExecutionRequest } = require('../app/domains/execution/request-policy');

test('execution request policy recognizes only exact supported run actions', () => {
  for (const action of ['approve', 'stop', 'retry']) {
    const policy = classifyExecutionRequest({ method: 'POST', pathSegments: ['runs', 'run-1', action] });
    assert.equal(policy.runAction, true);
    assert.equal(policy.relayEligible, true);
  }

  assert.equal(classifyExecutionRequest({ method: 'POST', pathSegments: ['runs', 'run-1', 'delete'] }).runAction, false);
  assert.equal(classifyExecutionRequest({ method: 'POST', pathSegments: ['runs', 'run-1', 'approve', 'extra'] }).runAction, false);
  assert.equal(classifyExecutionRequest({ method: 'GET', pathSegments: ['runs', 'run-1', 'approve'] }).runAction, false);
});

test('execution request policy classifies creation and mission execution', () => {
  assert.deepEqual(
    classifyExecutionRequest({ method: 'POST', pathSegments: ['runs'] }),
    { runCreate: true, runAction: false, missionLaunch: false, missionSchedule: false, relayEligible: true },
  );
  assert.equal(classifyExecutionRequest({ method: 'POST', pathSegments: ['missions', 'launch'] }).missionLaunch, true);
  assert.equal(classifyExecutionRequest({ method: 'POST', pathSegments: ['missions', 'schedule'] }).missionSchedule, true);
});
