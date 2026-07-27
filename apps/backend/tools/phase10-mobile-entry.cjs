#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  evaluateMobileEntryEvidence,
} = require('../app/lib/phase10-mobile-entry');

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--evidence-dir' || !String(args[1] || '').trim()) {
    throw new Error('--evidence-dir is required');
  }
  return path.resolve(args[1]);
}

try {
  const evidenceDir = parseArgs(process.argv.slice(2));
  const result = evaluateMobileEntryEvidence({ evidenceDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.mobileEntryReady) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    reasonCode: 'mobile_entry_cli_invalid',
    message: String(error?.message || error),
  })}\n`);
  process.exitCode = 64;
}
