'use strict';

const crypto = require('node:crypto');

const SOURCE_KINDS = new Set(['native', 'connected']);
const EXECUTION_ENGINES = new Set(['auto', 'codex', 'claude', 'grok', 'hermes', 'local_llm']);
const CAPABILITY_ID_PATTERN = /^(tool|skill):[a-z0-9][a-z0-9._/-]{0,118}$/;
const BUILDER_ORIGINS = new Set(['legacy', 'manual', 'one_line']);
const BUILDER_STATES = new Set(['draft', 'tested', 'active']);
const BUILDER_TEST_STATUSES = new Set(['running', 'passed', 'failed', 'cancelled', 'timed_out']);
const BUILDER_REQUEST_MAX_LENGTH = 500;

class WorkspaceAgentDirectoryError extends Error {
  constructor(code, message, statusHint = 422) {
    super(message);
    this.name = 'WorkspaceAgentDirectoryError';
    this.code = code;
    this.statusHint = statusHint;
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, fallback, maximumLength, { required = false } = {}) {
  const normalized = String(value === undefined || value === null ? fallback : value).trim();
  if (required && !normalized) {
    throw new WorkspaceAgentDirectoryError('agent_invalid', 'Agent display name is required');
  }
  return normalized.slice(0, maximumLength);
}

function stringList(value, maximumItems = 12, maximumLength = 80) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || '').trim().slice(0, maximumLength))
    .filter(Boolean))]
    .slice(0, maximumItems);
}

function stableHash(value, length = 32) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);
}

function capabilityIds(value, { maximumItems = 100, strict = false } = {}) {
  if (!Array.isArray(value)) return [];
  const normalized = [...new Set(value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
    .sort()
    .slice(0, maximumItems);
  if (strict && normalized.some((item) => !CAPABILITY_ID_PATTERN.test(item))) {
    throw new WorkspaceAgentDirectoryError(
      'agent_grants_invalid',
      'Tool and skill grants require stable capability IDs',
    );
  }
  return normalized.filter((item) => CAPABILITY_ID_PATTERN.test(item));
}

function normalizeGrants(value = {}, { strict = false } = {}) {
  const input = objectValue(value);
  const deny = capabilityIds(input.deny, { strict });
  return {
    allow: capabilityIds(input.allow, { strict }).filter((id) => !deny.includes(id)),
    deny,
  };
}

function grantUpdate(input, existing) {
  const current = normalizeGrants(objectValue(existing).grants);
  if (objectValue(input).approvedGrants) {
    return { grants: normalizeGrants(input.approvedGrants, { strict: true }) };
  }
  if (!Object.hasOwn(objectValue(input), 'grants')) {
    const gate = objectValue(objectValue(existing).approvalGate);
    return {
      grants: current,
      ...(gate.status === 'pending' ? { approvalGate: gate } : {}),
    };
  }
  const requested = normalizeGrants(input.grants, { strict: true });
  const additions = requested.allow.filter((id) => !current.allow.includes(id));
  if (!additions.length) return { grants: requested };
  const reducedCurrent = {
    allow: current.allow.filter((id) => requested.allow.includes(id) && !requested.deny.includes(id)),
    deny: requested.deny,
  };
  return {
    grants: reducedCurrent,
    approvalGate: {
      id: `grant_${stableHash({ requested, current }, 24)}`,
      status: 'pending',
      reason: 'grant_expansion',
      requestedGrants: requested,
      addedCapabilities: additions,
      externalDelivery: additions.some((id) => /(?:mail|send|publish|external|delivery)/.test(id)),
    },
  };
}

function normalizeRunnerCapabilityCatalog(value = {}) {
  const input = objectValue(value);
  const catalogId = String(input.catalogId || 'runner-default-deny').trim().toLowerCase();
  const version = Number(input.version || 1);
  if (!/^[a-z0-9][a-z0-9._/-]{0,79}$/.test(catalogId)
    || !Number.isSafeInteger(version) || version < 1) {
    throw new WorkspaceAgentDirectoryError(
      'runner_catalog_invalid',
      'Runner capability catalog identity or version is invalid',
    );
  }
  const rawEntries = Array.isArray(input.entries) ? input.entries : [];
  const entries = rawEntries.map((valueEntry) => {
    const entry = objectValue(valueEntry);
    const id = String(entry.id || '').trim().toLowerCase();
    const entryVersion = Number(entry.version);
    const kind = String(entry.kind || '').trim().toLowerCase();
    if (!CAPABILITY_ID_PATTERN.test(id)
      || !Number.isSafeInteger(entryVersion) || entryVersion < 1
      || !['tool', 'skill'].includes(kind)
      || !id.startsWith(`${kind}:`)) {
      throw new WorkspaceAgentDirectoryError(
        'runner_catalog_invalid',
        'Runner capability catalog entry is invalid',
      );
    }
    return {
      id,
      version: entryVersion,
      kind,
      externalDelivery: entry.externalDelivery === true,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new WorkspaceAgentDirectoryError(
      'runner_catalog_invalid',
      'Runner capability catalog IDs must be unique',
    );
  }
  const publicCatalog = { catalogId, version, entries };
  return {
    ...publicCatalog,
    revision: `cat_${stableHash(publicCatalog, 24)}`,
  };
}

function profileVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0
    ? Math.min(version, 1_000_000)
    : 1;
}

function profileMeaning(value) {
  const input = objectValue(value);
  return JSON.stringify({
    displayName: input.displayName || '',
    role: input.role || '',
    responsibility: input.responsibility || '',
    instructions: input.instructions || '',
    responseStyle: input.responseStyle || '',
    specialties: Array.isArray(input.specialties) ? input.specialties : [],
    memories: Array.isArray(input.memories) ? input.memories : [],
    sourceKind: input.sourceKind || '',
    provider: input.provider || '',
    externalAgentId: input.externalAgentId || '',
    defaultExecutionEngine: input.defaultExecutionEngine || 'auto',
    defaultRunnerId: input.defaultRunnerId || '',
    grants: normalizeGrants(input.grants),
  });
}

function positiveInteger(value, fallback = 0, maximum = 1_000_000) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0
    ? Math.min(normalized, maximum)
    : fallback;
}

function isoTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString();
}

function builderRequest(value, { required = false } = {}) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if ((required && !normalized) || normalized.length > BUILDER_REQUEST_MAX_LENGTH) {
    throw new WorkspaceAgentDirectoryError(
      'agent_builder_request_invalid',
      `One-line agent request must be between 1 and ${BUILDER_REQUEST_MAX_LENGTH} characters`,
    );
  }
  return normalized;
}

function normalizeBuilderSideEffects(value = {}) {
  const input = objectValue(value);
  const normalized = {};
  for (const key of ['calendar', 'externalDelivery', 'schedulerJobs']) {
    const count = Number(input[key]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      throw new WorkspaceAgentDirectoryError(
        'agent_test_result_invalid',
        'Builder test side-effect counts are invalid',
      );
    }
    normalized[key] = count;
  }
  return normalized;
}

function normalizeBuilderTest(value) {
  if (value === null || value === undefined) return null;
  const input = objectValue(value);
  const status = String(input.status || '').trim().toLowerCase();
  if (!BUILDER_TEST_STATUSES.has(status)) return null;
  return {
    id: boundedText(input.id, '', 160),
    revision: positiveInteger(input.revision),
    status,
    summary: boundedText(input.summary, '', 500),
    durationMs: Math.max(0, Math.min(Number(input.durationMs) || 0, 120_000)),
    timeoutMs: Math.max(250, Math.min(Number(input.timeoutMs) || 30_000, 30_000)),
    sideEffects: input.sideEffects
      ? normalizeBuilderSideEffects(input.sideEffects)
      : { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
    startedAt: input.startedAt ? isoTimestamp(input.startedAt) : null,
    terminalAt: input.terminalAt ? isoTimestamp(input.terminalAt) : null,
  };
}

function legacyLifecycle(input, version) {
  const enabled = input.enabled !== false;
  return {
    origin: 'legacy',
    state: enabled ? 'active' : 'draft',
    revision: version,
    reviewedRevision: enabled ? version : 0,
    testedRevision: enabled ? version : 0,
    activeVersion: enabled ? version : 0,
    request: '',
    lastTest: null,
    reviewedAt: null,
    activatedAt: null,
  };
}

function projectBuilderLifecycle(input, version) {
  const source = objectValue(input.lifecycle);
  const origin = String(source.origin || '').trim().toLowerCase();
  const state = String(source.state || '').trim().toLowerCase();
  if (!BUILDER_ORIGINS.has(origin) || !BUILDER_STATES.has(state)) {
    return legacyLifecycle(input, version);
  }
  const revision = positiveInteger(source.revision, version);
  return {
    origin,
    state,
    revision,
    reviewedRevision: positiveInteger(source.reviewedRevision),
    testedRevision: positiveInteger(source.testedRevision),
    activeVersion: positiveInteger(source.activeVersion),
    request: builderRequest(source.request),
    lastTest: normalizeBuilderTest(source.lastTest),
    reviewedAt: source.reviewedAt ? isoTimestamp(source.reviewedAt) : null,
    activatedAt: source.activatedAt ? isoTimestamp(source.activatedAt) : null,
  };
}

function initialBuilderLifecycle(input, sourceKind, version) {
  if (sourceKind === 'connected') return legacyLifecycle({ enabled: true }, version);
  const origin = String(input.builderOrigin || 'manual').trim().toLowerCase();
  if (!['manual', 'one_line'].includes(origin)) {
    throw new WorkspaceAgentDirectoryError(
      'agent_builder_request_invalid',
      'Agent builder origin is invalid',
    );
  }
  const request = builderRequest(input.oneLineRequest, { required: origin === 'one_line' });
  return {
    origin,
    state: 'draft',
    revision: version,
    reviewedRevision: 0,
    testedRevision: 0,
    activeVersion: 0,
    request,
    lastTest: null,
    reviewedAt: null,
    activatedAt: null,
  };
}

function assertBuilderRevision(lifecycle, action) {
  if (positiveInteger(action.expectedRevision) !== lifecycle.revision) {
    throw new WorkspaceAgentDirectoryError(
      'agent_builder_stale',
      'Agent builder revision is stale',
      409,
    );
  }
}

function applyBuilderAction(lifecycleValue, actionValue, { version, now }) {
  const lifecycle = { ...lifecycleValue };
  const action = objectValue(actionValue);
  const name = String(action.action || '').trim().toLowerCase();
  if (!name) return lifecycle;
  assertBuilderRevision(lifecycle, action);
  const timestamp = isoTimestamp(now);

  if (name === 'review') {
    if (lifecycle.state !== 'draft') {
      throw new WorkspaceAgentDirectoryError(
        'agent_builder_state_invalid',
        'Only a draft can be reviewed',
        409,
      );
    }
    return {
      ...lifecycle,
      reviewedRevision: lifecycle.revision,
      reviewedAt: timestamp,
    };
  }

  if (name === 'test_started') {
    if (lifecycle.state !== 'draft' || lifecycle.reviewedRevision !== lifecycle.revision) {
      throw new WorkspaceAgentDirectoryError(
        'agent_test_ineligible',
        'Current draft must be reviewed before testing',
        409,
      );
    }
    const requestId = boundedText(action.requestId, '', 160, { required: true });
    const timeoutMs = Number(action.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new WorkspaceAgentDirectoryError(
        'agent_test_request_invalid',
        'Builder test timeout must be between 250 and 30000 milliseconds',
      );
    }
    return {
      ...lifecycle,
      state: 'draft',
      testedRevision: 0,
      lastTest: {
        id: requestId,
        revision: lifecycle.revision,
        status: 'running',
        summary: '',
        durationMs: 0,
        timeoutMs,
        sideEffects: { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
        startedAt: timestamp,
        terminalAt: null,
      },
    };
  }

  if (name === 'test_result') {
    const current = lifecycle.lastTest;
    const requestId = boundedText(action.requestId, '', 160, { required: true });
    if (!current || current.status !== 'running'
      || current.id !== requestId || current.revision !== lifecycle.revision) {
      throw new WorkspaceAgentDirectoryError(
        'agent_test_stale',
        'Builder test result is stale',
        409,
      );
    }
    const status = String(action.status || '').trim().toLowerCase();
    const summary = String(action.summary || '').trim();
    const durationMs = Number(action.durationMs);
    if (!['passed', 'failed', 'cancelled', 'timed_out'].includes(status)
      || !summary || summary.length > 500
      || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 120_000) {
      throw new WorkspaceAgentDirectoryError(
        'agent_test_result_invalid',
        'Builder test result is invalid',
      );
    }
    const sideEffects = normalizeBuilderSideEffects(action.sideEffects);
    if (status === 'passed' && Object.values(sideEffects).some((count) => count !== 0)) {
      throw new WorkspaceAgentDirectoryError(
        'agent_test_side_effect',
        'Builder test produced a forbidden side effect',
      );
    }
    return {
      ...lifecycle,
      state: status === 'passed' ? 'tested' : 'draft',
      testedRevision: status === 'passed' ? lifecycle.revision : 0,
      lastTest: {
        ...current,
        status,
        summary,
        durationMs,
        sideEffects,
        terminalAt: timestamp,
      },
    };
  }

  if (name === 'activate') {
    const requestId = boundedText(action.requestId, '', 160, { required: true });
    if (lifecycle.state !== 'tested'
      || lifecycle.reviewedRevision !== lifecycle.revision
      || lifecycle.testedRevision !== lifecycle.revision
      || lifecycle.lastTest?.status !== 'passed'
      || lifecycle.lastTest?.id !== requestId) {
      throw new WorkspaceAgentDirectoryError(
        'agent_activation_ineligible',
        'Current draft requires review and a successful bounded test',
        409,
      );
    }
    return {
      ...lifecycle,
      state: 'active',
      activeVersion: version,
      activatedAt: timestamp,
    };
  }

  throw new WorkspaceAgentDirectoryError(
    'agent_builder_action_invalid',
    'Agent builder action is invalid',
  );
}

function legacySourceKind(input) {
  const source = String(input.sourceKind || input.agentSource || input.source || '').toLowerCase();
  if (SOURCE_KINDS.has(source)) return source;
  if (/hermes|claude|codex|grok|external|import|connect/.test(source)) return 'connected';
  return 'native';
}

function legacyProvider(input, sourceKind) {
  if (sourceKind === 'native') return 'agent-calendar';
  const provider = String(input.provider || input.runtime || input.agentSource || input.source || 'external')
    .trim()
    .toLowerCase();
  if (provider.includes('hermes')) return 'hermes';
  if (provider.includes('claude')) return 'claude';
  if (provider.includes('codex')) return 'codex';
  if (provider.includes('grok')) return 'grok';
  return provider.slice(0, 80) || 'external';
}

function projectWorkspaceAgent(value = {}) {
  const input = objectValue(value);
  const id = boundedText(input.id, '', 120);
  const sourceKind = legacySourceKind(input);
  const provider = legacyProvider(input, sourceKind);
  const displayName = boundedText(input.displayName || input.name, id || 'Agent', 120);
  const externalAgentId = sourceKind === 'connected'
    ? boundedText(
      input.externalAgentId || input.profileId || input.profileName || objectValue(input.profile).name,
      id,
      160,
    )
    : '';
  const connectionStatus = boundedText(
    input.connectionStatus,
    sourceKind === 'connected' ? 'linked' : 'ready',
    40,
  );
  const defaultExecutionEngine = String(input.defaultExecutionEngine || input.model || 'auto').toLowerCase();
  const grants = normalizeGrants(input.grants);
  const approvalGate = objectValue(input.approvalGate);
  const version = profileVersion(input.profileVersion);
  const lifecycle = projectBuilderLifecycle(input, version);

  return {
    id,
    displayName,
    name: displayName,
    role: boundedText(input.role, '', 160),
    responsibility: boundedText(input.responsibility || input.persona, '', 1_200),
    instructions: boundedText(input.instructions, '', 6_000),
    responseStyle: boundedText(input.responseStyle || input.style, '', 1_200),
    specialties: stringList(input.specialties || input.allowedTaskClasses),
    memories: stringList(input.memories || input.memory, 24, 500),
    profileVersion: version,
    sourceKind,
    provider,
    externalAgentId,
    syncMode: sourceKind === 'connected' ? 'reference' : 'managed',
    connectionStatus,
    defaultExecutionEngine: EXECUTION_ENGINES.has(defaultExecutionEngine)
      ? defaultExecutionEngine
      : 'auto',
    defaultRunnerId: boundedText(input.defaultRunnerId, '', 120),
    grants,
    ...(approvalGate.status === 'pending'
      ? {
        approvalGate: {
          id: boundedText(approvalGate.id, '', 120),
          status: 'pending',
          reason: boundedText(approvalGate.reason, 'grant_expansion', 80),
          requestedGrants: normalizeGrants(approvalGate.requestedGrants),
          addedCapabilities: capabilityIds(approvalGate.addedCapabilities),
          externalDelivery: approvalGate.externalDelivery === true,
        },
      }
      : {}),
    lifecycle,
    enabled: lifecycle.state === 'active' && input.enabled !== false,
    ...(boundedText(input.emoji, '', 16) ? { emoji: boundedText(input.emoji, '', 16) } : {}),
    ...(input.workspaceId ? { workspaceId: boundedText(input.workspaceId, '', 120) } : {}),
  };
}

function normalizeWorkspaceAgent(value = {}, {
  id,
  workspaceId,
  existing,
  builderAction,
  now,
} = {}) {
  const patch = objectValue(value);
  const input = {
    ...objectValue(existing),
    ...patch,
    id,
    workspaceId,
  };
  const sourceKind = legacySourceKind(input);
  const displayName = boundedText(input.displayName || input.name, '', 120, { required: true });
  const provider = sourceKind === 'native'
    ? 'agent-calendar'
    : boundedText(input.provider, '', 80).toLowerCase();
  const externalAgentId = sourceKind === 'connected'
    ? boundedText(input.externalAgentId, '', 160)
    : '';
  if (sourceKind === 'connected' && (!provider || !externalAgentId)) {
    throw new WorkspaceAgentDirectoryError(
      'agent_source_invalid',
      'Connected agents require provider and externalAgentId',
    );
  }
  const requestedEngine = String(input.defaultExecutionEngine || 'auto').trim().toLowerCase();
  if (!EXECUTION_ENGINES.has(requestedEngine)) {
    throw new WorkspaceAgentDirectoryError(
      'agent_engine_invalid',
      'Unsupported default execution engine',
    );
  }

  const grantState = grantUpdate(patch, existing);
  const normalized = {
    id: boundedText(id, '', 120, { required: true }),
    displayName,
    name: displayName,
    role: boundedText(input.role, '', 160),
    responsibility: boundedText(input.responsibility, '', 1_200),
    instructions: boundedText(input.instructions, '', 6_000),
    responseStyle: boundedText(input.responseStyle, '', 1_200),
    specialties: stringList(input.specialties),
    memories: stringList(input.memories, 24, 500),
    sourceKind,
    provider,
    externalAgentId,
    syncMode: sourceKind === 'connected' ? 'reference' : 'managed',
    connectionStatus: sourceKind === 'connected' ? 'linked' : 'ready',
    defaultExecutionEngine: requestedEngine,
    defaultRunnerId: boundedText(input.defaultRunnerId, '', 120),
    ...grantState,
    ...(boundedText(input.emoji, '', 16) ? { emoji: boundedText(input.emoji, '', 16) } : {}),
    workspaceId: boundedText(workspaceId, '', 120, { required: true }),
  };
  const existingProfile = existing
    ? projectWorkspaceAgent({
      id,
      ...objectValue(existing),
      workspaceId,
    })
    : null;
  const version = existingProfile
    ? profileVersion(existingProfile.profileVersion)
      + (profileMeaning(existingProfile) === profileMeaning(normalized) ? 0 : 1)
    : 1;
  const meaningChanged = Boolean(existingProfile && version !== existingProfile.profileVersion);
  let lifecycle = existingProfile
    ? projectBuilderLifecycle(existingProfile, existingProfile.profileVersion)
    : initialBuilderLifecycle(input, sourceKind, version);
  if (meaningChanged) {
    lifecycle = {
      ...lifecycle,
      state: 'draft',
      revision: lifecycle.revision + 1,
      reviewedRevision: 0,
      testedRevision: 0,
      lastTest: null,
      reviewedAt: null,
      activatedAt: null,
    };
  } else if (existingProfile && patch.enabled === false && lifecycle.state === 'active') {
    lifecycle = {
      ...lifecycle,
      state: 'draft',
      reviewedRevision: 0,
      testedRevision: 0,
      lastTest: null,
      reviewedAt: null,
      activatedAt: null,
    };
  }
  lifecycle = applyBuilderAction(lifecycle, builderAction, { version, now });
  return {
    ...normalized,
    profileVersion: version,
    lifecycle,
    enabled: lifecycle.state === 'active',
  };
}

function resolveEffectiveAgentConfiguration({
  workspaceId,
  agent: agentValue,
  runner: runnerValue,
  requestedEngine = 'auto',
  resolvedEngine = '',
  requestedModel = '',
  reason = '',
  requiredCapabilities = [],
  expectedSnapshotId = '',
} = {}) {
  const agent = projectWorkspaceAgent(agentValue);
  const runner = objectValue(runnerValue);
  const capabilities = objectValue(runner.capabilities);
  const catalog = normalizeRunnerCapabilityCatalog(
    capabilities.catalog || capabilities.capabilityCatalog,
  );
  const required = capabilityIds(requiredCapabilities, { strict: true });
  const deniedSet = new Set(agent.grants.deny);
  const catalogById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const allowed = agent.grants.allow
    .filter((id) => !deniedSet.has(id) && catalogById.has(id))
    .map((id) => catalogById.get(id));
  const allowedIds = new Set(allowed.map((entry) => entry.id));
  const denied = required.filter((id) => !allowedIds.has(id));
  const approvalRequired = required.filter(
    (id) => allowedIds.has(id) && catalogById.get(id)?.externalDelivery === true,
  );
  const runnerRef = `runner_${stableHash({
    workspaceId: String(workspaceId || ''),
    runnerId: String(runner.id || ''),
  }, 16)}`;
  const configuration = {
    schemaVersion: 1,
    engine: {
      requested: String(requestedEngine || 'auto').toLowerCase(),
      resolved: String(resolvedEngine || '').toLowerCase(),
      model: boundedText(requestedModel, '', 160),
      reason: boundedText(reason, '', 160),
    },
    runner: {
      ref: runnerRef,
      catalogId: catalog.catalogId,
      catalogVersion: catalog.version,
      catalogRevision: catalog.revision,
    },
    profile: {
      agentId: agent.id,
      displayName: agent.displayName,
      version: agent.profileVersion,
    },
    rules: {
      defaultDeny: true,
      denyOverAllow: true,
      profileInstructionsApplied: Boolean(agent.instructions || agent.responsibility),
    },
    grants: {
      allowed,
      denied,
      approvalRequired,
    },
    memoryScopes: agent.memories.length ? ['agent_profile'] : [],
    approvalPolicy: {
      grantExpansion: 'required',
      externalDelivery: 'required',
    },
    requiredCapabilities: required,
  };
  const snapshotId = `ecfg_${stableHash(configuration, 32)}`;
  if (expectedSnapshotId && expectedSnapshotId !== snapshotId) {
    throw new WorkspaceAgentDirectoryError(
      'effective_configuration_stale',
      'Effective configuration preview is stale',
      409,
    );
  }
  return Object.freeze({
    ...configuration,
    snapshotId,
    executable: denied.length === 0 && approvalRequired.length === 0,
  });
}

function agentExecutionProfile(value = {}) {
  const agent = projectWorkspaceAgent(value);
  if (agent.lifecycle.state !== 'active' || agent.enabled === false) {
    throw new WorkspaceAgentDirectoryError(
      'agent_inactive',
      'Inactive agent profiles cannot execute',
      409,
    );
  }
  return Object.freeze({
    agentId: agent.id,
    displayName: agent.displayName,
    role: agent.role,
    responsibility: agent.responsibility,
    instructions: agent.instructions,
    responseStyle: agent.responseStyle,
    specialties: Object.freeze([...agent.specialties]),
    memories: Object.freeze([...agent.memories]),
    profileVersion: agent.profileVersion,
    memoryScope: 'agent_profile',
  });
}

function applyAgentExecutionProfile(goal, snapshotValue) {
  const snapshot = objectValue(snapshotValue);
  if (!snapshot.agentId) return String(goal || '').slice(0, 12_000);
  const specialties = stringList(snapshot.specialties).join(', ');
  const memories = stringList(snapshot.memories, 24, 500);
  const profileContext = [
    '[Agent Calendar Responsible Agent Profile]',
    'Follow this Workspace-owned profile unless it conflicts with platform safety or the current user request.',
    `Profile version: ${profileVersion(snapshot.profileVersion)}`,
    `Name: ${boundedText(snapshot.displayName, 'Agent', 120)}`,
    boundedText(snapshot.role, '', 160) ? `Role: ${boundedText(snapshot.role, '', 160)}` : '',
    boundedText(snapshot.responsibility, '', 1_200)
      ? `Responsibility: ${boundedText(snapshot.responsibility, '', 1_200)}`
      : '',
    boundedText(snapshot.instructions, '', 6_000)
      ? `Working instructions:\n${boundedText(snapshot.instructions, '', 6_000)}`
      : '',
    boundedText(snapshot.responseStyle, '', 1_200)
      ? `Voice and personality:\n${boundedText(snapshot.responseStyle, '', 1_200)}`
      : '',
    specialties ? `Specialties: ${specialties}` : '',
    memories.length
      ? `Long-term agent memory (user-managed):\n${memories.map((memory) => `- ${memory}`).join('\n')}`
      : '',
    '[End Responsible Agent Profile]',
  ].filter(Boolean).join('\n\n').slice(0, 16_000);
  return `${profileContext}\n\nDelegated work:\n${String(goal || '').slice(0, 12_000)}`;
}

module.exports = {
  agentExecutionProfile,
  applyAgentExecutionProfile,
  normalizeRunnerCapabilityCatalog,
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  resolveEffectiveAgentConfiguration,
  WorkspaceAgentDirectoryError,
};
