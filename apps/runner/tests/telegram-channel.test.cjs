'use strict';

const assert = require('node:assert/strict');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireTelegramBindingLock,
  listTelegramChannels,
  registerTelegramChannel,
} = require('../lib/store');
const {
  reportTelegramIngressOwnership,
  runTelegramChannelOnce,
} = require('../lib/telegram-channel');

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
        if (requestPath.endsWith('/status')) return { ok: true };
        if (requestPath.endsWith('/next')) {
          const delivered = deviceCalls.filter((call) => call.requestPath.endsWith('/next')).length;
          return delivered === 1
            ? {
              ok: true,
              delivery: {
                receiptId: 'receipt_answer',
                eventId: 'evt_answer',
                sequence: 8,
                kind: 'agent_message',
                text: '같은 작업 대화의 답변입니다.',
                status: 'claimed',
              },
            }
            : { ok: true, delivery: null };
        }
        if (requestPath.endsWith('/begin')) return { ok: true, sequence: 8, status: 'sending' };
        if (requestPath.endsWith('/ack')) return { ok: true, sequence: 8, status: 'delivered' };
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
    assert.deepEqual(result, {
      ok: true,
      bindings: 1,
      inbound: 0,
      outbound: 1,
      deliveryUnknown: 0,
    });
    assert.equal(deviceCalls.some((call) => call.requestPath.endsWith('/inbound')), false);
    freshUpdateAvailable = true;
    const freshResult = await runTelegramChannelOnce(client, { fetchImpl });
    assert.deepEqual(freshResult, {
      ok: true,
      bindings: 1,
      inbound: 1,
      outbound: 0,
      deliveryUnknown: 0,
    });

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
    const begin = deviceCalls.find((call) => call.requestPath.endsWith('/begin'));
    assert.deepEqual(begin.body, {
      endpointId: 'channel_endpoint_a',
      receiptId: 'receipt_answer',
      eventId: 'evt_answer',
      sequence: 8,
    });
    const ack = deviceCalls.find((call) => call.requestPath.endsWith('/ack'));
    assert.deepEqual(ack.body, {
      endpointId: 'channel_endpoint_a',
      receiptId: 'receipt_answer',
      eventId: 'evt_answer',
      sequence: 8,
      outcome: 'delivered',
    });
    const ingressReports = deviceCalls.filter((call) => call.requestPath.endsWith('/status'));
    assert.ok(ingressReports.length >= 1);
    assert.deepEqual(ingressReports[0].body, {
      endpointId: 'channel_endpoint_a',
      ingressOwnership: 'owned',
    });
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

test('Telegram ingress report changes immediately and throttles repeated ownership writes', async () => {
  const bodies = [];
  const client = {
    deviceRequest: async (_method, requestPath, body) => {
      assert.equal(requestPath, '/api/runner/device/channels/telegram/status');
      bodies.push(structuredClone(body));
      return { ok: true };
    },
  };
  const channel = {
    endpointId: 'channel_endpoint_transition',
    ingressOwnership: 'conflict',
    ingressReportedAt: '2026-07-26T01:00:00.000Z',
  };
  const now = Date.parse('2026-07-26T01:00:10.000Z');

  assert.equal(await reportTelegramIngressOwnership(client, channel, 'owned', now), true);
  assert.equal(await reportTelegramIngressOwnership(client, channel, 'owned', now + 1_000), false);
  assert.deepEqual(bodies, [{
    endpointId: 'channel_endpoint_transition',
    ingressOwnership: 'owned',
  }]);
});

test('Telegram getUpdates ownership conflict is reported explicitly without exposing credentials', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_conflict',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    const deviceCalls = [];
    const client = {
      stateDir,
      deviceRequest: async (_method, requestPath, body) => {
        deviceCalls.push({ requestPath, body: structuredClone(body) });
        if (requestPath.endsWith('/bind')) {
          return { endpoint: { id: 'channel_endpoint_conflict' } };
        }
        if (requestPath.endsWith('/status')) return { ok: true };
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
    assert.deepEqual(
      deviceCalls.filter((call) => call.requestPath.endsWith('/status')).map((call) => call.body),
      [{
        endpointId: 'channel_endpoint_conflict',
        ingressOwnership: 'conflict',
      }],
    );
    assert.doesNotMatch(JSON.stringify(deviceCalls), /local-secret-token|998877/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Telegram kill switch performs no Gateway or Bot API work', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_killed',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    let calls = 0;
    const result = await runTelegramChannelOnce({
      stateDir,
      deviceRequest: async () => {
        calls += 1;
        throw new Error('kill switch leaked a Gateway request');
      },
    }, {
      env: { AGENT_CALENDAR_TELEGRAM_ENABLED: '0' },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('kill switch leaked a Bot API request');
      },
    });
    assert.deepEqual(result, {
      ok: true,
      disabled: true,
      bindings: 1,
      inbound: 0,
      outbound: 0,
      deliveryUnknown: 0,
    });
    assert.equal(calls, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('restart validation characterization preserves a valid channel and binds a missing endpoint handle', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-state-pin-'));
  try {
    const registered = registerTelegramChannel(stateDir, {
      workConversationId: 'session_restart_pin',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    const deviceCalls = [];
    const client = {
      stateDir,
      deviceRequest: async (_method, requestPath, body) => {
        deviceCalls.push({ requestPath, body: structuredClone(body) });
        if (requestPath.endsWith('/bind')) return { endpoint: { id: 'channel_endpoint_restart_pin' } };
        if (requestPath.endsWith('/status')) return { ok: true };
        if (requestPath.endsWith('/next')) return { ok: true, delivery: null };
        throw new Error(`unexpected ${requestPath}`);
      },
    };
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const first = await runTelegramChannelOnce(client, { fetchImpl });
    const restarted = await runTelegramChannelOnce(client, { fetchImpl });

    assert.deepEqual(first, {
      ok: true,
      bindings: 1,
      inbound: 0,
      outbound: 0,
      deliveryUnknown: 0,
    });
    assert.deepEqual(restarted, first);
    assert.deepEqual(
      deviceCalls.filter((call) => call.requestPath.endsWith('/bind')).map((call) => call.body),
      [{
        workConversationId: 'session_restart_pin',
        bindingHandle: registered.bindingHandle,
      }],
    );
    assert.equal(listTelegramChannels(stateDir)[0].endpointId, 'channel_endpoint_restart_pin');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fails closed malformed persisted Telegram channel state before locks or network activity', async (t) => {
  const validChannel = {
    bindingHandle: 'tg_state_validation',
    endpointId: 'channel_endpoint_state_validation',
    workConversationId: 'session_state_validation',
    botToken: '100000001:local-secret-token',
    chatId: '998877',
    executionEngine: 'auto',
    requestedModel: '',
    updateOffset: 0,
    updateOffsetInitialized: true,
  };
  const scenarios = [
    ['null_channel', null],
    ['scalar_channel', 42],
    ['array_channel', []],
    ['missing_binding_handle', { ...validChannel, bindingHandle: '' }],
    ['missing_bot_token', { ...validChannel, botToken: '' }],
    ['invalid_work_conversation_id', { ...validChannel, workConversationId: 'not valid' }],
    ['invalid_execution_engine', { ...validChannel, executionEngine: 'unsupported' }],
    ['malformed_outbound_delivery', {
      ...validChannel,
      outboundDelivery: {
        receiptId: [],
        eventId: 'event_state_validation',
        sequence: 1,
        status: 'sending',
      },
    }],
  ];

  for (const [name, channel] of scenarios) {
    await t.test(name, async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-state-invalid-'));
      try {
        writeFileSync(
          path.join(stateDir, 'telegram-channels.json'),
          `${JSON.stringify({ channels: [channel] })}\n`,
          { mode: 0o600 },
        );
        const calls = { boundary: 0, gateway: 0, bot: 0 };
        let error = null;
        try {
          await runTelegramChannelOnce({
            stateDir,
            deviceRequest: async () => {
              calls.gateway += 1;
              return { endpoint: { id: 'unexpected_endpoint' } };
            },
          }, {
            fetchImpl: async () => {
              calls.bot += 1;
              return new Response(JSON.stringify({ ok: true, result: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            },
            onBoundary: async () => { calls.boundary += 1; },
          });
        } catch (caught) {
          error = caught;
        }
        assert.deepEqual({
          code: error?.code,
          message: error?.message,
          calls,
          bindingLocks: readdirSync(stateDir).filter((entry) => entry.startsWith('telegram-binding-')),
        }, {
          code: 'TELEGRAM_CHANNEL_STATE_INVALID',
          message: 'Persisted Telegram channel state is invalid',
          calls: { boundary: 0, gateway: 0, bot: 0 },
          bindingLocks: [],
        });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('fails closed invalid persisted Telegram channel collection before locks or network activity', async (t) => {
  for (const [name, contents] of [
    ['truncated_json', '{"channels": [' ],
    ['scalar_collection', '{"channels":42}\n'],
    ['null_document', 'null\n'],
  ]) {
    await t.test(name, async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-collection-invalid-'));
      try {
        writeFileSync(path.join(stateDir, 'telegram-channels.json'), contents, { mode: 0o600 });
        const calls = { boundary: 0, gateway: 0, bot: 0 };
        let result = null;
        let error = null;
        try {
          result = await runTelegramChannelOnce({
            stateDir,
            deviceRequest: async () => { calls.gateway += 1; },
          }, {
            fetchImpl: async () => { calls.bot += 1; },
            onBoundary: async () => { calls.boundary += 1; },
          });
        } catch (caught) {
          error = caught;
        }
        assert.deepEqual({
          result,
          code: error?.code,
          message: error?.message,
          calls,
          bindingLocks: readdirSync(stateDir).filter((entry) => entry.startsWith('telegram-binding-')),
        }, {
          result: null,
          code: 'TELEGRAM_CHANNEL_STATE_INVALID',
          message: 'Persisted Telegram channel state is invalid',
          calls: { boundary: 0, gateway: 0, bot: 0 },
          bindingLocks: [],
        });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('one local Telegram loop owns a binding and a stale process lock recovers', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_locked',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let locked = false;
    const makeClient = () => ({
      stateDir,
      deviceRequest: async (_method, requestPath) => {
        if (requestPath.endsWith('/bind')) return { endpoint: { id: 'channel_endpoint_locked' } };
        if (requestPath.endsWith('/status')) return { ok: true };
        if (requestPath.endsWith('/next')) return { ok: true, delivery: null };
        throw new Error(`unexpected ${requestPath}`);
      },
    });
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const first = runTelegramChannelOnce(makeClient(), {
      fetchImpl,
      onBoundary: async (name) => {
        if (name === 'binding_locked') {
          locked = true;
          await held;
        }
      },
    });
    for (let attempt = 0; attempt < 100 && !locked; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(locked, true, 'first loop must expose the acquired binding boundary');
    await assert.rejects(
      () => runTelegramChannelOnce(makeClient(), { fetchImpl }),
      (error) => error?.code === 'TELEGRAM_BINDING_LOCKED',
    );
    release();
    assert.equal((await first).ok, true);
    assert.equal((await runTelegramChannelOnce(makeClient(), { fetchImpl })).ok, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Telegram binding lock rejects a live owner and one contender recovers a stale owner', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-lock-pin-'));
  const bindingHandle = 'tg_lock_characterization';
  const digest = crypto.createHash('sha256').update(bindingHandle).digest('hex');
  const lockPath = path.join(stateDir, `telegram-binding-${digest}.lock`);
  try {
    const releaseLiveOwner = acquireTelegramBindingLock(stateDir, bindingHandle);
    assert.throws(
      () => acquireTelegramBindingLock(stateDir, bindingHandle),
      (error) => error?.code === 'TELEGRAM_BINDING_LOCKED',
    );
    releaseLiveOwner();

    writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });
    const releaseRecoveredOwner = acquireTelegramBindingLock(stateDir, bindingHandle);
    assert.throws(
      () => acquireTelegramBindingLock(stateDir, bindingHandle),
      (error) => error?.code === 'TELEGRAM_BINDING_LOCKED',
    );
    releaseRecoveredOwner();

    writeFileSync(lockPath, '{"op":"acquire","token":"interrupted"', { mode: 0o600 });
    const releaseAfterInterruptedWrite = acquireTelegramBindingLock(stateDir, bindingHandle);
    assert.throws(
      () => acquireTelegramBindingLock(stateDir, bindingHandle),
      (error) => error?.code === 'TELEGRAM_BINDING_LOCKED',
    );
    releaseAfterInterruptedWrite();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('concurrent Runner processes reclaiming one stale binding elect exactly one owner', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-lock-race-'));
  const barrierDir = path.join(stateDir, 'barrier');
  const bindingHandle = 'tg_lock_concurrency';
  const digest = crypto.createHash('sha256').update(bindingHandle).digest('hex');
  const lockPath = path.join(stateDir, `telegram-binding-${digest}.lock`);
  const fixturePath = path.join(__dirname, 'fixtures', 'telegram-lock-contender-fixture.cjs');
  require('node:fs').mkdirSync(barrierDir, { mode: 0o700 });
  writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });

  const startContender = (role) => {
    const child = spawn(process.execPath, [fixturePath], {
      env: {
        ...process.env,
        TELEGRAM_LOCK_FIXTURE_STATE_DIR: stateDir,
        TELEGRAM_LOCK_FIXTURE_BARRIER_DIR: barrierDir,
        TELEGRAM_LOCK_FIXTURE_BINDING: bindingHandle,
        TELEGRAM_LOCK_FIXTURE_ROLE: role,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const completion = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 7_000);
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ role, code, signal, stdout, stderr });
      });
    });
    return { child, completion, role };
  };
  const children = ['a', 'b'].map(startContender);
  let manualReceipt = null;

  try {
    const deadline = Date.now() + 6_000;
    while (
      !children.every(({ role }) => existsSync(path.join(barrierDir, `${role}.result.json`)))
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      children.every(({ role }) => existsSync(path.join(barrierDir, `${role}.result.json`))),
      true,
      'both bounded child processes must record a result',
    );
    const results = children.map(({ role }) => (
      JSON.parse(readFileSync(path.join(barrierDir, `${role}.result.json`), 'utf8'))
    ));
    assert.equal(new Set(results.map((result) => result.pid)).size, 2);
    assert.equal(results.filter((result) => result.status === 'acquired').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(
      results.find((result) => result.status === 'rejected')?.error,
      'TELEGRAM_BINDING_LOCKED',
    );

    writeFileSync(path.join(barrierDir, 'release'), 'release\n', { mode: 0o600 });
    const completions = await Promise.all(children.map(({ completion }) => completion));
    for (const completion of completions) {
      assert.equal(completion.code, 0, JSON.stringify(completion));
    }
    const winner = results.find((result) => result.status === 'acquired');
    const winnerRelease = JSON.parse(
      readFileSync(path.join(barrierDir, `${winner.role}.released.json`), 'utf8'),
    );
    assert.deepEqual(winnerRelease, {
      role: winner.role,
      pid: winner.pid,
      released: true,
    });

    const later = startContender('later');
    const laterCompletion = await later.completion;
    assert.equal(laterCompletion.code, 0, JSON.stringify(laterCompletion));
    const laterResult = JSON.parse(
      readFileSync(path.join(barrierDir, 'later.result.json'), 'utf8'),
    );
    assert.equal(laterResult.status, 'acquired');
    assert.equal(new Set([...results, laterResult].map((result) => result.pid)).size, 3);
    assert.equal(
      JSON.parse(readFileSync(path.join(barrierDir, 'later.released.json'), 'utf8')).released,
      true,
    );
    manualReceipt = {
      scenario: 'concurrent_stale_binding_lock_reclamation',
      staleOwnerPid: 2_147_483_647,
      contenderResults: results,
      acquiredOwners: results.filter((result) => result.status === 'acquired').length,
      rejectedContenders: results.filter((result) => result.status === 'rejected').length,
      distinctInitialPids: new Set(results.map((result) => result.pid)).size,
      winnerReleased: winnerRelease.released,
      laterContender: laterResult,
      laterContenderReleased: true,
      childExitCodes: [...completions, laterCompletion].map(({ role, code }) => ({ role, code })),
    };
  } finally {
    if (existsSync(barrierDir)) {
      writeFileSync(path.join(barrierDir, 'release'), 'release\n', { mode: 0o600 });
    }
    const completions = await Promise.all(children.map(({ completion }) => completion));
    for (const completion of completions) {
      assert.equal(completion.code, 0, JSON.stringify(completion));
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
  assert.equal(existsSync(stateDir), false);
  if (process.env.TELEGRAM_LOCK_RACE_EVIDENCE_PATH) {
    writeFileSync(
      process.env.TELEGRAM_LOCK_RACE_EVIDENCE_PATH,
      `${JSON.stringify({
        ...manualReceipt,
        fixturePidsExited: true,
        lockSurvives: false,
        temporaryDirectoryRemoved: true,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
});

test('Runner recreation after send begin reports delivery_unknown once and never resends', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_uncertain',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    let gatewayStatus = 'unclaimed';
    let sendCalls = 0;
    let unknownAcks = 0;
    const makeClient = () => ({
      stateDir,
      deviceRequest: async (_method, requestPath, body) => {
        if (requestPath.endsWith('/bind')) return { endpoint: { id: 'channel_endpoint_uncertain' } };
        if (requestPath.endsWith('/status')) return { ok: true };
        if (requestPath.endsWith('/inbound')) return { ok: true, idempotentReplay: false };
        if (requestPath.endsWith('/next')) {
          if (gatewayStatus === 'unclaimed') {
            gatewayStatus = 'claimed';
            return {
              ok: true,
              delivery: {
                receiptId: 'receipt_uncertain',
                eventId: 'event_uncertain',
                sequence: 7,
                kind: 'completion',
                text: 'uncertain answer',
                status: 'claimed',
              },
            };
          }
          if (gatewayStatus === 'sending') {
            gatewayStatus = 'delivery_unknown';
            unknownAcks += 1;
            return {
              ok: true,
              delivery: null,
              deliveryUnknown: {
                receiptId: 'receipt_uncertain',
                eventId: 'event_uncertain',
                sequence: 7,
                status: 'delivery_unknown',
              },
            };
          }
          return { ok: true, delivery: null };
        }
        if (requestPath.endsWith('/begin')) {
          gatewayStatus = 'sending';
          return { ok: true, status: 'sending' };
        }
        if (requestPath.endsWith('/ack')) {
          gatewayStatus = body.outcome;
          return { ok: true, status: body.outcome, sequence: body.sequence };
        }
        throw new Error(`unexpected ${requestPath}`);
      },
    });
    const fetchImpl = async (url) => {
      if (String(url).includes('/sendMessage')) sendCalls += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: String(url).includes('/getUpdates') ? [] : { message_id: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(
      () => runTelegramChannelOnce(makeClient(), {
        fetchImpl,
        onBoundary: async (name) => {
          if (name === 'outbound_send_started') {
            throw Object.assign(new Error('simulated process termination'), {
              code: 'TEST_PROCESS_TERMINATED',
            });
          }
        },
      }),
      (error) => error?.code === 'TEST_PROCESS_TERMINATED',
    );
    const persisted = listTelegramChannels(stateDir)[0];
    assert.equal(persisted.outboundDelivery.status, 'sending');
    const recreated = await runTelegramChannelOnce(makeClient(), { fetchImpl });
    assert.equal(recreated.deliveryUnknown, 1);
    assert.equal(sendCalls, 0);
    assert.equal(unknownAcks, 1);
    assert.equal(gatewayStatus, 'delivery_unknown');
    const replay = await runTelegramChannelOnce(makeClient(), { fetchImpl });
    assert.equal(replay.deliveryUnknown, 0);
    assert.equal(sendCalls, 0);
    assert.equal(unknownAcks, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Runner persists each Telegram update offset and safely replays an accepted update after recreation', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-runner-'));
  try {
    const channel = registerTelegramChannel(stateDir, {
      workConversationId: 'session_offset',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    channel.endpointId = 'channel_endpoint_offset';
    channel.updateOffset = 50;
    channel.updateOffsetInitialized = true;
    require('../lib/store').saveTelegramChannels(stateDir, [channel]);
    let inboundCalls = 0;
    const makeClient = () => ({
      stateDir,
      deviceRequest: async (_method, requestPath) => {
        if (requestPath.endsWith('/status')) return { ok: true };
        if (requestPath.endsWith('/inbound')) {
          inboundCalls += 1;
          return {
            ok: true,
            idempotentReplay: inboundCalls > 1,
            eventId: 'event_offset',
          };
        }
        if (requestPath.endsWith('/next')) return { ok: true, delivery: null };
        throw new Error(`unexpected ${requestPath}`);
      },
    });
    const fetchImpl = async (url) => new Response(JSON.stringify({
      ok: true,
      result: String(url).includes('/getUpdates') ? [{
        update_id: 50,
        message: {
          message_id: 500,
          chat: { id: 998877 },
          text: 'offset survives',
        },
      }] : { message_id: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    await assert.rejects(
      () => runTelegramChannelOnce(makeClient(), {
        fetchImpl,
        onBoundary: async (name) => {
          if (name === 'inbound_accepted') {
            throw Object.assign(new Error('simulated process termination'), {
              code: 'TEST_PROCESS_TERMINATED',
            });
          }
        },
      }),
      (error) => error?.code === 'TEST_PROCESS_TERMINATED',
    );
    assert.equal(listTelegramChannels(stateDir)[0].updateOffset, 50);
    await runTelegramChannelOnce(makeClient(), { fetchImpl });
    assert.equal(inboundCalls, 2);
    assert.equal(listTelegramChannels(stateDir)[0].updateOffset, 51);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('separate Runner processes recover a stale binding lock and never resend send-start uncertainty', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-telegram-process-'));
  const scenarioPath = path.join(stateDir, 'scenario.json');
  const fixturePath = path.join(__dirname, 'fixtures', 'telegram-process-fixture.cjs');
  try {
    registerTelegramChannel(stateDir, {
      workConversationId: 'session_process',
      botToken: '100000001:local-secret-token',
      chatId: '998877',
    });
    writeFileSync(scenarioPath, `${JSON.stringify({
      deliveryStatus: 'unclaimed',
      sendCalls: 0,
      unknownAcks: 0,
      deliveryUnknownTransitions: 0,
      deliveredAcks: 0,
      devicePaths: [],
    })}\n`, { mode: 0o600 });
    const env = {
      ...process.env,
      TELEGRAM_FIXTURE_STATE_DIR: stateDir,
      TELEGRAM_FIXTURE_SCENARIO_PATH: scenarioPath,
    };
    const crashed = spawnSync(process.execPath, [fixturePath], {
      env: { ...env, TELEGRAM_FIXTURE_CRASH_BOUNDARY: 'outbound_send_started' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(crashed.status, 86, crashed.stderr);
    const crashReceipt = JSON.parse(crashed.stdout.trim());
    assert.equal(crashReceipt.crashedAt, 'outbound_send_started');
    assert.ok(Number.isSafeInteger(crashReceipt.pid));

    const recovered = spawnSync(process.execPath, [fixturePath], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    const recoveryReceipt = JSON.parse(recovered.stdout.trim());
    assert.equal(recoveryReceipt.deliveryUnknown, 1);
    assert.notEqual(recoveryReceipt.pid, crashReceipt.pid);
    const afterRecovery = JSON.parse(readFileSync(scenarioPath, 'utf8'));
    assert.equal(afterRecovery.deliveryStatus, 'delivery_unknown');
    assert.equal(afterRecovery.sendCalls, 0);
    assert.equal(afterRecovery.unknownAcks, 0);
    assert.equal(afterRecovery.deliveryUnknownTransitions, 1);

    const replay = spawnSync(process.execPath, [fixturePath], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(replay.status, 0, replay.stderr);
    const replayReceipt = JSON.parse(replay.stdout.trim());
    assert.equal(replayReceipt.deliveryUnknown, 0);
    const final = JSON.parse(readFileSync(scenarioPath, 'utf8'));
    assert.equal(final.sendCalls, 0);
    assert.equal(final.unknownAcks, 0);
    assert.equal(final.deliveryUnknownTransitions, 1);
    if (process.env.TELEGRAM_RUNNER_RESTART_EVIDENCE_PATH) {
      writeFileSync(
        process.env.TELEGRAM_RUNNER_RESTART_EVIDENCE_PATH,
        `${JSON.stringify({
          scenario: 'runner_process_recreation_after_send_begin',
          runnerPids: [crashReceipt.pid, recoveryReceipt.pid, replayReceipt.pid],
          receiptId: 'receipt_process_fixture',
          sequence: 11,
          sendCalls: final.sendCalls,
          deliveryUnknownTransitions: final.deliveryUnknownTransitions,
          terminalStatus: final.deliveryStatus,
          credentialFieldsPresent: false,
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    }
    assert.doesNotMatch(
      `${crashed.stdout}${crashed.stderr}${recovered.stdout}${recovered.stderr}${replay.stdout}${replay.stderr}`,
      /local-secret-token|998877/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
