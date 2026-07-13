const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');

const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { HermesStore } = require('../app/lib/store');
const { OFFICIAL_PROFILE_NAMES } = require('../app/lib/official-profiles');
const { relayTokensMatch } = require('../app/lib/railway-relay');
const { safeRuntimeError } = require('../app/lib/runtime-gateway');

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

test('protects Relay snapshots with caller or bridge authentication', async () => {
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
    const unauthenticated = await fetch(`${baseUrl}/api/relay/snapshot`);
    const callerAuthenticated = await fetch(`${baseUrl}/api/relay/snapshot`, {
      headers: { authorization: 'Bearer client-token' },
    });

    // Then
    assert.equal(unauthenticated.status, 401);
    assert.equal(callerAuthenticated.status, 404);
  } finally {
    await close(server);
  }
});

test('projects Relay snapshots to official profiles and safe public capability metadata', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RELAY_TOKEN: 'relay-token',
    },
  });
  const baseUrl = await listen(server);
  const unsafeSnapshot = {
    source: 'hostile-test-relay',
    debugSecret: 'super-secret',
    privatePath: '/Users/koyunseo/private-top-level',
    rawCommand: 'hermes --yolo',
    agents: [{ id: 'marketflow', name: 'marketflow', runtimeBinding: { commandTemplate: 'hermes --yolo' } }],
    tools: [],
    skills: [],
    data: {
      agents: [
        { id: 'marketflow', name: 'marketflow', runtimeBinding: { commandTemplate: 'hermes --yolo' } },
        {
          id: 'bizconsultant',
          name: 'bizconsultant',
          status: 'Idle',
          profile: { name: 'bizconsultant', path: '/Users/koyunseo/private-profile' },
          runtimeBinding: { commandTemplate: 'hermes --yolo' },
          skills: [{ id: 'research', name: 'Research', sourcePath: '/Users/koyunseo/private-skill' }],
        },
      ],
      tools: [{ id: 'browser', name: 'Browser', command: 'super-secret-command', raw: { token: 'super-secret' } }],
      skills: [{ id: 'research', name: 'Research', sourcePath: '/Users/koyunseo/private-skill' }],
      toolsets: ['safe', 'shell'],
      mcpServers: [{ id: 'shell-server', command: 'super-secret-command', raw: { token: 'super-secret' } }],
    },
    profileReadiness: {
      requiredProfiles: [
        {
          profile: 'bizconsultant',
          present: true,
          status: 'ready',
          setup: {
            profileRoot: '/Users/koyunseo/private-profile',
            dashboard: { command: 'hermes --yolo' },
          },
        },
        { profile: 'marketflow', present: true, status: 'ready' },
      ],
    },
  };
  unsafeSnapshot.state = { profileReadiness: unsafeSnapshot.profileReadiness };

  try {
    const publishResponse = await fetch(`${baseUrl}/api/relay/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify(unsafeSnapshot),
    });

    // When
    const callerHeaders = { authorization: 'Bearer client-token' };
    const [agentsResponse, toolsResponse, stateResponse, snapshotResponse] = await Promise.all([
      fetch(`${baseUrl}/api/agents`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/tools`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/state`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/relay/snapshot`, { headers: callerHeaders }),
    ]);
    const [agents, tools, state, snapshot] = await Promise.all([
      agentsResponse.json(),
      toolsResponse.json(),
      stateResponse.json(),
      snapshotResponse.json(),
    ]);

    // Then
    assert.equal(publishResponse.status, 200);
    assert.equal(agents.agents.length, 1);
    assert.equal(state.agents.length, 1);
    assert.equal(snapshot.agents.length, 1);
    assert.ok(agents.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.ok(state.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.ok(snapshot.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.deepEqual(tools.toolsets, ['safe']);
    assert.deepEqual(state.toolsets, ['safe']);
    assert.deepEqual(snapshot.toolsets, ['safe']);
    assert.deepEqual(tools.mcpServers, []);
    assert.deepEqual(state.mcpServers, []);
    assert.deepEqual(snapshot.mcpServers, []);
    assert.equal(tools.tools.length, 1);
    assert.equal(state.tools.length, 1);
    assert.equal(snapshot.tools.length, 1);
    assert.equal(tools.skills.length, 1);
    assert.equal(state.skills.length, 1);
    assert.equal(snapshot.skills.length, 1);
    for (const readiness of [agents.profileReadiness, state.profileReadiness, snapshot.profileReadiness]) {
      assert.ok(readiness.requiredProfiles.every((entry) => OFFICIAL_PROFILE_NAMES.includes(entry.profile)));
      assert.ok(readiness.requiredProfiles.every((entry) => Object.hasOwn(entry, 'setup') === false));
    }
    assert.equal(Object.hasOwn(tools.tools[0], 'command'), false);
    assert.equal(Object.hasOwn(tools.tools[0], 'raw'), false);
    assert.doesNotMatch(JSON.stringify({ agents, state, snapshot }), /commandTemplate/);
    assert.doesNotMatch(
      JSON.stringify({ agents, tools, state, snapshot }),
      /marketflow|--yolo|shell-server|super-secret|\/Users\/koyunseo/,
    );
  } finally {
    await close(server);
  }
});

test('projects direct runtime agent and tool reads through the same public policy', async () => {
  // Given
  const unsafeReadiness = {
    requiredProfiles: [
      {
        profile: 'bizconsultant',
        present: true,
        status: 'ready',
        setup: { profileRoot: '/Users/koyunseo/private-profile', dashboard: { command: 'hermes --yolo' } },
      },
      { profile: 'marketflow', present: true, status: 'ready' },
    ],
  };
  const unsafeAgents = [
    { id: 'marketflow', name: 'marketflow', runtimeBinding: { commandTemplate: 'hermes --yolo' } },
    {
      id: 'bizconsultant',
      name: 'bizconsultant',
      status: 'Ready',
      profile: { name: 'bizconsultant' },
      skills: [{ id: 'research', name: 'Research', description: 'Full nested skill' }],
    },
  ];
  const unsafeTools = [{ id: 'browser', name: 'Browser', description: 'Full nested tool', command: 'super-secret-command', raw: { token: 'super-secret' } }];
  const unsafeSkills = [{ id: 'research', name: 'Research', description: 'Full nested skill', sourcePath: '/Users/koyunseo/private-skill' }];
  const storedState = {
    tasks: [{ id: 'stored-task', title: 'Stored task' }],
    documents: [{ id: 'stored-document', title: 'Stored document' }],
    chatMessages: [{ id: 'stored-chat', text: 'Stored chat' }],
    sessions: [{ id: 'stored-session', title: 'Stored session' }],
    commandInboxArchivedIds: ['stored-command'],
  };
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    gatewayStore: { getState: () => storedState },
    fetchImpl: async (input) => {
      const runtimeUrl = new URL(String(input));
      const { pathname } = runtimeUrl;
      const payload = pathname === '/api/agents/bizconsultant/metrics'
        ? { ok: true, metrics: { completed: 3 } }
        : pathname === '/api/runs/run-data-state'
          ? {
            ok: true,
            data: {
              run: { id: 'run-data-state', status: 'completed' },
              state: {
                debugSecret: 'super-secret',
                privatePath: '/Users/koyunseo/private-top-level',
                agents: unsafeAgents,
                tools: unsafeTools,
                skills: unsafeSkills,
                toolsets: ['safe', 'shell'],
                mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
              },
            },
          }
        : pathname === '/api/runs/run-1'
          ? {
            ok: true,
            run: { id: 'run-1', status: 'completed' },
            state: { agents: unsafeAgents },
            agentSourceStatus: {
              ok: true,
              source: 'runtime-direct',
              profileCount: 2,
              rawToken: 'super-secret',
              privatePath: '/Users/koyunseo/private-top-level',
            },
            remoteVerification: {
              runtimeReachable: true,
              gatewayFallback: false,
              source: 'runtime-direct',
              checkedAt: '2026-07-13T00:00:00.000Z',
              command: 'super-secret-command',
            },
            data: {
              run: { id: 'run-1', status: 'completed' },
              state: {
                debugSecret: 'super-secret',
                privatePath: '/Users/koyunseo/private-top-level',
                agents: unsafeAgents,
                tools: unsafeTools,
                skills: unsafeSkills,
                toolsets: ['safe', 'shell'],
                mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
              },
            },
          }
        : pathname.startsWith('/api/agents')
        ? {
          ok: true,
          debugSecret: 'super-secret',
          agents: [{ id: 'bizconsultant' }],
          agent: pathname === '/api/agents/bizconsultant' ? unsafeAgents[1] : undefined,
          data: {
            agents: unsafeAgents,
            profileReadiness: unsafeReadiness,
          },
        }
        : pathname === '/api/tools'
          ? {
            ok: true,
            tools: [{ id: 'benchmark-tool', name: 'benchmark-tool' }, { id: 'browser' }],
            skills: [{ id: 'research' }, { command: 'super-secret-command' }],
            data: {
              tools: unsafeTools,
              skills: unsafeSkills,
              toolsets: ['safe', 'shell'],
              mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
            },
          }
          : runtimeUrl.searchParams.get('shape') === 'sibling-state'
            ? {
              ok: true,
              tools: unsafeTools,
              skills: unsafeSkills,
              state: {
                agents: unsafeAgents,
                profileReadiness: unsafeReadiness,
              },
            }
            : runtimeUrl.searchParams.get('shape') === 'data'
            ? {
              ok: true,
              data: {
                debugSecret: 'super-secret',
                privatePath: '/Users/koyunseo/private-top-level',
                rawCommand: 'hermes --yolo',
                agents: unsafeAgents,
                tools: unsafeTools,
                skills: unsafeSkills,
                profileReadiness: unsafeReadiness,
                toolsets: ['safe', 'shell'],
                mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
              },
            }
            : runtimeUrl.searchParams.get('shape') === 'data-state'
              ? {
                ok: true,
                data: {
                  state: {
                    debugSecret: 'super-secret',
                    privatePath: '/Users/koyunseo/private-top-level',
                    rawCommand: 'hermes --yolo',
                    agents: unsafeAgents,
                    tools: unsafeTools,
                    skills: unsafeSkills,
                    profileReadiness: unsafeReadiness,
                    toolsets: ['safe', 'shell'],
                    mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
                  },
                },
              }
            : {
              ok: true,
              state: {
                debugSecret: 'super-secret',
                privatePath: '/Users/koyunseo/private-top-level',
                rawCommand: 'hermes --yolo',
                agents: unsafeAgents,
                tools: unsafeTools,
                skills: unsafeSkills,
                profileReadiness: unsafeReadiness,
                toolsets: ['safe', 'shell'],
                mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
              },
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const headers = { authorization: 'Bearer client-token' };
    const [agents, agentDetail, agentMetrics, runDetail, dataOnlyRun, tools, state, dataState, nestedDataState, siblingState] = await Promise.all([
      fetch(`${baseUrl}/api/agents`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/agents/bizconsultant`, { headers }).then(async (response) => ({ status: response.status, body: await response.json() })),
      fetch(`${baseUrl}/api/agents/bizconsultant/metrics`, { headers }).then(async (response) => ({ status: response.status, body: await response.json() })),
      fetch(`${baseUrl}/api/runs/run-1`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/runs/run-data-state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/tools`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state?shape=data`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state?shape=data-state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state?shape=sibling-state`, { headers }).then((response) => response.json()),
    ]);

    // Then
    assert.ok(agents.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.ok(agents.profileReadiness.requiredProfiles.every((entry) => OFFICIAL_PROFILE_NAMES.includes(entry.profile)));
    assert.ok(agents.profileReadiness.requiredProfiles.every((entry) => Object.hasOwn(entry, 'setup') === false));
    assert.equal(Object.hasOwn(agents, 'debugSecret'), false);
    assert.equal(Object.hasOwn(agents, 'state'), false);
    assert.equal(agents.agents[0].status, 'Ready');
    assert.equal(agents.agents[0].skills.length, 1);
    assert.equal(agentDetail.status, 200);
    assert.equal(agentDetail.body.agent.id, 'bizconsultant');
    assert.equal(agentMetrics.status, 200);
    assert.deepEqual(agentMetrics.body.metrics, { completed: 3 });
    assert.deepEqual(tools.toolsets, ['safe']);
    assert.deepEqual(tools.mcpServers, []);
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].id, 'browser');
    assert.equal(tools.tools[0].description, 'Full nested tool');
    assert.equal(tools.skills[0].description, 'Full nested skill');
    assert.ok(runDetail.data.state.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.deepEqual(runDetail.data.state.toolsets, ['safe']);
    assert.deepEqual(runDetail.data.state.mcpServers, []);
    assert.deepEqual(Object.keys(runDetail.agentSourceStatus).sort(), ['generatedAt', 'ok', 'profileCount', 'source']);
    assert.deepEqual(
      Object.keys(runDetail.remoteVerification).sort(),
      ['checkedAt', 'gatewayFallback', 'runtimeReachable', 'source'],
    );
    assert.ok(dataOnlyRun.data.state.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.deepEqual(dataOnlyRun.data.state.toolsets, ['safe']);
    assert.deepEqual(dataOnlyRun.data.state.mcpServers, []);
    assert.deepEqual(dataOnlyRun.state, dataOnlyRun.data.state);
    assert.ok(state.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.deepEqual(state.toolsets, ['safe']);
    assert.deepEqual(state.mcpServers, []);
    assert.equal(state.tools.length, 1);
    assert.equal(state.skills.length, 1);
    assert.ok(dataState.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.deepEqual(dataState.toolsets, ['safe']);
    assert.deepEqual(dataState.mcpServers, []);
    assert.equal(dataState.tools.length, 1);
    assert.equal(dataState.skills.length, 1);
    assert.equal(Object.hasOwn(dataState, 'data'), false);
    assert.ok(nestedDataState.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.deepEqual(nestedDataState.toolsets, ['safe']);
    assert.deepEqual(nestedDataState.mcpServers, []);
    assert.equal(nestedDataState.tools.length, 1);
    assert.equal(nestedDataState.skills.length, 1);
    assert.equal(Object.hasOwn(nestedDataState, 'data'), false);
    assert.equal(siblingState.tools.length, 1);
    assert.equal(siblingState.skills.length, 1);
    for (const publicState of [state, dataState, nestedDataState, siblingState]) {
      assert.deepEqual(publicState.tasks, storedState.tasks);
      assert.deepEqual(publicState.documents, storedState.documents);
      assert.deepEqual(publicState.chatMessages, storedState.chatMessages);
      assert.deepEqual(publicState.sessions, storedState.sessions);
      assert.deepEqual(publicState.commandInboxArchivedIds, storedState.commandInboxArchivedIds);
    }
    assert.doesNotMatch(JSON.stringify({ agents, agentDetail, runDetail, dataOnlyRun, state, dataState, nestedDataState, siblingState }), /commandTemplate/);
    assert.doesNotMatch(
      JSON.stringify({ agents, agentDetail, runDetail, dataOnlyRun, tools, state, dataState, nestedDataState, siblingState }),
      /marketflow|--yolo|shell-server|super-secret|\/Users\/koyunseo/,
    );
  } finally {
    await close(server);
  }
});

test('compares Relay tokens without accepting prefixes or unequal lengths', () => {
  // Given / When / Then
  assert.equal(relayTokensMatch('relay-token', 'relay-token'), true);
  assert.equal(relayTokensMatch('relay', 'relay-token'), false);
  assert.equal(relayTokensMatch('relay-token-extra', 'relay-token'), false);
});

test('runtime errors never expose private filesystem paths', () => {
  // Given / When
  const message = safeRuntimeError(
    'runner failed at /Users/koyunseo/private/work.md',
    'Runtime execution failed',
  );

  // Then
  assert.equal(message, 'Runtime execution failed');
});

test('runtime proxy failures return a safe public error', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    fetchImpl: async () => {
      throw new Error('runner failed at /Users/koyunseo/private/secrets.md');
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/unknown`, {
      headers: { authorization: 'Bearer client-token' },
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 503);
    assert.equal(body.error, 'Runtime request failed');
    assert.doesNotMatch(JSON.stringify(body), /\/Users\/koyunseo/);
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

test('routes mission launch through the live Mac mini relay', async () => {
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RELAY_TOKEN: 'relay-token',
    },
    fetchImpl: async () => {
      throw new Error('mission launch should use the relay instead of direct runtime fetch');
    },
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const missionPromise = fetch(`${baseUrl}/api/missions/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'product-build',
        goal: 'Verify remote mission execution',
        agentId: 'marketflow',
        source: 'desktop-mission',
        noApproval: true,
        yolo: true,
        toolsets: ['all'],
      }),
    });

    const polled = await pollPromise;
    assert.equal(polled.ok, true);
    assert.equal(polled.job.kind, 'runtime.request');
    assert.equal(polled.job.payload.method, 'POST');
    assert.equal(polled.job.payload.path, '/api/missions/launch');
    const runtimeBody = JSON.parse(polled.job.payload.body);

    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        ok: true,
        status: 201,
        body: {
          ok: true,
          run: {
            id: 'run-relay-mission',
            name: 'Verify remote mission execution',
            status: 'running',
            agent: 'default',
          },
        },
      }),
    });

    const response = await missionPromise;
    const body = await response.json();
    assert.equal(runtimeBody.goal, 'Verify remote mission execution');
    assert.equal(runtimeBody.agentId, 'default');
    assert.equal(runtimeBody.agent, 'default');
    assert.equal(runtimeBody.noApproval, false);
    assert.equal(runtimeBody.yolo, false);
    assert.deepEqual(runtimeBody.toolsets, ['safe']);
    assert.equal(response.status, 201);
    assert.equal(body.run.id, 'run-relay-mission');
    assert.equal(body.run.agent, 'default');
    assert.equal(body.relayRuntimeRequest, true);
    assert.equal(body.gatewayFallback, false);
  } finally {
    await close(server);
  }
});

test('direct run creation strips approval bypasses before the Mac mini relay', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_CLIENT_TOKEN: 'client-token',
      HERMES_RELAY_TOKEN: 'relay-token',
    },
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // When
    const runPromise = fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        goal: 'Untrusted direct run',
        agentId: 'marketflow',
        noApproval: true,
        yolo: true,
        toolsets: ['shell', 'browser'],
      }),
    });
    const polled = await pollPromise;
    const runtimeBody = JSON.parse(polled.job.payload.body);

    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({ ok: true, status: 201, body: { ok: true, run: { id: 'run-safe-direct' } } }),
    });
    assert.equal((await runPromise).status, 201);

    // Then
    assert.equal(runtimeBody.agentId, 'default');
    assert.equal(runtimeBody.agent, 'default');
    assert.equal(runtimeBody.noApproval, false);
    assert.equal(runtimeBody.yolo, false);
    assert.deepEqual(runtimeBody.toolsets, ['safe']);
  } finally {
    await close(server);
  }
});

test('scheduler job creation strips a removed profile before the Mac mini relay', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: { HERMES_RELAY_TOKEN: 'relay-token' },
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // When
    const schedulePromise = fetch(`${baseUrl}/api/scheduler/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Safe scheduled research',
        goal: 'Review approved sources',
        profile: 'marketflow',
      }),
    });
    const polled = await pollPromise;

    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        ok: true,
        status: 201,
        body: { ok: true, job: { id: 'cron-safe', name: 'Safe scheduled research' } },
      }),
    });
    const response = await schedulePromise;

    // Then
    assert.equal(response.status, 201);
    assert.equal(polled.job.payload.path, '/api/cron/jobs');
    assert.equal(polled.job.payload.query.profile, 'default');
  } finally {
    await close(server);
  }
});

test('scheduler job reads normalize removed runtime profiles before returning them', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      jobs: [{
        id: 'legacy-cron',
        name: 'Legacy market scan',
        profile: 'marketflow',
        agent: 'marketflow',
        schedule_display: 'every 1h',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/scheduler/jobs`, {
      headers: { authorization: 'Bearer client-token' },
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.equal(body.jobs[0].agent, 'default');
    assert.doesNotMatch(JSON.stringify(body.jobs[0]), /marketflow/);
  } finally {
    await close(server);
  }
});

test('routes Hermes chat through a profile mission without inventing an API server model', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: { HERMES_RELAY_TOKEN: 'relay-token' },
    fetchImpl: async () => {
      throw new Error('Hermes chat should use the relay instead of direct runtime fetch');
    },
  });
  const baseUrl = await listen(server);

  try {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const chatPromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Confirm the selected profile',
        agentId: 'bizconsultant',
        view: 'agent-operations',
      }),
    });

    const polled = await pollPromise;
    const relayJob = polled.job;

    await fetch(`${baseUrl}/api/relay/jobs/${relayJob.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        ok: true,
        body: {
          run: {
            id: 'run-profile-chat',
            status: 'completed',
            agent: 'bizconsultant',
            output: 'bizconsultant ready token=topsecret /Users/koyunseo/private.md',
            logs: [],
          },
        },
      }),
    });

    const response = await chatPromise;
    const body = await response.text();
    assert.equal(relayJob.kind, 'runtime.request');
    assert.equal(relayJob.payload.path, '/api/missions/launch');
    const runtimeBody = JSON.parse(relayJob.payload.body);
    assert.equal(runtimeBody.agentId, 'bizconsultant');
    assert.match(runtimeBody.idempotencyKey, /^relay-/);
    assert.equal(response.status, 200);
    assert.match(body, /bizconsultant ready/);
    assert.doesNotMatch(body, /hermes-agent/);
    assert.doesNotMatch(body, /profile-default/);
    assert.match(body, /"model":"unknown"/);
    assert.doesNotMatch(body, /topsecret|\/Users\/koyunseo/);
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
