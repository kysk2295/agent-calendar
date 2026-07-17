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

test('explicit source commit identifies a CLI snapshot deployment', async () => {
  const server = createRailwayGatewayServer({
    env: {
      SOURCE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      RAILWAY_GIT_COMMIT_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      RAILWAY_DEPLOYMENT_ID: 'deployment-123',
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/gateway-status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.buildCommit, '0123456789ab');
    assert.equal(body.deploymentId, 'deployment-123');
  } finally {
    await close(server);
  }
});
