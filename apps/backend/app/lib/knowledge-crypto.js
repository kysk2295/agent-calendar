'use strict';

/**
 * Knowledge v2 encryption helpers (AES-256-GCM).
 * Strict 32-byte key: base64 or 64 hex. Fail closed — no weak passphrases.
 */

const crypto = require('node:crypto');

function reject(code, message, statusHint = 503) {
  const err = new Error(message || code);
  err.code = code;
  err.statusHint = statusHint;
  throw err;
}

function resolveKnowledgeKeyBytes(env = process.env) {
  const raw = String(
    env.KNOWLEDGE_ENCRYPTION_KEY
    || env.KNOWLEDGE_V2_ENCRYPTION_KEY
    || '',
  ).trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch { /* ignore */ }
  return null;
}

function requireKnowledgeKey(env = process.env) {
  const key = resolveKnowledgeKeyBytes(env);
  if (!key) {
    reject(
      'KNOWLEDGE_VAULT_KEY_REQUIRED',
      'KNOWLEDGE_ENCRYPTION_KEY must be exactly 32-byte base64 or 64 hex for cloud-indexed knowledge',
      503,
    );
  }
  return key;
}

function sealKnowledge(plaintext, keyBytes) {
  if (plaintext == null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `kv1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

function openKnowledge(sealed, keyBytes) {
  if (!sealed) return '';
  const text = String(sealed);
  if (!text.startsWith('kv1:')) {
    reject('KNOWLEDGE_CIPHERTEXT_INVALID', 'knowledge blob is not encrypted ciphertext', 500);
  }
  const parts = text.split(':');
  if (parts.length !== 4) reject('KNOWLEDGE_CIPHERTEXT_INVALID', 'malformed ciphertext', 500);
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ct = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function hashContent(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function knowledgeTokens(text) {
  return Array.from(new Set(
    String(text || '')
      .normalize('NFKC')
      .toLocaleLowerCase('und')
      .match(/[\p{L}\p{N}]{2,}/gu) || [],
  )).slice(0, 512);
}

function hashKnowledgeTokens(text, keyBytes) {
  return knowledgeTokens(text).map((token) => (
    crypto.createHmac('sha256', keyBytes).update(token, 'utf8').digest('hex')
  ));
}

/** Deterministic 256-dim hash embedding (parity with legacy hermes-hash). */
function hashEmbedding256(text) {
  const s = String(text || '');
  return Array.from({ length: 256 }, (_, i) => {
    let h = 0;
    for (let c = 0; c < s.length; c += 1) {
      h = ((h << 5) - h + s.charCodeAt(c) + i) | 0;
    }
    return (h % 1000) / 1000;
  });
}

function vectorLiteral(vector) {
  return `[${vector.map((n) => {
    const num = Number(n);
    return Number.isFinite(num) ? num : 0;
  }).join(',')}]`;
}

module.exports = {
  resolveKnowledgeKeyBytes,
  requireKnowledgeKey,
  sealKnowledge,
  openKnowledge,
  hashContent,
  hashKnowledgeTokens,
  hashEmbedding256,
  vectorLiteral,
};
