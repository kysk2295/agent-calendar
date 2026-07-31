import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, '..');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8');
const authKitSmokeSource = fs.readFileSync(path.join(testDir, 'playwright-workos-authkit-login-e2e.cjs'), 'utf8');
const packagedSmokeSource = fs.readFileSync(path.join(testDir, 'packaged-deep-link-smoke.cjs'), 'utf8');

test('QA composition never reaches native Keychain through direct probe or default stores', () => {
  assert.match(
    mainSource,
    /const secureStorage = createQaTestSecureStorage\(\{ nativeStorage: safeStorage \}\);/,
    'main process must resolve one QA-aware storage adapter',
  );
  assert.match(
    mainSource,
    /createWorkspaceSnapshotStore\(\{ storage: secureStorage\.storage \}\)/,
    'Workspace snapshot must receive the resolved shared adapter',
  );
  assert.match(
    mainSource,
    /createSecureSessionManager\(\{\s*storage: secureStorage\.storage,/s,
    'secure session must receive the resolved shared adapter',
  );
  assert.doesNotMatch(
    mainSource,
    /const workspaceSnapshotStore = createWorkspaceSnapshotStore\(\);/,
    'QA launch currently leaves Workspace snapshot storage on its native safeStorage default',
  );
  assert.doesNotMatch(
    mainSource,
    /createSecureSessionManager\(\{\s*apiBaseUrl:/s,
    'QA launch currently leaves secure session storage on its native safeStorage default',
  );
  assert.doesNotMatch(
    authKitSmokeSource,
    /safeStorage\?\.isEncryptionAvailable\?\.\(\)/,
    'AuthKit QA currently makes a direct native safeStorage/Keychain probe',
  );
  assert.doesNotMatch(
    packagedSmokeSource,
    /safeStorage\?\.isEncryptionAvailable\?\.\(\)/,
    'packaged deep-link QA currently makes a direct native safeStorage/Keychain probe',
  );
  for (const source of [authKitSmokeSource, packagedSmokeSource]) {
    assert.match(source, /AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE: '1'/);
    assert.match(source, /AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY: testSecureStorageKey/);
    assert.match(source, /AGENT_CALENDAR_E2E_SECURE_STORAGE_PID: String\(process\.pid\)/);
    assert.match(source, /getSecureStorageReceipt\(\)/);
  }
});

test('packaged smoke closes Settings through the current accessible header control', () => {
  assert.match(
    packagedSmokeSource,
    /getByRole\('button', \{ name: '설정 닫기' \}\)\.click\(\)/,
  );
  assert.doesNotMatch(
    packagedSmokeSource,
    /\.settings-overlay footer[\s\S]*name: '완료'/,
  );
});

test('packaged smoke expands the workspace navigation before clicking secondary surfaces', () => {
  assert.match(
    packagedSmokeSource,
    /const secondaryNavigation = window\.locator\('details\.nav-more'\);[\s\S]*secondaryNavigation\.locator\('summary'\)\.click\(\);[\s\S]*for \(const \[navigationLabel, heading, contentSelector\] of surfaces\)/,
  );
});

test('packaged smoke records SHA-bound screenshots for deep-link, surface, and widget states', () => {
  assert.match(packagedSmokeSource, /cold-launch\.png/);
  assert.match(packagedSmokeSource, /packaged-surfaces\.png/);
  assert.match(packagedSmokeSource, /widget-toggle\.png/);
  assert.match(packagedSmokeSource, /screenshots,/);
});
