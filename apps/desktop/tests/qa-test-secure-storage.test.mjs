import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const qaStorage = await vite.ssrLoadModule('/electron/qaTestSecureStorage.ts');
const secureSession = await vite.ssrLoadModule('/electron/secureSession.ts');
const workspaceSnapshot = await vite.ssrLoadModule('/electron/workspaceSnapshot.ts');
const tempDirs = [];

after(async () => {
  await vite.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function nativeStorageSpy() {
  const calls = { encryptionAvailable: 0, encrypt: 0, decrypt: 0 };
  return {
    calls,
    storage: {
      isEncryptionAvailable: () => {
        calls.encryptionAvailable += 1;
        return true;
      },
      encryptString: (plain) => {
        calls.encrypt += 1;
        return Buffer.from(`native:${plain}`, 'utf8');
      },
      decryptString: (encrypted) => {
        calls.decrypt += 1;
        return encrypted.toString('utf8').replace(/^native:/, '');
      },
    },
  };
}

function validEnvironment(overrides = {}) {
  const pid = '4242';
  return {
    AGENT_CALENDAR_E2E_AUTH: '1',
    AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE: '1',
    AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY: Buffer.alloc(32, 7).toString('base64url'),
    AGENT_CALENDAR_E2E_SECURE_STORAGE_PID: pid,
    AGENT_CALENDAR_USER_DATA_NAME: `Agent Calendar AuthKit E2E ${pid}`,
    ...overrides,
  };
}

function receipt(backend, nativeSafeStorageCallCount, nativeSafeStorageCalls) {
  return { backend, nativeSafeStorageCallCount, nativeSafeStorageCalls };
}

test('production/default selection stays on Electron native secure storage', () => {
  const native = nativeStorageSpy();
  const selected = qaStorage.createQaTestSecureStorage({ nativeStorage: native.storage, environment: {} });
  assert.deepEqual(selected.getReceipt(), receipt('electron-safe-storage', 0, {
    availability: 0,
    encrypt: 0,
    decrypt: 0,
  }));
  assert.equal(selected.storage.isEncryptionAvailable(), true);
  assert.deepEqual(native.calls, { encryptionAvailable: 1, encrypt: 0, decrypt: 0 });
  assert.deepEqual(selected.getReceipt(), receipt('electron-safe-storage', 1, {
    availability: 1,
    encrypt: 0,
    decrypt: 0,
  }));
});

test('explicit QA selection fails closed without a canonical 32-byte key or PID-scoped name', () => {
  const native = nativeStorageSpy();
  for (const environment of [
    validEnvironment({ AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY: '' }),
    validEnvironment({ AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY: Buffer.alloc(31, 7).toString('base64url') }),
    validEnvironment({ AGENT_CALENDAR_USER_DATA_NAME: 'Agent Calendar' }),
    validEnvironment({ AGENT_CALENDAR_E2E_SECURE_STORAGE_PID: 'not-a-pid' }),
  ]) {
    assert.throws(
      () => qaStorage.createQaTestSecureStorage({ nativeStorage: native.storage, environment }),
      /Explicit QA secure storage requires/,
    );
  }
  assert.deepEqual(native.calls, { encryptionAvailable: 0, encrypt: 0, decrypt: 0 });
});

test('explicit QA backend keeps session and Workspace snapshot encrypted across relaunch without native calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-qa-storage-'));
  tempDirs.push(dir);
  const native = nativeStorageSpy();
  const environment = validEnvironment();
  const firstLaunch = qaStorage.createQaTestSecureStorage({ nativeStorage: native.storage, environment });
  const session = secureSession.createSecureSessionManager({ userDataPath: dir, storage: firstLaunch.storage });
  const snapshot = workspaceSnapshot.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: firstLaunch.storage,
    now: () => Date.parse('2026-07-26T00:00:00.000Z'),
  });
  session.save({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    accessExpiresAt: '2026-07-27T00:00:00.000Z',
    sessionId: 'session-qa',
    userId: 'user-qa',
    workspaceId: 'workspace-qa',
    role: 'owner',
    updatedAt: '2026-07-26T00:00:00.000Z',
  });
  snapshot.save({ userId: 'user-qa', workspaceId: 'workspace-qa' }, { privateTitle: 'Private calendar title' });

  const encryptedSession = fs.readFileSync(path.join(dir, 'app-session.enc'));
  const encryptedSnapshot = fs.readFileSync(path.join(dir, 'workspace-snapshot.enc'));
  assert.equal(encryptedSession.includes('access-secret'), false);
  assert.equal(encryptedSnapshot.includes('Private calendar title'), false);

  const relaunched = qaStorage.createQaTestSecureStorage({ nativeStorage: native.storage, environment });
  const restoredSession = secureSession.createSecureSessionManager({ userDataPath: dir, storage: relaunched.storage });
  const restoredSnapshot = workspaceSnapshot.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: relaunched.storage,
    now: () => Date.parse('2026-07-26T00:00:00.000Z'),
  });
  assert.equal(restoredSession.load()?.accessToken, 'access-secret');
  assert.deepEqual(restoredSnapshot.read({ userId: 'user-qa', workspaceId: 'workspace-qa' })?.data, {
    privateTitle: 'Private calendar title',
  });
  assert.deepEqual(firstLaunch.getReceipt(), receipt('qa-aes-256-gcm', 0, {
    availability: 0,
    encrypt: 0,
    decrypt: 0,
  }));
  assert.deepEqual(relaunched.getReceipt(), receipt('qa-aes-256-gcm', 0, {
    availability: 0,
    encrypt: 0,
    decrypt: 0,
  }));
  assert.deepEqual(native.calls, { encryptionAvailable: 0, encrypt: 0, decrypt: 0 });
});
