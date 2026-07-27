'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_KEY_ID = /^runner-ed25519-[a-f0-9]{16}$/;
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64']);
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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runnerPublicKeyId(key) {
  const publicKey = key instanceof crypto.KeyObject && key.type === 'public'
    ? key
    : crypto.createPublicKey(key);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `runner-ed25519-${crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

function artifactStat(artifactPath) {
  let stat;
  try {
    stat = fs.statSync(artifactPath);
  } catch {
    throw new Error('Runner release artifact does not exist');
  }
  if (!stat.isFile() || stat.size < 1) {
    throw new Error('Runner release artifact must be a non-empty regular file');
  }
  return stat;
}

function createSignedRunnerManifest({
  artifactPath,
  version,
  commitSha,
  protocolVersion,
  stateSchemaVersion,
  platform,
  stagingPercentage,
  privateKey,
  generatedAt = new Date().toISOString(),
} = {}) {
  const stableVersion = String(version || '').trim();
  const normalizedCommit = String(commitSha || '').trim().toLowerCase();
  const artifact = path.resolve(String(artifactPath || ''));
  const stat = artifactStat(artifact);
  if (!STABLE_SEMVER.test(stableVersion)) {
    throw new Error('Runner releases require a stable semantic version');
  }
  if (!FULL_COMMIT_SHA.test(normalizedCommit)) {
    throw new Error('Runner release requires a full lowercase commit SHA');
  }
  const protocol = Number(protocolVersion);
  const stateSchema = Number(stateSchemaVersion);
  if (!Number.isInteger(protocol) || protocol < 1) {
    throw new Error('Runner release protocol version must be a positive integer');
  }
  if (!Number.isInteger(stateSchema) || stateSchema < 1) {
    throw new Error('Runner release state schema version must be a positive integer');
  }
  const releasePlatform = String(platform || '').trim();
  if (!SUPPORTED_PLATFORMS.has(releasePlatform)) {
    throw new Error('Runner release platform is unsupported');
  }
  const rollout = Number(stagingPercentage);
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) {
    throw new Error('Runner staging percentage must be an integer from 1 through 100');
  }
  if (!privateKey) throw new Error('Runner release signing private key is required');
  const publicKeyId = runnerPublicKeyId(privateKey);

  const manifest = {
    schemaVersion: 1,
    product: 'agent-calendar-runner',
    version: stableVersion,
    channel: 'stable',
    platform: releasePlatform,
    commitSha: normalizedCommit,
    protocolVersion: protocol,
    stateSchemaVersion: stateSchema,
    stagingPercentage: rollout,
    generatedAt: String(generatedAt || ''),
    signatureAlgorithm: 'ed25519',
    publicKeyId,
    artifact: {
      name: path.basename(artifact),
      size: stat.size,
      sha256: sha256File(artifact),
    },
  };
  const signature = crypto.sign(
    null,
    canonicalManifestPayload(manifest),
    privateKey,
  ).toString('base64');
  return { ...manifest, signature };
}

function parseSemver(version) {
  const match = String(version || '').trim().match(STABLE_SEMVER);
  if (!match) throw new Error('Runner version must be stable semantic version');
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

function validateRunnerReleaseManifest({
  manifest = {},
  artifactPath,
  trustedPublicKey,
  trustedPublicKeys,
  installedVersion = '',
  protocolVersion,
  stateSchemaVersion,
  now = () => Date.now(),
  maxManifestAgeMs = DEFAULT_MAX_MANIFEST_AGE_MS,
} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Runner release manifest must be an object');
  }
  if (manifest.schemaVersion !== 1 || manifest.product !== 'agent-calendar-runner') {
    throw new Error('Runner release manifest identity is invalid');
  }
  if (manifest.channel !== 'stable' || !STABLE_SEMVER.test(String(manifest.version || ''))) {
    throw new Error('Runner release version must be stable semantic version');
  }
  if (!SUPPORTED_PLATFORMS.has(String(manifest.platform || ''))) {
    throw new Error('Runner release platform is unsupported');
  }
  if (!FULL_COMMIT_SHA.test(String(manifest.commitSha || ''))) {
    throw new Error('Runner release commit provenance is invalid');
  }
  if (
    manifest.signatureAlgorithm !== 'ed25519'
    || !PUBLIC_KEY_ID.test(String(manifest.publicKeyId || ''))
  ) {
    throw new Error('Runner release requires pinned Ed25519 trust');
  }
  const selectedPublicKey = trustedPublicKeys
    ? trustedPublicKeys[manifest.publicKeyId]
    : trustedPublicKey;
  if (!selectedPublicKey) {
    throw new Error('Runner release signer is unknown to pinned trust');
  }
  if (runnerPublicKeyId(selectedPublicKey) !== manifest.publicKeyId) {
    throw new Error('Runner release public key id does not match pinned trust');
  }
  let signature;
  try {
    signature = Buffer.from(String(manifest.signature || ''), 'base64');
  } catch {
    throw new Error('Runner release signature is invalid');
  }
  const signatureValid = signature.length > 0 && crypto.verify(
    null,
    canonicalManifestPayload(manifest),
    selectedPublicKey,
    signature,
  );
  if (!signatureValid) throw new Error('Runner release signature verification failed');

  const generatedAtMs = Date.parse(String(manifest.generatedAt || ''));
  const currentTime = Number(now());
  const allowedAge = Number(maxManifestAgeMs);
  if (
    !Number.isFinite(generatedAtMs)
    || !Number.isFinite(currentTime)
    || !Number.isFinite(allowedAge)
    || allowedAge < 0
  ) {
    throw new Error('Runner release generated time is invalid');
  }
  if (generatedAtMs > currentTime + MAX_MANIFEST_FUTURE_SKEW_MS) {
    throw new Error('Runner release generated time is in the future');
  }
  if (currentTime - generatedAtMs > allowedAge) {
    throw new Error('Runner release manifest is stale');
  }

  const currentProtocol = Number(protocolVersion);
  const currentStateSchema = Number(stateSchemaVersion);
  if (Number(manifest.protocolVersion) !== currentProtocol) {
    throw new Error('Runner release protocol is incompatible');
  }
  if (Number(manifest.stateSchemaVersion) !== currentStateSchema) {
    throw new Error('Runner release state schema is incompatible');
  }
  const rollout = Number(manifest.stagingPercentage);
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) {
    throw new Error('Runner release staging percentage is invalid');
  }

  const artifact = path.resolve(String(artifactPath || ''));
  const stat = artifactStat(artifact);
  if (manifest.artifact?.name !== path.basename(artifact)) {
    throw new Error('Runner release artifact name does not match manifest');
  }
  if (Number(manifest.artifact?.size) !== stat.size) {
    throw new Error('Runner release artifact size does not match manifest');
  }
  const expectedDigest = String(manifest.artifact?.sha256 || '');
  if (!SHA256.test(expectedDigest) || sha256File(artifact) !== expectedDigest) {
    throw new Error('Runner release artifact SHA-256 does not match manifest');
  }
  if (installedVersion && compareSemver(manifest.version, installedVersion) <= 0) {
    throw new Error('Runner update version must be newer than the installed version');
  }

  return {
    version: manifest.version,
    commitSha: manifest.commitSha,
    protocolVersion: Number(manifest.protocolVersion),
    stateSchemaVersion: Number(manifest.stateSchemaVersion),
    platform: manifest.platform,
    stagingPercentage: rollout,
    publicKeyId: manifest.publicKeyId,
    artifact: {
      name: manifest.artifact.name,
      size: stat.size,
      sha256: expectedDigest,
    },
  };
}

function assertSafeInstallRoot(installRoot) {
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) {
    throw new Error('Runner install root must be a dedicated non-root directory');
  }
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new Error('Runner install root must be a directory');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function listArchiveEntries(artifactPath) {
  const result = spawnSync('tar', ['-tzf', artifactPath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error('Runner release archive cannot be listed');
  const entries = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  if (entries.length < 1) throw new Error('Runner release archive is empty');
  const verbose = spawnSync('tar', ['-tvzf', artifactPath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (verbose.status !== 0) throw new Error('Runner release archive metadata cannot be inspected');
  const types = String(verbose.stdout || '').split(/\r?\n/).filter(Boolean);
  if (types.length !== entries.length || types.some((line) => !['-', 'd'].includes(line[0]))) {
    throw new Error('Runner release archive contains unsupported links or special files');
  }
  const seen = new Set();
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    const segments = normalized.split('/').filter(Boolean);
    if (
      normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized)
      || segments.includes('..')
      || (segments[0] !== 'package')
      || !(
        normalized === 'package'
        || normalized === 'package/'
        || normalized === 'package/package.json'
        || normalized === 'package/bin'
        || normalized === 'package/bin/'
        || normalized.startsWith('package/bin/')
        || normalized === 'package/lib'
        || normalized === 'package/lib/'
        || normalized.startsWith('package/lib/')
      )
      || seen.has(normalized.replace(/\/$/, ''))
    ) {
      throw new Error('Runner release archive contains unsafe traversal path');
    }
    seen.add(normalized.replace(/\/$/, ''));
  }
  return entries;
}

function assertExtractedTreeSafe(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Runner release archive may not contain symbolic links');
      }
      if (stat.isDirectory()) stack.push(fullPath);
    }
  }
}

function extractRunnerArchive(artifactPath, destination) {
  listArchiveEntries(artifactPath);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync('tar', ['-xzf', artifactPath, '-C', destination], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error('Runner release archive extraction failed');
  assertExtractedTreeSafe(destination);
}

function readRunnerReleaseState(installRoot) {
  const statePath = path.join(path.resolve(String(installRoot || '')), 'release-state.json');
  if (!fs.existsSync(statePath)) {
    return {
      schemaVersion: 1,
      currentReleaseId: '',
      currentVersion: '',
      previousReleaseId: '',
      previousVersion: '',
      lastAttempt: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      schemaVersion: 1,
      currentReleaseId: String(parsed.currentReleaseId || ''),
      currentVersion: String(parsed.currentVersion || ''),
      previousReleaseId: String(parsed.previousReleaseId || ''),
      previousVersion: String(parsed.previousVersion || ''),
      lastAttempt: parsed.lastAttempt && typeof parsed.lastAttempt === 'object'
        ? parsed.lastAttempt
        : null,
    };
  } catch {
    throw new Error('Runner release state is invalid');
  }
}

function writeRunnerReleaseState(installRoot, state) {
  const target = path.join(installRoot, 'release-state.json');
  const temporary = path.join(
    installRoot,
    `.release-state-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
}

function switchCurrentPointer(installRoot, releaseId) {
  const current = path.join(installRoot, 'current');
  if (fs.existsSync(current) && !fs.lstatSync(current).isSymbolicLink()) {
    throw new Error('Runner current pointer is not a symbolic link');
  }
  if (!releaseId) {
    if (fs.existsSync(current)) fs.unlinkSync(current);
    return;
  }
  const temporary = path.join(
    installRoot,
    `.current-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.symlinkSync(path.join('releases', releaseId), temporary, 'dir');
  fs.renameSync(temporary, current);
}

function assertRunnerPackage(releaseRoot, version) {
  const packagePath = path.join(releaseRoot, 'package', 'package.json');
  let document;
  try {
    document = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('Runner release package manifest is missing or invalid');
  }
  if (document.name !== 'agent-calendar-runner' || document.version !== version) {
    throw new Error('Runner release package identity or version mismatch');
  }
  const entrypoint = path.join(releaseRoot, 'package', 'bin', 'agent-calendar-runner.js');
  let stat;
  try {
    stat = fs.lstatSync(entrypoint);
  } catch {
    throw new Error('Runner release entrypoint is missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Runner release entrypoint must be a regular file');
  }
  return entrypoint;
}

async function defaultReleaseHealthCheck({ releaseRoot, version }) {
  const entrypoint = assertRunnerPackage(releaseRoot, version);
  const result = spawnSync(process.execPath, [entrypoint, 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH || '',
    },
  });
  return result.status === 0 && String(result.stdout || '').trim() === version;
}

async function installRunnerRelease({
  installRoot,
  artifactPath,
  manifest,
  trustedPublicKey,
  protocolVersion,
  stateSchemaVersion,
  postPromoteCheck = defaultReleaseHealthCheck,
  onStage = () => {},
  now,
  maxManifestAgeMs,
} = {}) {
  const root = assertSafeInstallRoot(installRoot);
  const priorState = readRunnerReleaseState(root);
  const validated = validateRunnerReleaseManifest({
    manifest,
    artifactPath,
    trustedPublicKey,
    installedVersion: priorState.currentVersion,
    protocolVersion,
    stateSchemaVersion,
    now,
    maxManifestAgeMs,
  });
  onStage('verified');
  const releasesDir = path.join(root, 'releases');
  fs.mkdirSync(releasesDir, { recursive: true, mode: 0o700 });
  const releaseId = `${validated.version}-${validated.commitSha.slice(0, 12)}`;
  const finalReleaseRoot = path.join(releasesDir, releaseId);
  if (fs.existsSync(finalReleaseRoot)) {
    throw new Error('Runner release is already installed');
  }
  const stagingRoot = path.join(
    releasesDir,
    `.staging-${releaseId}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    extractRunnerArchive(path.resolve(artifactPath), stagingRoot);
    onStage('extracted');
    assertRunnerPackage(stagingRoot, validated.version);
    const healthyBeforePromotion = await defaultReleaseHealthCheck({
      releaseRoot: stagingRoot,
      version: validated.version,
    });
    if (!healthyBeforePromotion) {
      throw new Error('Runner release failed pre-promotion health check');
    }
    fs.renameSync(stagingRoot, finalReleaseRoot);
    onStage('prepared');
  } catch (error) {
    if (fs.existsSync(stagingRoot)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(finalReleaseRoot)) {
      fs.rmSync(finalReleaseRoot, { recursive: true, force: true });
    }
    throw error;
  }

  switchCurrentPointer(root, releaseId);
  let interrupted = false;
  let healthyAfterPromotion = false;
  try {
    onStage('promoted');
    healthyAfterPromotion = Boolean(await postPromoteCheck({
      installRoot: root,
      releaseRoot: finalReleaseRoot,
      releaseId,
      version: validated.version,
    }));
    onStage('health_checked');
  } catch {
    interrupted = true;
    healthyAfterPromotion = false;
  }

  if (!healthyAfterPromotion) {
    switchCurrentPointer(root, priorState.currentReleaseId);
    const rolledBackState = {
      ...priorState,
      schemaVersion: 1,
      lastAttempt: {
        attemptedReleaseId: releaseId,
        attemptedVersion: validated.version,
        status: 'rolled_back',
      },
    };
    writeRunnerReleaseState(root, rolledBackState);
    return {
      ok: false,
      rolledBack: true,
      attemptedVersion: validated.version,
      currentVersion: priorState.currentVersion,
      failure: interrupted ? 'update_interrupted' : 'post_promotion_health_failed',
    };
  }

  const nextState = {
    schemaVersion: 1,
    currentReleaseId: releaseId,
    currentVersion: validated.version,
    previousReleaseId: priorState.currentReleaseId,
    previousVersion: priorState.currentVersion,
    lastAttempt: {
      attemptedReleaseId: releaseId,
      attemptedVersion: validated.version,
      status: 'promoted',
    },
  };
  writeRunnerReleaseState(root, nextState);
  return {
    ok: true,
    rolledBack: false,
    currentVersion: validated.version,
    previousVersion: priorState.currentVersion,
    releaseId,
  };
}

module.exports = {
  canonicalManifestPayload,
  compareSemver,
  createSignedRunnerManifest,
  installRunnerRelease,
  readRunnerReleaseState,
  sha256File,
  runnerPublicKeyId,
  validateRunnerReleaseManifest,
};
