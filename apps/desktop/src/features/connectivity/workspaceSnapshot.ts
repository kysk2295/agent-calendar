export type WorkspacePresentationSnapshot = Readonly<{
  presentationSchemaVersion: 1;
  state: Record<string, unknown>;
  agentOperations: Record<string, unknown>;
  calendarSources: unknown[];
  calendarCoverageNote: string;
  connectedAutomationSources: unknown[];
  automationRunners: unknown[];
  calendarAiMemories: unknown[];
  calendarAiConversationId: string;
  chatMessages: unknown[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseWorkspacePresentationSnapshot(
  input: unknown,
): WorkspacePresentationSnapshot | null {
  if (!isRecord(input) || input.presentationSchemaVersion !== 1) return null;
  if (!isRecord(input.state) || !isRecord(input.agentOperations)) return null;
  for (const key of [
    'tasks',
    'events',
    'agents',
    'runs',
    'docs',
    'inbox',
    'automation',
    'channels',
    'sessions',
    'tools',
    'chatMessages',
    'taxonomy',
  ]) {
    if (!Array.isArray(input.state[key])) return null;
  }
  for (const key of [
    'wiki',
    'settings',
    'usage',
    'gatewayStatus',
    'profileReadiness',
    'agentSourceStatus',
  ]) {
    if (!isRecord(input.state[key])) return null;
  }
  if (
    !Array.isArray(input.calendarSources)
    || !Array.isArray(input.connectedAutomationSources)
    || !Array.isArray(input.automationRunners)
    || !Array.isArray(input.calendarAiMemories)
    || !Array.isArray(input.chatMessages)
  ) {
    return null;
  }
  if (
    typeof input.calendarCoverageNote !== 'string'
    || typeof input.calendarAiConversationId !== 'string'
  ) {
    return null;
  }
  return {
    presentationSchemaVersion: 1,
    state: input.state,
    agentOperations: input.agentOperations,
    calendarSources: input.calendarSources,
    calendarCoverageNote: input.calendarCoverageNote,
    connectedAutomationSources: input.connectedAutomationSources,
    automationRunners: input.automationRunners,
    calendarAiMemories: input.calendarAiMemories,
    calendarAiConversationId: input.calendarAiConversationId,
    chatMessages: input.chatMessages,
  };
}
