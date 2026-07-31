'use strict';

/**
 * Product agent roster must be workspace-owned only.
 * Empty gateway / missing Hermes snapshot must not invent official-profile-fallback agents.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  return { status: response.status, body };
}

test('empty gateway agent roster does not invent official Hermes profiles', async () => {
  const server = createRailwayGatewayServer({
    env: {
      ...process.env,
      // Force offline / no live runtime so we hit gateway fallback snapshot path.
      HERMES_RUNTIME_URL: '',
      MACMINI_RUNTIME_URL: '',
    },
  });
  const baseUrl = await listen(server);
  try {
    const agents = await getJson(baseUrl, '/api/agents');
    assert.equal(agents.status, 200);
    assert.equal(agents.body.ok, true);
    assert.ok(Array.isArray(agents.body.agents));
    assert.equal(
      agents.body.agents.length,
      0,
      'empty workspace must not show synthetic default/bizconsultant/stockagent/uniportpm/wikicurator roster',
    );
    assert.equal(
      (agents.body.agents || []).some((agent) => agent?.source === 'official-profile-fallback'
        || agent?.agentSourceStatus?.source === 'official-profile-fallback'),
      false,
    );

    const state = await getJson(baseUrl, '/api/state');
    assert.equal(state.status, 200);
    assert.ok(Array.isArray(state.body.agents));
    assert.equal(state.body.agents.length, 0, 'empty state.agents must match empty product roster');
  } finally {
    await close(server);
  }
});
