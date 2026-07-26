'use strict';

const { assertActiveMembership, assertWorkspaceScope } = require('./workspace-scope');

/**
 * Bind server-derived WorkspaceScope into a PostgreSQL transaction for RLS.
 * Never reads workspaceId from request body — caller must pass an issued scope.
 */
async function withWorkspaceTransaction(pool, scope, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('withWorkspaceTransaction requires a Pool');
  }
  const valid = assertWorkspaceScope(scope);
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Re-validate membership under the same connection before setting RLS context.
    await assertActiveMembership(client, valid);
    await client.query(`select set_config('app.workspace_id', $1, true)`, [valid.workspaceId]);
    await client.query(`select set_config('app.user_id', $1, true)`, [valid.userId]);
    await client.query(`select set_config('app.role', $1, true)`, [valid.role]);
    const result = await fn(client, valid);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run as non-BYPASSRLS app role with workspace RLS context (for hostile tests / hardened paths).
 */
async function withAppRoleWorkspaceTransaction(pool, scope, fn) {
  return withWorkspaceTransaction(pool, scope, async (client, valid) => {
    await client.query('set local role agent_calendar_app');
    // Re-apply settings after SET ROLE (session GUCs with is_local remain for transaction).
    await client.query(`select set_config('app.workspace_id', $1, true)`, [valid.workspaceId]);
    await client.query(`select set_config('app.user_id', $1, true)`, [valid.userId]);
    return fn(client, valid);
  });
}

function workspaceAuthMode(env = process.env) {
  const mode = String(env.WORKSPACE_AUTH_MODE || 'legacy').trim().toLowerCase();
  return mode === 'production' ? 'production' : 'legacy';
}

function isProductionWorkspaceAuth(env = process.env) {
  return workspaceAuthMode(env) === 'production';
}

module.exports = {
  isProductionWorkspaceAuth,
  withAppRoleWorkspaceTransaction,
  withWorkspaceTransaction,
  workspaceAuthMode,
};
