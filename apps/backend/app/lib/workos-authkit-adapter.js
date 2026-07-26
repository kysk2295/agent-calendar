'use strict';

/**
 * WorkOS AuthKit adapter boundary.
 * Tests inject a fake; production uses @workos-inc/node when configured.
 *
 * Official product methods (adapter surface):
 * - getAuthorizationUrlWithPKCE({ clientId, redirectUri, provider, state, screenHint })
 * - authenticateWithCodeAndVerifier({ clientId, code, codeVerifier })
 */

function createMissingWorkosConfigError() {
  const error = new Error('WorkOS AuthKit is not configured');
  error.code = 'WORKOS_CONFIG_MISSING';
  return error;
}

function resolveWorkosConfig(env = process.env) {
  const apiKey = String(env.WORKOS_API_KEY || env.WORKOS_API_KEY_SECRET || '').trim();
  const clientId = String(env.WORKOS_CLIENT_ID || env.WORKOS_CLIENTID || '').trim();
  if (!apiKey || !clientId) {
    return null;
  }
  return { apiKey, clientId, apiKeyConfigured: true };
}

function createWorkosAuthKitAdapterFromConfig(config, { WorkOSCtor = null } = {}) {
  if (!config || !config.clientId || !(config.apiKey || config.apiKeyConfigured)) {
    return null;
  }
  if (!config.apiKey) {
    // Config flag without key still requires real SDK construction path to fail closed later.
    return null;
  }

  let WorkOS = WorkOSCtor;
  if (!WorkOS) {
    try {
      // Production dependency declared in apps/backend/package.json.
      ({ WorkOS } = require('@workos-inc/node'));
    } catch {
      const error = createMissingWorkosConfigError();
      error.code = 'WORKOS_SDK_UNAVAILABLE';
      throw error;
    }
  }

  const workos = new WorkOS(config.apiKey, { clientId: config.clientId });
  const um = workos.userManagement;
  if (typeof um.getAuthorizationUrlWithPKCE !== 'function') {
    const error = new Error('WorkOS SDK missing getAuthorizationUrlWithPKCE');
    error.code = 'WORKOS_SDK_SURFACE_INVALID';
    throw error;
  }
  // @workos-inc/node v10+ exposes authenticateWithCodeAndVerifier for PKCE desktop clients.
  if (typeof um.authenticateWithCodeAndVerifier !== 'function') {
    const error = new Error('WorkOS SDK missing authenticateWithCodeAndVerifier');
    error.code = 'WORKOS_SDK_SURFACE_INVALID';
    throw error;
  }

  return {
    kind: 'workos',
    clientId: config.clientId,
    sdkSurface: {
      getAuthorizationUrlWithPKCE: true,
      authenticateWithCodeAndVerifier: true,
    },
    async getAuthorizationUrlWithPKCE({ clientId, redirectUri, provider = 'authkit', state, screenHint } = {}) {
      const result = await um.getAuthorizationUrlWithPKCE({
        clientId: clientId || config.clientId,
        redirectUri,
        provider: provider || 'authkit',
        state,
        screenHint,
      });
      return {
        url: result.url || result.authorizationUrl,
        codeVerifier: result.codeVerifier,
      };
    },
    async authenticateWithCodeAndVerifier({ clientId, code, codeVerifier } = {}) {
      return um.authenticateWithCodeAndVerifier({
        clientId: clientId || config.clientId,
        code,
        codeVerifier,
      });
    },
  };
}

function createWorkosAuthKitAdapter(env = process.env, options = {}) {
  const config = resolveWorkosConfig(env);
  if (!config) return null;
  return createWorkosAuthKitAdapterFromConfig(config, options);
}

module.exports = {
  createMissingWorkosConfigError,
  createWorkosAuthKitAdapter,
  createWorkosAuthKitAdapterFromConfig,
  resolveWorkosConfig,
};
