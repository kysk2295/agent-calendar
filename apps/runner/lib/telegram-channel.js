'use strict';

const {
  listTelegramChannels,
  saveTelegramChannels,
} = require('./store');

const INGRESS_REPORT_INTERVAL_MS = 60_000;

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

async function runTelegramChannelOnce(client, { fetchImpl = fetch } = {}) {
  const channels = await bindTelegramChannels(client, listTelegramChannels(client.stateDir));
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
      }
      if (Number.isSafeInteger(updateId)) {
        channel.updateOffset = Math.max(Number(channel.updateOffset || 0), updateId + 1);
      }
    }
    for (let count = 0; count < 20; count += 1) {
      const result = await client.deviceRequest(
        'POST',
        '/api/runner/device/channels/telegram/next',
        { endpointId: channel.endpointId },
      );
      const delivery = result.delivery;
      if (!delivery) break;
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
      await client.deviceRequest(
        'POST',
        '/api/runner/device/channels/telegram/ack',
        {
          endpointId: channel.endpointId,
          eventId: delivery.eventId,
          sequence: delivery.sequence,
        },
      );
      outbound += 1;
    }
  }
  saveTelegramChannels(client.stateDir, channels);
  return { ok: true, bindings: channels.length, inbound, outbound };
}

module.exports = {
  bindTelegramChannels,
  initializeTelegramChannelOffsets,
  reportTelegramIngressOwnership,
  runTelegramChannelOnce,
};
