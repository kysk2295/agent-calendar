'use strict';

const crypto = require('node:crypto');
const { assertActiveMembership, assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { normalizeInferencePolicy } = require('./workspace-inference-broker');
const {
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  WorkspaceAgentDirectoryError,
} = require('./workspace-agent-directory');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function scrubSettingsValue(value) {
  if (Array.isArray(value)) return value.map(scrubSettingsValue);
  if (!value || typeof value !== 'object') return value;
  const scrubbed = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/token|secret|password|apiKey|api_key|refresh|cookie|credential|authorization/i.test(key)) {
      continue;
    }
    scrubbed[key] = scrubSettingsValue(nested);
  }
  return scrubbed;
}

function mapEventKind(kind, phase) {
  const k = String(kind || '').toLowerCase();
  if (['user_message', 'agent_message', 'plan', 'progress', 'artifact', 'completion', 'error', 'blocked'].includes(k)) {
    return k;
  }
  const p = String(phase || '').toLowerCase();
  if (p === 'plan') return 'plan';
  if (p === 'progress' || p === 'leased' || p === 'accepted' || p === 'retry') return 'progress';
  if (p === 'artifact') return 'artifact';
  if (p === 'result' || p === 'completed') return 'completion';
  if (p === 'failed' || p === 'cancel' || p === 'cancelling') return 'error';
  return 'agent_message';
}

function requireOwner(scope) {
  assertWorkspaceScope(scope);
  if (String(scope.role || '').toLowerCase() !== 'owner') {
    const error = new Error('owner role required');
    error.code = 'ROLE_FORBIDDEN';
    error.statusHint = 403;
    throw error;
  }
}

/**
 * Product reads/writes under WorkspaceScope + app-role RLS transaction.
 * Never uses global HermesStore. Every SQL filters by workspace_id.
 */
class WorkspaceScopedProductService {
  constructor({ pool, useAppRole = true } = {}) {
    if (!pool) throw new Error('WorkspaceScopedProductService requires pool');
    this.pool = pool;
    this.useAppRole = useAppRole;
  }

  async #run(scope, fn) {
    assertWorkspaceScope(scope);
    if (this.useAppRole) {
      return withAppRoleWorkspaceTransaction(this.pool, scope, fn);
    }
    await assertActiveMembership(this.pool, scope);
    return fn(this.pool, scope);
  }

  // ── Tasks ──────────────────────────────────────────────────────────

  async listTasks(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id,
                created_at, updated_at
         from tasks
         where workspace_id = $1
         order by updated_at desc, id asc`,
        [valid.workspaceId],
      );
      return result.rows.map((row) => this.#mapTask(row));
    });
  }

  async getTaskById(scope, taskId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id,
                created_at, updated_at
         from tasks
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, String(taskId || '')],
      );
      return result.rowCount ? this.#mapTask(result.rows[0]) : null;
    });
  }

  async createTask(scope, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('task'));
      const title = String(input.title || input.name || 'Untitled task');
      const status = String(input.status || 'open');
      const owner = String(input.owner || valid.userId);
      const dueAt = String(input.dueAt || input.due_at || '');
      const payload = {
        ...asObject(input.payload),
        ...asObject(input),
        id,
        title,
        status,
        owner,
        dueAt,
        kind: input.kind || input.type || 'task',
        workspaceId: valid.workspaceId,
      };
      delete payload.payload;
      await client.query(
        `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          id,
          title,
          status,
          owner,
          dueAt,
          String(input.missionId || input.mission_id || ''),
          String(input.sessionId || input.session_id || ''),
          JSON.stringify(payload),
          valid.workspaceId,
        ],
      );
      return this.#mapTask({
        id, title, status, owner, due_at: dueAt, payload, workspace_id: valid.workspaceId,
      });
    });
  }

  async updateTask(scope, taskId, patch = {}) {
    return this.#run(scope, async (client, valid) => {
      const existing = await client.query(
        `select id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id
         from tasks where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(taskId || '')],
      );
      if (!existing.rowCount) return null;
      const row = existing.rows[0];
      const prev = asObject(row.payload);
      const title = patch.title !== undefined ? String(patch.title) : row.title;
      const status = patch.status !== undefined ? String(patch.status) : row.status;
      const owner = patch.owner !== undefined ? String(patch.owner) : row.owner;
      const dueAt = patch.dueAt !== undefined || patch.due_at !== undefined
        ? String(patch.dueAt || patch.due_at || '')
        : row.due_at;
      const payload = {
        ...prev,
        ...asObject(patch),
        id: row.id,
        title,
        status,
        owner,
        dueAt,
        workspaceId: valid.workspaceId,
      };
      delete payload.payload;
      await client.query(
        `update tasks
         set title = $3, status = $4, owner = $5, due_at = $6, payload = $7::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, row.id, title, status, owner, dueAt, JSON.stringify(payload)],
      );
      return this.#mapTask({
        ...row, title, status, owner, due_at: dueAt, payload, workspace_id: valid.workspaceId,
      });
    });
  }

  async deleteTask(scope, taskId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `delete from tasks where workspace_id = $1 and id = $2 returning id`,
        [valid.workspaceId, String(taskId || '')],
      );
      return result.rowCount > 0;
    });
  }

  #mapTask(row) {
    const payload = asObject(row.payload);
    return {
      id: row.id,
      title: row.title || payload.title || '',
      status: row.status || payload.status || '',
      owner: row.owner || payload.owner || '',
      dueAt: row.due_at || payload.dueAt || '',
      missionId: row.mission_id || payload.missionId || '',
      sessionId: row.session_id || payload.sessionId || '',
      workspaceId: row.workspace_id,
      kind: payload.kind || payload.type || 'task',
      type: payload.type || payload.kind || 'task',
      ...payload,
      id: row.id,
      workspaceId: row.workspace_id,
    };
  }

  // ── Calendar events ────────────────────────────────────────────────

  async listCalendarEvents(scope, { from, to } = {}) {
    return this.#run(scope, async (client, valid) => {
      const params = [valid.workspaceId];
      let sql = `select id, task_id, title, starts_at, payload, workspace_id, created_at, updated_at
                 from calendar_events where workspace_id = $1`;
      if (from) {
        params.push(String(from));
        sql += ` and starts_at >= $${params.length}`;
      }
      if (to) {
        params.push(String(to));
        sql += ` and starts_at <= $${params.length}`;
      }
      sql += ' order by starts_at asc, id asc';
      const result = await client.query(sql, params);
      return result.rows.map((row) => this.#mapEvent(row));
    });
  }

  async getCalendarEventById(scope, eventId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, task_id, title, starts_at, payload, workspace_id
         from calendar_events where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(eventId || '')],
      );
      return result.rowCount ? this.#mapEvent(result.rows[0]) : null;
    });
  }

  async createCalendarEvent(scope, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('event'));
      const title = String(input.title || 'Untitled event');
      const startsAt = String(input.startsAt || input.starts_at || input.start || '');
      const taskId = input.taskId || input.task_id || null;
      const payload = {
        ...asObject(input.payload),
        ...asObject(input),
        id,
        title,
        startsAt,
        kind: 'calendar-event',
        type: 'calendar-event',
        workspaceId: valid.workspaceId,
      };
      delete payload.payload;
      await client.query(
        `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, taskId, title, startsAt, JSON.stringify(payload), valid.workspaceId],
      );
      return this.#mapEvent({
        id, task_id: taskId, title, starts_at: startsAt, payload, workspace_id: valid.workspaceId,
      });
    });
  }

  async updateCalendarEvent(scope, eventId, patch = {}) {
    return this.#run(scope, async (client, valid) => {
      const existing = await client.query(
        `select id, task_id, title, starts_at, payload, workspace_id
         from calendar_events where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(eventId || '')],
      );
      if (!existing.rowCount) return null;
      const row = existing.rows[0];
      const prev = asObject(row.payload);
      const title = patch.title !== undefined ? String(patch.title) : row.title;
      const startsAt = patch.startsAt !== undefined || patch.starts_at !== undefined
        ? String(patch.startsAt || patch.starts_at || '')
        : row.starts_at;
      const payload = {
        ...prev,
        ...asObject(patch),
        id: row.id,
        title,
        startsAt,
        kind: 'calendar-event',
        type: 'calendar-event',
        workspaceId: valid.workspaceId,
      };
      delete payload.payload;
      await client.query(
        `update calendar_events
         set title = $3, starts_at = $4, payload = $5::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, row.id, title, startsAt, JSON.stringify(payload)],
      );
      return this.#mapEvent({
        ...row, title, starts_at: startsAt, payload, workspace_id: valid.workspaceId,
      });
    });
  }

  async deleteCalendarEvent(scope, eventId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `delete from calendar_events where workspace_id = $1 and id = $2 returning id`,
        [valid.workspaceId, String(eventId || '')],
      );
      return result.rowCount > 0;
    });
  }

  #mapEvent(row) {
    const payload = asObject(row.payload);
    const startsAt = row.starts_at || payload.startsAt || payload.starts_at || '';
    // Desktop calendar grid keys items by `date` (YYYY-MM-DD) and optional `time` (HH:mm).
    let date = String(payload.date || payload.startDate || payload.day || '');
    let time = String(payload.time || payload.t || '');
    if (!date && startsAt) {
      const match = String(startsAt).match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
      if (match) {
        date = match[1];
        if (!time && match[2]) time = match[2];
      }
    }
    return {
      ...payload,
      id: row.id,
      taskId: row.task_id || payload.taskId || null,
      title: row.title || payload.title || '',
      startsAt,
      date,
      startDate: date,
      day: date,
      time,
      kind: 'calendar-event',
      type: 'calendar-event',
      source: payload.source || 'calendar-event',
      workspaceId: row.workspace_id,
    };
  }

  // ── Agents ─────────────────────────────────────────────────────────

  async listAgents(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, payload, workspace_id from agents where workspace_id = $1 order by id asc`,
        [valid.workspaceId],
      );
      return result.rows.map((row) => projectWorkspaceAgent({
        id: row.id,
        ...asObject(row.payload),
        workspaceId: row.workspace_id,
      }));
    });
  }

  async createAgent(scope, input = {}) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('agent'));
      const payload = normalizeWorkspaceAgent(input, {
        id,
        workspaceId: valid.workspaceId,
      });
      if (payload.defaultRunnerId) {
        const runner = await client.query(
          `select id from runners
           where workspace_id = $1 and id = $2 and status = 'active'
           limit 1`,
          [valid.workspaceId, payload.defaultRunnerId],
        );
        if (!runner.rowCount) {
          throw new WorkspaceAgentDirectoryError(
            'agent_runner_invalid',
            'Default Runner must belong to the Workspace',
            422,
          );
        }
      }
      if (payload.sourceKind === 'connected') {
        const duplicate = await client.query(
          `select id from agents
           where workspace_id = $1
             and lower(coalesce(payload->>'provider', '')) = lower($2)
             and coalesce(payload->>'externalAgentId', '') = $3
           limit 1`,
          [valid.workspaceId, payload.provider, payload.externalAgentId],
        );
        if (duplicate.rowCount) {
          throw new WorkspaceAgentDirectoryError(
            'agent_source_conflict',
            'This external agent is already connected to the Workspace',
            409,
          );
        }
      }
      await client.query(
        `insert into agents (id, payload, workspace_id) values ($1, $2::jsonb, $3)`,
        [id, JSON.stringify(payload), valid.workspaceId],
      );
      return { ...payload, workspaceId: valid.workspaceId };
    });
  }

  async updateAgent(scope, agentId, patch = {}) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const existing = await client.query(
        `select id, payload from agents where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(agentId || '')],
      );
      if (!existing.rowCount) return null;
      const payload = normalizeWorkspaceAgent(patch, {
        id: existing.rows[0].id,
        workspaceId: valid.workspaceId,
        existing: asObject(existing.rows[0].payload),
      });
      if (payload.defaultRunnerId) {
        const runner = await client.query(
          `select id from runners
           where workspace_id = $1 and id = $2 and status = 'active'
           limit 1`,
          [valid.workspaceId, payload.defaultRunnerId],
        );
        if (!runner.rowCount) {
          throw new WorkspaceAgentDirectoryError(
            'agent_runner_invalid',
            'Default Runner must belong to the Workspace',
            422,
          );
        }
      }
      if (payload.sourceKind === 'connected') {
        const duplicate = await client.query(
          `select id from agents
           where workspace_id = $1
             and id <> $2
             and lower(coalesce(payload->>'provider', '')) = lower($3)
             and coalesce(payload->>'externalAgentId', '') = $4
           limit 1`,
          [valid.workspaceId, existing.rows[0].id, payload.provider, payload.externalAgentId],
        );
        if (duplicate.rowCount) {
          throw new WorkspaceAgentDirectoryError(
            'agent_source_conflict',
            'This external agent is already connected to the Workspace',
            409,
          );
        }
      }
      await client.query(
        `update agents set payload = $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, existing.rows[0].id, JSON.stringify(payload)],
      );
      return payload;
    });
  }

  async deleteAgent(scope, agentId) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `delete from agents where workspace_id = $1 and id = $2 returning id`,
        [valid.workspaceId, String(agentId || '')],
      );
      return result.rowCount > 0;
    });
  }

  // ── Documents / Wiki ───────────────────────────────────────────────

  async listDocuments(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, title, path, source, payload, workspace_id
         from documents where workspace_id = $1 order by updated_at desc, id asc`,
        [valid.workspaceId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        path: row.path,
        source: row.source,
        workspaceId: row.workspace_id,
        ...asObject(row.payload),
        id: row.id,
        workspaceId: row.workspace_id,
      }));
    });
  }

  async createDocument(scope, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('doc'));
      const title = String(input.title || 'Untitled');
      const docPath = String(input.path || `wiki/${id}.md`);
      const source = String(input.source || 'wiki');
      const content = String(input.content || input.body || '');
      const payload = {
        ...asObject(input.payload),
        content,
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `insert into documents (id, title, path, source, payload, workspace_id)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, title, docPath, source, JSON.stringify(payload), valid.workspaceId],
      );
      if (content) {
        const chunkId = newId('chunk');
        await client.query(
          `insert into wiki_chunks (
             id, source, source_id, document_id, path, title, chunk_index, content, excerpt, workspace_id
           ) values ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9)`,
          [
            chunkId, source, id, id, docPath, title, content,
            content.slice(0, 200), valid.workspaceId,
          ],
        );
      }
      return {
        id, title, path: docPath, source, content, workspaceId: valid.workspaceId,
      };
    });
  }

  async listWiki(scope, { path: wikiPath, query } = {}) {
    if (query) {
      const results = await this.searchWiki(scope, query);
      return { ok: true, results, query, workspaceId: scope.workspaceId };
    }
    return this.#run(scope, async (client, valid) => {
      if (wikiPath) {
        const result = await client.query(
          `select id, title, path, content, excerpt, workspace_id, document_id
           from wiki_chunks
           where workspace_id = $1 and path = $2
           order by chunk_index asc`,
          [valid.workspaceId, String(wikiPath)],
        );
        return {
          ok: true,
          path: wikiPath,
          chunks: result.rows,
          documents: [],
          workspaceId: valid.workspaceId,
        };
      }
      const docs = await client.query(
        `select id, title, path, source, payload, workspace_id
         from documents where workspace_id = $1 and source = 'wiki'
         order by updated_at desc limit 100`,
        [valid.workspaceId],
      );
      const notes = docs.rows.map((d) => {
        const payload = asObject(d.payload);
        return {
          id: d.id,
          title: d.title,
          path: d.path,
          source: d.source,
          folder: String(d.path || '').split('/')[0] || '2_wiki',
          kind: 'wiki',
          content: payload.content || '',
          workspaceId: d.workspace_id,
          ...payload,
          id: d.id,
          title: d.title,
          path: d.path,
          workspaceId: d.workspace_id,
        };
      });
      return {
        ok: true,
        documents: notes,
        notes,
        nodes: notes.map((d) => ({ id: d.id, title: d.title, path: d.path })),
        edges: [],
        graph: { nodes: notes.map((d) => ({ id: d.id, title: d.title, path: d.path })), edges: [] },
        workspaceId: valid.workspaceId,
      };
    });
  }

  async searchWiki(scope, queryText = '') {
    const q = String(queryText || '').trim();
    return this.#run(scope, async (client, valid) => {
      if (!q) return [];
      const result = await client.query(
        `select id, title, path, content, excerpt, workspace_id, document_id
         from wiki_chunks
         where workspace_id = $1
           and (
             search_vector @@ plainto_tsquery('simple', $2)
             or title ilike '%' || $2 || '%'
             or content ilike '%' || $2 || '%'
           )
         order by updated_at desc
         limit 20`,
        [valid.workspaceId, q],
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        path: row.path,
        excerpt: row.excerpt || String(row.content || '').slice(0, 200),
        documentId: row.document_id,
        workspaceId: row.workspace_id,
      }));
    });
  }

  async searchWikiVector(scope, queryVector, { limit = 10 } = {}) {
    return this.#run(scope, async (client, valid) => {
      let vector = queryVector;
      if (typeof queryVector === 'string') {
        const text = String(queryVector || '');
        vector = Array.from({ length: 256 }, (_, i) => {
          let h = 0;
          for (let c = 0; c < text.length; c += 1) {
            h = ((h << 5) - h + text.charCodeAt(c) + i) | 0;
          }
          return (h % 1000) / 1000;
        });
      }
      if (!Array.isArray(vector)) {
        const err = new Error('invalid vector: expected number[256]');
        err.code = 'VECTOR_LENGTH_INVALID';
        throw err;
      }
      if (vector.length !== 256) {
        const err = new Error(`invalid vector length ${vector.length}: expected exactly 256`);
        err.code = 'VECTOR_LENGTH_INVALID';
        throw err;
      }
      const literal = `[${vector.map((n) => {
        const num = Number(n);
        return Number.isFinite(num) ? num : 0;
      }).join(',')}]`;
      const result = await client.query(
        `select id, title, path, content, excerpt, workspace_id, document_id,
                (embedding_vector <=> $2::vector) as vector_distance
         from wiki_chunks
         where workspace_id = $1
           and embedding_vector is not null
         order by embedding_vector <=> $2::vector
         limit $3`,
        [valid.workspaceId, literal, Math.max(1, Number(limit) || 10)],
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        path: row.path,
        excerpt: row.excerpt || String(row.content || '').slice(0, 200),
        documentId: row.document_id,
        workspaceId: row.workspace_id,
        vectorDistance: Number(row.vector_distance),
      }));
    });
  }

  async askWikiScoped(scope, question = '') {
    const q = String(question || '').trim();
    const results = await this.searchWiki(scope, q);
    const answer = results.length
      ? results.map((r) => r.excerpt || r.title).join('\n\n').slice(0, 4000)
      : 'No workspace wiki passages matched this question.';
    return {
      ok: true,
      answer,
      results,
      mode: 'workspace_keyword',
      workspaceId: scope.workspaceId,
      gatewayFallback: false,
    };
  }

  // ── Scheduler / automation ─────────────────────────────────────────

  async listSchedulerJobs(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, name, agent, model, enabled, interval_minutes, payload, workspace_id
         from scheduler_jobs where workspace_id = $1 order by id asc`,
        [valid.workspaceId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        agent: row.agent,
        model: row.model,
        enabled: row.enabled,
        intervalMinutes: row.interval_minutes,
        workspaceId: row.workspace_id,
        ...asObject(row.payload),
        id: row.id,
        workspaceId: row.workspace_id,
      }));
    });
  }

  async createSchedulerJob(scope, input = {}) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('job'));
      const name = String(input.name || 'Automation');
      const agent = String(input.agent || '');
      const model = String(input.model || '');
      const enabled = input.enabled !== false;
      const intervalMinutes = Number(input.intervalMinutes || input.interval_minutes || 60) || 60;
      const payload = {
        ...asObject(input.payload),
        ...asObject(input),
        id,
        name,
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `insert into scheduler_jobs (
           id, name, agent, model, enabled, interval_minutes, payload, workspace_id
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [id, name, agent, model, enabled, intervalMinutes, JSON.stringify(payload), valid.workspaceId],
      );
      return {
        id, name, agent, model, enabled, intervalMinutes, workspaceId: valid.workspaceId, ...payload,
      };
    });
  }

  async updateSchedulerJob(scope, jobId, patch = {}) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const existing = await client.query(
        `select * from scheduler_jobs where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(jobId || '')],
      );
      if (!existing.rowCount) return null;
      const row = existing.rows[0];
      const name = patch.name !== undefined ? String(patch.name) : row.name;
      const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : row.enabled;
      const intervalMinutes = patch.intervalMinutes !== undefined || patch.interval_minutes !== undefined
        ? Number(patch.intervalMinutes || patch.interval_minutes || 60) || 60
        : row.interval_minutes;
      const payload = {
        ...asObject(row.payload),
        ...asObject(patch),
        id: row.id,
        name,
        enabled,
        intervalMinutes,
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `update scheduler_jobs
         set name = $3, enabled = $4, interval_minutes = $5, payload = $6::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, row.id, name, enabled, intervalMinutes, JSON.stringify(payload)],
      );
      return { id: row.id, name, enabled, intervalMinutes, workspaceId: valid.workspaceId, ...payload };
    });
  }

  async deleteSchedulerJob(scope, jobId) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `delete from scheduler_jobs where workspace_id = $1 and id = $2 returning id`,
        [valid.workspaceId, String(jobId || '')],
      );
      return result.rowCount > 0;
    });
  }

  async markSchedulerRunDeferred(scope, jobId) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const existing = await client.query(
        `select id, payload from scheduler_jobs where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(jobId || '')],
      );
      if (!existing.rowCount) return null;
      const payload = {
        ...asObject(existing.rows[0].payload),
        lastRunStatus: 'blocked_runner_required',
        lastRunAt: new Date().toISOString(),
      };
      await client.query(
        `update scheduler_jobs set payload = $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, existing.rows[0].id, JSON.stringify(payload)],
      );
      return {
        ok: true,
        id: existing.rows[0].id,
        status: 'blocked_runner_required',
        error: 'runner_required',
        message: 'Scheduler execution requires a Workspace-bound Runner',
        workspaceId: valid.workspaceId,
      };
    });
  }

  // ── Settings / UI preferences (state_meta) ─────────────────────────

  async getSettings(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select key, payload from state_meta where workspace_id = $1`,
        [valid.workspaceId],
      );
      const settings = { workspaceId: valid.workspaceId, uiPreferences: {} };
      for (const row of result.rows) {
        if (row.key === 'ui_preferences') {
          settings.uiPreferences = scrubSettingsValue(asObject(row.payload));
        } else if (row.key === 'workspace_settings') {
          const workspaceSettings = scrubSettingsValue(asObject(row.payload));
          if (Object.hasOwn(workspaceSettings, 'inferencePolicy')) {
            workspaceSettings.inferencePolicy = normalizeInferencePolicy(
              workspaceSettings.inferencePolicy,
            );
          }
          Object.assign(settings, workspaceSettings);
        }
      }
      return settings;
    });
  }

  async saveSettings(scope, input = {}) {
    await this.#run(scope, async (client, valid) => {
      const scrubbed = scrubSettingsValue(asObject(input));
      if (Object.hasOwn(scrubbed, 'inferencePolicy')) {
        scrubbed.inferencePolicy = normalizeInferencePolicy(scrubbed.inferencePolicy);
      }
      const uiPreferences = asObject(scrubbed.uiPreferences || scrubbed.ui_preferences);
      if (Object.keys(uiPreferences).length) {
        await client.query(
          `insert into state_meta (workspace_id, key, payload)
           values ($1, 'ui_preferences', $2::jsonb)
           on conflict (workspace_id, key)
           do update set payload = coalesce(state_meta.payload, '{}'::jsonb) || excluded.payload,
                         updated_at = now()`,
          [valid.workspaceId, JSON.stringify(uiPreferences)],
        );
      }
      const workspaceSettings = { ...scrubbed };
      delete workspaceSettings.uiPreferences;
      delete workspaceSettings.ui_preferences;
      await client.query(
        `insert into state_meta (workspace_id, key, payload)
         values ($1, 'workspace_settings', $2::jsonb)
         on conflict (workspace_id, key)
         do update set payload = coalesce(state_meta.payload, '{}'::jsonb) || excluded.payload,
                       updated_at = now()`,
        [valid.workspaceId, JSON.stringify(workspaceSettings)],
      );
    });
    return this.getSettings(scope);
  }

  // ── Chat ───────────────────────────────────────────────────────────

  async listChatMessages(scope, { target, limit = 80 } = {}) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, role, text, run_id, payload, workspace_id, created_at
         from chat_messages
         where workspace_id = $1
         order by created_at desc
         limit $2`,
        [valid.workspaceId, Math.max(1, Math.min(Number(limit) || 80, 200))],
      );
      let messages = result.rows.map((row) => ({
        id: row.id,
        role: row.role,
        text: row.text,
        runId: row.run_id,
        workspaceId: row.workspace_id,
        createdAt: row.created_at,
        ...asObject(row.payload),
        id: row.id,
        workspaceId: row.workspace_id,
      }));
      if (target) {
        messages = messages.filter((m) => String(m.target || '') === String(target));
      }
      return messages.reverse();
    });
  }

  async createChatMessage(scope, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('chat'));
      const role = String(input.role || 'user');
      const text = String(input.text || input.message || '');
      const payload = {
        ...asObject(input.payload),
        target: input.target || '',
        view: input.view || '',
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `insert into chat_messages (id, role, text, run_id, payload, workspace_id)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, role, text, String(input.runId || input.run_id || ''), JSON.stringify(payload), valid.workspaceId],
      );
      return { id, role, text, workspaceId: valid.workspaceId, ...payload };
    });
  }

  // ── Runs ───────────────────────────────────────────────────────────

  async listRuns(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, goal, agent, model, status, wiki_path, payload, workspace_id
         from runs where workspace_id = $1 order by updated_at desc limit 100`,
        [valid.workspaceId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        goal: row.goal,
        agent: row.agent,
        model: row.model,
        status: row.status,
        wikiPath: row.wiki_path,
        workspaceId: row.workspace_id,
        ...asObject(row.payload),
        id: row.id,
        workspaceId: row.workspace_id,
      }));
    });
  }

  async getRunById(scope, runId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, goal, agent, model, status, wiki_path, payload, workspace_id
         from runs where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(runId || '')],
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        goal: row.goal,
        agent: row.agent,
        model: row.model,
        status: row.status,
        wikiPath: row.wiki_path,
        workspaceId: row.workspace_id,
        ...asObject(row.payload),
        id: row.id,
        workspaceId: row.workspace_id,
      };
    });
  }

  async createRunDeferred(scope, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('run'));
      const goal = String(input.goal || input.title || '');
      const status = 'blocked_runner_required';
      const payload = {
        ...asObject(input),
        status,
        error: 'runner_required',
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `insert into runs (id, goal, agent, model, status, wiki_path, payload, workspace_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          id, goal, String(input.agent || ''), String(input.model || ''),
          status, String(input.wikiPath || ''), JSON.stringify(payload), valid.workspaceId,
        ],
      );
      return {
        ok: true,
        run: { id, goal, status, workspaceId: valid.workspaceId, ...payload },
        status,
        error: 'runner_required',
      };
    });
  }

  async approveRun(scope, runId) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const existing = await client.query(
        `select id, payload, status from runs where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(runId || '')],
      );
      if (!existing.rowCount) return null;
      const payload = {
        ...asObject(existing.rows[0].payload),
        status: 'approved',
        approvedAt: new Date().toISOString(),
      };
      await client.query(
        `update runs set status = 'approved', payload = $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, existing.rows[0].id, JSON.stringify(payload)],
      );
      return { id: existing.rows[0].id, status: 'approved', workspaceId: valid.workspaceId, ...payload };
    });
  }

  // ── Agent work / missions ──────────────────────────────────────────

  async listAgentSessionEvents(scope, sessionId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, session_id, sequence, kind, payload, workspace_id
         from agent_session_events
         where workspace_id = $1 and session_id = $2
         order by sequence asc`,
        [valid.workspaceId, String(sessionId || '')],
      );
      return result.rows;
    });
  }

  async getAgentOperationsSnapshot(scope) {
    return this.#run(scope, async (client, valid) => {
      const missions = await client.query(
        `select id, status, agent_id, report_due_at, payload, workspace_id
         from agent_missions
         where workspace_id = $1
           and coalesce(payload->>'hiddenFromAgentWork', 'false') <> 'true'
         order by updated_at desc`,
        [valid.workspaceId],
      );
      const sessions = await client.query(
        `select id, mission_id, task_id, status, payload, workspace_id
         from agent_sessions
         where workspace_id = $1
           and coalesce(payload->>'hiddenFromAgentWork', 'false') <> 'true'
         order by updated_at desc`,
        [valid.workspaceId],
      );
      const events = await client.query(
        `select id, session_id, sequence, kind, payload, workspace_id
         from agent_session_events
         where workspace_id = $1
           and session_id not in (
             select id from agent_sessions
             where workspace_id = $1
               and coalesce(payload->>'hiddenFromAgentWork', 'false') = 'true'
           )
         order by sequence desc limit 200`,
        [valid.workspaceId],
      );
      const reports = await client.query(
        `select id, payload, workspace_id from agent_reports
         where workspace_id = $1
           and coalesce(payload->>'hiddenFromAgentWork', 'false') <> 'true'
         order by updated_at desc limit 50`,
        [valid.workspaceId],
      ).catch(() => ({ rows: [] }));
      const agents = await client.query(
        `select id, payload, workspace_id from agents where workspace_id = $1`,
        [valid.workspaceId],
      );
      const runners = await client.query(
        `select id, status, connection_state, capabilities, last_seen_at, last_test_ok, fingerprint_sha256
         from runners
         where workspace_id = $1
         order by updated_at desc nulls last, created_at desc
         limit 20`,
        [valid.workspaceId],
      ).catch(() => ({ rows: [] }));
      const activeConnected = runners.rows.find(
        (r) => r.status === 'active' && r.connection_state === 'connected',
      );
      const activeAny = runners.rows.find((r) => r.status === 'active');
      const runnerConnected = Boolean(activeConnected);
      const runnerStatus = runnerConnected
        ? 'connected'
        : activeAny
          ? (activeAny.connection_state || 'disconnected')
          : 'runner_required';

      return {
        ok: true,
        workspaceId: valid.workspaceId,
        missions: missions.rows.map((r) => {
          const p = asObject(r.payload);
          const goal = String(p.goal || p.objective || p.title || '');
          return {
            id: r.id,
            status: r.status,
            agentId: r.agent_id || p.agentId || 'default',
            ...p,
            title: String(p.title || goal || r.id),
            objective: String(p.objective || goal),
            goal,
            templateId: p.templateId || 'general-agent-work',
            missionThreadId: p.missionThreadId || p.workConversationId || '',
            workspaceId: r.workspace_id,
          };
        }),
        sessions: sessions.rows.map((r) => ({ id: r.id, missionId: r.mission_id, status: r.status, ...asObject(r.payload), workspaceId: r.workspace_id })),
        events: events.rows,
        reports: reports.rows.map((r) => ({ id: r.id, ...asObject(r.payload), workspaceId: r.workspace_id })),
        agents: agents.rows.map((r) => ({ id: r.id, ...asObject(r.payload), workspaceId: r.workspace_id })),
        tasks: [],
        // Phase 3: derive Runner connectivity from Workspace-owned runners table.
        daemon: {
          running: runnerConnected,
          mode: runnerConnected ? 'workspace_runner' : 'runner_required',
          lastRun: null,
          lastError: null,
        },
        runner: {
          connected: runnerConnected,
          status: runnerStatus,
          message: runnerConnected
            ? 'Workspace Runner connected'
            : activeAny
              ? 'Workspace Runner enrolled but not connected'
              : 'Workspace Runner is not connected',
          runnerId: (activeConnected || activeAny || {}).id || null,
          lastTestOk: (activeConnected || activeAny || {}).last_test_ok ?? null,
        },
      };
    });
  }

  async createDeferredAgentWork(scope, input = {}) {
    // Phase 3: durable accepted work (waiting_runner or accepted), not blocked_runner_required.
    const { DurableExecution } = require('./durable-execution');
    const execution = new DurableExecution({ pool: this.pool });
    return execution.acceptWork(scope, input);
  }

  async requestCancelAgentWork(scope, missionId) {
    const { DurableExecution } = require('./durable-execution');
    const execution = new DurableExecution({ pool: this.pool });
    return execution.requestCancel(scope, missionId);
  }

  async getAgentWorkConversation(scope, missionId, { cursor, limit = 50 } = {}) {
    return this.#run(scope, async (client, valid) => {
      const mission = await client.query(
        `select id, status, agent_id, payload, created_at, updated_at from agent_missions
         where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(missionId || '')],
      );
      if (!mission.rowCount) return null;
      const m = mission.rows[0];
      const payload = asObject(m.payload);
      const session = await client.query(
        `select id, status, created_at, updated_at from agent_sessions
         where workspace_id = $1 and mission_id = $2
         order by created_at asc limit 1`,
        [valid.workspaceId, m.id],
      );
      const sessionId = session.rowCount ? session.rows[0].id : '';
      let events = [];
      if (sessionId) {
        const result = await client.query(
          `select id, session_id, sequence, kind, payload, workspace_id, created_at
           from agent_session_events
           where workspace_id = $1 and session_id = $2
           order by sequence asc
           limit $3`,
          [valid.workspaceId, sessionId, Math.max(1, Number(limit) || 200)],
        );
        events = result.rows;
      }
      if (cursor) {
        const cursorNum = Number(cursor) || 0;
        events = events.filter((e) => Number(e.sequence) > cursorNum);
      }

      const title = String(payload.title || payload.goal || m.id);
      const goal = String(payload.goal || title);
      const engine = String(payload.executionEngine || 'auto');
      const deliverable = payload.deliverable && typeof payload.deliverable === 'object'
        ? payload.deliverable
        : { kind: 'file', format: 'auto' };
      const createdAt = (m.created_at && new Date(m.created_at).toISOString()) || new Date().toISOString();
      const updatedAt = (m.updated_at && new Date(m.updated_at).toISOString()) || createdAt;
      const workStatus = ['completed', 'failed', 'cancelled', 'paused'].includes(m.status)
        ? m.status
        : 'active';

      // Prefer mission payload, then durable job.resolved_engine, then checkpoint engine metadata.
      let resolvedExecutionEngine = String(
        payload.resolvedExecutionEngine || payload.resolvedEngine || '',
      ).toLowerCase();
      if (!['hermes', 'codex', 'claude', 'grok', 'fake'].includes(resolvedExecutionEngine)) {
        const job = await client.query(
          `select resolved_engine from execution_jobs
           where workspace_id = $1 and mission_id = $2
           order by updated_at desc nulls last limit 1`,
          [valid.workspaceId, m.id],
        );
        resolvedExecutionEngine = job.rowCount
          ? String(job.rows[0].resolved_engine || '').toLowerCase()
          : '';
      }
      if (!['hermes', 'codex', 'claude', 'grok', 'fake'].includes(resolvedExecutionEngine)) {
        for (const e of events) {
          const p = asObject(e.payload);
          const candidate = String(p.engine || p.resolvedEngine || p.resolvedExecutionEngine || '').toLowerCase();
          if (['hermes', 'codex', 'claude', 'grok', 'fake'].includes(candidate)) {
            resolvedExecutionEngine = candidate;
            break;
          }
        }
      }
      if (!['hermes', 'codex', 'claude', 'grok', 'fake'].includes(resolvedExecutionEngine)) {
        resolvedExecutionEngine = '';
      }

      const work = {
        id: m.id,
        templateId: 'general-agent-work',
        title,
        objective: goal,
        status: workStatus,
        agentId: m.agent_id || 'default',
        assignmentReason: 'default:official',
        executionEngine: engine === 'automatic' ? 'auto' : engine,
        ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
        deliverable,
        missionThreadId: sessionId,
        workConversationId: sessionId,
        revisionCounter: 0,
        createdAt,
        updatedAt,
      };
      const conversation = {
        id: sessionId,
        missionId: m.id,
        type: 'mission-thread',
        title,
        status: workStatus === 'completed' ? 'draft' : 'planning',
        pendingInstructions: [],
        executionEngine: work.executionEngine,
        deliverable,
        createdAt,
        updatedAt,
      };

      const checkpoints = events.map((e) => {
        const p = asObject(e.payload);
        const kind = mapEventKind(e.kind, p.phase || p.kind);
        return {
          id: e.id,
          sessionId,
          sequence: Number(e.sequence),
          kind,
          text: String(p.text || ''),
          createdAt: p.createdAt || (e.created_at && new Date(e.created_at).toISOString()) || createdAt,
          metadata: p.metadata && typeof p.metadata === 'object'
            ? p.metadata
            : { applicationMode: 'next_checkpoint', phase: p.phase || kind },
        };
      });

      return {
        ok: true,
        work,
        conversation,
        checkpoints,
        nextCursor: null,
        missionId: m.id,
        sessionId,
        status: m.status,
        workspaceId: valid.workspaceId,
        messages: checkpoints,
      };
    });
  }

  async addAgentWorkMessage(scope, missionId, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const mission = await client.query(
        `select id, agent_id, payload
         from agent_missions
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, String(missionId || '')],
      );
      if (!mission.rowCount) return null;
      const session = await client.query(
        `select id from agent_sessions
         where workspace_id = $1 and mission_id = $2
         order by created_at asc limit 1`,
        [valid.workspaceId, mission.rows[0].id],
      );
      if (!session.rowCount) return null;
      const sessionId = session.rows[0].id;
      const clientMessageId = String(input.clientMessageId || '').slice(0, 160);
      if (clientMessageId) {
        const replay = await client.query(
          `select id, sequence, kind, payload
           from agent_session_events
           where workspace_id = $1 and session_id = $2
             and payload->>'clientMessageId' = $3
           limit 1`,
          [valid.workspaceId, sessionId, clientMessageId],
        );
        if (replay.rowCount) {
          const eventPayload = asObject(replay.rows[0].payload);
          return {
            ok: true,
            missionId: mission.rows[0].id,
            sessionId,
            event: {
              id: replay.rows[0].id,
              sequence: Number(replay.rows[0].sequence),
              kind: replay.rows[0].kind,
              ...eventPayload,
            },
            idempotentReplay: true,
            workspaceId: valid.workspaceId,
          };
        }
      }
      const providerResult = await client.query(
        `select ps.*, r.connection_state, r.status as runner_status, r.capabilities
         from provider_agent_sessions ps
         inner join runners r
           on r.workspace_id = ps.workspace_id and r.id = ps.runner_id
         where ps.workspace_id = $1 and ps.work_conversation_id = $2
         limit 1`,
        [valid.workspaceId, sessionId],
      );
      if (providerResult.rowCount && [
        'auth_required',
        'missing',
        'deleted',
        'quota_exhausted',
        'archived',
      ].includes(providerResult.rows[0].status)) {
        const error = new Error(`Provider session is ${providerResult.rows[0].status}`);
        error.code = `provider_session_${providerResult.rows[0].status}`;
        error.statusHint = 409;
        throw error;
      }
      const seqResult = await client.query(
        `select coalesce(max(sequence), 0)::int as n
         from agent_session_events
         where workspace_id = $1 and session_id = $2`,
        [valid.workspaceId, sessionId],
      );
      const sequence = (Number(seqResult.rows[0].n) || 0) + 1;
      const eventId = newId('evt');
      const payload = {
        text: String(input.text || input.message || ''),
        clientMessageId: clientMessageId || null,
        role: 'user',
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id)
         values ($1, $2, $3, 'user_message', $4::jsonb, $5)`,
        [eventId, sessionId, sequence, JSON.stringify(payload), valid.workspaceId],
      );
      let job = null;
      if (providerResult.rowCount && payload.text) {
        const providerSession = providerResult.rows[0];
        const {
          projectAgentWorkCalendarState,
          resolveEngine,
        } = require('./durable-execution');
        const resolved = providerSession.connection_state === 'connected'
          && providerSession.runner_status === 'active'
          ? resolveEngine(providerSession.engine, providerSession.capabilities || {})
          : { requested: providerSession.engine, resolved: '', reason: 'waiting_runner' };
        const jobStatus = resolved.resolved ? 'accepted' : 'waiting_runner';
        const turnResult = await client.query(
          `select coalesce(max(turn_index), 0)::int as n
           from execution_jobs
           where workspace_id = $1 and mission_id = $2`,
          [valid.workspaceId, mission.rows[0].id],
        );
        const turnIndex = (Number(turnResult.rows[0].n) || 0) + 1;
        const jobId = newId('job');
        const projectionKey = `proj:${mission.rows[0].id}:turn:${turnIndex}`;
        await client.query(
          `insert into execution_jobs (
             id, workspace_id, mission_id, session_id, requested_engine,
             resolved_engine, engine_reason, preferred_runner_id, status,
             goal, payload, available_at, max_attempts, projection_key,
             turn_index, provider_session_id
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),5,$12,$13,$14
           )`,
          [
            jobId,
            valid.workspaceId,
            mission.rows[0].id,
            sessionId,
            providerSession.engine,
            resolved.resolved || '',
            resolved.reason,
            providerSession.runner_id,
            jobStatus,
            payload.text.slice(0, 4000),
            JSON.stringify({
              agentId: mission.rows[0].agent_id || 'default',
              clientMessageId,
              turnIndex,
              providerSessionId: providerSession.id,
            }),
            projectionKey,
            turnIndex,
            providerSession.id,
          ],
        );
        await projectAgentWorkCalendarState(client, {
          workspaceId: valid.workspaceId,
          projectionKey,
          jobId,
          missionId: mission.rows[0].id,
          sessionId,
          goal: payload.text.slice(0, 4000),
          lifecycleStatus: 'scheduled',
          occurredAt: new Date().toISOString(),
          turnIndex,
          providerSessionId: providerSession.id,
        });
        await client.query(
          `update agent_missions
           set status = $3, payload = payload || $4::jsonb, updated_at = now()
           where workspace_id = $1 and id = $2`,
          [
            valid.workspaceId,
            mission.rows[0].id,
            jobStatus,
            JSON.stringify({
              status: jobStatus,
              updatedAt: new Date().toISOString(),
              providerSessionId: providerSession.id,
            }),
          ],
        );
        await client.query(
          `update agent_sessions
           set status = $3, payload = payload || $4::jsonb, updated_at = now()
           where workspace_id = $1 and id = $2`,
          [
            valid.workspaceId,
            sessionId,
            jobStatus,
            JSON.stringify({ status: jobStatus }),
          ],
        );
        job = {
          id: jobId,
          status: jobStatus,
          turnIndex,
          providerSessionId: providerSession.id,
        };
      }
      return {
        ok: true,
        missionId: mission.rows[0].id,
        sessionId,
        event: { id: eventId, sequence, kind: 'user_message', ...payload },
        ...(job ? { job } : {}),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async getAgentSession(scope, sessionId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, mission_id, task_id, status, payload, workspace_id
         from agent_sessions where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(sessionId || '')],
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        missionId: row.mission_id,
        taskId: row.task_id,
        status: row.status,
        workspaceId: row.workspace_id,
        ...asObject(row.payload),
      };
    });
  }

  async transitionMission(scope, missionId, action) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const status = action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : action;
      const existing = await client.query(
        `select id, payload from agent_missions where workspace_id = $1 and id = $2 limit 1`,
        [valid.workspaceId, String(missionId || '')],
      );
      if (!existing.rowCount) return null;
      const payload = {
        ...asObject(existing.rows[0].payload),
        status,
        lastAction: action,
      };
      await client.query(
        `update agent_missions set status = $3, payload = $4::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, existing.rows[0].id, status, JSON.stringify(payload)],
      );
      return { id: existing.rows[0].id, status, workspaceId: valid.workspaceId };
    });
  }

  // ── Aggregate state for Desktop hydrate ────────────────────────────

  async getAggregateState(scope) {
    const [tasks, events, agents, runs, documents, jobs, chat, settings, agentOps] = await Promise.all([
      this.listTasks(scope),
      this.listCalendarEvents(scope),
      this.listAgents(scope),
      this.listRuns(scope),
      this.listDocuments(scope),
      this.listSchedulerJobs(scope),
      this.listChatMessages(scope),
      this.getSettings(scope),
      this.getAgentOperationsSnapshot(scope),
    ]);
    return {
      ok: true,
      workspaceId: scope.workspaceId,
      tasks,
      events,
      calendarEvents: events,
      agents,
      runs,
      documents,
      jobs,
      schedulerJobs: jobs,
      chatMessages: chat,
      messages: chat,
      sessions: agentOps.sessions || [],
      settings,
      profileReadiness: { ok: true, mode: 'workspace_scoped' },
      agentSourceStatus: { mode: 'workspace_scoped' },
    };
  }

  async listWorkboard(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id, payload, workspace_id from workboard_pages
         where workspace_id = $1 order by updated_at desc limit 50`,
        [valid.workspaceId],
      ).catch(() => ({ rows: [] }));
      return result.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        ...asObject(row.payload),
      }));
    });
  }
}

module.exports = {
  WorkspaceScopedProductService,
  requireOwner,
};
