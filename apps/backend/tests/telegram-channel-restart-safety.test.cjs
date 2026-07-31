'use strict';

const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const {
  WorkConversationChannelService,
} = require('../app/lib/work-conversation-channel-service');
const {
  withEphemeralPostgres,
} = require('./support/ephemeral-postgres.cjs');

const RUNNER = Object.freeze({ id: 'runner-telegram-a', workspace_id: 'ws-telegram-a' });

async function withTelegramDatabase(body) {
  return withEphemeralPostgres({
    prefix: 'telegram-restart-backend-',
    role: 'telegramrestart',
    database: 'telegram_restart',
  }, async ({ pool, ...fixture }) => {
    await runMigrations({ pool });
    await pool.query(`
      insert into users (id, display_name, status)
      values ('user-telegram-a', 'Telegram owner', 'active');
      insert into workspaces (id, name, status)
      values ('ws-telegram-a', 'Telegram A', 'active'),
             ('ws-telegram-b', 'Telegram B', 'active');
      insert into workspace_memberships (id, user_id, workspace_id, role, status)
      values ('membership-telegram-a', 'user-telegram-a', 'ws-telegram-a', 'owner', 'active');
      insert into runners (
        id, workspace_id, status, connection_state, device_public_key, fingerprint_sha256
      ) values (
        'runner-telegram-a', 'ws-telegram-a', 'active', 'connected', 'public-a', 'fingerprint-a'
      ), (
        'runner-telegram-b', 'ws-telegram-b', 'active', 'connected', 'public-b', 'fingerprint-b'
      );
      insert into agent_missions (id, workspace_id, status, payload)
      values ('mission-telegram-a', 'ws-telegram-a', 'running', '{}'::jsonb);
      insert into agent_sessions (id, workspace_id, mission_id, status, payload)
      values (
        'session-telegram-a', 'ws-telegram-a', 'mission-telegram-a', 'running', '{}'::jsonb
      );
      insert into work_conversation_channel_endpoints (
        id, workspace_id, work_conversation_id, runner_id, channel, binding_handle,
        status, outbound_cursor
      ) values (
        'channel-telegram-a', 'ws-telegram-a', 'session-telegram-a',
        'runner-telegram-a', 'telegram', 'tg_local_handle_a', 'active', 0
      );
    `);
    return body({ pool, ...fixture });
  });
}

function serviceWithInboundStub(pool, implementation) {
  const service = new WorkConversationChannelService({ pool });
  service.product = {
    addAgentWorkMessage: implementation,
  };
  return service;
}

test('Telegram inbound receipt serializes duplicates and retries only failed or stale work', async () => {
  await withTelegramDatabase(async ({ pool }) => {
    let releaseFirst;
    let calls = 0;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const service = serviceWithInboundStub(pool, async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      return { event: { id: `event-inbound-${calls}` } };
    });
    const input = {
      endpointId: 'channel-telegram-a',
      deliveryKey: 'update_100_message_200',
      text: 'continue from Telegram',
      executionEngine: 'auto',
    };

    const accepted = service.inbound(RUNNER, input);
    while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => service.inbound(RUNNER, input),
      (error) => error?.code === 'CHANNEL_DELIVERY_IN_PROGRESS' && error?.statusHint === 409,
    );
    releaseFirst();
    const first = await accepted;
    assert.equal(first.idempotentReplay, false);
    const replay = await service.inbound(RUNNER, input);
    assert.deepEqual(replay, {
      ok: true,
      idempotentReplay: true,
      eventId: first.eventId,
    });
    assert.equal(calls, 1);

    let failedCalls = 0;
    const failedService = serviceWithInboundStub(pool, async () => {
      failedCalls += 1;
      if (failedCalls === 1) throw Object.assign(new Error('known failure'), { code: 'KNOWN_FAILURE' });
      return { event: { id: 'event-after-failed-retry' } };
    });
    const failedInput = { ...input, deliveryKey: 'update_101_message_201' };
    await assert.rejects(() => failedService.inbound(RUNNER, failedInput), /known failure/);
    assert.equal((await failedService.inbound(RUNNER, failedInput)).idempotentReplay, false);
    assert.equal(failedCalls, 2);

    await pool.query(
      `insert into work_conversation_channel_receipts (
         id, workspace_id, endpoint_id, direction, delivery_key, status, updated_at
       ) values (
         'receipt-stale-inbound', 'ws-telegram-a', 'channel-telegram-a',
         'inbound', 'update_102_message_202', 'pending', now() - interval '2 minutes'
       )`,
    );
    const stale = await service.inbound(RUNNER, {
      ...input,
      deliveryKey: 'update_102_message_202',
    });
    assert.equal(stale.idempotentReplay, false);
    assert.equal(calls, 2);

    const receipts = await pool.query(
      `select delivery_key, status, count(*)::int as count
       from work_conversation_channel_receipts
       where workspace_id = 'ws-telegram-a' and direction = 'inbound'
       group by delivery_key, status
       order by delivery_key`,
    );
    assert.deepEqual(
      receipts.rows.map((row) => [row.delivery_key, row.status, row.count]),
      [
        ['update_100_message_200', 'delivered', 1],
        ['update_101_message_201', 'delivered', 1],
        ['update_102_message_202', 'delivered', 1],
      ],
    );
  });
});

test('Telegram outbound claim begins before send and restart terminalizes uncertainty without resend', async () => {
  await withTelegramDatabase(async ({ pool }) => {
    await pool.query(
      `insert into agent_session_events (
         id, workspace_id, session_id, sequence, kind, payload
       ) values
         ('event-outbound-1', 'ws-telegram-a', 'session-telegram-a', 1, 'completion',
          '{"text":"first answer","origin":"execution"}'::jsonb),
         ('event-outbound-2', 'ws-telegram-a', 'session-telegram-a', 2, 'completion',
          '{"text":"second answer","origin":"execution"}'::jsonb)`,
    );
    const gatewayBeforeRestart = new WorkConversationChannelService({ pool });
    const firstClaim = await gatewayBeforeRestart.nextOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
    });
    assert.equal(firstClaim.delivery.eventId, 'event-outbound-1');
    assert.match(firstClaim.delivery.receiptId, /^receipt_/);
    assert.equal(firstClaim.delivery.status, 'claimed');

    await assert.rejects(
      () => gatewayBeforeRestart.nextOutbound(RUNNER, {
        endpointId: 'channel-telegram-a',
      }),
      (error) => error?.code === 'CHANNEL_DELIVERY_IN_PROGRESS' && error?.statusHint === 409,
    );

    const resumedClaim = await new WorkConversationChannelService({ pool }).nextOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
      receiptId: firstClaim.delivery.receiptId,
    });
    assert.equal(resumedClaim.delivery.receiptId, firstClaim.delivery.receiptId);
    assert.equal(resumedClaim.delivery.eventId, firstClaim.delivery.eventId);

    const begun = await new WorkConversationChannelService({ pool }).beginOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
      receiptId: firstClaim.delivery.receiptId,
      eventId: firstClaim.delivery.eventId,
      sequence: firstClaim.delivery.sequence,
    });
    assert.equal(begun.status, 'sending');

    const afterSendCrash = await new WorkConversationChannelService({ pool }).nextOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
    });
    assert.equal(afterSendCrash.delivery, null);
    assert.deepEqual(afterSendCrash.deliveryUnknown, {
      receiptId: firstClaim.delivery.receiptId,
      eventId: 'event-outbound-1',
      sequence: 1,
      status: 'delivery_unknown',
    });

    const secondClaim = await new WorkConversationChannelService({ pool }).nextOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
    });
    assert.equal(secondClaim.delivery.eventId, 'event-outbound-2');
    await new WorkConversationChannelService({ pool }).beginOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
      receiptId: secondClaim.delivery.receiptId,
      eventId: secondClaim.delivery.eventId,
      sequence: secondClaim.delivery.sequence,
    });
    const ack = await new WorkConversationChannelService({ pool }).ackOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
      receiptId: secondClaim.delivery.receiptId,
      eventId: secondClaim.delivery.eventId,
      sequence: secondClaim.delivery.sequence,
      outcome: 'delivered',
    });
    const duplicateAck = await new WorkConversationChannelService({ pool }).ackOutbound(RUNNER, {
      endpointId: 'channel-telegram-a',
      receiptId: secondClaim.delivery.receiptId,
      eventId: secondClaim.delivery.eventId,
      sequence: secondClaim.delivery.sequence,
      outcome: 'delivered',
    });
    assert.deepEqual(duplicateAck, ack);
    assert.equal(ack.sequence, 2);
    assert.equal(ack.status, 'delivered');

    for (const hostile of [
      { receiptId: secondClaim.delivery.receiptId, eventId: 'event-outbound-1', sequence: 2 },
      { receiptId: secondClaim.delivery.receiptId, eventId: 'event-outbound-2', sequence: 1 },
      { receiptId: 'receipt_foreign_opaque', eventId: 'event-outbound-2', sequence: 2 },
    ]) {
      await assert.rejects(
        () => new WorkConversationChannelService({ pool }).ackOutbound(RUNNER, {
          endpointId: 'channel-telegram-a',
          ...hostile,
          outcome: 'delivered',
        }),
        (error) => error?.code === 'CHANNEL_DELIVERY_NOT_FOUND' && error?.statusHint === 404,
      );
    }
    const final = await pool.query(
      `select outbound_cursor::int as cursor
       from work_conversation_channel_endpoints
       where workspace_id = 'ws-telegram-a' and id = 'channel-telegram-a'`,
    );
    assert.equal(final.rows[0].cursor, 2);
    const ledger = await pool.query(
      `select event_id, sequence::int, status
       from work_conversation_channel_receipts
       where workspace_id = 'ws-telegram-a' and direction = 'outbound'
       order by sequence`,
    );
    assert.deepEqual(ledger.rows, [
      { event_id: 'event-outbound-1', sequence: 1, status: 'delivery_unknown' },
      { event_id: 'event-outbound-2', sequence: 2, status: 'delivered' },
    ]);
  });
});

test('separate Gateway processes preserve claim, send-start uncertainty, and monotonic cursor', async () => {
  await withTelegramDatabase(async ({ pool, connectionString }) => {
    await pool.query(
      `insert into agent_session_events (
         id, workspace_id, session_id, sequence, kind, payload
       ) values (
         'event-process-outbound', 'ws-telegram-a', 'session-telegram-a', 1, 'completion',
         '{"text":"process answer","origin":"execution"}'::jsonb
       )`,
    );
    const fixturePath = path.join(
      __dirname,
      'fixtures',
      'telegram-gateway-process-fixture.cjs',
    );
    const run = (action, body) => {
      const child = spawnSync(process.execPath, [fixturePath], {
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
          TELEGRAM_GATEWAY_FIXTURE_INPUT: JSON.stringify({ action, body }),
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.doesNotMatch(`${child.stdout}${child.stderr}`, /binding|token|chat.?id/i);
      return JSON.parse(child.stdout.trim());
    };
    const claimed = run('next', { endpointId: 'channel-telegram-a' });
    assert.equal(claimed.delivery.status, 'claimed');
    const begun = run('begin', {
      endpointId: 'channel-telegram-a',
      receiptId: claimed.delivery.receiptId,
      eventId: claimed.delivery.eventId,
      sequence: claimed.delivery.sequence,
    });
    assert.equal(begun.status, 'sending');
    const recovered = run('next', { endpointId: 'channel-telegram-a' });
    assert.equal(recovered.delivery, null);
    assert.equal(recovered.deliveryUnknown.status, 'delivery_unknown');
    assert.equal(new Set([claimed.pid, begun.pid, recovered.pid]).size, 3);
    const cursor = await pool.query(
      `select outbound_cursor::int as cursor
       from work_conversation_channel_endpoints
       where workspace_id = 'ws-telegram-a' and id = 'channel-telegram-a'`,
    );
    assert.equal(cursor.rows[0].cursor, 1);
    if (process.env.TELEGRAM_GATEWAY_RESTART_EVIDENCE_PATH) {
      writeFileSync(
        process.env.TELEGRAM_GATEWAY_RESTART_EVIDENCE_PATH,
        `${JSON.stringify({
          scenario: 'gateway_process_recreation_after_send_begin',
          gatewayPids: [claimed.pid, begun.pid, recovered.pid],
          receiptId: claimed.delivery.receiptId,
          eventId: claimed.delivery.eventId,
          sequence: claimed.delivery.sequence,
          cursor: cursor.rows[0].cursor,
          terminalStatus: recovered.deliveryUnknown.status,
          credentialFieldsPresent: false,
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }
  });
});
