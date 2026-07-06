function stripCommand(text) {
  return String(text || '')
    .replace(/^\s*\/hermes(?:@\w+)?\b/i, '')
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function parseTelegramUpdate(update = {}) {
  const message = update.message || update.edited_message || {};
  const text = message.text || message.caption || '';
  const tags = text.match(/#\S+/g) || [];
  const shouldRun = /^\s*\/hermes(?:@\w+)?\b/i.test(text) || /(^|\s)#(hermes|agent|auto)\b/i.test(text);
  const chatId = message.chat && message.chat.id;
  const messageId = message.message_id || update.update_id || 'unknown';
  const attachment = telegramAttachmentFromMessage(message);
  return {
    shouldRun,
    source: 'telegram',
    sourceId: `telegram:${chatId || 'unknown'}:${messageId}`,
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
    agent: 'default',
    model: 'Recommended',
    noApproval: true,
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
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram setWebhook failed: ${response.status}`);
  }
  return response.json();
}

module.exports = {
  createDocumentPayloadFromTelegram,
  createRunPayloadFromTelegram,
  fetchTelegramAttachment,
  parseTelegramUpdate,
  registerTelegramWebhook,
};
