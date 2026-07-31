'use strict';

const net = require('node:net');

const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/;
const SECRET_REFERENCE = /^secret:\/\/[A-Za-z0-9._/-]{1,240}$/;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_BINDING_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const LIVE_ENGINES = new Set(['codex', 'claude', 'grok', 'hermes']);
const SECRET_MANAGERS = new Set([
  'aws-secrets-manager',
  'gcp-secret-manager',
  'azure-key-vault',
  'onepassword-connect',
  'railway-secrets',
]);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'mode',
  'environment',
  'gatewayOrigin',
  'candidate',
  'identity',
  'engine',
]);
const CANDIDATE_KEYS = new Set([
  'deploymentId',
  'commit',
  'environmentId',
  'serviceId',
  'boundAt',
]);
const IDENTITY_KEYS = new Set([
  'provider',
  'liveTenant',
  'injectedAdapter',
  'authoritySource',
]);
const ENGINE_KEYS = new Set(['name', 'authoritySource']);

function reject() {
  throw new Error('staging configuration rejected');
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  return value;
}

function hasExactKeys(value, allowed, required) {
  const keys = Object.keys(plainRecord(value));
  if (
    keys.some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    reject();
  }
}

function exactIsoTime(value) {
  if (typeof value !== 'string' || !value) reject();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) reject();
  return timestamp;
}

function currentTime(clock) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject();
  return now.getTime();
}

function privateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
  );
}

function localHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const labels = normalized.split('.');
  if (
    normalized === 'localhost'
    || labels.includes('localhost')
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.invalid')
    || normalized.endsWith('.test')
  ) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return privateIpv4(normalized);
  if (ipVersion === 6) {
    return (
      normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('::ffff:')
    );
  }
  for (let index = 0; index <= labels.length - 4; index += 1) {
    const possibleIpv4 = labels.slice(index, index + 4).join('.');
    if (net.isIP(possibleIpv4) === 4 && privateIpv4(possibleIpv4)) return true;
  }
  return !normalized.includes('.');
}

function validateGatewayOrigin(value) {
  if (typeof value !== 'string' || value.length > 2_048) reject();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject();
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')
    || localHostname(parsed.hostname)
  ) {
    reject();
  }
}

function validateConfig(config, { clock = () => new Date() } = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(config);
  } catch {
    reject();
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) reject();

  hasExactKeys(config, TOP_LEVEL_KEYS, [...TOP_LEVEL_KEYS]);
  if (
    config.schemaVersion !== 1
    || config.mode !== 'live-staging'
    || config.environment !== 'staging'
  ) {
    reject();
  }
  validateGatewayOrigin(config.gatewayOrigin);

  hasExactKeys(config.candidate, CANDIDATE_KEYS, [...CANDIDATE_KEYS]);
  const deploymentId = String(config.candidate.deploymentId || '').trim();
  const commit = String(config.candidate.commit || '').trim().toLowerCase();
  const environmentId = String(config.candidate.environmentId || '').trim();
  const serviceId = String(config.candidate.serviceId || '').trim();
  if (
    !BOUNDED_IDENTIFIER.test(deploymentId)
    || !FULL_COMMIT_SHA.test(commit)
    || !BOUNDED_IDENTIFIER.test(environmentId)
    || !BOUNDED_IDENTIFIER.test(serviceId)
  ) {
    reject();
  }
  const boundAt = exactIsoTime(config.candidate.boundAt);
  const now = currentTime(clock);
  if (boundAt < now - MAX_BINDING_AGE_MS || boundAt > now + MAX_FUTURE_SKEW_MS) reject();

  hasExactKeys(config.identity, IDENTITY_KEYS, [...IDENTITY_KEYS]);
  if (
    config.identity.provider !== 'workos_authkit'
    || config.identity.liveTenant !== true
    || config.identity.injectedAdapter !== false
    || config.identity.authoritySource !== 'secret-manager'
  ) {
    reject();
  }

  hasExactKeys(config.engine, ENGINE_KEYS, [...ENGINE_KEYS]);
  const engine = String(config.engine.name || '').toLowerCase();
  if (
    !LIVE_ENGINES.has(engine)
    || config.engine.authoritySource !== 'secret-manager'
  ) {
    reject();
  }

  return {
    deploymentId,
    commit,
    environmentId,
    serviceId,
  };
}

function produceStagingCandidateBinding(config, options = {}) {
  return validateConfig(config, options);
}

function validAuthorityReference(value) {
  return typeof value === 'string' && SECRET_REFERENCE.test(value);
}

function missingDeliveryCapabilities(delivery = {}) {
  const missing = [];
  if (
    delivery.source !== 'secret-manager'
    || !SECRET_MANAGERS.has(String(delivery.provider || ''))
  ) {
    missing.push('secret_manager_delivery');
  }
  if (!validAuthorityReference(delivery.workosAuthorityRef)) {
    missing.push('workos_clean_account_authority');
  }
  if (!validAuthorityReference(delivery.engineAuthorityRef)) {
    missing.push('live_engine_authority');
  }
  return missing;
}

function evaluateStagingCleanAccountPreflight(config, {
  clock = () => new Date(),
  delivery = {},
} = {}) {
  const candidateBinding = produceStagingCandidateBinding(config, { clock });
  const missingCapabilities = missingDeliveryCapabilities(delivery);
  const preflightReady = missingCapabilities.length === 0;
  return {
    schemaVersion: 1,
    kind: 'staging_clean_account_preflight',
    ok: false,
    preflightReady,
    journeyVerified: false,
    status: preflightReady ? 'ready_for_live_journey' : 'blocked',
    ...(preflightReady ? {} : { code: 'missing_external_authority' }),
    candidateBinding,
    missingCapabilities,
  };
}

module.exports = {
  MAX_CONFIG_BYTES,
  evaluateStagingCleanAccountPreflight,
  missingDeliveryCapabilities,
  produceStagingCandidateBinding,
};
