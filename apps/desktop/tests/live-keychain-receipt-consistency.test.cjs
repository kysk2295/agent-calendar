const assert = require('node:assert/strict');
const test = require('node:test');

const { assertSuccessfulReceiptConsistency } = require('./live-keychain-source-smoke.cjs');

test('PIN: a successful receipt with both plaintext-free file flags is internally consistent', () => {
  assert.doesNotThrow(() => assertSuccessfulReceiptConsistency({
    ok: true,
    encryptedFiles: { session: true, snapshot: true },
  }));
});

test('RED: a successful receipt rejects a contradictory legacy aggregate encryption field', () => {
  assert.throws(
    () => assertSuccessfulReceiptConsistency({
      ok: true,
      encryptedFiles: { session: true, snapshot: true },
      encryptedOnDisk: false,
    }),
    /legacy aggregate encryption field/,
  );
});

test('successful receipt rejects a missing or false encrypted-file detail', () => {
  assert.throws(
    () => assertSuccessfulReceiptConsistency({
      ok: true,
      encryptedFiles: { session: true, snapshot: false },
    }),
    /both encrypted files/,
  );
});
