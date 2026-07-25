'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AUTH_BYTES = 128 * 1024;

function providerIdentityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readCodexAccountIdentity(home) {
  const canonicalHome = fs.realpathSync(path.resolve(String(home || '')));
  const authPath = path.join(canonicalHome, 'auth.json');
  const stat = fs.lstatSync(authPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_AUTH_BYTES) {
    throw providerIdentityError(
      'PROVIDER_IDENTITY_UNVERIFIABLE',
      'Codex provider identity could not be verified',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const accountId = typeof parsed?.tokens?.account_id === 'string'
    ? parsed.tokens.account_id.trim()
    : typeof parsed?.account_id === 'string'
      ? parsed.account_id.trim()
      : '';
  if (!accountId || accountId.length > 512) {
    throw providerIdentityError(
      'PROVIDER_IDENTITY_UNVERIFIABLE',
      'Codex provider identity could not be verified',
    );
  }
  return {
    canonicalHome,
    canonicalAuthPath: fs.realpathSync(authPath),
    digest: crypto.createHash('sha256')
      .update('agent-calendar/codex-account/v1\0', 'utf8')
      .update(accountId, 'utf8')
      .digest(),
  };
}

function assertDistinctCodexProviderIdentities(homeA, homeB) {
  let identityA;
  let identityB;
  try {
    identityA = readCodexAccountIdentity(homeA);
    identityB = readCodexAccountIdentity(homeB);
  } catch (error) {
    if (error?.code === 'PROVIDER_IDENTITY_UNVERIFIABLE') throw error;
    throw providerIdentityError(
      'PROVIDER_IDENTITY_UNVERIFIABLE',
      'Codex provider identity could not be verified',
    );
  }
  if (
    identityA.canonicalHome === identityB.canonicalHome
    || identityA.canonicalAuthPath === identityB.canonicalAuthPath
  ) {
    throw providerIdentityError(
      'PROVIDER_HOMES_NOT_DISTINCT',
      'Codex provider homes are not independent',
    );
  }
  if (crypto.timingSafeEqual(identityA.digest, identityB.digest)) {
    throw providerIdentityError(
      'PROVIDER_IDENTITIES_NOT_DISTINCT',
      'Codex provider accounts are not independent',
    );
  }
  return {
    ok: true,
    provider: 'codex',
    distinctHomes: true,
    distinctIdentities: true,
  };
}

module.exports = {
  assertDistinctCodexProviderIdentities,
};
