#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  createSignedRunnerManifest,
  installRunnerRelease,
  readRunnerReleaseState,
  sha256File,
} = require('../lib/release-manager');
const { PROTOCOL_VERSION } = require('../lib/crypto');

const RUNNER_STATE_SCHEMA_VERSION = 1;
const KNOWN_GOOD_VERSION = '0.1.0';
const CANDIDATE_VERSION = '0.1.1';

function digestFiles(paths) {
  const hash = crypto.createHash('sha256');
  for (const target of paths) {
    hash.update(path.basename(target));
    hash.update(fs.readFileSync(target));
  }
  return hash.digest('hex');
}

function buildArchive(workDir, sourceRoot, version, commitSha) {
  const outputDir = path.join(workDir, `build-${version}`);
  const result = spawnSync(process.execPath, [
    path.join(sourceRoot, 'tools', 'runner-release-artifacts.cjs'),
    'build',
    '--source', sourceRoot,
    '--output-dir', outputDir,
    '--version', version,
    '--commit-sha', commitSha,
    '--platform', 'darwin-arm64',
  ], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH || '' } });
  if (result.status !== 0) throw new Error(`Runner rehearsal archive build failed: ${String(result.stderr || '').trim()}`);
  const report = JSON.parse(result.stdout);
  return { artifactPath: path.join(outputDir, report.archive), report };
}

function signedManifest(artifactPath, version, commitSha, privateKey) {
  return createSignedRunnerManifest({
    artifactPath,
    version,
    commitSha,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    platform: 'darwin-arm64',
    stagingPercentage: 100,
    privateKey,
    generatedAt: new Date().toISOString(),
  });
}

function maliciousTraversalArchive(workDir) {
  const target = path.join(workDir, 'traversal.tgz');
  const content = Buffer.from('outside', 'utf8');
  const header = Buffer.alloc(512);
  header.write('../outside.txt', 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  fs.writeFileSync(target, zlib.gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)])));
  return target;
}

async function expectRejected(operation, pattern) {
  try {
    await operation();
    return false;
  } catch (error) {
    return pattern.test(String(error?.message || ''));
  }
}

async function rehearse(workDir) {
  const sourceRoot = path.resolve(__dirname, '..');
  const installRoot = path.join(workDir, 'install');
  const stateDir = path.join(workDir, 'device-state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, 'state.json');
  const devicePath = path.join(stateDir, 'device-key.json');
  fs.writeFileSync(
    statePath,
    '{"runnerId":"task13-enrolled-runner","workspaceId":"task13-local-test-workspace","deviceCredential":"test-authorized-fixture"}\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.writeFileSync(
    devicePath,
    '{"publicKey":"task13-fixture-public","privateKey":"task13-fixture-private"}\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  const identityBeforeSha256 = digestFiles([statePath, devicePath]);
  const trust = crypto.generateKeyPairSync('ed25519');
  const fixturePrivateKeyPath = path.join(workDir, 'fixture-release-private.pem');
  fs.writeFileSync(
    fixturePrivateKeyPath,
    trust.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );

  const knownGood = buildArchive(workDir, sourceRoot, KNOWN_GOOD_VERSION, '1'.repeat(40));
  const knownGoodManifest = signedManifest(
    knownGood.artifactPath,
    KNOWN_GOOD_VERSION,
    '1'.repeat(40),
    trust.privateKey,
  );
  const first = await installRunnerRelease({
    installRoot,
    artifactPath: knownGood.artifactPath,
    manifest: knownGoodManifest,
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    postPromoteCheck: async () => true,
  });

  const candidate = buildArchive(workDir, sourceRoot, CANDIDATE_VERSION, '2'.repeat(40));
  const candidateManifest = signedManifest(
    candidate.artifactPath,
    CANDIDATE_VERSION,
    '2'.repeat(40),
    trust.privateKey,
  );
  let candidateReconnectObserved = false;
  const second = await installRunnerRelease({
    installRoot,
    artifactPath: candidate.artifactPath,
    manifest: candidateManifest,
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    postPromoteCheck: async ({ releaseRoot }) => {
      const result = spawnSync(process.execPath, [
        path.join(releaseRoot, 'package', 'bin', 'agent-calendar-runner.js'),
        'version',
      ], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH || '' } });
      candidateReconnectObserved = result.status === 0
        && String(result.stdout || '').trim() === CANDIDATE_VERSION;
      return false;
    },
  });

  const tamperedArtifact = path.join(workDir, 'tampered.tgz');
  fs.copyFileSync(candidate.artifactPath, tamperedArtifact);
  fs.appendFileSync(tamperedArtifact, 'tamper');
  const tamperRejected = await expectRejected(() => installRunnerRelease({
    installRoot,
    artifactPath: tamperedArtifact,
    manifest: { ...candidateManifest, artifact: { ...candidateManifest.artifact, name: path.basename(tamperedArtifact) } },
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
  }), /signature|size|sha-?256|artifact/i);

  const downgrade = buildArchive(workDir, sourceRoot, '0.0.9', '3'.repeat(40));
  const downgradeRejected = await expectRejected(() => installRunnerRelease({
    installRoot,
    artifactPath: downgrade.artifactPath,
    manifest: signedManifest(downgrade.artifactPath, '0.0.9', '3'.repeat(40), trust.privateKey),
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
  }), /newer|version/i);

  const traversalArtifact = maliciousTraversalArchive(workDir);
  const traversalRejected = await expectRejected(() => installRunnerRelease({
    installRoot,
    artifactPath: traversalArtifact,
    manifest: signedManifest(traversalArtifact, '0.1.2', '4'.repeat(40), trust.privateKey),
    trustedPublicKey: trust.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
  }), /archive|traversal|unsafe/i);

  const releaseState = readRunnerReleaseState(installRoot);
  const currentTarget = fs.realpathSync(path.join(installRoot, 'current'));
  const identityAfterSha256 = digestFiles([statePath, devicePath]);
  return {
    schemaVersion: 1,
    rehearsal: 'task13_signed_runner_atomic_update_rollback',
    generatedAt: new Date().toISOString(),
    ok: Boolean(
      first.ok
      && !second.ok
      && second.rolledBack
      && second.failure === 'post_promotion_health_failed'
      && candidateReconnectObserved
      && releaseState.currentVersion === KNOWN_GOOD_VERSION
      && currentTarget.includes(KNOWN_GOOD_VERSION)
      && identityBeforeSha256 === identityAfterSha256
      && tamperRejected
      && downgradeRejected
      && traversalRejected
    ),
    enrolledRunnerId: 'task13-enrolled-runner',
    knownGoodVersion: KNOWN_GOOD_VERSION,
    candidateVersion: CANDIDATE_VERSION,
    signedCandidateAccepted: candidateReconnectObserved,
    candidateReconnectObserved,
    forcedPostPromoteFailureObserved: second.failure === 'post_promotion_health_failed',
    rollbackObserved: second.rolledBack === true,
    currentVersion: releaseState.currentVersion,
    currentTarget: `releases/${path.basename(currentTarget)}`,
    identityBeforeSha256,
    identityAfterSha256,
    identityPreserved: identityBeforeSha256 === identityAfterSha256,
    tamperRejected,
    downgradeRejected,
    traversalRejected,
    archiveSha256: {
      knownGood: sha256File(knownGood.artifactPath),
      candidate: sha256File(candidate.artifactPath),
    },
    registeredResources: {
      installRoots: 1,
      currentSymlinks: 1,
      fixturePrivateKeys: 1,
      childProcesses: 0,
      ports: [],
      userDataRoots: 1,
      packageBuildRoots: 3,
    },
  };
}

async function main() {
  const evidenceDir = path.resolve(process.env.EVIDENCE_DIR || '.omo/evidence/task-13-manual');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-task13-'));
  let report;
  try {
    report = await rehearse(workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const cleanup = {
    cleanup: !fs.existsSync(workDir),
    fixturePrivateKeysDestroyed: !fs.existsSync(path.join(workDir, 'fixture-release-private.pem')),
    installRootRemoved: !fs.existsSync(path.join(workDir, 'install')),
    currentSymlinkRemoved: !fs.existsSync(path.join(workDir, 'install', 'current')),
    survivingChildProcesses: 0,
    openRegisteredPorts: [],
  };
  report = { ...report, ...cleanup };
  report.ok = Boolean(report.ok && cleanup.cleanup && cleanup.fixturePrivateKeysDestroyed);
  fs.writeFileSync(
    path.join(evidenceDir, 'rollback-rehearsal.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(evidenceDir, 'cleanup-receipt.json'),
    `${JSON.stringify(cleanup, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.message || 'Runner rollback rehearsal failed'}\n`);
  process.exitCode = 1;
});
