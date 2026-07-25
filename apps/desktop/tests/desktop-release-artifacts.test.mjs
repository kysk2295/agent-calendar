import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

const temporaryDirectories = [];

async function loadReleaseArtifacts() {
  return import('../tools/desktop-release-artifacts.mjs');
}

function makeReleaseDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-release-'));
  temporaryDirectories.push(directory);
  fs.writeFileSync(path.join(directory, 'Agent-Calendar-0.1.0-arm64.dmg'), 'dmg');
  fs.writeFileSync(path.join(directory, 'Agent-Calendar-0.1.0-arm64.zip'), 'zip');
  fs.writeFileSync(path.join(directory, 'Agent-Calendar-0.1.0-arm64.dmg.blockmap'), 'dmg-map');
  fs.writeFileSync(path.join(directory, 'Agent-Calendar-0.1.0-arm64.zip.blockmap'), 'zip-map');
  fs.writeFileSync(path.join(directory, 'latest-mac.yml'), [
    'version: 0.1.0',
    'files:',
    '  - url: Agent-Calendar-0.1.0-arm64.zip',
    'path: Agent-Calendar-0.1.0-arm64.zip',
    'sha512: fixture',
    'releaseDate: 2026-07-25T00:00:00.000Z',
    '',
  ].join('\n'));
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test('release request rejects version mismatch, prerelease versions, and invalid staging percentage', async () => {
  const { validateReleaseRequest } = await loadReleaseArtifacts();

  assert.throws(
    () => validateReleaseRequest({
      packageVersion: '0.1.0',
      releaseVersion: '0.1.1',
      stagingPercentage: '10',
    }),
    /package version/i,
  );
  assert.throws(
    () => validateReleaseRequest({
      packageVersion: '0.1.0',
      releaseVersion: '0.1.0-beta.1',
      stagingPercentage: '10',
    }),
    /stable semantic version/i,
  );
  for (const stagingPercentage of ['0', '101', '1.5', 'not-a-number']) {
    assert.throws(
      () => validateReleaseRequest({
        packageVersion: '0.1.0',
        releaseVersion: '0.1.0',
        stagingPercentage,
      }),
      /staging percentage/i,
    );
  }
});

test('release finalization verifies artifacts and writes staged metadata plus checksums', async () => {
  const { finalizeDesktopRelease } = await loadReleaseArtifacts();
  const releaseDirectory = makeReleaseDirectory();

  const manifest = finalizeDesktopRelease({
    releaseDirectory,
    packageVersion: '0.1.0',
    releaseVersion: '0.1.0',
    stagingPercentage: '25',
    commitSha: 'a'.repeat(40),
    generatedAt: '2026-07-25T00:00:00.000Z',
  });

  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.stagingPercentage, 25);
  assert.equal(manifest.commitSha, 'a'.repeat(40));
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.name),
    [
      'Agent-Calendar-0.1.0-arm64.dmg',
      'Agent-Calendar-0.1.0-arm64.dmg.blockmap',
      'Agent-Calendar-0.1.0-arm64.zip',
      'Agent-Calendar-0.1.0-arm64.zip.blockmap',
      'latest-mac.yml',
    ],
  );
  assert.ok(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert.match(
    fs.readFileSync(path.join(releaseDirectory, 'latest-mac.yml'), 'utf8'),
    /^stagingPercentage: 25$/m,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(releaseDirectory, 'release-manifest.json'), 'utf8')).version,
    '0.1.0',
  );
  assert.equal(
    fs.readFileSync(path.join(releaseDirectory, 'SHA256SUMS'), 'utf8').trim().split('\n').length,
    5,
  );
});

test('release finalization fails closed when expected update artifacts are missing or mismatched', async () => {
  const { finalizeDesktopRelease } = await loadReleaseArtifacts();
  const releaseDirectory = makeReleaseDirectory();
  fs.rmSync(path.join(releaseDirectory, 'Agent-Calendar-0.1.0-arm64.zip.blockmap'));

  assert.throws(
    () => finalizeDesktopRelease({
      releaseDirectory,
      packageVersion: '0.1.0',
      releaseVersion: '0.1.0',
      stagingPercentage: '100',
      commitSha: 'b'.repeat(40),
    }),
    /missing release artifact/i,
  );

  fs.writeFileSync(path.join(releaseDirectory, 'Agent-Calendar-0.1.0-arm64.zip.blockmap'), 'zip-map');
  fs.writeFileSync(
    path.join(releaseDirectory, 'latest-mac.yml'),
    'version: 0.1.1\npath: Agent-Calendar-0.1.0-arm64.zip\nsha512: fixture\n',
  );
  assert.throws(
    () => finalizeDesktopRelease({
      releaseDirectory,
      packageVersion: '0.1.0',
      releaseVersion: '0.1.0',
      stagingPercentage: '100',
      commitSha: 'b'.repeat(40),
    }),
    /update metadata version/i,
  );
});
