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
    specialties: stringList(input.specialties || input.allowedTaskClasses),
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

  return {
    id: boundedText(id, '', 120, { required: true }),
    displayName,
    name: displayName,
    role: boundedText(input.role, '', 160),
    responsibility: boundedText(input.responsibility, '', 1_200),
    instructions: boundedText(input.instructions, '', 6_000),
    specialties: stringList(input.specialties),
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
}

module.exports = {
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  WorkspaceAgentDirectoryError,
};
