#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_CONFIG_BYTES,
  evaluateStagingCleanAccountPreflight,
  missingDeliveryCapabilities,
} = require('../apps/backend/app/lib/staging-workos-clean-account-harness');

const KIND = 'staging_clean_account_preflight';
const REPO_ROOT = path.resolve(__dirname, '..');

function emit(result, exitCode) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

function rejected() {
  return {
    schemaVersion: 1,
    kind: KIND,
    ok: false,
    status: 'rejected',
    code: 'unsafe_configuration',
  };
}

function blockedWithoutConfig(delivery) {
  const missing = missingDeliveryCapabilities(delivery);
  if (!missing.includes('secret_manager_delivery')) {
    missing.unshift('secret_manager_delivery');
  }
  missing.splice(1, 0, 'staging_candidate_configuration');
  return {
    schemaVersion: 1,
    kind: KIND,
    ok: false,
    status: 'blocked',
    code: 'missing_external_authority',
    missingCapabilities: missing,
  };
}

function parsePreflightArgs(args) {
  if (
    args.length !== 2
    || args[0] !== '--config'
    || !String(args[1] || '').trim()
  ) {
    throw new Error('invalid');
  }
  return String(args[1]);
}

function readConfig(filePath, { live = false } = {}) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    throw new Error('invalid');
  }
  if (live) {
    const relative = path.relative(REPO_ROOT, resolved);
    if ((!relative.startsWith('..') && !path.isAbsolute(relative)) || (stat.mode & 0o077) !== 0) {
      throw new Error('invalid');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('invalid');
    }
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function deliveryFromEnvironment() {
  return {
    source: process.env.AGENT_CALENDAR_STAGING_CONFIG_SOURCE || '',
    provider: process.env.AGENT_CALENDAR_STAGING_SECRET_MANAGER || '',
    workosAuthorityRef: process.env.AGENT_CALENDAR_STAGING_WORKOS_AUTHORITY_REF || '',
    engineAuthorityRef: process.env.AGENT_CALENDAR_STAGING_ENGINE_AUTHORITY_REF || '',
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'preflight') {
    const configPath = parsePreflightArgs(args);
    const result = evaluateStagingCleanAccountPreflight(readConfig(configPath), {
      delivery: {},
    });
    emit(result, result.preflightReady ? 0 : 1);
    return;
  }
  if (command === 'live-preflight') {
    if (args.length !== 0) throw new Error('invalid');
    const delivery = deliveryFromEnvironment();
    const configPath = String(process.env.AGENT_CALENDAR_STAGING_CONFIG_PATH || '').trim();
    if (!configPath) {
      emit(blockedWithoutConfig(delivery), 1);
      return;
    }
    const result = evaluateStagingCleanAccountPreflight(
      readConfig(configPath, { live: true }),
      { delivery },
    );
    emit(result, result.preflightReady ? 0 : 1);
    return;
  }
  throw new Error('invalid');
}

try {
  main();
} catch {
  emit(rejected(), 2);
}
