#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  REQUIRED_OFFICIAL_PROFILES,
  buildUnsafeRuntimeCapabilityBlocker,
  formatFixtureCheckResult,
  isDocumentedExecutionHostLayout,
  redactProbeText,
  sanitizeRuntimeHealth,
  summarizeLocalProbe,
  validateMacminiRuntimeInventory,
} = require('../app/lib/macmini-runtime-inventory');

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node apps/backend/tools/macmini-runtime-inventory-check.cjs --fixture <path>',
    '  node apps/backend/tools/macmini-runtime-inventory-check.cjs --probe',
    '',
    'Never prints secret values. Fixture mode is offline. Probe mode is read-only.',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { fixture: '', probe: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--fixture') {
      args.fixture = String(argv[index + 1] || '');
      index += 1;
    } else if (item === '--probe') {
      args.probe = true;
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function pathExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function portListening(port) {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Boolean(String(output || '').includes('LISTEN'));
  } catch {
    return false;
  }
}

function launchAgentState(label) {
  try {
    const output = execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stateMatch = String(output).match(/state\s*=\s*([a-zA-Z]+)/);
    return { loaded: true, state: stateMatch ? stateMatch[1] : 'loaded' };
  } catch {
    return { loaded: false, state: 'not-loaded' };
  }
}

function safeVersion(command, args = ['--version']) {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return redactProbeText(String(output || '').split(/\r?\n/).slice(0, 2).join(' | ').slice(0, 160));
  } catch {
    return '';
  }
}

function toPathTemplate(absolutePath, home, hermesHome) {
  return String(absolutePath || '')
    .split(path.sep)
    .join('/')
    .replace(hermesHome.split(path.sep).join('/'), '$HERMES_HOME')
    .replace(home.split(path.sep).join('/'), '$HOME');
}

function hostClassFromHostname(hostname = '') {
  const value = String(hostname || '').toLowerCase();
  if (value.includes('macbook')) return 'macbook-like';
  if (value.includes('mac-mini') || value.includes('macmini')) return 'mac-mini-like';
  return 'host';
}

function runFixture(fixturePath) {
  const absolute = path.resolve(fixturePath);
  const inventory = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const result = validateMacminiRuntimeInventory(inventory);
  if (!result.ok) {
    process.stderr.write(`Inventory fixture failed validation:\n${result.errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(formatFixtureCheckResult({
    fixturePath: absolute,
    officialProfiles: result.officialProfiles,
    secretRegistryCount: inventory.secretRegistry.length,
    blockerCount: inventory.blockers.length,
  }), null, 2)}\n`);
}

function runProbe() {
  const home = os.homedir();
  const hermesHome = process.env.HERMES_HOME
    ? path.resolve(process.env.HERMES_HOME)
    : path.join(home, '.hermes');
  const ports = [
    { port: 64369, service: 'hermes-os-runtime' },
    { port: 9121, service: 'hermes-dashboard' },
    { port: 8643, service: 'wiki-curator-gateway' },
    { port: 8644, service: 'calendar-gateway' },
    { port: 11434, service: 'ollama' },
  ].map((entry) => ({
    ...entry,
    listening: portListening(entry.port),
  }));

  const launchAgents = [
    'xyz.hermes.os',
    'xyz.hermes.os.runtime',
    'xyz.hermes.os.tunnel',
    'com.yunseo.hermes-railway-relay',
    'ai.hermes.gateway-wikicurator',
    'ai.hermes.gateway-calendarassistant',
  ].map((label) => {
    const state = launchAgentState(label);
    return { label, ...state };
  });

  const pathTemplates = [
    path.join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes'),
    path.join(hermesHome, 'os-runtime'),
    path.join(hermesHome, 'os-runtime', 'scripts', 'hermes-railway-relay-bridge.js'),
    path.join(home, 'Library', 'LaunchAgents', 'xyz.hermes.os.runtime.plist'),
    path.join(home, 'Library', 'LaunchAgents', 'com.yunseo.hermes-railway-relay.plist'),
  ];

  const pathPresence = pathTemplates.map((absolutePath) => ({
    template: toPathTemplate(absolutePath, home, hermesHome),
    present: pathExists(absolutePath),
  }));

  const profiles = [...REQUIRED_OFFICIAL_PROFILES, 'calendarassistant'].map((id) => ({
    id,
    present: pathExists(path.join(hermesHome, 'profiles', id)),
  }));

  const hermesCli = path.join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes');
  const versions = {
    node: process.version,
    hermes: pathExists(hermesCli) ? safeVersion(hermesCli) : safeVersion('hermes'),
    ollama: safeVersion('ollama', ['--version']),
  };

  const blockers = [];
  const requiredMissingPorts = ports.filter((entry) => [9121, 8643, 8644].includes(entry.port) && !entry.listening);
  if (requiredMissingPorts.length) {
    blockers.push({
      id: 'P0-S2-MACMINI-HOST-UNREACHABLE',
      summary: 'Expected production Mac mini curator/dashboard listeners are not reachable on this host.',
      missingPorts: requiredMissingPorts.map((entry) => entry.port),
    });
  }
  if (!pathPresence.find((entry) => entry.template.endsWith('hermes-railway-relay-bridge.js'))?.present) {
    blockers.push({
      id: 'P0-S2-RELAY-BRIDGE-SCRIPT-MISSING',
      summary: 'Railway relay bridge script is missing under the local Hermes OS Runtime scripts directory.',
    });
  }
  const missingOfficial = profiles.filter((entry) => REQUIRED_OFFICIAL_PROFILES.includes(entry.id) && !entry.present);
  if (missingOfficial.length) {
    blockers.push({
      id: 'P0-S2-OFFICIAL-PROFILES-INCOMPLETE',
      summary: 'One or more official Hermes profiles are missing on this host.',
      missingProfiles: missingOfficial.map((entry) => entry.id),
    });
  }

  let runtimeHealth = { status: 0, reachable: false };
  try {
    const response = execFileSync('/usr/bin/curl', ['-fsS', '--max-time', '3', 'http://127.0.0.1:64369/api/health'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const body = JSON.parse(response);
    const capabilities = Array.isArray(body.runtimeVersion?.capabilities) ? body.runtimeVersion.capabilities : [];
    runtimeHealth = sanitizeRuntimeHealth({
      status: 200,
      name: body.name || '',
      runtimeVersion: body.runtimeVersion || null,
      capabilities,
      machineName: body.runtime?.machineName || body.resident?.process?.machineName || '',
      hostname: body.runtime?.hostname || body.resident?.process?.hostname || '',
      cwd: body.runtime?.cwd || body.resident?.process?.cwd || '',
      wikiRoot: body.wikiRoot || '',
      nodeVersion: body.runtime?.nodeVersion || '',
    });
    // Classify forbidden capability advertisements without mutating the runtime.
    const unsafeCapabilityBlocker = buildUnsafeRuntimeCapabilityBlocker({
      capabilities: runtimeHealth.capabilities || capabilities,
    });
    if (unsafeCapabilityBlocker) blockers.push(unsafeCapabilityBlocker);
  } catch {
    runtimeHealth = { status: 0, reachable: false };
  }

  const summary = summarizeLocalProbe({
    host: {
      class: hostClassFromHostname(os.hostname()),
      platform: process.platform,
      arch: process.arch,
      isDocumentedMacMiniPathHost: isDocumentedExecutionHostLayout({
        homeDir: home,
        hermesHome,
        pathExists,
      }),
    },
    ports,
    launchAgents,
    pathPresence,
    profiles,
    versions,
    blockers,
    runtimeHealth,
  });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (blockers.length) process.exitCode = 2;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.fixture && !args.probe)) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  if (args.fixture && args.probe) {
    throw new Error('Use either --fixture or --probe, not both');
  }
  if (args.fixture) runFixture(args.fixture);
  if (args.probe) runProbe();
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
