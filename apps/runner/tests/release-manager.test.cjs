'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const {
  createSignedRunnerManifest,
  installRunnerRelease,
  readRunnerReleaseState,
  validateRunnerReleaseManifest,
} = require('../lib/release-manager');

const temporaryDirectories = [];

function makeTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test.afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function makeArchive({ version, maliciousPath = '' }) {
  const root = makeTempDir('runner-release-fixture-');
  const archivePath = path.join(root, `agent-calendar-runner-${version}.tgz`);
  if (maliciousPath) {
    const content = Buffer.from('outside', 'utf8');
    const header = Buffer.alloc(512);
    header.write(maliciousPath, 0, 100, 'utf8');
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
    const contentPadding = Buffer.alloc((512 - (content.length % 512)) % 512);
    const tar = Buffer.concat([header, content, contentPadding, Buffer.alloc(1024)]);
    fs.writeFileSync(archivePath, zlib.gzipSync(tar));
    return archivePath;
  }
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify({
      name: 'agent-calendar-runner',
      version,
      bin: { 'agent-calendar-runner': './bin/agent-calendar-runner.js' },
    }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(packageDir, 'bin/agent-calendar-runner.js'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${version}\n`)});\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  const args = ['-czf', archivePath, '-C', root, 'package'];
  const tar = spawnSync('tar', args, { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archivePath;
}

function signedFixture({ version = '1.0.0', archivePath = makeArchive({ version }) } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = createSignedRunnerManifest({
    artifactPath: archivePath,
    version,
    commitSha: 'a'.repeat(40),
    protocolVersion: 1,
    stateSchemaVersion: 1,
    platform: 'darwin-arm64',
    stagingPercentage: 10,
    privateKey,
    generatedAt: '2026-07-25T00:00:00.000Z',
  });
  return { archivePath, manifest, publicKey, privateKey };
}

test('signed manifest fixes stable version, checksum, protocol, state, and pinned trust', () => {
  const fixture = signedFixture();
  const validated = validateRunnerReleaseManifest({
    manifest: fixture.manifest,
    artifactPath: fixture.archivePath,
    trustedPublicKey: fixture.publicKey,
    installedVersion: '0.9.0',
    protocolVersion: 1,
    stateSchemaVersion: 1,
  });
  assert.equal(validated.version, '1.0.0');
  assert.equal(validated.artifact.sha256.length, 64);

  const tampered = { ...fixture.manifest, commitSha: 'b'.repeat(40) };
  assert.throws(
    () => validateRunnerReleaseManifest({
      manifest: tampered,
      artifactPath: fixture.archivePath,
      trustedPublicKey: fixture.publicKey,
      installedVersion: '0.9.0',
      protocolVersion: 1,
      stateSchemaVersion: 1,
    }),
    /signature/i,
  );
  fs.appendFileSync(fixture.archivePath, 'tamper');
  assert.throws(
    () => validateRunnerReleaseManifest({
      manifest: fixture.manifest,
      artifactPath: fixture.archivePath,
      trustedPublicKey: fixture.publicKey,
      installedVersion: '0.9.0',
      protocolVersion: 1,
      stateSchemaVersion: 1,
    }),
    /size|sha-?256|artifact/i,
  );
});

test('manifest rejects downgrade and incompatible protocol or state schema', () => {
  const fixture = signedFixture({ version: '1.0.0' });
  const common = {
    manifest: fixture.manifest,
    artifactPath: fixture.archivePath,
    trustedPublicKey: fixture.publicKey,
  };
  assert.throws(
    () => validateRunnerReleaseManifest({
      ...common,
      installedVersion: '1.0.0',
      protocolVersion: 1,
      stateSchemaVersion: 1,
    }),
    /newer|version/i,
  );
  assert.throws(
    () => validateRunnerReleaseManifest({
      ...common,
      installedVersion: '0.9.0',
      protocolVersion: 2,
      stateSchemaVersion: 1,
    }),
    /protocol/i,
  );
  assert.throws(
    () => validateRunnerReleaseManifest({
      ...common,
      installedVersion: '0.9.0',
      protocolVersion: 1,
      stateSchemaVersion: 2,
    }),
    /state schema/i,
  );
});

test('archive traversal is rejected before extraction', async () => {
  const archivePath = makeArchive({ version: '1.0.0', maliciousPath: '../outside.txt' });
  const fixture = signedFixture({ version: '1.0.0', archivePath });
  const installRoot = makeTempDir('runner-install-');
  await assert.rejects(
    () => installRunnerRelease({
      installRoot,
      artifactPath: archivePath,
      manifest: fixture.manifest,
      trustedPublicKey: fixture.publicKey,
      protocolVersion: 1,
      stateSchemaVersion: 1,
    }),
    /archive|traversal|unsafe/i,
  );
  assert.equal(fs.existsSync(path.join(installRoot, 'current')), false);
});

test('failed promoted release restores known-good pointer and preserves Runner device state', async () => {
  const installRoot = makeTempDir('runner-install-');
  const stateDir = makeTempDir('runner-state-');
  const statePath = path.join(stateDir, 'state.json');
  const devicePath = path.join(stateDir, 'device-key.json');
  fs.writeFileSync(
    statePath,
    '{"runnerId":"runner-a","workspaceId":"workspace-a","deviceCredential":"fixture"}\n',
    'utf8',
  );
  fs.writeFileSync(devicePath, '{"publicKey":"fixture-public","privateKey":"fixture-private"}\n', 'utf8');
  const beforeState = fs.readFileSync(statePath);
  const beforeDevice = fs.readFileSync(devicePath);

  const trust = crypto.generateKeyPairSync('ed25519');
  const releaseOnePath = makeArchive({ version: '1.0.0' });
  const releaseOne = createSignedRunnerManifest({
    artifactPath: releaseOnePath,
    version: '1.0.0',
    commitSha: '1'.repeat(40),
    protocolVersion: 1,
    stateSchemaVersion: 1,
    platform: 'darwin-arm64',
    stagingPercentage: 10,
    privateKey: trust.privateKey,
  });
  const first = await installRunnerRelease({
    installRoot,
    artifactPath: releaseOnePath,
    manifest: releaseOne,
    trustedPublicKey: trust.publicKey,
    protocolVersion: 1,
    stateSchemaVersion: 1,
    postPromoteCheck: async () => true,
  });
  assert.equal(first.ok, true);
  assert.equal(first.currentVersion, '1.0.0');

  const releaseTwoPath = makeArchive({ version: '1.1.0' });
  const releaseTwo = createSignedRunnerManifest({
    artifactPath: releaseTwoPath,
    version: '1.1.0',
    commitSha: '2'.repeat(40),
    protocolVersion: 1,
    stateSchemaVersion: 1,
    platform: 'darwin-arm64',
    stagingPercentage: 10,
    privateKey: trust.privateKey,
  });
  const second = await installRunnerRelease({
    installRoot,
    artifactPath: releaseTwoPath,
    manifest: releaseTwo,
    trustedPublicKey: trust.publicKey,
    protocolVersion: 1,
    stateSchemaVersion: 1,
    postPromoteCheck: async () => false,
  });
  assert.equal(second.ok, false);
  assert.equal(second.rolledBack, true);
  assert.equal(second.attemptedVersion, '1.1.0');
  assert.equal(second.currentVersion, '1.0.0');
  assert.doesNotMatch(JSON.stringify(second), new RegExp(installRoot));

  const releaseState = readRunnerReleaseState(installRoot);
  assert.equal(releaseState.currentVersion, '1.0.0');
  assert.equal(releaseState.lastAttempt.status, 'rolled_back');
  assert.deepEqual(fs.readFileSync(statePath), beforeState);
  assert.deepEqual(fs.readFileSync(devicePath), beforeDevice);

  const currentPath = fs.realpathSync(path.join(installRoot, 'current'));
  assert.match(currentPath, /1\.0\.0/);
  assert.equal(
    fs.existsSync(path.join(currentPath, 'package/bin/agent-calendar-runner.js')),
    true,
  );
});
