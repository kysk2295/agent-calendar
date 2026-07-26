import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

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

function expectedArtifactNames(version) {
  const baseName = `Agent-Calendar-${version}-arm64`;
  return [
    `${baseName}.dmg`,
    `${baseName}.dmg.blockmap`,
    `${baseName}.zip`,
    `${baseName}.zip.blockmap`,
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

export function finalizeDesktopRelease({
  releaseDirectory,
  packageVersion,
  releaseVersion,
  stagingPercentage,
  commitSha,
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

  const artifacts = artifactNames.map((name) => {
    const filePath = path.join(directory, name);
    const stat = assertRegularFile(filePath, name);
    return {
      name,
      size: stat.size,
      sha256: sha256(filePath),
    };
  });
  const manifest = {
    schemaVersion: 1,
    version: request.version,
    channel: 'stable',
    stagingPercentage: request.stagingPercentage,
    commitSha: normalizedCommitSha,
    generatedAt,
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

function runCli() {
  const { command, flags } = parseArguments(process.argv.slice(2));
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
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  throw new Error('Usage: desktop-release-artifacts.mjs <validate|finalize> [options]');
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
