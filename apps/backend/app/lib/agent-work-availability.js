const UNAVAILABLE_STATUS = /(?:^|[\s_-])(stopped|stopping|paused|disabled|offline|unavailable|missing|pending|requested|error|failed)(?:$|[\s_-])|중지|일시정지|사용\s*불가|누락|오류/iu;

function text(value) {
  return String(value || '').trim();
}

function normalized(value) {
  return text(value).toLowerCase();
}

function agentKeys(agent = {}) {
  const profile = agent.profile && typeof agent.profile === 'object' ? agent.profile : {};
  return [agent.id, agent.name, agent.displayName, agent.profileName, profile.name, profile.profile]
    .map(normalized)
    .filter(Boolean);
}

function profileEntries(profileReadiness = {}) {
  if (!profileReadiness || typeof profileReadiness !== 'object' || Array.isArray(profileReadiness)) return [];
  return Array.isArray(profileReadiness.requiredProfiles)
    ? profileReadiness.requiredProfiles
    : Array.isArray(profileReadiness.profiles)
      ? profileReadiness.profiles
      : [];
}

function profileKey(profile = {}) {
  return normalized(profile.profile || profile.name || profile.id);
}

function blocked(status) {
  return UNAVAILABLE_STATUS.test(normalized(status));
}

function disabled(agent = {}) {
  const dashboardSettings = agent.dashboardSettings && typeof agent.dashboardSettings === 'object'
    ? agent.dashboardSettings
    : {};
  return agent.enabled === false || dashboardSettings.enabled === false;
}

function unavailable(status = 'unavailable') {
  const unavailableStatus = text(status) || 'unavailable';
  return {
    available: false,
    code: 'agent_unavailable',
    status: unavailableStatus,
    message: unavailableStatus === 'disabled'
      ? '담당 에이전트가 현재 중지되어 응답을 시작하지 않았습니다. 활성화한 뒤 다시 시도해 주세요.'
      : '담당 에이전트가 현재 준비되지 않아 응답을 시작하지 않았습니다. 준비된 뒤 다시 시도해 주세요.',
  };
}

function resolveLiveWorkAgentAvailability({ agentId, agents = [], profileReadiness = null } = {}) {
  const target = normalized(agentId);
  if (!target) return { available: true };

  const profile = profileEntries(profileReadiness).find((entry) => profileKey(entry) === target);
  if (profile && (profile.present === false || blocked(profile.status))) {
    return unavailable(profile.status || (profile.present === false ? 'missing' : 'unavailable'));
  }

  const agent = (Array.isArray(agents) ? agents : []).find((entry) => agentKeys(entry).includes(target));
  if (agent && disabled(agent)) {
    return unavailable('disabled');
  }

  if (agent && blocked(agent.status || agent.profileStatus || agent.runtimeStatus)) {
    return unavailable(agent.status || agent.profileStatus || agent.runtimeStatus);
  }

  return { available: true };
}

module.exports = {
  resolveLiveWorkAgentAvailability,
};
