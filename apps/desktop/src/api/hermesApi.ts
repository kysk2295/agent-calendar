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

export {
  AgentWorkPaginationError,
  agentWorkPollDelay,
  createAgentWorkClient,
  createdWorkIdentity,
  loadCompleteAgentWorkConversation,
} from '../features/agent-operations/workConversationClient';
export { executionEngineLabel } from '../features/agent-operations/executionContracts';
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
} from '../features/agent-operations/workConversationPresentation';
export type * from '../features/agent-operations/workConversationTypes';

export type ApiEnvelope = Record<string, unknown>;

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
const AGENT_OPERATIONS_TIMEOUT_MS = 400_000;
const WIKI_SEARCH_TIMEOUT_MS = 60_000;
const WIKI_ASK_TIMEOUT_MS = 150_000;

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
  createCalendarEvent: (body: Record<string, unknown>) => jsonPost('/api/calendar/events', body),
  updateCalendarEvent: (id: string, body: Record<string, unknown>) => hermesJson<ApiEnvelope>(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCalendarEvent: (id: string, body: Record<string, unknown> = {}) => hermesJson<ApiEnvelope>(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body) }),
  getInbox: () => hermesJson<ApiEnvelope>('/api/inbox/commands?limit=200'),
  saveMailAccount: (body: Record<string, unknown>) => jsonPost('/api/mail/accounts', body),
  syncMail: (body: Record<string, unknown> = {}) => jsonPost('/api/mail/sync', body),
  runInboxCommand: (id: string, action: string, body: Record<string, unknown> = {}) => jsonPost(`/api/inbox/commands/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, body),
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
  askSchedule: (body: Record<string, unknown>) => jsonPost('/api/assistant/ask', body, SCHEDULE_ASK_TIMEOUT_MS),
  ingestSchedule: (body: FormData) => hermesJson<ApiEnvelope>('/api/assistant/ingest', { method: 'POST', body }, SCHEDULE_ASK_TIMEOUT_MS),
  getAgents: () => hermesJson<ApiEnvelope>('/api/agents'),
  getAgentOperations: () => hermesJson<unknown>('/api/agent-operations', undefined, AGENT_OPERATIONS_TIMEOUT_MS),
  createAgentWork: (body: AgentWorkCreateRequest): Promise<AgentWorkCreateResponse> => hermesJson<unknown>('/api/agent-operations/work', {
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
  tickAgentOperations: () => hermesJson<unknown>('/api/agent-operations/tick', { method: 'POST', body: '{}' }, AGENT_OPERATIONS_TIMEOUT_MS),
  createAgent: (body: Record<string, unknown>) => jsonPost('/api/agents', body),
  getChannels: () => hermesJson<ApiEnvelope>('/api/channels/status'),
  getAutomation: () => hermesJson<ApiEnvelope>('/api/scheduler/jobs'),
  createSchedulerJob: (body: Record<string, unknown>) => jsonPost('/api/scheduler/jobs', body),
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
  draftCalendarWork: (body: Record<string, unknown>) => jsonPost('/api/calendar/draft', body),
  quickAddCalendarWork: (body: Record<string, unknown>) => jsonPost('/api/calendar/quick-add', body),
  convertWorkboard: (body: Record<string, unknown>) => jsonPost('/api/workboard/convert', body),
  streamChat: (body: Record<string, unknown>) => proxyFetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WIKI_ASK_TIMEOUT_MS),
  }),
};
