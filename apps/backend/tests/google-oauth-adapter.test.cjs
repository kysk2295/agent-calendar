'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createGoogleOAuthAdapter,
  createGoogleOAuthAdapterFromConfig,
  resolveGoogleOAuthConfig,
} = require('../app/lib/google-oauth-adapter');

function fakeFetch(handler) {
  return async (url, init) => handler(String(url), init || {});
}

test('config resolves only when client id, secret, and redirect are all present', () => {
  assert.equal(resolveGoogleOAuthConfig({}), null);
  assert.equal(resolveGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: 'id' }), null);
  assert.equal(
    resolveGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' }),
    null,
  );

  const config = resolveGoogleOAuthConfig({
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
  });
  assert.equal(config.clientId, 'client-id');
  assert.equal(config.redirectUri, 'https://gateway.example/api/auth/google/callback');
});

test('adapter is absent without configuration so production fails closed', () => {
  assert.equal(createGoogleOAuthAdapter({}), null);
});

test('authorization URL carries PKCE, state, and identity scopes', async () => {
  const adapter = createGoogleOAuthAdapterFromConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://gateway.example/api/auth/google/callback',
  });

  const { url, codeVerifier } = await adapter.getAuthorizationUrlWithPKCE({ state: 'state-abc' });
  const parsed = new URL(url);

  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), 'client-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://gateway.example/api/auth/google/callback');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('state'), 'state-abc');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((parsed.searchParams.get('code_challenge') || '').length >= 43);

  const scopes = String(parsed.searchParams.get('scope') || '').split(' ');
  assert.ok(scopes.includes('openid'));
  assert.ok(scopes.includes('email'));
  assert.ok(scopes.includes('profile'));

  assert.ok(codeVerifier.length >= 43, 'PKCE verifier must meet the RFC 7636 minimum');
  assert.notEqual(codeVerifier, parsed.searchParams.get('code_challenge'));
});

test('each authorization request uses a fresh verifier', async () => {
  const adapter = createGoogleOAuthAdapterFromConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://gateway.example/api/auth/google/callback',
  });
  const first = await adapter.getAuthorizationUrlWithPKCE({ state: 'a' });
  const second = await adapter.getAuthorizationUrlWithPKCE({ state: 'b' });
  assert.notEqual(first.codeVerifier, second.codeVerifier);
});

test('code exchange returns a verified identity and never leaks the client secret', async () => {
  const calls = [];
  const adapter = createGoogleOAuthAdapterFromConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://gateway.example/api/auth/google/callback',
  }, {
    fetchImpl: fakeFetch(async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { access_token: 'at', id_token: 'idt', token_type: 'Bearer' };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            sub: 'google-subject-1',
            email: 'owner@example.com',
            email_verified: true,
            given_name: '윤서',
            family_name: '고',
          };
        },
      };
    }),
  });

  const result = await adapter.authenticateWithCodeAndVerifier({
    code: 'auth-code',
    codeVerifier: 'verifier-value',
  });

  assert.equal(result.user.id, 'google-subject-1');
  assert.equal(result.user.email, 'owner@example.com');
  assert.equal(result.user.emailVerified, true);
  assert.equal(result.user.firstName, '윤서');

  const tokenCall = calls.find((call) => call.url.includes('oauth2.googleapis.com/token'));
  assert.ok(tokenCall, 'the gateway performs the exchange');
  assert.match(String(tokenCall.init.body || ''), /code_verifier=verifier-value/);
  assert.equal(
    JSON.stringify(result).includes('client-secret'),
    false,
    'the client secret must never appear in an adapter result',
  );
});

test('an unverified Google email is rejected rather than trusted', async () => {
  const adapter = createGoogleOAuthAdapterFromConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://gateway.example/api/auth/google/callback',
  }, {
    fetchImpl: fakeFetch(async (url) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, async json() { return { access_token: 'at' }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { sub: 'google-subject-2', email: 'unverified@example.com', email_verified: false };
        },
      };
    }),
  });

  await assert.rejects(
    adapter.authenticateWithCodeAndVerifier({ code: 'c', codeVerifier: 'v' }),
    (error) => error.code === 'GOOGLE_EMAIL_UNVERIFIED',
  );
});

test('a failed token exchange fails closed', async () => {
  const adapter = createGoogleOAuthAdapterFromConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://gateway.example/api/auth/google/callback',
  }, {
    fetchImpl: fakeFetch(async () => ({
      ok: false,
      status: 400,
      async json() { return { error: 'invalid_grant' }; },
    })),
  });

  await assert.rejects(
    adapter.authenticateWithCodeAndVerifier({ code: 'bad', codeVerifier: 'v' }),
    (error) => error.code === 'GOOGLE_TOKEN_EXCHANGE_FAILED',
  );
});

test('a subject-less identity is rejected', async () => {
  const adapter = createGoogleOAuthAdapterFromConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://gateway.example/api/auth/google/callback',
  }, {
    fetchImpl: fakeFetch(async (url) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, async json() { return { access_token: 'at' }; } };
      }
      return { ok: true, status: 200, async json() { return { email: 'x@example.com', email_verified: true }; } };
    }),
  });

  await assert.rejects(
    adapter.authenticateWithCodeAndVerifier({ code: 'c', codeVerifier: 'v' }),
    (error) => error.code === 'GOOGLE_IDENTITY_INVALID',
  );
});

test('the runtime selects Google when configured and stays fail-closed otherwise', async () => {
  const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const baseEnv = {
    WORKSPACE_AUTH_MODE: 'production',
    DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
    UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
  };

  const unconfigured = createPhase1Runtime({ pool, env: { ...baseEnv } });
  assert.equal(unconfigured.authKit, null, 'no identity provider means no login');

  const google = createPhase1Runtime({
    pool,
    env: {
      ...baseEnv,
      GOOGLE_OAUTH_CLIENT_ID: 'google-client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
    },
  });
  assert.equal(google.authKit?.kind, 'google');
  assert.equal(google.workosConfig?.clientId, 'google-client');

  const url = (await google.authKit.getAuthorizationUrlWithPKCE({ state: 's' })).url;
  assert.match(url, /accounts\.google\.com/);
});

test('desktop login uses the identity adapter redirect, not a hardcoded scheme', async () => {
  const {
    desktopLoginRedirectUri,
    DESKTOP_LOGIN_REDIRECT_URI,
  } = require('../app/lib/desktop-login-service');

  // WorkOS accepts the custom scheme, so the legacy default stays for it.
  assert.equal(desktopLoginRedirectUri({ authKit: { kind: 'workos' } }), DESKTOP_LOGIN_REDIRECT_URI);
  assert.equal(desktopLoginRedirectUri({ authKit: null }), DESKTOP_LOGIN_REDIRECT_URI);

  // Google rejects custom schemes, so its redirect must come from the adapter.
  assert.equal(
    desktopLoginRedirectUri({
      authKit: { kind: 'google', redirectUri: 'https://gateway.example/api/auth/google/callback' },
    }),
    'https://gateway.example/api/auth/google/callback',
  );
});
