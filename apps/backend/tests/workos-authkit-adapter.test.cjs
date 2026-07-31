'use strict';

/**
 * Unit tests for the production WorkOS AuthKit adapter surface.
 * Uses the real @workos-inc/node package (installed dependency) with a stub WorkOS ctor
 * for network-free method-shape verification.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkosAuthKitAdapter,
  createWorkosAuthKitAdapterFromConfig,
  resolveWorkosConfig,
} = require('../app/lib/workos-authkit-adapter');

test('@workos-inc/node is installed and exposes current AuthKit PKCE methods', () => {
  const sdk = require('@workos-inc/node');
  assert.equal(typeof sdk.WorkOS, 'function');
  const workos = new sdk.WorkOS('sk_test_probe', { clientId: 'client_probe' });
  assert.equal(typeof workos.userManagement.getAuthorizationUrlWithPKCE, 'function');
  assert.equal(typeof workos.userManagement.authenticateWithCodeAndVerifier, 'function');
  // Keep authenticateWithCode available but production adapter must prefer verifier method.
  assert.equal(typeof workos.userManagement.authenticateWithCode, 'function');
});

test('resolveWorkosConfig fails closed without credentials', () => {
  assert.equal(resolveWorkosConfig({}), null);
  assert.equal(resolveWorkosConfig({ WORKOS_API_KEY: 'sk_x' }), null);
  assert.equal(resolveWorkosConfig({ WORKOS_CLIENT_ID: 'client_x' }), null);
  const cfg = resolveWorkosConfig({ WORKOS_API_KEY: 'sk_x', WORKOS_CLIENT_ID: 'client_x' });
  assert.deepEqual(cfg, { apiKey: 'sk_x', clientId: 'client_x', apiKeyConfigured: true });
});

test('production adapter calls getAuthorizationUrlWithPKCE and authenticateWithCodeAndVerifier', async () => {
  const calls = [];
  class FakeWorkOS {
    constructor(apiKey, options) {
      calls.push({ ctor: { apiKey, options } });
      this.userManagement = {
        async getAuthorizationUrlWithPKCE(args) {
          calls.push({ getAuthorizationUrlWithPKCE: args });
          return { url: 'https://authkit.test/start?state=state_real', state: 'state_real', codeVerifier: 'ver_real' };
        },
        async authenticateWithCodeAndVerifier(args) {
          calls.push({ authenticateWithCodeAndVerifier: args });
          return {
            user: { id: 'user_1', email: 'a@example.com', emailVerified: true },
            accessToken: 'workos_access',
            refreshToken: 'workos_refresh',
          };
        },
        async authenticateWithCode() {
          throw new Error('adapter must not call authenticateWithCode for PKCE desktop');
        },
      };
    }
  }

  const adapter = createWorkosAuthKitAdapterFromConfig(
    { apiKey: 'sk_test', clientId: 'client_test', apiKeyConfigured: true },
    { WorkOSCtor: FakeWorkOS },
  );
  assert.ok(adapter);
  assert.equal(adapter.kind, 'workos');
  assert.equal(adapter.sdkSurface.getAuthorizationUrlWithPKCE, true);
  assert.equal(adapter.sdkSurface.authenticateWithCodeAndVerifier, true);

  const started = await adapter.getAuthorizationUrlWithPKCE({
    clientId: 'client_test',
    redirectUri: 'agent-calendar://auth/callback',
    provider: 'authkit',
    state: 'st1',
    screenHint: 'sign-in',
  });
  assert.equal(started.url, 'https://authkit.test/start?state=state_real');
  assert.equal(started.state, 'state_real');
  assert.equal(started.codeVerifier, 'ver_real');

  const auth = await adapter.authenticateWithCodeAndVerifier({
    clientId: 'client_test',
    code: 'code_1',
    codeVerifier: 'ver_real',
  });
  assert.equal(auth.user.id, 'user_1');

  assert.ok(calls.some((c) => c.getAuthorizationUrlWithPKCE));
  assert.ok(calls.some((c) => c.authenticateWithCodeAndVerifier));
  assert.equal(
    calls.some((c) => c.authenticateWithCodeAndVerifier && c.authenticateWithCodeAndVerifier.codeVerifier === 'ver_real'),
    true,
  );
});

test('createWorkosAuthKitAdapter returns null when env missing (fail closed, no fake auth)', () => {
  assert.equal(createWorkosAuthKitAdapter({}), null);
});
