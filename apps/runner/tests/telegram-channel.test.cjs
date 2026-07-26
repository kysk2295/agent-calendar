'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  listTelegramChannels,
  registerTelegramChannel,
} = require('../lib/store');
const { runTelegramChannelOnce } = require('../lib/telegram-channel');

test('Runner keeps Telegram credentials local while one canonical conversation flows both directions', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    const registered = registerTelegramChannel(stateDir, {
      workConversationId: 'session_shared',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
      executionEngine: 'codex',
      requestedModel: 'gpt-5.6-sol',
    });
    assert.match(registered.bindingHandle, /^tg_[a-f0-9]{32}$/);
    assert.equal(statSync(path.join(stateDir, 'telegram-channels.json')).mode & 0o777, 0o600);
    assert.match(readFileSync(path.join(stateDir, 'telegram-channels.json'), 'utf8'), /local-secret-token/);

    const deviceCalls = [];
    const client = {
      stateDir,
      deviceRequest: async (_method, requestPath, body) => {
        deviceCalls.push({ requestPath, body: structuredClone(body) });
        if (requestPath.endsWith('/bind')) {
          return {
            ok: true,
            endpoint: {
              id: 'channel_endpoint_a',
              workConversationId: 'session_shared',
              channel: 'telegram',
              status: 'active',
            },
          };
        }
        if (requestPath.endsWith('/inbound')) {
          return { ok: true, idempotentReplay: false, eventId: 'evt_inbound' };
        }
        if (requestPath.endsWith('/next')) {
          const delivered = deviceCalls.filter((call) => call.requestPath.endsWith('/next')).length;
          return delivered === 1
            ? {
              ok: true,
              delivery: {
                eventId: 'evt_answer',
                sequence: 8,
                kind: 'agent_message',
                text: '같은 작업 대화의 답변입니다.',
              },
            }
            : { ok: true, delivery: null };
        }
        if (requestPath.endsWith('/ack')) return { ok: true, sequence: 8 };
        throw new Error(`unexpected ${requestPath}`);
      },
    };
    const telegramCalls = [];
    let freshUpdateAvailable = false;
    const fetchImpl = async (url, init = {}) => {
      telegramCalls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes('/getUpdates')) {
        const offset = Number(JSON.parse(init.body).offset || 0);
        const updates = offset === -1
          ? [{
            update_id: 41,
            message: {
              message_id: 41,
              chat: { id: 998877 },
              text: '바인딩 전 과거 메시지',
            },
          }]
          : freshUpdateAvailable && offset === 42
            ? [{
              update_id: 42,
              message: {
                message_id: 42,
                chat: { id: 998877 },
                text: '텔레그램에서 이어서 수정해줘',
              },
            }]
            : [];
        return new Response(JSON.stringify({
          ok: true,
          result: updates,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await runTelegramChannelOnce(client, { fetchImpl });
    assert.deepEqual(result, { ok: true, bindings: 1, inbound: 0, outbound: 1 });
    assert.equal(deviceCalls.some((call) => call.requestPath.endsWith('/inbound')), false);
    freshUpdateAvailable = true;
    const freshResult = await runTelegramChannelOnce(client, { fetchImpl });
    assert.deepEqual(freshResult, { ok: true, bindings: 1, inbound: 1, outbound: 0 });

    const bind = deviceCalls.find((call) => call.requestPath.endsWith('/bind'));
    assert.deepEqual(bind.body, {
      workConversationId: 'session_shared',
      bindingHandle: registered.bindingHandle,
    });
    const inbound = deviceCalls.find((call) => call.requestPath.endsWith('/inbound'));
    assert.equal(inbound.body.endpointId, 'channel_endpoint_a');
    assert.equal(inbound.body.text, '텔레그램에서 이어서 수정해줘');
    assert.equal(inbound.body.executionEngine, 'codex');
    assert.equal(inbound.body.requestedModel, 'gpt-5.6-sol');
    assert.doesNotMatch(JSON.stringify(deviceCalls), /local-secret-token|998877/);

    const send = telegramCalls.find((call) => call.url.includes('/sendMessage'));
    assert.equal(send.body.chat_id, '998877');
    assert.equal(send.body.text, '같은 작업 대화의 답변입니다.');

    const restored = listTelegramChannels(stateDir);
    assert.equal(restored[0].endpointId, 'channel_endpoint_a');
    assert.equal(restored[0].updateOffset, 43);
    const updateRequests = telegramCalls.filter((call) => call.url.includes('/getUpdates'));
    assert.equal(updateRequests[0].body.offset, -1);
    assert.equal(updateRequests[1].body.offset, 42);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('one local Telegram chat cannot be bound to two Work Conversations', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_first',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    assert.throws(
      () => registerTelegramChannel(stateDir, {
        workConversationId: 'session_second',
        botToken: '100000001:local-secret-token',
        chatId: '998877',
      }),
      (error) => error?.code === 'TELEGRAM_CHAT_ALREADY_BOUND',
    );
    assert.deepEqual(
      listTelegramChannels(stateDir).map((channel) => channel.workConversationId),
      ['session_first'],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Telegram getUpdates ownership conflict is reported explicitly without exposing credentials', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_conflict',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    const client = {
      stateDir,
      deviceRequest: async (_method, requestPath) => {
        if (requestPath.endsWith('/bind')) {
          return { endpoint: { id: 'channel_endpoint_conflict' } };
        }
        throw new Error(`unexpected ${requestPath}`);
      },
    };
    await assert.rejects(
      () => runTelegramChannelOnce(client, {
        fetchImpl: async () => new Response(JSON.stringify({
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates request',
        }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      (error) => {
        assert.equal(error?.code, 'TELEGRAM_INGRESS_CONFLICT');
        assert.match(error?.message || '', /another poller owns ingress/i);
        assert.doesNotMatch(error?.message || '', /local-secret-token|998877/);
        return true;
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
