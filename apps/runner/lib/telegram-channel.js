'use strict';

const {
  acquireTelegramBindingLock,
  listTelegramChannels,
  saveTelegramChannels,
} = require('./store');

const INGRESS_REPORT_INTERVAL_MS = 60_000;
const TELEGRAM_CHANNEL_STATE_INVALID_MESSAGE = 'Persisted Telegram channel state is invalid';

function invalidTelegramChannelState() {
  return Object.assign(new Error(TELEGRAM_CHANNEL_STATE_INVALID_MESSAGE), {
    code: 'TELEGRAM_CHANNEL_STATE_INVALID',
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValidOutboundDelivery(channel) {
  if (!Object.hasOwn(channel, 'outboundDelivery') || channel.outboundDelivery == null) return true;
  const delivery = channel.outboundDelivery;
  return typeof delivery === 'object'
    && !Array.isArray(delivery)
    && isNonEmptyString(delivery.receiptId)
    && isNonEmptyString(delivery.eventId)
    && Number.isSafeInteger(delivery.sequence)
    && delivery.sequence >= 0
    && ['claimed', 'sending', 'sent'].includes(delivery.status);
}

function assertValidTelegramChannelState(channels) {
  for (const channel of channels) {
    if (
      !channel
      || typeof channel !== 'object'
      || Array.isArray(channel)
      || !isNonEmptyString(channel.bindingHandle)
      || !isNonEmptyString(channel.workConversationId)
      || !/^[A-Za-z][A-Za-z0-9_-]{1,159}$/.test(channel.workConversationId)
      || !isNonEmptyString(channel.botToken)
      || !isNonEmptyString(channel.chatId)
      || !['auto', 'codex', 'claude', 'grok', 'hermes'].includes(channel.executionEngine)
      || (Object.hasOwn(channel, 'endpointId') && typeof channel.endpointId !== 'string')
      || (Object.hasOwn(channel, 'requestedModel') && typeof channel.requestedModel !== 'string')
      || (Object.hasOwn(channel, 'updateOffset') && (
        !Number.isSafeInteger(channel.updateOffset) || channel.updateOffset < 0
      ))
      || (Object.hasOwn(channel, 'updateOffsetInitialized') && typeof channel.updateOffsetInitialized !== 'boolean')
      || !hasValidOutboundDelivery(channel)
    ) {
      throw invalidTelegramChannelState();
    }
  }
}

async function telegramRequest(botToken, method, body, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    const ingressConflict = method === 'getUpdates'
      && (response.status === 409 || Number(payload.error_code) === 409);
    const error = new Error(ingressConflict
      ? 'Telegram getUpdates failed because another poller owns ingress'
      : `Telegram ${method} failed`);
    error.code = ingressConflict
      ? 'TELEGRAM_INGRESS_CONFLICT'
      : 'TELEGRAM_CHANNEL_REQUEST_FAILED';
    throw error;
  }
  return payload.result;
}

async function bindTelegramChannels(client, channels) {
  let changed = false;
  for (const channel of channels) {
    if (channel.endpointId) continue;
    const result = await client.deviceRequest(
      'POST',
      '/api/runner/device/channels/telegram/bind',
      {
        workConversationId: channel.workConversationId,
        bindingHandle: channel.bindingHandle,
      },
    );
    channel.endpointId = String(result.endpoint?.id || '');
    if (!channel.endpointId) {
      const error = new Error('Gateway did not return a Telegram channel endpoint');
      error.code = 'TELEGRAM_CHANNEL_BIND_FAILED';
      throw error;
    }
    changed = true;
  }
  if (changed) saveTelegramChannels(client.stateDir, channels);
  return channels;
}

async function reportTelegramIngressOwnership(client, channel, ingressOwnership, now = Date.now()) {
  const lastReportedAt = Date.parse(String(channel.ingressReportedAt || ''));
  if (
    channel.ingressOwnership === ingressOwnership
    && Number.isFinite(lastReportedAt)
    && now - lastReportedAt < INGRESS_REPORT_INTERVAL_MS
  ) {
    return false;
  }
  await client.deviceRequest(
    'POST',
    '/api/runner/device/channels/telegram/status',
    {
      endpointId: channel.endpointId,
      ingressOwnership,
    },
  );
  channel.ingressOwnership = ingressOwnership;
  channel.ingressReportedAt = new Date(now).toISOString();
  return true;
}

async function initializeTelegramChannelOffsets(
  stateDir,
  channels,
  { fetchImpl = fetch, onIngressConflict } = {},
) {
  let changed = false;
  for (const channel of channels) {
    if (channel.updateOffsetInitialized === true) continue;
    let updates;
    try {
      updates = await telegramRequest(
        channel.botToken,
        'getUpdates',
        {
          offset: -1,
          limit: 1,
          timeout: 0,
          allowed_updates: ['message', 'edited_message'],
        },
        fetchImpl,
      );
    } catch (error) {
      if (error?.code === 'TELEGRAM_INGRESS_CONFLICT' && onIngressConflict) {
        await onIngressConflict(channel);
      }
      throw error;
    }
    const latestUpdateId = (Array.isArray(updates) ? updates : [])
      .map((update) => Number(update?.update_id))
      .filter(Number.isSafeInteger)
      .reduce((latest, updateId) => Math.max(latest, updateId), -1);
    channel.updateOffset = latestUpdateId >= 0 ? latestUpdateId + 1 : 0;
    channel.updateOffsetInitialized = true;
    changed = true;
  }
  if (changed) saveTelegramChannels(stateDir, channels);
  return channels;
}

async function runTelegramChannelOnce(client, {
  fetchImpl = fetch,
  env = process.env,
  onBoundary = null,
} = {}) {
  const channels = listTelegramChannels(client.stateDir);
  assertValidTelegramChannelState(channels);
  if (String(env.AGENT_CALENDAR_TELEGRAM_ENABLED || '1') === '0') {
    return {
      ok: true,
      disabled: true,
      bindings: channels.length,
      inbound: 0,
      outbound: 0,
      deliveryUnknown: 0,
    };
  }
  const releases = [];
  try {
    for (const channel of channels) {
      releases.push(acquireTelegramBindingLock(client.stateDir, channel.bindingHandle));
    }
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  const boundary = async (name, channel, detail = {}) => {
    if (typeof onBoundary === 'function') {
      await onBoundary(name, {
        bindingHandle: channel.bindingHandle,
        ...detail,
      });
    }
  };
  try {
    for (const channel of channels) {
      await boundary('binding_locked', channel);
    }
    await bindTelegramChannels(client, channels);
    await initializeTelegramChannelOffsets(client.stateDir, channels, {
      fetchImpl,
      onIngressConflict: async (channel) => {
        try {
          await reportTelegramIngressOwnership(client, channel, 'conflict');
          saveTelegramChannels(client.stateDir, channels);
        } catch {}
      },
    });
    let inbound = 0;
    let outbound = 0;
    let deliveryUnknown = 0;
    for (const channel of channels) {
      let updates;
      try {
        updates = await telegramRequest(
          channel.botToken,
          'getUpdates',
          {
            offset: Number(channel.updateOffset || 0),
            timeout: 0,
            allowed_updates: ['message', 'edited_message'],
          },
          fetchImpl,
        );
      } catch (error) {
        if (error?.code === 'TELEGRAM_INGRESS_CONFLICT') {
          try {
            await reportTelegramIngressOwnership(client, channel, 'conflict');
            saveTelegramChannels(client.stateDir, channels);
          } catch {}
        }
        throw error;
      }
      await reportTelegramIngressOwnership(client, channel, 'owned');
      for (const update of Array.isArray(updates) ? updates : []) {
        const message = update.message || update.edited_message || {};
        const updateId = Number(update.update_id);
        if (Number.isSafeInteger(updateId) && updateId < Number(channel.updateOffset || 0)) {
          continue;
        }
        if (String(message.chat?.id || '') === String(channel.chatId) && String(message.text || '').trim()) {
          await client.deviceRequest(
            'POST',
            '/api/runner/device/channels/telegram/inbound',
            {
              endpointId: channel.endpointId,
              deliveryKey: `update_${updateId}_message_${Number(message.message_id || 0)}`,
              text: String(message.text).trim().slice(0, 4_000),
              executionEngine: channel.executionEngine,
              ...(channel.requestedModel ? { requestedModel: channel.requestedModel } : {}),
            },
          );
          inbound += 1;
          await boundary('inbound_accepted', channel, { updateId });
        }
        if (Number.isSafeInteger(updateId)) {
          channel.updateOffset = Math.max(Number(channel.updateOffset || 0), updateId + 1);
          saveTelegramChannels(client.stateDir, channels);
          await boundary('update_offset_persisted', channel, {
            updateId,
            updateOffset: channel.updateOffset,
          });
        }
      }

      const priorDelivery = channel.outboundDelivery;
      if (priorDelivery?.status === 'sending') {
        const recovered = await client.deviceRequest(
          'POST',
          '/api/runner/device/channels/telegram/next',
          {
            endpointId: channel.endpointId,
            receiptId: priorDelivery.receiptId,
          },
        );
        if (recovered.deliveryUnknown) {
          channel.outboundDelivery = null;
          saveTelegramChannels(client.stateDir, channels);
          deliveryUnknown += 1;
        } else if (recovered.delivery) {
          channel.outboundDelivery.status = 'claimed';
          saveTelegramChannels(client.stateDir, channels);
        } else {
          throw Object.assign(new Error('Gateway lost an active Telegram delivery'), {
            code: 'TELEGRAM_DELIVERY_STATE_MISSING',
          });
        }
      } else if (priorDelivery?.status === 'sent') {
        await client.deviceRequest(
          'POST',
          '/api/runner/device/channels/telegram/ack',
          {
            endpointId: channel.endpointId,
            receiptId: priorDelivery.receiptId,
            eventId: priorDelivery.eventId,
            sequence: priorDelivery.sequence,
            outcome: 'delivered',
          },
        );
        channel.outboundDelivery = null;
        saveTelegramChannels(client.stateDir, channels);
        outbound += 1;
      }

      for (let count = 0; count < 20; count += 1) {
        const claimed = channel.outboundDelivery?.status === 'claimed'
          ? channel.outboundDelivery
          : null;
        const result = await client.deviceRequest(
          'POST',
          '/api/runner/device/channels/telegram/next',
          {
            endpointId: channel.endpointId,
            ...(claimed ? { receiptId: claimed.receiptId } : {}),
          },
        );
        if (result.deliveryUnknown) {
          deliveryUnknown += 1;
          continue;
        }
        const delivery = result.delivery;
        if (!delivery) break;
        channel.outboundDelivery = {
          receiptId: String(delivery.receiptId || ''),
          eventId: String(delivery.eventId || ''),
          sequence: Number(delivery.sequence),
          status: 'claimed',
        };
        saveTelegramChannels(client.stateDir, channels);
        await boundary('outbound_claim_persisted', channel, {
          receiptId: channel.outboundDelivery.receiptId,
          sequence: channel.outboundDelivery.sequence,
        });

        channel.outboundDelivery.status = 'sending';
        saveTelegramChannels(client.stateDir, channels);
        await client.deviceRequest(
          'POST',
          '/api/runner/device/channels/telegram/begin',
          {
            endpointId: channel.endpointId,
            receiptId: delivery.receiptId,
            eventId: delivery.eventId,
            sequence: delivery.sequence,
          },
        );
        await boundary('outbound_send_started', channel, {
          receiptId: delivery.receiptId,
          sequence: delivery.sequence,
        });
        try {
          if (String(delivery.text || '').trim()) {
            await telegramRequest(
              channel.botToken,
              'sendMessage',
              {
                chat_id: String(channel.chatId),
                text: String(delivery.text).slice(0, 4_000),
                disable_web_page_preview: true,
              },
              fetchImpl,
            );
          }
        } catch (error) {
          await client.deviceRequest(
            'POST',
            '/api/runner/device/channels/telegram/ack',
            {
              endpointId: channel.endpointId,
              receiptId: delivery.receiptId,
              eventId: delivery.eventId,
              sequence: delivery.sequence,
              outcome: 'delivery_unknown',
            },
          ).catch(() => {});
          channel.outboundDelivery = null;
          saveTelegramChannels(client.stateDir, channels);
          deliveryUnknown += 1;
          throw error;
        }
        await boundary('outbound_telegram_accepted', channel, {
          receiptId: delivery.receiptId,
          sequence: delivery.sequence,
        });
        channel.outboundDelivery.status = 'sent';
        saveTelegramChannels(client.stateDir, channels);
        await boundary('outbound_send_persisted', channel, {
          receiptId: delivery.receiptId,
          sequence: delivery.sequence,
        });
        await client.deviceRequest(
          'POST',
          '/api/runner/device/channels/telegram/ack',
          {
            endpointId: channel.endpointId,
            receiptId: delivery.receiptId,
            eventId: delivery.eventId,
            sequence: delivery.sequence,
            outcome: 'delivered',
          },
        );
        await boundary('outbound_acked', channel, {
          receiptId: delivery.receiptId,
          sequence: delivery.sequence,
        });
        channel.outboundDelivery = null;
        saveTelegramChannels(client.stateDir, channels);
        outbound += 1;
      }
    }
    saveTelegramChannels(client.stateDir, channels);
    return {
      ok: true,
      bindings: channels.length,
      inbound,
      outbound,
      deliveryUnknown,
    };
  } finally {
    for (const release of releases.reverse()) release();
  }
}

module.exports = {
  bindTelegramChannels,
  initializeTelegramChannelOffsets,
  reportTelegramIngressOwnership,
  runTelegramChannelOnce,
};
