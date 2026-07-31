'use strict';

const crypto = require('node:crypto');
const {
  agentExecutionProfile,
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  WorkspaceAgentDirectoryError,
} = require('./workspace-agent-directory');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { assertWorkspaceScope } = require('./workspace-scope');

const TEST_TIMEOUT_MIN_MS = 250;
const TEST_TIMEOUT_MAX_MS = 30_000;

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requireOwner(scope) {
  if (scope.role !== 'owner') {
    throw new WorkspaceAgentDirectoryError(
      'ROLE_FORBIDDEN',
      'Workspace owner role is required',
      403,
    );
  }
}

function requiredRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new WorkspaceAgentDirectoryError(
      'agent_builder_revision_invalid',
      'Agent builder revision is required',
    );
  }
  return revision;
}

function boundedTimeout(value) {
  const timeoutMs = Number(value === undefined ? TEST_TIMEOUT_MAX_MS : value);
  if (!Number.isSafeInteger(timeoutMs)
    || timeoutMs < TEST_TIMEOUT_MIN_MS || timeoutMs > TEST_TIMEOUT_MAX_MS) {
    throw new WorkspaceAgentDirectoryError(
      'agent_test_request_invalid',
      `Builder test timeout must be between ${TEST_TIMEOUT_MIN_MS} and ${TEST_TIMEOUT_MAX_MS} milliseconds`,
    );
  }
  return timeoutMs;
}

function publicTestRequest(row) {
  if (!row) return null;
  const payload = objectValue(objectValue(row.request).payload);
  const result = objectValue(objectValue(row.response).result);
  return {
    id: row.id,
    agentId: String(payload.agentId || ''),
    revision: Number(payload.revision || 0),
    runnerId: row.runner_id,
    provider: row.provider,
    status: row.status,
    passed: row.status === 'completed' ? result.passed === true : false,
    summary: String(result.summary || row.error_message || ''),
    durationMs: Number(result.durationMs || 0),
    errorCode: String(row.error_code || ''),
    createdAt: row.created_at,
    terminalAt: row.terminal_at || null,
  };
}

function generatedDisplayName(request) {
  const firstLine = String(request || '').split(/\r?\n/, 1)[0].trim();
  return (firstLine || 'Generated agent').slice(0, 80);
}

async function sideEffectCounts(client, workspaceId) {
  const result = await client.query(
    `select
       (select count(*)::int from calendar_events where workspace_id = $1) as calendar,
       (select count(*)::int from scheduler_jobs where workspace_id = $1) as scheduler_jobs,
       (
         select count(*)::int
         from work_conversation_channel_receipts
         where workspace_id = $1 and direction = 'outbound'
       ) as external_delivery`,
    [workspaceId],
  );
  const row = result.rows[0] || {};
  return {
    calendar: Number(row.calendar || 0),
    schedulerJobs: Number(row.scheduler_jobs || 0),
    externalDelivery: Number(row.external_delivery || 0),
  };
}

function sideEffectDelta(before, after) {
  return {
    calendar: Math.max(0, after.calendar - before.calendar),
    externalDelivery: Math.max(0, after.externalDelivery - before.externalDelivery),
    schedulerJobs: Math.max(0, after.schedulerJobs - before.schedulerJobs),
  };
}

async function lockAgent(client, workspaceId, agentId) {
  const result = await client.query(
    `select id, payload, workspace_id
     from agents
     where workspace_id = $1 and id = $2
     for update`,
    [workspaceId, String(agentId || '')],
  );
  if (!result.rowCount) return null;
  return {
    id: result.rows[0].id,
    ...objectValue(result.rows[0].payload),
    workspaceId: result.rows[0].workspace_id,
  };
}

async function persistAgent(client, workspaceId, agent) {
  await client.query(
    `update agents
     set payload = $3::jsonb, updated_at = now()
     where workspace_id = $1 and id = $2`,
    [workspaceId, agent.id, JSON.stringify(agent)],
  );
}

class WorkspaceAgentBuilderService {
  constructor({ pool } = {}) {
    if (!pool || typeof pool.query !== 'function') {
      throw new Error('WorkspaceAgentBuilderService requires a PostgreSQL pool');
    }
    this.pool = pool;
  }

  async createDraft(scope, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const request = String(input.request || '').trim();
      const id = newId('agent');
      const agent = normalizeWorkspaceAgent({
        displayName: input.displayName || generatedDisplayName(request),
        role: input.role || 'Generated agent draft',
        responsibility: input.responsibility || request,
        instructions: input.instructions || request,
        responseStyle: input.responseStyle || '',
        specialties: input.specialties,
        memories: input.memories,
        oneLineRequest: request,
        builderOrigin: 'one_line',
        defaultExecutionEngine: input.defaultExecutionEngine || 'auto',
        defaultRunnerId: input.defaultRunnerId || '',
        approvedGrants: { allow: [], deny: [] },
      }, {
        id,
        workspaceId: valid.workspaceId,
      });
      await client.query(
        `insert into agents (id, payload, workspace_id) values ($1, $2::jsonb, $3)`,
        [id, JSON.stringify(agent), valid.workspaceId],
      );
      return agent;
    });
  }

  async reviewDraft(scope, agentId, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    const expectedRevision = requiredRevision(input.expectedRevision);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const existing = await lockAgent(client, valid.workspaceId, agentId);
      if (!existing) return null;
      const agent = normalizeWorkspaceAgent({}, {
        id: existing.id,
        workspaceId: valid.workspaceId,
        existing,
        builderAction: { action: 'review', expectedRevision },
      });
      await persistAgent(client, valid.workspaceId, agent);
      return agent;
    });
  }

  async startTest(scope, agentId, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    const expectedRevision = requiredRevision(input.expectedRevision);
    const timeoutMs = boundedTimeout(input.timeoutMs);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const existing = await lockAgent(client, valid.workspaceId, agentId);
      if (!existing) return null;
      const runnerResult = await client.query(
        `select id, capabilities
         from runners
         where workspace_id = $1
           and status = 'active'
           and connection_state = 'connected'
           and ($2 = '' or id = $2)
         order by case when id = $2 then 0 else 1 end, last_seen_at desc nulls last, id asc
         limit 1`,
        [valid.workspaceId, existing.defaultRunnerId || ''],
      );
      if (!runnerResult.rowCount) {
        throw new WorkspaceAgentDirectoryError(
          'runner_unavailable',
          'A connected Workspace Runner is required for the builder test',
          409,
        );
      }
      const requestId = newId('builder_test');
      const baseline = await sideEffectCounts(client, valid.workspaceId);
      const engine = 'codex';
      const testing = normalizeWorkspaceAgent({}, {
        id: existing.id,
        workspaceId: valid.workspaceId,
        existing,
        builderAction: {
          action: 'test_started',
          expectedRevision,
          requestId,
          timeoutMs,
        },
      });
      await client.query(
        `insert into runner_connector_requests (
           id, workspace_id, runner_id, provider, kind, status, request, expires_at
         ) values (
           $1, $2, $3, $4, 'agent_builder_test', 'pending', $5::jsonb,
           now() + ($6 * interval '1 millisecond')
         )`,
        [
          requestId,
          valid.workspaceId,
          runnerResult.rows[0].id,
          engine,
          JSON.stringify({
            consent: true,
            payload: {
              agentId: existing.id,
              revision: expectedRevision,
              prompt: [
                `Name: ${testing.displayName}`,
                `Role: ${testing.role}`,
                `Responsibility: ${testing.responsibility}`,
                `Instructions: ${testing.instructions}`,
                'Produce one short sample response for explicit review.',
              ].join('\n').slice(0, 8_000),
              timeoutMs,
              baseline,
              policy: {
                disposable: true,
                defaultDeny: true,
                calendarProjection: false,
                externalDelivery: false,
              },
            },
          }),
          timeoutMs,
        ],
      );
      await persistAgent(client, valid.workspaceId, testing);
      return {
        agent: testing,
        request: {
          id: requestId,
          agentId: existing.id,
          revision: expectedRevision,
          runnerId: runnerResult.rows[0].id,
          provider: engine,
          status: 'pending',
          passed: false,
          summary: '',
          durationMs: 0,
          errorCode: '',
          createdAt: null,
          terminalAt: null,
        },
      };
    });
  }

  async getTest(scope, agentId, requestId) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const requestResult = await client.query(
        `select *
         from runner_connector_requests
         where workspace_id = $1 and id = $2 and kind = 'agent_builder_test'
           and request->'payload'->>'agentId' = $3
         for update`,
        [valid.workspaceId, String(requestId || ''), String(agentId || '')],
      );
      if (!requestResult.rowCount) return null;
      let row = requestResult.rows[0];
      if (['pending', 'running'].includes(row.status)
        && new Date(row.expires_at).getTime() <= Date.now()) {
        const timedOut = await client.query(
          `update runner_connector_requests
           set status = 'failed',
               error_code = 'AGENT_BUILDER_TEST_TIMEOUT',
               error_message = 'Disposable builder test timed out',
               terminal_at = now(),
               updated_at = now()
           where workspace_id = $1 and id = $2
           returning *`,
          [valid.workspaceId, row.id],
        );
        row = timedOut.rows[0];
      }
      const existing = await lockAgent(client, valid.workspaceId, agentId);
      if (!existing) return null;
      if (!['completed', 'failed', 'cancelled'].includes(row.status)
        || existing.lifecycle?.lastTest?.status !== 'running'
        || existing.lifecycle?.lastTest?.id !== row.id) {
        return { agent: projectWorkspaceAgent(existing), request: publicTestRequest(row) };
      }

      const requestPayload = objectValue(objectValue(row.request).payload);
      const baseline = objectValue(requestPayload.baseline);
      const currentCounts = await sideEffectCounts(client, valid.workspaceId);
      const delta = sideEffectDelta({
        calendar: Number(baseline.calendar || 0),
        schedulerJobs: Number(baseline.schedulerJobs || 0),
        externalDelivery: Number(baseline.externalDelivery || 0),
      }, currentCounts);
      const result = objectValue(objectValue(row.response).result);
      const hasSideEffect = Object.values(delta).some((count) => count !== 0);
      const status = row.status === 'cancelled'
        ? 'cancelled'
        : row.error_code === 'AGENT_BUILDER_TEST_TIMEOUT'
          ? 'timed_out'
          : row.status === 'completed' && result.passed === true && !hasSideEffect
            ? 'passed'
            : 'failed';
      const summary = hasSideEffect
        ? 'Disposable builder test changed a forbidden Workspace surface.'
        : String(result.summary || row.error_message || 'Disposable builder test failed').slice(0, 500);
      const agent = normalizeWorkspaceAgent({}, {
        id: existing.id,
        workspaceId: valid.workspaceId,
        existing,
        builderAction: {
          action: 'test_result',
          expectedRevision: Number(requestPayload.revision),
          requestId: row.id,
          status,
          summary,
          durationMs: Number(result.durationMs || 0),
          sideEffects: delta,
        },
      });
      await persistAgent(client, valid.workspaceId, agent);
      return { agent, request: { ...publicTestRequest(row), status, passed: status === 'passed', summary } };
    });
  }

  async cancelTest(scope, agentId, requestId) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `update runner_connector_requests
         set status = 'cancelled',
             error_code = 'AGENT_BUILDER_TEST_CANCELLED',
             error_message = 'Disposable builder test was cancelled',
             terminal_at = now(),
             updated_at = now()
         where workspace_id = $1 and id = $2 and kind = 'agent_builder_test'
           and request->'payload'->>'agentId' = $3
           and status in ('pending', 'running')
         returning *`,
        [valid.workspaceId, String(requestId || ''), String(agentId || '')],
      );
      if (!result.rowCount) {
        const current = await client.query(
          `select *
           from runner_connector_requests
           where workspace_id = $1 and id = $2 and kind = 'agent_builder_test'
             and request->'payload'->>'agentId' = $3`,
          [valid.workspaceId, String(requestId || ''), String(agentId || '')],
        );
        if (!current.rowCount) return null;
        const existing = await lockAgent(client, valid.workspaceId, agentId);
        if (!existing) return null;
        return { agent: projectWorkspaceAgent(existing), request: publicTestRequest(current.rows[0]) };
      }
      const existing = await lockAgent(client, valid.workspaceId, agentId);
      if (!existing) return null;
      const payload = objectValue(objectValue(result.rows[0].request).payload);
      const agent = normalizeWorkspaceAgent({}, {
        id: existing.id,
        workspaceId: valid.workspaceId,
        existing,
        builderAction: {
          action: 'test_result',
          expectedRevision: Number(payload.revision),
          requestId: result.rows[0].id,
          status: 'cancelled',
          summary: 'Disposable builder test was cancelled',
          durationMs: 0,
          sideEffects: { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
        },
      });
      await persistAgent(client, valid.workspaceId, agent);
      return { agent, request: publicTestRequest(result.rows[0]) };
    });
  }

  async activate(scope, agentId, input = {}) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    const expectedRevision = requiredRevision(input.expectedRevision);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const existing = await lockAgent(client, valid.workspaceId, agentId);
      if (!existing) return null;
      const agent = normalizeWorkspaceAgent({}, {
        id: existing.id,
        workspaceId: valid.workspaceId,
        existing,
        builderAction: {
          action: 'activate',
          expectedRevision,
          requestId: String(input.requestId || ''),
        },
      });
      const snapshot = agentExecutionProfile(agent);
      await client.query(
        `insert into agent_profile_versions (
           workspace_id, agent_id, profile_version, profile_snapshot, test_evidence, activated_at
         ) values ($1, $2, $3, $4::jsonb, $5::jsonb, now())
         on conflict (workspace_id, agent_id, profile_version) do nothing`,
        [
          valid.workspaceId,
          agent.id,
          agent.profileVersion,
          JSON.stringify(snapshot),
          JSON.stringify(agent.lifecycle.lastTest),
        ],
      );
      await persistAgent(client, valid.workspaceId, agent);
      return agent;
    });
  }

  async listVersions(scope, agentId) {
    assertWorkspaceScope(scope);
    requireOwner(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select profile_version, profile_snapshot, test_evidence, activated_at
         from agent_profile_versions
         where workspace_id = $1 and agent_id = $2
         order by profile_version desc`,
        [valid.workspaceId, String(agentId || '')],
      );
      const jobs = await client.query(
        `select id, name, payload
         from scheduler_jobs
         where workspace_id = $1
           and payload->'profileSnapshot'->>'agentId' = $2
         order by created_at asc, id asc`,
        [valid.workspaceId, String(agentId || '')],
      );
      return result.rows.map((row) => ({
        agentId: String(agentId || ''),
        profileVersion: Number(row.profile_version),
        profileSnapshot: objectValue(row.profile_snapshot),
        testEvidence: objectValue(row.test_evidence),
        activatedAt: row.activated_at,
        historicalJobs: jobs.rows
          .filter((job) => Number(objectValue(job.payload).profileSnapshot?.profileVersion)
            === Number(row.profile_version))
          .map((job) => ({
            id: job.id,
            name: job.name,
            profileVersion: Number(objectValue(job.payload).profileSnapshot?.profileVersion),
          })),
      }));
    });
  }
}

module.exports = {
  WorkspaceAgentBuilderService,
};
