#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  createSignedRunnerManifest,
  sha256File,
} = require('../lib/release-manager');

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;

function parseArgs(values) {
  const [command, ...rest] = values;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid Runner release argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  return { command, flags };
}

function required(flags, name) {
  const value = String(flags[name] || '').trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function validateVersionAndCommit(flags) {
  const version = required(flags, 'version');
  const commitSha = required(flags, 'commit-sha').toLowerCase();
  if (!STABLE_SEMVER.test(version)) throw new Error('Runner releases require a stable semantic version');
  if (!FULL_COMMIT_SHA.test(commitSha)) throw new Error('Runner release requires a full lowercase commit SHA');
  return { version, commitSha };
}

function writeOctal(header, offset, length, value) {
  const text = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0');
  header.write(`${text}\0`, offset, length, 'ascii');
}

function tarHeader(name, size, mode, type = '0') {
  if (Buffer.byteLength(name) > 100) throw new Error(`Runner archive path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 4, 'ascii');
  header.write('wheel', 297, 5, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function collectFiles(sourceRoot) {
  const files = [];
  for (const directory of ['bin', 'lib']) {
    const root = path.join(sourceRoot, directory);
    const walk = (current, relative) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error('Runner release source may not contain symbolic links');
        const absolute = path.join(current, entry.name);
        const nextRelative = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) walk(absolute, nextRelative);
        else if (entry.isFile()) files.push({
          name: `package/${nextRelative}`,
          content: fs.readFileSync(absolute),
          mode: directory === 'bin' ? 0o755 : 0o644,
        });
        else throw new Error('Runner release source contains unsupported file type');
      }
    };
    walk(root, directory);
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function packageMetadata(sourceRoot, version) {
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const document = {
    name: 'agent-calendar-runner',
    version,
    private: true,
    type: 'commonjs',
    bin: sourcePackage.bin,
    main: sourcePackage.main,
    engines: sourcePackage.engines,
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function sourceFingerprint(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(`${file.name}\0${file.mode.toString(8)}\0${file.content.length}\0`, 'utf8');
    hash.update(file.content);
  }
  return hash.digest('hex');
}

function buildTar(files) {
  const chunks = [];
  const directories = new Set(['package/', 'package/bin/', 'package/lib/']);
  for (const file of files) {
    let parent = path.posix.dirname(file.name);
    while (parent !== '.' && parent !== 'package') {
      directories.add(`${parent}/`);
      parent = path.posix.dirname(parent);
    }
  }
  for (const directory of [...directories].sort()) {
    chunks.push(tarHeader(directory, 0, 0o755, '5'));
  }
  for (const file of files) {
    chunks.push(tarHeader(file.name, file.content.length, file.mode));
    chunks.push(file.content);
    const padding = (512 - (file.content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeJson(target, document) {
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
}

function build(flags) {
  const sourceRoot = path.resolve(required(flags, 'source'));
  const outputDir = path.resolve(required(flags, 'output-dir'));
  const { version, commitSha } = validateVersionAndCommit(flags);
  const platform = String(flags.platform || 'darwin-arm64');
  if (!fs.statSync(sourceRoot).isDirectory()) throw new Error('Runner release source must be a directory');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const runtimeFiles = collectFiles(sourceRoot);
  const files = [
    { name: 'package/package.json', content: packageMetadata(sourceRoot, version), mode: 0o644 },
    ...runtimeFiles,
  ].sort((left, right) => left.name.localeCompare(right.name));
  const archiveName = `agent-calendar-runner-${version}-${platform}.tgz`;
  const archivePath = path.join(outputDir, archiveName);
  fs.writeFileSync(archivePath, zlib.gzipSync(buildTar(files), { level: 9, mtime: 0 }), { mode: 0o644 });
  const report = {
    schemaVersion: 1,
    archive: archiveName,
    archiveSha256: sha256File(archivePath),
    sourceSha256: sourceFingerprint(files),
    version,
    platform,
    commitSha,
    entries: files.map((file) => file.name),
  };
  writeJson(`${archivePath}.build.json`, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function finalize(flags) {
  const privateKeyPath = path.resolve(required(flags, 'private-key'));
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, 'utf8'));
  } catch {
    throw new Error('Runner release signing private key is missing or invalid');
  }
  const artifactPath = path.resolve(required(flags, 'artifact'));
  const { version, commitSha } = validateVersionAndCommit(flags);
  const manifest = createSignedRunnerManifest({
    artifactPath,
    version,
    commitSha,
    protocolVersion: Number(flags['protocol-version'] || 1),
    stateSchemaVersion: Number(flags['state-schema-version'] || 1),
    platform: flags.platform || 'darwin-arm64',
    stagingPercentage: Number(flags['staging-percentage'] || 10),
    privateKey,
    generatedAt: flags['generated-at'] || new Date().toISOString(),
  });
  const outputDir = path.resolve(flags['output-dir'] || path.dirname(artifactPath));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const manifestName = flags.output
    ? path.basename(flags.output)
    : `${path.basename(artifactPath)}.manifest.json`;
  const manifestPath = flags.output ? path.resolve(flags.output) : path.join(outputDir, manifestName);
  const sbomName = `${path.basename(artifactPath)}.cdx.json`;
  const provenanceName = `${path.basename(artifactPath)}.provenance.json`;
  const publicKeyName = `${manifest.publicKeyId}.public.pem`;
  const sumsName = 'SHA256SUMS';
  let sourceSha256 = '';
  try {
    sourceSha256 = JSON.parse(fs.readFileSync(`${artifactPath}.build.json`, 'utf8')).sourceSha256 || '';
  } catch {
    sourceSha256 = 'unavailable';
  }
  writeJson(manifestPath, manifest);
  fs.writeFileSync(
    path.join(outputDir, publicKeyName),
    crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    { mode: 0o644 },
  );
  writeJson(path.join(outputDir, sbomName), {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${manifest.artifact.sha256.slice(0, 8)}-${manifest.artifact.sha256.slice(8, 12)}-5${manifest.artifact.sha256.slice(13, 16)}-8${manifest.artifact.sha256.slice(17, 20)}-${manifest.artifact.sha256.slice(20, 32)}`,
    version: 1,
    metadata: { component: { type: 'application', name: 'agent-calendar-runner', version } },
    components: [{ type: 'application', name: 'agent-calendar-runner', version, hashes: [{ alg: 'SHA-256', content: manifest.artifact.sha256 }] }],
  });
  writeJson(path.join(outputDir, provenanceName), {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: manifest.artifact.name, digest: { sha256: manifest.artifact.sha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://agentcalendar.example/runner/deterministic-tar-v1',
        externalParameters: { version, platform: manifest.platform, commitSha },
        resolvedDependencies: [{ uri: `git+scoped:apps/runner/bin+lib@${commitSha}`, digest: { sha256: sourceSha256 } }],
      },
      runDetails: { builder: { id: 'agent-calendar-runner-release-artifacts-v1' } },
    },
  });
  fs.writeFileSync(
    path.join(outputDir, sumsName),
    `${manifest.artifact.sha256}  ${manifest.artifact.name}\n`
      + `${sha256File(manifestPath)}  ${path.basename(manifestPath)}\n`
      + `${sha256File(path.join(outputDir, publicKeyName))}  ${publicKeyName}\n`
      + `${sha256File(path.join(outputDir, sbomName))}  ${sbomName}\n`
      + `${sha256File(path.join(outputDir, provenanceName))}  ${provenanceName}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    manifest: path.basename(manifestPath),
    sha256sums: sumsName,
    sbom: sbomName,
    provenance: provenanceName,
    publicKey: publicKeyName,
    version,
    artifact: manifest.artifact.name,
    sha256: manifest.artifact.sha256,
    publicKeyId: manifest.publicKeyId,
  })}\n`);
}

function bootstrapPkg(flags) {
  if (process.platform !== 'darwin') throw new Error('Runner bootstrap pkg requires macOS pkgbuild');
  const artifactPath = path.resolve(required(flags, 'archive'));
  const outputPath = path.resolve(required(flags, 'output'));
  const identifier = required(flags, 'identifier');
  const version = required(flags, 'version');
  if (!STABLE_SEMVER.test(version)) throw new Error('Runner bootstrap pkg requires stable semantic version');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/.test(identifier)) throw new Error('Runner bootstrap pkg identifier is invalid');
  const buildRoot = fs.mkdtempSync(path.join(path.dirname(outputPath), '.runner-pkg-root-'));
  try {
    const payload = path.join(buildRoot, 'usr', 'local', 'share', 'agent-calendar-runner');
    fs.mkdirSync(payload, { recursive: true, mode: 0o755 });
    fs.copyFileSync(artifactPath, path.join(payload, path.basename(artifactPath)));
    const result = spawnSync('/usr/bin/pkgbuild', [
      '--root', buildRoot,
      '--identifier', identifier,
      '--version', version,
      '--install-location', '/',
      outputPath,
    ], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`Runner bootstrap pkg build failed: ${String(result.stderr || '').trim()}`);
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, pkg: path.basename(outputPath), sha256: sha256File(outputPath), signed: false })}\n`);
}

function releasePreflight(flags) {
  const pkgPath = path.resolve(required(flags, 'pkg'));
  artifactStatForPreflight(pkgPath);
  const failures = [];
  const developerId = String(process.env.RUNNER_DEVELOPER_ID_INSTALLER || '');
  const notaryProfile = String(process.env.RUNNER_NOTARY_KEYCHAIN_PROFILE || '');
  const publicationToken = String(process.env.RUNNER_DRAFT_PUBLICATION_TOKEN || '');
  if (!developerId) failures.push('DEVELOPER_ID_CREDENTIAL_REQUIRED');
  else if (!/^Developer ID Installer: .+ \([A-Z0-9]{10}\)$/.test(developerId)) {
    failures.push('DEVELOPER_ID_CREDENTIAL_INVALID');
  }
  if (!notaryProfile) failures.push('NOTARY_CREDENTIAL_REQUIRED');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(notaryProfile)) {
    failures.push('NOTARY_CREDENTIAL_INVALID');
  }
  if (!publicationToken) failures.push('DRAFT_PUBLICATION_AUTHORITY_REQUIRED');
  else if (publicationToken.length < 20 || /\s/.test(publicationToken)) {
    failures.push('DRAFT_PUBLICATION_AUTHORITY_INVALID');
  }
  if (process.platform === 'darwin') {
    const signature = spawnSync('/usr/sbin/pkgutil', ['--check-signature', pkgPath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (signature.status !== 0 || /no signature/i.test(`${signature.stdout}\n${signature.stderr}`)) {
      failures.push('DEVELOPER_ID_SIGNATURE_REQUIRED');
    }
    const staple = spawnSync('/usr/bin/xcrun', ['stapler', 'validate', pkgPath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (staple.status !== 0) failures.push('NOTARY_STAPLE_REQUIRED');
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
  throw new Error('EXTERNAL_RELEASE_ACTION_NOT_AUTHORIZED');
}

function artifactStatForPreflight(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error('Runner bootstrap pkg is missing');
  }
  if (!stat.isFile() || stat.size < 1) throw new Error('Runner bootstrap pkg is invalid');
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'build') return build(flags);
  if (command === 'finalize') return finalize(flags);
  if (command === 'bootstrap-pkg') return bootstrapPkg(flags);
  if (command === 'release-preflight') return releasePreflight(flags);
  throw new Error('Usage: runner-release-artifacts.cjs <build|finalize|bootstrap-pkg|release-preflight> [options]');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message || 'Runner release artifact operation failed'}\n`);
  process.exitCode = 1;
}
