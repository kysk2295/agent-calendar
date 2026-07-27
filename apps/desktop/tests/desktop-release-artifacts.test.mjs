import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  fs.writeFileSync(path.join(directory, 'Agent-Calendar-Widgets-0.1.0-arm64.zip'), 'widget-zip');
  fs.writeFileSync(path.join(directory, 'agent-calendar-sbom.cdx.json'), JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    components: [],
  }));
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

function fixtureEvidence(releaseDirectory, overrides = {}) {
  const digest = (name) => crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(releaseDirectory, name)))
    .digest('hex');
  return {
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    tag: 'v0.1.0',
    version: '0.1.0',
    signed: true,
    notarized: true,
    stapled: true,
    ordinarySecureStorage: {
      backend: 'electron-safe-storage',
      qaOverrideAbsent: true,
      sessionEncrypted: true,
      snapshotEncrypted: true,
      sessionRestored: true,
      snapshotRestored: true,
      rendererKeychainErrors: 0,
      cleanupVerified: true,
    },
    desktop: {
      bundleId: 'com.agents.calendar',
      codesignDeepStrict: true,
      gatekeeperAccepted: true,
      staplerValidated: true,
      authorities: ['Developer ID Application: Agent Calendar (ABCDE12345)'],
      teamIdentifier: 'ABCDE12345',
      appGroups: [],
    },
    widget: {
      hostBundleId: 'com.agents.calendar.widgets.host',
      extensionBundleId: 'com.agents.calendar.widgets.host.HermesWidgets',
      separatelySigned: true,
      packagedInDmg: true,
      fourWidgetsExposed: true,
      appGroupHydrated: true,
      sharedTogglePersisted: true,
      codesignDeepStrict: true,
      gatekeeperAccepted: true,
      staplerValidated: true,
      authorities: ['Developer ID Application: Agent Calendar (ABCDE12345)'],
      teamIdentifier: 'ABCDE12345',
      appGroups: ['group.com.agents.calendar'],
    },
    packagedSmoke: {
      productionRendererBooted: true,
      coldLaunchDeepLink: true,
      runningAppDeepLink: true,
      invalidUrlRejected: true,
      userDataRemoved: true,
    },
    artifactSha256: {
      dmg: digest('Agent-Calendar-0.1.0-arm64.dmg'),
      zip: digest('Agent-Calendar-0.1.0-arm64.zip'),
      widgetArchive: digest('Agent-Calendar-Widgets-0.1.0-arm64.zip'),
    },
    ...overrides,
  };
}

function fixtureUpdaterEvidence(releaseDirectory, overrides = {}) {
  const candidateSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(releaseDirectory, 'Agent-Calendar-0.1.0-arm64.zip')))
    .digest('hex');
  return {
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    tag: 'v0.1.0',
    previousVersion: '0.0.9',
    candidateVersion: '0.1.0',
    candidateSha256,
    controlledFeed: true,
    sha512Verified: true,
    update: {
      startedVersion: '0.0.9',
      offeredVersion: '0.1.0',
      installedVersion: '0.1.0',
      signedCandidateVerified: true,
      userDataPreserved: true,
    },
    rollback: {
      manualOnly: true,
      automaticDowngradeAttempted: false,
      retainedPreviousArtifactVerified: true,
      rollbackRehearsed: true,
      restoredVersion: '0.0.9',
    },
    cleanup: {
      qaApplicationRemoved: true,
      qaUserDataRemoved: true,
    },
    screenshots: [
      { name: 'before-update.png', sha256: 'b'.repeat(64) },
      { name: 'after-update.png', sha256: 'c'.repeat(64) },
      { name: 'rollback.png', sha256: 'd'.repeat(64) },
    ],
    ...overrides,
  };
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

test('publication credential preflight reports missing authority names without reading secret values', async () => {
  const { validatePublicationCredentials } = await loadReleaseArtifacts();
  assert.throws(
    () => validatePublicationCredentials({}),
    /CSC_LINK.*CSC_KEY_PASSWORD.*CSC_NAME.*APPLE_API_KEY_P8.*APPLE_API_KEY_ID.*APPLE_API_ISSUER.*APPLE_TEAM_ID/s,
  );
  assert.deepEqual(validatePublicationCredentials({
    CSC_LINK: 'present',
    CSC_KEY_PASSWORD: 'present',
    CSC_NAME: 'present',
    APPLE_API_KEY_P8: 'present',
    APPLE_API_KEY_ID: 'present',
    APPLE_API_ISSUER: 'present',
    APPLE_TEAM_ID: 'present',
  }), {
    ready: true,
    credentialNames: [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'CSC_NAME',
      'APPLE_API_KEY_P8',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'APPLE_TEAM_ID',
    ],
  });
});

test('release finalization verifies artifacts and writes staged metadata plus checksums', async () => {
  const { finalizeDesktopRelease } = await loadReleaseArtifacts();
  const releaseDirectory = makeReleaseDirectory();
  const verificationEvidence = fixtureEvidence(releaseDirectory);
  const updaterEvidence = fixtureUpdaterEvidence(releaseDirectory);

  const manifest = finalizeDesktopRelease({
    releaseDirectory,
    packageVersion: '0.1.0',
    releaseVersion: '0.1.0',
    stagingPercentage: '25',
    commitSha: 'a'.repeat(40),
    generatedAt: '2026-07-25T00:00:00.000Z',
    verificationEvidence,
    updaterEvidence,
  });

  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.stagingPercentage, 25);
  assert.equal(manifest.commitSha, 'a'.repeat(40));
  assert.equal(manifest.tag, 'v0.1.0');
  assert.equal(manifest.candidateStatus, 'verified');
  assert.equal(manifest.widget.separatelySigned, true);
  assert.equal(manifest.updateProof.previousVersion, '0.0.9');
  assert.equal(manifest.provenance.attestationRequired, true);
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.name),
    [
      'Agent-Calendar-0.1.0-arm64.dmg',
      'Agent-Calendar-0.1.0-arm64.dmg.blockmap',
      'Agent-Calendar-0.1.0-arm64.zip',
      'Agent-Calendar-0.1.0-arm64.zip.blockmap',
      'agent-calendar-sbom.cdx.json',
      'Agent-Calendar-Widgets-0.1.0-arm64.zip',
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
    7,
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

  fs.writeFileSync(path.join(releaseDirectory, 'latest-mac.yml'), [
    'version: 0.1.0',
    'path: Agent-Calendar-0.1.0-arm64.zip',
    'sha512: fixture',
    '',
  ].join('\n'));
  fs.rmSync(path.join(releaseDirectory, 'Agent-Calendar-Widgets-0.1.0-arm64.zip'));
  assert.throws(
    () => finalizeDesktopRelease({
      releaseDirectory,
      packageVersion: '0.1.0',
      releaseVersion: '0.1.0',
      stagingPercentage: '100',
      commitSha: 'b'.repeat(40),
    }),
    /Agent-Calendar-Widgets.*missing|missing release artifact/i,
  );
});

test('release finalization fails closed for unsigned, tampered, missing-widget, not-stapled, and wrong updater SHA evidence', async () => {
  const { finalizeDesktopRelease } = await loadReleaseArtifacts();
  const cases = [
    ['unsigned', (evidence) => ({ ...evidence, signed: false }), /signed/i],
    ['tampered', (evidence) => ({
      ...evidence,
      artifactSha256: { ...evidence.artifactSha256, dmg: '0'.repeat(64) },
    }), /sha-256|checksum/i],
    ['missing widget', (evidence) => ({
      ...evidence,
      widget: { ...evidence.widget, packagedInDmg: false },
    }), /widget/i],
    ['not stapled', (evidence) => ({
      ...evidence,
      widget: { ...evidence.widget, staplerValidated: false },
    }), /stapl/i],
    ['QA secure storage substituted for ordinary storage', (evidence) => ({
      ...evidence,
      ordinarySecureStorage: {
        ...evidence.ordinarySecureStorage,
        backend: 'qa-aes-256-gcm',
      },
    }), /ordinary secure storage|electron-safe-storage/i],
  ];

  for (const [name, mutate, errorPattern] of cases) {
    const releaseDirectory = makeReleaseDirectory();
    assert.throws(
      () => finalizeDesktopRelease({
        releaseDirectory,
        packageVersion: '0.1.0',
        releaseVersion: '0.1.0',
        stagingPercentage: '10',
        commitSha: 'a'.repeat(40),
        verificationEvidence: mutate(fixtureEvidence(releaseDirectory)),
        updaterEvidence: fixtureUpdaterEvidence(releaseDirectory),
      }),
      errorPattern,
      name,
    );
  }

  const releaseDirectory = makeReleaseDirectory();
  assert.throws(
    () => finalizeDesktopRelease({
      releaseDirectory,
      packageVersion: '0.1.0',
      releaseVersion: '0.1.0',
      stagingPercentage: '10',
      commitSha: 'a'.repeat(40),
      verificationEvidence: fixtureEvidence(releaseDirectory),
      updaterEvidence: fixtureUpdaterEvidence(releaseDirectory, {
        candidateSha256: 'f'.repeat(64),
      }),
    }),
    /updater.*sha-256|sha-256.*updater/i,
  );

  assert.throws(
    () => finalizeDesktopRelease({
      releaseDirectory,
      packageVersion: '0.1.0',
      releaseVersion: '0.1.0',
      stagingPercentage: '10',
      commitSha: 'a'.repeat(40),
      verificationEvidence: fixtureEvidence(releaseDirectory),
      updaterEvidence: fixtureUpdaterEvidence(releaseDirectory, {
        update: {
          ...fixtureUpdaterEvidence(releaseDirectory).update,
          signedCandidateVerified: false,
        },
      }),
    }),
    /signature|signed candidate/i,
  );
});
