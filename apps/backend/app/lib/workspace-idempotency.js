'use strict';

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function hashRequestCanonical({ method, path, body }) {
  const canonical = JSON.stringify({
    method: String(method || 'GET').toUpperCase(),
    path: String(path || ''),
    body: body === undefined ? null : body,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function readIdempotencyKey(headers = {}) {
  const raw = headers['idempotency-key']
    || headers['Idempotency-Key']
    || headers['x-idempotency-key']
    || headers['X-Idempotency-Key']
    || '';
  return String(raw || '').trim();
}

/**
 * Workspace-scoped atomic idempotency for production mutations.
 * scope column stores route/action fingerprint; PK is (workspace_id, scope, idempotency_key).
 */
class WorkspaceIdempotencyStore {
  constructor({ pool, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!pool) throw new Error('WorkspaceIdempotencyStore requires pool');
    this.pool = pool;
    this.ttlMs = ttlMs;
  }

  #scopeKey(route, action) {
    return `${String(route || '')}::${String(action || '')}`;
  }

  /**
   * Begin or replay an idempotent operation.
   * @returns {Promise<
   *   | { kind: 'replay', status: number, body: object }
   *   | { kind: 'conflict', status: 409, body: object }
   *   | { kind: 'execute', complete: Function, fail: Function }
   *   | { kind: 'skip' }
   * >}
   */
  async begin(scope, {
    idempotencyKey,
    method,
    path,
    body,
    route = '',
    action = '',
  } = {}) {
    assertWorkspaceScope(scope);
    const key = String(idempotencyKey || '').trim();
    if (!key) return { kind: 'skip' };

    const requestHash = hashRequestCanonical({ method, path, body });
    const scopeKey = this.#scopeKey(route, action);
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();

    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      // Best-effort cleanup of expired rows for this workspace.
      await client.query(
        `delete from idempotency_keys
         where workspace_id = $1
           and expires_at is not null
           and expires_at < now()`,
        [valid.workspaceId],
      );

      const existing = await client.query(
        `select request_hash, response_status, response_body, status, route, action
         from idempotency_keys
         where workspace_id = $1 and scope = $2 and idempotency_key = $3
         for update`,
        [valid.workspaceId, scopeKey, key],
      );

      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.request_hash && row.request_hash !== requestHash) {
          return {
            kind: 'conflict',
            status: 409,
            body: {
              ok: false,
              error: 'idempotency_key_conflict',
              message: 'idempotency key reused with different payload',
            },
          };
        }
        if (row.status === 'completed' || row.status === 'failed') {
          return {
            kind: 'replay',
            status: Number(row.response_status) || (row.status === 'failed' ? 500 : 200),
            body: row.response_body && typeof row.response_body === 'object'
              ? row.response_body
              : { ok: row.status === 'completed' },
          };
        }
        // in_progress with same hash — concurrent waiter will re-check after short delay outside.
        return {
          kind: 'in_progress',
          status: 409,
          body: {
            ok: false,
            error: 'idempotency_in_progress',
            message: 'duplicate request in progress',
          },
        };
      }

      // SAVEPOINT so concurrent unique-violation does not abort the whole txn (25P02).
      await client.query('savepoint idempotency_insert');
      try {
        await client.query(
          `insert into idempotency_keys (
             workspace_id, scope, idempotency_key, request_hash,
             response_status, response_body, status, route, action, locked_at, expires_at
           ) values ($1, $2, $3, $4, null, '{}'::jsonb, 'in_progress', $5, $6, now(), $7::timestamptz)`,
          [valid.workspaceId, scopeKey, key, requestHash, String(route || ''), String(action || ''), expiresAt],
        );
        await client.query('release savepoint idempotency_insert');
      } catch (error) {
        await client.query('rollback to savepoint idempotency_insert').catch(() => undefined);
        // Concurrent begin: peer won the insert — re-read under lock.
        if (error && (error.code === '23505' || /duplicate|unique/i.test(String(error.message || '')))) {
          const raced = await client.query(
            `select request_hash, response_status, response_body, status
             from idempotency_keys
             where workspace_id = $1 and scope = $2 and idempotency_key = $3
             for update`,
            [valid.workspaceId, scopeKey, key],
          );
          if (raced.rowCount) {
            const row = raced.rows[0];
            if (row.request_hash && row.request_hash !== requestHash) {
              return {
                kind: 'conflict',
                status: 409,
                body: {
                  ok: false,
                  error: 'idempotency_key_conflict',
                  message: 'idempotency key reused with different payload',
                },
              };
            }
            if (row.status === 'completed' || row.status === 'failed') {
              return {
                kind: 'replay',
                status: Number(row.response_status) || (row.status === 'failed' ? 500 : 200),
                body: row.response_body && typeof row.response_body === 'object'
                  ? row.response_body
                  : { ok: row.status === 'completed' },
              };
            }
            return {
              kind: 'in_progress',
              status: 409,
              body: {
                ok: false,
                error: 'idempotency_in_progress',
                message: 'duplicate request in progress',
              },
            };
          }
        }
        throw error;
      }

      const complete = async (status, responseBody) => {
        await withAppRoleWorkspaceTransaction(this.pool, scope, async (c, v) => {
          await c.query(
            `update idempotency_keys
             set status = $4,
                 response_status = $5,
                 response_body = $6::jsonb,
                 expires_at = $7::timestamptz
             where workspace_id = $1 and scope = $2 and idempotency_key = $3`,
            [
              v.workspaceId,
              scopeKey,
              key,
              status >= 400 ? 'failed' : 'completed',
              status,
              JSON.stringify(responseBody || {}),
              expiresAt,
            ],
          );
        });
      };

      const fail = async (status, responseBody) => complete(status || 500, responseBody);

      return { kind: 'execute', complete, fail };
    });
  }

  /**
   * Wait briefly for concurrent in_progress then replay if completed.
   */
  async awaitReplay(scope, { idempotencyKey, route = '', action = '', attempts = 40, delayMs = 25 } = {}) {
    assertWorkspaceScope(scope);
    const key = String(idempotencyKey || '').trim();
    if (!key) return null;
    const scopeKey = this.#scopeKey(route, action);
    for (let i = 0; i < attempts; i += 1) {
      const row = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        const result = await client.query(
          `select status, response_status, response_body
           from idempotency_keys
           where workspace_id = $1 and scope = $2 and idempotency_key = $3
           limit 1`,
          [valid.workspaceId, scopeKey, key],
        );
        return result.rowCount ? result.rows[0] : null;
      });
      if (row && (row.status === 'completed' || row.status === 'failed')) {
        return {
          status: Number(row.response_status) || (row.status === 'failed' ? 500 : 200),
          body: row.response_body && typeof row.response_body === 'object'
            ? row.response_body
            : { ok: row.status === 'completed' },
        };
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    // Deterministic terminal for waiters: never hang; surface in_progress 409.
    return {
      status: 409,
      body: {
        ok: false,
        error: 'idempotency_in_progress',
        message: 'duplicate request still in progress',
      },
    };
  }
}

module.exports = {
  WorkspaceIdempotencyStore,
  hashRequestCanonical,
  readIdempotencyKey,
  DEFAULT_TTL_MS,
};
