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
const secure = await vite.ssrLoadModule('/electron/secureSession.ts');
const sessionTruth = await vite.ssrLoadModule('/electron/sessionTruth.ts');

const tempDirs = [];
after(async () => {
  await vite.close();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    decryptString: (buffer) => {
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const data = buffer.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

test('secure session stores encrypted tokens with atomic 0600 file and never plaintext JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-secure-session-'));
  tempDirs.push(dir);
  let clearCount = 0;
  const manager = secure.createSecureSessionManager({
    userDataPath: dir,
    storage: fakeStorage(),
    onCleared: () => {
      clearCount += 1;
    },
  });
  const saved = manager.save({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    sessionId: 'sess_1',
    userId: 'user_1',
    workspaceId: 'ws_1',
    role: 'owner',
    user: { id: 'user_1', email: 'a@example.com', displayName: 'A' },
    updatedAt: new Date().toISOString(),
  });
  assert.equal(saved.accessToken, 'access-secret');
  const file = path.join(dir, 'app-session.enc');
  assert.equal(fs.existsSync(file), true);
  const raw = fs.readFileSync(file);
  assert.equal(raw.includes('access-secret'), false);
  assert.doesNotMatch(raw.toString('utf8'), /access-secret|refresh-secret/);
  const mode = fs.statSync(file).mode & 0o777;
  // On some hosts umask may widen; require owner-only write at least.
  assert.equal(mode & 0o022, 0, `expected no group/other write bits, got ${mode.toString(8)}`);

  const publicStatus = manager.getPublicStatus();
  assert.equal(publicStatus.signedIn, true);
  assert.equal(publicStatus.email, 'a@example.com');
  assert.equal(JSON.stringify(publicStatus).includes('access-secret'), false);

  manager.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(manager.getPublicStatus().signedIn, false);
  assert.equal(clearCount, 1);
});

test('scrubLegacyPlaintextAuthSettings removes tokens from settings without deleting auth-users.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scrub-'));
  tempDirs.push(dir);
  const settingsPath = path.join(dir, 'settings.json');
  const usersPath = path.join(dir, 'auth-users.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    apiBaseUrl: 'https://example.test',
    apiToken: 'legacy-bearer',
    theme: 'default',
    auth: {
      provider: 'google',
      id: 'g1',
      email: 'x@example.com',
      name: 'X',
      accessToken: 'google-at',
      refreshToken: 'google-rt',
      idToken: 'google-id',
    },
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2));
  fs.writeFileSync(usersPath, JSON.stringify({ users: [{ email: 'x@example.com' }] }, null, 2));

  const result = secure.scrubLegacyPlaintextAuthSettings(settingsPath);
  assert.equal(result.scrubbed, true);
  assert.equal(result.hadSecrets, true);
  const next = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(next.apiToken, '');
  assert.equal(next.auth, null);
  assert.doesNotMatch(JSON.stringify(next), /legacy-bearer|google-at|google-rt/);
  // Leave unread legacy password file present.
  assert.equal(fs.existsSync(usersPath), true);
});

test('scrubLegacyPlaintextAuthSettings leaves public AuthKit profile alone so restart restore survives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scrub-public-'));
  tempDirs.push(dir);
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    apiBaseUrl: 'https://example.test',
    apiToken: '',
    theme: 'default',
    auth: {
      provider: 'authkit',
      id: 'user_e2e',
      email: 'e2e@example.com',
      name: 'E2E Operator',
      workspaceId: 'ws_e2e',
      role: 'owner',
      updatedAt: new Date().toISOString(),
    },
    uiPreferences: { notify: true, agentShare: true, weekStartMon: true },
  }, null, 2));

  const result = secure.scrubLegacyPlaintextAuthSettings(settingsPath);
  assert.equal(result.scrubbed, false);
  assert.equal(result.hadSecrets, false);
  const next = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(next.auth.provider, 'authkit');
  assert.equal(next.auth.email, 'e2e@example.com');
  assert.equal(next.auth.accessToken, undefined);
});

test('public profile metadata never overrides an explicit signed-out secure session', () => {
  assert.equal(sessionTruth.resolveDesktopSignedIn(true, { signedIn: false }), false);
  assert.equal(sessionTruth.resolveDesktopSignedIn(true, { signedIn: true }), true);
  assert.equal(sessionTruth.resolveDesktopSignedIn(true), true);
});

test('network-only refresh failure keeps the encrypted session for offline cold start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-secure-session-offline-'));
  tempDirs.push(dir);
  let clearCount = 0;
  const manager = secure.createSecureSessionManager({
    userDataPath: dir,
    storage: fakeStorage(),
    apiBaseUrl: () => 'https://offline.example.test',
    fetchImpl: async () => {
      throw new TypeError('network unavailable');
    },
    onCleared: () => {
      clearCount += 1;
    },
  });
  manager.save({
    accessToken: 'expired-access',
    refreshToken: 'durable-refresh',
    accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    sessionId: 'session-offline',
    userId: 'user-offline',
    workspaceId: 'workspace-offline',
    role: 'owner',
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(() => manager.getAccessToken(), /network unavailable/);
  assert.equal(manager.getPublicStatus().signedIn, true);
  assert.equal(manager.getPublicStatus().workspaceId, 'workspace-offline');
  assert.equal(fs.existsSync(path.join(dir, 'app-session.enc')), true);
  assert.equal(clearCount, 0);
});

for (const status of [429, 503]) {
  test(`retryable ${status} refresh response keeps the encrypted session for offline cold start`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ac-secure-session-retry-${status}-`));
    tempDirs.push(dir);
    let clearCount = 0;
    const manager = secure.createSecureSessionManager({
      userDataPath: dir,
      storage: fakeStorage(),
      apiBaseUrl: () => 'https://temporarily-unavailable.example.test',
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({ ok: false, error: 'temporarily_unavailable' }),
      }),
      onCleared: () => {
        clearCount += 1;
      },
    });
    manager.save({
      accessToken: 'expired-access',
      refreshToken: 'durable-refresh',
      accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      sessionId: `session-retry-${status}`,
      userId: 'user-offline',
      workspaceId: 'workspace-offline',
      role: 'owner',
      updatedAt: new Date().toISOString(),
    });

    await assert.rejects(() => manager.getAccessToken(), new RegExp(String(status)));
    assert.equal(manager.getPublicStatus().signedIn, true);
    assert.equal(fs.existsSync(path.join(dir, 'app-session.enc')), true);
    assert.equal(clearCount, 0);
  });
}

test('definitive invalid refresh response clears the encrypted session and dependent snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-secure-session-invalid-'));
  tempDirs.push(dir);
  let clearCount = 0;
  const manager = secure.createSecureSessionManager({
    userDataPath: dir,
    storage: fakeStorage(),
    apiBaseUrl: () => 'https://invalid-session.example.test',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'invalid_refresh_token' }),
    }),
    onCleared: () => {
      clearCount += 1;
    },
  });
  manager.save({
    accessToken: 'expired-access',
    refreshToken: 'revoked-refresh',
    accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    sessionId: 'session-invalid',
    userId: 'user-invalid',
    workspaceId: 'workspace-invalid',
    role: 'owner',
    updatedAt: new Date().toISOString(),
  });

  assert.equal(await manager.getAccessToken(), null);
  assert.equal(manager.getPublicStatus().signedIn, false);
  assert.equal(fs.existsSync(path.join(dir, 'app-session.enc')), false);
  assert.equal(clearCount, 1);
});
