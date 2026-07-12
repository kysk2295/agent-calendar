const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { HermesStore } = require('../app/lib/store');

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

test('rejects an unauthenticated API caller before forwarding the server runtime token', async () => {
  // Given
  const runtimeCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'server-runtime-token',
    },
    fetchImpl: async (...args) => {
      runtimeCalls.push(args);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/runtime-only`);
    const body = await response.json();

    // Then
    assert.equal(response.status, 401);
    assert.equal(body.error, 'caller_unauthorized');
    assert.equal(runtimeCalls.length, 0);
  } finally {
    await close(server);
  }
});

test('forwards only the server runtime token after caller authentication succeeds', async () => {
  // Given
  const runtimeCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'server-runtime-token',
    },
    fetchImpl: async (...args) => {
      runtimeCalls.push(args);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/runtime-only`, {
      headers: { authorization: 'Bearer client-token' },
    });

    // Then
    assert.equal(response.status, 200);
    assert.equal(runtimeCalls.length, 1);
    assert.equal(runtimeCalls[0][1].headers.authorization, 'Bearer server-runtime-token');
  } finally {
    await close(server);
  }
});

test('allows tokenless loopback development when no client token is configured', async () => {
  // Given
  const runtimeCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'server-runtime-token',
    },
    fetchImpl: async (...args) => {
      runtimeCalls.push(args);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/runtime-only`);

    // Then
    assert.equal(response.status, 200);
    assert.equal(runtimeCalls.length, 1);
  } finally {
    await close(server);
  }
});

test('fails closed when a public deployment has no client token configured', async () => {
  // Given
  const runtimeCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      RAILWAY_PUBLIC_DOMAIN: 'calendar.example.test',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'server-runtime-token',
    },
    fetchImpl: async (...args) => {
      runtimeCalls.push(args);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/runtime-only`);
    const body = await response.json();

    // Then
    assert.equal(response.status, 503);
    assert.equal(body.error, 'caller_auth_not_configured');
    assert.equal(runtimeCalls.length, 0);
  } finally {
    await close(server);
  }
});

test('keeps the Railway gateway health check public while other API routes remain protected', async () => {
  // Given
  const runtimeCalls = [];
  const server = createRailwayGatewayServer({
    env: {
      RAILWAY_PUBLIC_DOMAIN: 'calendar.example.test',
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
    },
    fetchImpl: async (...args) => {
      runtimeCalls.push(args);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const healthResponse = await fetch(`${baseUrl}/api/gateway-status`);
    const protectedResponse = await fetch(`${baseUrl}/api/runtime-only`);

    // Then
    assert.equal(healthResponse.status, 200);
    assert.equal(protectedResponse.status, 401);
    assert.equal(runtimeCalls.length, 0);
  } finally {
    await close(server);
  }
});

test('preserves relay callback authentication independently of the client token', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RELAY_TOKEN: 'relay-token',
      HERMES_RELAY_POLL_TIMEOUT_MS: '1',
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/relay/poll?timeout=1`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
  } finally {
    await close(server);
  }
});

test('does not let the client token replace relay callback authentication', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RELAY_TOKEN: 'relay-token',
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/relay/poll?timeout=1`, {
      headers: { authorization: 'Bearer client-token' },
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 401);
    assert.equal(body.error, 'relay_unauthorized');
  } finally {
    await close(server);
  }
});

test('reports offline fallback agents and their source as unavailable', async () => {
  // Given
  const state = { agents: [], runs: [], agentProfileRequests: [] };
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: { getState: () => state },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/agents`);
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.ok(body.agents.length > 0);
    assert.ok(body.agents.every((agent) => agent.status === 'Unavailable'));
    assert.equal(body.agentSourceStatus.ok, false);
    assert.equal(body.agentSourceStatus.runtimeReachable, false);
  } finally {
    await close(server);
  }
});

test('refuses to persist a fake queued run while the runtime and relay are offline', async () => {
  // Given
  let createRunCalls = 0;
  const state = { agents: [], runs: [], agentProfileRequests: [] };
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: {
      getState: () => state,
      createRun: () => {
        createRunCalls += 1;
        return { id: 'fake-run', status: 'Queued' };
      },
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Release verification', agentId: 'default' }),
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 503);
    assert.equal(body.error, 'runtime_unavailable');
    assert.equal(body.queued, false);
    assert.equal(createRunCalls, 0);
  } finally {
    await close(server);
  }
});

test('refuses to persist a fake mission run while the runtime and relay are offline', async () => {
  const state = { agents: [], runs: [], agentProfileRequests: [] };
  let saveRunCalls = 0;
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: {
      getState: () => state,
      saveRun: () => {
        saveRunCalls += 1;
        return { id: 'fake-mission-run' };
      },
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/missions/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Must not fake execution', agentId: 'default' }),
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error, 'runtime_unavailable');
    assert.equal(body.queued, false);
    assert.equal(saveRunCalls, 0);
  } finally {
    await close(server);
  }
});

test('returns an explicit pending profileRequest when offline profile creation is accepted', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-profile-pending-'));
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: new HermesStore({ dataDir }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Release Agent', role: 'release verification' }),
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.pending, true);
    assert.equal(body.profileRequest.status, 'pending');
    assert.equal(body.profileRequest.displayName, 'Release Agent');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('persists an accepted profileRequest across a local store restart', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-profile-durable-'));
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: new HermesStore({ dataDir }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Durable Agent', persona: 'careful' }),
    });
    const body = await response.json();
    const restartedState = new HermesStore({ dataDir }).getState();

    // Then
    assert.ok(restartedState.agentProfileRequests.some((request) => (
      request.id === body.profileRequest.id
      && request.status === 'pending'
      && request.displayName === 'Durable Agent'
    )));
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('falls back to public desktop settings when the runtime rejects settings access', async () => {
  const server = createRailwayGatewayServer({
    env: {},
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/settings`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.gatewayFallback, true);
    assert.ok(body.settings);
  } finally {
    await close(server);
  }
});

test('keeps hydration resource responses compact instead of repeating the complete state', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-compact-resources-'));
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: new HermesStore({ dataDir }),
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);
  const resources = [
    ['/api/tasks', 'tasks'],
    ['/api/calendar/events', 'events'],
    ['/api/inbox/commands?limit=200', 'items'],
    ['/api/documents', 'documents'],
    ['/api/scheduler/jobs', 'jobs'],
    ['/api/usage', 'usage'],
    ['/api/tools', 'tools'],
    ['/api/channels/status', 'channels'],
  ];

  try {
    for (const [resourcePath, collectionKey] of resources) {
      const response = await fetch(`${baseUrl}${resourcePath}`);
      const responseText = await response.text();
      const body = JSON.parse(responseText);

      assert.equal(response.status, 200, resourcePath);
      assert.ok(Object.hasOwn(body, collectionKey), `${resourcePath} must expose ${collectionKey}`);
      assert.equal(Object.hasOwn(body, 'state'), false, `${resourcePath} must not repeat state`);
      assert.equal(Object.hasOwn(body, 'data'), false, `${resourcePath} must not duplicate its collection under data`);
      assert.ok(Buffer.byteLength(responseText) < 100_000, `${resourcePath} response is unexpectedly large`);
    }
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
