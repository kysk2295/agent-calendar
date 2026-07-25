'use strict';

const {
  assertActiveMembership,
  assertWorkspaceScope,
} = require('./workspace-scope');

/**
 * Workspace-scoped calendar-first persistence for tasks + calendar_events.
 * Every public method requires a server-derived WorkspaceScope and re-validates membership.
 */
class WorkspaceScopedCalendarRepository {
  constructor({ pool } = {}) {
    if (!pool || typeof pool.query !== 'function') {
      throw new Error('WorkspaceScopedCalendarRepository requires a PostgreSQL pool');
    }
    this.pool = pool;
  }

  async #scope(scope) {
    return assertActiveMembership(this.pool, scope);
  }

  async listTasks(scope) {
    const valid = await this.#scope(scope);
    const result = await this.pool.query(
      `select id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id,
              created_at, updated_at
       from tasks
       where workspace_id = $1
       order by updated_at desc, id asc`,
      [valid.workspaceId],
    );
    return result.rows;
  }

  async getTaskById(scope, taskId) {
    const valid = await this.#scope(scope);
    const id = String(taskId || '').trim();
    if (!id) return null;
    const result = await this.pool.query(
      `select id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id,
              created_at, updated_at
       from tasks
       where workspace_id = $1 and id = $2
       limit 1`,
      [valid.workspaceId, id],
    );
    return result.rowCount ? result.rows[0] : null;
  }

  async listCalendarEvents(scope) {
    const valid = await this.#scope(scope);
    const result = await this.pool.query(
      `select id, task_id, title, starts_at, payload, workspace_id, created_at, updated_at
       from calendar_events
       where workspace_id = $1
       order by starts_at asc, id asc`,
      [valid.workspaceId],
    );
    return result.rows;
  }

  async getCalendarEventById(scope, eventId) {
    const valid = await this.#scope(scope);
    const id = String(eventId || '').trim();
    if (!id) return null;
    const result = await this.pool.query(
      `select id, task_id, title, starts_at, payload, workspace_id, created_at, updated_at
       from calendar_events
       where workspace_id = $1 and id = $2
       limit 1`,
      [valid.workspaceId, id],
    );
    return result.rowCount ? result.rows[0] : null;
  }
}

module.exports = {
  WorkspaceScopedCalendarRepository,
  assertWorkspaceScope,
};
