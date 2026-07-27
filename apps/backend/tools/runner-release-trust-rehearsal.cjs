#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeRunnerReleaseManifest,
} = require('../app/lib/runner-control');
const {
  canonicalManifestPayload,
} = require('../app/lib/runner-release-trust');
const {
  createSignedRunnerManifest,
} = require('../../runner/lib/release-manager');

async function main() {
  const evidenceDir = path.resolve(
    process.env.EVIDENCE_DIR
      || '.omo/evidence/production-readiness-completion/task-13/trusted-manifest-remediation/manual',
  );
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-trust-rehearsal-'));
  const privateKeyPath = path.join(workDir, 'fixture-private.pem');
  let vite;
  let report;
  try {
    const keys = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(
      privateKeyPath,
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    const artifactPath = path.join(workDir, 'agent-calendar-runner-1.2.3-darwin-arm64.tgz');
    fs.writeFileSync(artifactPath, 'task13-trusted-runner-fixture', { mode: 0o600 });
    const manifest = createSignedRunnerManifest({
      artifactPath,
      version: '1.2.3',
      commitSha: 'a'.repeat(40),
      protocolVersion: 1,
      stateSchemaVersion: 1,
      platform: 'darwin-arm64',
      stagingPercentage: 10,
      privateKey: keys.privateKey,
      generatedAt: '2026-07-26T08:25:00.000Z',
    });
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const trust = { [manifest.publicKeyId]: publicKeyPem };
    const release = {
      status: 'verified_signed',
      downloadUrl: `https://releases.example.test/${manifest.artifact.name}`,
      manifestUrl: `https://releases.example.test/${manifest.artifact.name}.manifest.json`,
      manifest,
      verification: {
        status: 'verified',
        source: 'caller_asserted',
        artifactSha256: 'f'.repeat(64),
      },
    };
    const options = {
      trustedPublicKeys: trust,
      minimumVersion: '1.0.0',
      now: () => Date.parse('2026-07-26T08:30:00.000Z'),
    };
    const validResults = Array.from({ length: 3 }, () => (
      normalizeRunnerReleaseManifest(release, 'darwin-arm64', options)
    ));
    const attacker = {
      status: 'verified_signed',
      version: '1.2.3',
      platform: 'darwin-arm64',
      downloadUrl: release.downloadUrl,
      manifestUrl: release.manifestUrl,
      sha256: manifest.artifact.sha256,
      signature: Buffer.alloc(64, 1).toString('base64'),
      publicKeyId: manifest.publicKeyId,
      verification: {
        status: 'verified',
        source: 'backend_ed25519',
        algorithm: 'ed25519',
        manifestSha256: 'b'.repeat(64),
        artifactSha256: manifest.artifact.sha256,
        publicKeyId: manifest.publicKeyId,
      },
    };
    const attackerResults = Array.from({ length: 3 }, () => (
      normalizeRunnerReleaseManifest(attacker, 'darwin-arm64', options)
    ));
    const wrongKeys = crypto.generateKeyPairSync('ed25519');
    const wrongKey = normalizeRunnerReleaseManifest(release, 'darwin-arm64', {
      ...options,
      trustedPublicKeys: {
        [manifest.publicKeyId]: wrongKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    });
    const tampered = normalizeRunnerReleaseManifest({
      ...release,
      manifest: { ...manifest, commitSha: 'b'.repeat(40) },
    }, 'darwin-arm64', options);

    vite = await import('vite').then(({ createServer }) => createServer({
      root: path.resolve(__dirname, '../../desktop'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'silent',
    }));
    const desktop = await vite.ssrLoadModule('/src/features/runner/runnerApi.ts');
    const desktopValid = desktop.normalizeReleaseArtifact(validResults[0]);
    const desktopAttacker = desktop.normalizeReleaseArtifact(attackerResults[0]);
    const directCryptoValid = crypto.verify(
      null,
      canonicalManifestPayload(manifest),
      keys.publicKey,
      Buffer.from(manifest.signature, 'base64'),
    );
    const validSelectionStable = validResults.every((item) => (
      item.status === 'verified_signed'
      && item.verification?.source === 'backend_ed25519'
      && item.sha256 === manifest.artifact.sha256
      && item.publicKeyId === manifest.publicKeyId
    ));
    const attackerSelectionStable = attackerResults.every((item) => item.status === 'unavailable');
    report = {
      schemaVersion: 1,
      rehearsal: 'runner_backend_trusted_manifest',
      ok: Boolean(
        directCryptoValid
        && validSelectionStable
        && attackerSelectionStable
        && wrongKey.status === 'unavailable'
        && tampered.status === 'unavailable'
        && desktopValid.status === 'verified_signed'
        && desktopAttacker.status === 'unavailable'
      ),
      directCryptoValid,
      validSelectionStable,
      attackerSelectionStable,
      wrongTrustedKeyRejected: wrongKey.status === 'unavailable',
      tamperedManifestRejected: tampered.status === 'unavailable',
      backendStatus: validResults[0].status,
      desktopValidStatus: desktopValid.status,
      desktopAttackerStatus: desktopAttacker.status,
      artifactSha256: manifest.artifact.sha256,
      manifestSha256: validResults[0].verification?.manifestSha256 || '',
      publicKeyId: manifest.publicKeyId,
      registeredResources: {
        privateKeyFixtures: 1,
        tempDirectories: 1,
        viteMiddlewareServers: 1,
        childProcesses: 0,
        ports: [],
      },
    };
  } finally {
    if (vite) await vite.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const cleanup = {
    cleanup: !fs.existsSync(workDir),
    privateKeyDestroyed: !fs.existsSync(privateKeyPath),
    survivingChildProcesses: 0,
    openRegisteredPorts: [],
  };
  report = { ...report, ...cleanup };
  report.ok = Boolean(report.ok && cleanup.cleanup && cleanup.privateKeyDestroyed);
  fs.writeFileSync(
    path.join(evidenceDir, 'trusted-manifest-rehearsal.json'),
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
  process.stderr.write(`${error?.message || 'Runner trust rehearsal failed'}\n`);
  process.exitCode = 1;
});
