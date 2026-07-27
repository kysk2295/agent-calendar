import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
const secureSession = await vite.ssrLoadModule('/electron/secureSession.ts');
const workspaceSnapshot = await vite.ssrLoadModule('/electron/workspaceSnapshot.ts');
const temporaryDirectories = [];

after(async () => {
  await vite.close();
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function emptyUserDataDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-live-keychain-startup-'));
  temporaryDirectories.push(directory);
  return directory;
}

function nativeStorageProbe() {
  let availabilityCalls = 0;
  return {
    storage: {
      isEncryptionAvailable: () => {
        availabilityCalls += 1;
        return true;
      },
      encryptString: () => {
        throw new Error('unexpected encryption for empty storage');
      },
      decryptString: () => {
        throw new Error('unexpected decryption for empty storage');
      },
    },
    availabilityCalls: () => availabilityCalls,
  };
}

function encryptedStorageProbe() {
  const key = randomBytes(32);
  let availabilityCalls = 0;
  return {
    storage: {
      isEncryptionAvailable: () => {
        availabilityCalls += 1;
        return true;
      },
      encryptString: (plain) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString: (encrypted) => {
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
      },
    },
    availabilityCalls: () => availabilityCalls,
  };
}

test('PIN: ordinary signed-out boot returns no persisted session or snapshot', () => {
  const directory = emptyUserDataDirectory();
  const probe = nativeStorageProbe();
  const session = secureSession.createSecureSessionManager({ userDataPath: directory, storage: probe.storage });
  const snapshot = workspaceSnapshot.createWorkspaceSnapshotStore({ userDataPath: directory, storage: probe.storage });

  assert.equal(session.load(), null);
  assert.equal(snapshot.read({ userId: 'user-live', workspaceId: 'workspace-live' }), null);
});

test('RED: ordinary empty-store boot never reaches native secure storage', () => {
  const directory = emptyUserDataDirectory();
  const probe = nativeStorageProbe();
  const session = secureSession.createSecureSessionManager({ userDataPath: directory, storage: probe.storage });
  const snapshot = workspaceSnapshot.createWorkspaceSnapshotStore({ userDataPath: directory, storage: probe.storage });

  assert.equal(session.load(), null);
  assert.equal(snapshot.read({ userId: 'user-live', workspaceId: 'workspace-live' }), null);
  assert.equal(probe.availabilityCalls(), 0, 'missing encrypted files must not touch native Keychain storage');
});

test('empty ordinary store stays signed out when a native Keychain availability check would throw', () => {
  const directory = emptyUserDataDirectory();
  const failingStorage = {
    isEncryptionAvailable: () => {
      throw new Error('macOS Keychain access denied');
    },
    encryptString: () => {
      throw new Error('unexpected encryption for empty storage');
    },
    decryptString: () => {
      throw new Error('unexpected decryption for empty storage');
    },
  };
  const session = secureSession.createSecureSessionManager({ userDataPath: directory, storage: failingStorage });
  const snapshot = workspaceSnapshot.createWorkspaceSnapshotStore({ userDataPath: directory, storage: failingStorage });

  assert.equal(session.load(), null);
  assert.equal(snapshot.read({ userId: 'user-live', workspaceId: 'workspace-live' }), null);
});

test('existing encrypted session and snapshot still use storage and restore after relaunch', () => {
  const directory = emptyUserDataDirectory();
  const probe = encryptedStorageProbe();
  const owner = { userId: 'user-live', workspaceId: 'workspace-live' };
  const firstSession = secureSession.createSecureSessionManager({ userDataPath: directory, storage: probe.storage });
  const firstSnapshot = workspaceSnapshot.createWorkspaceSnapshotStore({ userDataPath: directory, storage: probe.storage });
  firstSession.save({
    accessToken: 'fixture-access-token',
    refreshToken: 'fixture-refresh-token',
    accessExpiresAt: '2026-08-01T00:00:00.000Z',
    sessionId: 'session-live',
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    role: 'owner',
    updatedAt: '2026-07-26T00:00:00.000Z',
  });
  firstSnapshot.save(owner, { privateTitle: 'restored encrypted snapshot' });

  const relaunchedSession = secureSession.createSecureSessionManager({ userDataPath: directory, storage: probe.storage });
  const relaunchedSnapshot = workspaceSnapshot.createWorkspaceSnapshotStore({ userDataPath: directory, storage: probe.storage });
  assert.equal(relaunchedSession.load()?.sessionId, 'session-live');
  assert.equal(relaunchedSnapshot.read(owner)?.data.privateTitle, 'restored encrypted snapshot');
  assert.ok(probe.availabilityCalls() >= 4, 'existing encrypted files must continue to use secure storage');
});

test('malformed existing encrypted session fails closed after one secure-storage check', () => {
  const directory = emptyUserDataDirectory();
  const probe = nativeStorageProbe();
  fs.writeFileSync(path.join(directory, 'app-session.enc'), Buffer.from('malformed-ciphertext'), { mode: 0o600 });
  const session = secureSession.createSecureSessionManager({ userDataPath: directory, storage: probe.storage });

  assert.equal(session.load(), null);
  assert.equal(probe.availabilityCalls(), 1);
});
