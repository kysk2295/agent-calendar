import electron from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SecureSessionStorage } from './secureSession.js';

const { app, safeStorage } = electron as typeof electron & {
  app: typeof electron.app;
  safeStorage: typeof electron.safeStorage;
};

const SNAPSHOT_FILE = 'workspace-snapshot.enc';
const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export type WorkspaceSnapshotOwner = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type WorkspaceSnapshotRead = Readonly<{
  savedAt: string;
  data: Record<string, unknown>;
}>;

type WorkspaceSnapshotEnvelope = Readonly<{
  schemaVersion: 1;
  userId: string;
  workspaceId: string;
  savedAt: string;
  data: Record<string, unknown>;
}>;

export type WorkspaceSnapshotOptions = Readonly<{
  userDataPath?: string;
  storage?: SecureSessionStorage;
  now?: () => number;
  maxAgeMs?: number;
  maxBytes?: number;
}>;

function defaultStorage(): SecureSessionStorage {
  return {
    isEncryptionAvailable: () => {
      try {
        return Boolean(safeStorage?.isEncryptionAvailable?.());
      } catch {
        return false;
      }
    },
    encryptString: (plain: string) => safeStorage.encryptString(plain),
    decryptString: (buffer: Buffer) => safeStorage.decryptString(buffer),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validOwner(owner: WorkspaceSnapshotOwner): boolean {
  return Boolean(owner.userId.trim() && owner.workspaceId.trim());
}

function parseEnvelope(input: unknown): WorkspaceSnapshotEnvelope | null {
  if (!isRecord(input) || input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !isRecord(input.data)) {
    return null;
  }
  const userId = typeof input.userId === 'string' ? input.userId : '';
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
  const savedAt = typeof input.savedAt === 'string' ? input.savedAt : '';
  if (!userId || !workspaceId || !Number.isFinite(Date.parse(savedAt))) return null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    userId,
    workspaceId,
    savedAt,
    data: input.data,
  };
}

export function createWorkspaceSnapshotStore(options: WorkspaceSnapshotOptions = {}) {
  const storage = options.storage || defaultStorage();
  const now = options.now || (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEncryptedBytes = maxBytes + Math.min(64 * 1024, Math.max(256, Math.ceil(maxBytes * 0.02)));
  const getUserDataPath = () => options.userDataPath || app.getPath('userData');
  const snapshotPath = () => path.join(getUserDataPath(), SNAPSHOT_FILE);

  function clear() {
    try {
      fs.rmSync(snapshotPath(), { force: true });
    } catch {
    }
  }

  function save(owner: WorkspaceSnapshotOwner, data: Record<string, unknown>): WorkspaceSnapshotRead {
    if (!validOwner(owner) || !isRecord(data)) {
      throw new Error('Workspace snapshot owner and data are required');
    }
    if (!storage.isEncryptionAvailable()) {
      throw new Error('Secure Workspace snapshot storage is unavailable on this host');
    }
    const savedAt = new Date(now()).toISOString();
    const envelope: WorkspaceSnapshotEnvelope = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      savedAt,
      data,
    };
    const plain = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(plain, 'utf8') > maxBytes) {
      throw new Error('Workspace snapshot exceeds the 8 MiB size limit');
    }
    const encrypted = storage.encryptString(plain);
    const dir = getUserDataPath();
    fs.mkdirSync(dir, { recursive: true });
    const target = snapshotPath();
    const temporary = path.join(dir, `.${SNAPSHOT_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
      }
    }
    try {
      fs.chmodSync(target, 0o600);
    } catch {
    }
    return { savedAt, data };
  }

  function read(owner: WorkspaceSnapshotOwner): WorkspaceSnapshotRead | null {
    if (!validOwner(owner)) return null;
    const target = snapshotPath();
    try {
      if (!fs.existsSync(target)) return null;
      if (!storage.isEncryptionAvailable()) return null;
      if (fs.statSync(target).size > maxEncryptedBytes) {
        clear();
        return null;
      }
      const plain = storage.decryptString(fs.readFileSync(target));
      if (Buffer.byteLength(plain, 'utf8') > maxBytes) {
        clear();
        return null;
      }
      const envelope = parseEnvelope(JSON.parse(plain));
      if (!envelope) {
        clear();
        return null;
      }
      if (envelope.userId !== owner.userId || envelope.workspaceId !== owner.workspaceId) {
        clear();
        return null;
      }
      const age = now() - Date.parse(envelope.savedAt);
      if (age < 0 || age > maxAgeMs) {
        clear();
        return null;
      }
      return { savedAt: envelope.savedAt, data: envelope.data };
    } catch {
      clear();
      return null;
    }
  }

  return { save, read, clear };
}

export type WorkspaceSnapshotStore = ReturnType<typeof createWorkspaceSnapshotStore>;
