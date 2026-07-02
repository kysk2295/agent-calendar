export type ApiEnvelope = Record<string, unknown>;

let apiBaseUrl = '';

export function setApiBaseUrl(baseUrl: string) {
  apiBaseUrl = String(baseUrl || '').replace(/\/+$/g, '');
}

function url(path: string) {
  return `${apiBaseUrl}${path}`;
}

async function hermesJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  if (!response.ok) throw new Error(`Hermes API ${response.status} ${path}`);
  return response.json() as Promise<T>;
}

function jsonPost(path: string, body: Record<string, unknown> = {}) {
  return hermesJson<ApiEnvelope>(path, { method: 'POST', body: JSON.stringify(body) });
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
  getWiki: (options: { path?: string; query?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.path) params.set('path', options.path);
    if (options.query) params.set('query', options.query);
    return hermesJson<ApiEnvelope>(`/api/wiki${params.toString() ? `?${params}` : ''}`);
  },
  askWiki: (body: Record<string, unknown>) => jsonPost('/api/wiki/ask', body),
  getAgents: () => hermesJson<ApiEnvelope>('/api/agents'),
  getChannels: () => hermesJson<ApiEnvelope>('/api/channels/status'),
  getAutomation: () => hermesJson<ApiEnvelope>('/api/scheduler/jobs'),
  createSchedulerJob: (body: Record<string, unknown>) => jsonPost('/api/scheduler/jobs', body),
  runSchedulerJob: (id: string) => jsonPost(`/api/scheduler/jobs/${encodeURIComponent(id)}/run`),
  getUsage: () => hermesJson<ApiEnvelope>('/api/usage'),
  getTools: () => hermesJson<ApiEnvelope>('/api/tools'),
  getSettings: () => hermesJson<ApiEnvelope>('/api/settings'),
  getChatMessages: (target?: string) => hermesJson<ApiEnvelope>(`/api/chat/messages${target ? `?target=${encodeURIComponent(target)}` : ''}`),
  getEvents: () => fetch(url('/api/events'), { headers: { accept: 'text/event-stream' } }),
  createRun: (body: Record<string, unknown>) => jsonPost('/api/runs', body),
  getRun: (id: string) => hermesJson<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}`),
  draftCalendarWork: (body: Record<string, unknown>) => jsonPost('/api/calendar/draft', body),
  quickAddCalendarWork: (body: Record<string, unknown>) => jsonPost('/api/calendar/quick-add', body),
  convertWorkboard: (body: Record<string, unknown>) => jsonPost('/api/workboard/convert', body),
  streamChat: (body: Record<string, unknown>) => fetch(url('/api/chat/stream'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }),
};
