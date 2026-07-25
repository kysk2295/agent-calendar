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
const snapshots = await vite.ssrLoadModule('/electron/workspaceSnapshot.ts');
const presentation = await vite.ssrLoadModule('/src/features/connectivity/workspaceSnapshot.ts');

const tempDirs = [];
after(async () => {
  await vite.close();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-workspace-snapshot-'));
  tempDirs.push(dir);
  return dir;
}

function fakeStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (buffer) => {
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

const ownerA = { userId: 'user-a', workspaceId: 'workspace-a' };
const ownerB = { userId: 'user-b', workspaceId: 'workspace-b' };

test('Workspace snapshot is encrypted, atomic, owner-only, and readable by the same session owner', () => {
  const dir = tempDir();
  const store = snapshots.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: fakeStorage(),
    now: () => Date.parse('2026-07-25T04:00:00.000Z'),
  });
  const saved = store.save(ownerA, {
    state: {
      events: [{ id: 'event-1', title: 'Private calendar title' }],
      docs: [{ id: 'doc-1', body: 'Private wiki content' }],
    },
  });

  assert.equal(saved.savedAt, '2026-07-25T04:00:00.000Z');
  const file = path.join(dir, 'workspace-snapshot.enc');
  const raw = fs.readFileSync(file);
  assert.doesNotMatch(raw.toString('utf8'), /Private calendar title|Private wiki content|workspace-a|user-a/);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'snapshot must deny group/other permissions');
  assert.deepEqual(store.read(ownerA), {
    savedAt: '2026-07-25T04:00:00.000Z',
    data: {
      state: {
        events: [{ id: 'event-1', title: 'Private calendar title' }],
        docs: [{ id: 'doc-1', body: 'Private wiki content' }],
      },
    },
  });
});

test('Workspace snapshot fails closed and is removed for another User or Workspace', () => {
  const dir = tempDir();
  const store = snapshots.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: fakeStorage(),
  });
  store.save(ownerA, { state: { events: [{ title: 'A only' }] } });
  assert.equal(store.read(ownerB), null);
  assert.equal(fs.existsSync(path.join(dir, 'workspace-snapshot.enc')), false);
});

test('expired and corrupted Workspace snapshots are removed instead of being rendered', () => {
  const dir = tempDir();
  let now = Date.parse('2026-07-25T00:00:00.000Z');
  const store = snapshots.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: fakeStorage(),
    now: () => now,
    maxAgeMs: 60_000,
  });
  store.save(ownerA, { state: { events: [] } });
  now += 60_001;
  assert.equal(store.read(ownerA), null);

  const file = path.join(dir, 'workspace-snapshot.enc');
  fs.writeFileSync(file, randomBytes(48), { mode: 0o600 });
  assert.equal(store.read(ownerA), null);
  assert.equal(fs.existsSync(file), false);
});

test('oversized Workspace snapshots are rejected without overwriting the last valid snapshot', () => {
  const dir = tempDir();
  const store = snapshots.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: fakeStorage(),
    maxBytes: 512,
  });
  store.save(ownerA, { state: { events: [{ title: 'kept' }] } });
  assert.throws(
    () => store.save(ownerA, { state: { docs: [{ body: 'x'.repeat(1_000) }] } }),
    /8 MiB|size limit|too large/i,
  );
  assert.equal(store.read(ownerA)?.data?.state?.events?.[0]?.title, 'kept');
});

test('oversized encrypted files are removed before decrypting or allocating plaintext', () => {
  const dir = tempDir();
  let decryptCount = 0;
  const storage = fakeStorage();
  const store = snapshots.createWorkspaceSnapshotStore({
    userDataPath: dir,
    storage: {
      ...storage,
      decryptString: (buffer) => {
        decryptCount += 1;
        return storage.decryptString(buffer);
      },
    },
    maxBytes: 512,
  });
  const file = path.join(dir, 'workspace-snapshot.enc');
  fs.writeFileSync(file, randomBytes(1_024), { mode: 0o600 });

  assert.equal(store.read(ownerA), null);
  assert.equal(decryptCount, 0);
  assert.equal(fs.existsSync(file), false);
});

test('renderer accepts only the complete versioned Workspace presentation snapshot', () => {
  const complete = {
    presentationSchemaVersion: 1,
    state: {
      tasks: [],
      events: [{ id: 'event-1' }],
      agents: [],
      runs: [],
      docs: [],
      inbox: [],
      automation: [],
      channels: [],
      sessions: [],
      tools: [],
      chatMessages: [],
      taxonomy: [],
      wiki: {},
      settings: {},
      usage: {},
      gatewayStatus: {},
      profileReadiness: {},
      agentSourceStatus: {},
    },
    agentOperations: { missions: [], tasks: [], sessions: [], agents: [], reports: [] },
    calendarSources: [],
    calendarCoverageNote: '완료',
    connectedAutomationSources: [],
    automationRunners: [],
    calendarAiMemories: [],
    calendarAiConversationId: 'conversation-1',
    chatMessages: [],
  };
  assert.deepEqual(presentation.parseWorkspacePresentationSnapshot(complete), complete);
  assert.equal(presentation.parseWorkspacePresentationSnapshot({ ...complete, presentationSchemaVersion: 2 }), null);
  assert.equal(presentation.parseWorkspacePresentationSnapshot({ ...complete, state: [] }), null);
  assert.equal(presentation.parseWorkspacePresentationSnapshot({ ...complete, calendarSources: {} }), null);
});
