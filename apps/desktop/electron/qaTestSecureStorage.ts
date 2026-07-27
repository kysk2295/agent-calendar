import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { SecureSessionStorage } from './secureSession.js';

type QaTestEnvironment = Readonly<Record<string, string | undefined>>;

export type QaTestSecureStorageReceipt = Readonly<{
  backend: 'electron-safe-storage' | 'qa-aes-256-gcm';
  nativeSafeStorageCallCount: number;
  nativeSafeStorageCalls: Readonly<{
    availability: number;
    encrypt: number;
    decrypt: number;
  }>;
}>;

export type QaTestSecureStorageSelection = Readonly<{
  storage: SecureSessionStorage;
  getReceipt: () => QaTestSecureStorageReceipt;
}>;

const E2E_FLAG = 'AGENT_CALENDAR_E2E_AUTH';
const ALLOW_FLAG = 'AGENT_CALENDAR_E2E_ALLOW_TEST_SECURE_STORAGE';
const KEY_FLAG = 'AGENT_CALENDAR_E2E_EPHEMERAL_SECURE_STORAGE_KEY';
const PID_FLAG = 'AGENT_CALENDAR_E2E_SECURE_STORAGE_PID';
const USER_DATA_FLAG = 'AGENT_CALENDAR_USER_DATA_NAME';
const QA_CIPHER_HEADER = Buffer.from('ACQA1', 'ascii');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function decodeEphemeralKey(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const key = Buffer.from(value, 'base64url');
    return key.length === 32 && key.toString('base64url') === value ? key : null;
  } catch {
    return null;
  }
}

function isPidScopedQaUserDataName(value: string | undefined, pid: string | undefined): boolean {
  if (!value || !pid || !/^[1-9][0-9]*$/.test(pid)) return false;
  return value === `Agent Calendar AuthKit E2E ${pid}`
    || value === `Agent Calendar Deep Link Smoke ${pid}`;
}

function createQaAesGcmStorage(key: Buffer): SecureSessionStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([QA_CIPHER_HEADER, iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString: (encrypted) => {
      const minimumLength = QA_CIPHER_HEADER.length + IV_BYTES + AUTH_TAG_BYTES + 1;
      if (encrypted.length < minimumLength || !encrypted.subarray(0, QA_CIPHER_HEADER.length).equals(QA_CIPHER_HEADER)) {
        throw new Error('Invalid QA secure-storage ciphertext');
      }
      const ivStart = QA_CIPHER_HEADER.length;
      const tagStart = ivStart + IV_BYTES;
      const ciphertextStart = tagStart + AUTH_TAG_BYTES;
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(ivStart, tagStart));
      decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart));
      return Buffer.concat([decipher.update(encrypted.subarray(ciphertextStart)), decipher.final()]).toString('utf8');
    },
  };
}

export function createQaTestSecureStorage(options: Readonly<{
  nativeStorage: SecureSessionStorage;
  environment?: QaTestEnvironment;
}>): QaTestSecureStorageSelection {
  const environment = options.environment || process.env;
  let nativeSafeStorageCallCount = 0;
  const nativeSafeStorageCalls = {
    availability: 0,
    encrypt: 0,
    decrypt: 0,
  };
  const getReceipt = (backend: QaTestSecureStorageReceipt['backend']): QaTestSecureStorageReceipt => ({
    backend,
    nativeSafeStorageCallCount,
    nativeSafeStorageCalls: { ...nativeSafeStorageCalls },
  });
  const nativeStorage: SecureSessionStorage = {
    isEncryptionAvailable: () => {
      nativeSafeStorageCallCount += 1;
      nativeSafeStorageCalls.availability += 1;
      try {
        return Boolean(options.nativeStorage.isEncryptionAvailable());
      } catch {
        return false;
      }
    },
    encryptString: (plain) => {
      nativeSafeStorageCallCount += 1;
      nativeSafeStorageCalls.encrypt += 1;
      return options.nativeStorage.encryptString(plain);
    },
    decryptString: (encrypted) => {
      nativeSafeStorageCallCount += 1;
      nativeSafeStorageCalls.decrypt += 1;
      return options.nativeStorage.decryptString(encrypted);
    },
  };
  const explicitlyRequested = environment[E2E_FLAG] === '1' && environment[ALLOW_FLAG] === '1';

  if (!explicitlyRequested) {
    return {
      storage: nativeStorage,
      getReceipt: () => getReceipt('electron-safe-storage'),
    };
  }

  const key = decodeEphemeralKey(environment[KEY_FLAG]);
  if (!key || !isPidScopedQaUserDataName(environment[USER_DATA_FLAG], environment[PID_FLAG])) {
    throw new Error('Explicit QA secure storage requires a valid ephemeral key and PID-scoped userData name');
  }
  const storage = createQaAesGcmStorage(key);
  return {
    storage,
    getReceipt: () => getReceipt('qa-aes-256-gcm'),
  };
}
