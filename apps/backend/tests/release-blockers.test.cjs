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
const { registerTelegramWebhook } = require('../app/lib/connectors/telegram');

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

test('Telegram webhook accepts only the secret registered with Bot API before recording an update', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-telegram-webhook-'));
  const gatewayStore = new HermesStore({ dataDir });
  const botToken = `${'123456789'}:${'AA'}${'x'.repeat(33)}`;
  let registrationBody = null;
  await registerTelegramWebhook({
    botToken,
    webhookUrl: 'https://calendar.example.test/api/telegram/webhook',
    fetchImpl: async (_url, init) => {
      registrationBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const secret = registrationBody?.secret_token;
  assert.match(secret || '', /^[A-Za-z0-9_-]{32,256}$/);

  const server = createRailwayGatewayServer({
    env: {
      HERMES_TELEGRAM_BOT_TOKEN: botToken,
      HERMES_TELEGRAM_ALLOWED_CHAT_IDS: '1234',
    },
    gatewayStore,
  });
  const baseUrl = await listen(server);
  const update = {
    update_id: 1,
    message: {
      message_id: 2,
      date: 1_752_550_400,
      chat: { id: 1234 },
      from: { username: 'owner' },
      text: '확인 메시지',
    },
  };
  const postUpdate = (headerValue) => fetch(`${baseUrl}/api/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headerValue ? { 'x-telegram-bot-api-secret-token': headerValue } : {}),
    },
    body: JSON.stringify(update),
  });

  try {
    assert.equal((await postUpdate()).status, 401);
    assert.equal((await postUpdate('wrong-secret')).status, 401);
    assert.equal(gatewayStore.getState().telegramChatCandidates.length, 0);
    assert.equal((await postUpdate(secret)).status, 200);
    assert.equal(gatewayStore.getState().telegramChatCandidates.length, 1);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('public gateway status omits the Mac mini working directory', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      runtime: {
        machineName: 'Hermes Mac mini',
        hostname: 'hermes-mini.local',
        cwd: '/Users/koyunseo/Documents/agent-calendar',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/gateway-status`);
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.equal(body.runtime.machineName, 'Hermes Mac mini');
    assert.equal(body.runtime.hostname, 'hermes-mini.local');
    assert.equal(body.runtime.cwd, '');
    assert.doesNotMatch(JSON.stringify(body), /\/Users\/koyunseo/);
  } finally {
    await close(server);
  }
});

test('fallback health never exposes runtime recovery commands', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      RAILWAY_PUBLIC_DOMAIN: 'calendar.example.test',
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://user:password@runtime.test/base?token=top-secret',
    },
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.text();

    // Then
    assert.equal(response.status, 200);
    assert.match(body, /Mac mini runtime is unreachable/);
    assert.doesNotMatch(body, /recoveryCommand|residentInstallCommand|launchctl bootstrap|hermes\s+daemon/i);
    assert.doesNotMatch(body, /user:password|top-secret/);
    assert.equal(JSON.parse(body).runtimeUrl, 'https://runtime.test/base');
  } finally {
    await close(server);
  }
});

test('projects fallback documents command inbox and system connections through public records', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-fallback-records-'));
  const gatewayStore = new HermesStore({ dataDir });
  const chatMessage = gatewayStore.addChatMessage({
    role: 'user',
    text: 'Create a public task token=top-secret /Users/koyunseo/private.md',
    wikiPath: '/Users/koyunseo/private-wiki.md',
    source: 'web',
  });
  const commandItemId = `chat:${chatMessage.id}`;
  gatewayStore.setDaemonStatus({
    running: true,
    isTicking: true,
    intervalMs: 1_000,
    command: 'hermes --yolo',
    privatePath: '/Users/koyunseo/private-daemon',
    raw: { token: 'top-secret-daemon' },
  });
  const server = createRailwayGatewayServer({
    env: {
      HERMES_WIKI_ROOT: '/Users/koyunseo/private-vault',
    },
    gatewayStore,
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const createdDocument = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Public document',
        extractedText: 'Visible evidence token=top-secret /Users/koyunseo/private.txt',
        originalFilePath: '/Users/koyunseo/private.pdf',
        telegramFilePath: '/Volumes/private/file.pdf',
        sourceUsername: 'private-user',
      }),
    }).then((response) => response.json());
    const documents = await fetch(`${baseUrl}/api/documents`).then((response) => response.json());
    const inbox = await fetch(`${baseUrl}/api/inbox/commands`).then((response) => response.json());
    const starred = await fetch(`${baseUrl}/api/inbox/commands/${encodeURIComponent(commandItemId)}/star`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((response) => response.json());
    const taskAction = await fetch(`${baseUrl}/api/inbox/commands/${encodeURIComponent(commandItemId)}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'marketflow' }),
    }).then((response) => response.json());
    const connections = await fetch(`${baseUrl}/api/system/connections`).then((response) => response.json());
    const wiki = await fetch(`${baseUrl}/api/wiki`).then((response) => response.json());
    const daemon = await fetch(`${baseUrl}/api/scheduler/daemon`).then((response) => response.json());
    const tick = await fetch(`${baseUrl}/api/scheduler/tick`, { method: 'POST' }).then((response) => response.json());

    // Then
    const publicBody = JSON.stringify({ createdDocument, documents, inbox, starred, taskAction, connections, daemon, tick });
    assert.doesNotMatch(publicBody, /top-secret|\/Users\/|\/Volumes\/|originalFilePath|telegramFilePath|sourceUsername|marketflow/i);
    assert.equal(createdDocument.document.title, 'Public document');
    assert.equal(documents.documents[0].title, 'Public document');
    assert.equal(inbox.items[0].id, commandItemId);
    assert.equal(starred.item.starred, true);
    assert.equal(taskAction.task.agent, 'default');
    assert.equal(connections.wikiRoot, '');
    assert.equal(wiki.wikiRoot, '');
    assert.equal(wiki.wikiIndex.wikiRoot, '');
    assert.equal(daemon.daemon.running, true);
    assert.equal(tick.daemon.running, true);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('projects non-success runtime JSON and every public state collection', async () => {
  // Given
  const unsafeRecord = {
    id: 'unsafe-1',
    title: 'Visible record',
    command: 'hermes --yolo',
    privatePath: '/Users/koyunseo/private-record',
    raw: { token: 'top-secret' },
  };
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    fetchImpl: async (requestUrl) => {
      const pathname = new URL(String(requestUrl)).pathname;
      if (pathname === '/api/state') {
        return new Response(JSON.stringify({
          ok: true,
          state: {
            ticktickTasks: [unsafeRecord],
            events: [{ ...unsafeRecord, id: 'unsafe-event' }],
            externalCalendarEvents: [{ ...unsafeRecord, id: 'unsafe-calendar' }],
            mailMessages: [{ ...unsafeRecord, id: 'unsafe-mail' }],
            deletedAgentIds: ['marketflow'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: false,
        error: 'Visible runtime failure token=top-secret /Users/koyunseo/private-error',
        command: 'hermes --yolo',
        privatePath: '/Volumes/private-error',
        raw: { authorization: 'Bearer top-secret' },
      }), { status: 500, headers: { 'content-type': 'application/json' } });
    },
  });
  const baseUrl = await listen(server);
  const headers = { authorization: 'Bearer client-token' };

  try {
    // When
    const stateResponse = await fetch(`${baseUrl}/api/state`, { headers });
    const state = await stateResponse.json();
    const failedResponse = await fetch(`${baseUrl}/api/failing-runtime-route`, { headers });
    const failure = await failedResponse.json();

    // Then
    assert.equal(stateResponse.status, 200);
    assert.equal(failedResponse.status, 500);
    assert.equal(state.ticktickTasks[0].title, 'Visible record');
    assert.equal(state.events[0].title, 'Visible record');
    assert.equal(state.externalCalendarEvents[0].title, 'Visible record');
    assert.equal(state.mailMessages[0].title, 'Visible record');
    assert.deepEqual(state.deletedAgentIds, []);
    assert.match(failure.error, /Runtime request failed|Visible runtime failure/);
    assert.doesNotMatch(JSON.stringify({ state, failure }), /top-secret|marketflow|\/Users\/|\/Volumes\/|hermes --yolo|authorization|privatePath|"raw"/i);
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
    health: {
      ok: true,
      source: 'hostile-health-source',
      debugSecret: 'super-secret-health',
      privatePath: '/Users/koyunseo/private-health',
    },
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
          description: 'marketflow should not escape through an official profile',
          status: 'Idle',
          profile: { name: 'bizconsultant', path: '/Users/koyunseo/private-profile' },
          runtimeBinding: { commandTemplate: 'hermes --yolo' },
          skills: [{ id: 'research', name: 'Research', description: 'hf_1234567890abcdefghijklmnop', sourcePath: '/Users/koyunseo/private-skill' }],
        },
      ],
      tools: [{ id: 'browser', name: 'Browser', description: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', command: 'super-secret-command', raw: { token: 'super-secret' } }],
      skills: [{ id: 'research', name: 'Research', description: 'AIza1234567890abcdefghijklmnop', sourcePath: '/Users/koyunseo/private-skill' }],
      runs: [{
        id: 'relay-run',
        name: 'Relay research run',
        goal: 'Safe relay goal',
        agent: 'bizconsultant',
        model: 'Hermes',
        status: 'completed',
        progress: 100,
        logs: ['runner completed', 'Bearer relay-run-token', '/Users/koyunseo/private-run', 'hermes --yolo'],
        output: 'hf_1234567890abcdefghijklmnop',
        runtimeBinding: { commandTemplate: 'hermes --yolo' },
      }],
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
    const publishBody = await publishResponse.json();

    // When
    const callerHeaders = { authorization: 'Bearer client-token' };
    const [agentsResponse, toolsResponse, stateResponse, snapshotResponse, healthResponse, runLogsResponse] = await Promise.all([
      fetch(`${baseUrl}/api/agents`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/tools`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/state`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/relay/snapshot`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/health`, { headers: callerHeaders }),
      fetch(`${baseUrl}/api/runs/relay-run/logs`, { headers: callerHeaders }),
    ]);
    const [agents, tools, state, snapshot, health, runLogs] = await Promise.all([
      agentsResponse.json(),
      toolsResponse.json(),
      stateResponse.json(),
      snapshotResponse.json(),
      healthResponse.json(),
      runLogsResponse.json(),
    ]);

    // Then
    assert.equal(publishResponse.status, 200);
    assert.equal(publishBody.accepted, true);
    assert.equal(Object.hasOwn(publishBody, 'snapshot'), false);
    assert.doesNotMatch(JSON.stringify(publishBody), /super-secret|marketflow|\/Users\/koyunseo/);
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
    assert.equal(state.runs[0].id, 'relay-run');
    assert.equal(state.runs[0].name, 'Relay research run');
    assert.deepEqual(state.runs[0].logs, ['runner completed']);
    assert.deepEqual(runLogs.logs, ['runner completed']);
    assert.equal(health.relaySnapshot.source, 'unknown');
    assert.equal(Object.hasOwn(health, 'debugSecret'), false);
    for (const readiness of [agents.profileReadiness, state.profileReadiness, snapshot.profileReadiness]) {
      assert.ok(readiness.requiredProfiles.every((entry) => OFFICIAL_PROFILE_NAMES.includes(entry.profile)));
      assert.ok(readiness.requiredProfiles.every((entry) => Object.hasOwn(entry, 'setup') === false));
    }
    assert.equal(Object.hasOwn(tools.tools[0], 'command'), false);
    assert.equal(Object.hasOwn(tools.tools[0], 'raw'), false);
    assert.doesNotMatch(JSON.stringify({ agents, state, snapshot }), /commandTemplate/);
    assert.doesNotMatch(
      JSON.stringify({ agents, tools, state, snapshot, health }),
      /marketflow|--yolo|shell-server|super-secret|hostile-test-relay|hostile-health-source|relay-run-token|hf_1234567890|\/Users\/koyunseo/,
    );
    assert.equal(snapshot.source, 'unknown');
  } finally {
    await close(server);
  }
});

test('does not let empty persisted collections erase live runtime collections', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-empty-store-'));
  const runtimeCollections = {
    runs: [{ id: 'runtime-run', status: 'completed' }],
    documents: [{ id: 'runtime-document', title: 'Runtime document' }],
    chatMessages: [{ id: 'runtime-chat', text: 'Runtime chat' }],
    agentMissions: [{ id: 'runtime-mission', title: 'Runtime mission' }],
    agentSessions: [{ id: 'runtime-session', title: 'Runtime session' }],
    agentReports: [{ id: 'runtime-report', title: 'Runtime report' }],
    schedulerJobs: [{ id: 'hermes-cron:runtime-job', name: 'Runtime job', agentId: 'bizconsultant' }],
    workboardPages: [{ id: 'runtime-page', title: 'Runtime page' }],
  };
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    gatewayStore: new HermesStore({ dataDir }),
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      state: runtimeCollections,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/state`, {
      headers: { authorization: 'Bearer client-token' },
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    for (const [key, expected] of Object.entries(runtimeCollections)) {
      assert.ok(body[key].some((item) => item.id === expected[0].id), `${key} should retain runtime data`);
    }
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('prefers live runtime scalars while retaining stored fields for same-id collections', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    gatewayStore: {
      getState: () => ({
        runs: [{ id: 'shared-run', status: 'queued', documentId: 'stored-document' }],
      }),
    },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      state: {
        runs: [{ id: 'shared-run', status: 'completed', progress: 100 }],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/state`, {
      headers: { authorization: 'Bearer client-token' },
    });
    const body = await response.json();
    const run = body.runs.find((item) => item.id === 'shared-run');

    // Then
    assert.equal(response.status, 200);
    assert.equal(run.status, 'completed');
    assert.equal(run.progress, 100);
    assert.equal(run.documentId, 'stored-document');
  } finally {
    await close(server);
  }
});

test('drops hostile public metadata values while preserving trusted display metadata', async () => {
  // Given
  const marker = 'DO_NOT_LEAK_PUBLIC_METADATA';
  const runtimeState = {
    agents: [{
      id: 'bizconsultant',
      name: 'Biz Consultant',
      description: 'Approved public description',
      status: 'Ready',
      skills: [{ id: 'research', name: marker, description: marker, source: 'hostile-source' }],
    }, {
      id: 'default',
      name: 'Default Hermes',
      description: 'marketflow should not escape through display metadata',
      status: 'Ready',
    }],
    tools: [
      {
        id: 'browser',
        name: marker,
        label: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345',
        description: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        source: 'hostile-source',
      },
      {
        id: 'gdrive',
        name: 'Google Drive',
        description: 'Google Drive connector',
        source: 'telegram',
        type: 'connector',
        category: 'connector',
      },
    ],
    skills: [{
      id: 'research',
      name: 'hf_1234567890abcdefghijklmnop',
      description: 'AIza1234567890abcdefghijklmnop',
      source: 'hostile-source',
    }, {
      id: 'scheduled-research',
      name: 'Scheduled Research',
      description: 'Scheduled research skill',
      source: 'scheduler',
      type: 'skill',
      category: 'skill',
    }],
    agentSourceStatus: {
      ok: true,
      source: 'hostile-source',
      profileCount: 1,
      generatedAt: marker,
    },
    remoteVerification: {
      runtimeReachable: true,
      gatewayFallback: false,
      source: 'hostile-source',
      checkedAt: marker,
    },
  };
  const server = createRailwayGatewayServer({
    env: {
      HERMES_REMOTE_AUTH_TOKEN: 'client-token',
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    fetchImpl: async (input) => {
      const pathname = new URL(String(input)).pathname;
      const payload = pathname === '/api/tools'
        ? { ok: true, tools: runtimeState.tools, skills: runtimeState.skills, state: runtimeState }
        : pathname === '/api/runs/runtime-run'
          ? { ok: true, run: { id: 'runtime-run' }, data: { state: runtimeState } }
          : { ok: true, state: runtimeState };
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
    const [state, tools, run] = await Promise.all([
      fetch(`${baseUrl}/api/state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/tools`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/runs/runtime-run`, { headers }).then((response) => response.json()),
    ]);

    // Then
    assert.equal(state.agents[0].name, 'Biz Consultant');
    assert.equal(state.agents[0].description, 'Approved public description');
    assert.equal(state.tools[0].id, 'browser');
    assert.equal(state.skills[0].id, 'research');
    const connector = state.tools.find((item) => item.id === 'gdrive');
    assert.equal(connector.description, 'Google Drive connector');
    assert.equal(connector.source, 'telegram');
    assert.equal(connector.type, 'connector');
    assert.equal(connector.category, 'connector');
    const scheduledSkill = state.skills.find((item) => item.id === 'scheduled-research');
    assert.equal(scheduledSkill.source, 'scheduler');
    assert.equal(scheduledSkill.type, 'skill');
    assert.equal(scheduledSkill.category, 'skill');
    assert.equal(state.agentSourceStatus.source, 'unknown');
    assert.equal(state.remoteVerification.source, 'unknown');
    assert.doesNotMatch(
      JSON.stringify({ state, tools, run }),
      /DO_NOT_LEAK|hostile-source|marketflow|0123456789abcdef0123456789abcdef|hf_1234567890|AIza1234567890|eyJhbGci/,
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
      name: 'Biz Consultant',
      description: 'Rich nested duplicate survives',
      status: 'Ready',
      profile: { name: 'bizconsultant' },
      skills: [{ id: 'research', name: 'Research', description: 'Full nested skill' }],
    },
  ];
  const unsafeTools = [{ id: 'browser', name: 'Browser', description: 'Full nested tool', status: 'draft', command: 'super-secret-command', raw: { token: 'super-secret' } }];
  const unsafeSkills = [{ id: 'research', name: 'Research', description: 'Full nested skill', sourcePath: '/Users/koyunseo/private-skill' }];
  const unsafeRuns = [{
    id: 'run-sensitive',
    name: 'Safe public run',
    goal: 'Safe public goal',
    agent: 'bizconsultant',
    model: 'Hermes',
    status: 'completed',
    progress: 100,
    createdAt: '2026-07-13T00:00:00.000Z',
    documentId: 'document-safe',
    logs: [
      'runner completed',
      'Bearer direct-run-token',
      '/Users/koyunseo/private-run',
      '/Library/Application Support/Hermes/private-run',
      'Research complete; hermes --danger',
      'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-opaque',
      'hermes --danger',
    ],
    output: 'AIza1234567890abcdefghijklmnop',
    privatePath: '/Users/koyunseo/private-run',
    runtimeBinding: { commandTemplate: 'hermes --danger' },
    steps: [{ title: 'Safe step', detail: 'Bearer nested-step-token', time: '10:00' }],
  }];
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
      const payload = pathname === '/api/health'
        ? {
          ok: true,
          ready: true,
          status: 'healthy',
          uptimeMs: 1234,
          debugSecret: 'super-secret-health',
          privatePath: '/Users/koyunseo/private-health',
          rawCommand: 'hermes --danger',
        }
        : pathname === '/api/agents/bizconsultant/metrics'
        ? { ok: true, metrics: { completed: 3 } }
        : pathname === '/api/runs/run-logs/logs'
          ? {
            ok: true,
            debugSecret: 'top-level-run-secret',
            privatePath: '/Users/koyunseo/private-run-envelope',
            run: { ...unsafeRuns[0], id: 'run-logs', status: 'streaming' },
            logs: unsafeRuns[0].logs,
            data: {
              debugSecret: 'nested-run-secret',
              logs: unsafeRuns[0].logs,
            },
          }
        : pathname === '/api/runs/run-data-state'
          ? {
            ok: true,
            data: {
              run: { ...unsafeRuns[0], id: 'run-data-state' },
              state: {
                debugSecret: 'super-secret',
                privatePath: '/Users/koyunseo/private-top-level',
                agents: unsafeAgents,
                tools: unsafeTools,
                skills: unsafeSkills,
                runs: unsafeRuns,
                toolsets: ['safe', 'shell'],
                mcpServers: [{ id: 'shell-server', command: 'super-secret-command' }],
              },
            },
          }
        : pathname === '/api/runs/run-1'
          ? {
            ok: true,
            run: { ...unsafeRuns[0], id: 'run-1' },
            state: { agents: unsafeAgents, runs: unsafeRuns },
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
              run: { ...unsafeRuns[0], id: 'run-1' },
              state: {
                debugSecret: 'super-secret',
                privatePath: '/Users/koyunseo/private-top-level',
                agents: unsafeAgents,
                tools: unsafeTools,
                skills: unsafeSkills,
                runs: unsafeRuns,
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
                runs: unsafeRuns,
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
                runs: unsafeRuns,
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
                    runs: unsafeRuns,
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
                runs: unsafeRuns,
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
    const [agents, agentDetail, agentMetrics, runDetail, runLogs, dataOnlyRun, tools, state, dataState, nestedDataState, siblingState, health] = await Promise.all([
      fetch(`${baseUrl}/api/agents`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/agents/bizconsultant`, { headers }).then(async (response) => ({ status: response.status, body: await response.json() })),
      fetch(`${baseUrl}/api/agents/bizconsultant/metrics`, { headers }).then(async (response) => ({ status: response.status, body: await response.json() })),
      fetch(`${baseUrl}/api/runs/run-1`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/runs/run-logs/logs`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/runs/run-data-state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/tools`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state?shape=data`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state?shape=data-state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/state?shape=sibling-state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/health`, { headers }).then((response) => response.json()),
    ]);

    // Then
    assert.ok(agents.agents.every((agent) => OFFICIAL_PROFILE_NAMES.includes(agent.id)));
    assert.ok(agents.profileReadiness.requiredProfiles.every((entry) => OFFICIAL_PROFILE_NAMES.includes(entry.profile)));
    assert.ok(agents.profileReadiness.requiredProfiles.every((entry) => Object.hasOwn(entry, 'setup') === false));
    assert.equal(Object.hasOwn(agents, 'debugSecret'), false);
    assert.equal(Object.hasOwn(agents, 'state'), false);
    assert.equal(agents.agents[0].name, 'Biz Consultant');
    assert.equal(agents.agents[0].description, 'Rich nested duplicate survives');
    assert.equal(agents.agents[0].status, 'Ready');
    assert.equal(agents.agents[0].skills.length, 1);
    assert.equal(agentDetail.status, 200);
    assert.equal(agentDetail.body.agent.id, 'bizconsultant');
    assert.equal(agentMetrics.status, 200);
    assert.deepEqual(agentMetrics.body.metrics, { completed: 3 });
    assert.equal(runDetail.run.id, 'run-1');
    assert.equal(runDetail.run.name, 'Safe public run');
    assert.equal(runDetail.data.run.id, 'run-1');
    assert.deepEqual(runDetail.run.logs, ['runner completed']);
    assert.equal(Object.hasOwn(runDetail.data.run, 'runtimeBinding'), false);
    assert.equal(runLogs.run.status, 'streaming');
    assert.deepEqual(runLogs.logs, ['runner completed']);
    assert.deepEqual(tools.toolsets, ['safe']);
    assert.deepEqual(tools.mcpServers, []);
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].id, 'browser');
    assert.equal(tools.tools[0].description, 'Full nested tool');
    assert.equal(tools.tools[0].status, 'draft');
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
      assert.equal(publicState.runs[0].id, 'run-sensitive');
      assert.deepEqual(publicState.runs[0].logs, ['runner completed']);
    }
    assert.deepEqual(
      Object.keys(health).sort(),
      ['gatewayFallback', 'ok', 'ready', 'runtimeReachable', 'status', 'uptimeMs'],
    );
    assert.doesNotMatch(JSON.stringify({ agents, agentDetail, runDetail, dataOnlyRun, state, dataState, nestedDataState, siblingState }), /commandTemplate/);
    assert.doesNotMatch(
      JSON.stringify({ agents, agentDetail, runDetail, runLogs, dataOnlyRun, tools, state, dataState, nestedDataState, siblingState, health }),
      /marketflow|--yolo|--danger|shell-server|super-secret|run-secret|direct-run-token|nested-step-token|AIza1234567890|AbCdEfGhIjKlMnOpQrStUvWxYz|\/Users\/koyunseo|\/Library\/Application Support\/Hermes/,
    );
  } finally {
    await close(server);
  }
});

test('projects fallback run state detail and logs through the public run policy', async () => {
  // Given
  const unsafeRun = {
    id: 'fallback-run',
    name: 'Fallback run',
    goal: 'Safe fallback goal',
    agent: 'bizconsultant',
    status: 'gateway-fallback',
    documentId: 'fallback-document',
    logs: ['fallback saved', 'Bearer fallback-run-token', '/Users/koyunseo/private-fallback', 'hermes --danger'],
    output: 'hf_1234567890abcdefghijklmnop',
    runtimeBinding: { commandTemplate: 'hermes --danger' },
  };
  const gatewayStore = {
    getState: () => ({ runs: [unsafeRun] }),
    getRun: (id) => (id === unsafeRun.id ? unsafeRun : null),
  };
  const server = createRailwayGatewayServer({
    env: { HERMES_REMOTE_AUTH_TOKEN: 'client-token' },
    gatewayStore,
  });
  const baseUrl = await listen(server);

  try {
    // When
    const headers = { authorization: 'Bearer client-token' };
    const [state, detail, logs] = await Promise.all([
      fetch(`${baseUrl}/api/state`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/runs/fallback-run`, { headers }).then((response) => response.json()),
      fetch(`${baseUrl}/api/runs/fallback-run/logs`, { headers }).then((response) => response.json()),
    ]);

    // Then
    assert.equal(state.runs[0].id, 'fallback-run');
    assert.equal(state.runs[0].status, 'gateway-fallback');
    assert.equal(detail.run.id, 'fallback-run');
    assert.equal(detail.run.documentId, 'fallback-document');
    assert.deepEqual(logs.logs, ['fallback saved']);
    assert.doesNotMatch(
      JSON.stringify({ state, detail, logs }),
      /fallback-run-token|\/Users\/koyunseo|--danger|hf_1234567890|commandTemplate/,
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

test('projects Relay profile creation and tool test responses through public records', async () => {
  // Given
  const server = createRailwayGatewayServer({
    env: { HERMES_RELAY_TOKEN: 'relay-token' },
  });
  const baseUrl = await listen(server);
  const completeRelayRequest = async ({ requestPromise, runtimeBody, status = 200 }) => {
    const pollPromise = fetch(`${baseUrl}/api/relay/poll?timeout=1000`, {
      headers: { 'x-hermes-relay-token': 'relay-token' },
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const responsePromise = requestPromise();
    const polled = await pollPromise;
    await fetch(`${baseUrl}/api/relay/jobs/${polled.job.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({ ok: true, status, body: runtimeBody }),
    });
    return responsePromise.then((response) => response.json());
  };

  try {
    // When
    const profile = await completeRelayRequest({
      requestPromise: () => fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'research_helper', role: 'Public research helper' }),
      }),
      runtimeBody: {
        ok: true,
        name: 'research_helper',
        description: 'Public research helper',
        debugSecret: 'top-secret-profile',
        path: '/Users/koyunseo/.hermes/profiles/research_helper',
        rawCommand: 'hermes --yolo',
      },
      status: 201,
    });
    const toolTest = await completeRelayRequest({
      requestPromise: () => fetch(`${baseUrl}/api/tools/skill:research/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'default' }),
      }),
      runtimeBody: {
        ok: true,
        name: 'research',
        message: 'Skill is ready',
        token: 'top-secret-tool-token',
        sourcePath: '/Library/Application Support/Hermes/research',
        command: 'hermes --yolo',
      },
    });

    // Then
    assert.equal(profile.ok, true);
    assert.equal(profile.agent.id, 'research_helper');
    assert.equal(profile.agent.role, 'Public research helper');
    assert.equal(toolTest.ok, true);
    assert.equal(toolTest.tool.id, 'skill:research');
    assert.equal(toolTest.tool.lastTest.status, 'ok');
    assert.equal(toolTest.tool.lastTest.result.message, 'Skill is ready');
    assert.doesNotMatch(
      JSON.stringify({ profile, toolTest }),
      /top-secret|\/Users\/koyunseo|\/Library\/Application Support|rawCommand|sourcePath|commandTemplate|--yolo/,
    );
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

test('routes Hermes console chat through profile streaming without inventing an API server model', async () => {
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

    await fetch(`${baseUrl}/api/relay/jobs/${relayJob.id}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        event: 'delta',
        data: { text: 'bizconsultant ready token=topsecret /Users/koyunseo/private.md' },
      }),
    });

    await fetch(`${baseUrl}/api/relay/jobs/${relayJob.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hermes-relay-token': 'relay-token',
      },
      body: JSON.stringify({
        ok: true,
        text: 'bizconsultant ready token=topsecret /Users/koyunseo/private.md',
        runner: 'hermes-profile-chat',
        profile: 'bizconsultant',
        usage: { outputChars: 64, promptChars: 80 },
        provenance: { kind: 'mac-mini-hermes-profile', localChatCompletions: false },
      }),
    });

    const response = await chatPromise;
    const body = await response.text();
    assert.equal(relayJob.kind, 'profile.chat');
    assert.equal(relayJob.payload.profile, 'bizconsultant');
    assert.equal(relayJob.payload.stream, true);
    assert.equal('model' in relayJob.payload, false);
    assert.deepEqual(relayJob.payload.toolsets, ['safe']);
    assert.equal(relayJob.payload.yolo, false);
    assert.equal(relayJob.payload.noApproval, false);
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

test('projects fallback chat stream runs before sending SSE events', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-chat-projection-'));
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: new HermesStore({ dataDir }),
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Summarize the approved research',
        agentId: 'bizconsultant',
        view: 'agent-operations',
      }),
    });
    const body = await response.text();

    // Then
    assert.equal(response.status, 200);
    assert.match(body, /"status":"gateway-fallback"/);
    assert.match(body, /gateway fallback run created/);
    assert.doesNotMatch(body, /recoveryCommand=|residentInstallCommand|\/Users\/|commandTemplate|--[a-z]/i);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('projects fallback task and scheduler mutations through public records', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-record-projection-'));
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore: new HermesStore({ dataDir }),
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const createdTaskResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Public task',
        notes: 'Visible note',
        runFile: '/Users/koyunseo/private-task.md',
        secret: 'super-secret-task',
      }),
    });
    const createdTask = await createdTaskResponse.json();
    const patchedTask = await fetch(`${baseUrl}/api/tasks/${createdTask.task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Updated public task',
        runFile: '/Users/koyunseo/private-task-updated.md',
      }),
    }).then((response) => response.json());
    const createdJob = await fetch(`${baseUrl}/api/scheduler/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Public schedule', goal: 'Visible scheduled work', agent: 'bizconsultant' }),
    }).then((response) => response.json());
    const patchedJob = await fetch(`${baseUrl}/api/scheduler/jobs/${createdJob.job.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'draft',
        secret: 'super-secret-job',
        profileRoot: '/Users/koyunseo/private-profile',
        raw: { command: 'hermes --danger' },
      }),
    }).then((response) => response.json());
    const listedJobs = await fetch(`${baseUrl}/api/scheduler/jobs`).then((response) => response.json());

    // Then
    assert.equal(createdTask.task.title, 'Public task');
    assert.equal(createdTask.task.notes, 'Visible note');
    assert.equal(patchedTask.task.title, 'Updated public task');
    assert.equal(patchedJob.job.status, 'draft');
    assert.equal(listedJobs.jobs[0].status, 'draft');
    assert.doesNotMatch(
      JSON.stringify({ createdTask, patchedTask, createdJob, patchedJob, listedJobs }),
      /super-secret|\/Users\/koyunseo|profileRoot|"raw"|--danger|runFile/,
    );
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
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
    env: { HERMES_WIKI_ROOT: '/Users/koyunseo/private-wiki' },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    const [response, stateResponse] = await Promise.all([
      fetch(`${baseUrl}/api/settings`),
      fetch(`${baseUrl}/api/state`),
    ]);
    const [body, state] = await Promise.all([response.json(), stateResponse.json()]);

    assert.equal(response.status, 200);
    assert.equal(body.gatewayFallback, true);
    assert.ok(body.settings);
    assert.equal(body.settings.wikiConfigured, true);
    assert.equal(body.settings.wikiRoot, '');
    assert.equal(state.systemConnections.wikiConfigured, true);
    assert.equal(state.systemConnections.wikiRoot, '');
    assert.doesNotMatch(JSON.stringify({ body, state }), /\/Users\/koyunseo\/private-wiki/);
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

test('projects successful generic JSON and SSE runtime responses before returning them publicly', async () => {
  // Given
  const safeLongText = `Internal quarterly analysis ${'keeps useful context '.repeat(12)}`.trim();
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    fetchImpl: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/runtime-stream')) {
        return new Response([
          'event: progress',
          `data: ${JSON.stringify({ id: 'event-safe', kind: 'progress', text: safeLongText, apiKey: 'stream-secret', command: 'bash -lc whoami', profileRoot: '/Volumes/private/profile' })}`,
          '',
          '',
        ].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        task: {
          id: 'task-safe',
          title: safeLongText,
          status: 'completed',
          apiKey: 'json-secret',
          command: 'node private-script.js',
          profileRoot: '/Volumes/private/profile',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    // When
    const [jsonResponse, streamResponse] = await Promise.all([
      fetch(`${baseUrl}/api/runtime-task`),
      fetch(`${baseUrl}/api/runtime-stream`),
    ]);
    const [jsonBody, streamBody] = await Promise.all([jsonResponse.json(), streamResponse.text()]);

    // Then
    assert.equal(jsonBody.task.title, safeLongText);
    assert.match(streamBody, /event-safe/);
    assert.match(streamBody, /Internal quarterly analysis/);
    assert.doesNotMatch(
      JSON.stringify({ jsonBody, streamBody }),
      /json-secret|stream-secret|private-script|whoami|\/Volumes\/private|apiKey|profileRoot|"command"/,
    );
  } finally {
    await close(server);
  }
});

test('projects Agent Operations list and mutation records through strict public shapes', async () => {
  // Given
  const hostileTask = {
    id: 'task-public',
    missionId: 'mission-public',
    sessionId: 'session-public',
    title: '공개 작업',
    status: 'scheduled',
    origin: 'agent',
    apiKey: 'task-secret',
    raw: { command: 'hermes --yolo' },
    profileRoot: '/Volumes/private/hermes',
  };
  const service = {
    listState: () => ({
      ok: true,
      missions: [{
        id: 'mission-public',
        title: '공개 미션',
        objective: '시장 변화를 조사한다.',
        agentId: 'bizconsultant',
        status: 'active',
        apiKey: 'mission-secret',
        runtimeBinding: { commandTemplate: 'hermes --yolo' },
      }],
      tasks: [hostileTask],
      sessions: [{
        id: 'session-public',
        missionId: 'mission-public',
        taskId: 'task-public',
        status: 'scheduled',
        events: [{
          kind: 'progress',
          text: '안전한 진행 상황',
          command: 'curl https://private.test',
          metadata: { tool: 'web', harmlessInternal: 'must-not-be-public', nested: { command: 'curl private' } },
        }],
        token: 'session-secret',
      }],
      reports: [],
      daemon: { running: true, commandTemplate: 'node scheduler.js', lastError: '' },
    }),
    transitionTask: () => ({ ...hostileTask, status: 'blocked' }),
  };
  const server = createRailwayGatewayServer({ env: {}, agentOperationsService: service });
  const baseUrl = await listen(server);

  try {
    // When
    const list = await fetch(`${baseUrl}/api/agent-operations`).then((response) => response.json());
    const mutation = await fetch(`${baseUrl}/api/agent-operations/tasks/task-public/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((response) => response.json());

    // Then
    assert.equal(list.missions[0].title, '공개 미션');
    assert.equal(list.tasks[0].title, '공개 작업');
    assert.equal(list.sessions[0].events[0].text, '안전한 진행 상황');
    assert.equal(list.sessions[0].events[0].metadata.tool, 'web');
    assert.equal(Object.hasOwn(list.sessions[0].events[0].metadata, 'harmlessInternal'), false);
    assert.equal(mutation.task.status, 'blocked');
    assert.doesNotMatch(
      JSON.stringify({ list, mutation }),
      /mission-secret|task-secret|session-secret|--yolo|scheduler\.js|private\.test|\/Volumes\/private|apiKey|runtimeBinding|commandTemplate|profileRoot|"raw"|"command"/,
    );
  } finally {
    await close(server);
  }
});

test('runtime task scalars win merge conflicts while stored-only fields and scheduler IDs stay stable', async () => {
  // Given
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-runtime-precedence-'));
  const store = new HermesStore({ dataDir });
  store.createTask({
    id: 'task-shared',
    title: '저장된 제목',
    status: 'scheduled',
    notes: 'DB에만 있는 메모',
  });
  const runtimeTitle = `Internal runtime result ${'with preserved detail '.repeat(12)}`.trim();
  const server = createRailwayGatewayServer({
    env: {
      HERMES_RUNTIME_URL: 'https://runtime.test',
      HERMES_RUNTIME_TOKEN: 'runtime-token',
    },
    gatewayStore: store,
    fetchImpl: async () => new Response(JSON.stringify({
      state: {
        tasks: [{ id: 'task-shared', title: runtimeTitle, status: 'completed' }],
        schedulerJobs: [{
          id: 'native-job',
          name: 'Native scheduler job',
          agent: 'bizconsultant',
          source: 'scheduler',
          raw: { harmless: true },
        }],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const baseUrl = await listen(server);

  try {
    // When
    const body = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    const task = body.tasks.find((item) => item.id === 'task-shared');

    // Then
    assert.equal(task.status, 'completed');
    assert.equal(task.title, runtimeTitle);
    assert.equal(task.notes, 'DB에만 있는 메모');
    assert.equal(body.schedulerJobs[0].id, 'native-job');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
