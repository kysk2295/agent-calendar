const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');

const telegram = require('../app/lib/connectors/telegram');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');
const { collectEnvSettings } = require('../app/lib/env-settings');
const { SecretStore } = require('../app/lib/secrets');
const { HermesStore } = require('../app/lib/store');

const AGENT_IDS = ['default', 'bizconsultant', 'stockagent', 'uniportpm', 'wikicurator'];

function syntheticBotToken(id, character) {
  return `${id}:${'AA'}${character.repeat(33)}`;
}

function telegramEnv() {
  return {
    HERMES_REMOTE_AUTH_TOKEN: 'owner-auth',
    HERMES_PUBLIC_BASE_URL: 'https://calendar.example.test',
    HERMES_TELEGRAM_ALLOWED_CHAT_IDS: '1234',
    HERMES_TELEGRAM_BOT_TOKEN: syntheticBotToken('100000001', 'a'),
    HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT: syntheticBotToken('100000002', 'b'),
    HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT: syntheticBotToken('100000003', 'c'),
    HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM: syntheticBotToken('100000004', 'd'),
    HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR: syntheticBotToken('100000005', 'e'),
  };
}

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

async function registeredWebhookSecret(botToken, webhookUrl) {
  let secret = '';
  await telegram.registerTelegramWebhook({
    botToken,
    webhookUrl,
    fetchImpl: async (_url, init) => {
      secret = JSON.parse(init.body || '{}').secret_token || '';
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return secret;
}

test('Telegram routing resolves default plus four Responsible Agent bot tokens without fallback', () => {
  assert.equal(typeof telegram.telegramBotRoutesFromEnv, 'function');
  assert.equal(typeof telegram.telegramBotTokenForAgent, 'function');
  if (
    typeof telegram.telegramBotRoutesFromEnv !== 'function'
    || typeof telegram.telegramBotTokenForAgent !== 'function'
  ) return;

  const env = telegramEnv();
  const routes = telegram.telegramBotRoutesFromEnv(env);

  assert.deepEqual(routes.map((route) => route.agentId), AGENT_IDS);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'default'), env.HERMES_TELEGRAM_BOT_TOKEN);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'bizconsultant'), env.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'stockagent'), env.HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'uniportpm'), env.HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'wikicurator'), env.HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'unsupported-agent'), '');

  delete env.HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM;
  assert.equal(telegram.telegramBotTokenForAgent(env, 'uniportpm'), '');
  assert.equal(telegram.telegramBotTokenForAgent(env, 'default'), env.HERMES_TELEGRAM_BOT_TOKEN);

  env.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT = env.HERMES_TELEGRAM_BOT_TOKEN;
  assert.equal(telegram.telegramBotTokenForAgent(env, 'default'), env.HERMES_TELEGRAM_BOT_TOKEN);
  assert.equal(telegram.telegramBotTokenForAgent(env, 'bizconsultant'), '');
});

test('Environment import and public settings retain five bot slots without exposing credentials', async () => {
  const env = telegramEnv();
  const { settings, imported } = collectEnvSettings(env, { overwrite: true });

  assert.equal(settings.telegram.botToken, env.HERMES_TELEGRAM_BOT_TOKEN);
  assert.deepEqual(settings.telegram.botTokens, {
    bizconsultant: env.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT,
    stockagent: env.HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT,
    uniportpm: env.HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM,
    wikicurator: env.HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR,
  });
  assert.equal(imported.filter((item) => item.env.startsWith('HERMES_TELEGRAM_BOT_TOKEN')).length, 5);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-telegram-secret-store-'));
  try {
    const secretStore = new SecretStore({ dataDir });
    secretStore.saveSettings(settings);
    const publicSettings = secretStore.getPublicSettings();
    assert.deepEqual(publicSettings.telegram.configuredAgentIds, AGENT_IDS);
    for (const token of AGENT_IDS.map((agentId) => telegram.telegramBotTokenForAgent(env, agentId))) {
      assert.equal(JSON.stringify(publicSettings).includes(token), false);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('System Connections bootstrap registers five distinct Telegram bot webhooks without exposing tokens', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-telegram-routes-'));
  const gatewayStore = new HermesStore({ dataDir });
  const env = telegramEnv();
  const telegramCalls = [];
  const server = createRailwayGatewayServer({
    env,
    gatewayStore,
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('api.telegram.org')) {
        telegramCalls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/system/connections/bootstrap`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-auth' },
    });
    const body = await response.json();

    assert.equal(response.status, 200, body.error || body.message || 'bootstrap failed');
    assert.equal(telegramCalls.length, 5);
    assert.deepEqual(
      telegramCalls.map((call) => call.body.url),
      [
        'https://calendar.example.test/api/telegram/webhook',
        'https://calendar.example.test/api/telegram/webhook/bizconsultant',
        'https://calendar.example.test/api/telegram/webhook/stockagent',
        'https://calendar.example.test/api/telegram/webhook/uniportpm',
        'https://calendar.example.test/api/telegram/webhook/wikicurator',
      ],
    );
    assert.equal(new Set(telegramCalls.map((call) => call.body.secret_token)).size, 5);
    assert.deepEqual(body.telegram.configuredAgentIds, AGENT_IDS);
    assert.equal(body.telegram.registeredCount, 5);
    assert.equal(gatewayStore.getState().telegramWebhook.registrations.length, 5);
    assert.deepEqual(
      gatewayStore.getState().telegramWebhook.registrations.map((registration) => registration.agentId),
      AGENT_IDS,
    );

    const headers = { authorization: 'Bearer owner-auth' };
    const connectionsResponse = await fetch(`${baseUrl}/api/system/connections`, { headers });
    const channelsResponse = await fetch(`${baseUrl}/api/channels/status`, { headers });
    const connections = await connectionsResponse.json();
    const channels = await channelsResponse.json();
    const telegramChannel = channels.channels.find((channel) => channel.id === 'telegram');

    assert.equal(connectionsResponse.status, 200);
    assert.deepEqual(connections.telegram.configuredAgentIds, AGENT_IDS);
    assert.equal(connections.telegram.registeredCount, 5);
    assert.equal(connections.telegram.registrations.length, 5);
    assert.equal(channelsResponse.status, 200);
    assert.deepEqual(telegramChannel.linkedAgents, AGENT_IDS);
    assert.deepEqual(telegramChannel.configuredAgentIds, AGENT_IDS);
    assert.equal(telegramChannel.registeredCount, 5);
    assert.deepEqual(channels.settings.telegram.configuredAgentIds, AGENT_IDS);
    for (const token of AGENT_IDS.map((agentId) => telegram.telegramBotTokenForAgent(env, agentId))) {
      assert.equal(JSON.stringify({ body, connections, channels, stored: gatewayStore.getState().telegramWebhook }).includes(token), false);
    }
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Existing poller mode preserves five live bot consumers without registering webhooks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-telegram-existing-poller-'));
  const gatewayStore = new HermesStore({ dataDir });
  const env = {
    ...telegramEnv(),
    HERMES_TELEGRAM_INGRESS_MODE: 'existing-poller',
  };
  const defaultSecret = await registeredWebhookSecret(
    env.HERMES_TELEGRAM_BOT_TOKEN,
    'https://calendar.example.test/api/telegram/webhook',
  );
  const telegramCalls = [];
  const server = createRailwayGatewayServer({
    env,
    gatewayStore,
    fetchImpl: async (url) => {
      if (String(url).includes('api.telegram.org')) telegramCalls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/system/connections/bootstrap`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-auth' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(telegramCalls.length, 0);
    assert.equal(body.telegram.ingressMode, 'existing-poller');
    assert.equal(body.telegram.state, 'ready');
    assert.equal(body.telegram.deliveryReady, true);
    assert.equal(body.telegram.registered, false);
    assert.equal(body.telegram.registeredCount, 0);
    assert.deepEqual(body.telegram.configuredAgentIds, AGENT_IDS);
    assert.equal(body.telegram.webhookUrl, '');
    assert.equal(gatewayStore.getState().telegramWebhook, null);

    const ingressResponse = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': defaultSecret,
      },
      body: JSON.stringify({
        update_id: 101,
        message: {
          message_id: 202,
          date: 1_700_000_000,
          chat: { id: 1234, type: 'private' },
          from: { username: 'owner' },
          text: '/hermes should stay with the existing poller',
        },
      }),
    });
    const ingressBody = await ingressResponse.json();

    assert.equal(ingressResponse.status, 404);
    assert.equal(ingressBody.reason, 'telegram_webhook_disabled');
    assert.equal(gatewayStore.listCommandInbox({ includeArchived: true }).length, 0);

    for (const token of AGENT_IDS.map((agentId) => telegram.telegramBotTokenForAgent(env, agentId))) {
      assert.equal(JSON.stringify(body).includes(token), false);
    }
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Responsible Agent webhook rejects a sibling secret and keeps its agent identity', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-telegram-agent-webhook-'));
  const gatewayStore = new HermesStore({ dataDir });
  const env = telegramEnv();
  const defaultSecret = await registeredWebhookSecret(
    env.HERMES_TELEGRAM_BOT_TOKEN,
    'https://calendar.example.test/api/telegram/webhook',
  );
  const businessSecret = await registeredWebhookSecret(
    env.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT,
    'https://calendar.example.test/api/telegram/webhook/bizconsultant',
  );
  const server = createRailwayGatewayServer({ env, gatewayStore });
  const baseUrl = await listen(server);
  const update = {
    update_id: 10,
    message: {
      message_id: 20,
      date: 1_752_550_400,
      chat: { id: 1234 },
      from: { username: 'owner' },
      text: '/hermes 이번 주 사업 기회를 조사해줘',
    },
  };
  const postUpdate = (secret) => fetch(`${baseUrl}/api/telegram/webhook/bizconsultant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(update),
  });

  try {
    const unknownResponse = await fetch(`${baseUrl}/api/telegram/webhook/bizconsultant/extra`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': businessSecret,
      },
      body: JSON.stringify(update),
    });
    assert.equal(unknownResponse.status, 401);

    assert.equal((await postUpdate(defaultSecret)).status, 401);
    assert.equal(gatewayStore.getState().telegramChatCandidates.length, 0);

    const response = await postUpdate(businessSecret);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.parsed.agentId, 'bizconsultant');
    assert.equal(body.parsed.sourceId, 'telegram:bizconsultant:1234:20');
    assert.equal(body.run.agent, 'bizconsultant');
    assert.equal(gatewayStore.getState().telegramChatCandidates[0].agentId, 'bizconsultant');
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Agent Report egress uses only the Responsible Agent bot token', async () => {
  assert.equal(typeof telegram.sendAgentReportTelegram, 'function');
  if (typeof telegram.sendAgentReportTelegram !== 'function') return;

  const env = telegramEnv();
  const calls = [];
  const report = {
    id: 'report-business',
    sessionId: 'session-business',
    title: '사업 기회 보고',
    findings: ['기회 A'],
    limitations: [],
  };
  const result = await telegram.sendAgentReportTelegram({
    env,
    agentId: 'bizconsultant',
    chatId: '1234',
    report,
    appUrl: 'agent-calendar://sessions/session-business',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(result.message_id, 77);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes(env.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT), true);
  assert.equal(calls[0].url.includes(env.HERMES_TELEGRAM_BOT_TOKEN), false);

  delete env.HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT;
  await assert.rejects(
    telegram.sendAgentReportTelegram({
      env,
      agentId: 'bizconsultant',
      chatId: '1234',
      report,
      fetchImpl: async () => {
        throw new Error('missing agent token must not fall back to the default bot');
      },
    }),
    (error) => error?.code === 'telegram_not_configured',
  );
  assert.equal(calls.length, 1);
});

test('Missing Responsible Agent bot configuration marks report delivery not configured', async () => {
  const { deliverAgentReport } = require('../app/lib/agent-report-delivery');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-telegram-report-route-'));
  const gatewayStore = new HermesStore({ dataDir });
  const mission = gatewayStore.createAgentMission({
    id: 'mission-business-report',
    title: '사업 기회 조사',
    agentId: 'bizconsultant',
  });
  const session = gatewayStore.createAgentSession({
    id: 'session-business-report',
    missionId: mission.id,
    status: 'completed',
  });
  const report = gatewayStore.createAgentReport({
    id: 'report-business-route-missing',
    missionId: mission.id,
    sessionId: session.id,
    status: 'ready',
    deliveryStatus: 'pending',
    findings: ['기회 A'],
    evidence: [{ label: '공식 출처', url: 'https://example.test/source' }],
    limitations: [],
    followUps: [],
    budget: { usedRuns: 1, usedMinutes: 1 },
  });
  const errorCountBefore = gatewayStore.getAgentSession(session.id).events
    .filter((event) => event.kind === 'error').length;

  try {
    const updated = await deliverAgentReport({
      store: gatewayStore,
      sessionId: session.id,
      report,
      sendTelegram: async () => {
        const error = new Error('Telegram bot is not configured for bizconsultant');
        error.code = 'telegram_not_configured';
        throw error;
      },
    });

    assert.equal(updated.deliveryStatus, 'not_configured');
    assert.equal(updated.deliveryError, 'telegram_not_configured');
    assert.equal(
      gatewayStore.getAgentSession(session.id).events.filter((event) => event.kind === 'error').length,
      errorCountBefore,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
