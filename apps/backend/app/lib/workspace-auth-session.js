'use strict';

const crypto = require('node:crypto');
const {
  resolveWorkspaceScope,
} = require('./workspace-scope');

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function newOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function withTransaction(pool, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    // Allow client-like pools used in tests that only have query (single connection).
    if (pool && typeof pool.query === 'function' && typeof pool.connect !== 'function') {
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
    reject('SESSION_POOL_REQUIRED', 'transaction requires a Pool');
  }
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

/**
 * Issue session tokens for a subject already verified by a trusted Adapter.
 * Never call this with raw HTTP body fields as identity.
 */
async function issueSessionForVerifiedSubject(pool, {
  provider,
  providerSubject,
  workspaceId,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    reject('SESSION_POOL_REQUIRED', 'issueSessionForVerifiedSubject requires a pool');
  }
  const normalizedProvider = String(provider || '').trim();
  const normalizedSubject = String(providerSubject || '').trim();
  if (!normalizedProvider || !normalizedSubject) {
    reject('SESSION_SUBJECT_REQUIRED', 'provider and providerSubject are required');
  }

  return withTransaction(pool, async (client) => {
    const identity = await client.query(
      `select ai.user_id, u.status as user_status
       from auth_identities ai
       inner join users u on u.id = ai.user_id
       where ai.provider = $1 and ai.provider_subject = $2
       limit 1
       for update of ai`,
      [normalizedProvider, normalizedSubject],
    );
    if (!identity.rowCount) {
      reject('SESSION_IDENTITY_UNKNOWN', 'auth identity not found for provider subject');
    }
    if (identity.rows[0].user_status !== 'active') {
      reject('SESSION_USER_INACTIVE', 'user is inactive');
    }
    const userId = identity.rows[0].user_id;

    let targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) {
      const membership = await client.query(
        `select workspace_id from workspace_memberships
         where user_id = $1 and status = 'active'
         order by created_at asc
         limit 1`,
        [userId],
      );
      if (!membership.rowCount) {
        reject('SESSION_NO_MEMBERSHIP', 'user has no active workspace membership');
      }
      targetWorkspaceId = membership.rows[0].workspace_id;
    }

    const scope = await resolveWorkspaceScope(client, { userId, workspaceId: targetWorkspaceId });

    const sessionId = newId('sess');
    const familyId = newId('fam');
    const accessToken = newOpaqueToken();
    const refreshToken = newOpaqueToken();
    const accessHash = hashToken(accessToken);
    const refreshHash = hashToken(refreshToken);
    const now = Date.now();
    const accessExpires = new Date(now + ACCESS_TTL_MS).toISOString();
    const refreshExpires = new Date(now + REFRESH_TTL_MS).toISOString();
    const refreshId = newId('rt');

    await client.query(
      `insert into auth_sessions (
         id, user_id, workspace_id, access_token_hash, refresh_family_id, expires_at, payload
       ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)`,
      [
        sessionId,
        scope.userId,
        scope.workspaceId,
        accessHash,
        familyId,
        accessExpires,
        JSON.stringify({ provider: normalizedProvider }),
      ],
    );
    await client.query(
      `insert into auth_refresh_tokens (
         id, session_id, user_id, workspace_id, token_hash, family_id, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [refreshId, sessionId, scope.userId, scope.workspaceId, refreshHash, familyId, refreshExpires],
    );
    await client.query(
      `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
       values ($1, $2, $3, 'session.issue', 'auth_session', $4, $5::jsonb)`,
      [newId('aud'), scope.workspaceId, scope.userId, sessionId, JSON.stringify({ provider: normalizedProvider })],
    );

    return {
      sessionId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      role: scope.role,
      accessToken,
      refreshToken,
      accessExpiresAt: accessExpires,
      refreshExpiresAt: refreshExpires,
      scope,
    };
  });
}

async function authenticateAccessToken(pool, accessToken) {
  const hash = hashToken(accessToken);
  if (!hash || !String(accessToken || '').trim()) {
    reject('SESSION_ACCESS_INVALID', 'access token missing');
  }
  const result = await pool.query(
    `select s.id, s.user_id, s.workspace_id, s.expires_at, s.revoked_at
     from auth_sessions s
     where s.access_token_hash = $1
     limit 1`,
    [hash],
  );
  if (!result.rowCount) {
    reject('SESSION_ACCESS_INVALID', 'access token not found');
  }
  const row = result.rows[0];
  if (row.revoked_at) {
    reject('SESSION_REVOKED', 'session revoked');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    reject('SESSION_ACCESS_EXPIRED', 'access token expired');
  }
  const scope = await resolveWorkspaceScope(pool, {
    userId: row.user_id,
    workspaceId: row.workspace_id,
  });
  await pool.query(
    `update auth_sessions set last_seen_at = now(), updated_at = now() where id = $1`,
    [row.id],
  );
  return {
    sessionId: row.id,
    scope,
  };
}

/**
 * Atomic one-time refresh with SELECT FOR UPDATE on the token row.
 * Concurrent loser: locks the already-used row, writes family revocation + audit, returns a
 * replay sentinel so withTransaction COMMITS, then SESSION_REFRESH_REPLAY is thrown outside.
 * That committed revoke makes any winner-issued refresh unusable.
 */
async function refreshSession(pool, { refreshToken } = {}) {
  const hash = hashToken(refreshToken);
  if (!hash || !String(refreshToken || '').trim()) {
    reject('SESSION_REFRESH_INVALID', 'refresh token missing');
  }

  const outcome = await withTransaction(pool, async (client) => {
    // Lock the token row first so concurrent refreshes serialize on this hash.
    const existing = await client.query(
      `select * from auth_refresh_tokens where token_hash = $1 for update`,
      [hash],
    );
    if (!existing.rowCount) {
      reject('SESSION_REFRESH_INVALID', 'refresh token not found');
    }
    const locked = existing.rows[0];

    if (locked.revoked_at) {
      reject('SESSION_REFRESH_REVOKED', 'refresh token revoked');
    }
    if (new Date(locked.expires_at).getTime() <= Date.now()) {
      reject('SESSION_REFRESH_EXPIRED', 'refresh token expired');
    }

    // Replay / concurrent loser: token already consumed — revoke whole family and commit via sentinel.
    if (locked.used_at) {
      await client.query(
        `update auth_refresh_tokens set revoked_at = coalesce(revoked_at, now())
         where family_id = $1`,
        [locked.family_id],
      );
      await client.query(
        `update auth_sessions set revoked_at = coalesce(revoked_at, now()), updated_at = now()
         where refresh_family_id = $1`,
        [locked.family_id],
      );
      await client.query(
        `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
         values ($1, $2, $3, 'session.refresh_replay', 'auth_session', $4, '{}'::jsonb)`,
        [newId('aud'), locked.workspace_id, locked.user_id, locked.session_id],
      );
      // Do not throw here — withTransaction would ROLLBACK and erase the revoke.
      return {
        kind: 'replay',
        code: 'SESSION_REFRESH_REPLAY',
        message: 'refresh token replay detected; family revoked',
      };
    }

    // Exclusive claim after lock: set used_at only if still unused.
    const claim = await client.query(
      `update auth_refresh_tokens
       set used_at = now()
       where id = $1
         and used_at is null
         and revoked_at is null
       returning *`,
      [locked.id],
    );
    if (!claim.rowCount) {
      // Lost the claim under the lock — treat as replay and revoke family (commit via sentinel).
      await client.query(
        `update auth_refresh_tokens set revoked_at = coalesce(revoked_at, now())
         where family_id = $1`,
        [locked.family_id],
      );
      await client.query(
        `update auth_sessions set revoked_at = coalesce(revoked_at, now()), updated_at = now()
         where refresh_family_id = $1`,
        [locked.family_id],
      );
      await client.query(
        `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
         values ($1, $2, $3, 'session.refresh_replay', 'auth_session', $4, '{}'::jsonb)`,
        [newId('aud'), locked.workspace_id, locked.user_id, locked.session_id],
      );
      return {
        kind: 'replay',
        code: 'SESSION_REFRESH_REPLAY',
        message: 'refresh token replay detected; family revoked',
      };
    }

    const row = claim.rows[0];
    const session = await client.query(
      `select * from auth_sessions where id = $1 for update`,
      [row.session_id],
    );
    if (!session.rowCount || session.rows[0].revoked_at) {
      // Session unusable: revoke family and surface after commit.
      await client.query(
        `update auth_refresh_tokens set revoked_at = coalesce(revoked_at, now())
         where family_id = $1`,
        [row.family_id],
      );
      await client.query(
        `update auth_sessions set revoked_at = coalesce(revoked_at, now()), updated_at = now()
         where refresh_family_id = $1`,
        [row.family_id],
      );
      return {
        kind: 'replay',
        code: 'SESSION_REVOKED',
        message: 'session revoked',
      };
    }

    const scope = await resolveWorkspaceScope(client, {
      userId: row.user_id,
      workspaceId: row.workspace_id,
    });

    const accessToken = newOpaqueToken();
    const nextRefresh = newOpaqueToken();
    const accessHash = hashToken(accessToken);
    const refreshHash = hashToken(nextRefresh);
    const now = Date.now();
    const accessExpires = new Date(now + ACCESS_TTL_MS).toISOString();
    const refreshExpires = new Date(now + REFRESH_TTL_MS).toISOString();
    const refreshId = newId('rt');

    await client.query(
      `update auth_sessions
       set access_token_hash = $2, expires_at = $3::timestamptz, last_seen_at = now(), updated_at = now()
       where id = $1`,
      [row.session_id, accessHash, accessExpires],
    );
    await client.query(
      `insert into auth_refresh_tokens (
         id, session_id, user_id, workspace_id, token_hash, family_id, parent_id, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [
        refreshId,
        row.session_id,
        scope.userId,
        scope.workspaceId,
        refreshHash,
        row.family_id,
        row.id,
        refreshExpires,
      ],
    );
    await client.query(
      `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
       values ($1, $2, $3, 'session.refresh', 'auth_session', $4, '{}'::jsonb)`,
      [newId('aud'), scope.workspaceId, scope.userId, row.session_id],
    );

    // If a concurrent loser already revoked the family, do not return usable tokens.
    const familyRevoked = await client.query(
      `select 1 from auth_refresh_tokens
       where family_id = $1 and revoked_at is not null
       limit 1`,
      [row.family_id],
    );
    if (familyRevoked.rowCount) {
      // Roll back this mint so we never hand out tokens for a revoked family.
      reject('SESSION_REFRESH_CONTENTION', 'refresh contention; family revoked');
    }

    return {
      kind: 'ok',
      value: {
        sessionId: row.session_id,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        role: scope.role,
        accessToken,
        refreshToken: nextRefresh,
        accessExpiresAt: accessExpires,
        refreshExpiresAt: refreshExpires,
        scope,
      },
    };
  });

  // Committed side effects (family revoke + audit) then throw outside the transaction.
  if (outcome && outcome.kind === 'replay') {
    reject(outcome.code || 'SESSION_REFRESH_REPLAY', outcome.message || 'refresh token replay detected; family revoked');
  }
  if (!outcome || outcome.kind !== 'ok' || !outcome.value) {
    reject('SESSION_REFRESH_INVALID', 'refresh failed');
  }
  return outcome.value;
}

async function logoutSession(pool, { accessToken } = {}) {
  return withTransaction(pool, async (client) => {
    const hash = hashToken(accessToken);
    if (!hash || !String(accessToken || '').trim()) {
      reject('SESSION_ACCESS_INVALID', 'access token missing');
    }
    const result = await client.query(
      `select s.id, s.user_id, s.workspace_id, s.expires_at, s.revoked_at, s.refresh_family_id
       from auth_sessions s
       where s.access_token_hash = $1
       limit 1
       for update`,
      [hash],
    );
    if (!result.rowCount) {
      reject('SESSION_ACCESS_INVALID', 'access token invalid for logout');
    }
    const row = result.rows[0];
    if (row.revoked_at) {
      reject('SESSION_REVOKED', 'session already revoked');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      // Still allow logout of expired access to revoke refresh family.
    }
    const scope = await resolveWorkspaceScope(client, {
      userId: row.user_id,
      workspaceId: row.workspace_id,
    });
    await client.query(
      `update auth_sessions set revoked_at = now(), updated_at = now() where id = $1`,
      [row.id],
    );
    await client.query(
      `update auth_refresh_tokens set revoked_at = now()
       where session_id = $1 and revoked_at is null`,
      [row.id],
    );
    await client.query(
      `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
       values ($1, $2, $3, 'session.logout', 'auth_session', $4, '{}'::jsonb)`,
      [newId('aud'), scope.workspaceId, scope.userId, row.id],
    );
    return { ok: true, sessionId: row.id };
  });
}

/**
 * Map a verified provider subject to User + auth_identity, creating exactly one
 * personal Workspace + owner membership on first login. Email is profile only.
 * Returns { userId, memberships: [{ workspaceId, workspaceName, role }] }.
 */
async function bootstrapUserWorkspaceForVerifiedSubject(pool, {
  provider,
  providerSubject,
  email = '',
  displayName = '',
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    reject('SESSION_POOL_REQUIRED', 'bootstrap requires a pool');
  }
  const normalizedProvider = String(provider || '').trim();
  const normalizedSubject = String(providerSubject || '').trim();
  if (!normalizedProvider || !normalizedSubject) {
    reject('SESSION_SUBJECT_REQUIRED', 'provider and providerSubject are required');
  }
  const profileEmail = String(email || '').trim().toLowerCase();
  const profileName = String(displayName || '').trim() || (profileEmail ? profileEmail.split('@')[0] : 'Agent Calendar user');

  return withTransaction(pool, async (client) => {
    const existing = await client.query(
      `select ai.user_id, u.status as user_status
       from auth_identities ai
       inner join users u on u.id = ai.user_id
       where ai.provider = $1 and ai.provider_subject = $2
       limit 1
       for update of ai`,
      [normalizedProvider, normalizedSubject],
    );

    let userId;
    if (existing.rowCount) {
      userId = existing.rows[0].user_id;
      if (existing.rows[0].user_status !== 'active') {
        reject('SESSION_USER_INACTIVE', 'user is inactive');
      }
      // Refresh non-authoritative profile fields only.
      await client.query(
        `update users
         set display_name = case when $2 <> '' then $2 else display_name end,
             payload = payload || $3::jsonb,
             updated_at = now()
         where id = $1`,
        [
          userId,
          profileName,
          JSON.stringify(profileEmail ? { email: profileEmail } : {}),
        ],
      );
      await client.query(
        `update auth_identities
         set payload = payload || $1::jsonb, updated_at = now()
         where provider = $2 and provider_subject = $3`,
        [
          JSON.stringify(profileEmail ? { email: profileEmail } : {}),
          normalizedProvider,
          normalizedSubject,
        ],
      );
    } else {
      userId = newId('user');
      const workspaceId = newId('ws');
      const membershipId = newId('mem');
      const identityId = newId('aid');
      const personalName = profileName ? `${profileName}'s Workspace` : 'Personal Workspace';

      await client.query(
        `insert into users (id, display_name, status, payload)
         values ($1, $2, 'active', $3::jsonb)`,
        [
          userId,
          profileName,
          JSON.stringify({
            kind: 'personal_operator',
            ...(profileEmail ? { email: profileEmail } : {}),
          }),
        ],
      );
      await client.query(
        `insert into workspaces (id, name, status, payload)
         values ($1, $2, 'active', $3::jsonb)`,
        [
          workspaceId,
          personalName,
          JSON.stringify({ kind: 'personal_workspace', owner_user_id: userId }),
        ],
      );
      await client.query(
        `insert into workspace_memberships (id, user_id, workspace_id, role, status, payload)
         values ($1, $2, $3, 'owner', 'active', $4::jsonb)`,
        [
          membershipId,
          userId,
          workspaceId,
          JSON.stringify({ kind: 'personal_owner_membership' }),
        ],
      );
      await client.query(
        `insert into auth_identities (id, user_id, provider, provider_subject, payload)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [
          identityId,
          userId,
          normalizedProvider,
          normalizedSubject,
          JSON.stringify({
            kind: 'workos_authkit',
            ...(profileEmail ? { email: profileEmail } : {}),
          }),
        ],
      );
      await client.query(
        `insert into audit_events (id, workspace_id, actor_user_id, action, resource_type, resource_id, payload)
         values ($1, $2, $3, 'account.bootstrap', 'user', $3, $4::jsonb)`,
        [
          newId('aud'),
          workspaceId,
          userId,
          JSON.stringify({ provider: normalizedProvider }),
        ],
      );
    }

    const memberships = await client.query(
      `select m.workspace_id, m.role, w.name as workspace_name
       from workspace_memberships m
       inner join workspaces w on w.id = m.workspace_id
       where m.user_id = $1
         and m.status = 'active'
         and w.status = 'active'
       order by m.created_at asc`,
      [userId],
    );

    // First login always has exactly one membership created above.
    // If somehow zero (data corruption), reject rather than invent.
    if (!memberships.rowCount) {
      reject('SESSION_NO_MEMBERSHIP', 'user has no active workspace membership');
    }

    return {
      userId,
      memberships: memberships.rows.map((row) => ({
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        role: row.role,
      })),
    };
  });
}

module.exports = {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  authenticateAccessToken,
  bootstrapUserWorkspaceForVerifiedSubject,
  hashToken,
  issueSessionForVerifiedSubject,
  logoutSession,
  refreshSession,
};
