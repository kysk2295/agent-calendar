'use strict';

/**
 * Server-derived Workspace authorization context.
 * Only resolveWorkspaceScope may issue a WorkspaceScope. Role always comes from
 * active membership rows; never from caller-selected payload fields.
 */

const LEGACY_OWNER_USER_ID = 'legacy-owner-user';
const LEGACY_PERSONAL_WORKSPACE_ID = 'legacy-personal-workspace';
const LEGACY_OWNER_MEMBERSHIP_ID = 'legacy-owner-membership';
const SCOPE_KIND = 'WorkspaceScope';

/** Private issuance registry: only objects produced by issueWorkspaceScope are valid. */
const issuedScopes = new WeakSet();

function normalizeId(value) {
  return String(value || '').trim();
}

/**
 * Module-private constructor. Not exported.
 * @private
 */
function issueWorkspaceScope({ userId, workspaceId, role } = {}) {
  const normalizedUserId = normalizeId(userId);
  const normalizedWorkspaceId = normalizeId(workspaceId);
  const normalizedRole = normalizeId(role);
  if (!normalizedUserId) {
    throw new Error('WorkspaceScope requires userId');
  }
  if (!normalizedWorkspaceId) {
    throw new Error('WorkspaceScope requires workspaceId');
  }
  if (!normalizedRole) {
    throw new Error('WorkspaceScope requires role');
  }
  const scope = Object.freeze({
    kind: SCOPE_KIND,
    userId: normalizedUserId,
    workspaceId: normalizedWorkspaceId,
    role: normalizedRole,
  });
  issuedScopes.add(scope);
  return scope;
}

function assertWorkspaceScope(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new Error('invalid WorkspaceScope: missing scope object');
  }
  if (scope.kind !== SCOPE_KIND) {
    throw new Error('invalid WorkspaceScope: kind must be WorkspaceScope (server-derived)');
  }
  if (!normalizeId(scope.userId) || !normalizeId(scope.workspaceId) || !normalizeId(scope.role)) {
    throw new Error('invalid WorkspaceScope: userId, workspaceId, and role are required');
  }
  if (Object.isFrozen && !Object.isFrozen(scope)) {
    throw new Error('invalid WorkspaceScope: scope must be immutable');
  }
  if (!issuedScopes.has(scope)) {
    const error = new Error('invalid WorkspaceScope: not server-issued');
    error.code = 'WORKSPACE_SCOPE_NOT_ISSUED';
    throw error;
  }
  return scope;
}

/**
 * Load active membership with active user + active workspace.
 * Role is always taken from the membership row.
 */
async function loadActiveMembershipRow(pool, { userId, workspaceId }) {
  const result = await pool.query(
    `select m.role as role
     from workspace_memberships m
     inner join users u
       on u.id = m.user_id
      and u.status = 'active'
     inner join workspaces w
       on w.id = m.workspace_id
      and w.status = 'active'
     where m.user_id = $1
       and m.workspace_id = $2
       and m.status = 'active'
     limit 1`,
    [userId, workspaceId],
  );
  if (!result.rowCount) {
    const error = new Error(
      'WorkspaceScope forbidden: active membership with active user and workspace not found',
    );
    error.code = 'WORKSPACE_SCOPE_FORBIDDEN';
    throw error;
  }
  return {
    role: normalizeId(result.rows[0].role) || 'member',
  };
}

/**
 * Resolve membership in PostgreSQL and return a frozen, server-issued WorkspaceScope.
 * Rejects inactive/missing membership, inactive User, or inactive Workspace.
 * Role is derived only from the membership row.
 */
async function resolveWorkspaceScope(pool, { userId, workspaceId } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('resolveWorkspaceScope requires a PostgreSQL pool');
  }
  const normalizedUserId = normalizeId(userId);
  const normalizedWorkspaceId = normalizeId(workspaceId);
  if (!normalizedUserId || !normalizedWorkspaceId) {
    throw new Error('resolveWorkspaceScope requires userId and workspaceId');
  }

  const membership = await loadActiveMembershipRow(pool, {
    userId: normalizedUserId,
    workspaceId: normalizedWorkspaceId,
  });

  return issueWorkspaceScope({
    userId: normalizedUserId,
    workspaceId: normalizedWorkspaceId,
    role: membership.role,
  });
}

/**
 * Re-validate a previously issued scope before repository IO.
 * Requires private issuance marker; re-loads role from membership (rejects elevation).
 * Rejects inactive user/workspace/membership.
 */
async function assertActiveMembership(pool, scope) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('assertActiveMembership requires a PostgreSQL pool');
  }
  const valid = assertWorkspaceScope(scope);
  const membership = await loadActiveMembershipRow(pool, {
    userId: valid.userId,
    workspaceId: valid.workspaceId,
  });

  if (membership.role !== valid.role) {
    const error = new Error(
      'WorkspaceScope forbidden: role does not match active membership (caller-selected roles are rejected)',
    );
    error.code = 'WORKSPACE_SCOPE_ROLE_MISMATCH';
    throw error;
  }

  // Re-issue so callers always hold a scope with membership-derived role and a fresh issuance marker.
  return issueWorkspaceScope({
    userId: valid.userId,
    workspaceId: valid.workspaceId,
    role: membership.role,
  });
}

module.exports = {
  LEGACY_OWNER_MEMBERSHIP_ID,
  LEGACY_OWNER_USER_ID,
  LEGACY_PERSONAL_WORKSPACE_ID,
  SCOPE_KIND,
  assertActiveMembership,
  assertWorkspaceScope,
  resolveWorkspaceScope,
  // createWorkspaceScope is intentionally NOT exported — resolveWorkspaceScope is the only issuance path.
};
