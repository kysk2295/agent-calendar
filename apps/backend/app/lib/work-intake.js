'use strict';

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { agentExecutionProfile } = require('./workspace-agent-directory');

const OPAQUE_LOCAL_FOLDER_HANDLE = /^[A-Za-z][A-Za-z0-9_-]{7,199}$/;
const RAW_LOCAL_KEY = /^(?:path|cwd|root|wikiRoot|localPath|absolutePath)$/i;
const WORK_PREVIEW_TTL_MS = 15 * 60 * 1_000;
const WORK_PREVIEW_CLOCK_SKEW_MS = 60 * 1_000;
const CONTEXT_LOOKBACK_MS = 30 * 86400000;
const CONTEXT_LOOKAHEAD_MS = 90 * 86400000;

class WorkIntakeError extends Error {
  constructor(code, message, statusHint = 422) {
    super(message || code);
    this.name = 'WorkIntakeError';
    this.code = code;
    this.statusHint = statusHint;
  }
}

function fail(code, message, statusHint = 422) {
  throw new WorkIntakeError(code, message, statusHint);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableId(prefix, value, length = 32) {
  const hash = crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, length);
  return `${prefix}_${hash}`;
}

function previewSnapshotId(value, issuedAtMs) {
  const issuedAtSeconds = Math.floor(issuedAtMs / 1_000);
  const timestamp = issuedAtSeconds.toString(16).padStart(8, '0').slice(-8);
  const hash = crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24);
  return `wip_${timestamp}${hash}`;
}

function previewIssuedAt(snapshotId) {
  const match = /^wip_([a-f0-9]{8})[a-f0-9]{24}$/.exec(String(snapshotId || ''));
  if (!match) return null;
  return Number.parseInt(match[1], 16) * 1_000;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function boundedText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeDeliverable(value) {
  const input = value === undefined ? {} : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('WORK_DELIVERABLE_INVALID', 'Deliverable must be an object', 422);
  }
  const kind = boundedText(input.kind || 'report', 80);
  if (!['report', 'document', 'image', 'file'].includes(kind)) {
    fail('WORK_DELIVERABLE_INVALID', 'Deliverable kind is not supported', 422);
  }
  return {
    kind,
    format: boundedText(input.format || (kind === 'report' ? 'markdown' : ''), 80),
  };
}

function normalizeOrigin(value) {
  const input = object(value);
  const kind = boundedText(input.kind || 'desktop', 40).toLowerCase();
  if (kind === 'calendar_ai') {
    const conversationId = boundedText(input.conversationId, 200);
    const turnId = boundedText(input.turnId, 200);
    if (!conversationId || !turnId) {
      fail(
        'CALENDAR_AI_ORIGIN_REQUIRED',
        'Calendar AI Work requires its conversation and turn origin',
        400,
      );
    }
    return {
      kind,
      conversationId,
      turnId,
      ...(boundedText(input.actionDraftId, 200)
        ? { actionDraftId: boundedText(input.actionDraftId, 200) }
        : {}),
    };
  }
  return { kind: kind || 'desktop' };
}

function assertNoRawLocalCoordinates(value) {
  for (const key of Object.keys(object(value))) {
    if (RAW_LOCAL_KEY.test(key)) {
      fail(
        'WORKING_CONTEXT_RAW_PATH_FORBIDDEN',
        'Working context must not contain a raw local path',
        400,
      );
    }
  }
}

function normalizeWorkingContext(value) {
  const input = object(value);
  assertNoRawLocalCoordinates(input);
  const kind = boundedText(input.kind || 'workspace_general', 40).toLowerCase();
  if (kind === 'workspace_general') return Object.freeze({ kind });
  if (kind !== 'local_folder') {
    fail('WORKING_CONTEXT_INVALID', 'Working context must be workspace_general or local_folder');
  }
  const handle = boundedText(input.handle, 200);
  if (!OPAQUE_LOCAL_FOLDER_HANDLE.test(handle)) {
    fail(
      'LOCAL_FOLDER_HANDLE_REQUIRED',
      'Local folder Work requires an opaque Electron/Runner folder handle',
      400,
    );
  }
  return Object.freeze({
    kind,
    handle,
    ...(boundedText(input.label, 120) ? { label: boundedText(input.label, 120) } : {}),
  });
}

function agentSearchScore(goal, profile) {
  const terms = new Set(
    boundedText(goal, 4000).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1),
  );
  const candidate = [
    profile.displayName,
    profile.role,
    profile.responsibility,
    ...(Array.isArray(profile.specialties) ? profile.specialties : []),
  ].join(' ').toLowerCase();
  const candidateTerms = candidate.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  let score = 0;
  for (const term of terms) {
    if (candidate.includes(term) || candidateTerms.some((candidateTerm) => term.includes(candidateTerm))) {
      score += 1;
    }
  }
  return score;
}

function publicEnvelope(value) {
  const envelope = object(value);
  const id = boundedText(envelope.id, 200);
  const digest = boundedText(envelope.digest, 128);
  if (!id || !digest) {
    fail('CONTEXT_ENVELOPE_REQUIRED', 'Work requires an immutable Context Envelope', 409);
  }
  return {
    id,
    digest,
    snapshotVersion: Number(envelope.snapshotVersion || 0),
    citations: (Array.isArray(envelope.citations) ? envelope.citations : [])
      .map((citation) => ({
        handle: boundedText(citation?.handle, 400),
        label: boundedText(citation?.label, 240),
      }))
      .filter((citation) => citation.handle && citation.label),
  };
}

class WorkIntake {
  constructor({
    pool = null,
    contextAssembler,
    durableExecution,
    resolveResponsibleAgent = null,
    clock = () => Date.now(),
  } = {}) {
    if (!contextAssembler || typeof contextAssembler.assemble !== 'function') {
      throw new Error('WorkIntake requires contextAssembler');
    }
    if (!durableExecution
      || typeof durableExecution.previewWork !== 'function'
      || (
        typeof durableExecution.acceptPreviewedWork !== 'function'
        && typeof durableExecution.acceptWork !== 'function'
      )) {
      throw new Error('WorkIntake requires durableExecution preview/start boundary');
    }
    if (!resolveResponsibleAgent && !pool) {
      throw new Error('WorkIntake requires pool or resolveResponsibleAgent');
    }
    this.pool = pool;
    this.contextAssembler = contextAssembler;
    this.durableExecution = durableExecution;
    this.resolveResponsibleAgent = resolveResponsibleAgent;
    this.clock = clock;
  }

  async #resolveResponsibleAgent(scope, input) {
    if (this.resolveResponsibleAgent) {
      return this.resolveResponsibleAgent(scope, clone(input));
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select id, payload
         from agents
         where workspace_id = $1
         order by id asc`,
        [valid.workspaceId],
      );
      const candidates = [];
      for (const row of rows.rows) {
        try {
          candidates.push(agentExecutionProfile({
            id: row.id,
            ...object(row.payload),
            workspaceId: valid.workspaceId,
          }));
        } catch {}
      }
      const requestedAgentId = boundedText(input.agentId, 120);
      if (requestedAgentId && requestedAgentId !== 'default') {
        const explicit = candidates.find((candidate) => candidate.agentId === requestedAgentId);
        if (!explicit) {
          fail(
            'RESPONSIBLE_AGENT_NOT_AVAILABLE',
            'The requested Responsible Agent is not active in this Workspace',
            409,
          );
        }
        return {
          agentId: explicit.agentId,
          assignmentReason: `explicit:${explicit.agentId}`,
          profileSnapshot: explicit,
        };
      }
      const ranked = candidates
        .map((profile) => ({ profile, score: agentSearchScore(input.goal, profile) }))
        .sort((left, right) => right.score - left.score
          || left.profile.agentId.localeCompare(right.profile.agentId));
      if (!ranked.length) {
        return {
          agentId: 'default',
          assignmentReason: 'unassigned:no_active_profile',
          profileSnapshot: null,
        };
      }
      return {
        agentId: ranked[0].profile.agentId,
        assignmentReason: ranked[0].score > 0
          ? 'automatic:profile_match'
          : 'automatic:available_profile',
        profileSnapshot: ranked[0].profile,
      };
    });
  }

  async #resolveContextEnvelope(scope, input, inputValue, issuedAtMs) {
    const contextEnvelopeId = boundedText(inputValue.contextEnvelopeId, 200);
    if (!contextEnvelopeId || !this.pool) {
      return this.contextAssembler.assemble(scope, {
        purpose: 'work',
        query: input.goal,
        conversationId: input.origin.conversationId,
        workId: input.missionId,
        agentId: input.agentId || undefined,
        workingContext: input.workingContext,
        budget: object(inputValue.budget),
        policy: object(inputValue.policy),
        range: {
          from: new Date(issuedAtMs - CONTEXT_LOOKBACK_MS).toISOString(),
          to: new Date(issuedAtMs + CONTEXT_LOOKAHEAD_MS).toISOString(),
        },
      });
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select id, snapshot_version, source_versions, context_digest, payload
         from context_envelopes
         where workspace_id = $1 and id = $2
         limit 1`,
        [valid.workspaceId, contextEnvelopeId],
      );
      if (!result.rowCount) {
        fail('CONTEXT_ENVELOPE_NOT_FOUND', 'Calendar AI Context Envelope was not found', 404);
      }
      const row = result.rows[0];
      const activeSnapshot = await client.query(
        `select version
         from second_brain_snapshots
         where workspace_id = $1 and status = 'active'
         limit 1`,
        [valid.workspaceId],
      );
      const currentSnapshotVersion = Number(activeSnapshot.rows[0]?.version || 0);
      if (currentSnapshotVersion !== Number(row.snapshot_version || 0)) {
        fail('WORK_PREVIEW_STALE', 'Calendar AI Context Envelope snapshot is stale', 409);
      }
      const sourceVersions = Array.isArray(row.source_versions) ? row.source_versions : [];
      if (sourceVersions.length) {
        const currentSources = await client.query(
          `select id, source_version, content_digest, status
           from workspace_source_records
           where workspace_id = $1 and id = any($2::text[])`,
          [valid.workspaceId, sourceVersions.map((source) => String(source.id || ''))],
        );
        const currentById = new Map(currentSources.rows.map((source) => [source.id, source]));
        const stale = sourceVersions.some((source) => {
          const current = currentById.get(String(source.id || ''));
          return !current
            || current.status !== 'active'
            || Number(current.source_version || 0) !== Number(source.version || 0)
            || String(current.content_digest || '') !== String(source.digest || '');
        });
        if (stale) {
          fail('WORK_PREVIEW_STALE', 'Calendar AI Context Envelope sources are stale', 409);
        }
      }
      const payload = object(row.payload);
      return {
        id: row.id,
        digest: row.context_digest,
        snapshotVersion: Number(row.snapshot_version || 0),
        citations: Array.isArray(payload.citations) ? payload.citations : [],
      };
    });
  }

  #normalizedInput(scope, input) {
    const goal = boundedText(input.goal || input.objective || input.text, 4000);
    if (!goal) fail('WORK_GOAL_REQUIRED', 'Work goal is required', 400);
    const origin = normalizeOrigin(input.origin);
    const missionId = boundedText(input.missionId, 200) || stableId('mission', {
      workspaceId: scope.workspaceId,
      requestId: boundedText(input.requestId || input.clientRequestId, 200),
      goal,
      origin,
    }, 24);
    let deliverable;
    try {
      deliverable = normalizeDeliverable(input.deliverable);
    } catch (error) {
      fail(error.code || 'WORK_DELIVERABLE_INVALID', error.message, error.status || 422);
    }
    return {
      missionId,
      title: boundedText(input.title || goal, 300),
      goal,
      origin,
      workingContext: normalizeWorkingContext(input.workingContext),
      agentId: boundedText(input.agentId, 120),
      executionEngine: boundedText(input.executionEngine || 'auto', 40).toLowerCase(),
      requestedModel: boundedText(input.requestedModel, 160),
      requiredCapabilities: Array.isArray(input.requiredCapabilities)
        ? [...new Set(input.requiredCapabilities.map(String))].sort()
        : [],
      deliverable: clone(deliverable),
      payload: clone(object(input.payload)),
      contextEnvelopeId: boundedText(input.contextEnvelopeId, 200),
    };
  }

  async preview(scopeValue, inputValue = {}, previewOptions = {}) {
    const scope = assertWorkspaceScope(scopeValue);
    const clockNow = Number(this.clock());
    const requestedIssuedAt = Number(previewOptions.issuedAtMs);
    const issuedAtMs = Math.floor(
      (Number.isFinite(requestedIssuedAt) ? requestedIssuedAt : clockNow) / 1_000,
    ) * 1_000;
    const expiresAtMs = issuedAtMs + WORK_PREVIEW_TTL_MS;
    const input = this.#normalizedInput(scope, object(inputValue));
    const assignmentValue = await this.#resolveResponsibleAgent(scope, input);
    const assignment = object(assignmentValue);
    const profileSnapshot = assignment.profileSnapshot ? clone(assignment.profileSnapshot) : null;
    const assignmentReason = boundedText(
      assignment.assignmentReason || 'unassigned:no_active_profile',
      200,
    );
    const assigned = Boolean(
      assignment.agentId
      && assignment.agentId !== 'default'
      && profileSnapshot?.agentId === assignment.agentId,
    );
    const envelopeValue = await this.#resolveContextEnvelope(scope, {
      ...input,
      agentId: assigned ? assignment.agentId : input.agentId,
    }, object(inputValue), issuedAtMs);
    const contextEnvelope = publicEnvelope(envelopeValue);
    let executionPreview = null;
    if (assigned) {
      executionPreview = await this.durableExecution.previewWork(scope, {
        ...input,
        agentId: assignment.agentId,
      });
      if (executionPreview?.responsibleAgent?.agentId
        && executionPreview.responsibleAgent.agentId !== assignment.agentId) {
        fail('RESPONSIBLE_AGENT_STALE', 'Responsible Agent preview changed', 409);
      }
    }
    const effectiveConfiguration = executionPreview?.effectiveConfiguration
      ? clone(executionPreview.effectiveConfiguration)
      : null;
    const ready = assigned && effectiveConfiguration?.executable === true;
    const snapshotContent = {
      workspaceId: scope.workspaceId,
      missionId: input.missionId,
      title: input.title,
      goal: input.goal,
      origin: input.origin,
      workingContext: input.workingContext,
      responsibleAgent: profileSnapshot,
      assignmentReason,
      contextEnvelope,
      effectiveConfiguration,
      executionEngine: input.executionEngine,
      requestedModel: input.requestedModel,
      requiredCapabilities: input.requiredCapabilities,
      deliverable: input.deliverable,
      attestation: {
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
    return {
      snapshotId: previewSnapshotId(snapshotContent, issuedAtMs),
      ready,
      missionId: input.missionId,
      title: input.title,
      goal: input.goal,
      origin: clone(input.origin),
      workingContext: clone(input.workingContext),
      responsibleAgent: profileSnapshot,
      assignment: {
        status: assigned ? 'assigned' : 'unassigned',
        reason: assignmentReason,
      },
      effectiveConfiguration,
      contextEnvelope,
      createdAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      workspaceId: scope.workspaceId,
    };
  }

  async start(scopeValue, inputValue = {}) {
    const scope = assertWorkspaceScope(scopeValue);
    const expectedSnapshotId = boundedText(inputValue.previewSnapshotId, 200);
    if (!expectedSnapshotId) {
      fail('WORK_PREVIEW_REQUIRED', 'Starting Work requires a preview snapshot id', 409);
    }
    const issuedAtMs = previewIssuedAt(expectedSnapshotId);
    const now = Number(this.clock());
    if (!issuedAtMs
      || issuedAtMs > now + WORK_PREVIEW_CLOCK_SKEW_MS
      || now >= issuedAtMs + WORK_PREVIEW_TTL_MS) {
      fail('WORK_PREVIEW_STALE', 'Work preview has expired; create a new preview', 409);
    }
    const preview = await this.preview(scope, inputValue, { issuedAtMs });
    if (preview.snapshotId !== expectedSnapshotId) {
      fail('WORK_PREVIEW_STALE', 'Work preview is stale; review the current context and assignment', 409);
    }
    if (!preview.ready || !preview.responsibleAgent) {
      fail(
        'RESPONSIBLE_AGENT_REQUIRED',
        'An active Responsible Agent must be assigned before Work can start',
        409,
      );
    }
    const input = this.#normalizedInput(scope, object(inputValue));
    const workIntake = {
      schemaVersion: 1,
      previewSnapshotId: preview.snapshotId,
      origin: clone(preview.origin),
      workingContext: clone(preview.workingContext),
      contextEnvelopeId: preview.contextEnvelope.id,
      contextEnvelopeDigest: preview.contextEnvelope.digest,
      snapshotVersion: preview.contextEnvelope.snapshotVersion,
      citations: clone(preview.contextEnvelope.citations),
      assignmentReason: preview.assignment.reason,
      responsibleAgentId: preview.responsibleAgent.agentId,
      responsibleAgentProfileVersion: preview.responsibleAgent.profileVersion,
    };
    const durableInput = {
      missionId: preview.missionId,
      title: preview.title,
      goal: preview.goal,
      agentId: preview.responsibleAgent.agentId,
      executionEngine: input.executionEngine,
      requestedModel: input.requestedModel,
      requiredCapabilities: input.requiredCapabilities,
      deliverable: input.deliverable,
      effectiveConfigurationSnapshotId: preview.effectiveConfiguration.snapshotId,
      clientRequestId: boundedText(inputValue.clientRequestId || inputValue.requestId, 200),
      templateId: input.origin.kind === 'calendar_ai'
        ? 'calendar-ai-delegation'
        : 'general-agent-work',
      payload: {
        ...input.payload,
        kind: input.origin.kind === 'calendar_ai'
          ? 'calendar_ai_delegated_work'
          : (boundedText(input.payload.kind, 80) || 'delegated_work'),
        profileSnapshot: clone(preview.responsibleAgent),
        workIntake,
      },
    };
    const started = typeof this.durableExecution.acceptPreviewedWork === 'function'
      ? await this.durableExecution.acceptPreviewedWork(scope, durableInput)
      : await this.durableExecution.acceptWork(scope, durableInput);
    return {
      ...started,
      preview,
      responsibleAgent: clone(preview.responsibleAgent),
      assignmentReason: preview.assignment.reason,
      workingContext: clone(preview.workingContext),
      contextEnvelopeId: preview.contextEnvelope.id,
    };
  }
}

module.exports = {
  WorkIntake,
  WorkIntakeError,
  normalizeOrigin,
  normalizeWorkingContext,
};
