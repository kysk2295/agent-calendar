#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  collectOperationsWindow,
  evaluateOperationsAlertWindow,
  readCollectorState,
  writeCollectorState,
} = require('../app/lib/operations-alert-collector');

function parseArgs(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid collector argument: ${name || '(missing)'}`);
    }
    flags[name.slice(2)] = value;
  }
  const allowed = new Set(['base-url', 'state-json', 'rate-reject-threshold']);
  if (Object.keys(flags).some((name) => !allowed.has(name))) {
    throw new Error('operations collector received an unsupported flag');
  }
  return flags;
}

function required(flags, name) {
  const value = String(flags[name] || '').trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const baseUrl = required(flags, 'base-url');
  const statePath = path.resolve(required(flags, 'state-json'));
  const rateRejectThreshold = flags['rate-reject-threshold'] === undefined
    ? 100
    : Number(flags['rate-reject-threshold']);
  if (!Number.isSafeInteger(rateRejectThreshold) || rateRejectThreshold < 1) {
    throw new Error('--rate-reject-threshold must be a positive integer');
  }

  const previousState = readCollectorState(statePath);
  const current = await collectOperationsWindow({
    baseUrl,
    operationsToken: process.env.AGENT_CALENDAR_OPERATIONS_TOKEN || '',
  });
  const result = evaluateOperationsAlertWindow({
    previousState,
    current,
    observedAt: new Date().toISOString(),
    rateRejectThreshold,
  });
  writeCollectorState(statePath, result.state);
  process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  process.exitCode = result.evidence.exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error?.message || 'operations collector failed'}\n`);
  process.exitCode = 1;
});
