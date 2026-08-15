'use strict';

const { randomUUID } = require('node:crypto');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { assertWorkspaceScope } = require('./workspace-scope');

const ALLOWED_ORIGINS = new Set(['calendar', 'mail', 'file']);
const RUNNING_STAGES = ['collecting', 'indexing', 'extracting', 'linking'];
const TERMINAL_STATUSES = new Set(['source_required', 'ready_for_review', 'active']);

function bounded(value, maximum = 1200) {
  return String(value || '').trim().slice(0, maximum);
}

function serviceError(code, message, statusHint = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function parseJson(text) {
  const raw = bounded(text, 50_000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw serviceError('SECOND_BRAIN_INFERENCE_SCHEMA_INVALID', 'inference must return JSON', 502);
  }
}

function groundedClaims(result, sources) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const claims = [];
  for (const [index, candidate] of (Array.isArray(result && result.claims) ? result.claims : []).entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const sourceId = bounded(candidate.sourceId || candidate.provenance?.sourceId, 300);
    const source = byId.get(sourceId);
    const evidenceHandle = bounded(candidate.evidenceHandle || candidate.provenance?.evidenceHandle, 500);
    const citation = bounded(candidate.citation || candidate.provenance?.citationLabel, 300);
    const text = bounded(candidate.text || candidate.value, 1000);
    if (!source || !text || citation !== source.citation || evidenceHandle !== source.evidenceHandle) continue;
    claims.push({
      id: bounded(candidate.id, 300) || `claim-${index + 1}`,
      text,
      provenance: { sourceId, evidenceHandle, origin: source.origin },
      citation,
      reviewStatus: 'pending',
    });
  }
  if (!claims.length) {
    throw serviceError(
      'SECOND_BRAIN_GROUNDED_CLAIMS_REQUIRED',
      'inference returned no claim with authorized evidence and citation',
      502,
    );
  }
  return claims;
}

function rowRun(row) {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    processed: Number(row.processed || 0),
    total: Number(row.total || 0),
    sourceIds: Array.isArray(row.source_ids) ? row.source_ids : [],
    stageHistory: Array.isArray(row.stage_history) ? row.stage_history : [],
    error: row.error_code ? { code: row.error_code, message: row.error_message || '' } : null,
  };
}

function rowSnapshot(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    version: Number(row.version),
    status: row.status,
    claims: Array.isArray(row.claims) ? row.claims : [],
  } : null;
}

class SecondBrain {
  constructor({ pool, sourceLibrary, inferenceBroker, schedule = setImmediate } = {}) {
    if (!pool) throw new Error('SecondBrain requires pool');
    if (!sourceLibrary || typeof sourceLibrary.listBootstrapSources !== 'function') {
      throw new Error('SecondBrain requires sourceLibrary.listBootstrapSources');
    }
    if (!inferenceBroker || typeof inferenceBroker.complete !== 'function') {
      throw new Error('SecondBrain requires inferenceBroker.complete');
    }
    this.pool = pool;
    this.sourceLibrary = sourceLibrary;
    this.inferenceBroker = inferenceBroker;
    this.scheduleCallback = schedule;
    this.scheduled = new Set();
  }

  async createRun(scope, input = {}) {
    const valid = assertWorkspaceScope(scope);
    const idempotencyKey = bounded(input.idempotencyKey, 240);
    if (!idempotencyKey) throw serviceError('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');
    const requested = [...new Set((Array.isArray(input.sourceIds) ? input.sourceIds : [])
      .map((value) => bounded(value, 300)).filter(Boolean))];
    const created = await withAppRoleWorkspaceTransaction(this.pool, valid, async (client) => {
      const id = randomUUID();
      const result = await client.query(
        `insert into second_brain_runs
         (id, workspace_id, user_id, idempotency_key, status, stage, processed, total, source_ids, stage_history)
         values ($1,$2,$3,$4,'running','collecting',0,0,$5::jsonb,$6::jsonb)
         on conflict (workspace_id, user_id, idempotency_key) do update
           set idempotency_key = excluded.idempotency_key
         returning *`,
        [id, valid.workspaceId, valid.userId, idempotencyKey, JSON.stringify(requested),
          JSON.stringify([{ stage: 'collecting', at: new Date().toISOString() }])],
      );
      return result.rows[0];
    });
    if (created.status === 'running') {
      this.#schedule(valid, created.id);
      return { ok: true, run: rowRun(created), snapshot: null };
    }
    return this.getRun(valid, created.id);
  }

  #schedule(scope, runId) {
    const key = `${scope.workspaceId}:${scope.userId}:${runId}`;
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    const handle = this.scheduleCallback(() => {
      void this.#process(scope, runId).finally(() => this.scheduled.delete(key));
    });
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  async #process(scope, runId) {
    const workerToken = randomUUID();
    try {
      const current = await this.#claimRun(scope, runId, workerToken);
      if (!current) return;
      const inventory = (await this.sourceLibrary.listBootstrapSources(scope))
        .filter((source) => source && ALLOWED_ORIGINS.has(source.origin)
          && source.content && source.evidenceHandle && source.citation);
      const requested = Array.isArray(current.source_ids) && current.source_ids.length
        ? new Set(current.source_ids)
        : null;
      const sources = requested ? inventory.filter((source) => requested.has(source.id)) : inventory;
      if (!sources.length) {
        await this.#checkpoint(scope, runId, {
          status: 'source_required', stage: 'source_required', processed: 0, total: 0, sourceIds: [],
        }, workerToken);
        return;
      }

      await this.#checkpoint(scope, runId, {
        status: 'running', stage: 'indexing', processed: 0, total: sources.length,
        sourceIds: sources.map((source) => source.id),
      }, workerToken);
      await new Promise((resolve) => setImmediate(resolve));
      await this.#checkpoint(scope, runId, {
        status: 'running', stage: 'extracting', processed: sources.length, total: sources.length,
      }, workerToken);
      const completion = await this.inferenceBroker.complete({
        scope,
        purpose: 'second_brain_bootstrap',
        requestId: `second-brain:${runId}`,
        messages: [
          {
            role: 'system',
            content: [
              '허용된 원본 근거만 사용해 개인 Second Brain claim JSON을 만드세요.',
              '각 claim은 text, sourceId, evidenceHandle, citation을 포함해야 합니다.',
              '응답 형식: {"claims":[...]}',
              ...sources.map((source, index) => (
                `[근거 ${index + 1}] sourceId=${source.id} evidenceHandle=${source.evidenceHandle} citation=${source.citation}\n${source.content}`
              )),
            ].join('\n\n').slice(0, 20_000),
          },
        ],
        context: {
          evidence: sources.map(({ id, origin, evidenceHandle, citation }) => ({
            sourceId: id, origin, evidenceHandle, citation,
          })),
        },
      });
      const extraction = completion && typeof completion === 'object' && Array.isArray(completion.claims)
        ? completion
        : parseJson(completion && completion.text);
      const claims = groundedClaims(extraction, sources);
      await this.#checkpoint(scope, runId, {
        status: 'running', stage: 'linking', processed: sources.length, total: sources.length,
      }, workerToken);
      await this.#persistReadySnapshot(scope, runId, claims, workerToken);
    } catch (error) {
      await this.#checkpoint(scope, runId, {
        status: error && error.name === 'AbortError' ? 'interrupted' : 'failed',
        stage: error && error.name === 'AbortError' ? 'extracting' : 'failed',
        errorCode: bounded(error && error.code, 120) || 'SECOND_BRAIN_FAILED',
        errorMessage: 'Second Brain 분석을 완료하지 못했습니다.',
      }, workerToken).catch(() => {});
    }
  }

  async #claimRun(scope, runId, workerToken) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `update second_brain_runs set
           worker_token=$4, lease_expires_at=now() + interval '2 minutes', updated_at=now()
         where workspace_id=$1 and user_id=$2 and id=$3 and status='running'
           and (worker_token='' or lease_expires_at is null or lease_expires_at < now())
         returning *`,
        [valid.workspaceId, valid.userId, runId, workerToken],
      );
      return result.rows[0] || null;
    });
  }

  async #checkpoint(scope, runId, patch, workerToken = '') {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select * from second_brain_runs
         where workspace_id=$1 and user_id=$2 and id=$3
           and ($4::text='' or worker_token=$4) for update`,
        [valid.workspaceId, valid.userId, runId, workerToken],
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      const history = Array.isArray(row.stage_history) ? row.stage_history : [];
      if (patch.stage && history.at(-1)?.stage !== patch.stage) {
        history.push({ stage: patch.stage, at: new Date().toISOString() });
      }
      const updated = await client.query(
        `update second_brain_runs set
           status=$4, stage=$5, processed=$6, total=$7,
           source_ids=$8::jsonb, stage_history=$9::jsonb,
           error_code=$10, error_message=$11,
           worker_token=case when $12 then '' else worker_token end,
           lease_expires_at=case when $12 then null else now() + interval '2 minutes' end,
           updated_at=now()
         where workspace_id=$1 and user_id=$2 and id=$3 returning *`,
        [valid.workspaceId, valid.userId, runId,
          patch.status || row.status, patch.stage || row.stage,
          patch.processed ?? row.processed, patch.total ?? row.total,
          JSON.stringify(patch.sourceIds ?? row.source_ids), JSON.stringify(history),
          patch.errorCode ?? row.error_code, patch.errorMessage ?? row.error_message,
          patch.status !== 'running'],
      );
      return updated.rows[0];
    });
  }

  async #persistReadySnapshot(scope, runId, claims, workerToken) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const runResult = await client.query(
        `select * from second_brain_runs
         where workspace_id=$1 and user_id=$2 and id=$3 and worker_token=$4 for update`,
        [valid.workspaceId, valid.userId, runId, workerToken],
      );
      if (!runResult.rowCount) return null;
      const versionResult = await client.query(
        `select coalesce(max(version),0)::int as version from second_brain_snapshots
         where workspace_id=$1 and user_id=$2 and run_id=$3`,
        [valid.workspaceId, valid.userId, runId],
      );
      const snapshot = await client.query(
        `insert into second_brain_snapshots
         (id, workspace_id, user_id, run_id, version, status, claims)
         values ($1,$2,$3,$4,$5,'ready_for_review',$6::jsonb) returning *`,
        [randomUUID(), valid.workspaceId, valid.userId, runId,
          Number(versionResult.rows[0].version) + 1, JSON.stringify(claims)],
      );
      const row = runResult.rows[0];
      const history = Array.isArray(row.stage_history) ? row.stage_history : [];
      history.push({ stage: 'ready_for_review', at: new Date().toISOString() });
      await client.query(
        `update second_brain_runs set status='ready_for_review', stage='ready_for_review',
           stage_history=$4::jsonb, error_code='', error_message='',
           worker_token='', lease_expires_at=null, updated_at=now()
         where workspace_id=$1 and user_id=$2 and id=$3`,
        [valid.workspaceId, valid.userId, runId, JSON.stringify(history)],
      );
      return snapshot.rows[0];
    });
  }

  async #loadRunRow(scope, id) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select * from second_brain_runs where workspace_id=$1 and user_id=$2 and id=$3`,
        [valid.workspaceId, valid.userId, id],
      );
      return result.rows[0] || null;
    });
  }

  async getRun(scope, id) {
    const valid = assertWorkspaceScope(scope);
    const result = await withAppRoleWorkspaceTransaction(this.pool, valid, async (client) => {
      const runResult = await client.query(
        `select * from second_brain_runs where workspace_id=$1 and user_id=$2 and id=$3`,
        [valid.workspaceId, valid.userId, bounded(id, 300)],
      );
      if (!runResult.rowCount) return null;
      const snapshots = await client.query(
        `select * from second_brain_snapshots
         where workspace_id=$1 and user_id=$2 and run_id=$3 order by version desc limit 1`,
        [valid.workspaceId, valid.userId, runResult.rows[0].id],
      );
      return { ok: true, run: rowRun(runResult.rows[0]), snapshot: rowSnapshot(snapshots.rows[0]) };
    });
    if (result && result.run.status === 'running') this.#schedule(valid, result.run.id);
    return result;
  }

  async getCurrent(scope) {
    const valid = assertWorkspaceScope(scope);
    const current = await withAppRoleWorkspaceTransaction(this.pool, valid, async (client) => {
      const latestRun = await client.query(
        `select id from second_brain_runs where workspace_id=$1 and user_id=$2
         order by created_at desc, id desc limit 1`,
        [valid.workspaceId, valid.userId],
      );
      const active = await client.query(
        `select s.id as snapshot_id, s.run_id
         from second_brain_snapshots s
         where s.workspace_id=$1 and s.user_id=$2 and s.status='active'
         order by s.created_at desc, s.version desc limit 1`,
        [valid.workspaceId, valid.userId],
      );
      return {
        latestRunId: latestRun.rows[0]?.id || '',
        activeRunId: active.rows[0]?.run_id || '',
        activeSnapshotId: active.rows[0]?.snapshot_id || '',
      };
    });
    if (!current.latestRunId) return { ok: true, run: null, snapshot: null, draftRun: null };
    const latest = await this.getRun(valid, current.latestRunId);
    if (!current.activeRunId) return { ...latest, draftRun: null };
    const active = await this.getRun(valid, current.activeRunId);
    if (!active || active.snapshot?.id !== current.activeSnapshotId) return { ...latest, draftRun: null };
    return {
      ...active,
      draftRun: current.latestRunId === current.activeRunId ? null : latest.run,
      draftSnapshot: current.latestRunId === current.activeRunId ? null : latest.snapshot,
    };
  }

  async reviewSnapshot(scope, id, input = {}) {
    const valid = assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, valid, async (client) => {
      const found = await client.query(
        `select * from second_brain_snapshots
         where workspace_id=$1 and user_id=$2 and id=$3 for update`,
        [valid.workspaceId, valid.userId, bounded(id, 300)],
      );
      if (!found.rowCount) return null;
      const original = found.rows[0];
      const latest = await client.query(
        `select max(version)::int as version from second_brain_snapshots
         where workspace_id=$1 and user_id=$2 and run_id=$3`,
        [valid.workspaceId, valid.userId, original.run_id],
      );
      if (Number(latest.rows[0].version) !== Number(original.version)) {
        throw serviceError('SECOND_BRAIN_VERSION_CONFLICT', 'snapshot is not current', 409);
      }
      const decisions = Array.isArray(input.decisions) ? input.decisions : [];
      const claims = (Array.isArray(original.claims) ? original.claims : []).map((claim) => ({ ...claim }));
      if (input.activate && decisions.length !== claims.length) {
        throw serviceError('SECOND_BRAIN_REVIEW_INCOMPLETE', 'every grounded claim must be reviewed');
      }
      const audit = [];
      for (const decision of decisions) {
        const action = bounded(decision && decision.action, 20);
        const claimId = bounded(decision && decision.claimId, 300);
        const basis = bounded(decision && decision.basis, 1000);
        const index = claims.findIndex((claim) => claim.id === claimId);
        if (index < 0 || !['confirm', 'correct', 'reject'].includes(action) || !basis) {
          throw serviceError('SECOND_BRAIN_REVIEW_INVALID', 'review action, claim, and basis are required');
        }
        const claim = claims[index];
        audit.push({ claimId, action, basis, provenance: claim.provenance });
        if (action === 'confirm') claims[index] = { ...claim, reviewStatus: 'confirmed' };
        if (action === 'correct') {
          const text = bounded(decision.text, 1000);
          if (!text) throw serviceError('SECOND_BRAIN_CORRECTION_REQUIRED', 'corrected text required');
          claims[index] = { ...claim, text, reviewStatus: 'corrected' };
        }
        if (action === 'reject') claims.splice(index, 1);
      }
      const snapshot = await client.query(
        `insert into second_brain_snapshots
         (id, workspace_id, user_id, run_id, version, status, claims)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning *`,
        [randomUUID(), valid.workspaceId, valid.userId, original.run_id,
          Number(original.version) + 1, input.activate ? 'active' : 'ready_for_review',
          JSON.stringify(claims)],
      );
      for (const item of audit) {
        await client.query(
          `insert into second_brain_reviews
           (id, workspace_id, user_id, snapshot_id, claim_id, action, basis, provenance)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [randomUUID(), valid.workspaceId, valid.userId, snapshot.rows[0].id,
            item.claimId, item.action, item.basis, JSON.stringify(item.provenance || {})],
        );
      }
      if (input.activate) {
        const run = await client.query(
          `select stage_history from second_brain_runs
           where workspace_id=$1 and user_id=$2 and id=$3 for update`,
          [valid.workspaceId, valid.userId, original.run_id],
        );
        const history = Array.isArray(run.rows[0]?.stage_history) ? run.rows[0].stage_history : [];
        history.push({ stage: 'active', at: new Date().toISOString() });
        await client.query(
          `update second_brain_runs set status='active', stage='active', stage_history=$4::jsonb, updated_at=now()
           where workspace_id=$1 and user_id=$2 and id=$3`,
          [valid.workspaceId, valid.userId, original.run_id, JSON.stringify(history)],
        );
      }
      return { ok: true, snapshot: rowSnapshot(snapshot.rows[0]), audit };
    });
  }
}

module.exports = { ALLOWED_ORIGINS, RUNNING_STAGES, SecondBrain, groundedClaims };
