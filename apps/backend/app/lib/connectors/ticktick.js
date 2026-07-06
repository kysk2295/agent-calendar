const { cleanTickTickTitle, isExecutableTickTickTask } = require('../store');

function extractTags(text) {
  return String(text || '').match(/#\S+/g) || [];
}

function normalizeTickTickTask(task) {
  const combined = [task.title, task.content].filter(Boolean).join(' ');
  const executable = isExecutableTickTickTask(combined);
  const completedTime = task.completedTime || '';
  return {
    id: task.id || task.taskId || '',
    title: cleanTickTickTitle(task.title || task.content || ''),
    original: task.title || task.content || '',
    content: task.content || '',
    tags: extractTags(combined),
    due: task.dueDate || task.startDate || task.date || '',
    startDate: task.startDate || '',
    dueDate: task.dueDate || '',
    projectId: task.projectId || task.ticktickProjectId || '',
    ticktickProjectId: task.ticktickProjectId || task.projectId || '',
    status: completedTime ? 2 : task.status || 'open',
    completedTime,
    completedUserId: task.completedUserId || '',
    executable,
  };
}

function createTickTickSyncPlan({ tasks = [] } = {}) {
  const normalized = tasks.map(normalizeTickTickTask);
  return {
    executableTasks: normalized.filter((task) => task.executable),
    skippedTasks: normalized.filter((task) => !task.executable),
    total: normalized.length,
  };
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function looksLikeCalendarEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const title = pickFirst(value.title, value.summary, value.text, value.content, value.name);
  const start = pickFirst(value.startDate, value.startTime, value.start, value.begin, value.from, value.dtStart, value.dtstart);
  return Boolean(title && start);
}

function collectCalendarEventCandidates(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCalendarEventCandidates(item, output));
    return output;
  }
  if (looksLikeCalendarEvent(value)) {
    output.push(value);
    return output;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectCalendarEventCandidates(child, output);
  }
  return output;
}

function normalizeTickTickCalendarEvent(event = {}, index = 0) {
  const calendar = event.calendar || event.list || event.project || {};
  const fallbackId = `${event.title || event.summary || 'event'}:${event.startDate || event.start || index}`;
  const calendarName = compactText(pickFirst(event.calendarName, event.listName, event.projectName, calendar.name, calendar.title, event.accountName));
  return {
    id: compactText(pickFirst(event.id, event.uid, event.eventId, event.taskId, event.uuid, fallbackId)),
    title: cleanTickTickTitle(compactText(pickFirst(event.title, event.summary, event.text, event.content, event.name, 'Calendar event'))),
    original: compactText(pickFirst(event.title, event.summary, event.text, event.content, event.name)),
    startDate: compactText(pickFirst(event.startDate, event.startTime, event.start, event.begin, event.from, event.dtStart, event.dtstart)),
    dueDate: compactText(pickFirst(event.dueDate, event.endDate, event.endTime, event.end, event.until, event.to, event.dtEnd, event.dtend)),
    calendarId: compactText(pickFirst(event.calendarId, event.listId, event.projectId, calendar.id, calendar.uid)),
    calendarName,
    source: 'ticktick-calendar',
    sourceLabel: calendarName ? `TickTick calendar · ${calendarName}` : 'TickTick calendar',
  };
}

async function fetchTickTickCalendarEvents({
  webCookie,
  webApiBase = 'https://ticktick.com/api/v2',
  begin,
  end,
  fetchImpl = fetch,
} = {}) {
  if (!webCookie) {
    throw new Error('TickTick web session cookie is required for connected calendar events');
  }
  const base = String(webApiBase || 'https://ticktick.com/api/v2').replace(/\/+$/g, '');
  const response = await fetchImpl(`${base}/calendar/bind/events/all`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: String(webCookie),
    },
    body: JSON.stringify({ begin, end }),
  });
  if (!response.ok) {
    throw new Error(`TickTick calendar request failed: ${response.status}`);
  }
  const payload = await response.json();
  return collectCalendarEventCandidates(payload).map(normalizeTickTickCalendarEvent);
}

function normalizeCompletedTickTickTask(task = {}) {
  const completedTime = task.completedTime || task.completedDate || task.modifiedTime || '';
  return {
    ...task,
    id: task.id || task.taskId || '',
    title: task.title || task.content || '',
    dueDate: task.dueDate || task.due || '',
    startDate: task.startDate || task.date || '',
    completedTime,
    status: completedTime ? 2 : task.status || 2,
  };
}

function tickTickWebHeaders(webCookie) {
  if (!webCookie) {
    throw new Error('TickTick web session cookie is required');
  }
  return {
    accept: 'application/json',
    cookie: String(webCookie),
  };
}

async function tickTickWebJsonRequest({ webCookie, webApiBase = 'https://ticktick.com/api/v2', fetchImpl = fetch, path }) {
  const base = String(webApiBase || 'https://ticktick.com/api/v2').replace(/\/+$/g, '');
  const response = await fetchImpl(`${base}${path}`, {
    method: 'GET',
    headers: tickTickWebHeaders(webCookie),
  });
  if (!response.ok) {
    throw new Error(`TickTick web request failed: ${response.status}`);
  }
  return response.json();
}

function completedPayloadTasks(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.tasks)) return payload.tasks;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.tasks)) return payload.data.tasks;
  return [];
}

function formatTickTickCompletedDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function fetchTickTickCompletedTasks({
  webCookie,
  webApiBase = 'https://ticktick.com/api/v2',
  from = '',
  to,
  limit = 100,
  maxPages = 5,
  fetchImpl = fetch,
} = {}) {
  if (!webCookie) {
    throw new Error('TickTick web session cookie is required for completed tasks');
  }
  const byId = new Map();
  const endpoints = ['completedInAll', 'completed'];
  for (const endpoint of endpoints) {
    let pageTo = to || formatTickTickCompletedDate(new Date());
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({
        from: from || '',
        to: pageTo || '',
        limit: String(limit),
      });
      const payload = await tickTickWebJsonRequest({
        webCookie,
        webApiBase,
        fetchImpl,
        path: `/project/all/${endpoint}/?${query.toString()}`,
      });
      const tasks = completedPayloadTasks(payload).map(normalizeCompletedTickTickTask);
      for (const task of tasks) {
        const id = String(task.id || task.taskId || `${endpoint}:${task.title || task.content || byId.size}`);
        byId.set(id, {
          ...(byId.get(id) || {}),
          ...task,
          status: task.completedTime ? 2 : task.status || 2,
        });
      }
      if (tasks.length < limit) break;
      const lastCompleted = tasks[tasks.length - 1]?.completedTime;
      if (!lastCompleted || lastCompleted === pageTo) break;
      pageTo = formatTickTickCompletedDate(lastCompleted);
    }
  }
  return [...byId.values()];
}

function tickTickHeaders(accessToken) {
  if (!accessToken) {
    throw new Error('TickTick access token is required');
  }
  return {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

function tickTickDateTime(task = {}) {
  const date = String(task.date || '').trim();
  if (!date) return '';
  const time = String(task.time || '').trim() || '00:00';
  return `${date}T${time.length === 5 ? `${time}:00` : time}+09:00`;
}

function tickTickPriority(priority) {
  const normalized = String(priority || '').toLowerCase();
  if (normalized === 'high') return 5;
  if (normalized === 'medium') return 3;
  if (normalized === 'low') return 1;
  return 0;
}

function buildTickTickTaskBody(task = {}) {
  const startDate = tickTickDateTime(task);
  const body = {
    title: String(task.title || task.name || 'Untitled Hermes task'),
    content: String(task.notes || task.content || ''),
    priority: tickTickPriority(task.priority),
  };
  if (startDate) {
    body.startDate = startDate;
    body.dueDate = startDate;
  }
  if (task.ticktickProjectId || task.projectId) {
    body.projectId = String(task.ticktickProjectId || task.projectId);
  }
  return body;
}

async function tickTickJsonRequest({ accessToken, apiBase = 'https://api.ticktick.com', fetchImpl = fetch, path, method = 'POST', body }) {
  const response = await fetchImpl(`${apiBase}${path}`, {
    method,
    headers: tickTickHeaders(accessToken),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`TickTick request failed: ${response.status}`);
  }
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }
  return {};
}

async function createTickTickTask({ accessToken, apiBase, task, fetchImpl = fetch } = {}) {
  return tickTickJsonRequest({
    accessToken,
    apiBase,
    fetchImpl,
    path: '/open/v1/task',
    method: 'POST',
    body: buildTickTickTaskBody(task),
  });
}

async function updateTickTickTask({ accessToken, apiBase, task, fetchImpl = fetch } = {}) {
  const taskId = String(task && (task.ticktickId || task.id) || '').trim();
  if (!taskId) throw new Error('TickTick task id is required');
  return tickTickJsonRequest({
    accessToken,
    apiBase,
    fetchImpl,
    path: `/open/v1/task/${encodeURIComponent(taskId)}`,
    method: 'POST',
    body: buildTickTickTaskBody(task),
  });
}

async function completeTickTickTask({ accessToken, apiBase, task, fetchImpl = fetch } = {}) {
  const taskId = String(task && (task.ticktickId || task.id) || '').trim();
  const projectId = String(task && (task.ticktickProjectId || task.projectId) || '').trim();
  if (!taskId) throw new Error('TickTick task id is required');
  if (!projectId) throw new Error('TickTick project id is required');
  await tickTickJsonRequest({
    accessToken,
    apiBase,
    fetchImpl,
    path: `/open/v1/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
    method: 'POST',
  });
  return { id: taskId, projectId };
}

async function deleteTickTickTask({ accessToken, apiBase, task, fetchImpl = fetch } = {}) {
  const taskId = String(task && (task.ticktickId || task.id) || '').trim();
  const projectId = String(task && (task.ticktickProjectId || task.projectId) || '').trim();
  if (!taskId) throw new Error('TickTick task id is required');
  if (!projectId) throw new Error('TickTick project id is required');
  await tickTickJsonRequest({
    accessToken,
    apiBase,
    fetchImpl,
    path: `/open/v1/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
    method: 'DELETE',
  });
  return { id: taskId, projectId };
}

async function fetchTickTickTasks({ accessToken, apiBase = 'https://api.ticktick.com', fetchImpl = fetch }) {
  if (!accessToken) {
    throw new Error('TickTick access token is required');
  }
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  };
  const byId = new Map();
  const addTasks = (items = [], projectId = '') => {
    for (const task of Array.isArray(items) ? items : []) {
      const id = String(task.id || task.taskId || `${projectId}:${task.title || task.content || byId.size}`);
      byId.set(id, {
        ...(byId.get(id) || {}),
        ...task,
        projectId: task.projectId || projectId || task.ticktickProjectId,
        ticktickProjectId: task.ticktickProjectId || task.projectId || projectId,
      });
    }
  };
  const taskResponse = await fetchImpl(`${apiBase}/open/v1/task`, { headers });
  if (taskResponse.ok) {
    const payload = await taskResponse.json();
    addTasks(Array.isArray(payload) ? payload : payload.tasks || []);
  }

  const projectsResponse = await fetchImpl(`${apiBase}/open/v1/project`, { headers });
  if (!projectsResponse.ok) {
    if (taskResponse.ok) return [...byId.values()];
    throw new Error(`TickTick request failed: ${taskResponse.status}`);
  }
  const projectsPayload = await projectsResponse.json();
  const projects = Array.isArray(projectsPayload) ? projectsPayload : projectsPayload.projects || [];
  const projectIds = ['inbox', ...projects.map((project) => project.id || project.projectId)];
  for (const projectId of [...new Set(projectIds.filter(Boolean).map(String))]) {
    if (!projectId) continue;
    const dataResponse = await fetchImpl(`${apiBase}/open/v1/project/${encodeURIComponent(projectId)}/data`, { headers });
    if (!dataResponse.ok) continue;
    const data = await dataResponse.json();
    addTasks(Array.isArray(data.tasks) ? data.tasks : [], projectId);
  }
  return [...byId.values()];
}

async function exchangeTickTickCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  tokenBase = 'https://ticktick.com/oauth/token',
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (!clientId) throw new Error('TickTick clientId is required');
  if (!clientSecret) throw new Error('TickTick clientSecret is required');
  if (!redirectUri) throw new Error('TickTick redirectUri is required');
  if (!code) throw new Error('TickTick OAuth code is required');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetchImpl(tokenBase, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`TickTick token exchange failed: ${response.status}`);
  }
  const payload = await response.json();
  const expiresIn = Number(payload.expires_in || 0);
  const expiresAt = expiresIn
    ? new Date(now().getTime() + expiresIn * 1000).toISOString()
    : '';
  return {
    accessToken: payload.access_token || '',
    refreshToken: payload.refresh_token || '',
    expiresAt,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || '',
  };
}

function createTickTickOAuthUrl({
  clientId,
  redirectUri,
  state,
  scope = 'tasks:read tasks:write',
  authBase = 'https://ticktick.com/oauth/authorize',
}) {
  if (!clientId) throw new Error('TickTick clientId is required');
  if (!redirectUri) throw new Error('TickTick redirectUri is required');
  const url = new URL(authBase);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  if (state) url.searchParams.set('state', state);
  return url;
}

module.exports = {
  completeTickTickTask,
  createTickTickTask,
  createTickTickOAuthUrl,
  createTickTickSyncPlan,
  deleteTickTickTask,
  exchangeTickTickCode,
  fetchTickTickCalendarEvents,
  fetchTickTickCompletedTasks,
  fetchTickTickTasks,
  normalizeTickTickCalendarEvent,
  normalizeTickTickTask,
  updateTickTickTask,
};
