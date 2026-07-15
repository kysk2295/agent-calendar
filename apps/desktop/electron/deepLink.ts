export type AgentCalendarDeepLink = Readonly<{
  kind: 'session';
  sessionId: string;
}>;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function parseAgentCalendarDeepLink(value: unknown): AgentCalendarDeepLink | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'agent-calendar:'
    || url.hostname !== 'sessions'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) return null;
  const sessionId = url.pathname.startsWith('/') ? url.pathname.slice(1) : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return { kind: 'session', sessionId };
}

export function findAgentCalendarDeepLink(values: readonly unknown[]): AgentCalendarDeepLink | null {
  for (const value of values) {
    const target = parseAgentCalendarDeepLink(value);
    if (target) return target;
  }
  return null;
}
