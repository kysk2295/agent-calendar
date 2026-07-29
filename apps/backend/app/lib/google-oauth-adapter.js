'use strict';

/**
 * Google OAuth adapter boundary.
 *
 * Same surface as the WorkOS AuthKit adapter so the runtime can accept either:
 * - getAuthorizationUrlWithPKCE({ state, screenHint, loginHint })
 * - authenticateWithCodeAndVerifier({ code, codeVerifier })
 *
 * Google only proves who the person is. Workspace scope, sessions, and refresh
 * tokens stay with the gateway, so nothing here issues product authority.
 */

const crypto = require('node:crypto');

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const IDENTITY_SCOPES = Object.freeze(['openid', 'email', 'profile']);

function googleError(code, message, statusHint = 503) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function base64Url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function createPkcePair() {
  // RFC 7636: 43..128 characters after base64url encoding.
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function resolveGoogleOAuthConfig(env = process.env) {
  const clientId = text(env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID);
  const clientSecret = text(env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET);
  const redirectUri = text(env.GOOGLE_OAUTH_REDIRECT_URI || env.GOOGLE_REDIRECT_URI);
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function createGoogleOAuthAdapterFromConfig(config, { fetchImpl = null } = {}) {
  if (!config || !config.clientId || !config.clientSecret || !config.redirectUri) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw googleError('GOOGLE_FETCH_UNAVAILABLE', 'a fetch implementation is required');
  }

  return {
    kind: 'google',
    clientId: config.clientId,
    redirectUri: config.redirectUri,

    async getAuthorizationUrlWithPKCE({ state, loginHint, screenHint } = {}) {
      const { verifier, challenge } = createPkcePair();
      const url = new URL(AUTHORIZE_ENDPOINT);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', IDENTITY_SCOPES.join(' '));
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // Refresh tokens only arrive with offline access plus an explicit prompt.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('include_granted_scopes', 'true');
      if (state) url.searchParams.set('state', String(state));
      if (loginHint) url.searchParams.set('login_hint', String(loginHint));
      if (screenHint === 'sign-up') url.searchParams.set('prompt', 'consent');
      return { url: url.toString(), codeVerifier: verifier };
    },

    async authenticateWithCodeAndVerifier({ code, codeVerifier } = {}) {
      if (!text(code) || !text(codeVerifier)) {
        throw googleError('GOOGLE_CODE_REQUIRED', 'code and codeVerifier are required', 400);
      }

      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: text(code),
        code_verifier: text(codeVerifier),
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
      });

      const tokenResponse = await doFetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!tokenResponse.ok) {
        // The upstream body can echo request parameters, so it is not surfaced.
        throw googleError(
          'GOOGLE_TOKEN_EXCHANGE_FAILED',
          `Google token exchange failed (${tokenResponse.status})`,
          401,
        );
      }
      const tokens = await tokenResponse.json();
      const accessToken = text(tokens?.access_token);
      if (!accessToken) {
        throw googleError('GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google returned no access token', 401);
      }

      const profileResponse = await doFetch(USERINFO_ENDPOINT, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!profileResponse.ok) {
        throw googleError(
          'GOOGLE_USERINFO_FAILED',
          `Google userinfo failed (${profileResponse.status})`,
          401,
        );
      }
      const profile = await profileResponse.json();

      const subject = text(profile?.sub);
      const email = text(profile?.email);
      if (!subject || !email) {
        throw googleError('GOOGLE_IDENTITY_INVALID', 'Google identity is incomplete', 401);
      }
      // An unverified address must never become a product identity: it would let one person
      // claim another person's Workspace by asserting their email.
      if (profile?.email_verified !== true) {
        throw googleError('GOOGLE_EMAIL_UNVERIFIED', 'Google email is not verified', 401);
      }

      return {
        user: {
          id: subject,
          email,
          emailVerified: true,
          firstName: text(profile?.given_name),
          lastName: text(profile?.family_name),
        },
      };
    },
  };
}

function createGoogleOAuthAdapter(env = process.env, options = {}) {
  const config = resolveGoogleOAuthConfig(env);
  if (!config) return null;
  return createGoogleOAuthAdapterFromConfig(config, options);
}

module.exports = {
  IDENTITY_SCOPES,
  createGoogleOAuthAdapter,
  createGoogleOAuthAdapterFromConfig,
  resolveGoogleOAuthConfig,
};
