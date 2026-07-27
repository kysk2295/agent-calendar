import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const PUBLICATION_CREDENTIAL_NAMES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_API_KEY_P8',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_TEAM_ID',
];

function stagingPercentageValue(value) {
  const text = String(value).trim();
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('Staging percentage must be an integer from 1 through 100.');
  }
  return parsed;
}

export function validateReleaseRequest({
  packageVersion,
  releaseVersion,
  stagingPercentage,
}) {
  const normalizedPackageVersion = String(packageVersion).trim();
  const normalizedReleaseVersion = String(releaseVersion).trim();
  if (!STABLE_SEMVER.test(normalizedPackageVersion) || !STABLE_SEMVER.test(normalizedReleaseVersion)) {
    throw new Error('Desktop releases require a stable semantic version such as 1.2.3.');
  }
  if (normalizedPackageVersion !== normalizedReleaseVersion) {
    throw new Error(
      `Release version ${normalizedReleaseVersion} does not match package version ${normalizedPackageVersion}.`,
    );
  }
  return {
    version: normalizedReleaseVersion,
    stagingPercentage: stagingPercentageValue(stagingPercentage),
  };
}

export function validatePublicationCredentials(environment) {
  const missing = PUBLICATION_CREDENTIAL_NAMES.filter((name) => (
    typeof environment?.[name] !== 'string' || environment[name].length === 0
  ));
  if (missing.length) {
    throw new Error(`Missing release credentials: ${missing.join(', ')}`);
  }
  return {
    ready: true,
    credentialNames: [...PUBLICATION_CREDENTIAL_NAMES],
  };
}

function expectedArtifactNames(version) {
  const baseName = `Agent-Calendar-${version}-arm64`;
  return [
    `${baseName}.dmg`,
    `${baseName}.dmg.blockmap`,
    `${baseName}.zip`,
    `${baseName}.zip.blockmap`,
    `Agent-Calendar-Widgets-${version}-arm64.zip`,
    'agent-calendar-sbom.cdx.json',
    'latest-mac.yml',
  ].sort((left, right) => left.localeCompare(right, 'en'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertRegularFile(filePath, name) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Missing release artifact: ${name}`);
  }
  if (!stat.isFile() || stat.size < 1) {
    throw new Error(`Missing release artifact: ${name}`);
  }
  return stat;
}

function stageUpdateMetadata(metadataPath, version, stagingPercentage) {
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  const versionMatch = metadata.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  if (!versionMatch || versionMatch[1] !== version) {
    throw new Error('Update metadata version does not match the requested release.');
  }
  if (!metadata.includes(`Agent-Calendar-${version}-arm64.zip`)) {
    throw new Error('Update metadata does not reference the expected arm64 ZIP.');
  }
  if (!/^sha512:\s*\S+/m.test(metadata)) {
    throw new Error('Update metadata is missing its SHA-512 integrity value.');
  }
  const stagingLine = `stagingPercentage: ${stagingPercentage}`;
  const stagedMetadata = /^stagingPercentage:/m.test(metadata)
    ? metadata.replace(/^stagingPercentage:.*$/m, stagingLine)
    : `${metadata.trimEnd()}\n${stagingLine}\n`;
  fs.writeFileSync(metadataPath, stagedMetadata, { encoding: 'utf8', mode: 0o644 });
}

function requireTrue(value, message) {
  if (value !== true) throw new Error(message);
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

function requireStringArray(value, message) {
  if (!Array.isArray(value) || value.length < 1 || value.some((entry) => (
    typeof entry !== 'string' || !entry.trim()
  ))) {
    throw new Error(message);
  }
}

function assertSha256(value, message) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new Error(message);
}

function compareStableVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function validateCandidateEvidence({
  evidence,
  updaterEvidence,
  releaseDirectory,
  version,
  commitSha,
}) {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('Signed candidate verification evidence is required.');
  }
  requireEqual(evidence.schemaVersion, 1, 'Unsupported candidate verification evidence schema.');
  requireEqual(evidence.sourceSha, commitSha, 'Candidate evidence source SHA does not match.');
  requireEqual(evidence.tag, `v${version}`, 'Candidate evidence tag does not match.');
  requireEqual(evidence.version, version, 'Candidate evidence version does not match.');
  requireTrue(evidence.signed, 'Candidate must be signed.');
  requireTrue(evidence.notarized, 'Candidate must be notarized.');
  requireTrue(evidence.stapled, 'Candidate must be stapled.');

  const ordinarySecureStorage = evidence.ordinarySecureStorage || {};
  requireEqual(
    ordinarySecureStorage.backend,
    'electron-safe-storage',
    'Ordinary secure storage must use electron-safe-storage.',
  );
  requireTrue(
    ordinarySecureStorage.qaOverrideAbsent,
    'Ordinary secure storage evidence must exclude QA overrides.',
  );
  requireTrue(ordinarySecureStorage.sessionEncrypted, 'Ordinary session encryption evidence is required.');
  requireTrue(ordinarySecureStorage.snapshotEncrypted, 'Ordinary snapshot encryption evidence is required.');
  requireTrue(ordinarySecureStorage.sessionRestored, 'Ordinary session restore evidence is required.');
  requireTrue(ordinarySecureStorage.snapshotRestored, 'Ordinary snapshot restore evidence is required.');
  requireEqual(
    ordinarySecureStorage.rendererKeychainErrors,
    0,
    'Ordinary secure storage must have zero renderer Keychain errors.',
  );
  requireTrue(ordinarySecureStorage.cleanupVerified, 'Ordinary secure storage cleanup is required.');

  const expectedAppGroup = 'group.com.agents.calendar';
  const desktop = evidence.desktop || {};
  requireEqual(desktop.bundleId, 'com.agents.calendar', 'Desktop bundle identifier is invalid.');
  requireTrue(desktop.codesignDeepStrict, 'Desktop codesign deep strict verification is required.');
  requireTrue(desktop.gatekeeperAccepted, 'Desktop Gatekeeper assessment must be accepted.');
  requireTrue(desktop.staplerValidated, 'Desktop stapler validation is required.');
  requireStringArray(desktop.authorities, 'Desktop signing authority inspection is required.');
  if (!String(desktop.teamIdentifier || '').trim()) {
    throw new Error('Desktop TeamIdentifier inspection is required.');
  }
  if (!Array.isArray(desktop.appGroups)) throw new Error('Desktop entitlement inspection is required.');

  const widget = evidence.widget || {};
  requireEqual(
    widget.hostBundleId,
    'com.agents.calendar.widgets.host',
    'Widget host bundle identifier is invalid.',
  );
  requireEqual(
    widget.extensionBundleId,
    'com.agents.calendar.widgets.host.HermesWidgets',
    'Widget extension bundle identifier is invalid.',
  );
  requireTrue(widget.separatelySigned, 'Widget companion must be separately signed.');
  requireTrue(widget.packagedInDmg, 'Widget companion is missing from the Desktop DMG.');
  requireTrue(widget.fourWidgetsExposed, 'Widget companion must expose four widgets.');
  requireTrue(widget.appGroupHydrated, 'Widget app-group hydration evidence is required.');
  requireTrue(widget.sharedTogglePersisted, 'Widget shared toggle evidence is required.');
  requireTrue(widget.codesignDeepStrict, 'Widget codesign deep strict verification is required.');
  requireTrue(widget.gatekeeperAccepted, 'Widget Gatekeeper assessment must be accepted.');
  requireTrue(widget.staplerValidated, 'Widget stapler validation is required.');
  requireStringArray(widget.authorities, 'Widget signing authority inspection is required.');
  if (!String(widget.teamIdentifier || '').trim()) {
    throw new Error('Widget TeamIdentifier inspection is required.');
  }
  if (!Array.isArray(widget.appGroups) || !widget.appGroups.includes(expectedAppGroup)) {
    throw new Error('Widget app-group entitlement is missing.');
  }
  if (
    widget.teamIdentifier !== desktop.teamIdentifier
    || widget.authorities.join('\n') !== desktop.authorities.join('\n')
  ) {
    throw new Error('Desktop and widget signing authorities must use the same trusted team.');
  }

  const smoke = evidence.packagedSmoke || {};
  requireTrue(smoke.productionRendererBooted, 'Packaged production renderer smoke is required.');
  requireTrue(smoke.coldLaunchDeepLink, 'Packaged cold-launch deep-link smoke is required.');
  requireTrue(smoke.runningAppDeepLink, 'Packaged running-app deep-link smoke is required.');
  requireTrue(smoke.invalidUrlRejected, 'Packaged invalid deep-link rejection is required.');
  requireTrue(smoke.userDataRemoved, 'Packaged smoke user-data cleanup is required.');

  const names = {
    dmg: `Agent-Calendar-${version}-arm64.dmg`,
    zip: `Agent-Calendar-${version}-arm64.zip`,
    widgetArchive: `Agent-Calendar-Widgets-${version}-arm64.zip`,
  };
  for (const [key, name] of Object.entries(names)) {
    const expectedSha = sha256(path.join(releaseDirectory, name));
    const recordedSha = evidence.artifactSha256?.[key];
    assertSha256(recordedSha, `Candidate ${key} SHA-256 is invalid.`);
    if (recordedSha !== expectedSha) {
      throw new Error(`Candidate ${key} SHA-256 checksum does not match release bytes.`);
    }
  }

  if (!updaterEvidence || typeof updaterEvidence !== 'object') {
    throw new Error('Controlled updater evidence is required.');
  }
  requireEqual(updaterEvidence.schemaVersion, 1, 'Unsupported updater evidence schema.');
  requireEqual(updaterEvidence.sourceSha, commitSha, 'Updater evidence source SHA does not match.');
  requireEqual(updaterEvidence.tag, `v${version}`, 'Updater evidence tag does not match.');
  requireEqual(updaterEvidence.candidateVersion, version, 'Updater candidate version does not match.');
  if (
    !STABLE_SEMVER.test(String(updaterEvidence.previousVersion || ''))
    || compareStableVersions(updaterEvidence.previousVersion, version) >= 0
  ) {
    throw new Error('Updater evidence must prove an N-1 to N version transition.');
  }
  assertSha256(updaterEvidence.candidateSha256, 'Updater candidate SHA-256 is invalid.');
  if (updaterEvidence.candidateSha256 !== evidence.artifactSha256.zip) {
    throw new Error('Updater candidate SHA-256 does not match the verified ZIP.');
  }
  requireTrue(updaterEvidence.controlledFeed, 'Updater evidence must use a controlled feed.');
  requireTrue(updaterEvidence.sha512Verified, 'Updater feed SHA-512 must be verified.');
  requireEqual(
    updaterEvidence.update?.startedVersion,
    updaterEvidence.previousVersion,
    'Updater start version does not match N-1.',
  );
  requireEqual(
    updaterEvidence.update?.offeredVersion,
    version,
    'Updater offered version does not match N.',
  );
  requireEqual(
    updaterEvidence.update?.installedVersion,
    version,
    'Updater installed version does not match N.',
  );
  requireTrue(updaterEvidence.update?.signedCandidateVerified, 'Updated app signature was not verified.');
  requireTrue(updaterEvidence.update?.userDataPreserved, 'Updater did not preserve user data.');
  requireTrue(updaterEvidence.rollback?.manualOnly, 'Rollback must remain a manual operation.');
  requireEqual(
    updaterEvidence.rollback?.automaticDowngradeAttempted,
    false,
    'Automatic downgrade must not be attempted.',
  );
  requireTrue(
    updaterEvidence.rollback?.retainedPreviousArtifactVerified,
    'Retained N-1 rollback artifact was not verified.',
  );
  requireTrue(updaterEvidence.rollback?.rollbackRehearsed, 'Manual rollback rehearsal is required.');
  requireEqual(
    updaterEvidence.rollback?.restoredVersion,
    updaterEvidence.previousVersion,
    'Rollback did not restore N-1.',
  );
  requireTrue(updaterEvidence.cleanup?.qaApplicationRemoved, 'Updater QA application cleanup is required.');
  requireTrue(updaterEvidence.cleanup?.qaUserDataRemoved, 'Updater QA user-data cleanup is required.');
  if (!Array.isArray(updaterEvidence.screenshots) || updaterEvidence.screenshots.length < 3) {
    throw new Error('Updater and rollback screenshots are required.');
  }
  for (const screenshot of updaterEvidence.screenshots) {
    if (!String(screenshot?.name || '').trim()) throw new Error('Updater screenshot name is required.');
    assertSha256(screenshot?.sha256, 'Updater screenshot SHA-256 is invalid.');
  }
  return { desktop, widget, smoke, updaterEvidence, ordinarySecureStorage };
}

export function finalizeDesktopRelease({
  releaseDirectory,
  packageVersion,
  releaseVersion,
  stagingPercentage,
  commitSha,
  verificationEvidence,
  updaterEvidence,
  generatedAt = new Date().toISOString(),
}) {
  const request = validateReleaseRequest({
    packageVersion,
    releaseVersion,
    stagingPercentage,
  });
  const normalizedCommitSha = String(commitSha).trim().toLowerCase();
  if (!COMMIT_SHA.test(normalizedCommitSha)) {
    throw new Error('Release commit SHA must be a full lowercase 40-character SHA.');
  }

  const directory = path.resolve(releaseDirectory);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('Release directory does not exist.');
  }

  const artifactNames = expectedArtifactNames(request.version);
  for (const name of artifactNames) {
    assertRegularFile(path.join(directory, name), name);
  }
  stageUpdateMetadata(
    path.join(directory, 'latest-mac.yml'),
    request.version,
    request.stagingPercentage,
  );
  const validatedEvidence = validateCandidateEvidence({
    evidence: verificationEvidence,
    updaterEvidence,
    releaseDirectory: directory,
    version: request.version,
    commitSha: normalizedCommitSha,
  });

  const artifacts = artifactNames.map((name) => {
    const filePath = path.join(directory, name);
    const stat = assertRegularFile(filePath, name);
    return {
      name,
      size: stat.size,
      sha256: sha256(filePath),
    };
  });
  const sbom = JSON.parse(fs.readFileSync(
    path.join(directory, 'agent-calendar-sbom.cdx.json'),
    'utf8',
  ));
  if (sbom.bomFormat !== 'CycloneDX' || !String(sbom.specVersion || '').trim()) {
    throw new Error('Release SBOM must be a valid CycloneDX document.');
  }
  const manifest = {
    schemaVersion: 2,
    candidateStatus: 'verified',
    tag: `v${request.version}`,
    version: request.version,
    channel: 'stable',
    stagingPercentage: request.stagingPercentage,
    commitSha: normalizedCommitSha,
    generatedAt,
    desktop: {
      bundleId: validatedEvidence.desktop.bundleId,
      teamIdentifier: validatedEvidence.desktop.teamIdentifier,
      authorities: validatedEvidence.desktop.authorities,
      appGroups: validatedEvidence.desktop.appGroups,
    },
    widget: {
      hostBundleId: validatedEvidence.widget.hostBundleId,
      extensionBundleId: validatedEvidence.widget.extensionBundleId,
      separatelySigned: validatedEvidence.widget.separatelySigned,
      packagedInDmg: validatedEvidence.widget.packagedInDmg,
      appGroups: validatedEvidence.widget.appGroups,
    },
    packagedSmoke: validatedEvidence.smoke,
    ordinarySecureStorage: validatedEvidence.ordinarySecureStorage,
    updateProof: {
      previousVersion: validatedEvidence.updaterEvidence.previousVersion,
      candidateVersion: request.version,
      candidateSha256: validatedEvidence.updaterEvidence.candidateSha256,
      controlledFeed: true,
      rollbackManualOnly: true,
    },
    sbom: {
      name: 'agent-calendar-sbom.cdx.json',
      sha256: sha256(path.join(directory, 'agent-calendar-sbom.cdx.json')),
      format: 'CycloneDX',
      specVersion: sbom.specVersion,
    },
    provenance: {
      attestationRequired: true,
      predicateType: 'https://slsa.dev/provenance/v1',
      subjects: artifacts.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    },
    artifacts,
  };
  fs.writeFileSync(
    path.join(directory, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(directory, 'SHA256SUMS'),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n')}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  return manifest;
}

function parseArguments(values) {
  const [command, ...rest] = values;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid release argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  return { command, flags };
}

function packageVersion(packagePath) {
  const packageDocument = JSON.parse(fs.readFileSync(path.resolve(packagePath), 'utf8'));
  return packageDocument.version;
}

function readJson(filePath, name) {
  if (!filePath) throw new Error(`${name} path is required.`);
  const resolved = path.resolve(filePath);
  assertRegularFile(resolved, name);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function runCli() {
  const { command, flags } = parseArguments(process.argv.slice(2));
  if (command === 'credentials') {
    const validated = validatePublicationCredentials(process.env);
    process.stdout.write(`${JSON.stringify(validated)}\n`);
    return;
  }
  const request = {
    packageVersion: packageVersion(flags.package || 'apps/desktop/package.json'),
    releaseVersion: flags.version,
    stagingPercentage: flags['staging-percentage'],
  };
  if (command === 'validate') {
    const validated = validateReleaseRequest(request);
    process.stdout.write(`${JSON.stringify(validated)}\n`);
    return;
  }
  if (command === 'finalize') {
    const manifest = finalizeDesktopRelease({
      ...request,
      releaseDirectory: flags['release-directory'] || 'apps/desktop/release',
      commitSha: flags['commit-sha'],
      verificationEvidence: readJson(
        flags['verification-evidence'],
        'desktop-candidate-verification.json',
      ),
      updaterEvidence: readJson(flags['updater-evidence'], 'desktop-updater-evidence.json'),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  throw new Error('Usage: desktop-release-artifacts.mjs <credentials|validate|finalize> [options]');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Desktop release failed.'}\n`);
    process.exitCode = 1;
  }
}
