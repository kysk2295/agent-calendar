'use strict';

const crypto = require('node:crypto');
const {
  normalizeWorkspaceAgent,
  WorkspaceAgentDirectoryError,
} = require('./workspace-agent-directory');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { assertWorkspaceScope } = require('./workspace-scope');
const {
  normalizeAutomationConnectorResult,
} = require('./runner-automation-source-adapter');

const PROVIDERS = new Set(['claude', 'codex', 'grok', 'hermes']);
const CATALOG_FIELDS = new Set([
  'provider',
  'externalAgentId',
  'displayName',
  'description',
  'sourceKind',
  'capability',
  'modifiedAt',
  'status',
]);
const SESSION_CATALOG_FIELDS = new Set([
  'provider',
  'externalSessionId',
  'title',
  'updatedAt',
  'status',
  'sourceKind',
  'capability',
]);
const PRIVATE_FIELD_PATTERN = /(api[_-]?key|authorization|cookie|credential|password|private|secret|token)/i;
const HOST_PATH_PATTERN = /(?:^|[\s"'=:])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/;
const SECRET_VALUE_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const AUTOMATION_CONNECTOR_KINDS = new Set([
  'automation_capabilities',
  'automation_list',
  'automation_mutation',
]);

function bridgeError(code, message, statusHint = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function text(value, { max = 500 } = {}) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  if (normalized.length > max) {
    throw bridgeError('provider_catalog_invalid', 'provider catalog value exceeds the public metadata limit');
  }
  return normalized;
}

function assertPublicValue(value) {
  if (HOST_PATH_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value)) {
    throw bridgeError(
      'provider_catalog_private_data',
      'provider catalog response contains private host data',
    );
  }
}

function normalizeCatalogEntry(provider, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bridgeError('provider_catalog_invalid', 'provider catalog entry must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!CATALOG_FIELDS.has(key) || PRIVATE_FIELD_PATTERN.test(key)) {
      throw bridgeError(
        'provider_catalog_private_data',
        'provider catalog response contains a non-public field',
      );
    }
  }

  const normalizedProvider = text(input.provider || provider, { max: 32 }).toLowerCase();
  if (!PROVIDERS.has(normalizedProvider) || normalizedProvider !== provider) {
    throw bridgeError('provider_catalog_invalid', 'provider catalog entry has the wrong provider');
  }

  const entry = {
    provider: normalizedProvider,
    externalAgentId: text(input.externalAgentId, { max: 160 }),
    displayName: text(input.displayName, { max: 160 }),
    description: text(input.description, { max: 500 }),
    sourceKind: text(input.sourceKind, { max: 64 }),
    capability: text(input.capability, { max: 64 }),
  };
  if (!entry.externalAgentId || !entry.displayName) {
    throw bridgeError('provider_catalog_invalid', 'provider catalog identity is required');
  }
  for (const value of Object.values(entry)) assertPublicValue(value);

  if (input.modifiedAt !== undefined) {
    entry.modifiedAt = text(input.modifiedAt, { max: 64 });
    assertPublicValue(entry.modifiedAt);
  }
  if (input.status !== undefined) {
    entry.status = text(input.status, { max: 64 });
    assertPublicValue(entry.status);
  }
  return entry;
}

function normalizeCatalogResponse(providerValue, entries) {
  const provider = text(providerValue, { max: 32 }).toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw bridgeError('provider_catalog_invalid', 'unsupported provider catalog');
  }
  if (!Array.isArray(entries) || entries.length > 200) {
    throw bridgeError('provider_catalog_invalid', 'provider catalog must be a bounded array');
  }
  return entries.map((entry) => normalizeCatalogEntry(provider, entry));
}

function normalizeSessionCatalogEntry(provider, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bridgeError('provider_catalog_invalid', 'provider session catalog entry must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!SESSION_CATALOG_FIELDS.has(key) || PRIVATE_FIELD_PATTERN.test(key)) {
      throw bridgeError(
        'provider_catalog_private_data',
        'provider session catalog response contains a non-public field',
      );
    }
  }
  const normalizedProvider = text(input.provider || provider, { max: 32 }).toLowerCase();
  if (!PROVIDERS.has(normalizedProvider) || normalizedProvider !== provider) {
    throw bridgeError('provider_catalog_invalid', 'provider session catalog entry has the wrong provider');
  }
  const entry = {
    provider: normalizedProvider,
    externalSessionId: text(input.externalSessionId, { max: 200 }),
    title: text(input.title, { max: 200 }),
    updatedAt: text(input.updatedAt, { max: 64 }),
    status: text(input.status || 'available', { max: 64 }),
    sourceKind: text(input.sourceKind || 'local_session', { max: 64 }),
    capability: text(input.capability || 'resumable', { max: 64 }),
  };
  if (!entry.externalSessionId || !entry.title) {
    throw bridgeError('provider_catalog_invalid', 'provider session catalog identity is required');
  }
  for (const value of Object.values(entry)) assertPublicValue(value);
  return entry;
}

function normalizeSessionCatalogResponse(providerValue, entries) {
  const provider = text(providerValue, { max: 32 }).toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw bridgeError('provider_catalog_invalid', 'unsupported provider session catalog');
  }
  if (!Array.isArray(entries) || entries.length > 200) {
    throw bridgeError('provider_catalog_invalid', 'provider session catalog must be a bounded array');
  }
  return entries.map((entry) => normalizeSessionCatalogEntry(provider, entry));
}

function normalizeProviderSession(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const session = {
    id: text(value.id, { max: 160 }),
    workspaceId: text(value.workspaceId, { max: 160 }),
    agentId: text(value.agentId, { max: 160 }),
    runnerId: text(value.runnerId, { max: 160 }),
    missionId: text(value.missionId, { max: 160 }),
    workConversationId: text(value.workConversationId, { max: 160 }),
    engine: text(value.engine, { max: 32 }).toLowerCase(),
    provider: text(value.provider, { max: 32 }).toLowerCase(),
    externalAgentId: text(value.externalAgentId, { max: 160 }),
    externalSessionId: text(value.externalSessionId, { max: 200 }),
    status: text(value.status, { max: 64 }) || 'pending',
    title: text(value.title, { max: 200 }),
    lastErrorCode: text(value.lastErrorCode, { max: 64 }),
  };
  const required = [
    'id',
    'workspaceId',
    'agentId',
    'runnerId',
    'missionId',
    'workConversationId',
    'engine',
    'provider',
  ];
  if (required.some((key) => !session[key]) || !PROVIDERS.has(session.provider)) {
    throw bridgeError('provider_session_invalid', 'provider session identity is incomplete');
  }
  for (const field of Object.values(session)) assertPublicValue(field);
  return session;
}

function providerSessionFailureStatus(errorCode) {
  switch (String(errorCode || '').trim().toLowerCase()) {
    case 'auth_required':
      return 'auth_required';
    case 'session_missing':
      return 'missing';
    case 'session_deleted':
      return 'deleted';
    case 'quota_exhausted':
      return 'quota_exhausted';
    default:
      return 'unavailable';
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requireOwner(scope) {
  if (scope.role !== 'owner') {
    throw bridgeError('ROLE_FORBIDDEN', 'Workspace owner role is required', 403);
  }
}

function publicCatalogRequest(row) {
  if (!row) return null;
  const response = row.response && typeof row.response === 'object' ? row.response : {};
  return {
    id: row.id,
    runnerId: row.runner_id,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    entries: Array.isArray(response.entries) ? response.entries : [],
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at || null,
  };
}

function publicProviderSession(row) {
  if (!row) return null;
  return normalizeProviderSession({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    runnerId: row.runner_id,
    missionId: row.mission_id,
    workConversationId: row.work_conversation_id,
    provider: row.provider,
    engine: row.engine,
    externalAgentId: row.external_agent_id,
    externalSessionId: row.external_session_id,
    status: row.status,
    title: row.title,
    lastErrorCode: row.last_error_code,
  });
}

async function withServiceTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const value = await fn(client);
    await client.query('commit');
    return value;
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

class ProviderAgentBridge {
  constructor({ pool, env = process.env } = {}) {
    if (!pool) throw new Error('ProviderAgentBridge requires pool');
    this.pool = pool;
    this.connectorLeaseMs = Math.max(
      1_000,
      Number.parseInt(String(env.RUNNER_CONNECTOR_LEASE_MS || '30000'), 10) || 30_000,
    );
  }

  async requestCatalog(scope, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    if (input.consent !== true) {
      throw bridgeError('connector_consent_required', 'Local catalog consent is required', 422);
    }
    const provider = text(input.provider, { max: 32 }).toLowerCase();
    if (!PROVIDERS.has(provider)) {
      throw bridgeError('provider_catalog_invalid', 'Unsupported provider catalog', 422);
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const runner = await client.query(
        `select id, connection_state
         from runners
         where workspace_id = $1 and id = $2 and status = 'active'
         limit 1`,
        [valid.workspaceId, text(input.runnerId, { max: 160 })],
      );
      if (!runner.rowCount) {
        throw bridgeError('runner_unavailable', 'Runner is unavailable', 404);
      }
      if (runner.rows[0].connection_state !== 'connected') {
        throw bridgeError('runner_offline', 'Runner is offline', 409);
      }
      const id = newId('connector');
      const inserted = await client.query(
        `insert into runner_connector_requests (
           id, workspace_id, runner_id, provider, kind, status, request
         ) values ($1,$2,$3,$4,'agent_catalog','pending',$5::jsonb)
         returning *`,
        [id, valid.workspaceId, runner.rows[0].id, provider, JSON.stringify({ consent: true })],
      );
      return publicCatalogRequest(inserted.rows[0]);
    });
  }

  async getCatalogRequest(scope, requestId) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select * from runner_connector_requests
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, text(requestId, { max: 160 })],
      );
      return result.rowCount ? publicCatalogRequest(result.rows[0]) : null;
    });
  }

  async importAgent(scope, requestId, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const request = await client.query(
        `select * from runner_connector_requests
         where workspace_id = $1 and id = $2 and status = 'completed'
         limit 1`,
        [valid.workspaceId, text(requestId, { max: 160 })],
      );
      if (!request.rowCount) {
        throw bridgeError('provider_catalog_unavailable', 'Provider catalog is unavailable', 404);
      }
      const response = request.rows[0].response && typeof request.rows[0].response === 'object'
        ? request.rows[0].response
        : {};
      const entries = normalizeCatalogResponse(request.rows[0].provider, response.entries || []);
      const externalAgentId = text(input.externalAgentId, { max: 160 });
      const entry = entries.find((item) => item.externalAgentId === externalAgentId);
      if (!entry) {
        throw bridgeError('provider_catalog_entry_missing', 'Provider catalog entry was not found', 404);
      }
      const duplicate = await client.query(
        `select id from agents
         where workspace_id = $1
           and lower(coalesce(payload->>'provider', '')) = lower($2)
           and coalesce(payload->>'externalAgentId', '') = $3
         limit 1`,
        [valid.workspaceId, entry.provider, entry.externalAgentId],
      );
      if (duplicate.rowCount) {
        throw new WorkspaceAgentDirectoryError(
          'agent_source_conflict',
          'This external agent is already connected to the Workspace',
          409,
        );
      }
      const id = newId('agent');
      const payload = normalizeWorkspaceAgent({
        displayName: input.displayName || entry.displayName,
        role: input.role || entry.description,
        responsibility: input.responsibility || entry.description,
        sourceKind: 'connected',
        provider: entry.provider,
        externalAgentId: entry.externalAgentId,
        defaultExecutionEngine: input.defaultExecutionEngine || entry.provider,
        defaultRunnerId: request.rows[0].runner_id,
      }, {
        id,
        workspaceId: valid.workspaceId,
      });
      await client.query(
        `insert into agents (id, payload, workspace_id) values ($1,$2::jsonb,$3)`,
        [id, JSON.stringify(payload), valid.workspaceId],
      );
      return payload;
    });
  }

  async requestSessionCatalog(scope, agentId, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    if (input.consent !== true) {
      throw bridgeError('connector_consent_required', 'Local session catalog consent is required', 422);
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const agent = await client.query(
        `select id, payload from agents
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, text(agentId, { max: 160 })],
      );
      if (!agent.rowCount) {
        throw bridgeError('agent_not_found', 'Agent was not found', 404);
      }
      const payload = agent.rows[0].payload && typeof agent.rows[0].payload === 'object'
        ? agent.rows[0].payload
        : {};
      const provider = text(payload.provider, { max: 32 }).toLowerCase();
      if (!PROVIDERS.has(provider)) {
        throw bridgeError('provider_catalog_invalid', 'Agent has no supported provider', 422);
      }
      const runnerId = text(input.runnerId || payload.defaultRunnerId, { max: 160 });
      if (payload.defaultRunnerId && payload.defaultRunnerId !== runnerId) {
        throw bridgeError('runner_scope_mismatch', 'Agent session catalog must use its configured Runner', 422);
      }
      const runner = await client.query(
        `select id, connection_state from runners
         where workspace_id = $1 and id = $2 and status = 'active'
         limit 1`,
        [valid.workspaceId, runnerId],
      );
      if (!runner.rowCount) {
        throw bridgeError('runner_unavailable', 'Runner is unavailable', 404);
      }
      if (runner.rows[0].connection_state !== 'connected') {
        throw bridgeError('runner_offline', 'Runner is offline', 409);
      }
      const id = newId('connector');
      const inserted = await client.query(
        `insert into runner_connector_requests (
           id, workspace_id, runner_id, provider, kind, status, request
         ) values ($1,$2,$3,$4,'session_catalog','pending',$5::jsonb)
         returning *`,
        [
          id,
          valid.workspaceId,
          runner.rows[0].id,
          provider,
          JSON.stringify({
            consent: true,
            agentId: agent.rows[0].id,
            externalAgentId: String(payload.externalAgentId || '').slice(0, 160),
          }),
        ],
      );
      return publicCatalogRequest(inserted.rows[0]);
    });
  }

  async importProviderSession(scope, agentId, requestId, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const agent = await client.query(
        `select id, payload from agents
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, text(agentId, { max: 160 })],
      );
      if (!agent.rowCount) {
        throw bridgeError('agent_not_found', 'Agent was not found', 404);
      }
      const request = await client.query(
        `select * from runner_connector_requests
         where workspace_id = $1 and id = $2
           and kind = 'session_catalog' and status = 'completed'
         limit 1`,
        [valid.workspaceId, text(requestId, { max: 160 })],
      );
      if (!request.rowCount) {
        throw bridgeError('provider_catalog_unavailable', 'Provider session catalog is unavailable', 404);
      }
      const requestPayload = request.rows[0].request && typeof request.rows[0].request === 'object'
        ? request.rows[0].request
        : {};
      if (requestPayload.agentId !== agent.rows[0].id) {
        throw bridgeError('provider_catalog_scope_mismatch', 'Provider session catalog belongs to another agent', 404);
      }
      const response = request.rows[0].response && typeof request.rows[0].response === 'object'
        ? request.rows[0].response
        : {};
      const entries = normalizeSessionCatalogResponse(request.rows[0].provider, response.entries || []);
      const externalSessionId = text(input.externalSessionId, { max: 200 });
      const entry = entries.find((item) => item.externalSessionId === externalSessionId);
      if (!entry) {
        throw bridgeError('provider_catalog_entry_missing', 'Provider session was not found', 404);
      }
      const duplicate = await client.query(
        `select id from provider_agent_sessions
         where workspace_id = $1 and provider = $2 and external_session_id = $3
         limit 1`,
        [valid.workspaceId, entry.provider, entry.externalSessionId],
      );
      if (duplicate.rowCount) {
        throw bridgeError('provider_session_conflict', 'Provider session is already connected', 409);
      }
      const missionId = newId('mission');
      const workConversationId = newId('session');
      const providerSessionId = newId('psess');
      const now = new Date().toISOString();
      const agentPayload = agent.rows[0].payload && typeof agent.rows[0].payload === 'object'
        ? agent.rows[0].payload
        : {};
      const missionPayload = {
        goal: entry.title,
        title: entry.title,
        objective: entry.title,
        agentId: agent.rows[0].id,
        status: 'accepted',
        executionEngine: entry.provider,
        resolvedEngine: entry.provider,
        resolvedExecutionEngine: entry.provider,
        engineReason: 'imported_provider_session',
        templateId: 'general-agent-work',
        deliverable: { kind: 'file', format: 'auto' },
        missionThreadId: workConversationId,
        workConversationId,
        providerSessionId,
        importedProviderSession: true,
        workspaceId: valid.workspaceId,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `insert into agent_missions (id, status, agent_id, report_due_at, payload, workspace_id)
         values ($1,'accepted',$2,'',$3::jsonb,$4)`,
        [missionId, agent.rows[0].id, JSON.stringify(missionPayload), valid.workspaceId],
      );
      await client.query(
        `insert into agent_sessions (id, mission_id, task_id, status, payload, workspace_id)
         values ($1,$2,'','accepted',$3::jsonb,$4)`,
        [
          workConversationId,
          missionId,
          JSON.stringify({
            missionThread: true,
            importedProviderSession: true,
            providerSessionId,
            workspaceId: valid.workspaceId,
          }),
          valid.workspaceId,
        ],
      );
      const updatedAt = Number.isNaN(Date.parse(entry.updatedAt)) ? now : new Date(entry.updatedAt).toISOString();
      const inserted = await client.query(
        `insert into provider_agent_sessions (
           id, workspace_id, agent_id, runner_id, work_conversation_id,
           provider, engine, external_agent_id, external_session_id,
           status, title, public_metadata, last_activity_at
         ) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,'active',$9,$10::jsonb,$11)
         returning *`,
        [
          providerSessionId,
          valid.workspaceId,
          agent.rows[0].id,
          request.rows[0].runner_id,
          workConversationId,
          entry.provider,
          String(agentPayload.externalAgentId || '').slice(0, 160),
          entry.externalSessionId,
          entry.title,
          JSON.stringify({
            sourceKind: entry.sourceKind,
            capability: entry.capability,
            importedAt: now,
          }),
          updatedAt,
        ],
      );
      await client.query(
        `insert into agent_session_events (
           id, session_id, sequence, kind, payload, workspace_id
         ) values ($1,$2,1,'progress',$3::jsonb,$4)`,
        [
          newId('evt'),
          workConversationId,
          JSON.stringify({
            text: '기존 provider 세션을 연결했습니다. 다음 메시지는 같은 provider 세션으로 전달됩니다.',
            phase: 'imported',
            checkpoint: true,
            resolvedExecutionEngine: entry.provider,
            createdAt: now,
          }),
          valid.workspaceId,
        ],
      );
      return {
        session: publicProviderSession({ ...inserted.rows[0], mission_id: missionId }),
        missionId,
        workConversationId,
      };
    });
  }

  async listSessions(scope, agentId, { search = '', archived = false } = {}) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select ps.*, s.mission_id
         from provider_agent_sessions ps
         inner join agent_sessions s
           on s.workspace_id = ps.workspace_id and s.id = ps.work_conversation_id
         where ps.workspace_id = $1 and ps.agent_id = $2
           and ($3::boolean = true or ps.archived_at is null)
           and ($4 = '' or lower(ps.title) like ('%' || lower($4) || '%'))
         order by ps.last_activity_at desc nulls last, ps.created_at desc`,
        [
          valid.workspaceId,
          text(agentId, { max: 160 }),
          archived === true,
          text(search, { max: 160 }),
        ],
      );
      return result.rows.map(publicProviderSession);
    });
  }

  async updateSession(scope, sessionId, patch = {}) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const status = patch.archived === true ? 'archived' : null;
      const result = await client.query(
        `with updated as (
           update provider_agent_sessions
           set title = case when $3 <> '' then $3 else title end,
               status = coalesce($4, status),
               archived_at = case when $4 = 'archived' then now() else archived_at end,
               updated_at = now()
           where workspace_id = $1 and id = $2
           returning *
         )
         select updated.*, s.mission_id
         from updated
         inner join agent_sessions s
           on s.workspace_id = updated.workspace_id and s.id = updated.work_conversation_id`,
        [
          valid.workspaceId,
          text(sessionId, { max: 160 }),
          text(patch.title, { max: 200 }),
          status,
        ],
      );
      return result.rowCount ? publicProviderSession(result.rows[0]) : null;
    });
  }

  async nextConnectorRequest(runnerRow) {
    if (!runnerRow || runnerRow.status !== 'active' || runnerRow.connection_state !== 'connected') {
      throw bridgeError('RUNNER_NOT_CONNECTED', 'Runner is not connected', 401);
    }
    return withServiceTransaction(this.pool, async (client) => {
      const result = await client.query(
        `select * from runner_connector_requests
         where workspace_id = $1 and runner_id = $2
           and expires_at > now()
           and (
             status = 'pending'
             or (
               status = 'running'
               and started_at < now() - ($3 * interval '1 millisecond')
             )
           )
         order by case when status = 'running' then 0 else 1 end, created_at asc
         for update skip locked
         limit 1`,
        [runnerRow.workspace_id, runnerRow.id, this.connectorLeaseMs],
      );
      if (!result.rowCount) return { ok: true, request: null };
      const row = result.rows[0];
      await client.query(
        `update runner_connector_requests
         set status = 'running', started_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2`,
        [runnerRow.workspace_id, row.id],
      );
      return {
        ok: true,
        request: {
          id: row.id,
          provider: row.provider,
          kind: row.kind,
          consent: row.request?.consent === true,
          externalAgentId: String(row.request?.externalAgentId || '').slice(0, 160),
          ...(AUTOMATION_CONNECTOR_KINDS.has(row.kind)
            ? {
              payload: row.request?.payload && typeof row.request.payload === 'object'
                ? row.request.payload
                : {},
            }
            : {}),
        },
      };
    });
  }

  async completeConnectorRequest(runnerRow, input = {}) {
    const requestId = text(input.requestId, { max: 160 });
    return withServiceTransaction(this.pool, async (client) => {
      const result = await client.query(
        `select * from runner_connector_requests
         where workspace_id = $1 and runner_id = $2 and id = $3
         for update`,
        [runnerRow.workspace_id, runnerRow.id, requestId],
      );
      if (!result.rowCount) {
        throw bridgeError('CONNECTOR_REQUEST_NOT_FOUND', 'Connector request was not found', 404);
      }
      const row = result.rows[0];
      if (!['pending', 'running'].includes(row.status)) {
        return { ok: true, replay: true, status: row.status };
      }
      const response = AUTOMATION_CONNECTOR_KINDS.has(row.kind)
        ? { result: normalizeAutomationConnectorResult(row.kind, input.result || {}) }
        : {
          entries: row.kind === 'session_catalog'
            ? normalizeSessionCatalogResponse(row.provider, input.entries || [])
            : normalizeCatalogResponse(row.provider, input.entries || []),
        };
      await client.query(
        `update runner_connector_requests
         set status = 'completed', response = $4::jsonb,
             terminal_at = now(), updated_at = now()
         where workspace_id = $1 and runner_id = $2 and id = $3`,
        [runnerRow.workspace_id, runnerRow.id, row.id, JSON.stringify(response)],
      );
      return { ok: true, status: 'completed', requestId: row.id };
    });
  }

  async failConnectorRequest(runnerRow, input = {}) {
    const errorCode = text(input.errorCode || 'connector_failed', { max: 64 });
    const errorMessage = text(input.errorMessage || 'Connector request failed', { max: 300 });
    assertPublicValue(errorCode);
    assertPublicValue(errorMessage);
    return withServiceTransaction(this.pool, async (client) => {
      const result = await client.query(
        `update runner_connector_requests
         set status = 'failed', error_code = $4, error_message = $5,
             terminal_at = now(), updated_at = now()
         where workspace_id = $1 and runner_id = $2 and id = $3
           and status in ('pending', 'running')
         returning id`,
        [
          runnerRow.workspace_id,
          runnerRow.id,
          text(input.requestId, { max: 160 }),
          errorCode,
          errorMessage,
        ],
      );
      if (!result.rowCount) {
        throw bridgeError('CONNECTOR_REQUEST_NOT_FOUND', 'Connector request was not found', 404);
      }
      return { ok: true, status: 'failed', requestId: result.rows[0].id };
    });
  }
}

module.exports = {
  normalizeCatalogResponse,
  normalizeSessionCatalogResponse,
  normalizeProviderSession,
  providerSessionFailureStatus,
  ProviderAgentBridge,
};
