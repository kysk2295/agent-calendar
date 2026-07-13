const HERMES_AGENT_REGISTRY = [];

function agentKey(agent = {}) {
  return String(agent.id || agent.displayName || agent.name || '').trim();
}

function matchesAgent(agent = {}, wanted = '') {
  const key = String(wanted || '').trim();
  if (!key) return false;
  return [
    agent.id,
    agent.displayName,
    agent.name,
    agent.agentIdentity?.id,
    agent.agentIdentity?.displayName,
    agent.runtimeBinding?.agentKey,
    agent.profile?.name,
  ].some((value) => String(value || '').trim() === key);
}

function clone(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeProfileAgent(agent = {}) {
  const id = agentKey(agent);
  if (!id) return null;
  const displayName = agent.displayName || agent.name || id;
  const model = agent.executionBackend?.model || agent.runtimeBinding?.model || agent.model || 'Recommended';
  const commandTemplate = agent.executionBackend?.commandTemplate
    || agent.runtimeBinding?.commandTemplate
    || 'hermes -z "$HERMES_GOAL"';
  const agentIdentity = {
    id: agent.agentIdentity?.id || id,
    displayName: agent.agentIdentity?.displayName || displayName,
    source: 'hermes-cli',
    resident: true,
    kind: 'mac-mini-hermes-profile',
  };
  const executionBackend = {
    id: 'hermes-cli',
    label: agent.executionBackend?.label || 'Hermes CLI',
    kind: 'hermes-cli',
    model,
    commandTemplate,
  };
  const runtimeBinding = {
    ...(agent.runtimeBinding || {}),
    kind: agentIdentity.kind,
    agentKey: agent.runtimeBinding?.agentKey || agent.profile?.name || id,
    resident: true,
    executionBackendId: 'hermes-cli',
    adapterId: 'hermes-cli',
    commandTemplate,
    model,
  };
  return {
    ...agent,
    id,
    displayName,
    name: agent.name || displayName,
    engine: agent.engine || 'hermes',
    model,
    tools: Array.isArray(agent.tools) ? agent.tools : [],
    agentSource: 'hermes-cli',
    agentIdentity,
    executionBackend,
    runnerAdapter: { ...executionBackend },
    runtimeBinding,
  };
}

function isProfileAgent(agent = {}) {
  return agent.agentIdentity?.source === 'hermes-cli'
    || agent.agentIdentity?.kind === 'mac-mini-hermes-profile'
    || agent.agentSource === 'hermes-cli'
    || agent.executionBackend?.id === 'hermes-cli'
    || agent.profile?.name;
}

function normalizeAdHocAgent(agent = {}) {
  const id = agentKey(agent);
  if (!id) return null;
  const displayName = agent.displayName || agent.name || id;
  const agentIdentity = {
    id: agent.agentIdentity?.id || id,
    displayName: agent.agentIdentity?.displayName || displayName,
    source: 'ad-hoc',
    resident: false,
    kind: 'ad-hoc-agent',
  };
  return {
    ...agent,
    id,
    displayName,
    name: agent.name || displayName,
    model: agent.model || 'Recommended',
    agentSource: 'ad-hoc',
    agentIdentity,
    executionBackend: null,
    runnerAdapter: undefined,
    runtimeBinding: undefined,
  };
}

function mergeProfileOverride(profileAgent = {}, persistedAgent = {}) {
  const profile = normalizeProfileAgent(profileAgent);
  if (!profile) return null;
  const dashboardSettings = persistedAgent.dashboardSettings && typeof persistedAgent.dashboardSettings === 'object'
    ? persistedAgent.dashboardSettings
    : {};
  const displayName = dashboardSettings.displayName || persistedAgent.displayName || profile.displayName;
  const model = dashboardSettings.model || persistedAgent.model || profile.model;
  const enabled = dashboardSettings.enabled !== undefined ? dashboardSettings.enabled : persistedAgent.enabled;
  const preserved = {
    id: profile.id,
    displayName,
    name: displayName || profile.name,
    model,
    agentSource: profile.agentSource,
    agentIdentity: clone(profile.agentIdentity),
    executionBackend: { ...clone(profile.executionBackend), model },
    runnerAdapter: { ...clone(profile.runnerAdapter), model },
    runtimeBinding: { ...clone(profile.runtimeBinding), model },
    profile: clone(profile.profile),
    engine: profile.engine,
    role: dashboardSettings.role ?? persistedAgent.role ?? profile.role,
    persona: dashboardSettings.persona ?? persistedAgent.persona ?? profile.persona,
    status: enabled === false ? 'Idle' : (persistedAgent.status || profile.status),
    enabled: enabled !== false,
    dashboardSettings: clone(dashboardSettings),
    tools: clone(profile.tools),
    rules: clone(profile.rules),
    skills: clone(profile.skills),
    delegation: clone(profile.delegation),
    hermesCliPath: profile.hermesCliPath,
  };
  return {
    ...profile,
    ...persistedAgent,
    ...preserved,
  };
}

function listHermesAgentRegistry() {
  return [];
}

function projectAgentsForState(state = {}, { profileAgents = [] } = {}) {
  const projected = new Map();
  const profiles = Array.isArray(profileAgents) ? profileAgents.map(normalizeProfileAgent).filter(Boolean) : [];
  profiles.forEach((agent) => projected.set(agentKey(agent), agent));

  (Array.isArray(state.agents) ? state.agents : []).forEach((agent) => {
    const key = agentKey(agent);
    if (!key) return;
    if (!projected.has(key) && !profiles.length && isProfileAgent(agent)) {
      projected.set(key, normalizeProfileAgent(agent));
      return;
    }
    if (!projected.has(key)) {
      const adHocAgent = normalizeAdHocAgent(agent);
      if (adHocAgent) projected.set(key, adHocAgent);
      return;
    }
    projected.set(key, mergeProfileOverride(projected.get(key), agent));
  });

  return [...projected.values()];
}

function resolveHermesAgent(state = {}, input = {}, options = {}) {
  const wanted = String(input.agentId || input.agent || input.displayName || input.name || '').trim();
  const profileAgents = Array.isArray(options.profileAgents) ? options.profileAgents : [];
  const profile = wanted
    ? profileAgents.map(normalizeProfileAgent).filter(Boolean).find((agent) => matchesAgent(agent, wanted))
    : profileAgents.map(normalizeProfileAgent).filter(Boolean)[0];
  if (profile) return profile;

  if (!wanted) return null;
  const persisted = (Array.isArray(state.agents) ? state.agents : []).find((agent) => matchesAgent(agent, wanted));
  if (!persisted) return null;
  if (isProfileAgent(persisted)) {
    const matchingProfile = profileAgents.map(normalizeProfileAgent).filter(Boolean).find((agent) => matchesAgent(agent, wanted));
    return matchingProfile || normalizeAdHocAgent(persisted);
  }
  return normalizeAdHocAgent(persisted);
}

function projectStateWithAgents(state = {}, options = {}) {
  const projected = {
    ...state,
    agents: projectAgentsForState(state, options),
  };
  if (options.agentSourceStatus) projected.agentSourceStatus = options.agentSourceStatus;
  return projected;
}

module.exports = {
  HERMES_AGENT_REGISTRY,
  listHermesAgentRegistry,
  projectAgentsForState,
  projectStateWithAgents,
  resolveHermesAgent,
};
