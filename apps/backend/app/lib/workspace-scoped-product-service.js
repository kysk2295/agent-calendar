'use strict';

const crypto = require('node:crypto');
const { assertActiveMembership, assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { normalizeInferencePolicy } = require('./workspace-inference-broker');
const {
  agentExecutionProfile,
  applyAgentExecutionProfile,
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  resolveEffectiveAgentConfiguration,
  WorkspaceAgentDirectoryError,
} = require('./workspace-agent-directory');
const { isOfficialProfileName } = require('./official-profiles');
const { projectPublicDisplayEvent } = require('./public-work-conversation-event');

const TELEGRAM_INGRESS_FRESHNESS_MS = 150_000;
const MAX_HANDOFF_DEPTH = 3;
const MAX_HANDOFF_FAN_OUT = 3;
const CAPABILITY_ID = /^(tool|skill):[a-z0-9][a-z0-9._/-]{0,118}$/;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function scopedMutationError(code, message, statusHint = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function publicMutationId(value, field) {
  const id = String(value || '').trim();
  if (!id || id.length > 200 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    throw scopedMutationError(`${field}_invalid`, `${field} is invalid`, 400);
  }
  return id;
}

function normalizedGrantSet(value = {}) {
  const source = asObject(value);
  const normalize = (items) => [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => CAPABILITY_ID.test(item)),
  )].sort();
  const deny = normalize(source.deny);
  return {
    allow: normalize(source.allow).filter((item) => !deny.includes(item)),
    deny,
  };
}

function intersectedGrants(parentValue, receiverValue, requestedValue) {
  const parent = normalizedGrantSet(parentValue);
  const receiver = normalizedGrantSet(receiverValue);
  const requested = requestedValue === undefined
    ? parent
    : normalizedGrantSet(requestedValue);
  const deny = [...new Set([
    ...parent.deny,
    ...receiver.deny,
    ...requested.deny,
  ])].sort();
  const receiverAllowed = new Set(receiver.allow);
  const requestedAllowed = new Set(requested.allow);
  return {
    allow: parent.allow
      .filter((item) => receiverAllowed.has(item) && requestedAllowed.has(item))
      .filter((item) => !deny.includes(item))
      .sort(),
    deny,
  };
}

function normalizedHandoffBudget(value = {}, fallback = {
  maxRuns: 3,
  maxMinutes: 60,
  maxCostUsd: 5,
}) {
  const source = asObject(value);
  const bounded = (key, maximum) => {
    const candidate = Number(source[key]);
    const inherited = Number(fallback[key]);
    const safeFallback = Number.isFinite(inherited) && inherited > 0
      ? inherited
      : maximum;
    return Number.isFinite(candidate) && candidate > 0
      ? Math.min(candidate, safeFallback, maximum)
      : Math.min(safeFallback, maximum);
  };
  return {
    maxRuns: Math.floor(bounded('maxRuns', 20)),
    maxMinutes: Math.floor(bounded('maxMinutes', 1_440)),
    maxCostUsd: Number(bounded('maxCostUsd', 1_000).toFixed(4)),
  };
}

function publicHandoff(row) {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    parentMissionId: row.root_mission_id,
    parentHandoffId: row.parent_handoff_id || '',
    parentTaskId: row.parent_task_id || '',
    rootAgentId: row.root_agent_id,
    delegatorAgentId: row.delegator_agent_id,
    receiverAgentId: row.receiver_agent_id,
    depth: Number(row.depth),
    lineage: Array.isArray(row.lineage) ? row.lineage.map(String) : [],
    effectiveGrants: normalizedGrantSet(row.effective_grants),
    effectiveBudget: normalizedHandoffBudget(row.effective_budget),
    status: row.status,
    resultProjection: asObject(row.result_projection),
    cancellationRequested: row.cancellation_requested === true,
    cancellationReason: row.cancellation_reason || '',
    executionJobId: row.execution_job_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    terminalAt: row.terminal_at ? new Date(row.terminal_at).toISOString() : null,
  };
}

function publicTransitionSession(row) {
  const lineage = Array.isArray(row.session_lineage) && row.session_lineage.length
    ? row.session_lineage.map(String)
    : [row.id];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id || '',
    runnerId: row.runner_id,
    workConversationId: row.work_conversation_id,
    provider: row.provider,
    engine: row.engine,
    externalSessionId: row.external_session_id || '',
    status: row.status,
    title: row.title || '',
    parentProviderSessionId: row.parent_provider_session_id || '',
    generation: Number(row.session_generation || 0),
    lineage,
    transitionAction: row.transition_action || 'existing',
  };
}

function channelIngressProjection(value, now = Date.now()) {
  const metadata = asObject(value);
  const reportedOwnership = ['owned', 'conflict'].includes(metadata.ingressOwnership)
    ? metadata.ingressOwnership
    : 'unverified';
  const checkedAt = new Date(String(metadata.ingressCheckedAt || ''));
  const hasValidObservation = reportedOwnership !== 'unverified' && Number.isFinite(checkedAt.getTime());
  const ingressOwnership = hasValidObservation ? reportedOwnership : 'unverified';
  const ingressCheckedAt = hasValidObservation
    ? checkedAt.toISOString()
    : null;
  let ingressReadiness = 'unverified';
  if (ingressCheckedAt && Math.max(0, now - checkedAt.getTime()) > TELEGRAM_INGRESS_FRESHNESS_MS) {
    ingressReadiness = 'stale';
  } else if (ingressCheckedAt && ingressOwnership === 'owned') {
    ingressReadiness = 'ready';
  } else if (ingressCheckedAt && ingressOwnership === 'conflict') {
    ingressReadiness = 'conflict';
  }
  return {
    ingressOwnership,
    ingressReadiness,
    ingressCheckedAt,
  };
}

function explicitProviderEngine(value) {
  const engine = String(value || '').trim().toLowerCase();
  if (!engine || engine === 'auto' || engine === 'automatic') return '';
  if (['codex', 'claude', 'grok', 'hermes'].includes(engine)) return engine;
  const error = new Error('Execution Engine is not supported for this Work Conversation');
  error.code = 'provider_engine_invalid';
  error.statusHint = 422;
  throw error;
}

function publicExecutionModel(value) {
  const model = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
    && !/^(sk-|bearer|token|cookie|secret)/i.test(model)
    ? model
    : '';
}

function requestedExecutionModel(value) {
  const model = String(value || '').trim();
  if (!model) return '';
  const normalized = publicExecutionModel(model);
  if (normalized) return normalized;
  const error = new Error('Execution model identifier is invalid');
  error.code = 'execution_model_invalid';
  error.statusHint = 422;
  throw error;
}

function requestedComparisonTargets(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    const error = new Error('Comparison requires between two and four explicit Execution Engines');
    error.code = 'comparison_targets_invalid';
    error.statusHint = 422;
    throw error;
  }
  const targets = value.map((entry) => {
    const target = asObject(entry);
    const executionEngine = explicitProviderEngine(target.executionEngine);
    if (!executionEngine) {
      const error = new Error('Comparison target requires an explicit Execution Engine');
      error.code = 'comparison_target_engine_required';
      error.statusHint = 422;
      throw error;
    }
    return {
      executionEngine,
      requestedModel: requestedExecutionModel(target.requestedModel),
    };
  });
  if (new Set(targets.map((target) => target.executionEngine)).size !== targets.length) {
    const error = new Error('Comparison target Execution Engines must be unique');
    error.code = 'comparison_target_duplicate';
    error.statusHint = 422;
    throw error;
  }
  return targets;
}

function providerSessionOwner(agentId, agentRow) {
  const id = String(agentId || '').trim();
  if (agentRow) return { agentId: id, officialProfile: '' };
  if (isOfficialProfileName(id)) return { agentId: null, officialProfile: id };
  const error = new Error('Provider session owner is unavailable in this Workspace');
  error.code = 'provider_session_owner_unavailable';
  error.statusHint = 409;
  throw error;
}

function assertRunnerSupportsModel(capabilities, engine, model) {
  if (!model) return;
  const engineCapability = asObject(asObject(capabilities).engines)[engine];
  const publicCapability = asObject(engineCapability);
  const models = Array.isArray(publicCapability.models)
    ? publicCapability.models.map(publicExecutionModel).filter(Boolean)
    : [];
  if (models.length && !models.includes(model)) {
    const error = new Error(`Execution model ${model} is unavailable on this Workspace Runner`);
    error.code = 'execution_model_unavailable';
    error.statusHint = 409;
    throw error;
  }
}

function providerSessionStateError(status) {
  const normalized = String(status || 'unavailable');
  const error = new Error(`Provider session is ${normalized}`);
  error.code = `provider_session_${normalized}`;
  error.statusHint = 409;
  return error;
}

function activeProviderEndpointConflict() {
  const error = new Error('Active provider endpoint is unavailable for this Work Conversation');
  error.code = 'active_provider_endpoint_conflict';
  error.statusHint = 409;
  return error;
}

function providerEndpointEligible(providerSession) {
  return providerSession && ![
    'auth_required',
    'missing',
    'deleted',
    'quota_exhausted',
    'unavailable',
    'archived',
  ].includes(String(providerSession.status || ''));
}

function canonicalContextGoal({ objective, events, message }) {
  const transcript = events
    .map((event) => {
      const payload = asObject(event.payload);
      const text = String(payload.text || '').trim();
      if (!text) return '';
      return `${event.kind === 'agent_message' ? 'Assistant' : 'User'}: ${text}`;
    })
    .filter(Boolean)
    .join('\n')
    .slice(-8_000);
  return [
    'Continue the same Agent Calendar Work Conversation using this canonical context.',
    `Work objective: ${String(objective || '').trim().slice(0, 2_000)}`,
    transcript ? `Transcript:\n${transcript}` : '',
    `Current user message: ${String(message || '').trim().slice(0, 4_000)}`,
  ].filter(Boolean).join('\n\n').slice(0, 12_000);
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
  constructor({ pool, useAppRole = true, env = {} } = {}) {
    if (!pool) throw new Error('WorkspaceScopedProductService requires pool');
    this.pool = pool;
    this.useAppRole = useAppRole;
    this.env = env;
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
      const [result, runners] = await Promise.all([
        client.query(
          `select id, payload, workspace_id from agents where workspace_id = $1 order by id asc`,
          [valid.workspaceId],
        ),
        client.query(
          `select id, capabilities, status, connection_state
           from runners
           where workspace_id = $1 and status = 'active'
           order by last_seen_at desc nulls last, id asc`,
          [valid.workspaceId],
        ),
      ]);
      return result.rows.map((row) => {
        const agent = projectWorkspaceAgent({
          id: row.id,
          ...asObject(row.payload),
          workspaceId: row.workspace_id,
        });
        const runner = runners.rows.find((entry) => entry.id === agent.defaultRunnerId)
          || runners.rows.find((entry) => entry.connection_state === 'connected')
          || runners.rows[0]
          || { id: '', capabilities: {} };
        return {
          ...agent,
          effectiveConfigurationPreview: resolveEffectiveAgentConfiguration({
            workspaceId: valid.workspaceId,
            agent,
            runner,
            requestedEngine: agent.defaultExecutionEngine,
            reason: runner.id ? 'agent_default' : 'waiting_runner',
          }),
        };
      });
    });
  }

  async createAgent(scope, input = {}) {
    requireOwner(scope);
    return this.#run(scope, async (client, valid) => {
      const id = String(input.id || newId('agent'));
      const { approvedGrants: _ignoredApprovedGrants, ...publicInput } = asObject(input);
      const payload = normalizeWorkspaceAgent(publicInput, {
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
      const existingPayload = asObject(existing.rows[0].payload);
      const {
        approvedGrants: _ignoredApprovedGrants,
        approveGrantRequestId,
        ...publicPatch
      } = asObject(patch);
      const approvalGate = asObject(existingPayload.approvalGate);
      const approvedPatch = approveGrantRequestId
        ? (
          String(approveGrantRequestId) === String(approvalGate.id || '')
          && approvalGate.status === 'pending'
            ? { ...publicPatch, approvedGrants: approvalGate.requestedGrants }
            : null
        )
        : publicPatch;
      if (!approvedPatch) {
        throw new WorkspaceAgentDirectoryError(
          'grant_approval_stale',
          'Grant Approval Gate is stale or unavailable',
          409,
        );
      }
      const payload = normalizeWorkspaceAgent(approvedPatch, {
        id: existing.rows[0].id,
        workspaceId: valid.workspaceId,
        existing: existingPayload,
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
    const execution = new DurableExecution({ pool: this.pool, env: this.env });
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
      const jobs = await client.query(
        `select id, requested_engine, requested_model, resolved_engine, resolved_model,
                engine_reason, preferred_runner_id, payload, turn_index, created_at, updated_at
         from execution_jobs
         where workspace_id = $1 and mission_id = $2
         order by turn_index desc, turn_target_index asc, updated_at desc nulls last`,
        [valid.workspaceId, m.id],
      );
      const latestJob = jobs.rows[0] || null;

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
      if (!['hermes', 'codex', 'claude', 'grok'].includes(resolvedExecutionEngine)) {
        resolvedExecutionEngine = latestJob
          ? String(latestJob.resolved_engine || '').toLowerCase()
          : '';
      }
      if (!['hermes', 'codex', 'claude', 'grok'].includes(resolvedExecutionEngine)) {
        for (const e of events) {
          const p = asObject(e.payload);
          const candidate = String(p.engine || p.resolvedEngine || p.resolvedExecutionEngine || '').toLowerCase();
          if (['hermes', 'codex', 'claude', 'grok'].includes(candidate)) {
            resolvedExecutionEngine = candidate;
            break;
          }
        }
      }
      if (!['hermes', 'codex', 'claude', 'grok'].includes(resolvedExecutionEngine)) {
        resolvedExecutionEngine = '';
      }
      const activeExecutionEngineCandidate = String(
        payload.activeExecutionEngine || resolvedExecutionEngine || '',
      ).toLowerCase();
      const activeExecutionEngine = ['hermes', 'codex', 'claude', 'grok'].includes(activeExecutionEngineCandidate)
        ? activeExecutionEngineCandidate
        : (engine === 'automatic' ? 'auto' : engine);
      const activeExecutionModel = publicExecutionModel(
        payload.activeExecutionModel || latestJob?.requested_model || '',
      );
      const resolvedExecutionModel = publicExecutionModel(
        payload.resolvedExecutionModel || latestJob?.resolved_model || '',
      );
      const currentAgentResult = await client.query(
          `select id, payload
           from agents
           where workspace_id = $1 and id = $2
           limit 1`,
          [valid.workspaceId, m.agent_id || 'default'],
        );
      const currentRunnerResult = await client.query(
          `select id, capabilities, status, connection_state
           from runners
           where workspace_id = $1 and status = 'active'
           order by
             case when id = $2 then 0 else 1 end,
             case when connection_state = 'connected' then 0 else 1 end,
             last_seen_at desc nulls last,
             id asc`,
          [valid.workspaceId, String(latestJob?.preferred_runner_id || '')],
        );
      const currentAgent = currentAgentResult.rowCount
        ? {
          id: currentAgentResult.rows[0].id,
          ...asObject(currentAgentResult.rows[0].payload),
          workspaceId: valid.workspaceId,
        }
        : {
          id: m.agent_id || 'default',
          displayName: 'Default agent',
          workspaceId: valid.workspaceId,
        };
      const currentRunner = currentRunnerResult.rows[0] || { id: '', capabilities: {} };
      const latestHistoricalConfiguration = asObject(asObject(latestJob?.payload).effectiveConfiguration);
      const currentEffectiveConfiguration = resolveEffectiveAgentConfiguration({
        workspaceId: valid.workspaceId,
        agent: currentAgent,
        runner: currentRunner,
        requestedEngine: latestJob?.requested_engine || engine,
        resolvedEngine: latestJob?.resolved_engine || resolvedExecutionEngine,
        requestedModel: latestJob?.requested_model || '',
        reason: latestJob?.engine_reason || 'current_preview',
        requiredCapabilities: latestHistoricalConfiguration.requiredCapabilities || [],
      });
      const effectiveConfigurationHistory = jobs.rows
        .map((job) => {
          const snapshot = asObject(asObject(job.payload).effectiveConfiguration);
          if (!snapshot.snapshotId) return null;
          return {
            jobRef: `job_${crypto.createHash('sha256').update(
              `${valid.workspaceId}:${job.id}`,
            ).digest('hex').slice(0, 16)}`,
            turnIndex: Number(job.turn_index || 1),
            createdAt: job.created_at
              ? new Date(job.created_at).toISOString()
              : createdAt,
            configuration: snapshot,
          };
        })
        .filter(Boolean);

      const work = {
        id: m.id,
        templateId: 'general-agent-work',
        title,
        objective: goal,
        status: workStatus,
        agentId: m.agent_id || 'default',
        assignmentReason: 'default:official',
        executionEngine: engine === 'automatic' ? 'auto' : engine,
        activeExecutionEngine,
        ...(resolvedExecutionEngine ? { resolvedExecutionEngine } : {}),
        activeExecutionModel,
        resolvedExecutionModel,
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
      const channelEndpoints = sessionId
        ? await client.query(
          `select id, channel, status, runner_id, public_metadata, last_activity_at
           from work_conversation_channel_endpoints
           where workspace_id = $1 and work_conversation_id = $2
           order by created_at asc, id asc`,
          [valid.workspaceId, sessionId],
        )
        : { rows: [] };
      const ingressProjectionTime = Date.now();
      const channels = channelEndpoints.rows.map((row) => {
        const ingress = channelIngressProjection(row.public_metadata, ingressProjectionTime);
        return {
          id: row.id,
          channel: row.channel,
          status: row.status,
          runnerId: row.runner_id,
          ...ingress,
          lastActivityAt: row.last_activity_at
            ? new Date(row.last_activity_at).toISOString()
            : null,
        };
      });

      const checkpoints = events
        .map((event) => projectPublicDisplayEvent(event, {
          sessionId,
          fallbackCreatedAt: createdAt,
        }))
        .filter(Boolean)
        .map((event) => ({
          id: event.id,
          sessionId: event.sessionId || sessionId,
          sequence: event.sequence,
          kind: event.kind,
          text: event.text,
          origin: event.origin,
          createdAt: event.createdAt,
          metadata: event.metadata || {
            applicationMode: 'next_checkpoint',
            phase: event.kind,
          },
        }));
      const handoffResult = await client.query(
          `select *
           from agent_work_handoffs
           where workspace_id = $1 and root_mission_id = $2
           order by depth asc, created_at asc, id asc`,
          [valid.workspaceId, m.id],
        );
      const providerSessionsResult = await client.query(
          `select *
           from provider_agent_sessions
           where workspace_id = $1 and work_conversation_id = $2
           order by session_generation asc, created_at asc, id asc`,
          [valid.workspaceId, sessionId],
        );
      const providerTransitionsResult = await client.query(
          `select *
           from provider_session_transitions
           where workspace_id = $1 and mission_id = $2
           order by created_at asc, id asc`,
          [valid.workspaceId, m.id],
        );
      const currentResult = await client.query(
          `select report_id, selection_version, selected_at
           from agent_work_current_results
           where workspace_id = $1 and mission_id = $2
           limit 1`,
          [valid.workspaceId, m.id],
        );
      const comparisonOutcomeResult = await client.query(
          `select
             r.id as report_id,
             r.payload as report_payload,
             j.id as job_id,
             j.requested_engine,
             j.requested_model,
             j.turn_index,
             j.turn_target_index,
             j.payload as job_payload,
             greatest(
               0,
               coalesce(
                 extract(epoch from (max(a.terminal_at) - min(a.started_at))) * 1000,
                 0
               )
             )::bigint as duration_ms,
             count(distinct art.id)::int as artifact_count
           from agent_reports r
           inner join execution_jobs j
             on j.workspace_id = r.workspace_id
            and j.mission_id = r.mission_id
            and j.id = r.payload->>'jobId'
            and j.turn_mode = 'comparison'
           left join execution_attempts a
             on a.workspace_id = j.workspace_id and a.job_id = j.id
           left join execution_artifacts art
             on art.workspace_id = j.workspace_id and art.job_id = j.id
           where r.workspace_id = $1 and r.mission_id = $2
           group by r.id, r.payload, j.id, j.requested_engine,
                    j.requested_model, j.turn_index, j.turn_target_index,
                    j.payload
           order by j.turn_index asc, j.turn_target_index asc, r.id asc`,
          [valid.workspaceId, m.id],
        );
      const adoptionResult = await client.query(
          `select *
           from agent_work_result_adoptions
           where workspace_id = $1 and mission_id = $2
           order by selection_version asc, created_at asc, id asc`,
          [valid.workspaceId, m.id],
        );
      const currentResultReportId = currentResult.rowCount
        ? String(currentResult.rows[0].report_id)
        : String(payload.currentResultReportId || '');
      work.revisionCounter = Number(payload.revisionCounter || 0);
      work.pendingRevisionId = String(payload.pendingRevisionId || '');
      work.currentResultReportId = currentResultReportId;
      const comparisonOutcomes = comparisonOutcomeResult.rows.map((row) => {
        const reportPayload = asObject(row.report_payload);
        const jobPayload = asObject(row.job_payload);
        return {
          reportId: row.report_id,
          jobId: row.job_id,
          executionEngine: row.requested_engine,
          requestedModel: row.requested_model || '',
          summary: String(
            reportPayload.summary || reportPayload.resultSummary || '',
          ).slice(0, 2_000),
          durationMs: Number(row.duration_ms || 0),
          costUsd: Number(
            reportPayload.costUsd ?? jobPayload.costUsd ?? 0,
          ),
          evidenceCount: Math.max(
            Number(row.artifact_count || 0),
            Array.isArray(reportPayload.evidence)
              ? reportPayload.evidence.length
              : 0,
          ),
          turnIndex: Number(row.turn_index),
          turnTargetIndex: Number(row.turn_target_index),
        };
      });

      return {
        ok: true,
        work,
        conversation,
        channels,
        checkpoints,
        nextCursor: null,
        missionId: m.id,
        sessionId,
        status: m.status,
        workspaceId: valid.workspaceId,
        messages: checkpoints,
        effectiveConfiguration: {
          current: currentEffectiveConfiguration,
          history: effectiveConfigurationHistory,
        },
        handoffGraph: {
          rootMissionId: m.id,
          rootAgentId: m.agent_id,
          maxDepth: MAX_HANDOFF_DEPTH,
          maxFanOut: MAX_HANDOFF_FAN_OUT,
          handoffs: handoffResult.rows.map(publicHandoff),
        },
        activeProviderSessionId: String(payload.activeProviderSessionId || ''),
        providerSessions: providerSessionsResult.rows.map(publicTransitionSession),
        providerSessionTransitions: providerTransitionsResult.rows.map((row) => ({
          id: row.id,
          action: row.action,
          sourceProviderSessionId: row.source_provider_session_id || '',
          targetProviderSessionId: row.target_provider_session_id,
          executionJobId: row.execution_job_id,
          clientRequestId: row.client_request_id,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        comparison: {
          currentResultReportId,
          outcomes: comparisonOutcomes,
          adoptions: adoptionResult.rows.map((row) => ({
            id: row.id,
            reportId: row.report_id,
            previousReportId: row.previous_report_id || '',
            selectionVersion: Number(row.selection_version),
            outcome: asObject(row.outcome_summary),
            createdAt: new Date(row.created_at).toISOString(),
          })),
        },
      };
    });
  }

  async #comparisonProviderEndpoint({
    client,
    valid,
    mission,
    sessionId,
    missionPayload,
    providerRows,
    target,
  }) {
    let providerSession = providerRows.find((row) => row.engine === target.executionEngine);
    let created = false;
    if (!providerSession) {
      const { resolveEngine } = require('./durable-execution');
      const runnerResult = await client.query(
        `select id, connection_state, status as runner_status, capabilities
         from runners
         where workspace_id = $1 and status = 'active'
         order by
           case when id = $2 then 0 else 1 end,
           updated_at desc,
           id asc`,
        [
          valid.workspaceId,
          String(providerRows[0]?.runner_id || missionPayload.preferredRunnerId || ''),
        ],
      );
      const eligibleRunner = runnerResult.rows.find((runner) => (
        runner.connection_state === 'connected'
        && resolveEngine(target.executionEngine, runner.capabilities || {}, this.env).resolved
          === target.executionEngine
      ));
      if (!eligibleRunner) {
        const unavailable = new Error(
          `Execution Engine ${target.executionEngine} is unavailable on this Workspace Runner`,
        );
        unavailable.code = 'provider_endpoint_unavailable';
        unavailable.statusHint = 409;
        throw unavailable;
      }
      const agentResult = await client.query(
        `select payload
         from agents
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, mission.agent_id],
      );
      const owner = providerSessionOwner(mission.agent_id, agentResult.rows[0]);
      const providerSessionId = newId('psess');
      const inserted = await client.query(
        `insert into provider_agent_sessions (
           id, workspace_id, agent_id, official_profile, runner_id, work_conversation_id,
           provider, engine, external_agent_id, status, title, public_metadata,
           context_sync_mode, last_activity_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,'pending',$9,$10::jsonb,'context_only',now())
         on conflict (workspace_id, work_conversation_id, engine, runner_id)
         do update set updated_at = now()
         returning *`,
        [
          providerSessionId,
          valid.workspaceId,
          owner.agentId,
          owner.officialProfile,
          eligibleRunner.id,
          sessionId,
          target.executionEngine,
          String(asObject(agentResult.rows[0]?.payload).externalAgentId || '').slice(0, 160),
          String(missionPayload.title || 'Work Conversation').slice(0, 300),
          JSON.stringify({
            source: 'work_conversation_comparison',
            contextSyncMode: 'context_only',
          }),
        ],
      );
      providerSession = {
        ...inserted.rows[0],
        connection_state: eligibleRunner.connection_state,
        runner_status: eligibleRunner.runner_status,
        capabilities: eligibleRunner.capabilities,
      };
      created = providerSession.id === providerSessionId;
      providerRows.push(providerSession);
    }
    if ([
      'auth_required',
      'missing',
      'deleted',
      'quota_exhausted',
      'unavailable',
      'archived',
    ].includes(providerSession.status)) {
      throw providerSessionStateError(providerSession.status);
    }
    assertRunnerSupportsModel(
      providerSession.capabilities,
      providerSession.engine,
      target.requestedModel,
    );
    return { providerSession, created };
  }

  async #addAgentWorkComparison({
    client,
    valid,
    mission,
    sessionId,
    input,
    targets,
    profileSnapshot,
    directoryAgent,
  }) {
    const text = String(input.text || input.message || '').trim().slice(0, 4_000);
    if (!text) {
      const error = new Error('Comparison message text is required');
      error.code = 'comparison_text_required';
      error.statusHint = 422;
      throw error;
    }
    if (explicitProviderEngine(input.executionEngine) || requestedExecutionModel(input.requestedModel)) {
      const error = new Error('Comparison targets cannot be combined with a single Execution Engine');
      error.code = 'comparison_request_ambiguous';
      error.statusHint = 422;
      throw error;
    }
    const providerResult = await client.query(
      `select ps.*, r.connection_state, r.status as runner_status, r.capabilities
       from provider_agent_sessions ps
       inner join runners r
         on r.workspace_id = ps.workspace_id and r.id = ps.runner_id
       where ps.workspace_id = $1 and ps.work_conversation_id = $2
       order by ps.updated_at desc, ps.id asc`,
      [valid.workspaceId, sessionId],
    );
    const providerRows = [...providerResult.rows];
    const missionPayload = asObject(mission.payload);
    const endpoints = [];
    for (const target of targets) {
      endpoints.push(await this.#comparisonProviderEndpoint({
        client,
        valid,
        mission,
        sessionId,
        missionPayload,
        providerRows,
        target,
      }));
    }
    const contextEvents = endpoints.some((endpoint) => endpoint.created)
      ? await client.query(
        `select kind, payload
         from agent_session_events
         where workspace_id = $1 and session_id = $2
           and kind in ('user_message', 'agent_message')
         order by sequence desc
         limit 24`,
        [valid.workspaceId, sessionId],
      )
      : { rows: [] };
    const seqResult = await client.query(
      `select coalesce(max(sequence), 0)::int as n
       from agent_session_events
       where workspace_id = $1 and session_id = $2`,
      [valid.workspaceId, sessionId],
    );
    const sequence = (Number(seqResult.rows[0].n) || 0) + 1;
    const turnResult = await client.query(
      `select coalesce(max(turn_index), 0)::int as n
       from execution_jobs
       where workspace_id = $1 and mission_id = $2`,
      [valid.workspaceId, mission.id],
    );
    const turnIndex = (Number(turnResult.rows[0].n) || 0) + 1;
    const clientMessageId = String(input.clientMessageId || '').slice(0, 160);
    const eventId = newId('evt');
    const publicTargets = targets.map((target) => ({
      executionEngine: target.executionEngine,
      requestedModel: target.requestedModel,
    }));
    const eventPayload = {
      text,
      clientMessageId: clientMessageId || null,
      executionEngine: null,
      requestedModel: '',
      providerSessionId: null,
      comparison: true,
      comparisonTargets: publicTargets,
      turnIndex,
      origin: String(input.origin || 'desktop').slice(0, 40),
      originEndpointId: String(input.originEndpointId || '').slice(0, 160),
      role: 'user',
      workspaceId: valid.workspaceId,
    };
    await client.query(
      `insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id)
       values ($1, $2, $3, 'user_message', $4::jsonb, $5)`,
      [eventId, sessionId, sequence, JSON.stringify(eventPayload), valid.workspaceId],
    );

    const jobs = [];
    for (let targetIndex = 0; targetIndex < endpoints.length; targetIndex += 1) {
      const { providerSession, created } = endpoints[targetIndex];
      const target = targets[targetIndex];
      const { projectAgentWorkCalendarState, resolveEngine } = require('./durable-execution');
      const resolved = providerSession.connection_state === 'connected'
        && providerSession.runner_status === 'active'
        ? resolveEngine(providerSession.engine, providerSession.capabilities || {}, this.env)
        : { requested: providerSession.engine, resolved: '', reason: 'waiting_runner' };
      const jobStatus = resolved.resolved ? 'accepted' : 'waiting_runner';
      const effectiveConfiguration = resolveEffectiveAgentConfiguration({
        workspaceId: valid.workspaceId,
        agent: directoryAgent,
        runner: {
          id: providerSession.runner_id,
          capabilities: providerSession.capabilities || {},
        },
        requestedEngine: providerSession.engine,
        resolvedEngine: resolved.resolved,
        requestedModel: target.requestedModel,
        reason: resolved.reason,
        requiredCapabilities: input.requiredCapabilities,
      });
      if (!effectiveConfiguration.executable) {
        const error = new Error('A required tool or skill is not granted');
        error.code = effectiveConfiguration.grants.approvalRequired.length
          ? 'capability_approval_required'
          : 'capability_denied';
        error.statusHint = effectiveConfiguration.grants.approvalRequired.length ? 409 : 403;
        throw error;
      }
      const jobId = newId('job');
      const projectionKey = `proj:${mission.id}:turn:${turnIndex}:target:${targetIndex}`;
      const conversationGoal = created
        ? canonicalContextGoal({
          objective: missionPayload.objective || missionPayload.goal,
          events: [...contextEvents.rows].reverse(),
          message: text,
        })
        : text;
      const effectiveGoal = profileSnapshot
        ? applyAgentExecutionProfile(conversationGoal, profileSnapshot)
        : conversationGoal;
      await client.query(
        `insert into execution_jobs (
           id, workspace_id, mission_id, session_id, requested_engine,
           requested_model, resolved_engine, resolved_model, engine_reason,
           preferred_runner_id, status, goal, payload, available_at, max_attempts,
           projection_key, turn_index, turn_target_index, turn_mode, provider_session_id
         ) values (
           $1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12::jsonb,now(),5,
           $13,$14,$15,'comparison',$16
         )`,
        [
          jobId,
          valid.workspaceId,
          mission.id,
          sessionId,
          providerSession.engine,
          target.requestedModel,
          resolved.resolved || '',
          resolved.reason,
          providerSession.runner_id,
          jobStatus,
          effectiveGoal,
          JSON.stringify({
            agentId: mission.agent_id || 'default',
            clientMessageId,
            executionEngine: providerSession.engine,
            requestedModel: target.requestedModel,
            origin: eventPayload.origin,
            turnIndex,
            turnTargetIndex: targetIndex,
            turnTargetCount: targets.length,
            turnMode: 'comparison',
            comparison: true,
            providerSessionId: providerSession.id,
            contextSyncMode: created ? 'context_only' : 'native',
            ...(profileSnapshot ? { profileSnapshot } : {}),
            effectiveConfiguration,
          }),
          projectionKey,
          turnIndex,
          targetIndex,
          providerSession.id,
        ],
      );
      await projectAgentWorkCalendarState(client, {
        workspaceId: valid.workspaceId,
        projectionKey,
        jobId,
        missionId: mission.id,
        sessionId,
        goal: conversationGoal,
        lifecycleStatus: 'scheduled',
        occurredAt: new Date().toISOString(),
        turnIndex,
        providerSessionId: providerSession.id,
      });
      await client.query(
        `update provider_agent_sessions
         set last_activity_at = now(),
             last_context_sequence = greatest(last_context_sequence, $3),
             updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, providerSession.id, sequence],
      );
      jobs.push({
        id: jobId,
        status: jobStatus,
        turnIndex,
        turnTargetIndex: targetIndex,
        providerSessionId: providerSession.id,
        executionEngine: providerSession.engine,
        requestedModel: target.requestedModel,
      });
    }
    const missionStatus = jobs.some((job) => job.status === 'accepted')
      ? 'accepted'
      : 'waiting_runner';
    await client.query(
      `update agent_missions
       set status = $3, payload = payload || $4::jsonb, updated_at = now()
       where workspace_id = $1 and id = $2`,
      [
        valid.workspaceId,
        mission.id,
        missionStatus,
        JSON.stringify({
          status: missionStatus,
          updatedAt: new Date().toISOString(),
          comparisonTurnIndex: turnIndex,
          comparisonTargets: publicTargets,
          comparisonStatus: 'running',
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
        missionStatus,
        JSON.stringify({ status: missionStatus, comparisonTurnIndex: turnIndex }),
      ],
    );
    return {
      ok: true,
      missionId: mission.id,
      sessionId,
      event: { id: eventId, sequence, kind: 'user_message', ...eventPayload },
      comparison: true,
      jobs,
      workspaceId: valid.workspaceId,
    };
  }

  async addAgentWorkMessage(scope, missionId, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const requestedProviderEngine = explicitProviderEngine(input.executionEngine);
      const comparisonTargets = requestedComparisonTargets(input.comparisonTargets);
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
      const agentResult = await client.query(
        `select payload
         from agents
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, mission.rows[0].agent_id],
      );
      const profileSnapshot = agentResult.rowCount
        ? agentExecutionProfile({
          id: mission.rows[0].agent_id,
          ...asObject(agentResult.rows[0].payload),
          workspaceId: valid.workspaceId,
        })
        : null;
      const directoryAgent = agentResult.rowCount
        ? {
          id: mission.rows[0].agent_id,
          ...asObject(agentResult.rows[0].payload),
          workspaceId: valid.workspaceId,
        }
        : {
          id: mission.rows[0].agent_id || 'default',
          displayName: 'Default agent',
          workspaceId: valid.workspaceId,
        };
      await client.query(
        `select id
         from agent_sessions
         where workspace_id = $1 and id = $2
         for update`,
        [valid.workspaceId, sessionId],
      );
      const lockedMission = await client.query(
        `select id, agent_id, payload
         from agent_missions
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, mission.rows[0].id],
      );
      if (!lockedMission.rowCount) return null;
      mission.rows[0] = lockedMission.rows[0];
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
      if (comparisonTargets.length) {
        return this.#addAgentWorkComparison({
          client,
          valid,
          mission: mission.rows[0],
          sessionId,
          input,
          targets: comparisonTargets,
          profileSnapshot,
          directoryAgent,
        });
      }
      const providerResult = await client.query(
        `select ps.*, r.connection_state, r.status as runner_status, r.capabilities
         from provider_agent_sessions ps
         inner join runners r
           on r.workspace_id = ps.workspace_id and r.id = ps.runner_id
         where ps.workspace_id = $1 and ps.work_conversation_id = $2
         order by ps.id asc`,
        [valid.workspaceId, sessionId],
      );
      const missionPayload = asObject(mission.rows[0].payload);
      const activeProviderSessionId = String(
        missionPayload.activeProviderSessionId || missionPayload.providerSessionId || '',
      );
      const activeProviderSession = activeProviderSessionId
        ? providerResult.rows.find((row) => row.id === activeProviderSessionId)
        : null;
      let providerSession = null;
      if (requestedProviderEngine) {
        if (
          activeProviderSession?.engine === requestedProviderEngine
          && providerEndpointEligible(activeProviderSession)
        ) {
          providerSession = activeProviderSession;
        } else {
          const matchingEndpoints = providerResult.rows.filter((row) => (
            row.engine === requestedProviderEngine && providerEndpointEligible(row)
          ));
          if (matchingEndpoints.length > 1) throw activeProviderEndpointConflict();
          providerSession = matchingEndpoints[0] || null;
        }
      } else if (activeProviderSessionId) {
        if (!providerEndpointEligible(activeProviderSession)) {
          throw activeProviderEndpointConflict();
        }
        providerSession = activeProviderSession;
      } else {
        const eligibleLegacyEndpoints = providerResult.rows.filter(providerEndpointEligible);
        if (eligibleLegacyEndpoints.length !== 1) throw activeProviderEndpointConflict();
        providerSession = eligibleLegacyEndpoints[0];
      }
      let createdProviderEndpoint = false;
      if (requestedProviderEngine && !providerSession) {
        const {
          resolveEngine,
        } = require('./durable-execution');
        const runnerResult = await client.query(
          `select id, connection_state, status as runner_status, capabilities
           from runners
           where workspace_id = $1 and status = 'active'
           order by
             case when id = $2 then 0 else 1 end,
             updated_at desc,
             id asc`,
          [
            valid.workspaceId,
            String(activeProviderSession?.runner_id || providerResult.rows[0]?.runner_id || ''),
          ],
        );
        const eligibleRunner = runnerResult.rows.find((runner) => (
          runner.connection_state === 'connected'
          && resolveEngine(requestedProviderEngine, runner.capabilities || {}, this.env).resolved === requestedProviderEngine
        ));
        if (!eligibleRunner) {
          const unavailable = new Error(`Execution Engine ${requestedProviderEngine} is unavailable on this Workspace Runner`);
          unavailable.code = 'provider_endpoint_unavailable';
          unavailable.statusHint = 409;
          throw unavailable;
        }
        const agentResult = await client.query(
          `select payload
           from agents
           where workspace_id = $1 and id = $2
           limit 1`,
          [valid.workspaceId, mission.rows[0].agent_id],
        );
        const owner = providerSessionOwner(
          mission.rows[0].agent_id,
          agentResult.rows[0],
        );
        const providerSessionId = newId('psess');
        const inserted = await client.query(
          `insert into provider_agent_sessions (
             id, workspace_id, agent_id, official_profile, runner_id, work_conversation_id,
             provider, engine, external_agent_id, status, title, public_metadata,
             context_sync_mode, last_activity_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,'pending',$9,$10::jsonb,'context_only',now())
           on conflict (workspace_id, work_conversation_id, engine, runner_id)
           do update set updated_at = now()
           returning *`,
          [
            providerSessionId,
            valid.workspaceId,
            owner.agentId,
            owner.officialProfile,
            eligibleRunner.id,
            sessionId,
            requestedProviderEngine,
            String(asObject(agentResult.rows[0]?.payload).externalAgentId || '').slice(0, 160),
            String(missionPayload.title || 'Work Conversation').slice(0, 300),
            JSON.stringify({
              source: 'work_conversation_engine_switch',
              contextSyncMode: 'context_only',
            }),
          ],
        );
        providerSession = {
          ...inserted.rows[0],
          connection_state: eligibleRunner.connection_state,
          runner_status: eligibleRunner.runner_status,
          capabilities: eligibleRunner.capabilities,
        };
        createdProviderEndpoint = providerSession.id === providerSessionId;
      }
      if (providerSession && [
        'auth_required',
        'missing',
        'deleted',
        'quota_exhausted',
        'unavailable',
        'archived',
      ].includes(providerSession.status)) {
        throw providerSessionStateError(providerSession.status);
      }
      if (!providerSession) throw activeProviderEndpointConflict();
      await client.query(
        `update agent_missions
         set payload = payload || $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [
          valid.workspaceId,
          mission.rows[0].id,
          JSON.stringify({
            providerSessionId: providerSession.id,
            activeProviderSessionId: providerSession.id,
            activeExecutionEngine: providerSession.engine,
          }),
        ],
      );
      const requestedModel = requestedExecutionModel(input.requestedModel);
      if (providerSession) {
        assertRunnerSupportsModel(
          providerSession.capabilities,
          providerSession.engine,
          requestedModel,
        );
      }
      const contextEvents = createdProviderEndpoint
        ? await client.query(
          `select kind, payload
           from agent_session_events
           where workspace_id = $1 and session_id = $2
             and kind in ('user_message', 'agent_message')
           order by sequence desc
           limit 24`,
          [valid.workspaceId, sessionId],
        )
        : { rows: [] };
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
        executionEngine: providerSession?.engine || requestedProviderEngine || null,
        requestedModel,
        providerSessionId: providerSession?.id || null,
        origin: String(input.origin || 'desktop').slice(0, 40),
        originEndpointId: String(input.originEndpointId || '').slice(0, 160),
        role: 'user',
        workspaceId: valid.workspaceId,
      };
      await client.query(
        `insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id)
         values ($1, $2, $3, 'user_message', $4::jsonb, $5)`,
        [eventId, sessionId, sequence, JSON.stringify(payload), valid.workspaceId],
      );
      let job = null;
      if (providerSession && payload.text) {
        const {
          projectAgentWorkCalendarState,
          resolveEngine,
        } = require('./durable-execution');
        const resolved = providerSession.connection_state === 'connected'
          && providerSession.runner_status === 'active'
          ? resolveEngine(providerSession.engine, providerSession.capabilities || {}, this.env)
          : { requested: providerSession.engine, resolved: '', reason: 'waiting_runner' };
        const jobStatus = resolved.resolved ? 'accepted' : 'waiting_runner';
        const effectiveConfiguration = resolveEffectiveAgentConfiguration({
          workspaceId: valid.workspaceId,
          agent: directoryAgent,
          runner: {
            id: providerSession.runner_id,
            capabilities: providerSession.capabilities || {},
          },
          requestedEngine: providerSession.engine,
          resolvedEngine: resolved.resolved,
          requestedModel,
          reason: resolved.reason,
          requiredCapabilities: input.requiredCapabilities,
          expectedSnapshotId: String(input.effectiveConfigurationSnapshotId || ''),
        });
        if (!effectiveConfiguration.executable) {
          const error = new Error('A required tool or skill is not granted');
          error.code = effectiveConfiguration.grants.approvalRequired.length
            ? 'capability_approval_required'
            : 'capability_denied';
          error.statusHint = effectiveConfiguration.grants.approvalRequired.length ? 409 : 403;
          throw error;
        }
        const turnResult = await client.query(
          `select coalesce(max(turn_index), 0)::int as n
           from execution_jobs
           where workspace_id = $1 and mission_id = $2`,
          [valid.workspaceId, mission.rows[0].id],
        );
        const turnIndex = (Number(turnResult.rows[0].n) || 0) + 1;
        const jobId = newId('job');
        const projectionKey = `proj:${mission.rows[0].id}:turn:${turnIndex}`;
        const conversationGoal = createdProviderEndpoint
          ? canonicalContextGoal({
            objective: missionPayload.objective || missionPayload.goal,
            events: [...contextEvents.rows].reverse(),
            message: payload.text,
          })
          : payload.text.slice(0, 4_000);
        const effectiveGoal = profileSnapshot
          ? applyAgentExecutionProfile(conversationGoal, profileSnapshot)
          : conversationGoal;
        await client.query(
          `insert into execution_jobs (
             id, workspace_id, mission_id, session_id, requested_engine,
             requested_model, resolved_engine, resolved_model, engine_reason, preferred_runner_id, status,
             goal, payload, available_at, max_attempts, projection_key,
             turn_index, provider_session_id
           ) values (
             $1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12::jsonb,now(),5,$13,$14,$15
           )`,
          [
            jobId,
            valid.workspaceId,
            mission.rows[0].id,
            sessionId,
            providerSession.engine,
            requestedModel,
            resolved.resolved || '',
            resolved.reason,
            providerSession.runner_id,
            jobStatus,
            effectiveGoal,
            JSON.stringify({
              agentId: mission.rows[0].agent_id || 'default',
              clientMessageId,
              executionEngine: providerSession.engine,
              requestedModel,
              origin: payload.origin,
              turnIndex,
              providerSessionId: providerSession.id,
              contextSyncMode: createdProviderEndpoint ? 'context_only' : 'native',
              ...(profileSnapshot ? { profileSnapshot } : {}),
              effectiveConfiguration,
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
          goal: conversationGoal,
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
              activeProviderSessionId: providerSession.id,
              activeExecutionEngine: providerSession.engine,
              activeExecutionModel: requestedModel,
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
        await client.query(
          `update provider_agent_sessions
           set last_activity_at = now(),
               last_context_sequence = greatest(last_context_sequence, $3),
               updated_at = now()
           where workspace_id = $1 and id = $2`,
          [valid.workspaceId, providerSession.id, sequence],
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

  async listAgentWorkHandoffs(scope, missionId) {
    return this.#run(scope, async (client, valid) => {
      const id = publicMutationId(missionId, 'mission_id');
      const mission = await client.query(
        `select id
         from agent_missions
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, id],
      );
      if (!mission.rowCount) {
        return {
          handoffs: [],
          maxDepth: MAX_HANDOFF_DEPTH,
          maxFanOut: MAX_HANDOFF_FAN_OUT,
        };
      }
      const result = await client.query(
        `select *
         from agent_work_handoffs
         where workspace_id = $1 and root_mission_id = $2
         order by depth asc, created_at asc, id asc`,
        [valid.workspaceId, id],
      );
      return {
        handoffs: result.rows.map(publicHandoff),
        maxDepth: MAX_HANDOFF_DEPTH,
        maxFanOut: MAX_HANDOFF_FAN_OUT,
      };
    });
  }

  async createAgentWorkHandoff(scope, missionId, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const untrustedFields = [
        'lineage',
        'depth',
        'rootAgentId',
        'effectiveGrants',
        'effectiveBudget',
        'maxDepth',
        'maxFanOut',
      ];
      if (untrustedFields.some((field) => Object.hasOwn(asObject(input), field))) {
        throw scopedMutationError(
          'handoff_lineage_untrusted',
          'Handoff lineage and limits are server-owned',
          400,
        );
      }
      const id = publicMutationId(missionId, 'mission_id');
      const clientRequestId = publicMutationId(
        input.clientRequestId,
        'client_request_id',
      );
      const receiverAgentId = publicMutationId(
        input.receiverAgentId,
        'receiver_agent_id',
      );
      const delegatorAgentId = publicMutationId(
        input.delegatorAgentId,
        'delegator_agent_id',
      );
      const parentHandoffId = input.parentHandoffId
        ? publicMutationId(input.parentHandoffId, 'parent_handoff_id')
        : null;
      const parentTaskId = input.parentTaskId
        ? publicMutationId(input.parentTaskId, 'parent_task_id')
        : '';
      const goal = String(input.goal || '').trim().slice(0, 4_000);
      if (!goal) {
        throw scopedMutationError(
          'handoff_goal_required',
          'Child handoff goal is required',
        );
      }
      const missionResult = await client.query(
        `select id, agent_id, payload
         from agent_missions
         where workspace_id = $1 and id = $2
         for update`,
        [valid.workspaceId, id],
      );
      if (!missionResult.rowCount) {
        throw scopedMutationError(
          'handoff_mission_not_found',
          'Root Work was not found',
          404,
        );
      }
      const replay = await client.query(
        `select *
         from agent_work_handoffs
         where workspace_id = $1 and root_mission_id = $2
           and client_request_id = $3
         limit 1`,
        [valid.workspaceId, id, clientRequestId],
      );
      if (replay.rowCount) {
        return {
          ok: true,
          idempotentReplay: true,
          handoff: publicHandoff(replay.rows[0]),
          workspaceId: valid.workspaceId,
        };
      }
      const mission = missionResult.rows[0];
      const rootAgentId = String(mission.agent_id || '');
      const sessionResult = await client.query(
        `select id
         from agent_sessions
         where workspace_id = $1 and mission_id = $2
         order by created_at asc
         limit 1`,
        [valid.workspaceId, id],
      );
      if (!sessionResult.rowCount) {
        throw scopedMutationError(
          'handoff_conversation_not_found',
          'Root Work Conversation was not found',
          409,
        );
      }
      let parent = null;
      if (parentHandoffId) {
        const parentResult = await client.query(
          `select *
           from agent_work_handoffs
           where workspace_id = $1 and root_mission_id = $2 and id = $3
           for update`,
          [valid.workspaceId, id, parentHandoffId],
        );
        if (!parentResult.rowCount) {
          throw scopedMutationError(
            'handoff_parent_not_found',
            'Parent child handoff was not found',
            404,
          );
        }
        parent = parentResult.rows[0];
        if (parent.status === 'cancelled') {
          throw scopedMutationError(
            'handoff_parent_cancelled',
            'Cancelled child handoff cannot delegate',
            409,
          );
        }
      }
      const expectedDelegator = parent ? parent.receiver_agent_id : rootAgentId;
      if (delegatorAgentId !== expectedDelegator) {
        throw scopedMutationError(
          'handoff_delegator_mismatch',
          'Delegator does not own the parent handoff',
          403,
        );
      }
      const depth = parent ? Number(parent.depth) + 1 : 1;
      const parentLineage = parent
        ? (Array.isArray(parent.lineage) ? parent.lineage.map(String) : [])
        : [rootAgentId];
      if (parentLineage.includes(receiverAgentId)) {
        throw scopedMutationError(
          'handoff_cycle',
          'Child handoff would create a cycle',
          409,
        );
      }
      if (depth > MAX_HANDOFF_DEPTH) {
        throw scopedMutationError(
          'handoff_depth_exceeded',
          'Child handoff depth limit exceeded',
          409,
        );
      }
      const fanOut = await client.query(
        `select count(*)::int as n
         from agent_work_handoffs
         where workspace_id = $1 and root_mission_id = $2
           and parent_handoff_id is not distinct from $3::text`,
        [valid.workspaceId, id, parentHandoffId],
      );
      if (Number(fanOut.rows[0].n) >= MAX_HANDOFF_FAN_OUT) {
        throw scopedMutationError(
          'handoff_fanout_exceeded',
          'Child handoff fan-out limit exceeded',
          409,
        );
      }
      const agents = await client.query(
        `select id, payload
         from agents
         where workspace_id = $1 and id = any($2::text[])`,
        [
          valid.workspaceId,
          [...new Set([rootAgentId, delegatorAgentId, receiverAgentId])],
        ],
      );
      const agentById = new Map(agents.rows.map((row) => [row.id, asObject(row.payload)]));
      if (!agentById.has(receiverAgentId)) {
        throw scopedMutationError(
          'handoff_workspace_mismatch',
          'Receiver Agent is not in this Workspace',
          404,
        );
      }
      if (!agentById.has(rootAgentId) || !agentById.has(delegatorAgentId)) {
        throw scopedMutationError(
          'handoff_agent_not_found',
          'Handoff Agent identity is unavailable',
          409,
        );
      }
      const missionPolicy = asObject(asObject(mission.payload).handoffPolicy);
      const parentGrants = parent
        ? asObject(parent.effective_grants)
        : asObject(missionPolicy.grants).allow
          ? missionPolicy.grants
          : asObject(agentById.get(rootAgentId).grants);
      const parentBudget = parent
        ? asObject(parent.effective_budget)
        : normalizedHandoffBudget(missionPolicy.budget);
      const effectiveGrants = intersectedGrants(
        parentGrants,
        asObject(agentById.get(receiverAgentId).grants),
        input.requestedGrants,
      );
      const effectiveBudget = normalizedHandoffBudget(
        input.requestedBudget,
        normalizedHandoffBudget(parentBudget),
      );
      const receiver = {
        id: receiverAgentId,
        ...agentById.get(receiverAgentId),
        grants: effectiveGrants,
        workspaceId: valid.workspaceId,
      };
      const runnerResult = await client.query(
        `select id, capabilities, connection_state, status
         from runners
         where workspace_id = $1 and status = 'active'
         order by
           case when id = $2 then 0 else 1 end,
           case when connection_state = 'connected' then 0 else 1 end,
           updated_at desc,
           id asc`,
        [
          valid.workspaceId,
          String(receiver.defaultRunnerId || ''),
        ],
      );
      const runner = runnerResult.rows[0];
      if (!runner) {
        throw scopedMutationError(
          'handoff_runner_unavailable',
          'No Workspace Runner is available for the child handoff',
          409,
        );
      }
      const requestedEngine = explicitProviderEngine(
        input.executionEngine || receiver.defaultExecutionEngine || 'codex',
      );
      const { resolveEngine } = require('./durable-execution');
      const resolved = runner.connection_state === 'connected'
        ? resolveEngine(requestedEngine, runner.capabilities || {}, this.env)
        : {
          requested: requestedEngine,
          resolved: '',
          reason: 'waiting_runner',
        };
      const effectiveConfiguration = resolveEffectiveAgentConfiguration({
        workspaceId: valid.workspaceId,
        agent: receiver,
        runner,
        requestedEngine,
        resolvedEngine: resolved.resolved,
        requestedModel: requestedExecutionModel(input.requestedModel),
        reason: resolved.reason,
        requiredCapabilities: input.requiredCapabilities,
      });
      if (!effectiveConfiguration.executable) {
        throw scopedMutationError(
          'handoff_capability_denied',
          'Child handoff effective grants do not authorize the request',
          403,
        );
      }
      const turnResult = await client.query(
        `select coalesce(max(turn_index), 0)::int as n
         from execution_jobs
         where workspace_id = $1 and mission_id = $2`,
        [valid.workspaceId, id],
      );
      const turnIndex = Number(turnResult.rows[0].n) + 1;
      const handoffId = newId('handoff');
      const jobId = newId('job');
      const jobStatus = resolved.resolved ? 'accepted' : 'waiting_runner';
      const projectionKey = `handoff:${handoffId}`;
      const lineage = [...parentLineage, receiverAgentId];
      await client.query(
        `insert into execution_jobs (
           id, workspace_id, mission_id, session_id, requested_engine,
           requested_model, resolved_engine, resolved_model, engine_reason,
           preferred_runner_id, status, goal, payload, available_at, max_attempts,
           projection_key, turn_index, turn_target_index, turn_mode
         ) values (
           $1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12::jsonb,now(),5,
           $13,$14,0,'single'
         )`,
        [
          jobId,
          valid.workspaceId,
          id,
          sessionResult.rows[0].id,
          requestedEngine,
          requestedExecutionModel(input.requestedModel),
          resolved.resolved || '',
          resolved.reason,
          runner.id,
          jobStatus,
          goal,
          JSON.stringify({
            agentId: receiverAgentId,
            handoffId,
            rootAgentId,
            delegatorAgentId,
            receiverAgentId,
            lineage,
            effectiveGrants,
            effectiveBudget,
            effectiveConfiguration,
          }),
          projectionKey,
          turnIndex,
        ],
      );
      const inserted = await client.query(
        `insert into agent_work_handoffs (
           id, workspace_id, root_mission_id, parent_handoff_id, parent_task_id,
           root_agent_id, delegator_agent_id, receiver_agent_id, depth, lineage,
           effective_grants, effective_budget, status, client_request_id,
           execution_job_id
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::jsonb,$12::jsonb,
           $13,$14,$15
         )
         returning *`,
        [
          handoffId,
          valid.workspaceId,
          id,
          parentHandoffId,
          parentTaskId,
          rootAgentId,
          delegatorAgentId,
          receiverAgentId,
          depth,
          lineage,
          JSON.stringify(effectiveGrants),
          JSON.stringify(effectiveBudget),
          jobStatus,
          clientRequestId,
          jobId,
        ],
      );
      return {
        ok: true,
        idempotentReplay: false,
        handoff: publicHandoff(inserted.rows[0]),
        job: {
          id: jobId,
          status: jobStatus,
          turnIndex,
        },
        workspaceId: valid.workspaceId,
      };
    });
  }

  async cancelAgentWorkHandoff(scope, missionId, handoffId, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const rootMissionId = publicMutationId(missionId, 'mission_id');
      const id = publicMutationId(handoffId, 'handoff_id');
      const result = await client.query(
        `select *
         from agent_work_handoffs
         where workspace_id = $1 and root_mission_id = $2 and id = $3
         for update`,
        [valid.workspaceId, rootMissionId, id],
      );
      if (!result.rowCount) {
        throw scopedMutationError(
          'handoff_not_found',
          'Child handoff was not found',
          404,
        );
      }
      const current = result.rows[0];
      if (['completed', 'failed', 'cancelled'].includes(current.status)) {
        return {
          ok: true,
          idempotentReplay: true,
          handoff: publicHandoff(current),
          workspaceId: valid.workspaceId,
        };
      }
      const reason = String(input.reason || 'user_cancelled').trim().slice(0, 160);
      await client.query(
        `update execution_jobs
         set cancellation_requested = true,
             status = case
               when status in ('accepted', 'waiting_runner', 'offered')
                 then 'cancelled'
               else status
             end,
             terminal_at = case
               when status in ('accepted', 'waiting_runner', 'offered')
                 then now()
               else terminal_at
             end,
             updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, current.execution_job_id],
      );
      const updated = await client.query(
        `update agent_work_handoffs
         set status = 'cancelled', cancellation_requested = true,
             cancellation_reason = $4,
             result_projection = result_projection || $5::jsonb,
             terminal_at = coalesce(terminal_at, now()), updated_at = now()
         where workspace_id = $1 and root_mission_id = $2 and id = $3
         returning *`,
        [
          valid.workspaceId,
          rootMissionId,
          id,
          reason,
          JSON.stringify({ status: 'cancelled', reason }),
        ],
      );
      return {
        ok: true,
        idempotentReplay: false,
        handoff: publicHandoff(updated.rows[0]),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async transitionAgentWorkProviderSession(scope, missionId, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = publicMutationId(missionId, 'mission_id');
      const clientRequestId = publicMutationId(
        input.clientRequestId,
        'client_request_id',
      );
      const action = String(input.action || '').trim().toLowerCase();
      if (!['rebind', 'new_session', 'fork'].includes(action)) {
        throw scopedMutationError(
          'provider_session_action_invalid',
          'Provider session action must be explicit',
          422,
        );
      }
      const text = String(input.text || '').trim().slice(0, 4_000);
      if (!text) {
        throw scopedMutationError(
          'provider_session_transition_text_required',
          'Provider session transition requires an execution message',
          422,
        );
      }
      const missionResult = await client.query(
        `select id, agent_id, payload
         from agent_missions
         where workspace_id = $1 and id = $2
         for update`,
        [valid.workspaceId, id],
      );
      if (!missionResult.rowCount) {
        throw scopedMutationError(
          'provider_session_mission_not_found',
          'Work was not found',
          404,
        );
      }
      const replay = await client.query(
        `select t.*, ps.*, j.status as job_status, j.turn_index
         from provider_session_transitions t
         inner join provider_agent_sessions ps
           on ps.workspace_id = t.workspace_id
          and ps.id = t.target_provider_session_id
         inner join execution_jobs j
           on j.workspace_id = t.workspace_id
          and j.id = t.execution_job_id
         where t.workspace_id = $1 and t.mission_id = $2
           and t.client_request_id = $3
         limit 1`,
        [valid.workspaceId, id, clientRequestId],
      );
      if (replay.rowCount) {
        const row = replay.rows[0];
        return {
          ok: true,
          idempotentReplay: true,
          transition: {
            id: row.id,
            action: row.action,
            sourceProviderSessionId: row.source_provider_session_id || '',
            targetProviderSessionId: row.target_provider_session_id,
            clientRequestId: row.client_request_id,
          },
          session: publicTransitionSession(row),
          job: {
            id: row.execution_job_id,
            status: row.job_status,
            turnIndex: Number(row.turn_index),
          },
          workspaceId: valid.workspaceId,
        };
      }
      const mission = missionResult.rows[0];
      const payload = asObject(mission.payload);
      const sessionResult = await client.query(
        `select id
         from agent_sessions
         where workspace_id = $1 and mission_id = $2
         order by created_at asc
         limit 1`,
        [valid.workspaceId, id],
      );
      if (!sessionResult.rowCount) {
        throw scopedMutationError(
          'provider_session_conversation_not_found',
          'Work Conversation was not found',
          409,
        );
      }
      const workConversationId = sessionResult.rows[0].id;
      const activeProviderSessionId = String(
        payload.activeProviderSessionId || payload.providerSessionId || '',
      );
      const expectedActiveProviderSessionId = String(
        input.expectedActiveProviderSessionId || '',
      );
      if (expectedActiveProviderSessionId !== activeProviderSessionId) {
        throw scopedMutationError(
          'provider_session_selection_stale',
          'Provider session selection is stale',
          409,
        );
      }
      const loadProviderSession = async (providerSessionId) => {
        const providerId = publicMutationId(
          providerSessionId,
          'provider_session_id',
        );
        const result = await client.query(
          `select *
           from provider_agent_sessions
           where workspace_id = $1 and work_conversation_id = $2 and id = $3
           limit 1`,
          [valid.workspaceId, workConversationId, providerId],
        );
        if (!result.rowCount) {
          throw scopedMutationError(
            'provider_session_not_found',
            'Provider session was not found in this Workspace',
            404,
          );
        }
        return result.rows[0];
      };
      let source = null;
      let target = null;
      if (action === 'rebind') {
        target = await loadProviderSession(input.targetProviderSessionId);
      } else {
        const sourceId = action === 'fork'
          ? input.sourceProviderSessionId
          : activeProviderSessionId;
        source = await loadProviderSession(sourceId);
      }
      const blocked = target || source;
      if (!providerEndpointEligible(blocked)) {
        throw scopedMutationError(
          'provider_session_state_blocked',
          `Provider session is ${String(blocked.status || 'unavailable')}`,
          409,
        );
      }
      if (action !== 'rebind') {
        const requestedEngine = explicitProviderEngine(
          input.executionEngine || source.engine,
        );
        const generationResult = await client.query(
          `select coalesce(max(session_generation), -1)::int as n
           from provider_agent_sessions
           where workspace_id = $1 and work_conversation_id = $2
             and engine = $3 and runner_id = $4`,
          [
            valid.workspaceId,
            workConversationId,
            requestedEngine,
            source.runner_id,
          ],
        );
        const generation = Number(generationResult.rows[0].n) + 1;
        const providerSessionId = newId('psess');
        const sourceLineage = Array.isArray(source.session_lineage)
          && source.session_lineage.length
          ? source.session_lineage.map(String)
          : [source.id];
        const lineage = action === 'fork'
          ? [...sourceLineage, providerSessionId]
          : [providerSessionId];
        if (lineage.length > 16 || new Set(lineage).size !== lineage.length) {
          throw scopedMutationError(
            'provider_session_lineage_invalid',
            'Provider session lineage is invalid',
            409,
          );
        }
        const inserted = await client.query(
          `insert into provider_agent_sessions (
             id, workspace_id, agent_id, official_profile, runner_id,
             work_conversation_id, provider, engine, external_agent_id,
             external_session_id, status, title, public_metadata,
             context_sync_mode, parent_provider_session_id,
             session_generation, session_lineage, transition_action,
             last_activity_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,'','pending',$10,$11::jsonb,
             'context_only',$12,$13,$14::text[],$15,now()
           )
           returning *`,
          [
            providerSessionId,
            valid.workspaceId,
            source.agent_id,
            source.official_profile || '',
            source.runner_id,
            workConversationId,
            requestedEngine,
            requestedEngine,
            source.external_agent_id || '',
            String(payload.title || source.title || 'Work Conversation').slice(0, 300),
            JSON.stringify({
              source: `explicit_${action}`,
              contextSyncMode: 'context_only',
            }),
            action === 'fork' ? source.id : null,
            generation,
            lineage,
            action,
          ],
        );
        target = inserted.rows[0];
      }
      const runnerResult = await client.query(
        `select id, capabilities, connection_state, status
         from runners
         where workspace_id = $1 and id = $2 and status = 'active'
         limit 1`,
        [valid.workspaceId, target.runner_id],
      );
      if (!runnerResult.rowCount) {
        throw scopedMutationError(
          'provider_session_runner_unavailable',
          'Provider session Runner is unavailable',
          409,
        );
      }
      const runner = runnerResult.rows[0];
      const agentResult = await client.query(
        `select id, payload
         from agents
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, mission.agent_id],
      );
      const agent = agentResult.rowCount
        ? {
          id: agentResult.rows[0].id,
          ...asObject(agentResult.rows[0].payload),
          workspaceId: valid.workspaceId,
        }
        : {
          id: mission.agent_id,
          displayName: mission.agent_id,
          workspaceId: valid.workspaceId,
        };
      const { resolveEngine } = require('./durable-execution');
      const resolved = runner.connection_state === 'connected'
        ? resolveEngine(target.engine, runner.capabilities || {}, this.env)
        : {
          requested: target.engine,
          resolved: '',
          reason: 'waiting_runner',
        };
      const requestedModel = requestedExecutionModel(input.requestedModel);
      const effectiveConfiguration = resolveEffectiveAgentConfiguration({
        workspaceId: valid.workspaceId,
        agent,
        runner,
        requestedEngine: target.engine,
        resolvedEngine: resolved.resolved,
        requestedModel,
        reason: resolved.reason,
        requiredCapabilities: input.requiredCapabilities,
      });
      if (!effectiveConfiguration.executable) {
        throw scopedMutationError(
          'provider_session_capability_denied',
          'Provider session transition is not authorized',
          403,
        );
      }
      const turnResult = await client.query(
        `select coalesce(max(turn_index), 0)::int as n
         from execution_jobs
         where workspace_id = $1 and mission_id = $2`,
        [valid.workspaceId, id],
      );
      const turnIndex = Number(turnResult.rows[0].n) + 1;
      const transitionId = newId('ptransition');
      const jobId = newId('job');
      const jobStatus = resolved.resolved ? 'accepted' : 'waiting_runner';
      await client.query(
        `insert into execution_jobs (
           id, workspace_id, mission_id, session_id, requested_engine,
           requested_model, resolved_engine, resolved_model, engine_reason,
           preferred_runner_id, status, goal, payload, available_at, max_attempts,
           projection_key, turn_index, turn_target_index, turn_mode,
           provider_session_id
         ) values (
           $1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12::jsonb,now(),5,
           $13,$14,0,'single',$15
         )`,
        [
          jobId,
          valid.workspaceId,
          id,
          workConversationId,
          target.engine,
          requestedModel,
          resolved.resolved || '',
          resolved.reason,
          target.runner_id,
          jobStatus,
          text,
          JSON.stringify({
            agentId: mission.agent_id,
            providerSessionId: target.id,
            providerSessionTransitionId: transitionId,
            providerSessionAction: action,
            effectiveConfiguration,
          }),
          `provider-transition:${transitionId}`,
          turnIndex,
          target.id,
        ],
      );
      await client.query(
        `insert into provider_session_transitions (
           id, workspace_id, mission_id, work_conversation_id, action,
           source_provider_session_id, target_provider_session_id,
           execution_job_id, client_request_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          transitionId,
          valid.workspaceId,
          id,
          workConversationId,
          action,
          action === 'rebind'
            ? activeProviderSessionId || null
            : source?.id || null,
          target.id,
          jobId,
          clientRequestId,
        ],
      );
      await client.query(
        `update agent_missions
         set payload = payload || $3::jsonb, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [
          valid.workspaceId,
          id,
          JSON.stringify({
            providerSessionId: target.id,
            activeProviderSessionId: target.id,
            activeExecutionEngine: target.engine,
            activeExecutionModel: requestedModel,
          }),
        ],
      );
      return {
        ok: true,
        idempotentReplay: false,
        transition: {
          id: transitionId,
          action,
          sourceProviderSessionId: action === 'rebind'
            ? activeProviderSessionId
            : source?.id || '',
          targetProviderSessionId: target.id,
          clientRequestId,
        },
        session: publicTransitionSession(target),
        job: {
          id: jobId,
          status: jobStatus,
          turnIndex,
        },
        workspaceId: valid.workspaceId,
      };
    });
  }

  async adoptAgentWorkComparisonResult(scope, missionId, input = {}) {
    return this.#run(scope, async (client, valid) => {
      const id = publicMutationId(missionId, 'mission_id');
      const selectionId = publicMutationId(input.selectionId, 'selection_id');
      const reportId = publicMutationId(input.reportId, 'report_id');
      const expectedCurrentResultReportId = String(
        input.expectedCurrentResultReportId || '',
      );
      const mission = await client.query(
        `select id
         from agent_missions
         where workspace_id = $1 and id = $2
         for update`,
        [valid.workspaceId, id],
      );
      if (!mission.rowCount) {
        throw scopedMutationError(
          'comparison_mission_not_found',
          'Work was not found',
          404,
        );
      }
      const replay = await client.query(
        `select a.*, c.report_id as current_report_id
         from agent_work_result_adoptions a
         inner join agent_work_current_results c
           on c.workspace_id = a.workspace_id and c.mission_id = a.mission_id
         where a.workspace_id = $1 and a.mission_id = $2 and a.id = $3
         limit 1`,
        [valid.workspaceId, id, selectionId],
      );
      if (replay.rowCount) {
        const row = replay.rows[0];
        return {
          ok: true,
          idempotentReplay: true,
          currentResultReportId: row.current_report_id,
          adoption: {
            id: row.id,
            reportId: row.report_id,
            previousReportId: row.previous_report_id || '',
            selectionVersion: Number(row.selection_version),
            outcome: asObject(row.outcome_summary),
            createdAt: new Date(row.created_at).toISOString(),
          },
          workspaceId: valid.workspaceId,
        };
      }
      const pointer = await client.query(
        `select report_id, selection_version
         from agent_work_current_results
         where workspace_id = $1 and mission_id = $2
         for update`,
        [valid.workspaceId, id],
      );
      const currentReportId = pointer.rowCount
        ? String(pointer.rows[0].report_id)
        : '';
      if (currentReportId !== expectedCurrentResultReportId) {
        throw scopedMutationError(
          'comparison_selection_stale',
          'Comparison current-result selection is stale',
          409,
        );
      }
      const outcomeResult = await client.query(
        `select
           r.id as report_id,
           r.payload as report_payload,
           j.id as job_id,
           j.requested_engine,
           j.requested_model,
           j.payload as job_payload,
           greatest(
             0,
             coalesce(
               extract(epoch from (max(a.terminal_at) - min(a.started_at))) * 1000,
               0
             )
           )::bigint as duration_ms,
           count(distinct art.id)::int as artifact_count
         from agent_reports r
         inner join execution_jobs j
           on j.workspace_id = r.workspace_id
          and j.mission_id = r.mission_id
          and j.id = r.payload->>'jobId'
          and j.turn_mode = 'comparison'
         left join execution_attempts a
           on a.workspace_id = j.workspace_id and a.job_id = j.id
         left join execution_artifacts art
           on art.workspace_id = j.workspace_id and art.job_id = j.id
         where r.workspace_id = $1 and r.mission_id = $2 and r.id = $3
         group by r.id, r.payload, j.id, j.requested_engine,
                  j.requested_model, j.payload`,
        [valid.workspaceId, id, reportId],
      );
      if (!outcomeResult.rowCount) {
        throw scopedMutationError(
          'comparison_result_not_found',
          'Comparison result was not found',
          404,
        );
      }
      const outcomeRow = outcomeResult.rows[0];
      const reportPayload = asObject(outcomeRow.report_payload);
      const jobPayload = asObject(outcomeRow.job_payload);
      const reportEvidenceCount = Array.isArray(reportPayload.evidence)
        ? reportPayload.evidence.length
        : 0;
      const outcome = {
        reportId,
        jobId: outcomeRow.job_id,
        executionEngine: outcomeRow.requested_engine,
        requestedModel: outcomeRow.requested_model || '',
        summary: String(
          reportPayload.summary || reportPayload.resultSummary || '',
        ).slice(0, 2_000),
        durationMs: Number(outcomeRow.duration_ms || 0),
        costUsd: Number(
          reportPayload.costUsd ?? jobPayload.costUsd ?? 0,
        ),
        evidenceCount: Math.max(
          Number(outcomeRow.artifact_count || 0),
          reportEvidenceCount,
        ),
      };
      const selectionVersion = pointer.rowCount
        ? Number(pointer.rows[0].selection_version) + 1
        : 1;
      await client.query(
        `insert into agent_work_current_results (
           workspace_id, mission_id, report_id, selection_version, selected_at
         ) values ($1,$2,$3,$4,now())
         on conflict (workspace_id, mission_id)
         do update set report_id = excluded.report_id,
                       selection_version = excluded.selection_version,
                       selected_at = excluded.selected_at`,
        [valid.workspaceId, id, reportId, selectionVersion],
      );
      const adoptionResult = await client.query(
        `insert into agent_work_result_adoptions (
           id, workspace_id, mission_id, report_id, previous_report_id,
           selection_version, outcome_summary
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
         returning *`,
        [
          selectionId,
          valid.workspaceId,
          id,
          reportId,
          currentReportId || null,
          selectionVersion,
          JSON.stringify(outcome),
        ],
      );
      const adoption = adoptionResult.rows[0];
      return {
        ok: true,
        idempotentReplay: false,
        currentResultReportId: reportId,
        adoption: {
          id: adoption.id,
          reportId: adoption.report_id,
          previousReportId: adoption.previous_report_id || '',
          selectionVersion: Number(adoption.selection_version),
          outcome,
          createdAt: new Date(adoption.created_at).toISOString(),
        },
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
