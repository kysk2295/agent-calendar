const OFFICIAL_PROFILE_NAMES = ['default', 'bizconsultant', 'stockagent', 'uniportpm', 'wikicurator'];
const DEFAULT_PROFILE_NAME = 'default';
const FORBIDDEN_PRODUCT_AGENT_NAMES = Object.freeze([
  ['코', '달'].join(''),
  ['다', '온'].join(''),
  ['도', '브'].join(''),
  ['시', '리'].join(''),
  ['Research', 'er'].join(''),
  ['Orchestr', 'ator'].join(''),
  ['Wiki', ' Curator'].join(''),
  ['PM', ' Agent'].join(''),
]);

function normalizeProfileName(value) {
  return String(value || '').trim();
}

function isOfficialProfileName(value) {
  return OFFICIAL_PROFILE_NAMES.includes(normalizeProfileName(value));
}

function isForbiddenProductAgentName(value) {
  return FORBIDDEN_PRODUCT_AGENT_NAMES.includes(normalizeProfileName(value));
}

function resolveOfficialProfileName(value, fallback = DEFAULT_PROFILE_NAME) {
  const normalized = normalizeProfileName(value);
  if (isOfficialProfileName(normalized)) return normalized;
  const normalizedFallback = normalizeProfileName(fallback);
  if (isOfficialProfileName(normalizedFallback)) return normalizedFallback;
  return DEFAULT_PROFILE_NAME;
}

function resolveRequestedOfficialProfile({ agentId, agent, fallback = DEFAULT_PROFILE_NAME } = {}) {
  return resolveOfficialProfileName(agentId || agent, fallback);
}

function resolveProductAgentName({ agentId, agent, fallback = DEFAULT_PROFILE_NAME } = {}) {
  const requested = normalizeProfileName(agentId || agent);
  if (!requested) return '';
  if (isForbiddenProductAgentName(requested)) return resolveOfficialProfileName('', fallback);
  return requested;
}

function createOfficialProfileAgent(value = DEFAULT_PROFILE_NAME, patch = {}) {
  const name = resolveOfficialProfileName(value);
  return {
    id: name,
    displayName: name,
    name,
    model: patch.model || 'Recommended',
    agentSource: 'hermes-cli',
    agentIdentity: {
      id: name,
      displayName: name,
      source: 'hermes-cli',
      resident: true,
      kind: 'mac-mini-hermes-profile',
    },
    profile: {
      name,
      isDefault: name === DEFAULT_PROFILE_NAME,
    },
    ...patch,
  };
}

module.exports = {
  createOfficialProfileAgent,
  DEFAULT_PROFILE_NAME,
  FORBIDDEN_PRODUCT_AGENT_NAMES,
  OFFICIAL_PROFILE_NAMES,
  isForbiddenProductAgentName,
  isOfficialProfileName,
  resolveProductAgentName,
  resolveOfficialProfileName,
  resolveRequestedOfficialProfile,
};
