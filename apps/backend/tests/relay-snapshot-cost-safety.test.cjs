const assert = require('node:assert/strict');
const test = require('node:test');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('rejects oversized Relay snapshots before they can recreate high network usage', async () => {
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RELAY_TOKEN: 'relay-token',
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/relay/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        source: 'cost-safety-test',
        state: { oversized: 'x'.repeat(512 * 1024) },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.deepEqual(body, {
      ok: false,
      error: 'relay_snapshot_too_large',
    });
  } finally {
    await close(server);
  }
});
