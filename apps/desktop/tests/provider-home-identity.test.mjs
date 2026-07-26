import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertDistinctCodexProviderIdentities,
} = require('./helpers/provider-home-identity.cjs');

function writeCodexHome(root, name, accountId) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: accountId, access_token: `secret-${name}` },
  }), { mode: 0o600 });
  return home;
}

test('strict provider preflight accepts two distinct Codex account identities without returning identity material', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-identity-'));
  try {
    const homeA = writeCodexHome(root, 'a', 'account-a');
    const homeB = writeCodexHome(root, 'b', 'account-b');
    assert.deepEqual(assertDistinctCodexProviderIdentities(homeA, homeB), {
      ok: true,
      provider: 'codex',
      distinctHomes: true,
      distinctIdentities: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict provider preflight rejects duplicate Codex identity without exposing account or token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-identity-'));
  try {
    const homeA = writeCodexHome(root, 'a', 'same-account');
    const homeB = writeCodexHome(root, 'b', 'same-account');
    assert.throws(
      () => assertDistinctCodexProviderIdentities(homeA, homeB),
      (error) => {
        assert.equal(error.code, 'PROVIDER_IDENTITIES_NOT_DISTINCT');
        assert.doesNotMatch(String(error.message), /same-account|secret-a|secret-b/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict provider preflight rejects the same canonical provider home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-identity-'));
  try {
    const home = writeCodexHome(root, 'shared', 'account-a');
    assert.throws(
      () => assertDistinctCodexProviderIdentities(home, home),
      (error) => {
        assert.equal(error.code, 'PROVIDER_HOMES_NOT_DISTINCT');
        assert.doesNotMatch(String(error.message), /account-a|secret-shared/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict provider preflight rejects unverifiable identity before provider execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-identity-'));
  try {
    const homeA = writeCodexHome(root, 'a', 'account-a');
    const homeB = path.join(root, 'b');
    fs.mkdirSync(homeB);
    fs.writeFileSync(path.join(homeB, 'auth.json'), JSON.stringify({
      auth_mode: 'api-key',
      OPENAI_API_KEY: 'secret-api-key',
    }), { mode: 0o600 });
    assert.throws(
      () => assertDistinctCodexProviderIdentities(homeA, homeB),
      (error) => {
        assert.equal(error.code, 'PROVIDER_IDENTITY_UNVERIFIABLE');
        assert.doesNotMatch(String(error.message), /secret-api-key|account-a/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
