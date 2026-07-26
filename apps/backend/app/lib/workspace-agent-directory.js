'use strict';

const SOURCE_KINDS = new Set(['native', 'connected']);
const EXECUTION_ENGINES = new Set(['auto', 'codex', 'claude', 'grok', 'hermes', 'local_llm']);

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
    enabled: input.enabled !== false,
  });
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
    profileVersion: profileVersion(input.profileVersion),
    sourceKind,
    provider,
    externalAgentId,
    syncMode: sourceKind === 'connected' ? 'reference' : 'managed',
    connectionStatus,
    defaultExecutionEngine: EXECUTION_ENGINES.has(defaultExecutionEngine)
      ? defaultExecutionEngine
      : 'auto',
    defaultRunnerId: boundedText(input.defaultRunnerId, '', 120),
    enabled: input.enabled !== false,
    ...(boundedText(input.emoji, '', 16) ? { emoji: boundedText(input.emoji, '', 16) } : {}),
    ...(input.workspaceId ? { workspaceId: boundedText(input.workspaceId, '', 120) } : {}),
  };
}

function normalizeWorkspaceAgent(value = {}, { id, workspaceId, existing } = {}) {
  const input = {
    ...objectValue(existing),
    ...objectValue(value),
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
    enabled: input.enabled !== false,
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
  return {
    ...normalized,
    profileVersion: version,
  };
}

function agentExecutionProfile(value = {}) {
  const agent = projectWorkspaceAgent(value);
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
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  WorkspaceAgentDirectoryError,
};
