#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  installRunnerRelease,
  readRunnerReleaseState,
} = require('../lib/release-manager');
const { PROTOCOL_VERSION } = require('../lib/crypto');

const RUNNER_STATE_SCHEMA_VERSION = 1;

function parseArgs(values) {
  const args = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid`);
  }
}

function readPublicKey(filePath) {
  try {
    return crypto.createPublicKey(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    throw new Error('trusted Runner release public key is missing or invalid');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'help') {
    process.stdout.write([
      'Usage:',
      '  agent-calendar-runner-update install --artifact PATH --manifest PATH',
      '    --trusted-public-key PATH --install-root PATH',
      '  agent-calendar-runner-update status --install-root PATH',
      '',
    ].join('\n'));
    return;
  }
  if (!args['install-root']) throw new Error('--install-root is required');
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ...readRunnerReleaseState(args['install-root']),
    }, null, 2)}\n`);
    return;
  }
  if (command !== 'install') throw new Error(`Unknown update command: ${command}`);
  for (const name of ['artifact', 'manifest', 'trusted-public-key']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const manifest = readJson(args.manifest, 'Runner release manifest');
  const expectedPlatform = `${process.platform}-${process.arch}`;
  if (manifest.platform !== expectedPlatform) {
    throw new Error(`Runner release platform ${manifest.platform || 'unknown'} does not match host`);
  }
  const result = await installRunnerRelease({
    installRoot: args['install-root'],
    artifactPath: args.artifact,
    manifest,
    trustedPublicKey: readPublicKey(args['trusted-public-key']),
    protocolVersion: PROTOCOL_VERSION,
    stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.message || 'Runner update failed'}\n`);
  process.exitCode = 1;
});
