'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, '..', '..');
const DEFAULT_APP_PATH = path.join(DESKTOP_ROOT, 'release', 'mac-arm64', 'Agent Calendar.app');
const PRODUCTION_GATEWAY = 'https://hermes-os-production-e174.up.railway.app';
const EVIDENCE_ROOT = path.join(
  REPOSITORY_ROOT,
  'docs',
  'qa',
  'first-user-production',
  '2026-08-16',
);
const EVIDENCE_PATH = path.join(EVIDENCE_ROOT, 'wave5-packaged-smoke.json');
const SCREENSHOT_ROOT = path.join(EVIDENCE_ROOT, 'screenshots', 'wave5');

function packagedPaths() {
  const configured = String(process.env.AGENT_CALENDAR_PACKAGED_APP_PATH || '').trim();
  const appPath = path.resolve(configured || DEFAULT_APP_PATH);
  return {
    appPath,
    executablePath: path.join(appPath, 'Contents', 'MacOS', 'Agent Calendar'),
    asarPath: path.join(appPath, 'Contents', 'Resources', 'app.asar'),
    rendererPath: path.join(appPath, 'Contents', 'Resources', 'app.asar', 'dist', 'index.html'),
  };
}

function requirePackagedApp() {
  const paths = packagedPaths();
  const missing = [paths.appPath, paths.executablePath, paths.asarPath].filter(
    (candidate) => !fs.existsSync(candidate),
  );
  if (process.platform !== 'darwin' || missing.length) {
    console.error(`packaged app required: ${paths.appPath}`);
    return null;
  }
  return paths;
}

function assertPackagedRendererUrl(rendererUrl, expectedRendererPath) {
  const parsed = new URL(rendererUrl);
  assert.equal(parsed.protocol, 'file:', 'production evidence must use a file: renderer');
  assert.equal(
    path.normalize(decodeURIComponent(parsed.pathname)),
    path.normalize(expectedRendererPath),
    'renderer must come from Contents/Resources/app.asar/dist/index.html',
  );
}

function staticContract() {
  const example = path.join('/Applications', 'Agent Calendar.app', 'Contents', 'Resources', 'app.asar', 'dist', 'index.html');
  assertPackagedRendererUrl(new URL(`file://${example}`).href, example);
  assert.equal(DEFAULT_APP_PATH.endsWith(path.join('release', 'mac-arm64', 'Agent Calendar.app')), true);
  assert.equal(PRODUCTION_GATEWAY.startsWith('https://'), true);
  console.log(JSON.stringify({ ok: true, packagedOnly: true, viteFallback: false }));
}

function sourceSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim();
}

function mergeEvidence(scenario, receipt) {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
  } catch {
    current = {};
  }
  const next = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harnessSourceSha: sourceSha(),
    liveProduction: true,
    fixtureEvidence: false,
    scenarios: { ...(current.scenarios || {}), [scenario]: receipt },
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
}

async function screenshot(page, name) {
  fs.mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  const target = path.join(SCREENSHOT_ROOT, name);
  await page.screenshot({ path: target, fullPage: true });
  return {
    path: path.relative(EVIDENCE_ROOT, target),
    sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
  };
}

async function visibleCopy(page) {
  const candidates = page.locator([
    '.loading',
    '.api-banner',
    '.desktop-connectivity',
    '.task-empty',
    '.plan-empty',
    '.search-empty',
    '.widget-empty',
    '[role="alert"]',
  ].join(','));
  const copy = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      const text = String(await candidate.textContent() || '').trim();
      if (text) copy.push(text.replace(/\s+/g, ' '));
    }
  }
  return [...new Set(copy)];
}

async function waitForManualAuth(page) {
  if (await page.locator('.sidebar').isVisible().catch(() => false)) return true;
  const login = page.getByRole('button', { name: /AuthKit으로 계속하기/ }).first();
  if (await login.isVisible().catch(() => false)) {
    console.log('Manual checkpoint: finish real AuthKit OAuth in the system browser.');
    await login.click();
  }
  const timeoutMs = Math.max(
    1_000,
    Number(process.env.AGENT_CALENDAR_MANUAL_CHECKPOINT_TIMEOUT_MS || 180_000),
  );
  return page.locator('.sidebar').waitFor({ timeout: timeoutMs }).then(() => true, () => false);
}

async function openPackagedApp(scenario) {
  const paths = requirePackagedApp();
  if (!paths) return { exitCode: 2 };
  if (process.env.VITE_DEV_SERVER_URL) {
    throw new Error('VITE_DEV_SERVER_URL is forbidden for packaged production evidence');
  }

  const { _electron: electron } = require('playwright');
  const userDataName = `Agent Calendar Wave5 ${scenario} ${process.pid}`;
  const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
  const launchEnvironment = { ...process.env, AGENT_CALENDAR_USER_DATA_NAME: userDataName };
  delete launchEnvironment.VITE_DEV_SERVER_URL;
  delete launchEnvironment.AGENT_CALENDAR_E2E_AUTH;
  delete launchEnvironment.AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE;

  fs.rmSync(userDataPath, { recursive: true, force: true });
  let electronApp;
  let page;
  try {
    electronApp = await electron.launch({
      executablePath: paths.executablePath,
      env: launchEnvironment,
    });
    page = await electronApp.firstWindow();
    await page.locator('.app-root').waitFor({ timeout: 30_000 });
    assertPackagedRendererUrl(page.url(), paths.rendererPath);
    const settings = await page.evaluate(() => window.hermesDesktop?.getSettings?.());
    assert.equal(settings?.apiBaseUrl, PRODUCTION_GATEWAY, 'isolated packaged run must target production Railway');

    const signedIn = await waitForManualAuth(page);
    if (!signedIn) {
      const blockedScreenshot = await screenshot(page, `${scenario}-external-blocked.png`);
      mergeEvidence(scenario, {
        status: 'EXTERNAL_BLOCKED',
        reason: 'real AuthKit manual checkpoint unavailable',
        packagedApp: true,
        rendererUrl: page.url(),
        productionGateway: PRODUCTION_GATEWAY,
        screenshot: blockedScreenshot,
      });
      await electronApp.close().catch(() => undefined);
      fs.rmSync(userDataPath, { recursive: true, force: true });
      return { exitCode: 2 };
    }
    return { exitCode: 0, electronApp, page, paths, userDataPath };
  } catch (error) {
    if (page) {
      const failedScreenshot = await screenshot(page, `${scenario}-failed.png`).catch(() => null);
      mergeEvidence(scenario, {
        status: 'FAIL',
        error: error instanceof Error ? error.message : String(error),
        screenshot: failedScreenshot,
      });
    }
    if (electronApp) await electronApp.close().catch(() => undefined);
    fs.rmSync(userDataPath, { recursive: true, force: true });
    throw error;
  }
}

async function closePackagedApp(context) {
  await context.electronApp.close().catch(() => undefined);
  fs.rmSync(context.userDataPath, { recursive: true, force: true });
}

async function main() {
  if (process.argv.includes('--static-contract')) {
    staticContract();
    return 0;
  }
  const context = await openPackagedApp('folderless');
  if (context.exitCode !== 0) return context.exitCode;
  try {
    const settings = await context.page.evaluate(() => window.hermesDesktop?.getSettings?.());
    assert.equal(settings?.hasWikiVault, false, 'isolated first-user run must stay folderless');
    const receipt = {
      status: 'PASS',
      packagedApp: true,
      rendererUrl: context.page.url(),
      productionGateway: PRODUCTION_GATEWAY,
      hasWikiVault: false,
      visibleCopy: await visibleCopy(context.page),
      screenshot: await screenshot(context.page, 'folderless.png'),
    };
    mergeEvidence('folderless', receipt);
    console.log(JSON.stringify(receipt));
    return 0;
  } finally {
    await closePackagedApp(context);
  }
}

module.exports = {
  DESKTOP_ROOT,
  closePackagedApp,
  mergeEvidence,
  openPackagedApp,
  screenshot,
  visibleCopy,
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
