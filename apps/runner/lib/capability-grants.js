'use strict';

const crypto = require('node:crypto');

const CATALOG_ID = 'agent-calendar-runner';
const CATALOG_VERSION = 1;
const CATALOG_ENTRIES = Object.freeze([
  Object.freeze({ id: 'skill:agent.profile', version: 1, kind: 'skill', externalDelivery: false }),
  Object.freeze({ id: 'tool:external.delivery', version: 1, kind: 'tool', externalDelivery: true }),
  Object.freeze({ id: 'tool:workspace.read', version: 1, kind: 'tool', externalDelivery: false }),
]);

function hash(value, length) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);
}

function runnerCapabilityCatalog() {
  const catalog = {
    catalogId: CATALOG_ID,
    version: CATALOG_VERSION,
    entries: CATALOG_ENTRIES.map((entry) => ({ ...entry })),
  };
  return {
    ...catalog,
    revision: `cat_${hash(catalog, 24)}`,
  };
}

function grantError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'base64url');
  const rightBuffer = Buffer.from(String(right || ''), 'base64url');
  return leftBuffer.length > 0
    && leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertAuthorizedLease(lease, runnerState, now = Date.now()) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    throw grantError('LEASE_AUTHORIZATION_REQUIRED', 'authenticated lease is required');
  }
  const authorization = lease.authorization;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw grantError('LEASE_AUTHORIZATION_REQUIRED', 'lease authorization is required');
  }
  if (authorization.schemaVersion !== 1 || authorization.algorithm !== 'hmac-sha256') {
    throw grantError('LEASE_AUTHORIZATION_INVALID', 'lease authorization format is invalid');
  }
  if (String(authorization.runnerId || '') !== String(runnerState?.runnerId || '')) {
    throw grantError('LEASE_RUNNER_MISMATCH', 'lease is not authorized for this Runner');
  }
  if (String(authorization.workspaceId || '') !== String(runnerState?.workspaceId || '')
    || String(lease.workspaceId || '') !== String(runnerState?.workspaceId || '')) {
    throw grantError('LEASE_WORKSPACE_MISMATCH', 'lease is not authorized for this Workspace');
  }
  if (Number(authorization.credentialVersion || 0) !== Number(runnerState?.credentialVersion || 0)) {
    throw grantError('LEASE_CREDENTIAL_VERSION_STALE', 'lease credential version is stale');
  }
  const issuedAt = Date.parse(String(authorization.issuedAt || ''));
  const expiresAt = Date.parse(String(authorization.expiresAt || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || authorization.expiresAt !== lease.leaseExpiresAt
    || issuedAt > now + 120_000
    || expiresAt <= now) {
    throw grantError('LEASE_AUTHORIZATION_STALE', 'lease authorization is stale');
  }
  if (!lease.offerId || !lease.attemptId || !lease.jobId || !lease.leaseEpoch) {
    throw grantError('LEASE_AUTHORIZATION_INVALID', 'lease binding is incomplete');
  }
  const credential = String(runnerState?.deviceCredential || '');
  if (!credential) {
    throw grantError('LEASE_AUTHORIZATION_REQUIRED', 'Runner device credential is unavailable');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(authorization.mac || ''))) {
    throw grantError('LEASE_AUTHORIZATION_INVALID', 'lease authorization MAC is invalid');
  }
  const unsignedLease = { ...lease };
  delete unsignedLease.authorization;
  const unsignedAuthorization = { ...authorization };
  delete unsignedAuthorization.mac;
  const transcript = `lease-authorization-v1\n${stableJson({
    authorization: unsignedAuthorization,
    lease: unsignedLease,
  })}`;
  const key = crypto.createHash('sha256').update(credential, 'utf8').digest();
  const expectedMac = crypto.createHmac('sha256', key).update(transcript, 'utf8').digest('base64url');
  if (!safeEqual(authorization.mac, expectedMac)) {
    throw grantError('LEASE_AUTHORIZATION_INVALID', 'lease authorization is invalid');
  }
  const consumed = Array.isArray(runnerState?.consumedLeaseAuthorizations)
    ? runnerState.consumedLeaseAuthorizations
    : [];
  if (consumed.includes(authorization.mac)) {
    throw grantError('LEASE_AUTHORIZATION_REPLAY', 'lease authorization was already consumed');
  }
  return authorization.mac;
}

function assertEffectiveConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw grantError('EFFECTIVE_CONFIGURATION_REQUIRED', 'effective configuration is required');
  }
  const grants = value.grants && typeof value.grants === 'object' ? value.grants : {};
  const denied = Array.isArray(grants.denied) ? grants.denied : [];
  const approvalRequired = Array.isArray(grants.approvalRequired) ? grants.approvalRequired : [];
  if (value.executable !== true || denied.length || approvalRequired.length) {
    throw grantError('CAPABILITY_GRANT_DENIED', 'effective configuration denies execution');
  }
  const snapshotId = String(value.snapshotId || '');
  const configuration = { ...value };
  delete configuration.snapshotId;
  delete configuration.executable;
  if (snapshotId !== `ecfg_${hash(configuration, 32)}`) {
    throw grantError('EFFECTIVE_CONFIGURATION_INVALID', 'effective configuration identity is invalid');
  }
  const localCatalog = runnerCapabilityCatalog();
  if (value.runner?.catalogId !== localCatalog.catalogId
    || value.runner?.catalogVersion !== localCatalog.version
    || value.runner?.catalogRevision !== localCatalog.revision) {
    throw grantError('RUNNER_CATALOG_STALE', 'effective configuration Runner catalog is stale');
  }
  const allowed = new Set(
    Array.isArray(grants.allowed) ? grants.allowed.map((entry) => String(entry?.id || '')) : [],
  );
  const required = Array.isArray(value.requiredCapabilities) ? value.requiredCapabilities : [];
  if (required.some((id) => !allowed.has(String(id)))) {
    throw grantError('CAPABILITY_GRANT_DENIED', 'required capability is not granted');
  }
  return value;
}

module.exports = {
  assertAuthorizedLease,
  assertEffectiveConfiguration,
  runnerCapabilityCatalog,
  stableJson,
};
