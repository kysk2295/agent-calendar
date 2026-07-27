import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function digest(filePath, algorithm, encoding) {
  return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest(encoding);
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function requireFile(filePath, label) {
  const resolved = path.resolve(String(filePath || ''));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < 1) throw new Error(`Missing ${label}: ${resolved}`);
  return resolved;
}

function requireDirectory(directoryPath, label) {
  const resolved = path.resolve(String(directoryPath || ''));
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Missing ${label}: ${resolved}`);
  }
  return resolved;
}

function requireQaRoot(rootPath) {
  const resolved = path.resolve(String(rootPath || ''));
  if (!path.basename(resolved).startsWith('agent-calendar-desktop-updater-qa-')) {
    throw new Error('QA root must use the agent-calendar-desktop-updater-qa- prefix.');
  }
  const forbidden = [
    path.parse(resolved).root,
    path.resolve(os.homedir()),
    path.resolve('/Applications'),
  ];
  if (forbidden.includes(resolved)) throw new Error('Refusing unsafe updater QA root.');
  return resolved;
}

function readAppVersion(appPath) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const plist = fs.readFileSync(plistPath, 'utf8');
  const match = plist.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
  );
  if (!match || !STABLE_VERSION.test(match[1])) {
    throw new Error(`App bundle has no stable CFBundleShortVersionString: ${appPath}`);
  }
  return match[1];
}

function parseFeed(feedPath) {
  const source = fs.readFileSync(feedPath, 'utf8');
  const value = (key) => source.match(new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm'))?.[1] || '';
  return {
    version: value('version'),
    archiveName: value('path'),
    sha512: value('sha512'),
  };
}

function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('ditto', ['-x', '-k', archivePath, destination], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Candidate archive extraction timed out.');
  if (result.status !== 0) {
    throw new Error(`Candidate archive extraction failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const appPath = path.join(destination, 'Agent Calendar.app');
  return requireDirectory(appPath, 'extracted candidate application');
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
}

function screenshotEvidence(paths) {
  if (!Array.isArray(paths) || paths.length < 3) {
    throw new Error('Before, after, and rollback screenshots are required.');
  }
  const stateNames = ['before-update.png', 'after-update.png', 'rollback.png'];
  return paths.slice(0, 3).map((screenshotPath, index) => {
    const resolved = requireFile(screenshotPath, 'updater screenshot');
    return {
      name: stateNames[index],
      sha256: digest(resolved, 'sha256', 'hex'),
    };
  });
}

export async function runLocalDesktopUpdaterQa(options) {
  const qaRoot = requireQaRoot(options.qaRoot);
  const previousApp = requireDirectory(options.previousApp, 'retained N-1 application');
  const candidateArchive = requireFile(options.candidateArchive, 'candidate ZIP');
  const feedPath = requireFile(options.feedPath, 'controlled update feed');
  const evidencePath = path.resolve(String(options.evidencePath || ''));
  if (evidencePath === qaRoot || evidencePath.startsWith(`${qaRoot}${path.sep}`)) {
    throw new Error('Updater evidence must be outside the disposable QA root.');
  }
  const previousVersion = String(options.previousVersion || '');
  const candidateVersion = String(options.candidateVersion || '');
  const sourceSha = String(options.sourceSha || '').toLowerCase();
  const expectedCandidateSha256 = String(options.expectedCandidateSha256 || '').toLowerCase();
  if (!STABLE_VERSION.test(previousVersion) || !STABLE_VERSION.test(candidateVersion)) {
    throw new Error('Updater QA requires stable N-1 and N versions.');
  }
  if (compareVersions(previousVersion, candidateVersion) >= 0) {
    throw new Error('Updater QA requires a strict N-1 to N transition.');
  }
  if (!SOURCE_SHA.test(sourceSha)) throw new Error('Updater QA source SHA is invalid.');
  if (!SHA256.test(expectedCandidateSha256)) throw new Error('Expected candidate SHA-256 is invalid.');
  if (readAppVersion(previousApp) !== previousVersion) {
    throw new Error('Retained application version does not match N-1.');
  }

  const actualCandidateSha256 = digest(candidateArchive, 'sha256', 'hex');
  if (actualCandidateSha256 !== expectedCandidateSha256) {
    throw new Error('Candidate SHA-256 does not match the expected release bytes.');
  }
  const feed = parseFeed(feedPath);
  if (feed.version !== candidateVersion) throw new Error('Controlled feed version does not match N.');
  if (feed.archiveName !== path.basename(candidateArchive)) {
    throw new Error('Controlled feed path does not reference the exact candidate archive.');
  }
  const actualSha512 = digest(candidateArchive, 'sha512', 'base64');
  if (feed.sha512 !== actualSha512) throw new Error('Controlled feed SHA-512 does not match candidate bytes.');
  const screenshots = screenshotEvidence(options.screenshots);

  fs.rmSync(qaRoot, { recursive: true, force: true });
  const installParent = path.join(qaRoot, 'install');
  const installedApp = path.join(installParent, 'Agent Calendar.app');
  const retainedApp = path.join(qaRoot, 'retained', 'Agent Calendar.app');
  const stagingDirectory = path.join(qaRoot, 'staging');
  const userDataDirectory = path.join(qaRoot, 'user-data');
  const sentinelPath = path.join(userDataDirectory, 'sentinel.json');
  const sentinel = '{"owner":"updater-qa","preserve":true}\n';
  let restoredVersion = '';
  let installedVersion = '';
  let failureMode = '';
  let rollbackRehearsed = false;

  try {
    fs.mkdirSync(installParent, { recursive: true });
    fs.cpSync(previousApp, installedApp, { recursive: true });
    fs.mkdirSync(userDataDirectory, { recursive: true });
    fs.writeFileSync(sentinelPath, sentinel);
    const stagedApp = extractArchive(candidateArchive, stagingDirectory);
    if (readAppVersion(stagedApp) !== candidateVersion) {
      throw new Error('Extracted candidate version does not match N.');
    }

    fs.mkdirSync(path.dirname(retainedApp), { recursive: true });
    fs.renameSync(installedApp, retainedApp);
    if (options.failureMode === 'interrupt-after-backup') {
      failureMode = options.failureMode;
      fs.renameSync(retainedApp, installedApp);
      rollbackRehearsed = true;
      restoredVersion = readAppVersion(installedApp);
    } else {
      fs.renameSync(stagedApp, installedApp);
      installedVersion = readAppVersion(installedApp);
      if (options.failureMode === 'post-update-validation') {
        failureMode = options.failureMode;
        fs.rmSync(installedApp, { recursive: true, force: true });
        fs.renameSync(retainedApp, installedApp);
        rollbackRehearsed = true;
        restoredVersion = readAppVersion(installedApp);
      } else {
        if (fs.readFileSync(sentinelPath, 'utf8') !== sentinel) {
          throw new Error('Updater changed task-owned user data.');
        }
        fs.rmSync(installedApp, { recursive: true, force: true });
        fs.renameSync(retainedApp, installedApp);
        rollbackRehearsed = true;
        restoredVersion = readAppVersion(installedApp);
      }
    }

    const evidence = {
      schemaVersion: 1,
      ok: !failureMode,
      localUnsigned: true,
      publicationEligible: false,
      sourceSha,
      tag: `v${candidateVersion}`,
      previousVersion,
      candidateVersion,
      candidateSha256: actualCandidateSha256,
      controlledFeed: true,
      sha512Verified: true,
      failureMode: failureMode || null,
      update: {
        startedVersion: previousVersion,
        offeredVersion: candidateVersion,
        installedVersion: installedVersion || null,
        candidateIntegrityVerified: true,
        signedCandidateVerified: false,
        userDataPreserved: fs.readFileSync(sentinelPath, 'utf8') === sentinel,
      },
      rollback: {
        manualOnly: true,
        automaticDowngradeAttempted: false,
        retainedPreviousArtifactVerified: restoredVersion === previousVersion,
        rollbackRehearsed,
        restoredVersion,
      },
      cleanup: {
        qaApplicationRemoved: false,
        qaUserDataRemoved: false,
        stagingRemoved: false,
      },
      screenshots,
    };
    fs.rmSync(qaRoot, { recursive: true, force: true });
    evidence.cleanup = {
      qaApplicationRemoved: !fs.existsSync(installedApp),
      qaUserDataRemoved: !fs.existsSync(userDataDirectory),
      stagingRemoved: !fs.existsSync(stagingDirectory),
    };
    writeJson(evidencePath, evidence);
    return evidence;
  } finally {
    fs.rmSync(qaRoot, { recursive: true, force: true });
  }
}

function parseArguments(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid updater QA argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

async function main() {
  const flags = parseArguments(process.argv.slice(2));
  const evidence = await runLocalDesktopUpdaterQa({
    qaRoot: flags['qa-root'],
    previousApp: flags['previous-app'],
    candidateArchive: flags['candidate-archive'],
    feedPath: flags.feed,
    expectedCandidateSha256: flags['candidate-sha256'],
    sourceSha: flags['source-sha'],
    previousVersion: flags['previous-version'],
    candidateVersion: flags['candidate-version'],
    screenshots: String(flags.screenshots || '').split(',').filter(Boolean),
    evidencePath: flags.output,
    failureMode: flags['failure-mode'] || '',
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Updater QA failed.'}\n`);
    process.exitCode = 1;
  });
}
