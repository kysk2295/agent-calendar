const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mailAccountDefaults(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'naver') {
    return { host: 'imap.naver.com', port: 993, secure: true };
  }
  return { host: 'imap.gmail.com', port: 993, secure: true };
}

function normalizeProvider(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'google') return 'gmail';
  if (normalized === 'navermail') return 'naver';
  return normalized === 'naver' ? 'naver' : 'gmail';
}

function normalizeMailAccount(input = {}) {
  const provider = normalizeProvider(input.provider);
  const defaults = mailAccountDefaults(provider);
  const email = String(input.email || input.username || '').trim();
  const rawUsername = String(input.username || email).trim();
  const username = provider === 'naver' && /@naver\.com$/i.test(rawUsername)
    ? rawUsername.split('@')[0]
    : rawUsername;
  return {
    id: String(input.id || `${provider}:${email}`).trim(),
    provider,
    email,
    username,
    password: String(input.password || '').trim(),
    accessToken: String(input.accessToken || '').trim(),
    host: String(input.host || defaults.host).trim(),
    port: Number(input.port || defaults.port),
    secure: input.secure !== false,
    enabled: input.enabled !== false,
    lastSyncAt: input.lastSyncAt || '',
    lastError: input.lastError || '',
  };
}

function quoteImap(value = '') {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function decodeMimeWords(value = '') {
  return String(value || '').replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_match, charset, encoding, text) => {
    try {
      const buffer = encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_hex, code) => String.fromCharCode(parseInt(code, 16))), 'binary');
      return buffer.toString(String(charset || '').toLowerCase().includes('utf-8') ? 'utf8' : 'latin1');
    } catch {
      return text;
    }
  });
}

function parseHeaderBlock(block = '') {
  const unfolded = String(block || '').replace(/\r?\n[ \t]+/g, ' ');
  const header = {};
  unfolded.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) header[match[1].toLowerCase()] = decodeMimeWords(match[2].trim());
  });
  return header;
}

function parseFetchedMessages(raw = '', account = {}) {
  return String(raw || '')
    .split(/\)\r?\n\* \d+ FETCH/gi)
    .map((chunk) => {
      const uid = chunk.match(/\bUID\s+(\d+)/i)?.[1] || '';
      const headerStart = chunk.search(/From:|Subject:|Date:|Message-ID:/i);
      if (headerStart < 0) return null;
      const text = chunk.slice(headerStart);
      const [headerText, ...bodyParts] = text.split(/\r?\n\r?\n/);
      const header = parseHeaderBlock(headerText);
      const body = extractReadableBody(bodyParts.join('\n\n')
        .replace(/\)\s*[A-Z0-9]+\s+OK[\s\S]*$/i, '')
        .trim());
      return {
        accountId: account.id,
        provider: account.provider,
        from: header.from || account.email,
        subject: header.subject || '(no subject)',
        text: body || header.subject || '',
        receivedAt: header.date ? new Date(header.date).toISOString() : new Date().toISOString(),
        messageId: header['message-id'] || `${account.id}-${uid || Date.now()}`,
      };
    })
    .filter(Boolean);
}

function walkFiles(root, predicate, output = []) {
  if (!root || !fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, output);
    } else if (!predicate || predicate(fullPath)) {
      output.push(fullPath);
    }
  }
  return output;
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeQuotedPrintable(value = '') {
  const binary = String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(binary, 'binary').toString('utf8');
}

function decodeTransferPayload(value = '', encoding = '') {
  const normalized = String(encoding || '').trim().toLowerCase();
  try {
    if (normalized === 'base64') {
      return Buffer.from(String(value || '').replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (normalized === 'quoted-printable') {
      return decodeQuotedPrintable(value);
    }
  } catch {
    return String(value || '');
  }
  return String(value || '');
}

function cleanupMailText(value = '') {
  return stripHtml(String(value || '')
    .replace(/\r/g, '')
    .replace(/^Content-[^\n]*(?:\n[ \t][^\n]*)*\n?/gim, ' ')
    .replace(/^MIME-Version:[^\n]*\n?/gim, ' ')
    .replace(/^--[^\n]+$/gm, ' ')
    .replace(/\s+/g, ' '))
    .slice(0, 1200);
}

function extractReadableBody(rawBody = '') {
  const body = String(rawBody || '')
    .replace(/\r/g, '')
    .split(/\n<?xml version=|<plist version=/)[0]
    .trim();
  if (!body) return '';

  const parts = body
    .split(/\n?--[A-Za-z0-9'()+_,./:=?-]+(?:--)?\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = (parts.length ? parts : [body])
    .map((part) => {
      const [partHeader, ...payloadParts] = part.split(/\n\n/);
      const hasPartHeader = /^(Content-|MIME-Version:)/im.test(partHeader || '');
      const header = hasPartHeader ? parseHeaderBlock(partHeader) : {};
      const contentType = String(header['content-type'] || '').toLowerCase();
      const disposition = String(header['content-disposition'] || '').toLowerCase();
      const payload = hasPartHeader ? payloadParts.join('\n\n') : part;
      if (/attachment/.test(disposition) || /^(image|application|audio|video)\//.test(contentType)) return null;
      const decoded = decodeTransferPayload(payload, header['content-transfer-encoding']);
      const text = cleanupMailText(decoded);
      const score = contentType.includes('text/plain') ? 3 : contentType.includes('text/html') ? 2 : hasPartHeader ? 1 : 0;
      const meaningfulLength = text.replace(/[=\s]+/g, '').length;
      return meaningfulLength > 3 ? { text, score, meaningfulLength } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (b.meaningfulLength - a.meaningfulLength));

  return candidates[0]?.text || cleanupMailText(body);
}

function parseEmlxFile(filePath, account = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const withoutLength = raw.replace(/^\d+\r?\n/, '');
  const [headerText, ...bodyParts] = withoutLength.split(/\r?\n\r?\n/);
  const header = parseHeaderBlock(headerText);
  const body = extractReadableBody(bodyParts.join('\n\n'));
  const stat = fs.statSync(filePath);
  const receivedAt = header.date
    ? new Date(header.date).toISOString()
    : stat.mtime.toISOString();
  return {
    accountId: account.id || 'apple-mail:gmail-local',
    provider: account.provider || 'gmail',
    from: header.from || account.email || 'Apple Mail',
    subject: header.subject || '(no subject)',
    text: body,
    receivedAt,
    messageId: header['message-id'] || `apple-mail-${path.basename(filePath, '.emlx')}`,
  };
}

function appleMailInboxRoots(mailRoot = path.join(os.homedir(), 'Library/Mail')) {
  const inboxRoots = walkFiles(mailRoot, (filePath) => filePath.endsWith('Info.plist'))
    .filter((filePath) => /\/INBOX\.mbox\/Info\.plist$/.test(filePath))
    .map((filePath) => path.dirname(filePath));
  const rootsWithMessages = inboxRoots.filter((root) => walkFiles(root, (filePath) => /\.emlx$/i.test(filePath)).length);
  if (rootsWithMessages.length) return rootsWithMessages;
  return walkFiles(mailRoot, (filePath) => filePath.endsWith('Info.plist'))
    .map((filePath) => path.dirname(filePath))
    .filter((root) => /\.mbox$/.test(root))
    .filter((root) => !/(Outbox|SendLater|Drafts|Sent|Unwanted|Spam|Trash|휴지통|스팸함|보낸편지함|임시보관함)\.mbox/i.test(root))
    .filter((root) => walkFiles(root, (filePath) => /\.emlx$/i.test(filePath)).length);
}

function syncAppleMailMessages({ mailRoot = path.join(os.homedir(), 'Library/Mail'), limit = 20 } = {}) {
  const roots = appleMailInboxRoots(mailRoot);
  const files = roots
    .flatMap((root) => walkFiles(root, (filePath) => /\.emlx$/i.test(filePath)))
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Number(limit || 20))
    .map((item) => item.filePath);
  const messages = files.map((filePath) => parseEmlxFile(filePath, {
    id: 'apple-mail:gmail-local',
    provider: 'gmail',
    email: 'Apple Mail Gmail',
  }));
  return {
    messages,
    accounts: [{
      accountId: 'apple-mail:gmail-local',
      provider: 'gmail',
      ok: true,
      count: messages.length,
      syncedAt: new Date().toISOString(),
      source: 'apple-mail',
    }],
  };
}

function connectTls(account, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: account.host,
      port: account.port,
      servername: account.host,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('mail_sync_timeout'));
    }, timeoutMs);
    socket.once('secureConnect', () => resolve({ socket, timer }));
    socket.once('error', reject);
  });
}

async function fetchImapMessages(account, { limit = 10, timeoutMs = 12000 } = {}) {
  const { socket, timer } = await connectTls(account, timeoutMs);
  let buffer = '';
  let tagIndex = 1;

  function waitFor(pattern) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        socket.off('data', onData);
        socket.off('error', onError);
      }
      function onError(error) {
        cleanup();
        reject(error);
      }
      function onData(chunk) {
        buffer += chunk.toString('utf8');
        if (pattern.test(buffer)) {
          const value = buffer;
          buffer = '';
          cleanup();
          resolve(value);
        }
      }
      socket.on('data', onData);
      socket.once('error', onError);
      if (pattern.test(buffer)) {
        const value = buffer;
        buffer = '';
        cleanup();
        resolve(value);
      }
    });
  }

  async function command(name, args = '', pattern) {
    const tag = `A${tagIndex++}`;
    socket.write(`${tag} ${name}${args ? ` ${args}` : ''}\r\n`);
    const response = await waitFor(pattern || new RegExp(`${tag} (OK|NO|BAD)`, 'i'));
    if (new RegExp(`${tag} (NO|BAD)`, 'i').test(response)) {
      throw new Error(`imap_${name.toLowerCase()}_failed`);
    }
    return response;
  }

  try {
    await waitFor(/^\* OK/im);
    await command('LOGIN', `${quoteImap(account.username)} ${quoteImap(account.password || account.accessToken)}`);
    await command('SELECT', 'INBOX');
    const search = await command('UID SEARCH', 'ALL');
    const uids = (search.match(/\* SEARCH ([\d\s]+)/i)?.[1] || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(-Number(limit || 10));
    if (!uids.length) return [];
    const fetched = await command('UID FETCH', `${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT]<0.1024>)`);
    return parseFetchedMessages(fetched, account);
  } finally {
    try {
      socket.write(`A${tagIndex++} LOGOUT\r\n`);
    } catch {
      // best effort logout
    }
    clearTimeout(timer);
    socket.destroy();
  }
}

async function syncMailAccounts({ accounts = [], limit = 10 } = {}) {
  const normalized = (Array.isArray(accounts) ? accounts : []).map(normalizeMailAccount).filter((account) => account.enabled !== false);
  const statuses = [];
  const messages = [];
  for (const account of normalized) {
    if (!account.username || !(account.password || account.accessToken)) {
      statuses.push({ accountId: account.id, provider: account.provider, ok: false, reason: 'missing-credentials' });
      continue;
    }
    try {
      const imported = await fetchImapMessages(account, { limit });
      messages.push(...imported);
      statuses.push({ accountId: account.id, provider: account.provider, ok: true, count: imported.length, syncedAt: new Date().toISOString() });
    } catch (error) {
      statuses.push({ accountId: account.id, provider: account.provider, ok: false, reason: error.message || 'sync_failed' });
    }
  }
  return { messages, accounts: statuses };
}

module.exports = {
  extractReadableBody,
  mailAccountDefaults,
  normalizeMailAccount,
  syncAppleMailMessages,
  syncMailAccounts,
};
