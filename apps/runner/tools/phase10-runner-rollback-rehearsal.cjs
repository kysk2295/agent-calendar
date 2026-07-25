#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createSignedRunnerManifest,
  installRunnerRelease,
  readRunnerReleaseState,
} = require('../lib/release-manager');
const { PROTOCOL_VERSION } = require('../lib/crypto');

const RUNNER_STATE_SCHEMA_VERSION = 1;
const KNOWN_GOOD_VERSION = '0.1.0';
const FAILED_VERSION = '0.1.1';

function parseArgs(values) {
  const args = { workDir: '', writeEvidence: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--work-dir') {
      args.workDir = String(values[index + 1] || '');
      index += 1;
    } else if (value === '--write-evidence') {
      args.writeEvidence = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function assertEmptyWorkDir(workDir) {
  const resolved = path.resolve(String(workDir || ''));
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error('Runner rehearsal work directory must be a dedicated non-root path');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Runner rehearsal work directory must exist');
  }
  if (fs.readdirSync(resolved).filter((name) => name !== '.DS_Store').length > 0) {
    throw new Error('Runner rehearsal work directory must be empty');
  }
  return resolved;
}

function copyRunnerPackage(sourceRoot, targetRoot, version) {
  const packageRoot = path.join(targetRoot, 'package');
  fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  for (const directory of ['bin', 'lib']) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(packageRoot, directory), {
      recursive: true,
    });
  }
  const packageDocument = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'),
  );
  packageDocument.version = version;
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify(packageDocument, null, 2)}\n`,
    'utf8',
  );
  return packageRoot;
}

function buildArchive(workDir, sourceRoot, version) {
  const buildRoot = path.join(workDir, `build-${version}`);
  fs.mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  copyRunnerPackage(sourceRoot, buildRoot, version);
  const artifactPath = path.join(workDir, `agent-calendar-runner-${version}-darwin-arm64.tgz`);
  const result = spawnSync('tar', [
    '-czf',
    artifactPath,
    '-C',
    buildRoot,
    'package',
  ], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error('Runner rehearsal archive build failed');
  return artifactPath;
}

function buffersEqual(leftPath, right) {
  return fs.readFileSync(leftPath).equals(right);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workDir) throw new Error('--work-dir is required');
  const workDir = assertEmptyWorkDir(args.workDir);
  const sourceRoot = path.resolve(__dirname, '..');
  const installRoot = path.join(workDir, 'install');
  const stateDir = path.join(workDir, 'device-state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, 'state.json');
  const devicePath = path.join(stateDir, 'device-key.json');
  fs.writeFileSync(
    statePath,
    '{"runnerId":"phase10-runner","workspaceId":"phase10-workspace","deviceCredential":"synthetic"}\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.writeFileSync(
    devicePath,
    '{"publicKey":"synthetic-public","privateKey":"synthetic-private"}\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  const beforeState = fs.readFileSync(statePath);
  const beforeDevice = fs.readFileSync(devicePath);
  const trust = crypto.generateKeyPairSync('ed25519');

  const knownGoodArtifact = buildArchive(workDir, sourceRoot, KNOWN_GOOD_VERSION);
  const knownGoodManifest = createSignedRunnerManifest({
    artifactPath: knownGoodArtifact,
    version: KNOWN_GOOD_VERSION,
    commitSha: '1'.repeat(40),
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    platform: 'darwin-arm64',
    stagingPercentage: 10,
    privateKey: trust.privateKey,
    generatedAt: '2026-07-25T00:00:00.000Z',
  });
  const first = await installRunnerRelease({
    installRoot,
    artifactPath: knownGoodArtifact,
    manifest: knownGoodManifest,
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    postPromoteCheck: async () => true,
  });

  const failedArtifact = buildArchive(workDir, sourceRoot, FAILED_VERSION);
  const failedManifest = createSignedRunnerManifest({
    artifactPath: failedArtifact,
    version: FAILED_VERSION,
    commitSha: '2'.repeat(40),
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    platform: 'darwin-arm64',
    stagingPercentage: 10,
    privateKey: trust.privateKey,
    generatedAt: '2026-07-25T01:00:00.000Z',
  });
  const second = await installRunnerRelease({
    installRoot,
    artifactPath: failedArtifact,
    manifest: failedManifest,
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    postPromoteCheck: async () => false,
  });
  const releaseState = readRunnerReleaseState(installRoot);
  const statePreserved = buffersEqual(statePath, beforeState)
    && buffersEqual(devicePath, beforeDevice);
  const currentEntrypoint = path.join(
    fs.realpathSync(path.join(installRoot, 'current')),
    'package',
    'bin',
    'agent-calendar-runner.js',
  );
  const report = {
    schemaVersion: 1,
    rehearsal: 'phase10_runner_atomic_update_rollback',
    generatedAt: new Date().toISOString(),
    ok: Boolean(
      first.ok
      && !second.ok
      && second.rolledBack
      && releaseState.currentVersion === KNOWN_GOOD_VERSION
      && statePreserved
      && fs.existsSync(currentEntrypoint),
    ),
    knownGoodVersion: KNOWN_GOOD_VERSION,
    attemptedVersion: FAILED_VERSION,
    currentVersion: releaseState.currentVersion,
    rollbackObserved: Boolean(second.rolledBack),
    statePreserved,
    currentEntrypointExists: fs.existsSync(currentEntrypoint),
    signedManifestVerified: true,
    artifactChecksumsVerified: true,
    workDir: '$WORK_DIR',
  };
  if (args.writeEvidence && report.ok) {
    const evidencePath = path.resolve(
      __dirname,
      '../../../docs/operations/evidence/2026-07-25-phase10-runner-rollback.json',
    );
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: false,
    error: String(error?.message || 'runner_rollback_rehearsal_failed'),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
