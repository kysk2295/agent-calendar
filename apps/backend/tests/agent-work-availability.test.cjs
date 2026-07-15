const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveLiveWorkAgentAvailability } = require('../app/lib/agent-work-availability');

test('live Work availability blocks an explicitly stopped responsible agent even when another profile is ready', () => {
  const availability = resolveLiveWorkAgentAvailability({
    agentId: 'bizconsultant',
    agents: [
      { id: 'bizconsultant', status: 'stopped' },
      { id: 'stockagent', status: 'ready' },
    ],
    profileReadiness: {
      requiredProfiles: [
        { profile: 'bizconsultant', present: true, status: 'ready' },
        { profile: 'stockagent', present: true, status: 'ready' },
      ],
    },
  });

  assert.equal(availability.available, false);
  assert.equal(availability.code, 'agent_unavailable');
  assert.equal(availability.status, 'stopped');
});

test('live Work availability allows an idle agent whose own profile is ready', () => {
  const availability = resolveLiveWorkAgentAvailability({
    agentId: 'bizconsultant',
    agents: [{ id: 'bizconsultant', status: 'Idle' }],
    profileReadiness: {
      requiredProfiles: [{ profile: 'bizconsultant', present: true, status: 'ready' }],
    },
  });

  assert.equal(availability.available, true);
});

test('live Work availability blocks a disabled responsible agent even when its profile is ready', () => {
  const availability = resolveLiveWorkAgentAvailability({
    agentId: 'bizconsultant',
    agents: [{ id: 'bizconsultant', status: 'Idle', enabled: false }],
    profileReadiness: {
      requiredProfiles: [{ profile: 'bizconsultant', present: true, status: 'ready' }],
    },
  });

  assert.equal(availability.available, false);
  assert.equal(availability.code, 'agent_unavailable');
  assert.equal(availability.status, 'disabled');
});

test('live Work availability blocks a missing or unavailable responsible profile', () => {
  const availability = resolveLiveWorkAgentAvailability({
    agentId: 'bizconsultant',
    agents: [{ id: 'bizconsultant', status: 'Idle' }],
    profileReadiness: {
      requiredProfiles: [{ profile: 'bizconsultant', present: false, status: 'unavailable' }],
    },
  });

  assert.equal(availability.available, false);
  assert.equal(availability.status, 'unavailable');
});
