'use strict';

const crypto = require('node:crypto');
const {
  issueSessionForVerifiedSubject,
  bootstrapUserWorkspaceForVerifiedSubject,
} = require('./workspace-auth-session');

// WorkOS accepts this custom scheme. Google does not — it rejects custom schemes outright —
// so a Google adapter carries its own gateway-hosted redirect and that value wins.
const DESKTOP_LOGIN_REDIRECT_URI = 'agent-calendar://auth/callback';

function desktopLoginRedirectUri(runtime) {
  const configured = String(runtime?.authKit?.redirectUri || '').trim();
  return configured || DESKTOP_LOGIN_REDIRECT_URI;
}
const LOGIN_TTL_MS = 10 * 60 * 1000;
const SELECTION_TTL_MS = 10 * 60 * 1000;
const PROVIDER = 'workos';

function hashDesktopLoginSecret(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function newOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function reject(code, message, statusHint = 401) {
  const error = new Error(message);
  error.code = code;
  error.statusHint = statusHint;
  throw error;
}

async function withTransaction(pool, fn) {
  if (pool && typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  }
  if (pool && typeof pool.query === 'function') {
    await pool.query('begin');
    try {
      const result = await fn(pool);
      await pool.query('commit');
      return result;
    } catch (error) {
      try { await pool.query('rollback'); } catch { /* ignore */ }
      throw error;
    }
  }
  reject('DESKTOP_LOGIN_POOL_REQUIRED', 'transaction requires a pool', 500);
}

function assertAuthKitReady(runtime) {
  const authKit = runtime && runtime.authKit;
  const config = runtime && runtime.workosConfig;
  if (!authKit || typeof authKit.getAuthorizationUrlWithPKCE !== 'function'
    || typeof authKit.authenticateWithCodeAndVerifier !== 'function'
    || !config || !config.clientId) {
    reject('WORKOS_CONFIG_MISSING', 'WorkOS AuthKit is not configured', 503);
  }
  return { authKit, clientId: config.clientId };
}

/**
 * Begin Desktop AuthKit PKCE login. Returns plaintext state + verifier once;
 * only hashes are persisted.
 */
async function startDesktopLogin(runtime, { screenHint } = {}) {
  const { authKit, clientId } = assertAuthKitReady(runtime);
  const redirectUri = desktopLoginRedirectUri(runtime);
  const state = newOpaqueToken();
  const { url, codeVerifier } = await authKit.getAuthorizationUrlWithPKCE({
    clientId,
    redirectUri,
    provider: 'authkit',
    state,
    screenHint: screenHint || undefined,
  });
  if (!url || !codeVerifier) {
    reject('WORKOS_AUTH_URL_INVALID', 'AuthKit authorization URL incomplete', 503);
  }

  const transactionId = newId('dlogin');
  const expiresAt = new Date(Date.now() + LOGIN_TTL_MS).toISOString();
  await runtime.pool.query(
    `insert into desktop_login_transactions (
       id, state_hash, verifier_hash, redirect_uri, status, expires_at
     ) values ($1, $2, $3, $4, 'pending', $5::timestamptz)`,
    [
      transactionId,
      hashDesktopLoginSecret(state),
      hashDesktopLoginSecret(codeVerifier),
      redirectUri,
      expiresAt,
    ],
  );

  return {
    ok: true,
    transactionId,
    authorizationUrl: url,
    state,
    codeVerifier,
    redirectUri,
    expiresAt,
  };
}

async function claimPendingLoginTransaction(client, { state, codeVerifier, redirectUri }) {
  const stateHash = hashDesktopLoginSecret(state);
  const verifierHash = hashDesktopLoginSecret(codeVerifier);
  if (!String(state || '').trim() || !String(codeVerifier || '').trim()) {
    reject('DESKTOP_LOGIN_PARAMS_REQUIRED', 'state and codeVerifier are required', 400);
  }

  // Atomic exclusive claim: only one concurrent winner.
  const claimed = await client.query(
    `update desktop_login_transactions
     set status = 'completed',
         completed_at = now(),
         updated_at = now()
     where state_hash = $1
       and verifier_hash = $2
       and redirect_uri = $3
       and status = 'pending'
       and expires_at > now()
     returning *`,
    [stateHash, verifierHash, redirectUri || DESKTOP_LOGIN_REDIRECT_URI],
  );

  if (claimed.rowCount) {
    return claimed.rows[0];
  }

  const existing = await client.query(
    `select id, status, expires_at from desktop_login_transactions
     where state_hash = $1
     order by created_at desc
     limit 1`,
    [stateHash],
  );
  if (!existing.rowCount) {
    reject('DESKTOP_LOGIN_STATE_INVALID', 'unknown or forged login state', 401);
  }
  const row = existing.rows[0];
  if (row.status !== 'pending') {
    reject('DESKTOP_LOGIN_REPLAY', 'login transaction already used', 401);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await client.query(
      `update desktop_login_transactions
       set status = 'expired', updated_at = now()
       where id = $1 and status = 'pending'`,
      [row.id],
    );
    reject('DESKTOP_LOGIN_EXPIRED', 'login transaction expired', 401);
  }
  // State matched but verifier did not (or race lost without status change).
  reject('DESKTOP_LOGIN_VERIFIER_MISMATCH', 'code verifier mismatch', 401);
}

async function markLoginFailed(pool, transactionId, failureCode) {
  if (!transactionId) return;
  try {
    await pool.query(
      `update desktop_login_transactions
       set status = 'failed',
           failed_at = now(),
           failure_code = $2,
           updated_at = now()
       where id = $1`,
      [transactionId, String(failureCode || 'exchange_failed').slice(0, 120)],
    );
  } catch {
    // Best-effort; do not mask original error.
  }
}

function publicSessionPayload(issued, profile = {}) {
  return {
    ok: true,
    sessionId: issued.sessionId,
    userId: issued.userId,
    workspaceId: issued.workspaceId,
    role: issued.role,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    accessExpiresAt: issued.accessExpiresAt,
    refreshExpiresAt: issued.refreshExpiresAt,
    user: {
      id: issued.userId,
      email: profile.email || null,
      displayName: profile.displayName || null,
    },
    // Never include WorkOS tokens.
  };
}

/**
 * Complete Desktop AuthKit callback: claim transaction, exchange code, bootstrap, issue session.
 * Request body identity fields (providerSubject, email, userId, workspaceId) are never trusted
 * as authority for auto-binding when multi-membership requires selection.
 */
async function completeDesktopLogin(runtime, body = {}) {
  const { authKit, clientId } = assertAuthKitReady(runtime);
  const code = String(body.code || '').trim();
  const state = String(body.state || '').trim();
  const codeVerifier = String(body.codeVerifier || '').trim();
  if (!code) {
    reject('DESKTOP_LOGIN_CODE_REQUIRED', 'authorization code is required', 400);
  }

  let claimedTx = null;
  try {
    claimedTx = await withTransaction(runtime.pool, async (client) => (
      claimPendingLoginTransaction(client, {
        state,
        codeVerifier,
        redirectUri: desktopLoginRedirectUri(runtime),
      })
    ));
  } catch (error) {
    throw error;
  }

  let exchange;
  try {
    exchange = await authKit.authenticateWithCodeAndVerifier({
      clientId,
      code,
      codeVerifier,
    });
  } catch (error) {
    await markLoginFailed(runtime.pool, claimedTx && claimedTx.id, error.code || 'WORKOS_EXCHANGE_FAILED');
    // Transaction already marked completed to prevent code replay; surface exchange failure.
    const wrapped = new Error('WorkOS code exchange failed');
    wrapped.code = error.code || 'WORKOS_EXCHANGE_FAILED';
    wrapped.statusHint = 401;
    throw wrapped;
  }

  const workosUser = exchange && exchange.user ? exchange.user : null;
  const providerSubject = workosUser && workosUser.id ? String(workosUser.id).trim() : '';
  if (!providerSubject) {
    await markLoginFailed(runtime.pool, claimedTx && claimedTx.id, 'WORKOS_USER_MISSING');
    reject('WORKOS_USER_MISSING', 'WorkOS user missing after exchange', 401);
  }
  if (workosUser.emailVerified === false) {
    await markLoginFailed(runtime.pool, claimedTx && claimedTx.id, 'WORKOS_EMAIL_UNVERIFIED');
    reject('WORKOS_EMAIL_UNVERIFIED', 'WorkOS email is not verified', 401);
  }

  const email = workosUser.email ? String(workosUser.email).trim().toLowerCase() : '';
  const displayName = [workosUser.firstName, workosUser.lastName].filter(Boolean).join(' ').trim()
    || (email ? email.split('@')[0] : 'Agent Calendar user');

  const bootstrap = await bootstrapUserWorkspaceForVerifiedSubject(runtime.pool, {
    provider: PROVIDER,
    providerSubject,
    email,
    displayName,
  });

  const memberships = bootstrap.memberships || [];
  if (memberships.length === 0) {
    reject('SESSION_NO_MEMBERSHIP', 'user has no active workspace membership', 401);
  }

  if (memberships.length > 1) {
    // Multi-membership: never auto-bind body.workspaceId. Issue opaque selection transaction.
    const selectionToken = newOpaqueToken();
    const selectionId = newId('wsel');
    const expiresAt = new Date(Date.now() + SELECTION_TTL_MS).toISOString();
    await runtime.pool.query(
      `insert into desktop_workspace_selection_transactions (
         id, token_hash, user_id, status, expires_at, payload
       ) values ($1, $2, $3, 'pending', $4::timestamptz, $5::jsonb)`,
      [
        selectionId,
        hashDesktopLoginSecret(selectionToken),
        bootstrap.userId,
        expiresAt,
        JSON.stringify({
          workspaces: memberships.map((m) => ({
            id: m.workspaceId,
            name: m.workspaceName,
            role: m.role,
          })),
        }),
      ],
    );
    return {
      ok: true,
      needsWorkspaceSelection: true,
      selectionToken,
      selectionExpiresAt: expiresAt,
      userId: bootstrap.userId,
      user: { id: bootstrap.userId, email, displayName },
      workspaces: memberships.map((m) => ({
        id: m.workspaceId,
        name: m.workspaceName,
        role: m.role,
      })),
    };
  }

  const only = memberships[0];
  const issued = await issueSessionForVerifiedSubject(runtime.pool, {
    provider: PROVIDER,
    providerSubject,
    workspaceId: only.workspaceId,
  });

  return publicSessionPayload(issued, { email, displayName });
}

async function selectDesktopWorkspace(runtime, body = {}) {
  // AuthKit not required for selection; membership + selection token are authority.
  const selectionToken = String(body.selectionToken || '').trim();
  const workspaceId = String(body.workspaceId || '').trim();
  if (!selectionToken || !workspaceId) {
    reject('DESKTOP_SELECTION_PARAMS_REQUIRED', 'selectionToken and workspaceId are required', 400);
  }
  const tokenHash = hashDesktopLoginSecret(selectionToken);

  const outcome = await withTransaction(runtime.pool, async (client) => {
    const claimed = await client.query(
      `update desktop_workspace_selection_transactions
       set status = 'completed',
           completed_at = now(),
           selected_workspace_id = $2,
           updated_at = now()
       where token_hash = $1
         and status = 'pending'
         and expires_at > now()
       returning *`,
      [tokenHash, workspaceId],
    );
    if (!claimed.rowCount) {
      const existing = await client.query(
        `select status, expires_at from desktop_workspace_selection_transactions
         where token_hash = $1 limit 1`,
        [tokenHash],
      );
      if (!existing.rowCount) {
        reject('DESKTOP_SELECTION_INVALID', 'unknown selection token', 401);
      }
      if (existing.rows[0].status !== 'pending') {
        reject('DESKTOP_SELECTION_REPLAY', 'selection token already used', 401);
      }
      reject('DESKTOP_SELECTION_EXPIRED', 'selection token expired', 401);
    }

    const row = claimed.rows[0];
    const membership = await client.query(
      `select m.role, m.status, m.workspace_id, w.name as workspace_name, w.status as workspace_status,
              u.status as user_status, ai.provider_subject
       from workspace_memberships m
       inner join workspaces w on w.id = m.workspace_id
       inner join users u on u.id = m.user_id
       inner join auth_identities ai on ai.user_id = m.user_id and ai.provider = $3
       where m.user_id = $1 and m.workspace_id = $2 and m.status = 'active'
       limit 1`,
      [row.user_id, workspaceId, PROVIDER],
    );
    if (!membership.rowCount) {
      reject('DESKTOP_SELECTION_FORBIDDEN', 'workspace is not authorized for this user', 403);
    }
    if (membership.rows[0].user_status !== 'active' || membership.rows[0].workspace_status !== 'active') {
      reject('DESKTOP_SELECTION_INACTIVE', 'user or workspace inactive', 403);
    }

    return {
      userId: row.user_id,
      workspaceId,
      providerSubject: membership.rows[0].provider_subject,
      email: null,
      displayName: null,
    };
  });

  // Load profile email for response (non-authoritative).
  const profile = await runtime.pool.query(
    `select display_name, payload from users where id = $1 limit 1`,
    [outcome.userId],
  );
  const email = profile.rowCount && profile.rows[0].payload && profile.rows[0].payload.email
    ? String(profile.rows[0].payload.email)
    : null;
  const displayName = profile.rowCount ? profile.rows[0].display_name : null;

  const issued = await issueSessionForVerifiedSubject(runtime.pool, {
    provider: PROVIDER,
    providerSubject: outcome.providerSubject,
    workspaceId: outcome.workspaceId,
  });
  return publicSessionPayload(issued, { email, displayName });
}

module.exports = {
  DESKTOP_LOGIN_REDIRECT_URI,
  LOGIN_TTL_MS,
  SELECTION_TTL_MS,
  completeDesktopLogin,
  desktopLoginRedirectUri,
  hashDesktopLoginSecret,
  selectDesktopWorkspace,
  startDesktopLogin,
};
