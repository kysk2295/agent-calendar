'use strict';

const crypto = require('node:crypto');

const AUTOMATION_KINDS = new Set([
  'automation_capabilities',
  'automation_list',
  'automation_mutation',
]);
const AUTOMATION_RESULT_FIELDS = new Set([
  'list',
  'create',
  'update',
  'pause',
  'resume',
  'run',
  'delete',
  'triggers',
  'sessionReuse',
  'runHistory',
  'items',
  'occurrences',
  'cursor',
  'sourceRevision',
  'capabilities',
  'automation',
  'result',
]);
const PRIVATE_FIELD_PATTERN = /(api[_-]?key|authorization|cookie|credential|password|private|secret|token)/i;
const HOST_PATH_PATTERN = /(?:^|[\s"'=:])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\\\\[^\\\s]+\\)/;
const SECRET_VALUE_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const MAX_RESULT_BYTES = 128 * 1024;

function adapterError(code, message, statusHint = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function cleanText(value, max = 500) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > max) {
    throw adapterError('AUTOMATION_CONNECTOR_REQUEST_INVALID', 'automation connector value is too long', 422);
  }
  return normalized;
}

function assertPublicResult(value, depth = 0) {
  if (depth > 7) {
    throw adapterError('AUTOMATION_CONNECTOR_RESULT_INVALID', 'automation connector result is too deep', 422);
  }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 4_000 || HOST_PATH_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value)) {
      throw adapterError(
        'AUTOMATION_CONNECTOR_PRIVATE_DATA',
        'automation connector result contains private host data',
        422,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) {
      throw adapterError('AUTOMATION_CONNECTOR_RESULT_INVALID', 'automation connector result is too large', 422);
    }
    value.forEach((entry) => assertPublicResult(entry, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') {
    throw adapterError('AUTOMATION_CONNECTOR_RESULT_INVALID', 'automation connector result is invalid', 422);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_FIELD_PATTERN.test(key)) {
      throw adapterError(
        'AUTOMATION_CONNECTOR_PRIVATE_DATA',
        'automation connector result contains a private field',
        422,
      );
    }
    assertPublicResult(entry, depth + 1);
  }
}

function normalizeAutomationConnectorResult(kindValue, input) {
  const kind = String(kindValue || '');
  if (!AUTOMATION_KINDS.has(kind) || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw adapterError('AUTOMATION_CONNECTOR_RESULT_INVALID', 'automation connector result is invalid', 422);
  }
  for (const key of Object.keys(input)) {
    if (!AUTOMATION_RESULT_FIELDS.has(key) || PRIVATE_FIELD_PATTERN.test(key)) {
      throw adapterError(
        'AUTOMATION_CONNECTOR_PRIVATE_DATA',
        'automation connector result contains a non-public field',
        422,
      );
    }
  }
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
    throw adapterError('AUTOMATION_CONNECTOR_RESULT_INVALID', 'automation connector result is too large', 422);
  }
  assertPublicResult(input);
  return JSON.parse(encoded);
}

function mutationPayload(action, input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    action,
    externalId: cleanText(value.externalId, 200),
    name: cleanText(value.name, 200),
    goal: cleanText(value.goal, 4_000),
    agentId: cleanText(value.agentId, 200),
    schedule: cleanText(value.schedule, 500),
    expectedRevision: cleanText(value.expectedRevision, 200),
    idempotencyKey: cleanText(value.idempotencyKey, 200),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

class RunnerAutomationSourceAdapter {
  constructor({ pool, env = process.env, sleep } = {}) {
    if (!pool) throw new Error('RunnerAutomationSourceAdapter requires pool');
    this.pool = pool;
    this.timeoutMs = Math.max(
      250,
      Number(env.AUTOMATION_RUNNER_REQUEST_TIMEOUT_MS || 30_000),
    );
    this.pollMs = Math.max(5, Number(env.AUTOMATION_RUNNER_POLL_MS || 50));
    this.sleep = sleep || ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  }

  async capabilities(source) {
    return this.#dispatch(source, 'automation_capabilities', { action: 'capabilities' });
  }

  async list(source, cursor = '') {
    return this.#dispatch(source, 'automation_list', {
      action: 'list',
      cursor: cleanText(cursor, 500),
    });
  }

  async create(source, input = {}) {
    return this.#dispatch(source, 'automation_mutation', mutationPayload('create', input));
  }

  async update(source, input = {}) {
    return this.#dispatch(source, 'automation_mutation', mutationPayload('update', input));
  }

  async pause(source, input = {}) {
    return this.#dispatch(source, 'automation_mutation', mutationPayload('pause', input));
  }

  async resume(source, input = {}) {
    return this.#dispatch(source, 'automation_mutation', mutationPayload('resume', input));
  }

  async run(source, input = {}) {
    return this.#dispatch(source, 'automation_mutation', mutationPayload('run', input));
  }

  async #dispatch(source, kind, payload) {
    const workspaceId = cleanText(source?.workspaceId, 160);
    const runnerId = cleanText(source?.runnerId || source?.connectionRef?.runnerId, 160);
    const provider = cleanText(source?.adapterKind, 32).toLowerCase();
    if (!workspaceId || !runnerId || provider !== 'hermes') {
      throw adapterError(
        'AUTOMATION_RUNNER_SCOPE_INVALID',
        'automation source has no eligible Workspace Runner',
        422,
      );
    }
    const requestId = `automation_connector_${crypto.randomUUID()}`;
    const inserted = await this.pool.query(
      `insert into runner_connector_requests (
         id, workspace_id, runner_id, provider, kind, status, request, expires_at
       )
       select $1, r.workspace_id, r.id, $4, $5, 'pending', $6::jsonb,
              now() + ($7 * interval '1 millisecond')
       from runners r
       where r.workspace_id = $2 and r.id = $3
         and r.status = 'active' and r.connection_state = 'connected'
       returning id`,
      [
        requestId,
        workspaceId,
        runnerId,
        provider,
        kind,
        JSON.stringify({ consent: true, payload }),
        this.timeoutMs,
      ],
    );
    if (!inserted.rowCount) {
      throw adapterError('AUTOMATION_RUNNER_OFFLINE', 'Workspace Runner is offline', 409);
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.pool.query(
        `select status, response, error_code, error_message
         from runner_connector_requests
         where workspace_id = $1 and runner_id = $2 and id = $3
         limit 1`,
        [workspaceId, runnerId, requestId],
      );
      if (!result.rowCount) {
        throw adapterError('AUTOMATION_CONNECTOR_MISSING', 'automation connector request disappeared');
      }
      const row = result.rows[0];
      if (row.status === 'completed') {
        return normalizeAutomationConnectorResult(kind, row.response?.result || {});
      }
      if (row.status === 'failed') {
        const code = cleanText(row.error_code || 'AUTOMATION_SOURCE_FAILED', 64);
        throw adapterError(code, cleanText(row.error_message || 'automation source failed', 300));
      }
      if (row.status === 'cancelled') break;
      await this.sleep(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
    }
    await this.pool.query(
      `update runner_connector_requests
       set status = 'cancelled', terminal_at = now(), updated_at = now()
       where workspace_id = $1 and runner_id = $2 and id = $3
         and status in ('pending', 'running')`,
      [workspaceId, runnerId, requestId],
    );
    throw adapterError('SOURCE_TIMEOUT', 'Workspace Runner automation request timed out', 504);
  }
}

module.exports = {
  RunnerAutomationSourceAdapter,
  normalizeAutomationConnectorResult,
};
