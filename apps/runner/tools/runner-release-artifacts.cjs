#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSignedRunnerManifest } = require('../lib/release-manager');

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

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command !== 'finalize') {
    throw new Error('Usage: runner-release-artifacts.cjs finalize [options]');
  }
  const privateKeyPath = path.resolve(required(flags, 'private-key'));
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, 'utf8'));
  } catch {
    throw new Error('Runner release signing private key is missing or invalid');
  }
  const artifactPath = path.resolve(required(flags, 'artifact'));
  const manifest = createSignedRunnerManifest({
    artifactPath,
    version: required(flags, 'version'),
    commitSha: required(flags, 'commit-sha'),
    protocolVersion: Number(flags['protocol-version'] || 1),
    stateSchemaVersion: Number(flags['state-schema-version'] || 1),
    platform: flags.platform || 'darwin-arm64',
    stagingPercentage: Number(flags['staging-percentage'] || 10),
    privateKey,
  });
  const outputPath = path.resolve(
    flags.output || `${artifactPath}.manifest.json`,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    manifest: path.basename(outputPath),
    version: manifest.version,
    artifact: manifest.artifact.name,
    sha256: manifest.artifact.sha256,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message || 'Runner release finalization failed'}\n`);
  process.exitCode = 1;
}
