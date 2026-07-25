'use strict';

/**
 * Phase 3 Durable Execution coordinator.
 * Authoritative state is PostgreSQL only (offers, leases, events, outbox).
 * User paths (accept/cancel) use app-role + Workspace RLS.
 * Device paths use service-owned pool and derive Workspace from verified runner only.
 */

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const {
  engineCapabilityReady,
  engineReportsAvailability,
} = require('./engine-capability-auth');
const { providerSessionFailureStatus } = require('./provider-agent-session-bridge');

const OFFER_TTL_MS = 30_000;
const LEASE_TTL_MS = 120_000;
const MAX_ATTEMPTS_DEFAULT = 5;
const BACKOFF_BASE_MS = 2_000;
const REAPER_INTERVAL_MS = 5_000;
const OUTBOX_DRAIN_INTERVAL_MS = 2_000;
const OUTBOX_MAX_ATTEMPTS = 8;

const BANNED_PROVIDER_SECRET_KEYS = Object.freeze([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'HERMES_API_KEY',
  'apiKey', 'api_key', 'authorization', 'password', 'secret', 'token',
]);

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function reject(code, message, statusHint = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  throw error;
}

function claimsEnabled(env = process.env) {
  const raw = env.DURABLE_EXECUTION_CLAIMS_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw));
}

function redactSecrets(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/sk-[a-zA-Z0-9]{10,}/.test(value) || /Bearer\s+\S+/i.test(value)) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (BANNED_PROVIDER_SECRET_KEYS.some((b) => k.toLowerCase().includes(b.toLowerCase()))) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function assertNoProviderSecrets(payload) {
  const raw = JSON.stringify(payload || {});
  for (const key of BANNED_PROVIDER_SECRET_KEYS) {
    if (new RegExp(`"${key}"\\s*:\\s*"(?!\\[redacted\\])[^"]+`, 'i').test(raw)) {
      reject('PROVIDER_SECRET_FORBIDDEN', 'provider secrets must not enter control plane', 400);
    }
  }
  if (/sk-[a-zA-Z0-9]{20,}/.test(raw)) {
    reject('PROVIDER_SECRET_FORBIDDEN', 'provider secrets must not enter control plane', 400);
  }
}

function isPublicResolvedEngine(value) {
  return ['hermes', 'codex', 'claude', 'grok', 'fake'].includes(String(value || '').toLowerCase());
}

function shouldProjectJobToCalendar(payload) {
  return !(payload && typeof payload === 'object' && !Array.isArray(payload)
    && ['calendar_ai_conversation', 'workspace_inference'].includes(payload.kind));
}

async function projectAgentWorkCalendarState(client, {
  workspaceId,
  projectionKey,
  jobId,
  missionId,
  sessionId,
  goal,
  lifecycleStatus,
  occurredAt,
  turnIndex = 1,
  providerSessionId = '',
  attemptId = '',
  reportId = '',
  resultSummary = '',
  failureCode = '',
} = {}) {
  if (!workspaceId || !projectionKey || !jobId || !missionId || !sessionId) return null;
  const eventId = `cal_${projectionKey}`;
  const existing = await client.query(
    `select starts_at from calendar_events
     where workspace_id = $1 and id = $2
     limit 1`,
    [workspaceId, eventId],
  );
  const nowIso = new Date(occurredAt || Date.now()).toISOString();
  const startsAtIso = existing.rowCount
    ? new Date(existing.rows[0].starts_at).toISOString()
    : nowIso;
  const startMs = Date.parse(startsAtIso);
  const terminal = ['completed', 'failed', 'cancelled'].includes(lifecycleStatus);
  const occurredMs = Date.parse(nowIso);
  const endsAtIso = new Date(
    terminal
      ? Math.max(startMs + 60_000, occurredMs)
      : startMs + 60 * 60 * 1000,
  ).toISOString();
  const title = `Agent work: ${String(goal || 'Work').slice(0, 120)}`;
  const payload = {
    source: 'agent-work',
    lifecycleStatus,
    status: lifecycleStatus,
    missionId,
    sessionId,
    jobId,
    turnIndex: Math.max(1, Number(turnIndex) || 1),
    providerSessionId,
    attemptId,
    reportId,
    projectionKey,
    resultSummary,
    failureCode,
    date: startsAtIso.slice(0, 10),
    time: startsAtIso.slice(11, 16),
    startsAt: startsAtIso,
    endsAt: endsAtIso,
    updatedAt: nowIso,
  };
  await client.query(
    `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
     values ($1, null, $2, $3::timestamptz, $4::jsonb, $5)
     on conflict (id) do update set
       title = excluded.title,
       payload = excluded.payload,
       updated_at = now()`,
    [eventId, title, startsAtIso, JSON.stringify(payload), workspaceId],
  );
  return eventId;
}

function phaseToCheckpointKind(phase) {
  const p = String(phase || '').toLowerCase();
  if (p === 'plan') return 'plan';
  if (p === 'progress' || p === 'leased' || p === 'retry' || p === 'accepted') return 'progress';
  if (p === 'artifact') return 'artifact';
  if (p === 'result' || p === 'completed') return 'completion';
  if (p === 'failed' || p === 'cancel' || p === 'cancelling') return 'error';
  return 'agent_message';
}

function providerSessionProjection(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    engine: row.engine,
    externalAgentId: row.external_agent_id || '',
    externalSessionId: row.external_session_id || '',
    status: row.status,
    title: row.title || '',
  };
}

/** Service-owned transaction (device path; table owner, bypasses app least-privilege). */
async function withServiceTransaction(pool, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    if (pool && typeof pool.query === 'function') {
      await pool.query('begin');
      try {
        const result = await fn(pool);
        await pool.query('commit');
        return result;
      } catch (error) {
        try { await pool.query('rollback'); } catch { /* ignore */ }
        throw error;
      }
    }
    reject('EXEC_POOL_REQUIRED', 'pool required', 503);
  }
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('begin');
    const result = await fn(client);
    if (!client.__durableCommitted) {
      await client.query('commit');
      committed = true;
    } else {
      committed = true;
    }
    return result;
  } catch (error) {
    if (!committed && !client.__durableCommitted) {
      try { await client.query('rollback'); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

function resolveEngine(requested, capabilities = {}) {
  const req = String(requested || 'auto').toLowerCase() || 'auto';
  const engines = (capabilities && capabilities.engines) || capabilities || {};
  const order = ['codex', 'claude', 'grok', 'hermes'];
  const available = (name) => engineCapabilityReady(engines[name]);
  const knowledgeAvailable = capabilities.localKnowledge === true
    || capabilities.knowledgeSearch === true
    || engines.localKnowledge === true
    || engines.knowledgeSearch === true;

  if (req === 'knowledge') {
    return knowledgeAvailable
      ? { requested: req, resolved: 'knowledge', reason: 'runner_local_knowledge' }
      : { requested: req, resolved: '', reason: 'knowledge_search_unavailable' };
  }

  if (req === 'auto' || req === 'automatic') {
    for (const name of order) {
      if (available(name)) {
        return { requested: 'auto', resolved: name, reason: `auto_selected_first_authenticated:${name}` };
      }
    }
    if (available('fake')) {
      return { requested: 'auto', resolved: 'fake', reason: 'auto_selected_fake' };
    }
    return { requested: 'auto', resolved: '', reason: 'no_eligible_engine' };
  }

  if (!order.includes(req) && req !== 'fake') {
    return { requested: req, resolved: '', reason: 'unknown_engine' };
  }
  if (!available(req)) {
    if (engineReportsAvailability(engines[req])) {
      return { requested: req, resolved: '', reason: `engine_auth_required:${req}` };
    }
    return { requested: req, resolved: '', reason: `engine_unavailable:${req}` };
  }
  return { requested: req, resolved: req, reason: 'explicit' };
}

class DurableExecution {
  constructor({
    pool,
    clock = () => Date.now(),
    offerTtlMs = OFFER_TTL_MS,
    leaseTtlMs = LEASE_TTL_MS,
    env = process.env,
    sseHub = null,
    outboxHandler = null,
  } = {}) {
    if (!pool) throw new Error('DurableExecution requires pool');
    this.pool = pool;
    this.clock = clock;
    this.offerTtlMs = offerTtlMs;
    this.leaseTtlMs = leaseTtlMs;
    this.env = env;
    this.sseHub = sseHub;
    // Real outbox handler: default publishes job completion to Workspace SSE when hub present.
    this.outboxHandler = typeof outboxHandler === 'function'
      ? outboxHandler
      : (sseHub ? this.#defaultOutboxHandler.bind(this) : null);
    this.#reaperTimer = null;
    this.#outboxTimer = null;
  }

  #reaperTimer;
  #outboxTimer;

  #defaultOutboxHandler(row) {
    if (!this.sseHub || typeof this.sseHub.publishWorkspace !== 'function') {
      const err = new Error('outbox_handler_not_configured');
      err.code = 'OUTBOX_NOT_CONFIGURED';
      throw err;
    }
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    this.sseHub.publishWorkspace(row.workspace_id, 'agent-operations', {
      type: row.event_type || 'job.completed',
      jobId: row.job_id,
      workspaceId: row.workspace_id,
      ...payload,
    });
    return { ok: true };
  }

  /**
   * Start bounded reaper + outbox drain (service-owned). Safe to call once per process.
   */
  startBackgroundWorkers({ reaperIntervalMs = REAPER_INTERVAL_MS, outboxIntervalMs = OUTBOX_DRAIN_INTERVAL_MS } = {}) {
    if (!this.#reaperTimer) {
      this.#reaperTimer = setInterval(() => {
        this.reap().catch(() => undefined);
      }, reaperIntervalMs);
      if (typeof this.#reaperTimer.unref === 'function') this.#reaperTimer.unref();
    }
    if (!this.#outboxTimer) {
      this.#outboxTimer = setInterval(() => {
        this.drainOutbox({ limit: 25 }).catch(() => undefined);
      }, outboxIntervalMs);
      if (typeof this.#outboxTimer.unref === 'function') this.#outboxTimer.unref();
    }
    return { ok: true, reaper: true, outbox: true };
  }

  stopBackgroundWorkers() {
    if (this.#reaperTimer) {
      clearInterval(this.#reaperTimer);
      this.#reaperTimer = null;
    }
    if (this.#outboxTimer) {
      clearInterval(this.#outboxTimer);
      this.#outboxTimer = null;
    }
  }

  /**
   * Accept Delegated Work via app-role + Workspace RLS (user path).
   * Does not insert service-only outbox/offers/attempts.
   */
  async acceptWork(scope, input = {}) {
    assertWorkspaceScope(scope);
    const goal = String(input.goal || input.title || input.text || 'Delegated work').slice(0, 4000);
    const agentId = String(input.agentId || input.agent || 'default').slice(0, 120);
    const requestedEngineInput = String(input.executionEngine || input.engine || 'auto').toLowerCase() || 'auto';
    const clientRequestId = input.clientRequestId ? String(input.clientRequestId) : null;
    const missionId = String(input.missionId || input.id || newId('mission'));
    const sessionId = String(input.sessionId || newId('session'));
    const jobId = newId('job');
    const projectionKey = `proj:${missionId}`;
    const now = new Date(this.clock()).toISOString();
    const title = String(input.title || goal).slice(0, 300);
    const deliverable = input.deliverable && typeof input.deliverable === 'object'
      ? input.deliverable
      : { kind: 'file', format: 'auto' };
    const inputPayload = input.payload && typeof input.payload === 'object'
      && !Array.isArray(input.payload)
      ? input.payload
      : {};
    const hiddenSystemWork = ['calendar_ai_conversation', 'workspace_inference']
      .includes(inputPayload.kind);

    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      let directoryAgent = null;
      if (agentId && agentId !== 'default') {
        const agentResult = await client.query(
          `select id, payload from agents
           where workspace_id = $1 and id = $2
           limit 1`,
          [valid.workspaceId, agentId],
        );
        directoryAgent = agentResult.rowCount
          ? (agentResult.rows[0].payload || {})
          : null;
      }
      const agentDefaultEngine = String(directoryAgent?.defaultExecutionEngine || 'auto').toLowerCase();
      const requestedEngine = requestedEngineInput === 'auto' && agentDefaultEngine !== 'auto'
        ? agentDefaultEngine
        : requestedEngineInput;

      // preferredRunnerId: only same-Workspace active runners; ignore foreign/stale ids (never stall).
      let preferredRunnerId = input.preferredRunnerId || input.runnerId
        || directoryAgent?.defaultRunnerId || null;
      if (preferredRunnerId) {
        preferredRunnerId = String(preferredRunnerId);
        const pref = await client.query(
          `select id from runners
           where workspace_id = $1 and id = $2 and status = 'active'
           limit 1`,
          [valid.workspaceId, preferredRunnerId],
        );
        if (!pref.rowCount) preferredRunnerId = null;
      }

      const runners = await client.query(
        `select id, connection_state, capabilities, status
         from runners
         where workspace_id = $1 and status = 'active'
         order by last_seen_at desc nulls last`,
        [valid.workspaceId],
      );
      const connected = runners.rows.filter((r) => r.connection_state === 'connected');
      let status = 'waiting_runner';
      let resolved = { requested: requestedEngine, resolved: '', reason: 'waiting_runner' };
      let selectedRunner = null;
      if (connected.length) {
        const preferredConnected = preferredRunnerId
          ? connected.find((r) => r.id === preferredRunnerId)
          : null;
        const pick = preferredConnected || connected[0];
        selectedRunner = pick;
        const caps = pick.capabilities || {};
        resolved = resolveEngine(requestedEngine, caps);
        if (resolved.resolved) status = 'accepted';
        else status = 'waiting_runner';
      }
      if (!selectedRunner && preferredRunnerId) {
        selectedRunner = runners.rows.find((runner) => runner.id === preferredRunnerId) || null;
      }
      const providerEngine = ['codex', 'claude', 'grok', 'hermes'].includes(resolved.resolved)
        ? resolved.resolved
        : (['codex', 'claude', 'grok', 'hermes'].includes(requestedEngine) ? requestedEngine : '');
      const provider = ['codex', 'claude', 'grok', 'hermes'].includes(
        String(directoryAgent?.provider || '').toLowerCase(),
      )
        ? String(directoryAgent.provider).toLowerCase()
        : providerEngine;
      const providerSessionId = directoryAgent && selectedRunner && providerEngine && provider
        ? newId('psess')
        : null;

      const missionPayload = {
        goal,
        title,
        objective: goal,
        agentId,
        status,
        executionEngine: requestedEngine,
        resolvedEngine: resolved.resolved || '',
        ...(isPublicResolvedEngine(resolved.resolved)
          ? { resolvedExecutionEngine: resolved.resolved }
          : {}),
        engineReason: resolved.reason,
        clientRequestId,
        templateId: String(input.templateId || 'general-agent-work'),
        deliverable,
        missionThreadId: sessionId,
        workConversationId: sessionId,
        ...(providerSessionId ? { providerSessionId } : {}),
        ...(hiddenSystemWork
          ? { hiddenFromAgentWork: true, systemKind: inputPayload.kind }
          : {}),
        workspaceId: valid.workspaceId,
        jobId,
        createdAt: now,
        updatedAt: now,
      };

      await client.query(
        `insert into agent_missions (id, status, agent_id, report_due_at, payload, workspace_id)
         values ($1, $2, $3, '', $4::jsonb, $5)`,
        [missionId, status, agentId, JSON.stringify(missionPayload), valid.workspaceId],
      );
      await client.query(
        `insert into agent_sessions (id, mission_id, task_id, status, payload, workspace_id)
         values ($1, $2, '', $3, $4::jsonb, $5)`,
        [
          sessionId,
          missionId,
          status,
          JSON.stringify({
            missionThread: true,
            workspaceId: valid.workspaceId,
            jobId,
            ...(hiddenSystemWork
              ? { hiddenFromAgentWork: true, systemKind: inputPayload.kind }
              : {}),
          }),
          valid.workspaceId,
        ],
      );
      if (providerSessionId) {
        await client.query(
          `insert into provider_agent_sessions (
             id, workspace_id, agent_id, runner_id, work_conversation_id,
             provider, engine, external_agent_id, status, title, last_activity_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,now())`,
          [
            providerSessionId,
            valid.workspaceId,
            agentId,
            selectedRunner.id,
            sessionId,
            provider,
            providerEngine,
            String(directoryAgent.externalAgentId || '').slice(0, 160),
            title,
          ],
        );
      }

      const acceptText = status === 'waiting_runner'
        ? 'Work accepted and queued. Waiting for an eligible Workspace Runner to connect. waiting_runner'
        : 'Work accepted and queued for durable execution on a Workspace Runner. accepted';
      const eventId = newId('evt');
      await client.query(
        `insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id)
         values ($1, $2, 1, 'agent_message', $3::jsonb, $4)`,
        [
          eventId,
          sessionId,
          JSON.stringify({
            text: acceptText,
            status,
            checkpoint: true,
            phase: 'accepted',
            requestedEngine,
            resolvedEngine: resolved.resolved,
            engineReason: resolved.reason,
            sessionId,
            kind: 'agent_message',
            createdAt: now,
          }),
          valid.workspaceId,
        ],
      );

      await client.query(
        `insert into execution_jobs (
           id, workspace_id, mission_id, session_id, requested_engine, resolved_engine, engine_reason,
           preferred_runner_id, status, goal, payload, available_at, max_attempts, projection_key,
           turn_index, provider_session_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now(), $12, $13, 1, $14)`,
        [
          jobId,
          valid.workspaceId,
          missionId,
          sessionId,
          requestedEngine,
          resolved.resolved || '',
          resolved.reason,
          preferredRunnerId,
          status,
          goal,
          JSON.stringify(redactSecrets({
            agentId,
            clientRequestId,
            title,
            ...(providerSessionId ? { providerSessionId } : {}),
            // Spread system payload kinds (e.g. knowledge_search) at top level for protocol adapters.
            ...(input.payload && typeof input.payload === 'object' ? redactSecrets(input.payload) : {}),
            input: redactSecrets(input.payload || {}),
          })),
          MAX_ATTEMPTS_DEFAULT,
          projectionKey,
          providerSessionId,
        ],
      );
      if (!hiddenSystemWork) {
        await projectAgentWorkCalendarState(client, {
          workspaceId: valid.workspaceId,
          projectionKey,
          jobId,
          missionId,
          sessionId,
          goal,
          lifecycleStatus: 'scheduled',
          occurredAt: now,
          providerSessionId: providerSessionId || '',
        });
      }

      const work = {
        id: missionId,
        templateId: String(input.templateId || 'general-agent-work'),
        title,
        objective: goal,
        status: 'active',
        agentId,
        assignmentReason: agentId && agentId !== 'default' ? `explicit:${agentId}` : 'default:official',
        executionEngine: requestedEngine === 'automatic' ? 'auto' : requestedEngine,
        ...(isPublicResolvedEngine(resolved.resolved)
          ? { resolvedExecutionEngine: resolved.resolved, resolvedEngine: resolved.resolved }
          : {}),
        deliverable,
        missionThreadId: sessionId,
        workConversationId: sessionId,
        ...(providerSessionId ? { providerSessionId } : {}),
        revisionCounter: 0,
        createdAt: now,
        updatedAt: now,
      };
      const conversation = {
        id: sessionId,
        missionId,
        type: 'mission-thread',
        title,
        status: 'planning',
        pendingInstructions: [],
        executionEngine: work.executionEngine,
        deliverable,
        createdAt: now,
        updatedAt: now,
      };
      const message = {
        id: eventId,
        sessionId,
        sequence: 1,
        kind: 'agent_message',
        text: acceptText,
        createdAt: now,
        metadata: {
          applicationMode: 'mission_context',
          phase: 'accepted',
          jobStatus: status,
        },
      };

      return {
        ok: true,
        work,
        conversation,
        message,
        idempotentReplay: false,
        missionId,
        sessionId,
        jobId,
        status,
        waitingRunner: status === 'waiting_runner',
        requestedEngine,
        resolvedEngine: resolved.resolved || null,
        engineReason: resolved.reason,
        workspaceId: valid.workspaceId,
        mission: {
          id: missionId,
          status: 'active',
          agentId,
          goal,
          title,
          workspaceId: valid.workspaceId,
          executionEngine: work.executionEngine,
        },
      };
    });
  }

  async requestCancel(scope, missionId) {
    assertWorkspaceScope(scope);
    // App-role path: jobs + session events only (cannot mutate offers).
    const result = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const job = await client.query(
        `select * from execution_jobs
         where workspace_id = $1 and mission_id = $2
         for update`,
        [valid.workspaceId, String(missionId || '')],
      );
      if (!job.rowCount) return null;
      const row = job.rows[0];
      if (['completed', 'cancelled', 'dead_letter'].includes(row.status)) {
        return { ok: true, status: row.status, jobId: row.id, replay: true, withdrawOffers: false };
      }
      await client.query(
        `update execution_jobs
         set cancellation_requested = true,
             updated_at = now(),
             last_error_code = 'cancellation_requested',
             last_error_message = 'user cancel'
         where id = $1 and workspace_id = $2`,
        [row.id, valid.workspaceId],
      );

      // Not yet leased: terminal-cancel job immediately (offers withdrawn via service path).
      if (row.status === 'offered' || row.status === 'accepted' || row.status === 'waiting_runner') {
        await client.query(
          `update execution_jobs
           set status = 'cancelled', terminal_at = now(), updated_at = now()
           where id = $1 and workspace_id = $2`,
          [row.id, valid.workspaceId],
        );
        await this.#appendSessionCheckpoint(client, {
          workspaceId: valid.workspaceId,
          sessionId: row.session_id,
          text: 'Cancellation applied; open offers will be withdrawn',
          status: 'cancelled',
          phase: 'cancel',
        });
        return {
          ok: true,
          status: 'cancelled',
          jobId: row.id,
          workspaceId: valid.workspaceId,
          withdrawOffers: true,
        };
      }

      // Leased/running: flag only; Runner heartbeats and cancel-acks.
      await this.#appendSessionCheckpoint(client, {
        workspaceId: valid.workspaceId,
        sessionId: row.session_id,
        text: 'Cancellation requested',
        status: 'cancelling',
        phase: 'cancel',
      });
      return {
        ok: true,
        status: 'cancellation_requested',
        jobId: row.id,
        workspaceId: valid.workspaceId,
        withdrawOffers: false,
      };
    });

    if (result && result.withdrawOffers && result.jobId) {
      await withServiceTransaction(this.pool, async (client) => {
        await client.query(
          `update execution_offers set status = 'withdrawn'
           where workspace_id = $1 and job_id = $2 and status = 'open'`,
          [result.workspaceId, result.jobId],
        );
      });
      return { ...result, withdrawnOffers: true };
    }
    return result;
  }

  async nextOffer(runnerRow) {
    if (!claimsEnabled(this.env)) {
      return { ok: true, offer: null, reason: 'claims_disabled' };
    }
    if (!runnerRow || runnerRow.status !== 'active' || runnerRow.connection_state !== 'connected') {
      reject('RUNNER_NOT_CONNECTED', 'runner not connected', 401);
    }

    const now = this.clock();
    return withServiceTransaction(this.pool, async (client) => {
      await this.#reapExpired(client, runnerRow.workspace_id, now);

      const jobResult = await client.query(
        `select * from execution_jobs
         where workspace_id = $1
           and status in ('accepted', 'waiting_runner')
           and cancellation_requested = false
           and available_at <= now()
           and attempt_count < max_attempts
           and (preferred_runner_id is null or preferred_runner_id = $2)
         order by available_at asc
         for update skip locked
         limit 1`,
        [runnerRow.workspace_id, runnerRow.id],
      );
      if (!jobResult.rowCount) {
        return { ok: true, offer: null };
      }
      const job = jobResult.rows[0];
      let providerSession = null;
      if (job.provider_session_id) {
        const providerResult = await client.query(
          `select * from provider_agent_sessions
           where workspace_id = $1 and id = $2 and runner_id = $3
           limit 1`,
          [runnerRow.workspace_id, job.provider_session_id, runnerRow.id],
        );
        if (!providerResult.rowCount) {
          await client.query(
            `update execution_jobs
             set status = 'waiting_runner', engine_reason = 'provider_session_unavailable', updated_at = now()
             where workspace_id = $1 and id = $2`,
            [runnerRow.workspace_id, job.id],
          );
          return { ok: true, offer: null, reason: 'provider_session_unavailable' };
        }
        providerSession = providerSessionProjection(providerResult.rows[0]);
        if (['auth_required', 'missing', 'deleted', 'quota_exhausted', 'archived'].includes(providerSession.status)) {
          await client.query(
            `update execution_jobs
             set status = 'waiting_runner', engine_reason = $3, updated_at = now()
             where workspace_id = $1 and id = $2`,
            [runnerRow.workspace_id, job.id, `provider_session_${providerSession.status}`],
          );
          return { ok: true, offer: null, reason: `provider_session_${providerSession.status}` };
        }
      }

      const caps = runnerRow.capabilities || {};
      const resolved = resolveEngine(job.requested_engine, caps);
      if (!resolved.resolved) {
        await client.query(
          `update execution_jobs
           set status = 'waiting_runner',
               engine_reason = $1,
               updated_at = now()
           where id = $2 and workspace_id = $3`,
          [resolved.reason, job.id, job.workspace_id],
        );
        return { ok: true, offer: null, reason: resolved.reason };
      }

      const offerId = newId('offer');
      const expiresAt = new Date(now + this.offerTtlMs).toISOString();
      await client.query(
        `insert into execution_offers (id, workspace_id, job_id, runner_id, status, expires_at)
         values ($1, $2, $3, $4, 'open', $5::timestamptz)`,
        [offerId, job.workspace_id, job.id, runnerRow.id, expiresAt],
      );
      await client.query(
        `update execution_jobs
         set status = 'offered',
             resolved_engine = $1,
             engine_reason = $2,
             updated_at = now()
         where id = $3 and workspace_id = $4`,
        [resolved.resolved, resolved.reason, job.id, job.workspace_id],
      );

      return {
        ok: true,
        offer: {
          offerId,
          jobId: job.id,
          missionId: job.mission_id,
          sessionId: job.session_id,
          goal: job.goal,
          requestedEngine: job.requested_engine,
          resolvedEngine: resolved.resolved,
          engineReason: resolved.reason,
          expiresAt,
          workspaceId: job.workspace_id,
          // Redacted job payload (knowledge_search kind, query metadata — never provider secrets).
          payload: job.payload && typeof job.payload === 'object' ? job.payload : {},
          ...(providerSession ? { providerSession } : {}),
        },
      };
    });
  }

  async leaseOffer(runnerRow, { offerId } = {}) {
    if (!claimsEnabled(this.env)) reject('CLAIMS_DISABLED', 'claims disabled', 403);
    const id = String(offerId || '').trim();
    if (!id) reject('OFFER_ID_REQUIRED', 'offerId required', 400);

    const now = this.clock();
    return withServiceTransaction(this.pool, async (client) => {
      const offerResult = await client.query(
        `select o.*, j.attempt_count, j.max_attempts, j.requested_engine, j.goal, j.mission_id, j.session_id,
                j.status as job_status, j.cancellation_requested, j.provider_session_id,
                j.projection_key, j.payload, j.turn_index
         from execution_offers o
         inner join execution_jobs j on j.id = o.job_id and j.workspace_id = o.workspace_id
         where o.id = $1 and o.workspace_id = $2
         for update of o, j`,
        [id, runnerRow.workspace_id],
      );
      if (!offerResult.rowCount) reject('OFFER_NOT_FOUND', 'offer not found', 404);
      const offer = offerResult.rows[0];
      if (offer.runner_id !== runnerRow.id) reject('OFFER_FOREIGN_RUNNER', 'offer not for this runner', 403);
      if (runnerRow.status === 'revoked') reject('RUNNER_REVOKED', 'runner revoked', 401);
      if (offer.status !== 'open') reject('OFFER_NOT_OPEN', 'offer not open', 409);
      if (new Date(offer.expires_at).getTime() <= now) {
        // Persist expiry + requeue, commit, then reject so the write is not rolled back.
        await client.query(
          `update execution_offers set status = 'expired' where id = $1 and workspace_id = $2`,
          [id, runnerRow.workspace_id],
        );
        await client.query(
          `update execution_jobs
           set status = 'accepted', available_at = now(), updated_at = now()
           where id = $1 and workspace_id = $2 and status = 'offered'`,
          [offer.job_id, runnerRow.workspace_id],
        );
        await client.query('commit');
        client.__durableCommitted = true;
        reject('OFFER_EXPIRED', 'offer expired', 409);
      }
      if (offer.cancellation_requested) reject('JOB_CANCELLED', 'job cancelled', 409);

      const caps = runnerRow.capabilities || {};
      const resolved = resolveEngine(offer.requested_engine, caps);
      if (!resolved.resolved) reject('ENGINE_INELIGIBLE', resolved.reason, 409);
      let providerSession = null;
      if (offer.provider_session_id) {
        const providerResult = await client.query(
          `select * from provider_agent_sessions
           where workspace_id = $1 and id = $2 and runner_id = $3
           for update`,
          [runnerRow.workspace_id, offer.provider_session_id, runnerRow.id],
        );
        if (!providerResult.rowCount) {
          reject('PROVIDER_SESSION_UNAVAILABLE', 'Provider session is unavailable', 409);
        }
        providerSession = providerSessionProjection(providerResult.rows[0]);
        if (['auth_required', 'missing', 'deleted', 'quota_exhausted', 'archived'].includes(providerSession.status)) {
          reject(
            `PROVIDER_SESSION_${providerSession.status.toUpperCase()}`,
            `Provider session is ${providerSession.status}`,
            409,
          );
        }
      }

      // Monotonic lease epoch from locked attempt_count (not Date.now).
      const attemptNumber = Number(offer.attempt_count || 0) + 1;
      if (attemptNumber > Number(offer.max_attempts || MAX_ATTEMPTS_DEFAULT)) {
        await client.query(
          `update execution_jobs set status = 'dead_letter', updated_at = now() where id = $1`,
          [offer.job_id],
        );
        reject('MAX_ATTEMPTS', 'dead letter', 409);
      }
      const leaseEpoch = attemptNumber;
      const attemptId = newId('att');
      const leaseExpires = new Date(now + this.leaseTtlMs).toISOString();

      await client.query(`update execution_offers set status = 'accepted' where id = $1`, [id]);
      await client.query(
        `insert into execution_attempts (
           id, workspace_id, job_id, runner_id, offer_id, attempt_number, lease_epoch,
           status, engine, lease_expires_at
         ) values ($1,$2,$3,$4,$5,$6,$7,'leased',$8,$9::timestamptz)`,
        [
          attemptId,
          runnerRow.workspace_id,
          offer.job_id,
          runnerRow.id,
          id,
          attemptNumber,
          leaseEpoch,
          resolved.resolved,
          leaseExpires,
        ],
      );
      await client.query(
        `update execution_jobs
         set status = 'leased',
             attempt_count = $1,
             resolved_engine = $2,
             engine_reason = $3,
             updated_at = now()
         where id = $4 and workspace_id = $5`,
        [attemptNumber, resolved.resolved, resolved.reason, offer.job_id, runnerRow.workspace_id],
      );

      await this.#persistMissionResolvedEngine(client, {
        workspaceId: runnerRow.workspace_id,
        missionId: offer.mission_id,
        resolvedEngine: resolved.resolved,
      });

      await this.#appendSessionCheckpoint(client, {
        workspaceId: runnerRow.workspace_id,
        sessionId: offer.session_id,
        text: `Runner leased attempt ${attemptNumber} with engine ${resolved.resolved}`,
        status: 'leased',
        phase: 'leased',
        attemptId,
        engine: resolved.resolved,
      });
      if (shouldProjectJobToCalendar(offer.payload)) {
        await projectAgentWorkCalendarState(client, {
          workspaceId: runnerRow.workspace_id,
          projectionKey: offer.projection_key,
          jobId: offer.job_id,
          missionId: offer.mission_id,
          sessionId: offer.session_id,
          goal: offer.goal,
          lifecycleStatus: 'running',
          occurredAt: new Date(this.clock()).toISOString(),
          turnIndex: offer.turn_index,
          providerSessionId: offer.provider_session_id || '',
          attemptId,
        });
      }

      return {
        ok: true,
        lease: {
          attemptId,
          jobId: offer.job_id,
          missionId: offer.mission_id,
          sessionId: offer.session_id,
          attemptNumber,
          leaseEpoch,
          leaseExpiresAt: leaseExpires,
          engine: resolved.resolved,
          goal: offer.goal,
          workspaceId: runnerRow.workspace_id,
          ...(providerSession ? { providerSession } : {}),
        },
      };
    });
  }

  async postEvent(runnerRow, {
    attemptId,
    leaseEpoch,
    kind = 'checkpoint',
    text = '',
    phase = '',
    idempotencyKey = '',
    payload = {},
  } = {}) {
    assertNoProviderSecrets(payload);
    const safePayload = redactSecrets({
      ...payload,
      text: String(text || payload.text || '').slice(0, 8000),
      phase: phase || payload.phase || kind,
      kind,
    });

    return withServiceTransaction(this.pool, async (client) => {
      const att = await this.#lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {});
      const key = String(idempotencyKey || `${kind}:${safePayload.phase}:${safePayload.text}`).slice(0, 200);

      const existing = await client.query(
        `select id, sequence, payload from execution_events
         where workspace_id = $1 and job_id = $2 and idempotency_key = $3
         limit 1`,
        [att.workspace_id, att.job_id, key],
      );
      if (existing.rowCount) {
        return {
          ok: true,
          replay: true,
          event: {
            id: existing.rows[0].id,
            sequence: Number(existing.rows[0].sequence),
            payload: existing.rows[0].payload,
          },
        };
      }

      // Sequence under locked job row (already FOR UPDATE via lockLiveAttempt).
      const seqRow = await client.query(
        `select coalesce(max(sequence), 0)::bigint as seq
         from execution_events where workspace_id = $1 and job_id = $2`,
        [att.workspace_id, att.job_id],
      );
      const sequence = Number(seqRow.rows[0].seq) + 1;
      const eventId = newId('exev');
      await client.query(
        `insert into execution_events
           (id, workspace_id, job_id, attempt_id, sequence, kind, idempotency_key, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [eventId, att.workspace_id, att.job_id, att.id, sequence, kind, key, JSON.stringify(safePayload)],
      );

      if (att.status === 'leased') {
        await client.query(
          `update execution_attempts set status = 'running', updated_at = now() where id = $1`,
          [att.id],
        );
        await client.query(
          `update execution_jobs set status = 'running', updated_at = now() where id = $1 and workspace_id = $2`,
          [att.job_id, att.workspace_id],
        );
      }

      await client.query(
        `update execution_attempts
         set lease_expires_at = $1::timestamptz, updated_at = now()
         where id = $2`,
        [new Date(this.clock() + this.leaseTtlMs).toISOString(), att.id],
      );

      await this.#appendSessionCheckpoint(client, {
        workspaceId: att.workspace_id,
        sessionId: att.session_id,
        text: safePayload.text || `${kind}`,
        status: 'running',
        phase: safePayload.phase || kind,
        attemptId: att.id,
        engine: att.engine,
        sequence,
      });

      return {
        ok: true,
        replay: false,
        event: { id: eventId, sequence, kind, payload: safePayload },
      };
    });
  }

  async postArtifact(runnerRow, {
    attemptId,
    leaseEpoch,
    name = 'artifact',
    content = '',
    contentType = 'text/plain',
    idempotencyKey = '',
    metadata = {},
  } = {}) {
    assertNoProviderSecrets({ content, metadata });
    const key = String(idempotencyKey || `artifact:${name}`).slice(0, 200);
    const safeContent = String(content || '').slice(0, 200_000);

    return withServiceTransaction(this.pool, async (client) => {
      const att = await this.#lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {});
      const existing = await client.query(
        `select id, name from execution_artifacts
         where workspace_id = $1 and job_id = $2 and idempotency_key = $3 limit 1`,
        [att.workspace_id, att.job_id, key],
      );
      if (existing.rowCount) {
        return { ok: true, replay: true, artifact: { id: existing.rows[0].id, name: existing.rows[0].name } };
      }
      const artifactId = newId('art');
      await client.query(
        `insert into execution_artifacts
           (id, workspace_id, job_id, attempt_id, kind, name, content_type, content, metadata, idempotency_key)
         values ($1,$2,$3,$4,'file',$5,$6,$7,$8::jsonb,$9)`,
        [
          artifactId,
          att.workspace_id,
          att.job_id,
          att.id,
          String(name || 'artifact').slice(0, 200),
          contentType,
          safeContent,
          JSON.stringify(redactSecrets(metadata || {})),
          key,
        ],
      );
      await this.#appendSessionCheckpoint(client, {
        workspaceId: att.workspace_id,
        sessionId: att.session_id,
        text: `Artifact ready: ${name}`,
        status: 'running',
        phase: 'artifact',
        attemptId: att.id,
        artifactId,
        engine: att.engine,
      });
      return { ok: true, replay: false, artifact: { id: artifactId, name } };
    });
  }

  async completeAttempt(runnerRow, {
    attemptId,
    leaseEpoch,
    summary = '',
    idempotencyKey = 'terminal:complete',
    providerSession = null,
  } = {}) {
    const completionKey = String(idempotencyKey || 'terminal:complete').slice(0, 200);

    return withServiceTransaction(this.pool, async (client) => {
      const att = await this.#lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {
        allowTerminalReplay: true,
      });

      if (att.status === 'completed') {
        if (att.completion_idempotency_key && att.completion_idempotency_key !== completionKey) {
          reject('COMPLETION_IDEMPOTENCY_CONFLICT', 'completion idempotency key mismatch', 409);
        }
        return { ok: true, replay: true, status: 'completed', jobId: att.job_id };
      }
      if (['failed', 'cancelled', 'expired', 'fenced'].includes(att.status)) {
        reject('ATTEMPT_TERMINAL', `attempt already ${att.status}`, 409);
      }
      if (att.cancellation_requested) {
        reject('JOB_CANCELLED', 'cancellation requested', 409);
      }
      if (['completed', 'cancelled'].includes(att.job_status)) {
        return { ok: true, replay: true, status: att.job_status, jobId: att.job_id };
      }

      const nowIso = new Date(this.clock()).toISOString();
      const resultSummary = String(summary || 'Work completed').slice(0, 4000);
      const completedResolved = isPublicResolvedEngine(att.engine)
        ? String(att.engine)
        : (isPublicResolvedEngine(att.resolved_engine) ? String(att.resolved_engine) : '');
      if (att.provider_session_id) {
        const providerSessionId = String(providerSession?.id || '');
        const externalSessionId = String(providerSession?.externalSessionId || '').slice(0, 200);
        if (providerSessionId !== att.provider_session_id || !externalSessionId) {
          reject('PROVIDER_SESSION_ID_REQUIRED', 'Provider session identity is required', 409);
        }
        await client.query(
          `update provider_agent_sessions
           set external_session_id = $4, status = 'active',
               last_error_code = '', last_error_message = '',
               last_activity_at = $5::timestamptz, updated_at = now()
           where workspace_id = $1 and id = $2 and runner_id = $3`,
          [
            att.workspace_id,
            att.provider_session_id,
            runnerRow.id,
            externalSessionId,
            nowIso,
          ],
        );
      }

      await client.query(
        `update execution_attempts
         set status = 'completed',
             terminal_at = $1::timestamptz,
             result_summary = $2,
             completion_idempotency_key = $3,
             updated_at = now()
         where id = $4`,
        [nowIso, resultSummary, completionKey, att.id],
      );
      await client.query(
        `update execution_jobs
         set status = 'completed', terminal_at = $1::timestamptz, updated_at = now()
         where id = $2 and workspace_id = $3`,
        [nowIso, att.job_id, att.workspace_id],
      );
      await client.query(
        `update agent_missions set status = 'completed', payload = payload || $1::jsonb, updated_at = now()
         where id = $2 and workspace_id = $3`,
        [JSON.stringify({
          status: 'completed',
          resultSummary,
          completedAt: nowIso,
          ...(completedResolved
            ? { resolvedExecutionEngine: completedResolved, resolvedEngine: completedResolved }
            : {}),
        }), att.mission_id, att.workspace_id],
      );
      await client.query(
        `update agent_sessions set status = 'completed', payload = payload || $1::jsonb
         where id = $2 and workspace_id = $3`,
        [JSON.stringify({ status: 'completed' }), att.session_id, att.workspace_id],
      );

      // Authoritative agent report (once).
      const reportId = `report_${att.job_id}`;
      await client.query(
        `insert into agent_reports (id, mission_id, session_id, status, payload, workspace_id)
         values ($1, $2, $3, 'ready', $4::jsonb, $5)
         on conflict (id) do nothing`,
        [
          reportId,
          att.mission_id,
          att.session_id || '',
          JSON.stringify(redactSecrets({
            id: reportId,
            missionId: att.mission_id,
            sessionId: att.session_id,
            status: 'ready',
            summary: resultSummary,
            resultSummary,
            engine: completedResolved || att.engine,
            resolvedExecutionEngine: completedResolved || null,
            jobId: att.job_id,
            attemptId: att.id,
            ...(!shouldProjectJobToCalendar(att.payload)
              ? { hiddenFromAgentWork: true, systemKind: att.payload.kind }
              : {}),
            createdAt: nowIso,
            updatedAt: nowIso,
          })),
          att.workspace_id,
        ],
      );

      await this.#appendSessionCheckpoint(client, {
        workspaceId: att.workspace_id,
        sessionId: att.session_id,
        text: resultSummary,
        status: 'completed',
        phase: 'result',
        attemptId: att.id,
        engine: att.engine,
      });

      let eventId = null;
      if (shouldProjectJobToCalendar(att.payload)) {
        eventId = await projectAgentWorkCalendarState(client, {
          workspaceId: att.workspace_id,
          projectionKey: att.projection_key || att.job_id,
          jobId: att.job_id,
          missionId: att.mission_id,
          sessionId: att.session_id,
          goal: att.goal,
          lifecycleStatus: 'completed',
          occurredAt: nowIso,
          turnIndex: att.turn_index,
          providerSessionId: att.provider_session_id || '',
          attemptId: att.id,
          reportId,
          resultSummary,
        });
      }

      // Service-owned outbox row for drain worker.
      await client.query(
        `insert into execution_outbox (id, workspace_id, job_id, event_type, payload, status)
         values ($1,$2,$3,'job.completed',$4::jsonb,'pending')`,
        [
          newId('obx'),
          att.workspace_id,
          att.job_id,
          JSON.stringify({
            attemptId: att.id,
            summary: resultSummary,
            calendarEventId: eventId,
            reportId,
          }),
        ],
      );

      return {
        ok: true,
        replay: false,
        status: 'completed',
        jobId: att.job_id,
        calendarEventId: eventId,
        reportId,
        summary: resultSummary,
      };
    });
  }

  async failAttempt(runnerRow, {
    attemptId,
    leaseEpoch,
    errorCode = 'execution_failed',
    errorMessage = 'execution failed',
    retryable = true,
    providerSession = null,
  } = {}) {
    return withServiceTransaction(this.pool, async (client) => {
      const att = await this.#lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {
        allowTerminalReplay: true,
      });
      if (['completed', 'cancelled', 'failed', 'expired', 'fenced'].includes(att.status)) {
        return { ok: true, replay: true, status: att.status };
      }
      const nowIso = new Date(this.clock()).toISOString();
      await client.query(
        `update execution_attempts
         set status = 'failed', terminal_at = $1::timestamptz, error_code = $2, error_message = $3, updated_at = now()
         where id = $4`,
        [nowIso, String(errorCode).slice(0, 80), String(errorMessage).slice(0, 500), att.id],
      );

      const attempts = Number(att.attempt_count || 0);
      const max = Number(att.max_attempts || MAX_ATTEMPTS_DEFAULT);
      const safeErrorCode = String(errorCode).slice(0, 80);
      const safeErrorMessage = String(errorMessage).slice(0, 500);
      if (att.provider_session_id) {
        if (providerSession?.id && String(providerSession.id) !== att.provider_session_id) {
          reject('PROVIDER_SESSION_MISMATCH', 'Provider session identity does not match', 409);
        }
        const externalSessionId = String(providerSession?.externalSessionId || '').slice(0, 200);
        const providerStatus = providerSessionFailureStatus(safeErrorCode);
        await client.query(
          `update provider_agent_sessions
           set external_session_id = case when $4 <> '' then $4 else external_session_id end,
               status = $5, last_error_code = $6, last_error_message = $7,
               last_activity_at = $8::timestamptz, updated_at = now()
           where workspace_id = $1 and id = $2 and runner_id = $3`,
          [
            att.workspace_id,
            att.provider_session_id,
            runnerRow.id,
            externalSessionId,
            providerStatus,
            safeErrorCode,
            safeErrorMessage,
            nowIso,
          ],
        );
      }
      if (!retryable || attempts >= max) {
        const terminal = retryable ? 'dead_letter' : 'failed';
        const failedResolved = isPublicResolvedEngine(att.engine)
          ? String(att.engine)
          : (isPublicResolvedEngine(att.resolved_engine) ? String(att.resolved_engine) : '');
        const failurePayload = {
          status: 'failed',
          failureCode: safeErrorCode,
          failureMessage: safeErrorMessage,
          failedAt: nowIso,
          ...(failedResolved
            ? { resolvedExecutionEngine: failedResolved, resolvedEngine: failedResolved }
            : {}),
        };
        await client.query(
          `update execution_jobs
           set status = $1, terminal_at = $2::timestamptz,
               last_error_code = $3, last_error_message = $4, updated_at = now()
           where id = $5 and workspace_id = $6`,
          [terminal, nowIso, safeErrorCode, safeErrorMessage, att.job_id, att.workspace_id],
        );
        await client.query(
          `update agent_missions
           set status = 'failed', payload = payload || $1::jsonb, updated_at = now()
           where id = $2 and workspace_id = $3`,
          [JSON.stringify(failurePayload), att.mission_id, att.workspace_id],
        );
        await client.query(
          `update agent_sessions
           set status = 'failed', payload = payload || $1::jsonb
           where id = $2 and workspace_id = $3`,
          [JSON.stringify(failurePayload), att.session_id, att.workspace_id],
        );
        await this.#appendSessionCheckpoint(client, {
          workspaceId: att.workspace_id,
          sessionId: att.session_id,
          text: `Execution failed [${safeErrorCode}]: ${safeErrorMessage}`,
          status: terminal,
          phase: 'failed',
          attemptId: att.id,
          engine: failedResolved || undefined,
        });
        if (shouldProjectJobToCalendar(att.payload)) {
          await projectAgentWorkCalendarState(client, {
            workspaceId: att.workspace_id,
            projectionKey: att.projection_key || att.job_id,
            jobId: att.job_id,
            missionId: att.mission_id,
            sessionId: att.session_id,
            goal: att.goal,
            lifecycleStatus: 'failed',
            occurredAt: nowIso,
            turnIndex: att.turn_index,
            providerSessionId: att.provider_session_id || '',
            attemptId: att.id,
            failureCode: safeErrorCode,
          });
        }
        return { ok: true, status: terminal, jobId: att.job_id };
      }

      const backoff = BACKOFF_BASE_MS * (2 ** Math.max(0, attempts - 1));
      const availableAt = new Date(this.clock() + backoff).toISOString();
      await client.query(
        `update execution_jobs
         set status = 'accepted',
             available_at = $1::timestamptz,
             last_error_code = $2,
             last_error_message = $3,
             updated_at = now()
         where id = $4 and workspace_id = $5`,
        [availableAt, errorCode, String(errorMessage).slice(0, 500), att.job_id, att.workspace_id],
      );
      await this.#appendSessionCheckpoint(client, {
        workspaceId: att.workspace_id,
        sessionId: att.session_id,
        text: `Attempt failed (will retry): ${errorMessage}`,
        status: 'accepted',
        phase: 'retry',
        attemptId: att.id,
      });
      if (shouldProjectJobToCalendar(att.payload)) {
        await projectAgentWorkCalendarState(client, {
          workspaceId: att.workspace_id,
          projectionKey: att.projection_key || att.job_id,
          jobId: att.job_id,
          missionId: att.mission_id,
          sessionId: att.session_id,
          goal: att.goal,
          lifecycleStatus: 'rework',
          occurredAt: nowIso,
          turnIndex: att.turn_index,
          providerSessionId: att.provider_session_id || '',
          attemptId: att.id,
          failureCode: safeErrorCode,
        });
      }
      return { ok: true, status: 'accepted', retryAt: availableAt, jobId: att.job_id };
    });
  }

  async ackCancel(runnerRow, { attemptId, leaseEpoch } = {}) {
    return withServiceTransaction(this.pool, async (client) => {
      const att = await this.#lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {
        allowCancel: true,
        allowTerminalReplay: true,
      });
      if (att.status === 'cancelled') {
        return { ok: true, replay: true, status: 'cancelled', jobId: att.job_id };
      }
      if (['completed', 'failed', 'expired', 'fenced'].includes(att.status)) {
        reject('ATTEMPT_TERMINAL', `attempt already ${att.status}`, 409);
      }
      // Runner may only ack cancel when the Workspace owner requested cancellation.
      if (!att.cancellation_requested) {
        reject('CANCEL_NOT_REQUESTED', 'cancellation was not requested by workspace', 409);
      }
      const nowIso = new Date(this.clock()).toISOString();
      await client.query(
        `update execution_attempts
         set status = 'cancelled', terminal_at = $1::timestamptz, updated_at = now()
         where id = $2`,
        [nowIso, att.id],
      );
      await client.query(
        `update execution_jobs
         set status = 'cancelled', terminal_at = $1::timestamptz, updated_at = now()
         where id = $2 and workspace_id = $3`,
        [nowIso, att.job_id, att.workspace_id],
      );
      await this.#appendSessionCheckpoint(client, {
        workspaceId: att.workspace_id,
        sessionId: att.session_id,
        text: 'Cancellation acknowledged by Runner',
        status: 'cancelled',
        phase: 'cancel',
        attemptId: att.id,
      });
      return { ok: true, status: 'cancelled', jobId: att.job_id };
    });
  }

  /**
   * Signed attempt heartbeat: revalidate lease, extend expiry, return cancellationRequested.
   */
  async heartbeatAttempt(runnerRow, { attemptId, leaseEpoch } = {}) {
    return withServiceTransaction(this.pool, async (client) => {
      const att = await this.#lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {
        allowCancel: true,
      });
      const leaseExpiresAt = new Date(this.clock() + this.leaseTtlMs).toISOString();
      await client.query(
        `update execution_attempts
         set lease_expires_at = $1::timestamptz, updated_at = now()
         where id = $2 and workspace_id = $3`,
        [leaseExpiresAt, att.id, att.workspace_id],
      );
      return {
        ok: true,
        attemptId: att.id,
        jobId: att.job_id,
        leaseEpoch: Number(att.lease_epoch),
        leaseExpiresAt,
        cancellationRequested: Boolean(att.cancellation_requested),
        jobStatus: att.job_status,
        attemptStatus: att.status,
      };
    });
  }

  async reap(workspaceId = null) {
    return withServiceTransaction(this.pool, async (client) => {
      await this.#reapExpired(client, workspaceId, this.clock());
      return { ok: true };
    });
  }

  /**
   * Bounded outbox drain — invokes real handler; marks done only after success.
   * When no handler is configured, leaves pending and reports not_configured.
   */
  async drainOutbox({ limit = 25 } = {}) {
    if (typeof this.outboxHandler !== 'function') {
      return { ok: false, not_configured: true, drained: 0, scanned: 0 };
    }
    return withServiceTransaction(this.pool, async (client) => {
      const rows = await client.query(
        `select * from execution_outbox
         where status = 'pending' and available_at <= now()
         order by available_at asc
         for update skip locked
         limit $1`,
        [Math.max(1, Math.min(100, Number(limit) || 25))],
      );
      let drained = 0;
      let failed = 0;
      for (const row of rows.rows) {
        try {
          await this.outboxHandler(row);
          await client.query(
            `update execution_outbox
             set status = 'done', updated_at = now(), attempts = attempts + 1, last_error = ''
             where id = $1`,
            [row.id],
          );
          drained += 1;
        } catch (error) {
          failed += 1;
          const attempts = Number(row.attempts || 0) + 1;
          const terminal = attempts >= OUTBOX_MAX_ATTEMPTS;
          await client.query(
            `update execution_outbox
             set status = $1,
                 attempts = $2,
                 last_error = $3,
                 available_at = now() + ($4 || ' seconds')::interval,
                 updated_at = now()
             where id = $5`,
            [
              terminal ? 'failed' : 'pending',
              attempts,
              String(error.message || error).slice(0, 300),
              String(Math.min(60, 2 ** Math.min(6, attempts))),
              row.id,
            ],
          );
        }
      }
      return { ok: true, drained, failed, scanned: rows.rowCount };
    });
  }

  async #reapExpired(client, workspaceId, nowMs) {
    const nowIso = new Date(nowMs).toISOString();
    if (workspaceId) {
      await client.query(
        `update execution_offers set status = 'expired'
         where workspace_id = $1 and status = 'open' and expires_at <= $2::timestamptz`,
        [workspaceId, nowIso],
      );
      await client.query(
        `update execution_jobs j
         set status = 'accepted', available_at = now(), updated_at = now()
         where j.workspace_id = $1
           and j.status = 'offered'
           and j.cancellation_requested = false
           and not exists (
             select 1 from execution_offers o
             where o.job_id = j.id and o.workspace_id = j.workspace_id and o.status = 'open'
           )`,
        [workspaceId],
      );
      const expired = await client.query(
        `select a.*, j.session_id, j.attempt_count, j.max_attempts, j.cancellation_requested
         from execution_attempts a
         inner join execution_jobs j on j.id = a.job_id and j.workspace_id = a.workspace_id
         where a.workspace_id = $1
           and a.status in ('leased','running')
           and a.lease_expires_at <= $2::timestamptz
         for update of a, j`,
        [workspaceId, nowIso],
      );
      for (const att of expired.rows) {
        await client.query(
          `update execution_attempts set status = 'expired', terminal_at = $1::timestamptz, updated_at = now() where id = $2`,
          [nowIso, att.id],
        );
        if (att.cancellation_requested) {
          await client.query(
            `update execution_jobs set status = 'cancelled', terminal_at = $1::timestamptz, updated_at = now() where id = $2`,
            [nowIso, att.job_id],
          );
          continue;
        }
        const attempts = Number(att.attempt_count || 0);
        if (attempts >= Number(att.max_attempts || MAX_ATTEMPTS_DEFAULT)) {
          await client.query(
            `update execution_jobs set status = 'dead_letter', terminal_at = $1::timestamptz, updated_at = now() where id = $2`,
            [nowIso, att.job_id],
          );
        } else {
          await client.query(
            `update execution_jobs
             set status = 'accepted', available_at = now(), updated_at = now(),
                 last_error_code = 'lease_expired', last_error_message = 'lease expired; requeued'
             where id = $1`,
            [att.job_id],
          );
        }
      }
    } else {
      await client.query(
        `update execution_offers set status = 'expired'
         where status = 'open' and expires_at <= $1::timestamptz`,
        [nowIso],
      );
      await client.query(
        `update execution_attempts
         set status = 'expired', terminal_at = $1::timestamptz, updated_at = now()
         where status in ('leased','running') and lease_expires_at <= $1::timestamptz`,
        [nowIso],
      );
      await client.query(
        `update execution_jobs j
         set status = 'accepted', available_at = now(), updated_at = now()
         where j.status in ('offered','leased','running')
           and j.cancellation_requested = false
           and j.terminal_at is null
           and not exists (
             select 1 from execution_attempts a
             where a.job_id = j.id and a.workspace_id = j.workspace_id
               and a.status in ('leased','running')
           )
           and not exists (
             select 1 from execution_offers o
             where o.job_id = j.id and o.workspace_id = j.workspace_id and o.status = 'open'
           )`,
      );
    }
  }

  /**
   * Lock attempt + job FOR UPDATE and revalidate workspace/runner/epoch/live/lease/cancel/revoke
   * in the same transaction as the mutation.
   */
  async #lockLiveAttempt(client, runnerRow, attemptId, leaseEpoch, {
    allowTerminalReplay = false,
    allowCancel = false,
  } = {}) {
    const id = String(attemptId || '').trim();
    if (!id) reject('ATTEMPT_ID_REQUIRED', 'attemptId required', 400);
    if (!runnerRow || runnerRow.status === 'revoked') {
      reject('RUNNER_REVOKED', 'runner revoked', 401);
    }

    const result = await client.query(
      `select a.*,
              j.session_id, j.mission_id, j.cancellation_requested, j.status as job_status,
              j.attempt_count, j.max_attempts, j.resolved_engine, j.goal, j.projection_key,
              j.payload, j.provider_session_id, j.turn_index
       from execution_attempts a
       inner join execution_jobs j on j.id = a.job_id and j.workspace_id = a.workspace_id
       where a.id = $1 and a.workspace_id = $2
       for update of a, j`,
      [id, runnerRow.workspace_id],
    );
    if (!result.rowCount) reject('ATTEMPT_NOT_FOUND', 'attempt not found', 404);
    const att = result.rows[0];

    if (att.workspace_id !== runnerRow.workspace_id) {
      reject('ATTEMPT_FOREIGN_WORKSPACE', 'foreign workspace', 403);
    }
    if (att.runner_id !== runnerRow.id) {
      reject('ATTEMPT_FOREIGN_RUNNER', 'foreign runner', 403);
    }
    if (Number(leaseEpoch) !== Number(att.lease_epoch)) {
      reject('LEASE_EPOCH_MISMATCH', 'stale lease epoch', 409);
    }
    if (['fenced', 'expired'].includes(att.status)) {
      reject('ATTEMPT_FENCED', `attempt ${att.status}`, 409);
    }
    if (allowTerminalReplay && ['completed', 'failed', 'cancelled'].includes(att.status)) {
      return att;
    }
    if (!['leased', 'running'].includes(att.status)) {
      reject('ATTEMPT_NOT_LIVE', `attempt status ${att.status}`, 409);
    }
    if (new Date(att.lease_expires_at).getTime() <= this.clock()) {
      reject('LEASE_EXPIRED', 'lease expired', 409);
    }
    if (att.cancellation_requested && !allowCancel) {
      reject('JOB_CANCELLED', 'cancellation requested', 409);
    }
    return att;
  }

  async #persistMissionResolvedEngine(client, { workspaceId, missionId, resolvedEngine }) {
    if (!missionId || !isPublicResolvedEngine(resolvedEngine)) return;
    const engine = String(resolvedEngine);
    await client.query(
      `update agent_missions
       set payload = payload || $1::jsonb, updated_at = now()
       where id = $2 and workspace_id = $3`,
      [
        JSON.stringify({
          resolvedExecutionEngine: engine,
          resolvedEngine: engine,
        }),
        missionId,
        workspaceId,
      ],
    );
  }

  async #appendSessionCheckpoint(client, {
    workspaceId,
    sessionId,
    text,
    status,
    phase,
    attemptId = null,
    engine = null,
    sequence = null,
    artifactId = null,
  }) {
    if (!sessionId) return;
    // Lock session row for concurrency-safe sequence allocation.
    await client.query(
      `select id from agent_sessions where id = $1 and workspace_id = $2 for update`,
      [sessionId, workspaceId],
    );
    const seqRow = await client.query(
      `select coalesce(max(sequence), 0)::int as seq
       from agent_session_events where workspace_id = $1 and session_id = $2`,
      [workspaceId, sessionId],
    );
    const next = Number(seqRow.rows[0].seq) + 1;
    const kind = phaseToCheckpointKind(phase);
    const createdAt = new Date(this.clock()).toISOString();
    await client.query(
      `insert into agent_session_events (id, session_id, sequence, kind, payload, workspace_id)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        newId('evt'),
        sessionId,
        next,
        kind,
        JSON.stringify(redactSecrets({
          text,
          status,
          phase,
          checkpoint: true,
          attemptId,
          engine,
          sequence,
          artifactId,
          sessionId,
          kind,
          createdAt,
          metadata: {
            applicationMode: phase === 'result' || phase === 'artifact' ? 'checkpoint_result' : 'next_checkpoint',
            phase,
            ...(isPublicResolvedEngine(engine) ? { resolvedExecutionEngine: engine } : {}),
          },
        })),
        workspaceId,
      ],
    );
  }
}

module.exports = {
  DurableExecution,
  resolveEngine,
  shouldProjectJobToCalendar,
  projectAgentWorkCalendarState,
  redactSecrets,
  claimsEnabled,
  assertNoProviderSecrets,
  isPublicResolvedEngine,
  OFFER_TTL_MS,
  LEASE_TTL_MS,
  REAPER_INTERVAL_MS,
  OUTBOX_DRAIN_INTERVAL_MS,
  BANNED_PROVIDER_SECRET_KEYS,
};
