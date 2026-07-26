'use strict';

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;
const SUPPORTED_OPERATIONS = new Set(['create', 'update', 'pause', 'resume', 'run']);
const SENSITIVE_CONNECTION_KEY = /credential|password|secret|token|api.?key/i;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function automationError(code, message, statusHint = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function requireOwner(scope) {
  assertWorkspaceScope(scope);
  if (String(scope.role || '').toLowerCase() !== 'owner') {
    throw automationError('ROLE_FORBIDDEN', 'owner role required', 403);
  }
}

function safeConnectionRef(input = {}, runnerId = '') {
  const raw = asObject(input);
  for (const key of Object.keys(raw)) {
    if (SENSITIVE_CONNECTION_KEY.test(key)) {
      throw automationError(
        'AUTOMATION_PROVIDER_CREDENTIAL_REJECTED',
        'provider credentials must remain on the Runner',
        400,
      );
    }
  }
  return {
    ...raw,
    runnerId,
    providerCredentialsStored: false,
    providerCredentialLocation: 'runner',
  };
}

function mapSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runnerId: row.runner_id || '',
    adapterKind: row.adapter_kind,
    displayName: row.display_name,
    status: row.status,
    capabilities: asObject(row.capabilities),
    connectionRef: asObject(row.connection_ref),
    sourceRevision: row.source_revision || '',
    lastSyncedAt: row.last_synced_at,
    staleAfter: row.stale_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAutomation(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    name: row.name,
    goal: row.goal || '',
    agentId: row.agent_id || '',
    schedule: row.schedule || '',
    status: row.status || 'unknown',
    enabled: row.enabled,
    sourceRevision: row.source_revision || '',
    capabilities: asObject(row.capabilities),
    projection: asObject(row.projection),
    lastSyncedAt: row.last_synced_at,
    staleAfter: row.stale_after,
    source: row.source_display_name
      ? {
        id: row.source_id,
        displayName: row.source_display_name,
        adapterKind: row.source_adapter_kind,
        status: row.source_status,
      }
      : undefined,
    lastReceipt: row.receipt_id
      ? {
        id: row.receipt_id,
        status: row.receipt_status,
        operation: row.receipt_operation,
        sourceRevision: row.receipt_source_revision || '',
        errorCode: row.receipt_error_code || '',
        errorMessage: row.receipt_error_message || '',
        createdAt: row.receipt_created_at,
      }
      : null,
  };
}

function mapOccurrence(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    automationId: row.automation_id,
    externalOccurrenceId: row.external_occurrence_id,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    sourceRevision: row.source_revision || '',
    result: asObject(row.result),
    lastSyncedAt: row.last_synced_at,
  };
}

function mapChange(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    automationId: row.automation_id || '',
    operation: row.operation,
    status: row.status,
    requestId: row.client_request_id,
    expectedRevision: row.expected_revision || '',
    input: asObject(row.input),
    policy: asObject(row.policy),
    approvedByUserId: row.approved_by_user_id || '',
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    changeId: row.change_id,
    sourceId: row.source_id,
    automationId: row.automation_id || '',
    operation: row.operation,
    status: row.status,
    sourceRevision: row.source_revision || '',
    externalId: row.external_id || '',
    result: asObject(row.result),
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
  };
}

function normalizedCapabilities(value) {
  const raw = asObject(value);
  return {
    list: raw.list === true,
    create: raw.create === true,
    update: raw.update === true,
    pause: raw.pause === true,
    resume: raw.resume === true,
    run: raw.run === true,
    delete: raw.delete === true,
    triggers: Array.isArray(raw.triggers) ? raw.triggers.map(String) : [],
    sessionReuse: raw.sessionReuse === true,
    runHistory: raw.runHistory === true,
  };
}

function normalizedStatus(value, enabled) {
  const status = String(value || '').trim().toLowerCase();
  if (enabled === false || ['paused', 'disabled', 'stopped'].includes(status)) return 'paused';
  if (['failed', 'error', 'blocked'].includes(status)) return 'failed';
  if (enabled === true || ['active', 'enabled', 'ready', 'running', 'scheduled'].includes(status)) {
    return 'active';
  }
  return 'unknown';
}

function normalizedAutomation(item, capabilities) {
  const source = asObject(item);
  const externalId = String(source.externalId || source.id || '').trim();
  if (!externalId) {
    throw automationError('AUTOMATION_EXTERNAL_ID_REQUIRED', 'source automation id required');
  }
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : null;
  return {
    externalId,
    name: String(source.name || source.title || '이름 없는 자동화').trim(),
    goal: String(source.goal || source.description || source.objective || '').trim(),
    agentId: String(source.agentId || source.agent || source.profile || '').trim(),
    schedule: String(source.schedule || source.scheduleDisplay || source.cron || '').trim(),
    status: normalizedStatus(source.status, enabled),
    enabled,
    revision: String(source.revision || source.sourceRevision || '').trim(),
    capabilities: normalizedCapabilities(source.capabilities || capabilities),
    projection: source,
  };
}

function normalizedOccurrence(item) {
  const source = asObject(item);
  const externalOccurrenceId = String(
    source.externalOccurrenceId || source.occurrenceId || source.id || '',
  ).trim();
  const automationExternalId = String(
    source.automationExternalId || source.automationId || '',
  ).trim();
  const scheduledAt = String(source.scheduledAt || source.startsAt || source.start || '').trim();
  if (!externalOccurrenceId || !automationExternalId || !scheduledAt) return null;
  return {
    externalOccurrenceId,
    automationExternalId,
    scheduledAt,
    startedAt: source.startedAt || null,
    finishedAt: source.finishedAt || source.endsAt || null,
    status: ['scheduled', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']
      .includes(String(source.status || '').toLowerCase())
      ? String(source.status).toLowerCase()
      : 'unknown',
    revision: String(source.revision || source.sourceRevision || ''),
    result: asObject(source.result),
  };
}

function changePolicy(input = {}) {
  const value = asObject(input);
  const reasons = [];
  if (value.newPermission === true || value.requiresNewPermission === true) {
    reasons.push('new_permission');
  }
  if (Number(value.estimatedAdditionalCost || 0) > 0) {
    reasons.push('additional_cost');
  }
  if (value.externalDelivery === true) {
    reasons.push('external_delivery');
  }
  return {
    required: reasons.length > 0,
    reasons,
    classification: reasons.length ? 'approval_required' : 'low_risk_authorized',
  };
}

class AutomationFederation {
  constructor({
    pool,
    adapters = {},
    clock = () => Date.now(),
    freshnessMs = DEFAULT_FRESHNESS_MS,
    env = process.env,
  } = {}) {
    if (!pool) throw new Error('AutomationFederation requires pool');
    this.pool = pool;
    this.adapters = { ...adapters };
    this.clock = clock;
    this.freshnessMs = freshnessMs;
    this.env = env;
  }

  async #run(scope, fn) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, fn);
  }

  #adapter(source) {
    const configured = this.adapters[source.adapterKind];
    const adapter = typeof configured === 'function' ? configured(source) : configured;
    if (!adapter) {
      throw automationError(
        'AUTOMATION_SOURCE_ADAPTER_UNAVAILABLE',
        `automation source adapter unavailable: ${source.adapterKind}`,
        503,
      );
    }
    return adapter;
  }

  async connectSource(scope, input = {}) {
    requireOwner(scope);
    if (/^(0|false|off|no)$/i.test(String(this.env.AUTOMATION_FEDERATION_ENABLED || '1'))) {
      throw automationError('AUTOMATION_FEDERATION_DISABLED', 'automation federation disabled', 503);
    }
    const adapterKind = String(input.adapterKind || '').trim();
    const displayName = String(input.displayName || '').trim();
    const runnerId = String(input.runnerId || '').trim();
    const requestId = String(input.requestId || '').trim();
    if (!adapterKind || !displayName || !runnerId) {
      throw automationError(
        'AUTOMATION_SOURCE_PARAMS_REQUIRED',
        'adapterKind, displayName, and runnerId are required',
      );
    }
    const replay = requestId
      ? await this.#run(scope, async (client, valid) => {
        const result = await client.query(
          `select * from automation_sources
           where workspace_id = $1 and connection_ref->>'requestId' = $2
           limit 1`,
          [valid.workspaceId, requestId],
        );
        return result.rowCount ? mapSource(result.rows[0]) : null;
      })
      : null;
    if (replay) return { ok: true, source: replay, replay: true };

    await this.#run(scope, async (client, valid) => {
      const runner = await client.query(
        `select id, status, connection_state, capabilities from runners
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, runnerId],
      );
      if (!runner.rowCount) {
        throw automationError('AUTOMATION_RUNNER_NOT_FOUND', 'same-Workspace Runner not found', 404);
      }
      if (
        runner.rows[0].status !== 'active'
        || !['connected', 'reconnecting'].includes(runner.rows[0].connection_state)
      ) {
        throw automationError('AUTOMATION_RUNNER_OFFLINE', 'Runner is not connected', 409);
      }
    });

    const sourceId = newId('automation_source');
    const connectionRef = safeConnectionRef(
      { ...asObject(input.connectionRef), ...(requestId ? { requestId } : {}) },
      runnerId,
    );
    const provisional = {
      id: sourceId,
      workspaceId: scope.workspaceId,
      runnerId,
      adapterKind,
      displayName,
      connectionRef,
    };
    const capabilities = normalizedCapabilities(
      await this.#adapter(provisional).capabilities(provisional),
    );
    if (!capabilities.list) {
      throw automationError(
        'AUTOMATION_CAPABILITY_UNSUPPORTED',
        'source does not support listing automations',
        409,
      );
    }
    const source = await this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `insert into automation_sources (
           id, workspace_id, runner_id, adapter_kind, display_name, status,
           capabilities, connection_ref, created_by_user_id
         ) values ($1, $2, $3, $4, $5, 'connected', $6::jsonb, $7::jsonb, $8)
         returning *`,
        [
          sourceId,
          valid.workspaceId,
          runnerId,
          adapterKind,
          displayName,
          JSON.stringify(capabilities),
          JSON.stringify(connectionRef),
          valid.userId,
        ],
      );
      return mapSource(result.rows[0]);
    });
    return { ok: true, source, replay: false };
  }

  async listSources(scope) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select * from automation_sources
         where workspace_id = $1
         order by created_at asc`,
        [valid.workspaceId],
      );
      return {
        ok: true,
        sources: result.rows.map(mapSource),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async #getSource(scope, sourceId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select * from automation_sources
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, String(sourceId || '')],
      );
      return result.rowCount ? mapSource(result.rows[0]) : null;
    });
  }

  async synchronize(scope, sourceId) {
    requireOwner(scope);
    const source = await this.#getSource(scope, sourceId);
    if (!source) throw automationError('AUTOMATION_SOURCE_NOT_FOUND', 'source not found', 404);
    const adapter = this.#adapter(source);
    const cursor = await this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select cursor from automation_sync_cursors
         where workspace_id = $1 and source_id = $2
         limit 1`,
        [valid.workspaceId, source.id],
      );
      return result.rowCount ? result.rows[0].cursor : '';
    });
    let page;
    try {
      page = await adapter.list(source, cursor);
    } catch (error) {
      await this.#run(scope, async (client, valid) => {
        await client.query(
          `update automation_sources
           set status = 'stale', updated_at = now()
           where workspace_id = $1 and id = $2`,
          [valid.workspaceId, source.id],
        );
        await client.query(
          `insert into automation_sync_cursors (
             id, workspace_id, source_id, cursor, last_attempt_at,
             last_error_code, last_error_message
           ) values ($1, $2, $3, $4, now(), $5, $6)
           on conflict (workspace_id, source_id) do update
           set last_attempt_at = now(),
               last_error_code = excluded.last_error_code,
               last_error_message = excluded.last_error_message,
               updated_at = now()`,
          [
            newId('automation_cursor'),
            valid.workspaceId,
            source.id,
            cursor,
            String(error.code || 'SOURCE_SYNC_FAILED'),
            String(error.message || error).slice(0, 500),
          ],
        );
      });
      throw error;
    }
    const capabilities = normalizedCapabilities(page.capabilities || source.capabilities);
    const automations = (Array.isArray(page.items) ? page.items : [])
      .map((item) => normalizedAutomation(item, capabilities));
    const occurrences = (Array.isArray(page.occurrences) ? page.occurrences : [])
      .map(normalizedOccurrence)
      .filter(Boolean);
    const now = new Date(this.clock());
    const staleAfter = new Date(now.getTime() + this.freshnessMs);
    const persisted = await this.#run(scope, async (client, valid) => {
      const byExternalId = new Map();
      for (const item of automations) {
        const id = newId('connected_automation');
        const result = await client.query(
          `insert into connected_automations (
             id, workspace_id, source_id, external_id, name, goal, agent_id,
             schedule, status, enabled, source_revision, capabilities, projection,
             last_synced_at, stale_after
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
             $13::jsonb, $14, $15
           )
           on conflict (workspace_id, source_id, external_id) do update
           set name = excluded.name,
               goal = case
                 when btrim(excluded.goal) <> '' then excluded.goal
                 else connected_automations.goal
               end,
               agent_id = case
                 when btrim(excluded.agent_id) <> '' then excluded.agent_id
                 else connected_automations.agent_id
               end,
               schedule = excluded.schedule,
               status = excluded.status,
               enabled = excluded.enabled,
               source_revision = excluded.source_revision,
               capabilities = excluded.capabilities,
               projection = excluded.projection,
               last_synced_at = excluded.last_synced_at,
               stale_after = excluded.stale_after,
               updated_at = now()
           returning *`,
          [
            id,
            valid.workspaceId,
            source.id,
            item.externalId,
            item.name,
            item.goal,
            item.agentId,
            item.schedule,
            item.status,
            item.enabled,
            item.revision,
            JSON.stringify(item.capabilities),
            JSON.stringify(item.projection),
            now,
            staleAfter,
          ],
        );
        byExternalId.set(item.externalId, mapAutomation(result.rows[0]));
      }
      const persistedOccurrences = [];
      for (const item of occurrences) {
        const automation = byExternalId.get(item.automationExternalId);
        if (!automation) continue;
        const result = await client.query(
          `insert into automation_occurrences (
             id, workspace_id, source_id, automation_id, external_occurrence_id,
             scheduled_at, started_at, finished_at, status, source_revision,
             result, last_synced_at
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12
           )
           on conflict (workspace_id, source_id, external_occurrence_id) do update
           set automation_id = excluded.automation_id,
               scheduled_at = excluded.scheduled_at,
               started_at = excluded.started_at,
               finished_at = excluded.finished_at,
               status = excluded.status,
               source_revision = excluded.source_revision,
               result = excluded.result,
               last_synced_at = excluded.last_synced_at,
               updated_at = now()
           returning *`,
          [
            newId('automation_occurrence'),
            valid.workspaceId,
            source.id,
            automation.id,
            item.externalOccurrenceId,
            item.scheduledAt,
            item.startedAt,
            item.finishedAt,
            item.status,
            item.revision,
            JSON.stringify(item.result),
            now,
          ],
        );
        persistedOccurrences.push(mapOccurrence(result.rows[0]));
      }
      await client.query(
        `update automation_sources
         set status = 'connected',
             capabilities = $3::jsonb,
             source_revision = $4,
             last_synced_at = $5,
             stale_after = $6,
             updated_at = now()
         where workspace_id = $1 and id = $2`,
        [
          valid.workspaceId,
          source.id,
          JSON.stringify(capabilities),
          String(page.sourceRevision || ''),
          now,
          staleAfter,
        ],
      );
      await client.query(
        `insert into automation_sync_cursors (
           id, workspace_id, source_id, cursor, source_revision,
           last_attempt_at, last_success_at
         ) values ($1, $2, $3, $4, $5, $6, $6)
         on conflict (workspace_id, source_id) do update
         set cursor = excluded.cursor,
             source_revision = excluded.source_revision,
             last_attempt_at = excluded.last_attempt_at,
             last_success_at = excluded.last_success_at,
             last_error_code = '',
             last_error_message = '',
             updated_at = now()`,
        [
          newId('automation_cursor'),
          valid.workspaceId,
          source.id,
          String(page.cursor || ''),
          String(page.sourceRevision || ''),
          now,
        ],
      );
      return {
        automations: [...byExternalId.values()],
        occurrences: persistedOccurrences,
      };
    });
    return {
      ok: true,
      source: await this.#getSource(scope, source.id),
      automations: persisted.automations,
      occurrences: persisted.occurrences,
      cursor: String(page.cursor || ''),
    };
  }

  async listAutomations(scope, { sourceId = '' } = {}) {
    return this.#run(scope, async (client, valid) => {
      const values = [valid.workspaceId];
      const filter = sourceId ? 'and a.source_id = $2' : '';
      if (sourceId) values.push(String(sourceId));
      const result = await client.query(
        `select a.*,
                s.display_name as source_display_name,
                s.adapter_kind as source_adapter_kind,
                s.status as source_status,
                r.id as receipt_id,
                r.status as receipt_status,
                r.operation as receipt_operation,
                r.source_revision as receipt_source_revision,
                r.error_code as receipt_error_code,
                r.error_message as receipt_error_message,
                r.created_at as receipt_created_at
         from connected_automations a
         join automation_sources s
           on s.workspace_id = a.workspace_id and s.id = a.source_id
         left join lateral (
           select *
           from automation_change_receipts receipt
           where receipt.workspace_id = a.workspace_id
             and receipt.automation_id = a.id
           order by receipt.created_at desc
           limit 1
         ) r on true
         where a.workspace_id = $1 ${filter}
         order by a.name asc, a.id asc`,
        values,
      );
      return {
        ok: true,
        automations: result.rows.map(mapAutomation),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async listOccurrences(scope, { from = '', to = '', automationId = '' } = {}) {
    return this.#run(scope, async (client, valid) => {
      const values = [valid.workspaceId];
      const clauses = [];
      if (from) {
        values.push(from);
        clauses.push(`o.scheduled_at >= $${values.length}::timestamptz`);
      }
      if (to) {
        values.push(to);
        clauses.push(`o.scheduled_at < $${values.length}::timestamptz`);
      }
      if (automationId) {
        values.push(automationId);
        clauses.push(`o.automation_id = $${values.length}`);
      }
      const result = await client.query(
        `select o.*
         from automation_occurrences o
         where o.workspace_id = $1
           ${clauses.length ? `and ${clauses.join(' and ')}` : ''}
         order by o.scheduled_at asc, o.id asc`,
        values,
      );
      return {
        ok: true,
        occurrences: result.rows.map(mapOccurrence),
        workspaceId: valid.workspaceId,
      };
    });
  }

  async requestChange(scope, input = {}) {
    requireOwner(scope);
    if (/^(0|false|off|no)$/i.test(String(this.env.AUTOMATION_WRITES_ENABLED || '1'))) {
      throw automationError('AUTOMATION_WRITES_DISABLED', 'automation writes disabled', 503);
    }
    const sourceId = String(input.sourceId || '').trim();
    const operation = String(input.operation || '').trim().toLowerCase();
    const requestId = String(input.requestId || '').trim();
    const automationId = String(input.automationId || '').trim();
    if (!sourceId || !SUPPORTED_OPERATIONS.has(operation) || !requestId) {
      throw automationError(
        'AUTOMATION_CHANGE_PARAMS_REQUIRED',
        'sourceId, supported operation, and requestId are required',
      );
    }
    const replay = await this.#readChangeByRequest(scope, requestId);
    if (replay) return replay;
    const source = await this.#getSource(scope, sourceId);
    if (!source) throw automationError('AUTOMATION_SOURCE_NOT_FOUND', 'source not found', 404);
    const capability = source.capabilities[operation] === true;
    if (!capability) {
      throw automationError(
        'AUTOMATION_CAPABILITY_UNSUPPORTED',
        `source does not support ${operation}`,
        409,
      );
    }
    const automation = automationId
      ? await this.#getAutomation(scope, automationId)
      : null;
    if (automationId && (!automation || automation.sourceId !== source.id)) {
      throw automationError('CONNECTED_AUTOMATION_NOT_FOUND', 'automation not found', 404);
    }
    if (operation !== 'create' && !automation) {
      throw automationError('CONNECTED_AUTOMATION_REQUIRED', 'automationId required', 400);
    }
    const policy = changePolicy(input.input);
    const change = await this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `insert into automation_changes (
           id, workspace_id, source_id, automation_id, operation, status,
           client_request_id, expected_revision, input, policy, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
         returning *`,
        [
          newId('automation_change'),
          valid.workspaceId,
          source.id,
          automation?.id || null,
          operation,
          policy.required ? 'pending_approval' : 'pending',
          requestId,
          String(input.expectedRevision || ''),
          JSON.stringify(asObject(input.input)),
          JSON.stringify(policy),
          valid.userId,
        ],
      );
      return mapChange(result.rows[0]);
    });
    if (policy.required) {
      return {
        ok: true,
        change,
        approvalGate: policy,
        receipt: null,
        automation,
      };
    }
    return this.#applyChange(scope, change.id);
  }

  async approveChange(scope, changeId) {
    requireOwner(scope);
    const existing = await this.#readChange(scope, changeId);
    if (!existing) throw automationError('AUTOMATION_CHANGE_NOT_FOUND', 'change not found', 404);
    if (existing.receipt) return existing;
    if (existing.change.status !== 'pending_approval') {
      throw automationError('AUTOMATION_CHANGE_NOT_APPROVABLE', 'change is not awaiting approval', 409);
    }
    await this.#run(scope, async (client, valid) => {
      await client.query(
        `update automation_changes
         set status = 'pending',
             approved_by_user_id = $3,
             approved_at = now(),
             updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, existing.change.id, valid.userId],
      );
    });
    return this.#applyChange(scope, existing.change.id);
  }

  async #getAutomation(scope, automationId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select * from connected_automations
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, String(automationId || '')],
      );
      return result.rowCount ? mapAutomation(result.rows[0]) : null;
    });
  }

  async #readChangeByRequest(scope, requestId) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `select id from automation_changes
         where workspace_id = $1 and client_request_id = $2
         limit 1`,
        [valid.workspaceId, String(requestId || '')],
      );
      if (!result.rowCount) return null;
      return this.#readChangeRows(client, valid, result.rows[0].id);
    });
  }

  async #readChange(scope, changeId) {
    return this.#run(scope, (client, valid) => (
      this.#readChangeRows(client, valid, String(changeId || ''))
    ));
  }

  async #readChangeRows(client, scope, changeId) {
    const changeResult = await client.query(
      `select * from automation_changes
       where workspace_id = $1 and id = $2
       limit 1`,
      [scope.workspaceId, changeId],
    );
    if (!changeResult.rowCount) return null;
    const receiptResult = await client.query(
      `select * from automation_change_receipts
       where workspace_id = $1 and change_id = $2
       limit 1`,
      [scope.workspaceId, changeId],
    );
    const automationId = receiptResult.rows[0]?.automation_id || changeResult.rows[0].automation_id;
    const automationResult = automationId
      ? await client.query(
        `select * from connected_automations
         where workspace_id = $1 and id = $2
         limit 1`,
        [scope.workspaceId, automationId],
      )
      : { rowCount: 0, rows: [] };
    const change = mapChange(changeResult.rows[0]);
    return {
      ok: true,
      change,
      approvalGate: change.status === 'pending_approval'
        ? { ...change.policy, required: true }
        : null,
      receipt: receiptResult.rowCount ? mapReceipt(receiptResult.rows[0]) : null,
      automation: automationResult.rowCount ? mapAutomation(automationResult.rows[0]) : null,
    };
  }

  async #applyChange(scope, changeId) {
    const bundle = await this.#readChange(scope, changeId);
    if (!bundle) throw automationError('AUTOMATION_CHANGE_NOT_FOUND', 'change not found', 404);
    if (bundle.receipt) return bundle;
    const source = await this.#getSource(scope, bundle.change.sourceId);
    if (!source) throw automationError('AUTOMATION_SOURCE_NOT_FOUND', 'source not found', 404);
    const adapter = this.#adapter(source);
    const operation = bundle.change.operation;
    const automation = bundle.change.automationId
      ? await this.#getAutomation(scope, bundle.change.automationId)
      : null;
    const adapterInput = {
      ...bundle.change.input,
      ...(automation ? {
        externalId: automation.externalId,
        automation,
      } : {}),
      expectedRevision: bundle.change.expectedRevision || automation?.sourceRevision || '',
      idempotencyKey: bundle.change.requestId,
      enabled: operation === 'create' ? false : bundle.change.input.enabled,
    };
    await this.#run(scope, async (client, valid) => {
      await client.query(
        `update automation_changes
         set status = 'applying', updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, bundle.change.id],
      );
    });

    let sourceResult;
    try {
      sourceResult = await adapter[operation](source, adapterInput);
    } catch (error) {
      const code = String(error.code || 'AUTOMATION_SOURCE_FAILED');
      const status = code === 'SOURCE_TIMEOUT'
        ? 'unknown'
        : code === 'SOURCE_REVISION_CONFLICT'
          ? 'conflict'
          : 'failed';
      return this.#persistReceipt(scope, {
        change: bundle.change,
        status,
        sourceRevision: String(error.currentRevision || ''),
        automation,
        errorCode: code,
        errorMessage: String(error.message || error),
        result: error.currentAutomation ? { currentAutomation: error.currentAutomation } : {},
      });
    }
    const normalized = sourceResult?.automation
      ? normalizedAutomation(sourceResult.automation, source.capabilities)
      : automation
        ? {
          ...automation,
          revision: String(sourceResult?.sourceRevision || automation.sourceRevision),
        }
        : null;
    const persistedAutomation = normalized
      ? await this.#upsertAutomation(scope, source, normalized)
      : automation;
    if (sourceResult?.run && persistedAutomation) {
      const run = normalizedOccurrence(sourceResult.run);
      if (run) await this.#upsertOccurrence(scope, source.id, persistedAutomation.id, run);
    }
    return this.#persistReceipt(scope, {
      change: bundle.change,
      status: 'succeeded',
      sourceRevision: String(
        sourceResult?.sourceRevision || persistedAutomation?.sourceRevision || '',
      ),
      automation: persistedAutomation,
      externalId: persistedAutomation?.externalId || '',
      result: asObject(sourceResult),
    });
  }

  async #upsertAutomation(scope, source, item) {
    const normalized = item.externalId ? item : normalizedAutomation(item, source.capabilities);
    const now = new Date(this.clock());
    const staleAfter = new Date(now.getTime() + this.freshnessMs);
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `insert into connected_automations (
           id, workspace_id, source_id, external_id, name, goal, agent_id,
           schedule, status, enabled, source_revision, capabilities, projection,
           last_synced_at, stale_after
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
           $13::jsonb, $14, $15
         )
         on conflict (workspace_id, source_id, external_id) do update
         set name = excluded.name,
             goal = case
               when btrim(excluded.goal) <> '' then excluded.goal
               else connected_automations.goal
             end,
             agent_id = case
               when btrim(excluded.agent_id) <> '' then excluded.agent_id
               else connected_automations.agent_id
             end,
             schedule = excluded.schedule,
             status = excluded.status,
             enabled = excluded.enabled,
             source_revision = excluded.source_revision,
             capabilities = excluded.capabilities,
             projection = excluded.projection,
             last_synced_at = excluded.last_synced_at,
             stale_after = excluded.stale_after,
             updated_at = now()
         returning *`,
        [
          newId('connected_automation'),
          valid.workspaceId,
          source.id,
          normalized.externalId,
          normalized.name,
          normalized.goal || '',
          normalized.agentId || '',
          normalized.schedule || '',
          normalizedStatus(normalized.status, normalized.enabled),
          typeof normalized.enabled === 'boolean' ? normalized.enabled : null,
          normalized.revision || normalized.sourceRevision || '',
          JSON.stringify(normalized.capabilities || source.capabilities),
          JSON.stringify(normalized.projection || normalized),
          now,
          staleAfter,
        ],
      );
      return mapAutomation(result.rows[0]);
    });
  }

  async #upsertOccurrence(scope, sourceId, automationId, item) {
    return this.#run(scope, async (client, valid) => {
      const result = await client.query(
        `insert into automation_occurrences (
           id, workspace_id, source_id, automation_id, external_occurrence_id,
           scheduled_at, started_at, finished_at, status, source_revision,
           result, last_synced_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now()
         )
         on conflict (workspace_id, source_id, external_occurrence_id) do update
         set automation_id = excluded.automation_id,
             scheduled_at = excluded.scheduled_at,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             status = excluded.status,
             source_revision = excluded.source_revision,
             result = excluded.result,
             last_synced_at = now(),
             updated_at = now()
         returning *`,
        [
          newId('automation_occurrence'),
          valid.workspaceId,
          sourceId,
          automationId,
          item.externalOccurrenceId,
          item.scheduledAt,
          item.startedAt,
          item.finishedAt,
          item.status,
          item.revision,
          JSON.stringify(item.result),
        ],
      );
      return mapOccurrence(result.rows[0]);
    });
  }

  async #persistReceipt(scope, {
    change,
    status,
    sourceRevision = '',
    automation = null,
    externalId = '',
    result = {},
    errorCode = '',
    errorMessage = '',
  }) {
    await this.#run(scope, async (client, valid) => {
      await client.query(
        `update automation_changes
         set status = $3,
             automation_id = coalesce($4, automation_id),
             completed_at = now(),
             updated_at = now()
         where workspace_id = $1 and id = $2`,
        [valid.workspaceId, change.id, status, automation?.id || null],
      );
      await client.query(
        `insert into automation_change_receipts (
           id, workspace_id, change_id, source_id, automation_id, operation,
           status, source_revision, external_id, result, error_code, error_message
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12
         )
         on conflict (workspace_id, change_id) do nothing`,
        [
          newId('automation_receipt'),
          valid.workspaceId,
          change.id,
          change.sourceId,
          automation?.id || null,
          change.operation,
          status,
          sourceRevision,
          externalId || automation?.externalId || '',
          JSON.stringify(result),
          errorCode,
          String(errorMessage || '').slice(0, 500),
        ],
      );
    });
    return this.#readChange(scope, change.id);
  }
}

module.exports = {
  AutomationFederation,
  automationError,
  changePolicy,
  normalizedCapabilities,
  normalizedOccurrence,
  normalizedAutomation,
  safeConnectionRef,
};
