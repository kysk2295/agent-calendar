'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { generateEd25519Keypair, fingerprint, formatFingerprint } = require('./crypto');

function defaultStateDir(env = process.env) {
  if (env.AGENT_CALENDAR_RUNNER_HOME) {
    return path.resolve(env.AGENT_CALENDAR_RUNNER_HOME);
  }
  return path.join(os.homedir(), '.agent-calendar-runner');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows may ignore mode
  }
}

function writePrivateFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(temporaryPath, 0o600);
    } catch {}
    fs.renameSync(temporaryPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function loadOrCreateIdentity(stateDir) {
  ensureDir(stateDir);
  const keyPath = path.join(stateDir, 'device-key.json');
  if (fs.existsSync(keyPath)) {
    const parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return {
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      fingerprint: fingerprint(parsed.publicKey),
      fingerprintGrouped: formatFingerprint(fingerprint(parsed.publicKey)),
      path: keyPath,
    };
  }
  const keys = generateEd25519Keypair();
  const payload = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: new Date().toISOString(),
  };
  writePrivateFile(keyPath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    fingerprint: fingerprint(keys.publicKey),
    fingerprintGrouped: formatFingerprint(fingerprint(keys.publicKey)),
    path: keyPath,
  };
}

function loadState(stateDir) {
  const statePath = path.join(stateDir, 'state.json');
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(stateDir, state) {
  ensureDir(stateDir);
  const statePath = path.join(stateDir, 'state.json');
  writePrivateFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

function knowledgeSourcesPath(stateDir) {
  return path.join(stateDir, 'knowledge-sources.json');
}

function listKnowledgeSources(stateDir) {
  const filePath = knowledgeSourcesPath(stateDir);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

function registerKnowledgeSource(stateDir, { sourceId, path: sourcePath, label = '' } = {}) {
  const id = String(sourceId || '').trim();
  if (!id) {
    throw Object.assign(new Error('sourceId is required'), { code: 'KNOWLEDGE_SOURCE_ID_REQUIRED' });
  }
  const resolvedPath = path.resolve(String(sourcePath || ''));
  if (!sourcePath || !fs.existsSync(resolvedPath)) {
    throw Object.assign(new Error('local source path does not exist'), { code: 'KNOWLEDGE_SOURCE_PATH_INVALID' });
  }
  const realPath = fs.realpathSync(resolvedPath);
  const sources = listKnowledgeSources(stateDir).filter((source) => source.sourceId !== id);
  sources.push({
    sourceId: id,
    path: realPath,
    label: String(label || path.basename(realPath)).slice(0, 200),
    updatedAt: new Date().toISOString(),
  });
  sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  ensureDir(stateDir);
  writePrivateFile(
    knowledgeSourcesPath(stateDir),
    `${JSON.stringify({ sources }, null, 2)}\n`,
  );
  return sources.find((source) => source.sourceId === id);
}

function removeKnowledgeSource(stateDir, sourceId) {
  const id = String(sourceId || '').trim();
  const current = listKnowledgeSources(stateDir);
  const sources = current.filter((source) => source.sourceId !== id);
  if (sources.length === current.length) return false;
  writePrivateFile(
    knowledgeSourcesPath(stateDir),
    `${JSON.stringify({ sources }, null, 2)}\n`,
  );
  return true;
}

function telegramChannelsPath(stateDir) {
  return path.join(stateDir, 'telegram-channels.json');
}

function invalidTelegramChannelState() {
  return Object.assign(new Error('Persisted Telegram channel state is invalid'), {
    code: 'TELEGRAM_CHANNEL_STATE_INVALID',
  });
}

function telegramBindingLockPath(stateDir, bindingHandle) {
  const digest = crypto.createHash('sha256').update(String(bindingHandle)).digest('hex');
  return path.join(stateDir, `telegram-binding-${digest}.lock`);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function appendTelegramBindingLockRecord(lockPath, record) {
  const descriptor = fs.openSync(lockPath, 'a', 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    const payload = Buffer.from(`\n${JSON.stringify(record)}\n`, 'utf8');
    const written = fs.writeSync(descriptor, payload, 0, payload.length);
    if (written !== payload.length) {
      throw new Error('Telegram binding lock record write was interrupted');
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function liveTelegramBindingLockRecords(lockPath) {
  const records = [];
  const releasedTokens = new Set();
  for (const line of fs.readFileSync(lockPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.op === 'release' && typeof record.token === 'string') {
      releasedTokens.add(record.token);
    } else if (
      record?.op === 'acquire'
      && typeof record.token === 'string'
      && Number.isSafeInteger(record.pid)
    ) {
      records.push(record);
    } else if (Number.isSafeInteger(record?.pid)) {
      records.push({ pid: record.pid, token: '' });
    }
  }
  return records.filter((record) => (
    !releasedTokens.has(record.token)
    && processIsAlive(record.pid)
  ));
}

function acquireTelegramBindingLock(stateDir, bindingHandle) {
  ensureDir(stateDir);
  const lockPath = telegramBindingLockPath(stateDir, bindingHandle);
  const token = crypto.randomUUID();
  appendTelegramBindingLockRecord(lockPath, {
    op: 'acquire',
    token,
    pid: process.pid,
  });
  const owner = liveTelegramBindingLockRecords(lockPath)[0];
  if (owner?.token !== token) {
    appendTelegramBindingLockRecord(lockPath, {
      op: 'release',
      token,
      pid: process.pid,
    });
    throw Object.assign(new Error('Telegram binding already has a local loop'), {
      code: 'TELEGRAM_BINDING_LOCKED',
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    appendTelegramBindingLockRecord(lockPath, {
      op: 'release',
      token,
      pid: process.pid,
    });
  };
}

function listTelegramChannels(stateDir) {
  const filePath = telegramChannelsPath(stateDir);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.channels)) {
      throw invalidTelegramChannelState();
    }
    return parsed.channels;
  } catch (error) {
    if (error?.code === 'TELEGRAM_CHANNEL_STATE_INVALID') throw error;
    throw invalidTelegramChannelState();
  }
}

function saveTelegramChannels(stateDir, channels) {
  writePrivateFile(
    telegramChannelsPath(stateDir),
    `${JSON.stringify({ channels }, null, 2)}\n`,
  );
  return channels;
}

function registerTelegramChannel(stateDir, {
  workConversationId,
  botToken,
  chatId,
  executionEngine = 'auto',
  requestedModel = '',
} = {}) {
  const conversationId = String(workConversationId || '').trim();
  const token = String(botToken || '').trim();
  const localChatId = String(chatId || '').trim();
  const engine = String(executionEngine || 'auto').trim().toLowerCase();
  const model = String(requestedModel || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,159}$/.test(conversationId)) {
    throw Object.assign(new Error('workConversationId is invalid'), { code: 'TELEGRAM_CONVERSATION_ID_INVALID' });
  }
  if (!token || !localChatId) {
    throw Object.assign(new Error('Telegram bot token and chat id are required locally'), { code: 'TELEGRAM_LOCAL_CREDENTIAL_REQUIRED' });
  }
  if (!['auto', 'codex', 'claude', 'grok', 'hermes'].includes(engine)) {
    throw Object.assign(new Error('Telegram execution engine is invalid'), { code: 'TELEGRAM_ENGINE_INVALID' });
  }
  if (model && (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
    || /^(sk-|bearer|token|cookie|secret)/i.test(model)
  )) {
    throw Object.assign(new Error('Telegram execution model is invalid'), { code: 'TELEGRAM_MODEL_INVALID' });
  }
  const channels = listTelegramChannels(stateDir);
  const sameLocalChat = channels.find((channel) => (
    channel.botToken === token
    && String(channel.chatId) === localChatId
    && channel.workConversationId !== conversationId
  ));
  if (sameLocalChat) {
    throw Object.assign(
      new Error('Telegram chat is already bound to another Work Conversation'),
      { code: 'TELEGRAM_CHAT_ALREADY_BOUND' },
    );
  }
  const sameConversation = channels.find((channel) => channel.workConversationId === conversationId);
  const channel = {
    bindingHandle: sameConversation?.bindingHandle || `tg_${crypto.randomBytes(16).toString('hex')}`,
    endpointId: sameConversation?.endpointId || '',
    workConversationId: conversationId,
    botToken: token,
    chatId: localChatId,
    executionEngine: engine,
    requestedModel: model,
    updateOffset: Number(sameConversation?.updateOffset || 0),
    updateOffsetInitialized: sameConversation
      ? sameConversation.updateOffsetInitialized === true
        || Number(sameConversation.updateOffset || 0) > 0
      : false,
    updatedAt: new Date().toISOString(),
  };
  saveTelegramChannels(stateDir, [
    ...channels.filter((item) => item.workConversationId !== conversationId),
    channel,
  ]);
  return channel;
}

module.exports = {
  acquireTelegramBindingLock,
  defaultStateDir,
  ensureDir,
  loadOrCreateIdentity,
  listKnowledgeSources,
  listTelegramChannels,
  loadState,
  registerKnowledgeSource,
  removeKnowledgeSource,
  registerTelegramChannel,
  saveState,
  saveTelegramChannels,
  writePrivateFile,
};
