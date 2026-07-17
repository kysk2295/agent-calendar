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

test('mail messages endpoint excludes Web chat commands and preserves mail fields', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-mail-boundary-'));
  const gatewayStore = new HermesStore({ dataDir });
  gatewayStore.addChatMessage({
    role: 'user',
    source: 'web',
    text: '이 Web chat 명령은 메일함에 나타나면 안 됩니다.',
  });
  gatewayStore.importMailMessages([{
    provider: 'gmail',
    accountId: 'owner@gmail.com',
    messageId: 'message-1@example.com',
    from: 'sender@example.com',
    subject: '실제 메일 제목',
    text: '실제 메일 본문',
    receivedAt: '2026-07-18T01:00:00.000Z',
  }]);
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore,
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/mail/messages?limit=200`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items.length, 1);
    assert.deepEqual(body.items[0], {
      id: 'mail:owner@gmail.com:message-1@example.com',
      accountId: 'owner@gmail.com',
      provider: 'gmail',
      source: 'gmail',
      sourceLabel: 'Gmail',
      from: 'sender@example.com',
      email: 'sender@example.com',
      subject: '실제 메일 제목',
      title: '실제 메일 제목',
      text: '실제 메일 본문',
      body: '실제 메일 본문',
      preview: '실제 메일 본문',
      receivedAt: '2026-07-18T01:00:00.000Z',
      unread: true,
      starred: false,
      star: false,
    });
    assert.doesNotMatch(JSON.stringify(body), /Web chat 명령/);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('mail sync response never substitutes Web chat commands for an empty mailbox', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-mail-sync-boundary-'));
  const gatewayStore = new HermesStore({ dataDir });
  gatewayStore.addChatMessage({
    role: 'user',
    source: 'web',
    text: '메일 동기화 결과에 들어가면 안 되는 Web chat',
  });
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore,
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/mail/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.items, []);
    assert.equal(body.detail, 'HERMES_MAIL_ACCOUNTS_JSON is not configured on Railway.');
    assert.doesNotMatch(JSON.stringify(body), /Web chat/);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('mail action endpoint rejects a Web chat command id', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-calendar-mail-action-boundary-'));
  const gatewayStore = new HermesStore({ dataDir });
  const chat = gatewayStore.addChatMessage({
    role: 'user',
    source: 'web',
    text: '메일 action으로 처리하면 안 되는 Web chat',
  });
  const server = createRailwayGatewayServer({
    env: {},
    gatewayStore,
    fetchImpl: async () => {
      throw new Error('runtime offline');
    },
  });
  const baseUrl = await listen(server);

  try {
    const commandId = `chat:${chat.id}`;
    const response = await fetch(`${baseUrl}/api/mail/messages/${encodeURIComponent(commandId)}/star`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Mail message not found');
    assert.deepEqual(gatewayStore.getState().commandInboxStarredIds, []);
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
