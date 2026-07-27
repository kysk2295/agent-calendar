'use strict';

const crypto = require('node:crypto');

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_KEY_ID = /^runner-ed25519-[a-f0-9]{16}$/;
const DEFAULT_MAX_MANIFEST_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_FUTURE_SKEW_MS = 5 * 60 * 1000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function canonicalManifestPayload(manifest = {}) {
  const { signature, ...unsigned } = manifest;
  return Buffer.from(JSON.stringify(stableValue(unsigned)), 'utf8');
}

function canonicalSignedManifest(manifest = {}) {
  return Buffer.from(JSON.stringify(stableValue(manifest)), 'utf8');
}

function runnerPublicKeyId(key) {
  const publicKey = key instanceof crypto.KeyObject && key.type === 'public'
    ? key
    : crypto.createPublicKey(key);
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Runner release trust key must be Ed25519 public key');
  }
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `runner-ed25519-${crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

function parseSemver(value) {
  const match = String(value || '').match(STABLE_SEMVER);
  if (!match) throw new Error('Runner release semantic version is invalid');
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function safeHttpsReleaseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function strictSignature(value) {
  const encoded = String(value || '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) {
    throw new Error('Runner release signature encoding is invalid');
  }
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== encoded) {
    throw new Error('Runner release signature size is invalid');
  }
  return signature;
}

function verifyTrustedRunnerRelease({
  release,
  requestedPlatform,
  trustedPublicKeys,
  minimumVersion = '',
  now = () => Date.now(),
  maxManifestAgeMs = DEFAULT_MAX_MANIFEST_AGE_MS,
} = {}) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Runner release record is invalid');
  }
  const manifest = release.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Runner signed manifest is required');
  }
  if (
    manifest.schemaVersion !== 1
    || manifest.product !== 'agent-calendar-runner'
    || manifest.channel !== 'stable'
    || manifest.signatureAlgorithm !== 'ed25519'
    || !STABLE_SEMVER.test(String(manifest.version || ''))
    || !FULL_COMMIT_SHA.test(String(manifest.commitSha || ''))
    || String(manifest.platform || '') !== String(requestedPlatform || '')
    || !PUBLIC_KEY_ID.test(String(manifest.publicKeyId || ''))
    || !Number.isInteger(manifest.protocolVersion)
    || manifest.protocolVersion < 1
    || !Number.isInteger(manifest.stateSchemaVersion)
    || manifest.stateSchemaVersion < 1
    || !Number.isInteger(manifest.stagingPercentage)
    || manifest.stagingPercentage < 1
    || manifest.stagingPercentage > 100
    || !manifest.artifact
    || typeof manifest.artifact !== 'object'
    || Array.isArray(manifest.artifact)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(manifest.artifact.name || ''))
    || !Number.isSafeInteger(manifest.artifact.size)
    || manifest.artifact.size < 1
    || !SHA256.test(String(manifest.artifact.sha256 || ''))
  ) {
    throw new Error('Runner signed manifest shape is invalid');
  }

  const generatedAt = Date.parse(String(manifest.generatedAt || ''));
  const currentTime = Number(now());
  const maximumAge = Number(maxManifestAgeMs);
  if (
    !Number.isFinite(generatedAt)
    || !Number.isFinite(currentTime)
    || !Number.isFinite(maximumAge)
    || maximumAge < 0
    || new Date(generatedAt).toISOString() !== manifest.generatedAt
    || generatedAt > currentTime + MAX_MANIFEST_FUTURE_SKEW_MS
    || currentTime - generatedAt > maximumAge
  ) {
    throw new Error('Runner signed manifest freshness is invalid');
  }
  if (minimumVersion && compareSemver(manifest.version, minimumVersion) < 0) {
    throw new Error('Runner signed manifest is below the server release floor');
  }

  const key = trustedPublicKeys
    && typeof trustedPublicKeys === 'object'
    && !Array.isArray(trustedPublicKeys)
    ? trustedPublicKeys[manifest.publicKeyId]
    : null;
  if (!key) throw new Error('Runner release signer is not trusted');
  const publicKey = key instanceof crypto.KeyObject ? key : crypto.createPublicKey(key);
  if (runnerPublicKeyId(publicKey) !== manifest.publicKeyId) {
    throw new Error('Runner release signer key id mismatch');
  }
  if (!crypto.verify(
    null,
    canonicalManifestPayload(manifest),
    publicKey,
    strictSignature(manifest.signature),
  )) {
    throw new Error('Runner release signature verification failed');
  }

  const downloadUrl = safeHttpsReleaseUrl(release.downloadUrl);
  const manifestUrl = safeHttpsReleaseUrl(release.manifestUrl);
  if (
    !downloadUrl
    || !manifestUrl
    || new URL(downloadUrl).pathname !== `/${manifest.artifact.name}`
    || new URL(manifestUrl).pathname !== `/${manifest.artifact.name}.manifest.json`
  ) {
    throw new Error('Runner release URLs are invalid');
  }
  const manifestSha256 = crypto
    .createHash('sha256')
    .update(canonicalSignedManifest(manifest))
    .digest('hex');
  return {
    status: 'verified_signed',
    version: manifest.version,
    platform: manifest.platform,
    downloadUrl,
    manifestUrl,
    sha256: manifest.artifact.sha256,
    signature: manifest.signature,
    publicKeyId: manifest.publicKeyId,
    notes: typeof release.notes === 'string'
      && !/ignore previous|system prompt|verified_signed/i.test(release.notes)
      ? release.notes.slice(0, 240)
      : '',
    verification: {
      status: 'verified',
      source: 'backend_ed25519',
      algorithm: 'ed25519',
      manifestSha256,
      artifactSha256: manifest.artifact.sha256,
      publicKeyId: manifest.publicKeyId,
    },
  };
}

function runnerReleaseConfigurationFromEnv(env = {}) {
  const manifestJson = String(env.RUNNER_RELEASE_MANIFEST_JSON || '').trim();
  const trustJson = String(env.RUNNER_RELEASE_TRUSTED_PUBLIC_KEYS_JSON || '').trim();
  const minimumVersion = String(env.RUNNER_RELEASE_MINIMUM_VERSION || '').trim();
  if (!manifestJson && !trustJson && !minimumVersion) {
    return {
      releaseManifest: null,
      trustedPublicKeys: {},
      minimumVersion: '',
    };
  }
  try {
    const releaseManifest = JSON.parse(manifestJson);
    const trustedPublicKeys = JSON.parse(trustJson);
    if (
      !releaseManifest
      || typeof releaseManifest !== 'object'
      || Array.isArray(releaseManifest)
      || !trustedPublicKeys
      || typeof trustedPublicKeys !== 'object'
      || Array.isArray(trustedPublicKeys)
      || Object.keys(trustedPublicKeys).some((key) => (
        !PUBLIC_KEY_ID.test(key)
        || typeof trustedPublicKeys[key] !== 'string'
        || trustedPublicKeys[key].length > 8_192
        || !trustedPublicKeys[key].includes('BEGIN PUBLIC KEY')
        || trustedPublicKeys[key].includes('PRIVATE KEY')
      ))
      || (minimumVersion && !STABLE_SEMVER.test(minimumVersion))
    ) {
      throw new Error('invalid');
    }
    return { releaseManifest, trustedPublicKeys, minimumVersion };
  } catch {
    return {
      releaseManifest: {},
      trustedPublicKeys: {},
      minimumVersion: '',
    };
  }
}

module.exports = {
  canonicalManifestPayload,
  runnerReleaseConfigurationFromEnv,
  verifyTrustedRunnerRelease,
};
