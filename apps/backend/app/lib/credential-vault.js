'use strict';

/**
 * Encrypted credential vault for Google (and future) OAuth tokens.
 * - Never stores plaintext access/refresh tokens.
 * - Requires GOOGLE_CREDENTIAL_ENCRYPTION_KEY (or CALENDAR_CREDENTIAL_ENCRYPTION_KEY):
 *   32-byte key as base64 or 64-char hex.
 * - Fail closed when key is absent (production OAuth path).
 * - Intended for service/superuser pool access only — not agent_calendar_app SELECT.
 */

const crypto = require('node:crypto');

function reject(code, message, statusHint = 503) {
  const err = new Error(message || code);
  err.code = code;
  err.statusHint = statusHint;
  throw err;
}

function resolveVaultKeyBytes(env = process.env) {
  const raw = String(
    env.GOOGLE_CREDENTIAL_ENCRYPTION_KEY
    || env.CALENDAR_CREDENTIAL_ENCRYPTION_KEY
    || '',
  ).trim();
  if (!raw) return null;
  // Strict: exactly 32-byte base64 OR 64-char hex. No weak passphrase scrypt.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return null;
}

function requireVaultKey(env = process.env) {
  const external = String(env.GOOGLE_CREDENTIAL_VAULT || '').toLowerCase() === 'external';
  const key = resolveVaultKeyBytes(env);
  if (!key && !external) {
    reject(
      'GOOGLE_VAULT_KEY_REQUIRED',
      'GOOGLE_CREDENTIAL_ENCRYPTION_KEY (or external vault) is required; refusing plaintext token storage',
      503,
    );
  }
  if (!key && external) {
    reject(
      'GOOGLE_EXTERNAL_VAULT_REQUIRED',
      'GOOGLE_CREDENTIAL_VAULT=external requires an injected credentialVault implementation',
      503,
    );
  }
  return key;
}

function seal(plaintext, keyBytes) {
  if (plaintext == null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

function open(sealed, keyBytes) {
  if (!sealed) return '';
  const text = String(sealed);
  if (!text.startsWith('v1:')) {
    // Refuse to return legacy plaintext as tokens.
    reject('GOOGLE_VAULT_CIPHERTEXT_INVALID', 'vault value is not encrypted ciphertext', 500);
  }
  const parts = text.split(':');
  if (parts.length !== 4) reject('GOOGLE_VAULT_CIPHERTEXT_INVALID', 'malformed ciphertext', 500);
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ct = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * DB-backed vault using service pool (owner). Encrypts at rest.
 * Does not use app-role RLS clients for secret material.
 */
function createDbCredentialVault(pool, env = process.env) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createDbCredentialVault requires pool');
  }
  return {
    kind: 'encrypted-db',
    async putTokens(credentialRef, tokens, meta = {}) {
      const key = requireVaultKey(env);
      const accessEnc = seal(tokens.accessToken || '', key);
      const refreshEnc = seal(tokens.refreshToken || '', key);
      // Defense: never persist if seal failed open to empty when token present
      if (tokens.accessToken && !accessEnc.startsWith('v1:')) {
        reject('GOOGLE_VAULT_SEAL_FAILED', 'failed to seal access token', 500);
      }
      await pool.query(
        `insert into calendar_credential_vault (
           credential_ref, workspace_id, provider, access_token_enc, refresh_token_enc,
           access_expires_at, payload, updated_at
         ) values ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb, now())
         on conflict (credential_ref) do update set
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = coalesce(nullif(excluded.refresh_token_enc, ''), calendar_credential_vault.refresh_token_enc),
           access_expires_at = excluded.access_expires_at,
           payload = calendar_credential_vault.payload || excluded.payload,
           updated_at = now()`,
        [
          credentialRef,
          meta.workspaceId || tokens.workspaceId || '',
          meta.provider || 'google',
          accessEnc,
          refreshEnc,
          tokens.accessExpiresAt || null,
          JSON.stringify({ rotatedAt: new Date().toISOString(), enc: 'aes-256-gcm-v1' }),
        ],
      );
    },
    async getTokens(credentialRef) {
      const key = requireVaultKey(env);
      const r = await pool.query(
        `select access_token_enc, refresh_token_enc, access_expires_at
         from calendar_credential_vault where credential_ref = $1`,
        [credentialRef],
      );
      if (!r.rowCount) return null;
      return {
        accessToken: open(r.rows[0].access_token_enc, key),
        refreshToken: open(r.rows[0].refresh_token_enc, key),
        accessExpiresAt: r.rows[0].access_expires_at,
      };
    },
    async revoke(credentialRef) {
      await pool.query(`delete from calendar_credential_vault where credential_ref = $1`, [credentialRef]);
    },
    sealSecret(plaintext) {
      const key = requireVaultKey(env);
      return seal(plaintext, key);
    },
    openSecret(ciphertext) {
      const key = requireVaultKey(env);
      return open(ciphertext, key);
    },
  };
}

module.exports = {
  createDbCredentialVault,
  requireVaultKey,
  resolveVaultKeyBytes,
  seal,
  open,
};
