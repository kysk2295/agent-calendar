'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractFile, listPackage } = require('@electron/asar');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const PRODUCTION_GATEWAY = 'https://hermes-os-production-e174.up.railway.app';

function repositoryHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim().toLowerCase();
}

function verifyPackagedCodesign(appPath) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'ignore',
  });
}

function productionGatewayOrigin(value) {
  if (String(value || '') !== PRODUCTION_GATEWAY) {
    throw new Error(`production gateway must be exactly ${PRODUCTION_GATEWAY}`);
  }
  return PRODUCTION_GATEWAY;
}

async function probeGateway(origin, fetchImpl) {
  const receipts = {};
  for (const name of ['health', 'ready', 'gateway-status']) {
    let response;
    try {
      response = await fetchImpl(`${origin}/api/${name}`, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Railway /api/${name} request failed`);
    }
    if (response.status !== 200) {
      throw new Error(`Railway /api/${name} must return HTTP 200`);
    }
    receipts[name] = response;
  }
  let gatewayStatus;
  try {
    gatewayStatus = await receipts['gateway-status'].json();
  } catch {
    throw new Error('Railway /api/gateway-status must return JSON');
  }
  return { gatewayStatus };
}

function matchingGatewayIdentity(status, sourceSha) {
  const exactFields = ['sourceSha', 'build'];
  for (const field of exactFields) {
    const value = typeof status?.[field] === 'string' ? status[field].trim().toLowerCase() : '';
    if (value && value !== sourceSha) return null;
  }
  const buildCommit = typeof status?.buildCommit === 'string'
    ? status.buildCommit.trim().toLowerCase()
    : '';
  if (buildCommit === sourceSha.slice(0, 12)) {
    return { field: 'buildCommit', value: buildCommit };
  }
  return null;
}

async function probePackagedRenderer({ executablePath }) {
  if (process.env.VITE_DEV_SERVER_URL) {
    throw new Error('VITE_DEV_SERVER_URL is forbidden for production freeze evidence');
  }
  const { _electron: electron } = require('playwright');
  const userDataName = `Agent Calendar Freeze ${process.pid}`;
  const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
  const environment = { ...process.env, AGENT_CALENDAR_USER_DATA_NAME: userDataName };
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.AGENT_CALENDAR_E2E_AUTH;
  delete environment.AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE;
  fs.rmSync(userDataPath, { recursive: true, force: true });
  let electronApp;
  try {
    electronApp = await electron.launch({ executablePath, env: environment });
    const page = await electronApp.firstWindow();
    await page.locator('.app-root').waitFor({ timeout: 30_000 });
    return page.url();
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

async function runFreeze(options, dependencies = {}) {
  const gitHead = dependencies.gitHead || repositoryHead;
  const requested = String(options.sourceSha || '').trim().toLowerCase();
  const head = String(gitHead()).trim().toLowerCase();
  if (!SOURCE_SHA.test(requested)) throw new Error('requested source SHA must be exactly 40 lowercase hex characters');
  if (!SOURCE_SHA.test(head) || requested !== head) {
    throw new Error('requested source SHA must equal Git HEAD');
  }
  if (!['check', 'write'].includes(options.mode)) {
    throw new Error('freeze mode must be check or write');
  }
  const appPath = path.resolve(String(options.appPath || ''));
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Agent Calendar');
  if (!fs.existsSync(appPath)
    || !fs.statSync(appPath).isDirectory()
    || !fs.existsSync(asarPath)
    || !fs.statSync(asarPath).isFile()) {
    throw new Error('packaged app required with app.asar');
  }
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error('packaged app required with executable');
  }
  let metadata;
  try {
    metadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  } catch {
    throw new Error('packaged app.asar metadata is unreadable');
  }
  if (String(metadata.sourceSha || '').toLowerCase() !== requested) {
    throw new Error('packaged metadata source SHA must equal requested source SHA');
  }
  const entries = listPackage(asarPath);
  const rendererBuildId = requested.slice(0, 12);
  const rendererEntries = entries.filter((entry) => (
    /^\/dist\//.test(entry) && /\.(?:html|js)$/.test(entry)
  ));
  const visibleBuildEmbedded = rendererEntries.some((entry) => {
    const contents = extractFile(asarPath, entry.replace(/^\//, '')).toString('utf8');
    return contents.includes(rendererBuildId) && contents.includes('Desktop build');
  });
  if (!entries.includes('/dist/index.html') || !visibleBuildEmbedded) {
    throw new Error('visible renderer build id must equal requested source SHA prefix');
  }
  let packagedMain = '';
  try {
    packagedMain = extractFile(asarPath, 'dist-electron/main.js').toString('utf8');
  } catch {
    packagedMain = '';
  }
  if (!/\.loadFile\(/.test(packagedMain) || !packagedMain.includes('packagedRendererIndexPath')) {
    throw new Error('packaged Electron main must load the file renderer');
  }
  const verifyCodesign = dependencies.verifyCodesign || verifyPackagedCodesign;
  try {
    verifyCodesign(appPath);
  } catch {
    throw new Error('codesign --verify --deep --strict failed');
  }
  const probeRenderer = dependencies.probeRenderer || probePackagedRenderer;
  const rendererUrl = await probeRenderer({ appPath, asarPath, executablePath });
  const expectedRendererPath = path.join(asarPath, 'dist', 'index.html');
  let renderer;
  try {
    renderer = new URL(rendererUrl);
  } catch {
    throw new Error('renderer must use the packaged app.asar file URL');
  }
  if (renderer.protocol !== 'file:'
    || path.normalize(decodeURIComponent(renderer.pathname)) !== path.normalize(expectedRendererPath)) {
    throw new Error('renderer must use the packaged app.asar file URL');
  }
  const gatewayOrigin = productionGatewayOrigin(options.gateway);
  const gatewayProbe = await probeGateway(gatewayOrigin, dependencies.fetchImpl || fetch);
  const gatewayIdentity = matchingGatewayIdentity(gatewayProbe.gatewayStatus, requested);
  if (!gatewayIdentity) {
    throw new Error('gateway-status build identity must match requested source SHA');
  }
  const now = dependencies.now || (() => new Date().toISOString());
  const receipt = {
    schemaVersion: 1,
    kind: 'first_user_production_freeze',
    mode: options.mode,
    readyToFreeze: true,
    checkedAt: now(),
    sourceSha: requested,
    packaged: {
      appBundle: path.basename(appPath),
      renderer: `file://…/${path.basename(appPath)}/Contents/Resources/app.asar/dist/index.html`,
      metadataSourceSha: requested,
      rendererBuildId,
      asarSha256: createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex'),
      codesignDeepStrict: true,
    },
    railway: {
      origin: gatewayOrigin,
      healthStatus: 200,
      readyStatus: 200,
      gatewayStatus: 200,
      identityField: gatewayIdentity.field,
      buildIdentity: gatewayIdentity.value,
    },
  };
  if (options.mode === 'write') {
    const receiptPath = path.resolve(options.receiptPath || path.join(
      REPOSITORY_ROOT,
      'docs',
      'qa',
      'first-user-production',
      '2026-08-16',
      'frozen-identity-receipt.json',
    ));
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const temporaryPath = `${receiptPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryPath, receiptPath);
  }
  return receipt;
}

function parseArguments(values, environment = process.env) {
  let mode = '';
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--check' || argument === '--write') {
      if (mode) throw new Error('choose exactly one of --check or --write');
      mode = argument.slice(2);
      continue;
    }
    if (!['--app', '--gateway', '--source-sha', '--receipt'].includes(argument)) {
      throw new Error('invalid freeze argument');
    }
    const value = values[index + 1];
    if (value === undefined) throw new Error('freeze argument value is required');
    flags[argument.slice(2)] = value;
    index += 1;
  }
  if (!mode) throw new Error('choose exactly one of --check or --write');
  return {
    mode,
    sourceSha: flags['source-sha'] || environment.AGENT_CALENDAR_SOURCE_SHA || '',
    appPath: flags.app || '',
    gateway: flags.gateway || '',
    receiptPath: flags.receipt || '',
  };
}

async function main(values = process.argv.slice(2), environment = process.env) {
  try {
    const receipt = await runFreeze(parseArguments(values, environment));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'freeze verification failed';
    process.stderr.write(`freeze failed: ${message}\n`);
    return 1;
  }
}

module.exports = { main, parseArguments, runFreeze };

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
