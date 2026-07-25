type RecordValue = Record<string, unknown>;

function text(value: unknown, fallback = '') {
  return String(value || fallback);
}

function objectValue(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function arrays(payload: RecordValue | undefined, ...keys: string[]): RecordValue[] {
  for (const key of keys) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value as RecordValue[];
  }
  const data = objectValue(payload?.data);
  const nestedData = Object.keys(data).length ? arrays(data, ...keys) : [];
  if (nestedData.length) return nestedData;
  const state = objectValue(payload?.state);
  return Object.keys(state).length ? arrays(state, ...keys) : [];
}

function profileReadinessEntries(payload: RecordValue) {
  return arrays(payload, 'requiredProfiles', 'profiles');
}

function profileEntryName(entry: RecordValue) {
  return text(entry.profile || entry.name || entry.id || objectValue(entry.setup).profile, '').toLowerCase();
}

export function agentProfileName(agent: RecordValue) {
  const profile = objectValue(agent.profile);
  return text(agent.profileName || agent.profileId || profile.name || profile.profile || agent.name || agent.id, '').toLowerCase();
}

export function mergeAgentsWithProfileReadiness(agents: RecordValue[], readiness: RecordValue) {
  const entries = profileReadinessEntries(readiness);
  if (!entries.length) return agents;
  const byProfile = new Map<string, RecordValue>();
  entries.forEach((entry) => {
    const key = profileEntryName(entry);
    if (key) byProfile.set(key, entry);
  });
  return agents.map((agent) => {
    const key = agentProfileName(agent);
    const profileStatus = key ? byProfile.get(key) : undefined;
    if (!profileStatus) return agent;
    return {
      ...agent,
      hermesProfileName: profileEntryName(profileStatus) || key,
      hermesProfileStatus: text(profileStatus.status, ''),
      hermesProfilePresent: profileStatus.present,
      hermesProfileSetup: profileStatus.setup,
      hermesDashboardProfile: profileStatus,
    };
  });
}

export function agentStatusLabel(agent: RecordValue) {
  if (agent.enabled === false) return '중지됨';
  const raw = text(agent.hermesProfileStatus || agent.profileStatus || agent.connectionStatus || agent.status, '').toLowerCase();
  if (agent.hermesProfilePresent === false || /missing|not-found|absent|누락|없음/.test(raw)) return '누락';
  if (/ready|준비/.test(raw)) return '준비됨';
  if (/busy|running|작업|executing/.test(raw)) return '작업중';
  if (/active|online|connected|활성/.test(raw)) return '활성';
  if (/idle|유휴/.test(raw)) return '유휴';
  if (/pending|requested|대기/.test(raw)) return '생성 대기';
  if (/unavailable|offline|disconnected|사용 불가/.test(raw)) return '사용 불가';
  if (/blocked|error|fail|오류/.test(raw)) return '확인 필요';
  return raw ? text(agent.hermesProfileStatus || agent.profileStatus || agent.status) : '상태 없음';
}

export function agentDisplayName(agent: RecordValue) {
  return text(agent.displayName || agent.name || agent.id || agent.hermesProfileName, 'agent');
}

export function agentSourceKind(agent: RecordValue): 'native' | 'connected' {
  const source = text(agent.sourceKind || agent.agentSource || agent.source, '').toLowerCase();
  if (source === 'connected' || /hermes|claude|codex|grok|external|import|connect/.test(source)) {
    return 'connected';
  }
  return 'native';
}

export function agentSourceLabel(agent: RecordValue) {
  if (agentSourceKind(agent) === 'native') return '사용자 생성';
  const provider = text(agent.provider || agent.runtime || agent.agentSource || agent.source, '외부').toLowerCase();
  if (provider.includes('hermes')) return 'Hermes 연결';
  if (provider.includes('claude')) return 'Claude 연결';
  if (provider.includes('codex')) return 'Codex 연결';
  if (provider.includes('grok')) return 'Grok 연결';
  return `${text(agent.provider || agent.runtime || agent.agentSource || agent.source, '외부')} 연결`;
}

export function groupAgentDirectory<T extends RecordValue>(agents: readonly T[]) {
  return {
    native: agents.filter((agent) => agentSourceKind(agent) === 'native'),
    connected: agents.filter((agent) => agentSourceKind(agent) === 'connected'),
  };
}

export function agentConnectionLabel(agent: RecordValue, context: { readonly runnerConnected?: boolean } = {}) {
  if (agent.enabled === false) return '중지됨';
  if (agentSourceKind(agent) === 'connected' && !context.runnerConnected) return 'Runner 필요';
  const raw = text(agent.connectionStatus || agent.hermesProfileStatus || agent.status, '').toLowerCase();
  if (/error|failed|blocked|오류/.test(raw)) return '확인 필요';
  if (/offline|unavailable|disconnected|사용 불가/.test(raw)) return '연결 끊김';
  if (agentSourceKind(agent) === 'connected') return '연결됨';
  return agentStatusLabel(agent);
}

export function isAgentSelectable(
  agent: RecordValue,
  context: { readonly runnerConnected?: boolean } | number = {},
) {
  const runnerConnected = typeof context === 'number' ? undefined : context.runnerConnected;
  return agent.hermesProfilePresent !== false
    && !agent.pending
    && !(agentSourceKind(agent) === 'connected' && runnerConnected === false)
    && !/missing|누락|pending|requested|unavailable|offline|disconnected|사용 불가/i.test(text(agent.hermesProfileStatus || agent.status));
}
