import type { AgentMissionCreateInput, AgentTaskAction } from '../features/agent-operations/types';
import {
  parseAgentWorkConversationPage,
  parseAgentWorkCreateResponse,
  parseAgentWorkMessageResponse,
} from '../features/agent-operations/workConversationParser';
import type {
  AgentWorkConversationPage,
  AgentWorkCreateRequest,
  AgentWorkCreateResponse,
  AgentWorkLiveTurnRequest,
  AgentWorkMessageRequest,
  AgentWorkMessageResponse,
} from '../features/agent-operations/workConversationTypes';
import type {
  AgentWorkIntakePreview,
  AgentWorkIntakeRequest,
  AgentWorkIntakeStartRequest,
} from '../features/agent-operations/workConversationClient';

export {
  AgentWorkPaginationError,
  agentWorkPollDelay,
  createAgentWorkClient,
  createdWorkIdentity,
  loadCompleteAgentWorkConversation,
} from '../features/agent-operations/workConversationClient';
export {
  executionEngineLabel,
  resolvedExecutionEngineLabel,
} from '../features/agent-operations/executionContracts';
export {
  AgentWorkParseError,
  compareAgentWorkCheckpoints,
  parseAgentWorkConversationPage,
  parseAgentWorkCreateResponse,
  parseAgentWorkMessageResponse,
} from '../features/agent-operations/workConversationParser';
export {
  deliveryApplicationLabel,
  deliveryStatusLabel,
  responsibleAgentAssignmentCopy,
  responsibleAgentLabel,
  telegramIngressOwnershipLabel,
  telegramIngressReadinessLabel,
} from '../features/agent-operations/workConversationPresentation';
export type * from '../features/agent-operations/workConversationTypes';

export type ApiEnvelope = Record<string, unknown>;

export const CLIENT_V1_CONTRACT_ID = 'client-v1';
export const CLIENT_V1_MEDIA_TYPE = 'application/vnd.agent-calendar.client-v1+json';
export const CLIENT_CONTRACT_HEADER = 'x-agent-calendar-contract';

export class HermesApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path: string;

  constructor(status: number, code: string, message: string, path: string) {
    super(message);
    this.name = 'HermesApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

let apiBaseUrl = '';
let proxyCredential = '';
const PROXY_CREDENTIAL_HEADER = 'x-agent-calendar-proxy-credential';
const API_TIMEOUT_MS = 6500;
const SCHEDULE_ASK_TIMEOUT_MS = 45_000;
const SCHEDULE_INGEST_TIMEOUT_MS = 210_000;
const AGENT_OPERATIONS_TIMEOUT_MS = 400_000;
const WIKI_SEARCH_TIMEOUT_MS = 60_000;
const WIKI_ASK_TIMEOUT_MS = 150_000;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function setApiBaseUrl(baseUrl: string) {
  apiBaseUrl = String(baseUrl || '').replace(/\/+$/g, '');
  proxyCredential = '';
}

export function setApiProxyConnection(connection: Readonly<{ baseUrl: string; credential: string }>) {
  apiBaseUrl = connection.baseUrl.replace(/\/+$/g, '');
  proxyCredential = connection.credential;
}

function url(path: string) {
  return `${apiBaseUrl}${path}`;
}

function proxyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = String(init.method || 'GET').toUpperCase();
  headers.set(CLIENT_CONTRACT_HEADER, CLIENT_V1_CONTRACT_ID);
  if (!headers.has('accept')) {
    headers.set('accept', `${CLIENT_V1_MEDIA_TYPE}, application/json`);
  }
  if (MUTATING_METHODS.has(method)) {
    const requestId = headers.get('x-client-request-id')
      || headers.get('idempotency-key')
      || crypto.randomUUID();
    if (!headers.has('x-client-request-id')) {
      headers.set('x-client-request-id', requestId);
    }
    if (!headers.has('idempotency-key')) {
      headers.set('idempotency-key', requestId);
    }
  }
  if (proxyCredential) headers.set(PROXY_CREDENTIAL_HEADER, proxyCredential);
  return fetch(url(path), { ...init, headers });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseError(response: Response, path: string): Promise<HermesApiError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const source = isRecord(payload) ? payload : {};
  const code = typeof source.error === 'string' ? source.error : 'api_request_failed';
  const message = typeof source.message === 'string'
    ? source.message
    : `Agents Calendar API ${response.status} ${path}`;
  return new HermesApiError(response.status, code, message, path);
}

async function hermesJson<T>(path: string, init?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  try {
    const headers = new Headers(init?.headers);
    if (!isFormData && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await proxyFetch(path, {
      ...init,
      headers,
      signal: init?.signal || controller.signal,
    });
    if (!response.ok) throw await responseError(response, path);
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (init?.signal?.aborted) throw error;
      throw new HermesApiError(0, 'api_timeout', `Agents Calendar API timeout ${path}`, path);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function jsonPost(path: string, body: Record<string, unknown> = {}, timeoutMs = API_TIMEOUT_MS) {
  return hermesJson<ApiEnvelope>(path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs);
}

export const hermesApi = {
  getGatewayStatus: () => hermesJson<ApiEnvelope>('/api/gateway-status'),
  getClientContract: () => hermesJson<ApiEnvelope>('/api/contracts/client-v1'),
  getDashboardState: () => hermesJson<ApiEnvelope>('/api/state'),
  getTasks: () => hermesJson<ApiEnvelope>('/api/tasks'),
  createTask: (body: Record<string, unknown>) => jsonPost('/api/tasks', body),
  updateTask: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTask: (id: string, body: Record<string, unknown> = {}) => hermesJson<ApiEnvelope>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body) }),
  getCalendarEvents: (options: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    return hermesJson<ApiEnvelope>(`/api/calendar/events${params.toString() ? `?${params}` : ''}`);
  },
  getUnifiedCalendar: (options: { from: string; to: string; sourceIds?: string } ) => {
    const params = new URLSearchParams();
    params.set('from', options.from);
    params.set('to', options.to);
    if (options.sourceIds) params.set('sourceIds', options.sourceIds);
    return hermesJson<ApiEnvelope>(`/api/calendar/unified?${params.toString()}`);
  },
  getCalendarSources: () => hermesJson<ApiEnvelope>('/api/calendar/sources'),
  syncCalendarSource: (id: string, body: Record<string, unknown> = {}) => hermesJson<ApiEnvelope>(`/api/calendar/sources/${encodeURIComponent(id)}/sync`, { method: 'POST', body: JSON.stringify(body) }),
  disconnectCalendarSource: (id: string) => hermesJson<ApiEnvelope>(`/api/calendar/sources/${encodeURIComponent(id)}/disconnect`, { method: 'POST', body: '{}' }),
  createExternalCalendarEvent: (body: Record<string, unknown>) => jsonPost('/api/calendar/external/events', body),
  updateExternalCalendarEvent: (providerEventId: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(
    `/api/calendar/external/events/${encodeURIComponent(providerEventId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  ),
  createCalendarEvent: (body: Record<string, unknown>) => jsonPost('/api/calendar/events', body),
  updateCalendarEvent: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCalendarEvent: (id: string, body: Record<string, unknown> = {}) => hermesJson<ApiEnvelope>(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body) }),
  getMailMessages: () => hermesJson<ApiEnvelope>('/api/mail/messages?limit=200'),
  getWorkboard: () => hermesJson<ApiEnvelope>('/api/workboard'),
  getDocuments: () => hermesJson<ApiEnvelope>('/api/documents'),
  createDocument: (body: Record<string, unknown>) => jsonPost('/api/documents', body),
  getWiki: (options: { path?: string; query?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.path) params.set('path', options.path);
    if (options.query) params.set('query', options.query);
    return hermesJson<ApiEnvelope>(`/api/wiki${params.toString() ? `?${params}` : ''}`);
  },
  askWiki: (body: Record<string, unknown>) => jsonPost('/api/wiki/ask', body, WIKI_ASK_TIMEOUT_MS),
  searchWiki: (body: Record<string, unknown>) => jsonPost('/api/wiki/search', body, WIKI_SEARCH_TIMEOUT_MS),
  getKnowledgeSources: () => hermesJson<ApiEnvelope>('/api/knowledge/sources'),
  createKnowledgeSource: (body: Record<string, unknown>) => jsonPost('/api/knowledge/sources', body),
  ingestKnowledge: (body: Record<string, unknown>) => jsonPost('/api/knowledge/ingest', body, WIKI_ASK_TIMEOUT_MS),
  registerPrivateLocalKnowledge: (body: Record<string, unknown>) => jsonPost('/api/knowledge/private-local/register', body),
  revokeKnowledgeSource: (id: string) => jsonPost(`/api/knowledge/sources/${encodeURIComponent(id)}/revoke`, {}),
  askKnowledge: (body: Record<string, unknown>) => jsonPost('/api/knowledge/ask', body, WIKI_ASK_TIMEOUT_MS),
  getKnowledgeSearchJob: (id: string) => hermesJson<ApiEnvelope>(`/api/knowledge/search/jobs/${encodeURIComponent(id)}`),
  resolveKnowledgeEvidence: (handle: string) => hermesJson<ApiEnvelope>(`/api/knowledge/evidence/${encodeURIComponent(handle)}`),
  askSchedule: (body: Record<string, unknown>) => jsonPost('/api/assistant/ask', body, SCHEDULE_ASK_TIMEOUT_MS),
  ingestSchedule: (body: FormData) => hermesJson<ApiEnvelope>('/api/assistant/ingest', { method: 'POST', body }, SCHEDULE_INGEST_TIMEOUT_MS),
  getAgents: () => hermesJson<ApiEnvelope>('/api/agents'),
  getAgentOperations: () => hermesJson<unknown>('/api/agent-operations', undefined, AGENT_OPERATIONS_TIMEOUT_MS),
  createAgentWork: (body: AgentWorkCreateRequest): Promise<AgentWorkCreateResponse> => hermesJson<unknown>('/api/agent-operations/work', {
    method: 'POST',
    body: JSON.stringify(body),
  }, AGENT_OPERATIONS_TIMEOUT_MS).then(parseAgentWorkCreateResponse),
  previewAgentWork: (body: AgentWorkIntakeRequest): Promise<AgentWorkIntakePreview> => hermesJson<{
    preview: AgentWorkIntakePreview;
  }>('/api/work-intake/preview', {
    method: 'POST',
    body: JSON.stringify(body),
  }, AGENT_OPERATIONS_TIMEOUT_MS).then((response) => response.preview),
  startAgentWork: (body: AgentWorkIntakeStartRequest): Promise<AgentWorkCreateResponse> => hermesJson<unknown>('/api/work-intake/start', {
    method: 'POST',
    body: JSON.stringify(body),
  }, AGENT_OPERATIONS_TIMEOUT_MS).then(parseAgentWorkCreateResponse),
  getAgentWorkConversation: (missionId: string, options: Readonly<{ cursor?: string; limit?: number; signal?: AbortSignal }> = {}): Promise<AgentWorkConversationPage> => {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    return hermesJson<unknown>(`/api/agent-operations/work/${encodeURIComponent(missionId)}/conversation${query ? `?${query}` : ''}`, options.signal ? { signal: options.signal } : undefined, AGENT_OPERATIONS_TIMEOUT_MS).then(parseAgentWorkConversationPage);
  },
  sendAgentWorkMessage: (missionId: string, body: AgentWorkMessageRequest): Promise<AgentWorkMessageResponse> => hermesJson<unknown>(`/api/agent-operations/work/${encodeURIComponent(missionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, AGENT_OPERATIONS_TIMEOUT_MS).then(parseAgentWorkMessageResponse),
  createAgentWorkHandoff: (missionId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agent-operations/work/${encodeURIComponent(missionId)}/handoffs`,
    body,
    AGENT_OPERATIONS_TIMEOUT_MS,
  ),
  cancelAgentWorkHandoff: (missionId: string, handoffId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agent-operations/work/${encodeURIComponent(missionId)}/handoffs/${encodeURIComponent(handoffId)}/cancel`,
    body,
    AGENT_OPERATIONS_TIMEOUT_MS,
  ),
  transitionAgentWorkProviderSession: (missionId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agent-operations/work/${encodeURIComponent(missionId)}/provider-session-transitions`,
    body,
    AGENT_OPERATIONS_TIMEOUT_MS,
  ),
  adoptAgentWorkComparisonResult: (missionId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agent-operations/work/${encodeURIComponent(missionId)}/comparison/adopt`,
    body,
    AGENT_OPERATIONS_TIMEOUT_MS,
  ),
  streamAgentWorkTurn: async (missionId: string, body: AgentWorkLiveTurnRequest, signal?: AbortSignal): Promise<Response> => {
    const response = await proxyFetch(`/api/agent-operations/work/${encodeURIComponent(missionId)}/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await responseError(response, `/api/agent-operations/work/${encodeURIComponent(missionId)}/live`);
    return response;
  },
  createAgentMission: (body: AgentMissionCreateInput) => hermesJson<unknown>('/api/agent-operations/missions', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  planAgentMission: (missionId: string) => hermesJson<unknown>(`/api/agent-operations/missions/${encodeURIComponent(missionId)}/plan`, { method: 'POST', body: '{}' }, AGENT_OPERATIONS_TIMEOUT_MS),
  activateAgentMission: (missionId: string) => hermesJson<unknown>(`/api/agent-operations/missions/${encodeURIComponent(missionId)}/activate`, { method: 'POST', body: '{}' }),
  transitionAgentMission: (missionId: string, action: 'pause' | 'cancel') => hermesJson<unknown>(`/api/agent-operations/missions/${encodeURIComponent(missionId)}/${action}`, { method: 'POST', body: '{}' }),
  transitionAgentTask: (taskId: string, action: AgentTaskAction) => hermesJson<unknown>(`/api/agent-operations/tasks/${encodeURIComponent(taskId)}/${encodeURIComponent(action)}`, { method: 'POST', body: '{}' }),
  runAgentTaskNow: (taskId: string) => hermesJson<unknown>(`/api/agent-operations/tasks/${encodeURIComponent(taskId)}/run-now`, { method: 'POST', body: '{}' }),
  getAgentSession: (sessionId: string) => hermesJson<unknown>(`/api/agent-operations/sessions/${encodeURIComponent(sessionId)}`),
  sendAgentSessionMessage: (sessionId: string, text: string) => hermesJson<unknown>(`/api/agent-operations/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  }),
  recordAgentReportFeedback: (reportId: string, useful: boolean, note = '') => hermesJson<unknown>(`/api/agent-operations/reports/${encodeURIComponent(reportId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ useful, note }),
  }),
  recordAgentFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => hermesJson<unknown>(`/api/agent-operations/reports/${encodeURIComponent(reportId)}/follow-ups`, {
    method: 'POST',
    body: JSON.stringify({ index, decision }),
  }),
  createAgent: (body: Record<string, unknown>) => jsonPost('/api/agents', body),
  createAgentBuilderDraft: (body: Record<string, unknown>) => jsonPost('/api/agents/builder', body),
  reviewAgentBuilderDraft: (agentId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agents/${encodeURIComponent(agentId)}/review`,
    body,
  ),
  startAgentBuilderTest: (agentId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agents/${encodeURIComponent(agentId)}/tests`,
    body,
    AGENT_OPERATIONS_TIMEOUT_MS,
  ),
  getAgentBuilderTest: (agentId: string, requestId: string) => hermesJson<ApiEnvelope>(
    `/api/agents/${encodeURIComponent(agentId)}/tests/${encodeURIComponent(requestId)}`,
    undefined,
    AGENT_OPERATIONS_TIMEOUT_MS,
  ),
  cancelAgentBuilderTest: (agentId: string, requestId: string) => jsonPost(
    `/api/agents/${encodeURIComponent(agentId)}/tests/${encodeURIComponent(requestId)}/cancel`,
    {},
  ),
  activateAgentBuilderProfile: (agentId: string, body: Record<string, unknown>) => jsonPost(
    `/api/agents/${encodeURIComponent(agentId)}/activate`,
    body,
  ),
  listAgentProfileVersions: (agentId: string) => hermesJson<ApiEnvelope>(
    `/api/agents/${encodeURIComponent(agentId)}/profile-versions`,
  ),
  updateAgent: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  requestAgentCatalog: (body: Record<string, unknown>) => jsonPost('/api/agents/catalog/requests', body),
  getAgentCatalogRequest: (id: string) => hermesJson<ApiEnvelope>(`/api/agents/catalog/requests/${encodeURIComponent(id)}`),
  importAgentCatalogEntry: (id: string, body: Record<string, unknown>) => jsonPost(`/api/agents/catalog/requests/${encodeURIComponent(id)}/import`, body),
  listProviderAgentSessions: (agentId: string, options: { search?: string; archived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.archived) params.set('archived', 'true');
    const query = params.toString();
    return hermesJson<ApiEnvelope>(`/api/agents/${encodeURIComponent(agentId)}/sessions${query ? `?${query}` : ''}`);
  },
  requestProviderSessionCatalog: (agentId: string, body: Record<string, unknown>) => jsonPost(`/api/agents/${encodeURIComponent(agentId)}/sessions/catalog/requests`, body),
  importProviderSessionCatalogEntry: (agentId: string, requestId: string, body: Record<string, unknown>) => jsonPost(`/api/agents/${encodeURIComponent(agentId)}/sessions/catalog/requests/${encodeURIComponent(requestId)}/import`, body),
  updateProviderAgentSession: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/agent-sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  getChannels: () => hermesJson<ApiEnvelope>('/api/channels/status'),
  getAutomation: () => hermesJson<ApiEnvelope>('/api/scheduler/jobs'),
  listAutomationSources: () => hermesJson<ApiEnvelope>('/api/automation/sources'),
  connectAutomationSource: (body: Record<string, unknown>) => jsonPost('/api/automation/sources', body),
  syncAutomationSource: (id: string) => jsonPost(`/api/automation/sources/${encodeURIComponent(id)}/sync`, {}),
  listConnectedAutomations: () => hermesJson<ApiEnvelope>('/api/automation/automations'),
  listAutomationOccurrences: (query = '') => hermesJson<ApiEnvelope>(`/api/automation/occurrences${query}`),
  requestAutomationChange: (body: Record<string, unknown>) => jsonPost('/api/automation/changes', body),
  approveAutomationChange: (id: string, body: Record<string, unknown> = {}) => jsonPost(`/api/automation/changes/${encodeURIComponent(id)}/approve`, body),
  createSchedulerJob: (body: Record<string, unknown>) => jsonPost('/api/scheduler/jobs', body),
  updateSchedulerJob: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/scheduler/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSchedulerJob: (id: string) => hermesJson<ApiEnvelope>(`/api/scheduler/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runSchedulerJob: (id: string) => jsonPost(`/api/scheduler/jobs/${encodeURIComponent(id)}/run`),
  getUsage: () => hermesJson<ApiEnvelope>('/api/usage'),
  getTools: () => hermesJson<ApiEnvelope>('/api/tools'),
  getSettings: () => hermesJson<ApiEnvelope>('/api/settings'),
  saveSettings: (body: Record<string, unknown>) => jsonPost('/api/settings', body),
  getChatMessages: (target?: string) => hermesJson<ApiEnvelope>(`/api/chat/messages${target ? `?target=${encodeURIComponent(target)}` : ''}`),
  getEvents: () => proxyFetch('/api/events', { headers: { accept: 'text/event-stream' } }),
  createRun: (body: Record<string, unknown>) => jsonPost('/api/runs', body),
  launchMission: (body: Record<string, unknown>) => jsonPost('/api/missions/launch', body),
  getRun: (id: string) => hermesJson<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}`),
  approveRun: (id: string) => jsonPost(`/api/runs/${encodeURIComponent(id)}/approve`),
  quickAddCalendarWork: (body: Record<string, unknown>) => jsonPost('/api/calendar/quick-add', body),
  streamChat: (body: Record<string, unknown>) => proxyFetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WIKI_ASK_TIMEOUT_MS),
  }),
  listCalendarAiConversations: () => hermesJson<ApiEnvelope>('/api/calendar-ai/conversations'),
  getCalendarAiConversation: (id: string) => hermesJson<ApiEnvelope>(`/api/calendar-ai/conversations/${encodeURIComponent(id)}`),
  listCalendarAiMemories: () => hermesJson<ApiEnvelope>('/api/calendar-ai/memories'),
  updateCalendarAiMemory: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/calendar-ai/memories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  forgetCalendarAiMemory: (id: string) => hermesJson<ApiEnvelope>(`/api/calendar-ai/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  purgeCalendarAiMemory: (id: string) => hermesJson<ApiEnvelope>(`/api/calendar-ai/memories/${encodeURIComponent(id)}/purge`, {
    method: 'DELETE',
  }),
  approveCalendarAiAction: (id: string, requestId: string) => jsonPost(`/api/calendar-ai/actions/${encodeURIComponent(id)}/approve`, { requestId }),
  reviseCalendarAiAction: (id: string, input: Record<string, unknown>) => jsonPost(`/api/calendar-ai/actions/${encodeURIComponent(id)}/revise`, { input }),
  cancelCalendarAiAction: (id: string) => jsonPost(`/api/calendar-ai/actions/${encodeURIComponent(id)}/cancel`),
  // Phase 2 account-bound Runner (user session only — never device credentials)
  listRunners: () => hermesJson<ApiEnvelope>('/api/runners'),
  getRunnerReleaseManifest: () => hermesJson<ApiEnvelope>('/api/runners/release-manifest'),
  startRunnerEnrollment: (body: Record<string, unknown> = {}) => jsonPost('/api/runners/enrollments', body),
  getRunnerEnrollment: (id: string) => hermesJson<ApiEnvelope>(`/api/runners/enrollments/${encodeURIComponent(id)}`),
  confirmRunnerEnrollment: (id: string) => jsonPost(`/api/runners/enrollments/${encodeURIComponent(id)}/confirm`),
  rejectRunnerEnrollment: (id: string) => jsonPost(`/api/runners/enrollments/${encodeURIComponent(id)}/reject`),
  testRunner: (id: string) => jsonPost(`/api/runners/${encodeURIComponent(id)}/test`),
  revokeRunner: (id: string) => jsonPost(`/api/runners/${encodeURIComponent(id)}/revoke`),
};
