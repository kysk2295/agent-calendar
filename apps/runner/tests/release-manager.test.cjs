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
const RELEASE_FIXTURE_NOW = () => Date.parse('2026-07-25T00:01:00.000Z');

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

function makeArchive({ version, maliciousPath = '', includeSymlink = false }) {
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
  if (includeSymlink) {
    fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true });
    fs.symlinkSync('../bin/agent-calendar-runner.js', path.join(packageDir, 'lib', 'linked-runner.js'));
  }
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

test('manifest trust is selected by signed public key id and unknown signer fails closed', () => {
  const fixture = signedFixture();
  assert.match(fixture.manifest.publicKeyId, /^runner-ed25519-[a-f0-9]{16}$/);
  const validated = validateRunnerReleaseManifest({
    manifest: fixture.manifest,
    artifactPath: fixture.archivePath,
    trustedPublicKeys: { [fixture.manifest.publicKeyId]: fixture.publicKey },
    installedVersion: '0.9.0',
    protocolVersion: 1,
    stateSchemaVersion: 1,
    now: RELEASE_FIXTURE_NOW,
  });
  assert.equal(validated.publicKeyId, fixture.manifest.publicKeyId);
  assert.throws(
    () => validateRunnerReleaseManifest({
      manifest: fixture.manifest,
      artifactPath: fixture.archivePath,
      trustedPublicKeys: { 'runner-ed25519-0000000000000000': fixture.publicKey },
      installedVersion: '0.9.0',
      protocolVersion: 1,
      stateSchemaVersion: 1,
      now: RELEASE_FIXTURE_NOW,
    }),
    /unknown|trust|key/i,
  );
});

test('manifest rejects stale and future release metadata', () => {
  const fixture = signedFixture();
  const common = {
    manifest: fixture.manifest,
    artifactPath: fixture.archivePath,
    trustedPublicKey: fixture.publicKey,
    installedVersion: '0.9.0',
    protocolVersion: 1,
    stateSchemaVersion: 1,
    maxManifestAgeMs: 60_000,
  };
  assert.throws(
    () => validateRunnerReleaseManifest({
      ...common,
      now: () => Date.parse('2026-07-25T00:02:00.001Z'),
    }),
    /stale|generated/i,
  );
  assert.throws(
    () => validateRunnerReleaseManifest({
      ...common,
      now: () => Date.parse('2026-07-24T23:50:00.000Z'),
    }),
    /future|generated/i,
  );
});

test('signed manifest fixes stable version, checksum, protocol, state, and pinned trust', () => {
  const fixture = signedFixture();
  const validated = validateRunnerReleaseManifest({
    manifest: fixture.manifest,
    artifactPath: fixture.archivePath,
    trustedPublicKey: fixture.publicKey,
    installedVersion: '0.9.0',
    protocolVersion: 1,
    stateSchemaVersion: 1,
    now: RELEASE_FIXTURE_NOW,
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
      now: RELEASE_FIXTURE_NOW,
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
      now: RELEASE_FIXTURE_NOW,
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
    now: RELEASE_FIXTURE_NOW,
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
      now: RELEASE_FIXTURE_NOW,
    }),
    /archive|traversal|unsafe/i,
  );
  assert.equal(fs.existsSync(path.join(installRoot, 'current')), false);
});

test('archive links are rejected before extraction', async () => {
  const archivePath = makeArchive({ version: '1.0.0', includeSymlink: true });
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
      now: RELEASE_FIXTURE_NOW,
    }),
    /archive|link|special/i,
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

test('interruption after pointer promotion rolls back visibly and leaves no staging pointer', async () => {
  const installRoot = makeTempDir('runner-install-');
  const trust = crypto.generateKeyPairSync('ed25519');
  const installVersion = async (version, commit, onStage) => {
    const artifactPath = makeArchive({ version });
    const manifest = createSignedRunnerManifest({
      artifactPath,
      version,
      commitSha: commit.repeat(40),
      protocolVersion: 1,
      stateSchemaVersion: 1,
      platform: 'darwin-arm64',
      stagingPercentage: 10,
      privateKey: trust.privateKey,
      generatedAt: '2026-07-25T00:00:00.000Z',
    });
    return installRunnerRelease({
      installRoot,
      artifactPath,
      manifest,
      trustedPublicKey: trust.publicKey,
      protocolVersion: 1,
      stateSchemaVersion: 1,
      postPromoteCheck: async () => true,
      onStage,
      now: RELEASE_FIXTURE_NOW,
    });
  };
  assert.equal((await installVersion('1.0.0', '1')).ok, true);
  const interrupted = await installVersion('1.1.0', '2', (stage) => {
    if (stage === 'promoted') throw new Error('fixture interruption');
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.rolledBack, true);
  assert.equal(interrupted.failure, 'update_interrupted');
  assert.equal(readRunnerReleaseState(installRoot).currentVersion, '1.0.0');
  assert.match(fs.realpathSync(path.join(installRoot, 'current')), /1\.0\.0/);
  assert.deepEqual(
    fs.readdirSync(installRoot).filter((name) => name.startsWith('.current-')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(installRoot, 'releases')).filter((name) => name.startsWith('.staging-')),
    [],
  );
});

test('interruption at verify, extract, prepare, and health boundaries leaves one whole current release', async () => {
  for (const stage of ['verified', 'extracted', 'prepared', 'health_checked']) {
    const installRoot = makeTempDir(`runner-interruption-${stage}-`);
    const trust = crypto.generateKeyPairSync('ed25519');
    const install = async (version, commit, onStage = () => {}) => {
      const artifactPath = makeArchive({ version });
      return installRunnerRelease({
        installRoot,
        artifactPath,
        manifest: createSignedRunnerManifest({
          artifactPath,
          version,
          commitSha: commit.repeat(40),
          protocolVersion: 1,
          stateSchemaVersion: 1,
          platform: 'darwin-arm64',
          stagingPercentage: 10,
          privateKey: trust.privateKey,
        }),
        trustedPublicKey: trust.publicKey,
        protocolVersion: 1,
        stateSchemaVersion: 1,
        postPromoteCheck: async () => true,
        onStage,
      });
    };
    assert.equal((await install('1.0.0', '1')).ok, true);
    const operation = install('1.1.0', '2', (current) => {
      if (current === stage) throw new Error(`fixture ${stage} interruption`);
    });
    if (['verified', 'extracted', 'prepared'].includes(stage)) {
      await assert.rejects(operation, /fixture/);
    } else {
      const result = await operation;
      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, true);
    }
    assert.equal(readRunnerReleaseState(installRoot).currentVersion, '1.0.0');
    assert.match(fs.realpathSync(path.join(installRoot, 'current')), /1\.0\.0/);
    assert.equal(
      fs.readdirSync(path.join(installRoot, 'releases')).some((name) => name.startsWith('.staging-')),
      false,
    );
  }
});
