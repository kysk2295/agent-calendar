'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const stateDir = process.env.TELEGRAM_LOCK_FIXTURE_STATE_DIR;
const barrierDir = process.env.TELEGRAM_LOCK_FIXTURE_BARRIER_DIR;
const bindingHandle = process.env.TELEGRAM_LOCK_FIXTURE_BINDING;
const role = process.env.TELEGRAM_LOCK_FIXTURE_ROLE;
const digest = crypto.createHash('sha256').update(bindingHandle).digest('hex');
const lockPath = path.join(stateDir, `telegram-binding-${digest}.lock`);
const resultPath = path.join(barrierDir, `${role}.result.json`);
const releasedPath = path.join(barrierDir, `${role}.released.json`);
const releasePath = path.join(barrierDir, 'release');
const stalePayload = `${JSON.stringify({ pid: 2_147_483_647 })}\n`;

const original = {
  existsSync: fs.existsSync.bind(fs),
  openSync: fs.openSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
};

function marker(name) {
  original.writeFileSync(path.join(barrierDir, name), `${process.pid}\n`, { mode: 0o600 });
}

function writeReceipt(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const descriptor = original.openSync(temporaryPath, 'wx', 0o600);
  try {
    original.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
}

function waitFor(check, label) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`fixture barrier timed out: ${label}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

let coordinatedRead = false;
fs.readFileSync = function readFileSync(filePath, ...args) {
  const value = original.readFileSync(filePath, ...args);
  if (String(filePath) === lockPath && value === stalePayload && !coordinatedRead) {
    coordinatedRead = true;
    marker(`${role}.read`);
    waitFor(
      () => original.existsSync(path.join(barrierDir, 'a.read'))
        && original.existsSync(path.join(barrierDir, 'b.read')),
      'both contenders read stale owner',
    );
  }
  return value;
};

let coordinatedUnlink = false;
fs.unlinkSync = function unlinkSync(filePath, ...args) {
  if (String(filePath) === lockPath && coordinatedRead && !coordinatedUnlink) {
    coordinatedUnlink = true;
    if (role === 'b') {
      waitFor(
        () => original.existsSync(path.join(barrierDir, 'a.opened')),
        'first contender created replacement lock',
      );
    }
    const result = original.unlinkSync(filePath, ...args);
    marker(`${role}.unlinked`);
    return result;
  }
  return original.unlinkSync(filePath, ...args);
};

let openAttempts = 0;
fs.openSync = function openSync(filePath, flags, ...args) {
  if (String(filePath) === lockPath && flags === 'wx') openAttempts += 1;
  const descriptor = original.openSync(filePath, flags, ...args);
  if (String(filePath) === lockPath && flags === 'wx' && role === 'a' && openAttempts > 1) {
    marker('a.opened');
  }
  return descriptor;
};

const { acquireTelegramBindingLock } = require('../../lib/store');

let release = null;
let result;
try {
  release = acquireTelegramBindingLock(stateDir, bindingHandle);
  result = { role, pid: process.pid, status: 'acquired' };
} catch (error) {
  result = {
    role,
    pid: process.pid,
    status: 'rejected',
    error: error?.code || 'fixture_error',
  };
}
writeReceipt(resultPath, result);

if (release) {
  waitFor(() => original.existsSync(releasePath), 'parent release');
  release();
  writeReceipt(releasedPath, { role, pid: process.pid, released: true });
}
