#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  collectPrivateBetaReceipt,
  evaluatePrivateBetaEvidence,
  writePrivateBetaManifest,
} = require('../app/lib/private-beta-stability');

const MAX_INPUT_BYTES = 64 * 1024;

function parseArgs(values) {
  const [operation, ...rest] = values;
  if (!['collect', 'evaluate', 'init'].includes(operation)) {
    throw new Error('private beta operation must be init, collect, or evaluate');
  }
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('private beta argument is invalid');
    }
    const key = name.slice(2);
    if (Object.hasOwn(flags, key)) throw new Error('private beta argument is duplicated');
    flags[key] = value;
  }
  const allowed = {
    collect: new Set(['evidence-dir', 'receipt-json']),
    evaluate: new Set(['evidence-dir', 'now']),
    init: new Set(['evidence-dir', 'manifest-json']),
  }[operation];
  if (Object.keys(flags).some((key) => !allowed.has(key))) {
    throw new Error('private beta argument is unsupported');
  }
  return { operation, flags };
}

function required(flags, name) {
  const value = String(flags[name] || '').trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readBoundedJson(filePath) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size > MAX_INPUT_BYTES
    || (stats.mode & 0o077) !== 0
  ) throw new Error('private beta JSON input is invalid');
  const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('private beta JSON input is invalid');
  }
  return value;
}

function main() {
  const { operation, flags } = parseArgs(process.argv.slice(2));
  const evidenceDir = path.resolve(required(flags, 'evidence-dir'));
  let output;
  if (operation === 'init') {
    output = writePrivateBetaManifest({
      evidenceDir,
      manifest: readBoundedJson(required(flags, 'manifest-json')),
    });
  } else if (operation === 'collect') {
    output = collectPrivateBetaReceipt({
      evidenceDir,
      receipt: readBoundedJson(required(flags, 'receipt-json')),
    });
  } else {
    output = evaluatePrivateBetaEvidence({
      evidenceDir,
      now: flags.now || new Date().toISOString(),
    });
    process.exitCode = output.privateBetaReady ? 0 : 2;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.message || 'private beta stability tool failed'}\n`);
  process.exitCode = 1;
}
