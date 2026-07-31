'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const desktopRoot = path.resolve(__dirname, '..');
const evidenceDirectory = process.env.AGENT_CALENDAR_LIVE_KEYCHAIN_EVIDENCE
  ? path.resolve(process.env.AGENT_CALENDAR_LIVE_KEYCHAIN_EVIDENCE)
  : path.join(desktopRoot, 'test-results', 'live-keychain-source');
const userDataName = `Agent Calendar Live Keychain ${process.pid}`;
const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', userDataName);
const sessionPath = path.join(userDataPath, 'app-session.enc');
const snapshotPath = path.join(userDataPath, 'workspace-snapshot.enc');
const settingsPath = path.join(userDataPath, 'settings.json');
const mainPath = path.join(desktopRoot, 'dist-electron', 'main.js');
const fixtureSession = {
  accessToken: 'live-keychain-fixture-access',
  refreshToken: 'live-keychain-fixture-refresh',
  accessExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshExpiresAt: '2099-01-02T00:00:00.000Z',
  sessionId: 'live-keychain-fixture-session',
  userId: 'live-keychain-fixture-user',
  workspaceId: 'live-keychain-fixture-workspace',
  role: 'owner',
  user: { id: 'live-keychain-fixture-user', email: null, displayName: 'Live Keychain Fixture' },
  updatedAt: '2026-07-26T00:00:00.000Z',
};
const fixtureSnapshot = { privateTitle: 'Live Keychain Workspace Snapshot' };

const {
  AGENT_CALENDAR_E2E_AUTH: _e2eAuth,
  AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE: _allowTestStorage,
  AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY: _testStorageKey,
  AGENT_CALENDAR_E2E_SECURE_STORAGE_PID: _testStoragePid,
  AGENT_CALENDAR_LIVE_KEYCHAIN_RECEIPT: _liveKeychainReceipt,
  ...ordinaryEnvironment
} = process.env;

function launchEnvironment() {
  return {
    ...ordinaryEnvironment,
    AGENT_CALENDAR_USER_DATA_NAME: userDataName,
    AGENT_CALENDAR_LIVE_KEYCHAIN_RECEIPT: '1',
    VITE_DEV_SERVER_URL: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
}

async function closeApp(application) {
  if (!application) return;
  try {
    await application.evaluate(({ app }) => app.exit(0));
  } catch {
  }
  await application.close().catch(() => {});
}

function writeResult(result) {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(evidenceDirectory, 'ordinary-source-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

function redactDiagnostic(value) {
  return String(value)
    .replace(/\/Users\/[^\s"']+/g, '<path>')
    .replace(/"(workspaceId|userId|sessionId)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"')
    .slice(0, 240);
}

function assertSuccessfulReceiptConsistency(result) {
  assert.equal(
    Object.hasOwn(result, 'encryptedOnDisk'),
    false,
    'successful receipt must not carry a legacy aggregate encryption field',
  );
  assert.deepEqual(
    result.encryptedFiles,
    { session: true, snapshot: true },
    'successful receipt must report both encrypted files as plaintext-free',
  );
}

async function launchOrdinarySourceApp() {
  assert.equal(fs.existsSync(mainPath), true, 'build Electron before live Keychain source smoke');
  return electron.launch({
    args: [mainPath],
    cwd: desktopRoot,
    env: launchEnvironment(),
  });
}

async function main() {
  let firstApplication;
  let secondApplication;
  let lifecycleLogPath = '';
  let lifecycleLogStartBytes = 0;
  const consoleMessages = [];
  const qaOverrideAbsent = [
    'AGENT_CALENDAR_E2E_AUTH',
    'AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE',
    'AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY',
    'AGENT_CALENDAR_E2E_SECURE_STORAGE_PID',
  ].every((name) => launchEnvironment()[name] === undefined);
  const result = {
    ok: false,
    qaOverrideAbsent,
    firstLaunchBooted: false,
    secondLaunchBooted: false,
    appOwnedBootReceipt: null,
    appOwnedAfterSaveReceipt: null,
    appOwnedBeforeSnapshotReadReceipt: null,
    appOwnedAfterSnapshotReadReceipt: null,
    appOwnedFixtureSaved: false,
    sessionRestored: false,
    sessionStatusObserved: false,
    sessionStatusSignedIn: false,
    encryptedFiles: { session: false, snapshot: false },
    snapshotRestored: false,
    lifecycle: { logObserved: false, sessionRestored: false, sessionRestoreFailed: false, profileCleared: false },
    rendererKeychainErrors: 0,
    keychainDiagnostics: [],
    cleanup: { userDataRemoved: false },
  };

  fs.rmSync(userDataPath, { recursive: true, force: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    apiBaseUrl: '',
    apiToken: '',
    theme: 'default',
    auth: null,
    uiPreferences: { notify: false, agentShare: false, weekStartMon: true },
  }, null, 2)}\n`);

  try {
    assert.equal(result.qaOverrideAbsent, true, 'live source smoke must not launch with an AuthKit QA secure-storage flag');
    firstApplication = await launchOrdinarySourceApp();
    const firstPage = await firstApplication.firstWindow();
    firstPage.on('console', (message) => consoleMessages.push(message.text()));
    await firstPage.locator('.app-root').waitFor({ state: 'visible', timeout: 20_000 });
    await firstPage.screenshot({ path: path.join(evidenceDirectory, 'ordinary-source-first-launch.png'), fullPage: true });
    result.firstLaunchBooted = true;
    result.appOwnedBootReceipt = await firstApplication.evaluate(() => {
      const diagnostics = globalThis.__agentCalendarLiveKeychain;
      return diagnostics?.getSecureStorageReceipt?.() || null;
    });
    assert.notEqual(result.appOwnedBootReceipt, null, 'current-source live diagnostic receipt must be available');
    assert.deepEqual(result.appOwnedBootReceipt, {
      backend: 'electron-safe-storage',
      nativeSafeStorageCallCount: 0,
      nativeSafeStorageCalls: { availability: 0, encrypt: 0, decrypt: 0 },
    }, 'ordinary empty boot must make zero app-owned native storage calls');
    const firstLogsDirectory = await firstApplication.evaluate(({ app }) => app.getPath('logs'));
    lifecycleLogPath = path.join(firstLogsDirectory, 'main.log');
    lifecycleLogStartBytes = fs.existsSync(lifecycleLogPath) ? fs.statSync(lifecycleLogPath).size : 0;
    const savedFixture = await firstApplication.evaluate(() => {
      const diagnostics = globalThis.__agentCalendarLiveKeychain;
      return diagnostics?.saveFixture?.() || null;
    });
    result.appOwnedFixtureSaved = Boolean(savedFixture?.snapshotSaved);
    assert.deepEqual(savedFixture, {
      sessionId: fixtureSession.sessionId,
      workspaceId: fixtureSession.workspaceId,
      snapshotSaved: true,
    }, 'the current app must save the fixture session and Workspace snapshot through its production stores');
    result.appOwnedAfterSaveReceipt = await firstApplication.evaluate(() => {
      const diagnostics = globalThis.__agentCalendarLiveKeychain;
      return diagnostics?.getSecureStorageReceipt?.() || null;
    });
    assert.deepEqual(result.appOwnedAfterSaveReceipt, {
      backend: 'electron-safe-storage',
      nativeSafeStorageCallCount: 4,
      nativeSafeStorageCalls: { availability: 2, encrypt: 2, decrypt: 0 },
    }, 'app-owned fixture save must use native availability and encryption exactly once per persisted store');
    const rawSession = fs.readFileSync(sessionPath);
    const rawSnapshot = fs.readFileSync(snapshotPath);
    result.encryptedFiles = {
      session: !rawSession.includes(fixtureSession.accessToken),
      snapshot: !rawSnapshot.includes(fixtureSnapshot.privateTitle),
    };
    assert.deepEqual(result.encryptedFiles, { session: true, snapshot: true }, 'app-owned session and snapshot files must remain encrypted on disk');

    await closeApp(firstApplication);
    firstApplication = undefined;

    secondApplication = await launchOrdinarySourceApp();
    const secondPage = await secondApplication.firstWindow();
    secondPage.on('console', (message) => consoleMessages.push(message.text()));
    await secondPage.locator('.app-root').waitFor({ state: 'visible', timeout: 20_000 });
    await secondPage.waitForTimeout(1_500);
    const sessionStatus = await secondPage.evaluate(() => window.hermesDesktop?.getSessionStatus?.());
    result.appOwnedBeforeSnapshotReadReceipt = await secondApplication.evaluate(() => {
      const diagnostics = globalThis.__agentCalendarLiveKeychain;
      return diagnostics?.getSecureStorageReceipt?.() || null;
    });
    const restoredSnapshot = await secondPage.evaluate(() => window.hermesDesktop?.readWorkspaceSnapshot?.());
    result.appOwnedAfterSnapshotReadReceipt = await secondApplication.evaluate(() => {
      const diagnostics = globalThis.__agentCalendarLiveKeychain;
      return diagnostics?.getSecureStorageReceipt?.() || null;
    });
    const logsDirectory = await secondApplication.evaluate(({ app }) => app.getPath('logs'));
    const logFile = path.join(logsDirectory, 'main.log');
    const lifecycleLog = fs.existsSync(logFile)
      ? fs.readFileSync(logFile).subarray(logFile === lifecycleLogPath ? lifecycleLogStartBytes : 0).toString('utf8')
      : '';
    result.secondLaunchBooted = true;
    result.sessionStatusObserved = Boolean(sessionStatus);
    result.sessionStatusSignedIn = Boolean(sessionStatus?.signedIn);
    result.lifecycle = {
      logObserved: fs.existsSync(logFile),
      sessionRestored: lifecycleLog.includes('session-restored'),
      sessionRestoreFailed: lifecycleLog.includes('session-restore-failed'),
      profileCleared: lifecycleLog.includes('legacy-auth-scrubbed'),
    };
    result.sessionRestored = Boolean(sessionStatus?.signedIn && sessionStatus.sessionId === fixtureSession.sessionId);
    assert.equal(result.sessionRestored, true, 'ordinary source relaunch must restore the encrypted native session');
    result.snapshotRestored = Boolean(restoredSnapshot?.data?.privateTitle === fixtureSnapshot.privateTitle);
    assert.equal(result.snapshotRestored, true, 'renderer Workspace snapshot IPC must restore the encrypted native snapshot');
    assert.equal(result.appOwnedBeforeSnapshotReadReceipt?.backend, 'electron-safe-storage');
    assert.equal(result.appOwnedBeforeSnapshotReadReceipt?.nativeSafeStorageCalls?.decrypt >= 1, true, 'relaunch must decrypt the saved session through native storage');
    assert.deepEqual(result.appOwnedAfterSnapshotReadReceipt?.nativeSafeStorageCalls, {
      availability: result.appOwnedBeforeSnapshotReadReceipt.nativeSafeStorageCalls.availability + 1,
      encrypt: result.appOwnedBeforeSnapshotReadReceipt.nativeSafeStorageCalls.encrypt,
      decrypt: result.appOwnedBeforeSnapshotReadReceipt.nativeSafeStorageCalls.decrypt + 1,
    }, 'renderer snapshot IPC must add exactly one native availability and decryption call');
    await secondPage.screenshot({ path: path.join(evidenceDirectory, 'ordinary-source-relaunch.png'), fullPage: true });

    const lifecycleMessages = lifecycleLog.split(/\r?\n/g).filter(Boolean);
    const keychainMessages = [...consoleMessages, ...lifecycleMessages]
      .filter((message) => {
        const withoutUserData = String(message).replace(/"userData"\s*:\s*"[^"]*"/, '');
        const withoutIdentifiers = withoutUserData.replace(/"(workspaceId|userId|sessionId)"\s*:\s*"[^"]*"/g, '');
        return /keychain|safe\s*storage|secure session storage is unavailable/i.test(withoutIdentifiers);
      });
    result.rendererKeychainErrors = keychainMessages.length;
    result.keychainDiagnostics = keychainMessages.map(redactDiagnostic);
    assert.equal(result.rendererKeychainErrors, 0, 'ordinary source launch must not emit a Keychain or safe-storage error');
    assertSuccessfulReceiptConsistency(result);
    result.ok = true;
  } finally {
    await closeApp(secondApplication);
    await closeApp(firstApplication);
    fs.rmSync(userDataPath, { recursive: true, force: true });
    result.cleanup.userDataRemoved = !fs.existsSync(userDataPath);
    writeResult(result);
  }
}

module.exports = { assertSuccessfulReceiptConsistency };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
