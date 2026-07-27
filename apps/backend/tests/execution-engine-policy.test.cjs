'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isFakeEngineAllowed } = require('../app/lib/execution-engine-policy');

test('Backend Fake Engine policy allows only the exact two-key test environment', () => {
  // Given: injected environments that include each supported and unsupported boundary case.
  const cases = [
    [{ NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, true],
    [{ NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, false],
    [{ AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, false],
    [{ NODE_ENV: 'test' }, false],
    [{ NODE_ENV: 'Test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, false],
    [{ NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1 ' }, false],
  ];

  // When: the gateway evaluates each injected environment.
  const actual = cases.map(([env]) => isFakeEngineAllowed(env));

  // Then: Fake is enabled only by the exact two-key test opt-in.
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
});

test('Backend Fake Engine policy fails closed for malformed injected environments', () => {
  // Given: malformed environment inputs.
  const inputs = [null, 1, 'test'];

  // When: the gateway evaluates them.
  const actual = inputs.map((env) => isFakeEngineAllowed(env));

  // Then: no malformed input enables Fake.
  assert.deepEqual(actual, [false, false, false]);
});
