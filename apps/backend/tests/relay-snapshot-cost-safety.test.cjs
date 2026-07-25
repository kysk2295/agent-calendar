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

test('accepts the current Relay payload but retains only compact operational state', async () => {
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
        health: { ok: true, status: 'ready' },
        state: {
          tasks: [{ id: 'duplicate-task', title: 'Canonical data belongs in Postgres' }],
          documents: [{ id: 'large-document', content: 'x'.repeat(1024 * 1024) }],
          runs: [{ id: 'runtime-run', status: 'running' }],
        },
        agents: [{ id: 'default', name: 'default', status: 'Ready' }],
      }),
    });
    const body = await response.json();
    const snapshotResponse = await fetch(`${baseUrl}/api/relay/snapshot`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    });
    const snapshot = await snapshotResponse.json();

    assert.equal(response.status, 200);
    assert.equal(body.accepted, true);
    assert.ok(JSON.stringify(body).length < 256);
    assert.equal(snapshotResponse.status, 200);
    assert.deepEqual(snapshot.state.tasks, []);
    assert.deepEqual(snapshot.state.documents, []);
    assert.equal(snapshot.state.runs[0].id, 'runtime-run');
    assert.equal(snapshot.state.agents[0].id, 'default');
    assert.ok(JSON.stringify(snapshot).length < 16 * 1024);
  } finally {
    await close(server);
  }
});

test('rejects Relay snapshots above the compatibility ceiling', async () => {
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
        state: { oversized: 'x'.repeat(4 * 1024 * 1024) },
      }),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'relay_snapshot_too_large',
    });
  } finally {
    await close(server);
  }
});
