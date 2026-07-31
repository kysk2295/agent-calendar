'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const tool = path.resolve(__dirname, '../tools/runner-release-artifacts.cjs');
const source = path.resolve(__dirname, '..');
const temporaryDirectories = [];

function temporaryDirectory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifacts-test-'));
  temporaryDirectories.push(value);
  return value;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', ...env },
    timeout: 30_000,
  });
}

test.afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test('two clean deterministic builds have identical archive digest and allowed entries', () => {
  const one = temporaryDirectory();
  const two = temporaryDirectory();
  const common = [
    'build',
    '--source', source,
    '--version', '0.1.0',
    '--commit-sha', 'a'.repeat(40),
    '--platform', 'darwin-arm64',
  ];
  const first = run([...common, '--output-dir', one]);
  const second = run([...common, '--output-dir', two]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstReport = JSON.parse(first.stdout);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(firstReport.archiveSha256, secondReport.archiveSha256);
  assert.equal(firstReport.sourceSha256, secondReport.sourceSha256);
  assert.deepEqual(firstReport.entries, secondReport.entries);
  assert.ok(firstReport.entries.includes('package/bin/agent-calendar-runner.js'));
  assert.ok(firstReport.entries.includes('package/lib/release-manager.js'));
  assert.ok(firstReport.entries.every((entry) => (
    entry === 'package/package.json'
    || entry.startsWith('package/bin/')
    || entry.startsWith('package/lib/')
  )));
});

test('finalize emits pinned signed manifest, sums, SBOM, and provenance', () => {
  const output = temporaryDirectory();
  const build = run([
    'build',
    '--source', source,
    '--output-dir', output,
    '--version', '0.1.0',
    '--commit-sha', 'b'.repeat(40),
  ]);
  assert.equal(build.status, 0, build.stderr);
  const archive = path.join(output, JSON.parse(build.stdout).archive);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(output, 'fixture-private.pem');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const finalized = run([
    'finalize',
    '--artifact', archive,
    '--private-key', privateKeyPath,
    '--version', '0.1.0',
    '--commit-sha', 'b'.repeat(40),
    '--protocol-version', '1',
    '--state-schema-version', '1',
    '--platform', 'darwin-arm64',
    '--staging-percentage', '10',
    '--generated-at', '2026-07-26T00:00:00.000Z',
    '--output-dir', output,
  ]);
  assert.equal(finalized.status, 0, finalized.stderr);
  const report = JSON.parse(finalized.stdout);
  assert.match(report.publicKeyId, /^runner-ed25519-[a-f0-9]{16}$/);
  for (const name of [report.manifest, report.sha256sums, report.sbom, report.provenance, report.publicKey]) {
    const target = path.join(output, name);
    assert.equal(fs.statSync(target).size > 0, true, name);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(output, report.manifest), 'utf8'));
  assert.equal(manifest.publicKeyId, report.publicKeyId);
  assert.match(fs.readFileSync(path.join(output, report.publicKey), 'utf8'), /BEGIN PUBLIC KEY/);
  assert.equal(manifest.artifact.sha256, report.sha256);
  const sums = fs.readFileSync(path.join(output, report.sha256sums), 'utf8');
  assert.match(sums, new RegExp(`${report.sha256}  ${manifest.artifact.name}`));
  const sbom = JSON.parse(fs.readFileSync(path.join(output, report.sbom), 'utf8'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  const provenance = JSON.parse(fs.readFileSync(path.join(output, report.provenance), 'utf8'));
  assert.equal(provenance.subject[0].digest.sha256, report.sha256);
});

test('bootstrap pkg is task-local and release credential preflight fails closed', {
  skip: process.platform !== 'darwin',
}, () => {
  const output = temporaryDirectory();
  const build = run([
    'build',
    '--source', source,
    '--output-dir', output,
    '--version', '0.1.0',
    '--commit-sha', 'c'.repeat(40),
  ]);
  assert.equal(build.status, 0, build.stderr);
  const archive = path.join(output, JSON.parse(build.stdout).archive);
  const pkgPath = path.join(output, 'AgentCalendarRunner-0.1.0.pkg');
  const pkg = run([
    'bootstrap-pkg',
    '--archive', archive,
    '--output', pkgPath,
    '--identifier', 'com.agentcalendar.runner',
    '--version', '0.1.0',
  ]);
  assert.equal(pkg.status, 0, pkg.stderr);
  assert.equal(fs.statSync(pkgPath).size > 0, true);

  const preflight = run(['release-preflight', '--pkg', pkgPath]);
  assert.notEqual(preflight.status, 0);
  assert.match(preflight.stderr, /DEVELOPER_ID_CREDENTIAL_REQUIRED/);
  assert.match(preflight.stderr, /NOTARY_CREDENTIAL_REQUIRED/);
  assert.match(preflight.stderr, /DRAFT_PUBLICATION_AUTHORITY_REQUIRED/);

  const invalid = run(['release-preflight', '--pkg', pkgPath], {
    RUNNER_DEVELOPER_ID_INSTALLER: 'fixture',
    RUNNER_NOTARY_KEYCHAIN_PROFILE: '../fixture',
    RUNNER_DRAFT_PUBLICATION_TOKEN: 'fixture',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /DEVELOPER_ID_CREDENTIAL_INVALID/);
  assert.match(invalid.stderr, /NOTARY_CREDENTIAL_INVALID/);
  assert.match(invalid.stderr, /DRAFT_PUBLICATION_AUTHORITY_INVALID/);
});
