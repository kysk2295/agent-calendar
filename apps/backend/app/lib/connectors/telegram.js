const crypto = require('node:crypto');

const TELEGRAM_BOT_ROUTE_DEFINITIONS = Object.freeze([
  { agentId: 'default', envName: 'HERMES_TELEGRAM_BOT_TOKEN', webhookPath: '/api/telegram/webhook' },
  { agentId: 'bizconsultant', envName: 'HERMES_TELEGRAM_BOT_TOKEN_BIZCONSULTANT', webhookPath: '/api/telegram/webhook/bizconsultant' },
  { agentId: 'stockagent', envName: 'HERMES_TELEGRAM_BOT_TOKEN_STOCKAGENT', webhookPath: '/api/telegram/webhook/stockagent' },
  { agentId: 'uniportpm', envName: 'HERMES_TELEGRAM_BOT_TOKEN_UNIPORTPM', webhookPath: '/api/telegram/webhook/uniportpm' },
  { agentId: 'wikicurator', envName: 'HERMES_TELEGRAM_BOT_TOKEN_WIKICURATOR', webhookPath: '/api/telegram/webhook/wikicurator' },
]);

function telegramBotRoutesFromEnv(env = process.env) {
  const seenTokens = new Set();
  return TELEGRAM_BOT_ROUTE_DEFINITIONS.flatMap((definition) => {
    const botToken = String(env[definition.envName] || '').trim();
    if (!botToken || seenTokens.has(botToken)) return [];
    seenTokens.add(botToken);
    return [{ ...definition, botToken }];
  });
}

function telegramBotTokenForAgent(env = process.env, agentId = 'default') {
  const normalizedAgentId = String(agentId || 'default').trim().toLowerCase() || 'default';
  return telegramBotRoutesFromEnv(env)
    .find((route) => route.agentId === normalizedAgentId)?.botToken || '';
}

function telegramIngressMode(env = process.env) {
  const mode = String(env.HERMES_TELEGRAM_INGRESS_MODE || '').trim().toLowerCase();
  if (!mode || mode === 'webhook') return 'webhook';
  if (['existing-poller', 'poller', 'external-poller'].includes(mode)) return 'existing-poller';
  return 'disabled';
}

function isTelegramWebhookPath(pathname = '') {
  const normalizedPathname = String(pathname || '').trim();
  return TELEGRAM_BOT_ROUTE_DEFINITIONS
    .some((route) => route.webhookPath === normalizedPathname);
}

function stripCommand(text) {
  return String(text || '')
    .replace(/^\s*\/hermes(?:@\w+)?\b/i, '')
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function telegramWebhookSecret(botToken) {
  const token = String(botToken || '').trim();
  if (!token) return '';
  return crypto
    .createHmac('sha256', token)
    .update('agent-calendar-telegram-webhook:v1')
    .digest('hex');
}

function telegramWebhookRequestAuthorized({ botToken, secretToken } = {}) {
  const expected = telegramWebhookSecret(botToken);
  const received = String(secretToken || '').trim();
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function largestPhoto(photos = []) {
  if (!Array.isArray(photos) || !photos.length) return null;
  return [...photos].sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0];
}

function telegramAttachmentFromMessage(message = {}) {
  if (message.document) {
    return {
      kind: 'document',
      filename: message.document.file_name || `telegram-document-${message.message_id || 'unknown'}`,
      mimeType: message.document.mime_type || 'application/octet-stream',
      size: Number(message.document.file_size || 0),
      fileId: message.document.file_id || '',
      fileUniqueId: message.document.file_unique_id || '',
    };
  }
  const photo = largestPhoto(message.photo);
  if (photo) {
    return {
      kind: 'photo',
      filename: `telegram-photo-${message.message_id || 'unknown'}.jpg`,
      mimeType: 'image/jpeg',
      size: Number(photo.file_size || 0),
      fileId: photo.file_id || '',
      fileUniqueId: photo.file_unique_id || '',
    };
  }
  for (const key of ['video', 'audio', 'voice']) {
    if (message[key]) {
      const file = message[key];
      const extension = key === 'voice' ? 'ogg' : key;
      return {
        kind: key,
        filename: file.file_name || `telegram-${key}-${message.message_id || 'unknown'}.${extension}`,
        mimeType: file.mime_type || `${key === 'voice' ? 'audio' : key}/unknown`,
        size: Number(file.file_size || 0),
        fileId: file.file_id || '',
        fileUniqueId: file.file_unique_id || '',
      };
    }
  }
  return null;
}

function parseTelegramUpdate(update = {}, { agentId = 'default' } = {}) {
  const message = update.message || update.edited_message || {};
  const text = message.text || message.caption || '';
  const tags = text.match(/#\S+/g) || [];
  const shouldRun = /^\s*\/hermes(?:@\w+)?\b/i.test(text) || /(^|\s)#(hermes|agent|auto)\b/i.test(text);
  const chatId = message.chat && message.chat.id;
  const messageId = message.message_id || update.update_id || 'unknown';
  const attachment = telegramAttachmentFromMessage(message);
  const normalizedAgentId = String(agentId || 'default').trim().toLowerCase() || 'default';
  const sourcePrefix = normalizedAgentId === 'default' ? 'telegram' : `telegram:${normalizedAgentId}`;
  return {
    agentId: normalizedAgentId,
    shouldRun,
    source: 'telegram',
    sourceId: `${sourcePrefix}:${chatId || 'unknown'}:${messageId}`,
    chatId,
    messageId,
    username: message.from && (message.from.username || message.from.first_name),
    text,
    command: shouldRun ? stripCommand(text) : '',
    tags,
    attachment: attachment ? { ...attachment, caption: message.caption || '' } : null,
    receivedAt: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
  };
}

function createDocumentPayloadFromTelegram(parsed = {}, downloaded = null) {
  return createDocumentPayloadFromTelegramDownload(parsed, downloaded);
}

function isTextLikeAttachment(attachment = {}) {
  const mimeType = String(attachment.mimeType || '').toLowerCase();
  const filename = String(attachment.filename || '').toLowerCase();
  return mimeType.startsWith('text/')
    || mimeType.includes('json')
    || mimeType.includes('csv')
    || /\.(txt|md|log|csv|json)$/i.test(filename);
}

async function fetchTelegramAttachment({ botToken, attachment, fetchImpl = fetch } = {}) {
  if (!botToken || !attachment?.fileId) {
    return { ok: false, error: !botToken ? 'telegram bot token missing' : 'telegram file id missing' };
  }
  const fileInfoResponse = await fetchImpl(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(attachment.fileId)}`);
  if (!fileInfoResponse.ok) {
    return { ok: false, status: fileInfoResponse.status, error: `Telegram getFile failed: ${fileInfoResponse.status}` };
  }
  const fileInfo = await fileInfoResponse.json();
  const filePath = String(fileInfo?.result?.file_path || '');
  if (!filePath) return { ok: false, error: 'Telegram getFile did not return file_path' };
  const fileResponse = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileResponse.ok) {
    return { ok: false, status: fileResponse.status, filePath, error: `Telegram file download failed: ${fileResponse.status}` };
  }
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  return {
    ok: true,
    bytes: buffer.length,
    buffer,
    text: isTextLikeAttachment(attachment) ? buffer.toString('utf8') : '',
    telegramFilePath: filePath,
    downloadedAt: new Date().toISOString(),
  };
}

function createDocumentPayloadFromTelegramDownload(parsed = {}, downloaded = null) {
  if (!parsed.attachment) return null;
  const attachment = parsed.attachment;
  const hasDownload = downloaded && typeof downloaded === 'object';
  const extractedText = hasDownload ? String(downloaded.text || '') : (attachment.caption || parsed.command || parsed.text || '');
  return {
    title: attachment.filename,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: downloaded?.bytes || attachment.size,
    content: extractedText,
    ocrStatus: hasDownload ? (extractedText ? 'extracted' : 'pending') : undefined,
    summary: attachment.caption || parsed.command || parsed.text || '',
    source: 'telegram',
    sourceLabel: 'Telegram',
    sourceId: parsed.sourceId,
    sourceChatId: parsed.chatId,
    sourceMessageId: parsed.messageId,
    sourceUsername: parsed.username,
    telegramFileId: attachment.fileId,
    telegramFileUniqueId: attachment.fileUniqueId,
    telegramFilePath: downloaded?.telegramFilePath || '',
    downloadedAt: downloaded?.downloadedAt || '',
    downloadStatus: downloaded ? (downloaded.ok ? 'downloaded' : 'failed') : 'metadata-only',
    downloadError: downloaded && !downloaded.ok ? downloaded.error || '' : '',
    tags: parsed.tags,
  };
}

function createRunPayloadFromTelegram(parsed) {
  return {
    goal: parsed.command || parsed.text,
    source: 'telegram',
    sourceId: parsed.sourceId,
    agent: parsed.agentId || 'default',
    model: 'Recommended',
    noApproval: false,
    metadata: {
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      username: parsed.username,
      tags: parsed.tags,
    },
  };
}

async function registerTelegramWebhook({ botToken, webhookUrl, fetchImpl = fetch }) {
  if (!botToken) throw new Error('Telegram bot token is required');
  if (!webhookUrl) throw new Error('Telegram webhookUrl is required');
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'edited_message'],
      secret_token: telegramWebhookSecret(botToken),
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram setWebhook failed: ${response.status}`);
  }
  return response.json();
}

function safeTelegramSummaryLine(value, maximumLength = Number.POSITIVE_INFINITY) {
  const sanitized = String(value || '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6,12}:AA[A-Za-z0-9_-]{30,}/g, '[redacted-telegram-token]')
    .replace(/(?:token|secret|password)\s*[=:]\s*[^\s]+/gi, '[redacted]')
    .replace(/\/(?:Users|home)\/[^\s"']+/g, '[private-path]')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(sanitized);
  if (characters.length <= maximumLength) return sanitized;
  return `${characters.slice(0, Math.max(0, maximumLength - 1)).join('')}…`;
}

function formatAgentReportTelegram(report = {}, { appUrl = '' } = {}) {
  const title = safeTelegramSummaryLine(report.title || 'Agent Report', 200);
  const findings = (Array.isArray(report.findings) ? report.findings : [])
    .slice(0, 3)
    .map((finding) => safeTelegramSummaryLine(finding, 800))
    .filter(Boolean);
  const limitation = safeTelegramSummaryLine(
    (Array.isArray(report.limitations) ? report.limitations : [])[0] || '',
    500,
  );
  const sessionLink = safeTelegramSummaryLine(appUrl, 500);
  return [
    title,
    '',
    '발견',
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
    ...(limitation ? ['', `한계: ${limitation}`] : []),
    ...(sessionLink ? ['', sessionLink] : []),
  ].join('\n');
}

async function sendAgentReportTelegram({
  env = process.env,
  agentId,
  chatId,
  report,
  appUrl = '',
  fetchImpl = fetch,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim().toLowerCase();
  const botToken = normalizedAgentId
    ? telegramBotTokenForAgent(env, normalizedAgentId)
    : '';
  if (!botToken || !String(chatId || '').trim()) {
    const error = new Error(`Telegram delivery is not configured for ${normalizedAgentId || 'unknown agent'}`);
    error.code = 'telegram_not_configured';
    throw error;
  }
  return sendTelegramMessage({
    botToken,
    chatId,
    text: formatAgentReportTelegram(report, { appUrl }),
    fetchImpl,
  });
}

async function sendTelegramMessage({ botToken, chatId, text, fetchImpl = fetch } = {}) {
  if (!String(botToken || '').trim()) throw new Error('Telegram bot token is required');
  if (!String(chatId || '').trim()) throw new Error('Telegram chat ID is required');
  if (!String(text || '').trim()) throw new Error('Telegram message text is required');
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text),
      disable_web_page_preview: true,
    }),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.description || `Telegram sendMessage failed: ${response.status}`);
    error.code = 'telegram_delivery_failed';
    throw error;
  }
  return payload.result || {};
}

module.exports = {
  createDocumentPayloadFromTelegram,
  createRunPayloadFromTelegram,
  fetchTelegramAttachment,
  formatAgentReportTelegram,
  parseTelegramUpdate,
  registerTelegramWebhook,
  sendAgentReportTelegram,
  sendTelegramMessage,
  isTelegramWebhookPath,
  telegramBotRoutesFromEnv,
  telegramBotTokenForAgent,
  telegramIngressMode,
  telegramWebhookRequestAuthorized,
};
