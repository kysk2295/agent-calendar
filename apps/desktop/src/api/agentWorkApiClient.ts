import { hermesApi } from './hermesApi';
import { createAgentWorkClient, createdWorkIdentity } from '../features/agent-operations/workConversationClient';
import type { AgentMissionCreateInput } from '../features/agent-operations/types';
import type { AgentCreatedWork, AgentWorkMessageResponse } from '../features/agent-operations/workConversationTypes';

const agentWorkClient = createAgentWorkClient({
  transport: hermesApi,
  createId: () => globalThis.crypto.randomUUID(),
});

export async function createAgentWork(input: AgentMissionCreateInput): Promise<AgentCreatedWork> {
  const response = await agentWorkClient.create({
    templateId: input.templateId,
    title: input.title,
    objective: input.objective,
    initialMessage: input.objective,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    executionEngine: input.executionEngine,
    deliverable: input.deliverable,
  });
  return createdWorkIdentity(response);
}

export function sendAgentWorkMessage(missionId: string, text: string): Promise<AgentWorkMessageResponse> {
  return agentWorkClient.send(missionId, text);
}
