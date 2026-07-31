'use strict';

const crypto = require('node:crypto');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createLeaseAuthorization(lease, runner, issuedAt) {
  const integrityKey = String(runner?.lease_integrity_key || '');
  if (!/^[a-f0-9]{64}$/i.test(integrityKey)) {
    const error = new Error('Runner lease integrity key is unavailable');
    error.code = 'LEASE_AUTHORIZATION_UNAVAILABLE';
    error.statusHint = 503;
    throw error;
  }
  const authorization = {
    schemaVersion: 1,
    algorithm: 'hmac-sha256',
    runnerId: String(runner.id || ''),
    workspaceId: String(runner.workspace_id || ''),
    credentialVersion: Number(runner.credential_version || 0),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: String(lease.leaseExpiresAt || ''),
  };
  const transcript = `lease-authorization-v1\n${stableJson({ authorization, lease })}`;
  return {
    ...authorization,
    mac: crypto
      .createHmac('sha256', Buffer.from(integrityKey, 'hex'))
      .update(transcript, 'utf8')
      .digest('base64url'),
  };
}

module.exports = {
  createLeaseAuthorization,
  stableJson,
};
