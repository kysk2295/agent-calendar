const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { buildCalendarWorkDraft } = require('./lib/calendar-work');
const { buildHermesChatDeltas, buildHermesChatStreamEvents, compactStateSummary } = require('./lib/chat-runtime');
const { routeWebCommand } = require('./lib/commands');
const { normalizeMailAccount, syncMailAccounts } = require('./lib/connectors/mail');
const { createRunPayloadFromTelegram, parseTelegramUpdate, registerTelegramWebhook } = require('./lib/connectors/telegram');
const {
  createTickTickOAuthUrl,
  createTickTickSyncPlan,
  exchangeTickTickCode,
  fetchTickTickCalendarEvents,
  fetchTickTickCompletedTasks,
  fetchTickTickTasks,
} = require('./lib/connectors/ticktick');
const { createReflection, createSkillCandidate, shouldPromoteSkill } = require('./lib/learning');
const { buildMissionRunPayload, buildMissionSchedulePayload, listMissionTemplates } = require('./lib/missions');
const {
  createOfficialProfileAgent,
  isOfficialProfileName,
  resolveOfficialProfileName,
  resolveProductAgentName,
  resolveRequestedOfficialProfile,
} = require('./lib/official-profiles');
const { buildProductStatus } = require('./lib/product-status');
const { buildRunnerAdapterCatalog } = require('./lib/runner-adapters');
const { buildGatewayStatus, buildRuntimeProxyRequest, redactGatewayConfig, safeRuntimeError } = require('./lib/runtime-gateway');
const { HermesRailwayRelay, isRelayAuthorized, relayEnabled } = require('./lib/railway-relay');
const { projectStateWithAgents, resolveHermesAgent } = require('./lib/agent-registry');
const { buildScheduleAssistantAnswer, isScheduleQuestion } = require('./lib/schedule-assistant');
const { createStore } = require('./lib/store-factory');
const { buildTaskShareDraft } = require('./lib/task-share');
const { buildVisualBrief } = require('./lib/visual-brief');
const { buildWorkboardRunPayload, buildWorkboardTaskDraft } = require('./lib/workboard');
const { mergeUsageSummaries, readExternalUsageSources, usageFromState } = require('./lib/usage-sources');
const { buildWikiIndex, dateStamp, slugify } = require('./lib/wiki');
const { answerWikiQuestion } = require('./lib/wiki-rag');

const ROOT_DIR = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(ROOT_DIR, 'snapshots');
const PORT = Number(process.env.PORT || 3000);
const PROTECTED_AGENT_IDS = new Set(['default']);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendDatabaseRequired(res, resource = 'desktop data') {
  sendJson(res, 409, {
    ok: false,
    error: `DATABASE_URL is required before ${resource} can be written through the Railway gateway.`,
    databaseConfigured: false,
    gatewayFallback: true,
  });
}

function sendSseStream(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  events.forEach((item) => {
    res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
  });
  res.end();
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function normalizePublicBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function publicBaseUrlFromEnv(env = process.env) {
  return normalizePublicBaseUrl(
    env.HERMES_REMOTE_PUBLIC_BASE_URL
    || env.HERMES_PUBLIC_BASE_URL
    || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')
    || env.RAILWAY_STATIC_URL
  );
}

function tickTickCallbackRedirectUri({ requestUrl, env = process.env }) {
  const explicitRedirectUri = requestUrl.searchParams.get('redirect_uri');
  if (explicitRedirectUri) return explicitRedirectUri;
  const publicBaseUrl = publicBaseUrlFromEnv(env);
  return publicBaseUrl ? `${publicBaseUrl}/ticktick/callback` : `${requestUrl.origin}/ticktick/callback`;
}

function buildTickTickSetupSummary({ requestUrl, env = process.env, state = 'hermes-os' }) {
  const redirectUri = tickTickCallbackRedirectUri({ requestUrl, env });
  const connected = Boolean(env.HERMES_TICKTICK_ACCESS_TOKEN);
  const clientId = env.HERMES_TICKTICK_CLIENT_ID || '';
  const clientSecret = env.HERMES_TICKTICK_CLIENT_SECRET || '';
  const missing = [];
  if (!clientId) missing.push('clientId');
  if (!clientSecret && !connected) missing.push('clientSecret');
  return {
    ok: true,
    connected,
    oauthReady: Boolean(clientId && clientSecret),
    missing,
    redirectUri,
    oauthUrl: clientId
      ? createTickTickOAuthUrl({
        clientId,
        redirectUri,
        state,
        scope: requestUrl.searchParams.get('scope') || undefined,
      }).toString()
      : '',
    apiBase: env.HERMES_TICKTICK_API_BASE || 'https://api.ticktick.com',
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBuffer(buffer) {
  if (!buffer || !buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

function queryObject(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (query[key] === undefined) {
      query[key] = value;
    } else if (Array.isArray(query[key])) {
      query[key].push(value);
    } else {
      query[key] = [query[key], value];
    }
  }
  return query;
}

function dateParts(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):?(\d{2})?)?/);
  if (!match) return null;
  const day = Number(match[3]);
  if (!Number.isFinite(day)) return null;
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    day,
    time: match[4] ? `${match[4]}:${match[5] || '00'}` : '',
  };
}

function eventTimeRange(startParts, endParts) {
  if (!startParts) return { tEnd: '', rangeLabel: '' };
  if (!endParts) return { tEnd: '', rangeLabel: startParts.time || '종일' };
  const startTime = startParts.time || '종일';
  const endTime = endParts.time || '종일';
  const sameDay = startParts.date === endParts.date;
  if (sameDay && !startParts.time && !endParts.time) return { tEnd: '', rangeLabel: '종일' };
  if (sameDay && startParts.time && !endParts.time) return { tEnd: '', rangeLabel: startParts.time };
  return {
    tEnd: endParts.time || '',
    rangeLabel: sameDay
      ? `${startTime}~${endTime}`
      : `${startParts.date.slice(5).replace('-', '/')} ${startTime}~${endParts.date.slice(5).replace('-', '/')} ${endTime}`,
  };
}

function completedSyncRange(now = new Date(), days = 120) {
  const end = new Date(now);
  const begin = new Date(end.getTime() - Math.max(1, Number(days) || 120) * 24 * 60 * 60 * 1000);
  return {
    from: begin.toISOString().slice(0, 19).replace('T', ' '),
    to: end.toISOString().slice(0, 19).replace('T', ' '),
  };
}

function monthSyncRange(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const begin = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 8, 23, 59, 59));
  return {
    begin: begin.toISOString(),
    end: end.toISOString(),
  };
}

function normalizeGatewayPriority(value, title = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (['high', 'medium', 'low', 'none'].includes(raw)) return raw;
  if (/!1|높음|긴급|high/i.test(title)) return 'high';
  if (/!2|보통|medium/i.test(title)) return 'medium';
  if (/!3|낮음|low/i.test(title)) return 'low';
  return 'none';
}

function gatewayCalendarEventsFromState(state = {}) {
  const events = [];
  const seen = new Set();
  const pushEvent = (event) => {
    if (!event || !event.id || seen.has(event.id) || !event.d) return;
    seen.add(event.id);
    events.push(event);
  };

  for (const task of Array.isArray(state.tasks) ? state.tasks : []) {
    const parts = dateParts(task.date || task.due || task.startDate || task.dueDate || task.completedAt);
    if (!parts) continue;
    const endParts = dateParts(task.dateEnd || task.endDate || task.dueDate);
    const timeRange = eventTimeRange(parts, endParts);
    const isCompleted = Boolean(task.completedAt) || /^done|completed|완료$/i.test(String(task.status || ''));
    pushEvent({
      id: `task:${task.id}`,
      d: parts.day,
      t: parts.time || task.time || '',
      tEnd: timeRange.tEnd,
      date: parts.date,
      dateEnd: endParts?.date || '',
      rangeLabel: timeRange.rangeLabel,
      title: task.title || 'Hermes task',
      o: task.owner || 'Me',
      st: isCompleted ? 'Done' : (task.status || 'Planned'),
      source: 'calendar',
      sourceId: task.id,
    });
  }

  for (const task of Array.isArray(state.ticktickTasks) ? state.ticktickTasks : []) {
    const parts = dateParts(task.startDate || task.due || task.date || task.dueDate || task.completedTime);
    if (!parts) continue;
    const endParts = dateParts(task.endDate || task.dateEnd || task.dueDate);
    const timeRange = eventTimeRange(parts, endParts);
    const isCompleted = Boolean(task.completedTime) || /^done|completed|2$/i.test(String(task.status || ''));
    pushEvent({
      id: `ticktick:${task.id}`,
      d: parts.day,
      t: parts.time,
      tEnd: timeRange.tEnd,
      date: parts.date,
      dateEnd: endParts?.date || '',
      rangeLabel: timeRange.rangeLabel,
      title: task.title || task.original || 'TickTick task',
      o: task.executable === false ? 'Me' : 'Agent',
      st: isCompleted ? 'Done' : 'Planned',
      source: 'ticktick',
      sourceId: task.id,
    });
  }

  for (const calendarEvent of Array.isArray(state.externalCalendarEvents) ? state.externalCalendarEvents : []) {
    const parts = dateParts(calendarEvent.startDate || calendarEvent.date || calendarEvent.dueDate);
    if (!parts) continue;
    const endParts = dateParts(calendarEvent.dueDate || calendarEvent.endDate || calendarEvent.dateEnd);
    const timeRange = eventTimeRange(parts, endParts);
    pushEvent({
      id: `external-calendar:${calendarEvent.source || 'calendar'}:${calendarEvent.id}`,
      d: parts.day,
      t: parts.time,
      tEnd: timeRange.tEnd,
      date: parts.date,
      dateEnd: endParts?.date || '',
      rangeLabel: timeRange.rangeLabel,
      title: calendarEvent.title || calendarEvent.original || 'Calendar event',
      o: 'Me',
      st: 'Planned',
      source: calendarEvent.source || 'ticktick-calendar',
      sourceId: calendarEvent.id,
      sourceLabel: calendarEvent.sourceLabel || '',
      calendarName: calendarEvent.calendarName || '',
    });
  }

  return events.sort((a, b) => (a.d - b.d) || String(a.t || '').localeCompare(String(b.t || '')) || String(a.title || '').localeCompare(String(b.title || '')));
}

function gatewayTasksFromState(state = {}) {
  const nativeTasks = Array.isArray(state.tasks) ? state.tasks : [];
  const ticktickReplacementEnabled = Boolean(state.ticktickReplacement && state.ticktickReplacement.enabled);
  const ticktickTasks = (ticktickReplacementEnabled ? [] : (Array.isArray(state.ticktickTasks) ? state.ticktickTasks : [])).map((task) => {
    const parts = dateParts(task.startDate || task.due || task.date || task.dueDate || task.completedTime);
    const isCompleted = Boolean(task.completedTime) || /^done|completed|2$/i.test(String(task.status || ''));
    return {
      id: `ticktick:${task.id}`,
      title: task.title || task.original || 'TickTick task',
      status: isCompleted ? 'Done' : (task.executable === false ? 'Not Started' : 'Planned'),
      date: parts?.date || '',
      due: task.due || task.date || '',
      time: parts?.time || '',
      agent: task.executable === false ? 'Yunseo' : 'default',
      owner: task.executable === false ? 'Me' : 'Agent',
      done: isCompleted,
      overdue: Boolean(parts?.date && parts.date < dateStamp() && !isCompleted),
      category: task.project || 'TickTick',
      priority: normalizeGatewayPriority(task.priority, task.title || task.original || ''),
      body: task.content || task.original || '',
      source: 'ticktick',
      sourceId: task.id,
      ticktickId: task.id,
      ticktickProjectId: task.projectId || '',
    };
  });
  const byId = new Map();
  [...nativeTasks, ...ticktickTasks].forEach((task) => {
    const key = String(task.id || task.ticktickId || task.title || '');
    if (key) byId.set(key, task);
  });
  return [...byId.values()];
}

function gatewayWorkboardStagesFromState(state = {}) {
  const steps = [
    ['command', '명령 수신'],
    ['plan', '계획'],
    ['tool', '도구 호출'],
    ['run', '실행'],
    ['wiki', 'Wiki 기록'],
  ];
  const runs = Array.isArray(state.runs) ? state.runs.slice(0, 12) : [];
  return steps.map(([id, label]) => ({
    id,
    label,
    items: runs.map((run) => ({
      id: `${id}:${run.id}`,
      title: run.name || run.goal || run.title || 'Untitled run',
      runId: run.id,
      status: run.status,
      agent: run.agent || run.agentId,
    })),
  }));
}

function mergeEventsById(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (!event || !event.id || seen.has(String(event.id))) return false;
    seen.add(String(event.id));
    return true;
  });
}

function isActualGatewayTool(tool = {}) {
  const haystack = [
    tool.id,
    tool.name,
    tool.description,
    tool.category,
    tool.source,
    tool.provenance,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return !/benchmark-tool|benchmark parity|test-fixture|seed-demo/.test(haystack);
}

function filterActualGatewayTools(tools) {
  return (Array.isArray(tools) ? tools : []).filter(isActualGatewayTool);
}

function mergeTasksById(...taskLists) {
  const byId = new Map();
  taskLists.flatMap((tasks) => (Array.isArray(tasks) ? tasks : [])).forEach((task) => {
    const key = String(task.id || task.ticktickId || task.sourceId || task.title || '');
    if (key) byId.set(key, { ...(byId.get(key) || {}), ...task });
  });
  return [...byId.values()];
}

function mergeGatewayLiveState(runtimeState = {}, gatewayState = {}, env = process.env, gatewayStore = null) {
  const storedState = gatewayStore ? gatewayStore.getState() : {};
  const liveState = {
    ...gatewayState,
    ...storedState,
    ticktickTasks: [
      ...(Array.isArray(gatewayState.ticktickTasks) ? gatewayState.ticktickTasks : []),
      ...(Array.isArray(storedState.ticktickTasks) ? storedState.ticktickTasks : []),
    ],
    externalCalendarEvents: [
      ...(Array.isArray(gatewayState.externalCalendarEvents) ? gatewayState.externalCalendarEvents : []),
      ...(Array.isArray(storedState.externalCalendarEvents) ? storedState.externalCalendarEvents : []),
    ],
    events: [
      ...(Array.isArray(gatewayState.events) ? gatewayState.events : []),
      ...(Array.isArray(storedState.events) ? storedState.events : []),
	    ],
	  };
  const ticktickReplacement = liveState.ticktickReplacement || runtimeState.ticktickReplacement || null;
  const ticktickReplaced = Boolean(ticktickReplacement && ticktickReplacement.enabled);
  const ticktickById = new Map();
  liveState.ticktickTasks.forEach((task) => {
    if (task && task.id) ticktickById.set(String(task.id), task);
  });
  const liveTicktickTasks = [...ticktickById.values()];
  const hasLiveTickTick = liveTicktickTasks.length > 0;
  const nativeTasks = ticktickReplaced
    ? (Array.isArray(liveState.tasks) ? liveState.tasks : [])
    : mergeTasksById(runtimeState.tasks, liveState.tasks);
  if (!hasLiveTickTick && !nativeTasks.length && !Array.isArray(liveState.events)) {
    return filterDeletedGatewayAgents({
      ...runtimeState,
      tools: filterActualGatewayTools(runtimeState.tools),
    }, gatewayState, gatewayStore);
  }

  const derivedEvents = gatewayCalendarEventsFromState({
    ...liveState,
    tasks: nativeTasks,
    ticktickTasks: liveTicktickTasks,
  });
  const liveEvents = mergeEventsById([
    ...(Array.isArray(liveState.events) ? liveState.events : []),
    ...derivedEvents,
  ]);
  const runtimeNonTickTickEvents = (Array.isArray(runtimeState.events) ? runtimeState.events : [])
    .filter((event) => String(event.source || '') !== 'ticktick' && !String(event.id || '').startsWith('ticktick:'));
  const ticktickConnection = {
    ...((runtimeState.systemConnections && runtimeState.systemConnections.ticktick) || {}),
    connected: ticktickReplaced ? false : (hasLiveTickTick || Boolean(env.HERMES_TICKTICK_ACCESS_TOKEN)),
    state: ticktickReplaced ? 'replaced-by-hermes-task-db' : (hasLiveTickTick ? 'synced' : (env.HERMES_TICKTICK_ACCESS_TOKEN ? 'ready' : 'unchecked')),
    detail: ticktickReplaced
      ? 'TickTick was imported once. Hermes desktop task DB is now the source of truth.'
      : hasLiveTickTick
        ? 'Railway gateway merged the live TickTick snapshot into runtime state.'
        : 'Railway gateway has TickTick credentials but no imported snapshot yet.',
    token: env.HERMES_TICKTICK_ACCESS_TOKEN ? '••••' : '',
    importedCount: liveTicktickTasks.length,
  };
  const projectedTicktickTasks = ticktickReplaced
    ? []
    : (hasLiveTickTick ? liveTicktickTasks : runtimeState.ticktickTasks);

  return filterDeletedGatewayAgents({
    ...runtimeState,
    tools: filterActualGatewayTools(runtimeState.tools),
    tasks: gatewayTasksFromState({
      ...runtimeState,
      tasks: nativeTasks,
      ticktickTasks: projectedTicktickTasks,
    }),
    ticktickTasks: hasLiveTickTick ? liveTicktickTasks : runtimeState.ticktickTasks,
    ticktickReplacement,
    ticktickAutoSync: liveState.ticktickAutoSync || runtimeState.ticktickAutoSync,
    externalCalendarEvents: liveState.externalCalendarEvents.length
      ? liveState.externalCalendarEvents
      : runtimeState.externalCalendarEvents,
    events: liveEvents.length
      ? mergeEventsById([...liveEvents, ...runtimeNonTickTickEvents])
      : runtimeState.events,
    systemConnections: {
      ...(runtimeState.systemConnections || {}),
      ticktick: ticktickConnection,
    },
    gatewayMerged: true,
  }, gatewayState, gatewayStore);
}

function gatewayTickTickTaskCount(gatewayState = {}, gatewayStore = null) {
  const storedState = gatewayStore ? gatewayStore.getState() : {};
  const ids = new Set();
  [
    ...(Array.isArray(gatewayState.ticktickTasks) ? gatewayState.ticktickTasks : []),
    ...(Array.isArray(storedState.ticktickTasks) ? storedState.ticktickTasks : []),
  ].forEach((task) => {
    const key = String(task && (task.id || task.ticktickId || task.sourceId || task.title) || '');
    if (key) ids.add(key);
  });
  return ids.size;
}

function readGatewayTickTickSnapshotFromEnv(env = process.env) {
  const chunks = [];
  for (let index = 0; index < 20; index += 1) {
    const chunk = String(env[`HERMES_TICKTICK_SNAPSHOT_B64_${index}`] || '').trim();
    if (!chunk) break;
    chunks.push(chunk);
  }
  const encoded = chunks.length
    ? chunks.join('')
    : String(env.HERMES_TICKTICK_SNAPSHOT_B64 || '').trim();
  const rawJson = String(env.HERMES_TICKTICK_SNAPSHOT_JSON || '').trim();
  if (!encoded && !rawJson) return null;
  try {
    const text = encoded
      ? zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')
      : rawJson;
    const parsed = JSON.parse(text);
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      externalCalendarEvents: Array.isArray(parsed.externalCalendarEvents) ? parsed.externalCalendarEvents : [],
      source: encoded ? 'env-gzip-base64' : 'env-json',
    };
  } catch (error) {
    return {
      tasks: [],
      events: [],
      externalCalendarEvents: [],
      source: encoded ? 'env-gzip-base64' : 'env-json',
      error: safeRuntimeError(error.message || String(error), 'TickTick snapshot env parse failed'),
    };
  }
}

async function fetchGatewayTickTickSnapshot({ env = process.env, fetchImpl = fetch, body = {} } = {}) {
  const accessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  const webCookie = env.HERMES_TICKTICK_WEB_COOKIE || env.HERMES_TICKTICK_COOKIE || '';
  const apiBase = env.HERMES_TICKTICK_API_BASE || 'https://api.ticktick.com';
  const webApiBase = env.HERMES_TICKTICK_CALENDAR_API_BASE || env.HERMES_TICKTICK_WEB_API_BASE || 'https://ticktick.com/api/v2';
  const tasks = body.tasks || (accessToken ? await fetchTickTickTasks({ accessToken, apiBase, fetchImpl }) : []);
  const byId = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [String(task.id || task.taskId || ''), task]));
  let completedSync = webCookie
    ? { ok: false, source: 'ticktick-completed', imported: 0 }
    : { ok: false, source: 'ticktick-completed', imported: 0, reason: 'web-cookie-not-configured' };
  if (!body.tasks && webCookie) {
    try {
      const range = {
        ...completedSyncRange(new Date(), body.completedDays || env.HERMES_TICKTICK_COMPLETED_DAYS || 120),
        ...(body.completedFrom || body.completedTo ? { from: body.completedFrom || '', to: body.completedTo || '' } : {}),
      };
      const completedTasks = await fetchTickTickCompletedTasks({
        webCookie,
        webApiBase,
        from: range.from,
        to: range.to,
        fetchImpl,
      });
      completedTasks.forEach((task) => {
        const id = String(task.id || task.taskId || '');
        if (!id) return;
        byId.set(id, { ...(byId.get(id) || {}), ...task, status: task.status || 2 });
      });
      completedSync = { ok: true, source: 'ticktick-completed', imported: completedTasks.length, from: range.from, to: range.to };
    } catch (error) {
      completedSync = { ok: false, source: 'ticktick-completed', imported: 0, reason: error.message };
    }
  }
  let externalCalendarEvents = Array.isArray(body.externalCalendarEvents) ? body.externalCalendarEvents : [];
  let calendarSync = webCookie
    ? { ok: false, source: 'ticktick-calendar', imported: 0 }
    : { ok: false, source: 'ticktick-calendar', imported: 0, reason: 'web-cookie-not-configured' };
  if (!externalCalendarEvents.length && webCookie) {
    try {
      const range = {
        ...monthSyncRange(new Date()),
        ...(body.begin && body.end ? { begin: body.begin, end: body.end } : {}),
      };
      externalCalendarEvents = await fetchTickTickCalendarEvents({
        webCookie,
        webApiBase,
        begin: range.begin,
        end: range.end,
        fetchImpl,
      });
      calendarSync = { ok: true, source: 'ticktick-calendar', imported: externalCalendarEvents.length, begin: range.begin, end: range.end };
    } catch (error) {
      calendarSync = { ok: false, source: 'ticktick-calendar', imported: 0, reason: error.message };
    }
  }
  return {
    tasks: [...byId.values()],
    externalCalendarEvents,
    completedSync,
    calendarSync,
  };
}

async function ensureGatewayTickTickSnapshot({
  gatewayState,
  gatewayStore = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (gatewayState.ticktickAutoSyncPromise) {
    await gatewayState.ticktickAutoSyncPromise;
    return;
  }
  const storedState = gatewayStore ? gatewayStore.getState() : {};
  if (gatewayState.ticktickReplacement?.enabled || storedState.ticktickReplacement?.enabled) return;
  if (gatewayTickTickTaskCount(gatewayState, gatewayStore) > 0) return;
  if (!gatewayStore) return;
  const envSnapshot = readGatewayTickTickSnapshotFromEnv(env);
  if (envSnapshot && (envSnapshot.tasks.length || envSnapshot.events.length || envSnapshot.externalCalendarEvents.length)) {
    const result = importGatewayTickTickTasks({
      body: envSnapshot,
      gatewayState,
      gatewayStore,
    });
    gatewayState.ticktickAutoSync = {
      ok: true,
      total: result.total,
      source: envSnapshot.source,
      syncedAt: new Date().toISOString(),
    };
    return;
  }
  if (envSnapshot?.error) {
    gatewayState.ticktickAutoSync = {
      ok: false,
      source: envSnapshot.source,
      error: envSnapshot.error,
      syncedAt: new Date().toISOString(),
    };
  }
  const accessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  if (!accessToken) return;
  const now = Date.now();
  const lastAttempt = Number(gatewayState.ticktickAutoSyncAttemptAt || 0);
  if (lastAttempt && now - lastAttempt < 5 * 60 * 1000 && gatewayState.ticktickAutoSync?.ok === false) return;
  gatewayState.ticktickAutoSyncAttemptAt = now;
  gatewayState.ticktickAutoSyncPromise = (async () => {
    try {
      const snapshot = await fetchGatewayTickTickSnapshot({ env, fetchImpl });
      const result = importGatewayTickTickTasks({
        body: snapshot,
        gatewayState,
        gatewayStore,
      });
      gatewayState.ticktickAutoSync = {
        ok: true,
        total: result.total,
        completedSync: snapshot.completedSync,
        calendarSync: snapshot.calendarSync,
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      gatewayState.ticktickAutoSync = {
        ok: false,
        error: safeRuntimeError(error.message || String(error), 'TickTick sync failed'),
        syncedAt: new Date().toISOString(),
      };
    } finally {
      gatewayState.ticktickAutoSyncPromise = null;
    }
  })();
  await gatewayState.ticktickAutoSyncPromise;
}

function mergeGatewayResponseBody(body = {}, gatewayState, env = process.env, gatewayStore = null) {
  const runtimeState = body.state && typeof body.state === 'object' && !Array.isArray(body.state)
    ? body.state
    : {};
  const state = mergeGatewayLiveState(runtimeState, gatewayState, env, gatewayStore);
  const nextBody = {
    ...body,
    state,
    deletedAgentIds: state.deletedAgentIds || [],
    gatewayMerged: true,
  };
  if (Array.isArray(body.tools)) nextBody.tools = filterActualGatewayTools(body.tools);
  if (Array.isArray(body.agents)) {
    nextBody.agents = filterDeletedGatewayAgents({ agents: body.agents }, gatewayState, gatewayStore).agents || [];
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data) && Array.isArray(body.data.agents)) {
    nextBody.data = {
      ...body.data,
      agents: filterDeletedGatewayAgents({ agents: body.data.agents }, gatewayState, gatewayStore).agents || [],
    };
  }
  if (Array.isArray(state.tools)) nextBody.state = { ...state, tools: filterActualGatewayTools(state.tools) };
  return nextBody;
}

async function pipeRuntimeResponse(runtimeResponse, res) {
  const headers = {
    'content-type': runtimeResponse.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  res.writeHead(runtimeResponse.status, headers);

  if (!runtimeResponse.body) {
    res.end(await runtimeResponse.text());
    return;
  }

  const reader = runtimeResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}

function createGatewayState() {
  return {
    tasks: [],
    events: [],
    externalCalendarEvents: [],
    runs: [],
    events: [],
    externalCalendarEvents: [],
    documents: [],
    tools: [],
    sessions: [],
    agents: [],
    chatMessages: [],
    mailMessages: [],
    workboardPages: [],
    telegramChatCandidates: [],
    commandInboxArchivedIds: [],
    ticktickTasks: [],
    schedulerJobs: [],
    deletedAgentIds: [],
    daemon: {
      running: false,
      intervalMs: 60000,
      isTicking: false,
      lastRun: null,
      lastError: null,
    },
    reflections: [],
    skillCandidates: [],
    gatewayFallback: true,
  };
}

function gatewayAgentKeys(agent = {}) {
  return [
    agent.id,
    agent.displayName,
    agent.name,
    agent.agentIdentity?.id,
    agent.agentIdentity?.displayName,
    agent.runtimeBinding?.agentKey,
    agent.profile?.name,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function isProtectedGatewayAgent(agentOrId = {}) {
  if (typeof agentOrId === 'string') {
    return PROTECTED_AGENT_IDS.has(String(agentOrId || '').trim().toLowerCase());
  }
  return agentOrId.agentSource === 'hermes-cli'
    || agentOrId.agentIdentity?.source === 'hermes-cli'
    || agentOrId.agentIdentity?.kind === 'mac-mini-hermes-profile'
    || agentOrId.executionBackend?.id === 'hermes-cli'
    || agentOrId.runtimeBinding?.executionBackendId === 'hermes-cli'
    || gatewayAgentKeys(agentOrId).some((key) => PROTECTED_AGENT_IDS.has(key.toLowerCase()));
}

function findGatewayAgentById(agentId, gatewayState = {}, gatewayStore = null, extraStates = []) {
  const wanted = String(agentId || '').trim();
  if (!wanted) return null;
  const states = [
    ...(Array.isArray(extraStates) ? extraStates : []),
    gatewayStore && typeof gatewayStore.getState === 'function' ? gatewayStore.getState() : null,
    gatewayState,
    gatewaySnapshot(gatewayState, gatewayStore),
  ].filter(Boolean);
  for (const state of states) {
    const agent = (Array.isArray(state.agents) ? state.agents : [])
      .find((item) => gatewayAgentKeys(item).includes(wanted));
    if (agent) return agent;
  }
  return null;
}

function deletedGatewayAgentIds(gatewayState = {}, gatewayStore = null) {
  const storedState = gatewayStore && typeof gatewayStore.getState === 'function' ? gatewayStore.getState() : {};
  return new Set([
    ...(Array.isArray(gatewayState.deletedAgentIds) ? gatewayState.deletedAgentIds : []),
    ...(Array.isArray(storedState.deletedAgentIds) ? storedState.deletedAgentIds : []),
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function filterDeletedGatewayAgents(state = {}, gatewayState = {}, gatewayStore = null) {
  const deletedIds = deletedGatewayAgentIds(gatewayState, gatewayStore);
  if (!deletedIds.size || !Array.isArray(state.agents)) return state;
  return {
    ...state,
    deletedAgentIds: [...deletedIds],
    agents: state.agents.filter((agent) => (
      isProtectedGatewayAgent(agent) || !gatewayAgentKeys(agent).some((key) => deletedIds.has(key))
    )),
  };
}

function gatewaySnapshot(gatewayState, gatewayStore) {
  const snapshot = readHermesAgentSnapshot();
  return filterDeletedGatewayAgents(projectStateWithAgents({
    ...(gatewayStore ? gatewayStore.getState() : gatewayState),
    gatewayFallback: true,
  }, {
    profileAgents: snapshot?.agents || [],
    agentSourceStatus: snapshot?.agentSourceStatus || fallbackAgentSourceStatus(),
  }), gatewayState, gatewayStore);
}

function isGatewayProfileAgent(agent = {}) {
  return agent.agentSource === 'hermes-cli'
    || agent.agentIdentity?.source === 'hermes-cli'
    || agent.agentIdentity?.kind === 'mac-mini-hermes-profile'
    || agent.executionBackend?.id === 'hermes-cli'
    || agent.runtimeBinding?.executionBackendId === 'hermes-cli';
}

function gatewayProfileState(gatewayState, gatewayStore) {
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const agents = (Array.isArray(state.agents) ? state.agents : []).filter(isGatewayProfileAgent);
  return { ...state, agents };
}

function resolveGatewayRunProfile(body = {}, state = {}) {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const wanted = String(body.agentId || body.agent || body.profile || '').trim();
  const matched = wanted
    ? agents.find((agent) => gatewayAgentKeys(agent).some((key) => key === wanted))
    : null;
  return matched || agents.find((agent) => gatewayAgentKeys(agent).includes('default')) || agents[0] || { id: 'default', displayName: 'default', name: 'default' };
}

function relayLiveSnapshot(relay, env = process.env) {
  if (!relay || typeof relay.snapshot !== 'function') return null;
  const snapshot = relay.snapshot({ env });
  return snapshot && snapshot.ok ? snapshot : null;
}

function liveAgentProfileRoot(agent = {}) {
  const profile = agent.profile && typeof agent.profile === 'object' ? agent.profile : {};
  const candidates = [
    profile.profileRoot,
    profile.path,
    agent.profileRoot,
    agent.profilePath,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (candidates.length) return candidates[0];
  const soulPath = String(profile.soulPath || agent.soulPath || '').trim();
  return soulPath ? path.dirname(soulPath) : '';
}

function normalizeLiveAgentSkillOrigin(skill = {}, agent = {}) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return skill;
  const profileRoot = liveAgentProfileRoot(agent);
  const runtimeKind = String(
    skill.sourceRuntime
    || agent.executionBackend?.kind
    || agent.executionBackend?.id
    || agent.runtimeBinding?.executionBackendId
    || 'hermes-cli',
  ).trim() || 'hermes-cli';
  const device = String(
    skill.sourceDevice
    || agent.agentIdentity?.device
    || (String(agent.agentIdentity?.kind || '').includes('mac-mini') ? 'mac-mini' : '')
    || 'mac-mini',
  ).trim() || 'mac-mini';
  return {
    ...skill,
    sourceDevice: skill.sourceDevice || device,
    sourcePath: skill.sourcePath || profileRoot,
    sourceRuntime: skill.sourceRuntime || runtimeKind,
  };
}

function normalizeLiveAgentSkillOrigins(agents = []) {
  if (!Array.isArray(agents)) return [];
  return agents.map((agent) => {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return agent;
    const skills = Array.isArray(agent.skills)
      ? agent.skills.map((skill) => normalizeLiveAgentSkillOrigin(skill, agent))
      : agent.skills;
    return { ...agent, skills };
  });
}

function relayStateFromSnapshot(snapshot, gatewayState, env = process.env, gatewayStore = null) {
  const runtimeState = snapshot?.state && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)
    ? snapshot.state
    : {};
  const state = {
    ...runtimeState,
    ...(Array.isArray(snapshot?.agents) ? { agents: normalizeLiveAgentSkillOrigins(snapshot.agents) } : {}),
    ...(Array.isArray(snapshot?.tools) ? { tools: snapshot.tools } : {}),
    ...(Array.isArray(snapshot?.skills) ? { skills: snapshot.skills } : {}),
    ...(Array.isArray(snapshot?.toolsets) ? { toolsets: snapshot.toolsets } : {}),
    ...(Array.isArray(snapshot?.mcpServers) ? { mcpServers: snapshot.mcpServers } : {}),
    ...(Array.isArray(snapshot?.schedulerJobs) ? { schedulerJobs: snapshot.schedulerJobs } : {}),
    ...(Array.isArray(snapshot?.automationJobs) ? { automationJobs: snapshot.automationJobs } : {}),
    ...(snapshot?.agentSourceStatus ? { agentSourceStatus: snapshot.agentSourceStatus } : {}),
    remoteVerification: {
      ...(runtimeState.remoteVerification || {}),
      runtimeReachable: true,
      gatewayFallback: false,
      source: 'railway-relay-snapshot',
      checkedAt: snapshot.receivedAt || new Date().toISOString(),
    },
  };
  const merged = mergeGatewayLiveState(state, gatewayState, env, gatewayStore);
  return filterDeletedGatewayAgents({
    ...merged,
    agents: normalizeLiveAgentSkillOrigins(merged.agents),
    gatewayFallback: false,
    runtimeReachable: true,
    relaySnapshot: {
      source: snapshot.source || 'railway-relay-bridge',
      receivedAt: snapshot.receivedAt || '',
      ageMs: snapshot.ageMs,
      ttlMs: snapshot.ttlMs,
    },
  }, gatewayState, gatewayStore);
}

function buildApiPath(pathSegments = []) {
  return `/api/${pathSegments.map((segment) => encodeURIComponent(decodeURIComponent(String(segment || '')))).join('/')}`;
}

async function relayRuntimeJsonRequest({
  relay,
  env = process.env,
  method = 'GET',
  pathSegments = [],
  pathOverride = '',
  query = {},
  bodyBuffer,
  bodyText = '',
  timeoutMs = 30_000,
} = {}) {
  if (!relay || !relayEnabled(env) || !relay.isBridgeOnline()) return null;
  const job = relay.enqueue({
    kind: 'runtime.request',
    payload: {
      method,
      path: pathOverride || buildApiPath(pathSegments),
      query,
      body: bodyText || (bodyBuffer ? bodyBuffer.toString('utf8') : '{}'),
    },
    meta: {
      source: 'railway-gateway-runtime-request',
      createdAt: new Date().toISOString(),
    },
  });
  let cursor = 0;
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
  let finalData = null;
  let lastError = '';
  while (Date.now() < deadline) {
    const batch = await relay.waitForEvents(job.id, cursor, Math.min(5_000, Math.max(1, deadline - Date.now())));
    cursor = batch.cursor || cursor;
    for (const record of batch.events || []) {
      if (record.event === 'error') {
        lastError = safeRuntimeError(record.data?.error || 'Relay runtime request failed', 'Relay runtime request failed');
      }
      if (record.event === 'bridge-complete') {
        finalData = record.data || {};
      }
    }
    if (batch.complete) break;
  }
  if (!finalData) {
    return {
      ok: false,
      status: 504,
      body: { ok: false, error: lastError || 'Relay runtime request timed out' },
    };
  }
  return {
    ok: finalData.ok !== false,
    status: Number(finalData.status || (finalData.ok === false ? 502 : 200)),
    body: finalData.body && typeof finalData.body === 'object' ? finalData.body : {},
    contentType: finalData.contentType || 'application/json; charset=utf-8',
  };
}

function isHermesCronSchedulerId(value = '') {
  return String(value || '').startsWith('hermes-cron:');
}

function stripHermesCronSchedulerId(value = '') {
  return String(value || '').replace(/^hermes-cron:/, '');
}

function schedulerIntervalSchedule(body = {}) {
  const explicit = String(body.schedule || body.scheduleDisplay || body.cron || '').trim();
  if (explicit) return explicit;
  const minutes = Math.max(1, Math.round(Number(body.intervalMinutes || body.minutes || 60)));
  if (minutes % 1440 === 0) return `every ${minutes}m`;
  if (minutes % 60 === 0) return `every ${minutes / 60}h`;
  return `every ${minutes}m`;
}

function normalizeHermesCronResponseJob(job = {}) {
  const rawId = String(job.id || job.name || '').trim();
  const scheduleDisplay = job.schedule_display || job.scheduleDisplay || job.schedule?.display || '';
  const intervalMinutes = (() => {
    const everyMinutes = String(scheduleDisplay).match(/^every\s+(\d+)\s*m/i);
    if (everyMinutes) return Math.max(1, Number(everyMinutes[1]) || 1);
    const everyHours = String(scheduleDisplay).match(/^every\s+(\d+)\s*h/i);
    if (everyHours) return Math.max(1, (Number(everyHours[1]) || 1) * 60);
    return Math.max(1, Math.round(Number(job.intervalMinutes) || 60));
  })();
  return {
    id: rawId.startsWith('hermes-cron:') ? rawId : `hermes-cron:${rawId || job.name || 'job'}`,
    name: String(job.name || job.title || rawId || 'Hermes cron job'),
    goal: String(job.goal || job.description || job.prompt || job.script || job.name || 'Scheduled Hermes run'),
    agent: String(job.agent || job.profile || 'default'),
    model: String(job.model || 'Hermes CLI'),
    intervalMinutes,
    enabled: job.enabled !== false && job.state !== 'disabled',
    runCount: Number(job.repeat?.completed || job.runCount || 0),
    lastRunAt: job.last_run_at || job.lastRunAt || '',
    nextRunAt: job.next_run_at || job.nextRunAt || '',
    schedule: job.schedule || null,
    scheduleDisplay,
    status: job.state || job.status || '',
    source: 'hermes-cli-cron',
    raw: job,
  };
}

function buildHermesCronCreateBody(body = {}) {
  const name = String(body.name || body.title || body.goal || 'Scheduled Hermes run').trim();
  return {
    name,
    prompt: String(body.prompt || body.goal || name).trim(),
    schedule: schedulerIntervalSchedule(body),
    deliver: String(body.deliver || body.delivery || 'local').trim(),
    skills: Array.isArray(body.skills) ? body.skills : [],
  };
}

function buildHermesCronUpdateBody(body = {}) {
  const updates = {};
  if (body.name !== undefined || body.title !== undefined) updates.name = String(body.name || body.title || '').trim();
  if (body.goal !== undefined || body.prompt !== undefined) updates.prompt = String(body.prompt || body.goal || '').trim();
  if (body.profile !== undefined || body.agent !== undefined || body.agentId !== undefined) updates.profile = hermesProfileNameFromAgentBody(body);
  if (body.schedule !== undefined || body.scheduleDisplay !== undefined || body.cron !== undefined || body.intervalMinutes !== undefined) {
    updates.schedule = schedulerIntervalSchedule(body);
  }
  if (body.deliver !== undefined || body.delivery !== undefined) updates.deliver = String(body.deliver || body.delivery || 'local').trim();
  if (Array.isArray(body.skills)) updates.skills = body.skills;
  return { updates };
}

function hermesProfileNameFromAgentBody(body = {}) {
  return String(body.profile || body.agent || body.agentId || 'default').trim() || 'default';
}

function buildHermesProfileCreateBody(body = {}) {
  const rawName = String(body.name || body.displayName || body.profile || '').trim();
  const name = slugify(rawName, 'agent').replace(/-/g, '_');
  const model = String(body.model || '').trim();
  const provider = String(body.provider || '').trim() || (model.includes('/') ? model.split('/')[0] : '');
  return {
    name,
    description: String(body.description || body.role || body.persona || rawName || name).trim(),
    clone_from_default: body.cloneFromDefault !== false,
    clone_all: Boolean(body.cloneAll),
    no_skills: Boolean(body.noSkills),
    ...(provider && model ? { provider, model } : {}),
  };
}

function normalizeHermesProfileAgent(body = {}) {
  const name = String(body.name || body.profile?.name || '').trim();
  if (!name) return null;
  const model = String(body.model || body.profile?.model || 'Recommended').trim();
  const commandTemplate = name === 'default'
    ? 'hermes --yolo -z "$HERMES_GOAL"'
    : `hermes profile use ${name} && hermes --yolo -z "$HERMES_GOAL"`;
  const agentIdentity = {
    id: name,
    displayName: name,
    source: 'hermes-cli',
    resident: true,
    kind: 'mac-mini-hermes-profile',
  };
  const executionBackend = {
    id: 'hermes-cli',
    label: 'Hermes CLI',
    kind: 'hermes-cli',
    model,
    commandTemplate,
  };
  return {
    id: name,
    displayName: name,
    name,
    engine: 'hermes',
    role: body.description || `Mac mini Hermes profile ${name}`,
    persona: body.description || `맥 미니 Hermes 프로필 ${name}.`,
    model,
    status: 'Idle',
    tools: ['hermes-cli'],
    agentSource: 'hermes-cli',
    agentIdentity,
    executionBackend,
    runnerAdapter: { ...executionBackend },
    runtimeBinding: {
      kind: agentIdentity.kind,
      agentKey: name,
      resident: true,
      executionBackendId: executionBackend.id,
      adapterId: executionBackend.id,
      commandTemplate,
      model,
    },
    profile: {
      name,
      path: body.path || '',
      description: body.description || '',
      provider: body.provider || '',
    },
  };
}

function schedulerRelayTranslation({ method, pathSegments = [], body = {} } = {}) {
  const isSchedulerJob = pathSegments[0] === 'scheduler' && pathSegments[1] === 'jobs';
  const isMissionSchedule = method === 'POST' && pathSegments[0] === 'missions' && pathSegments[1] === 'schedule';
  if (isMissionSchedule) {
    const schedulePayload = buildMissionSchedulePayload(body);
    return {
      method: 'POST',
      pathOverride: '/api/cron/jobs',
      query: { profile: hermesProfileNameFromAgentBody(schedulePayload) },
      bodyText: JSON.stringify(buildHermesCronCreateBody(schedulePayload)),
      kind: 'cron-create',
    };
  }
  if (!isSchedulerJob || method === 'GET') return null;
  const jobId = pathSegments[2] ? decodeURIComponent(pathSegments[2]) : '';
  const action = pathSegments[3] || '';
  if (method === 'POST' && !jobId) {
    return {
      method: 'POST',
      pathOverride: '/api/cron/jobs',
      query: { profile: hermesProfileNameFromAgentBody(body) },
      bodyText: JSON.stringify(buildHermesCronCreateBody(body)),
      kind: 'cron-create',
    };
  }
  if (!isHermesCronSchedulerId(jobId)) return null;
  const cronId = encodeURIComponent(stripHermesCronSchedulerId(jobId));
  if (method === 'POST' && action === 'run') {
    return { method: 'POST', pathOverride: `/api/cron/jobs/${cronId}/trigger`, bodyText: '{}', kind: 'cron-trigger' };
  }
  if (method === 'DELETE' && !action) {
    return { method: 'DELETE', pathOverride: `/api/cron/jobs/${cronId}`, bodyText: '{}', kind: 'cron-delete' };
  }
  if (method === 'PATCH' && !action) {
    const keys = Object.keys(body || {});
    if (keys.length === 1 && body.enabled === false) {
      return { method: 'POST', pathOverride: `/api/cron/jobs/${cronId}/pause`, bodyText: '{}', kind: 'cron-pause' };
    }
    if (keys.length === 1 && body.enabled === true) {
      return { method: 'POST', pathOverride: `/api/cron/jobs/${cronId}/resume`, bodyText: '{}', kind: 'cron-resume' };
    }
    return {
      method: 'PUT',
      pathOverride: `/api/cron/jobs/${cronId}`,
      bodyText: JSON.stringify(buildHermesCronUpdateBody(body)),
      kind: 'cron-update',
    };
  }
  return null;
}

function decodeToolId(value = '') {
  const text = decodeURIComponent(String(value || ''));
  const match = text.match(/^([^:]+):(.+)$/);
  if (!match) return { kind: '', name: text };
  return { kind: match[1], name: match[2] };
}

function enabledFromToolPatch(body = {}) {
  if (body.enabled !== undefined) return Boolean(body.enabled);
  if (body.status !== undefined) {
    return !['disabled', 'blocked', 'off', 'inactive'].includes(String(body.status || '').toLowerCase());
  }
  return true;
}

function toolRelayTranslation({ method, pathSegments = [], body = {}, query = {} } = {}) {
  if (pathSegments[0] !== 'tools' || !pathSegments[1]) return null;
  const { kind, name } = decodeToolId(pathSegments[1]);
  if (!kind || !name) return null;
  const action = pathSegments[2] || '';
  const profile = body.profile || query.profile || 'default';
  const enabled = enabledFromToolPatch(body);
  if (method === 'PATCH' && !action) {
    if (kind === 'skill') {
      return {
        method: 'PUT',
        pathOverride: '/api/skills/toggle',
        bodyText: JSON.stringify({ name, enabled, profile }),
        kind: 'skill-toggle',
        tool: { id: `skill:${name}`, name, status: enabled ? 'enabled' : 'disabled', type: 'skill', category: 'skill' },
      };
    }
    if (kind === 'toolset') {
      return {
        method: 'PUT',
        pathOverride: `/api/tools/toolsets/${encodeURIComponent(name)}`,
        bodyText: JSON.stringify({ enabled, profile }),
        kind: 'toolset-toggle',
        tool: { id: `toolset:${name}`, name, status: enabled ? 'enabled' : 'disabled', type: 'api', category: 'api' },
      };
    }
    if (kind === 'mcp') {
      return {
        method: 'PUT',
        pathOverride: `/api/mcp/servers/${encodeURIComponent(name)}/enabled`,
        bodyText: JSON.stringify({ enabled, profile }),
        kind: 'mcp-toggle',
        tool: { id: `mcp:${name}`, name, status: enabled ? 'enabled' : 'disabled', type: 'connector', category: 'connector' },
      };
    }
  }
  if (method === 'POST' && action === 'test') {
    if (kind === 'skill') {
      return {
        method: 'GET',
        pathOverride: '/api/skills/content',
        query: { name, profile },
        bodyText: '{}',
        kind: 'skill-test',
        tool: { id: `skill:${name}`, name, type: 'skill', category: 'skill' },
      };
    }
    if (kind === 'toolset') {
      return {
        method: 'GET',
        pathOverride: `/api/tools/toolsets/${encodeURIComponent(name)}/config`,
        query: { profile },
        bodyText: '{}',
        kind: 'toolset-test',
        tool: { id: `toolset:${name}`, name, type: 'api', category: 'api' },
      };
    }
    if (kind === 'mcp') {
      return {
        method: 'POST',
        pathOverride: `/api/mcp/servers/${encodeURIComponent(name)}/test`,
        query: { profile },
        bodyText: '{}',
        kind: 'mcp-test',
        tool: { id: `mcp:${name}`, name, type: 'connector', category: 'connector' },
      };
    }
  }
  return null;
}

function readHermesAgentSnapshot() {
  const snapshotPath = path.join(SNAPSHOT_DIR, 'hermes-agents-snapshot.json');
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    if (!agents.length) return null;
    return {
      agents,
      profiles: Array.isArray(snapshot.profiles) ? snapshot.profiles : [],
      agentSourceStatus: {
        ...(snapshot.agentSourceStatus || {}),
        ok: true,
        source: snapshot.agentSourceStatus?.source || 'hermes-cli-snapshot',
        snapshotSource: snapshot.source || snapshot.agentSourceStatus?.snapshotSource || 'local-hermes-agent-snapshot',
        generatedAt: snapshot.generatedAt || snapshot.agentSourceStatus?.generatedAt || '',
        profileCount: snapshot.agentSourceStatus?.profileCount || agents.length,
        skillCount: snapshot.agentSourceStatus?.skillCount || 0,
        runtimeReachable: false,
      },
    };
  } catch {
    return null;
  }
}

function usageHasMetrics(usage = {}) {
  return Number(usage.totalTokens || 0) > 0
    || Number(usage.inputTokens || 0) > 0
    || Number(usage.outputTokens || 0) > 0
    || (Array.isArray(usage.byModel) && usage.byModel.some((item) => Number(item.totalTokens || 0) > 0));
}

function readGatewayUsageSnapshot(env = process.env) {
  const rawJson = String(env.HERMES_USAGE_SNAPSHOT_JSON || '').trim();
  const snapshotPath = path.join(SNAPSHOT_DIR, 'usage-snapshot.json');
  const sourcePayload = rawJson
    ? { raw: rawJson, source: 'env-usage-snapshot' }
    : fs.existsSync(snapshotPath)
      ? { raw: fs.readFileSync(snapshotPath, 'utf8'), source: 'local-usage-snapshot' }
      : null;
  if (!sourcePayload) return null;
  try {
    const parsed = JSON.parse(sourcePayload.raw);
    const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : parsed;
    if (!usage || typeof usage !== 'object' || !usageHasMetrics(usage)) return null;
    const source = parsed.source || sourcePayload.source;
    return {
      usage: {
        ...usage,
        sourceStatus: [
          ...(Array.isArray(usage.sourceStatus) ? usage.sourceStatus : []),
          { source, ok: true, generatedAt: parsed.generatedAt || usage.generatedAt || '' },
        ],
      },
      source,
      generatedAt: parsed.generatedAt || usage.generatedAt || '',
    };
  } catch (error) {
    return {
      usage: null,
      source: sourcePayload.source,
      error: safeRuntimeError(error.message || String(error), 'Usage snapshot parse failed'),
    };
  }
}

function fallbackAgentSourceStatus() {
  return {
    ok: false,
    source: 'mac-mini-runtime',
    reason: 'runtime-unreachable',
  };
}

async function waitForStoreReady(store) {
  if (store && store.ready && typeof store.ready.then === 'function') {
    await store.ready;
  }
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

const BENCHMARK_FIXTURE_TEXT = 'Retrieval augmented generation benchmark evidence. Hypothesis: better retrieval quality improves answer accuracy and daily experiment loops.';
const PLAYWRIGHT_UPLOAD_TEXT = 'Playwright evidence upload check\nsource: web direct upload';

function gatewayDocumentProvenance(document = {}) {
  const filename = String(document.filename || document.name || document.title || '').toLowerCase();
  const tags = Array.isArray(document.tags) ? document.tags : [];
  const body = [
    document.title,
    document.filename,
    document.extractedText,
    document.source,
    document.sourceLabel,
    ...tags,
  ].map((value) => String(value || '').toLowerCase()).join('\n');
  if (
    tags.some((tag) => String(tag || '').toLowerCase() === 'playwright')
    || body.includes(PLAYWRIGHT_UPLOAD_TEXT.toLowerCase())
    || (filename.includes('benchmark-evidence-paper') && body.includes(BENCHMARK_FIXTURE_TEXT.toLowerCase()))
    || filename.startsWith('hermes-evidence-playwright')
  ) {
    return 'test-fixture';
  }
  if (String(document.source || '').toLowerCase() === 'telegram' || document.telegramFileId) return 'telegram-original';
  if (String(document.source || '').toLowerCase() === 'web' || String(document.sourceLabel || '').toLowerCase() === 'web upload') return 'web-upload';
  return 'document-ingest';
}

function gatewayProvenanceLabel(provenance = '') {
  return ({
    'test-fixture': '테스트 fixture',
    'telegram-original': 'Telegram 원본',
    'web-upload': '실제 업로드',
    'document-ingest': '문서 기록',
  })[provenance] || '문서 기록';
}

function createGatewayDocument(body = {}) {
  const now = new Date().toISOString();
  const title = String(body.title || body.filename || 'Untitled document').trim();
  const content = String(body.extractedText || body.content || body.text || '').trim();
  const tags = Array.isArray(body.tags)
    ? body.tags.map(String).filter(Boolean)
    : String(body.tags || '').split(',').map((item) => item.trim()).filter(Boolean);
  const source = String(body.source || 'web').trim();
  const sourceLabel = String(body.sourceLabel || (source === 'telegram' ? 'Telegram' : source === 'web' ? 'Web upload' : source)).trim();
  const document = {
    id: createId('doc'),
    title,
    name: String(body.filename || `${slugify(title, 'document')}.txt`),
    filename: String(body.filename || `${slugify(title, 'document')}.txt`),
    mimeType: String(body.mimeType || body.type || 'text/plain'),
    size: Number(body.size || Buffer.byteLength(content, 'utf8') || 0),
    tags,
    ocrStatus: content ? 'extracted' : 'pending',
    ocr: content ? '텍스트 추출' : '대기',
    extractedText: content,
    extract: content,
    source,
    sourceLabel,
    wikiPath: body.wikiPath || `1_raw/documents/${dateStamp(now)}-${slugify(title, 'document')}.md`,
    createdAt: now,
    updatedAt: now,
    gatewayFallback: true,
  };
  const provenance = gatewayDocumentProvenance(document);
  return {
    ...document,
    provenance,
    provenanceLabel: gatewayProvenanceLabel(provenance),
    evidenceVisible: provenance !== 'test-fixture',
    isTestFixture: provenance === 'test-fixture',
  };
}

function parseCsvArray(value = []) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseGatewayMailAccounts(env = process.env) {
  try {
    const parsed = JSON.parse(String(env.HERMES_MAIL_ACCOUNTS_JSON || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeMailAccount).filter((account) => account.email || account.username);
  } catch {
    return [];
  }
}

function publicGatewayMailAccounts(env = process.env) {
  return parseGatewayMailAccounts(env).map((account) => ({
    id: account.id,
    provider: account.provider,
    email: account.email,
    username: account.username,
    host: account.host,
    port: account.port,
    secure: account.secure !== false,
    enabled: account.enabled !== false,
    connected: Boolean((account.username || account.email) && (account.password || account.accessToken)),
    password: account.password ? '••••' : null,
    accessToken: account.accessToken ? '••••' : null,
    lastSyncAt: account.lastSyncAt || '',
    lastError: account.lastError || '',
  }));
}

function cleanGatewayMailMessageId(value = '') {
  return String(value || '').trim().replace(/^<|>$/g, '').replace(/[\s<>]+/g, '') || `mail-${Date.now()}`;
}

function gatewayMailProviderLabel(provider = '') {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'gmail') return 'Gmail';
  if (normalized === 'naver') return 'Naver Mail';
  return 'Mail';
}

function importGatewayMailMessages(gatewayState, messages = []) {
  if (!Array.isArray(gatewayState.mailMessages)) gatewayState.mailMessages = [];
  const normalized = (Array.isArray(messages) ? messages : []).map((message) => {
    const provider = String(message.provider || 'mail').toLowerCase();
    const accountId = String(message.accountId || message.email || message.username || provider).trim();
    const messageId = cleanGatewayMailMessageId(message.messageId || `${accountId}-${message.receivedAt || Date.now()}-${message.subject || ''}`);
    return {
      id: `mail:${accountId}:${messageId}`,
      accountId,
      provider,
      from: String(message.from || '').trim(),
      subject: String(message.subject || '(no subject)').trim(),
      text: String(message.text || message.body || '').trim(),
      receivedAt: message.receivedAt ? new Date(message.receivedAt).toISOString() : new Date().toISOString(),
      messageId,
      importedAt: new Date().toISOString(),
    };
  }).filter((message) => message.accountId && (message.subject || message.text));
  const existing = new Map(gatewayState.mailMessages.map((message) => [String(message.id), message]));
  normalized.forEach((message) => existing.set(message.id, { ...(existing.get(message.id) || {}), ...message }));
  gatewayState.mailMessages = [...existing.values()]
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .slice(0, 500);
  return normalized;
}

function createGatewayTool(body = {}) {
  const now = new Date().toISOString();
  const rawType = String(body.type || 'Skill').trim().toLowerCase();
  const type = rawType === 'mcp' ? 'MCP' : rawType === 'plugin' ? 'Plugin' : rawType === 'script' ? 'Script' : 'Skill';
  const rawStatus = String(body.status || 'enabled').trim().toLowerCase();
  const status = ['disabled', 'draft', 'error'].includes(rawStatus) ? rawStatus : 'enabled';
  const rawRisk = String(body.riskLevel || body.risk || 'medium').trim().toLowerCase();
  return {
    id: createId('tool'),
    name: String(body.name || body.displayName || 'Untitled tool').trim(),
    type,
    category: String(body.category || 'general').trim(),
    description: String(body.description || '').trim(),
    command: String(body.command || '').trim(),
    sourcePath: String(body.sourcePath || body.path || '').trim(),
    status,
    riskLevel: ['low', 'medium', 'high'].includes(rawRisk) ? rawRisk : 'medium',
    agents: parseCsvArray(body.agents || body.agent || []),
    permissions: parseCsvArray(body.permissions || []),
    createdAt: now,
    updatedAt: now,
    lastTest: null,
    gatewayFallback: true,
  };
}

function searchGatewayTools(gatewayState, query = '', filters = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const type = String(filters.type || '').trim().toLowerCase();
  const status = String(filters.status || '').trim().toLowerCase();
  return (gatewayState.tools || []).filter((tool) => {
    if (type && String(tool.type || '').toLowerCase() !== type) return false;
    if (status && String(tool.status || '').toLowerCase() !== status) return false;
    if (!needle) return true;
    return [
      tool.name,
      tool.type,
      tool.category,
      tool.description,
      tool.command,
      tool.sourcePath,
      tool.riskLevel,
      ...(tool.agents || []),
      ...(tool.permissions || []),
    ].some((value) => String(value || '').toLowerCase().includes(needle));
  });
}

function fallbackToolsList({ res, gatewayState, gatewayStore = null, query = {} }) {
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    tools: filterActualGatewayTools(searchGatewayTools(state, query.query || '', {
      type: query.type || '',
      status: query.status || '',
    })),
    state,
    gatewayFallback: true,
  });
}

function fallbackToolCreate({ res, gatewayState, gatewayStore = null, body = {} }) {
  if (gatewayStore && typeof gatewayStore.createTool === 'function') {
    const tool = gatewayStore.createTool(body);
    sendJson(res, 200, {
      tool,
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    });
    return;
  }
  sendDatabaseRequired(res, 'tools');
}

function fallbackToolPatch({ res, gatewayState, gatewayStore = null, toolId, body = {} }) {
  if (gatewayStore && typeof gatewayStore.updateTool === 'function') {
    const tool = gatewayStore.updateTool(toolId, body);
    if (!tool) {
      sendJson(res, 404, { error: 'Tool not found in gateway store', gatewayFallback: true });
      return;
    }
    sendJson(res, 200, {
      tool,
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    });
    return;
  }
  sendDatabaseRequired(res, 'tools');
}

function fallbackToolTest({ res, gatewayState, gatewayStore = null, toolId, body = {} }) {
  if (!gatewayStore) {
    sendDatabaseRequired(res, 'tool test runs');
    return;
  }
  const tool = gatewayStore && typeof gatewayStore.getTool === 'function'
    ? gatewayStore.getTool(toolId)
    : (gatewayState.tools || []).find((item) => item.id === String(toolId || ''));
  if (!tool) {
    sendJson(res, 404, { error: 'Tool not found in gateway fallback state', gatewayFallback: true });
    return;
  }
  const prompt = String(body.prompt || `Test Hermes tool ${tool.name}`).trim();
  const runInput = {
    name: `tool-test-${tool.name}`,
    goal: [
      `Tool test: ${tool.name}`,
      `Type: ${tool.type}`,
      tool.command ? `Command: ${tool.command}` : '',
      tool.sourcePath ? `Source: ${tool.sourcePath}` : '',
      '',
      `Prompt: ${prompt}`,
    ].filter(Boolean).join('\n'),
    agent: resolveRequestedOfficialProfile({
      agentId: body.agentId,
      agent: body.agent,
      fallback: (tool.agents || [])[0],
    }),
    model: body.model || 'Codex',
    source: 'tool-test',
    toolId: tool.id,
    sourceTool: tool,
    wikiWriteBack: tool.sourcePath || '6_agents/skills',
  };
  const run = gatewayStore && typeof gatewayStore.createRun === 'function'
    ? gatewayStore.createRun(runInput)
    : createGatewayRun(runInput);
  run.toolId = tool.id;
  run.sourceTool = tool;
  const lastTest = {
    status: 'queued',
    runId: run.id,
    runFile: run.file,
    checkedAt: new Date().toISOString(),
  };
  let updatedTool = tool;
  if (gatewayStore && typeof gatewayStore.recordToolTest === 'function') {
    updatedTool = gatewayStore.recordToolTest(tool.id, { run, status: lastTest.status }) || tool;
  }
  sendJson(res, 200, {
    tool: updatedTool,
    run,
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function searchGatewayDocuments(gatewayState, query = '', options = {}) {
  const needle = String(query || '').trim().toLowerCase();
  return (gatewayState.documents || []).map((document) => {
    const provenance = document.provenance || gatewayDocumentProvenance(document);
    return {
      ...document,
      provenance,
      provenanceLabel: document.provenanceLabel || gatewayProvenanceLabel(provenance),
      evidenceVisible: document.evidenceVisible !== undefined ? document.evidenceVisible : provenance !== 'test-fixture',
      isTestFixture: document.isTestFixture !== undefined ? document.isTestFixture : provenance === 'test-fixture',
    };
  }).filter((document) => {
    if (!options.includeFixtures && document.evidenceVisible === false) return false;
    if (!needle) return true;
    return [
      document.title,
      document.filename,
      document.mimeType,
      document.extractedText,
      document.wikiPath,
      document.source,
      document.sourceLabel,
      document.provenanceLabel,
      ...(document.tags || []),
    ].some((value) => String(value || '').toLowerCase().includes(needle));
  });
}

function fallbackDocumentsList({ res, gatewayState, gatewayStore = null, query = {} }) {
  const documents = gatewayStore && typeof gatewayStore.searchDocuments === 'function'
    ? gatewayStore.searchDocuments(query.query || '', { includeFixtures: query.includeFixtures === '1' })
    : searchGatewayDocuments(gatewayState, query.query || '', {
      includeFixtures: query.includeFixtures === '1',
    });
  sendJson(res, 200, {
    ok: true,
    documents,
    state: gatewayStore ? gatewaySnapshot(gatewayState, gatewayStore) : { ...gatewayState, documents },
    gatewayFallback: true,
  });
}

async function fallbackDocumentCreate({ res, gatewayState, gatewayStore = null, body = {} }) {
  if (!gatewayStore || typeof gatewayStore.createDocument !== 'function') {
    sendDatabaseRequired(res, 'documents');
    return;
  }
  const document = gatewayStore.createDocument(body);
  if (gatewayStore && typeof gatewayStore.indexDocumentChunks === 'function') {
    await gatewayStore.indexDocumentChunks(document);
  }
  sendJson(res, 200, {
    ok: true,
    document,
    written: { relativePath: document.wikiPath, gatewayFallback: true },
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackDocumentAnalyze({ res }) {
  sendDatabaseRequired(res, 'document analysis runs');
}

function addGatewayChatMessage(gatewayState, input = {}) {
  if (!Array.isArray(gatewayState.chatMessages)) gatewayState.chatMessages = [];
  const message = {
    id: createId('chat'),
    role: input.role || 'assistant',
    text: String(input.text || ''),
    runId: input.runId ? String(input.runId) : '',
    wikiPath: input.wikiPath ? String(input.wikiPath) : '',
    agent: input.agent ? String(input.agent) : '',
    model: input.model ? String(input.model) : '',
    source: input.source || 'chat',
    createdAt: new Date().toISOString(),
  };
  gatewayState.chatMessages.push(message);
  gatewayState.chatMessages = gatewayState.chatMessages.slice(-120);
  return message;
}

function fallbackChatMessages({ res, gatewayState, gatewayStore = null, limit = 80 }) {
  const messages = gatewayStore && typeof gatewayStore.listChatMessages === 'function'
    ? gatewayStore.listChatMessages({ limit })
    : (Array.isArray(gatewayState.chatMessages) ? gatewayState.chatMessages : []).slice(-Number(limit || 80));
  sendJson(res, 200, {
    messages,
    state: gatewayState,
    gatewayFallback: true,
  });
}

function listGatewayCommandInbox(gatewayState, { limit = 50, source = '', includeArchived = false } = {}) {
  const archived = new Set(Array.isArray(gatewayState.commandInboxArchivedIds) ? gatewayState.commandInboxArchivedIds : []);
  const items = [];
  (Array.isArray(gatewayState.chatMessages) ? gatewayState.chatMessages : [])
    .filter((message) => message.role === 'user' && message.text)
    .forEach((message) => {
      items.push({
        id: `chat:${message.id}`,
        rawId: message.id,
        source: 'web',
        sourceLabel: 'Web chat',
        title: message.text,
        text: message.text,
        receivedAt: message.createdAt,
        status: 'new',
        detail: 'gateway fallback web command',
      });
    });
  (Array.isArray(gatewayState.ticktickTasks) ? gatewayState.ticktickTasks : [])
    .filter((task) => task.executable !== false)
    .forEach((task) => {
      items.push({
        id: `ticktick:${task.id}`,
        rawId: task.id,
        source: 'ticktick',
        sourceLabel: 'TickTick',
        title: task.title || task.original || '',
        text: task.original || task.title || '',
        receivedAt: task.importedAt || '',
        status: task.action || 'Run',
        detail: [task.tags, task.due].filter(Boolean).join(' · '),
      });
    });
  (Array.isArray(gatewayState.telegramChatCandidates) ? gatewayState.telegramChatCandidates : [])
    .forEach((candidate) => {
      items.push({
        id: `telegram:${candidate.chatId}`,
        rawId: candidate.chatId,
        source: 'telegram',
        sourceLabel: 'Telegram',
        title: candidate.lastText || candidate.text || '/hermes Telegram command',
        text: candidate.lastText || candidate.text || '',
        receivedAt: candidate.lastSeenAt || candidate.receivedAt || candidate.firstSeenAt || '',
        status: candidate.reason || 'new',
        detail: [
          candidate.username ? `@${candidate.username}` : '',
          candidate.reason || '',
          candidate.seenCount ? `${candidate.seenCount}회 수신` : '',
        ].filter(Boolean).join(' · '),
      });
    });
  (Array.isArray(gatewayState.mailMessages) ? gatewayState.mailMessages : [])
    .forEach((message) => {
      items.push({
        id: message.id,
        rawId: message.messageId || message.id,
        source: message.provider || 'mail',
        sourceLabel: gatewayMailProviderLabel(message.provider),
        title: message.subject || '(no subject)',
        text: message.text || message.subject || '',
        receivedAt: message.receivedAt || message.importedAt || '',
        status: 'new',
        detail: message.from || message.accountId || 'mail',
        accountId: message.accountId || '',
      });
    });
  return items
    .filter((item) => includeArchived || !archived.has(item.id))
    .filter((item) => !source || item.source === source)
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .slice(0, Number(limit || 50));
}

function recordGatewayTelegramChatCandidate({ gatewayState, gatewayStore = null, parsed, reason = '' }) {
  if (!parsed || !parsed.chatId) return null;
  if (gatewayStore && typeof gatewayStore.addTelegramChatCandidate === 'function') {
    return gatewayStore.addTelegramChatCandidate({
      chatId: parsed.chatId,
      username: parsed.username,
      text: parsed.text,
      reason,
    });
  }
  if (!Array.isArray(gatewayState.telegramChatCandidates)) gatewayState.telegramChatCandidates = [];
  const chatId = String(parsed.chatId);
  const now = new Date().toISOString();
  const existing = gatewayState.telegramChatCandidates.find((item) => String(item.chatId) === chatId);
  if (existing) {
    existing.username = parsed.username || existing.username;
    existing.lastText = parsed.text || existing.lastText || '';
    existing.reason = reason || existing.reason || '';
    existing.lastSeenAt = now;
    existing.seenCount = Number(existing.seenCount || 1) + 1;
    return existing;
  }
  const record = {
    chatId,
    username: parsed.username || '',
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 1,
    lastText: parsed.text || '',
    reason,
  };
  gatewayState.telegramChatCandidates.unshift(record);
  gatewayState.telegramChatCandidates = gatewayState.telegramChatCandidates.slice(0, 200);
  return record;
}

function archiveGatewayCommandInboxItem(gatewayState, itemId) {
  if (!Array.isArray(gatewayState.commandInboxArchivedIds)) gatewayState.commandInboxArchivedIds = [];
  const id = String(itemId || '');
  if (id && !gatewayState.commandInboxArchivedIds.includes(id)) {
    gatewayState.commandInboxArchivedIds.push(id);
    gatewayState.commandInboxArchivedIds = gatewayState.commandInboxArchivedIds.slice(-500);
  }
}

function fallbackCommandInboxList({ res, gatewayState, gatewayStore = null, query = {} }) {
  const limit = Number(query.limit || 50);
  const source = query.source || '';
  const storeItems = gatewayStore && typeof gatewayStore.listCommandInbox === 'function'
    ? gatewayStore.listCommandInbox({ limit, source })
    : null;
  sendJson(res, 200, {
    items: storeItems || listGatewayCommandInbox(gatewayState, { limit, source }),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackCommandInboxAction({ res, gatewayState, gatewayStore = null, itemId, action, body = {} }) {
  if (!gatewayStore) {
    sendDatabaseRequired(res, 'command inbox actions');
    return;
  }
  const storeItem = gatewayStore && typeof gatewayStore.getCommandInboxItem === 'function'
    ? gatewayStore.getCommandInboxItem(String(itemId || ''))
    : null;
  const item = storeItem || listGatewayCommandInbox(gatewayState, { limit: 500, includeArchived: true })
    .find((candidate) => candidate.id === String(itemId || ''));
  if (!item) {
    sendJson(res, 404, { error: 'Command inbox item not found in gateway fallback state', gatewayFallback: true });
    return;
  }
  const archiveItem = () => {
    if (gatewayStore && typeof gatewayStore.archiveCommandInboxItem === 'function') {
      gatewayStore.archiveCommandInboxItem(item.id);
    }
  };
  if (action === 'archive') {
    archiveItem();
    sendJson(res, 200, { item, archived: true, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  if (action === 'star' || action === 'unstar') {
    const starred = action === 'star';
    gatewayStore.setCommandInboxItemStarred(item.id, starred);
    sendJson(res, 200, { item: { ...item, starred, star: starred }, starred, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  const command = routeWebCommand({
    message: body.message || item.text || item.title,
    view: 'inbox',
    agent: body.agent,
    agentId: body.agentId,
  });
  if (action === 'run') {
    const payload = buildMissionRunPayload({
      templateId: command.templateId,
      goal: command.message,
      agent: body.agent,
      agentId: body.agentId || command.agent,
      model: body.model || command.model,
      source: item.source,
    });
    const run = typeof gatewayStore.saveRun === 'function'
      ? gatewayStore.saveRun(createGatewayRun(payload))
      : gatewayStore.createRun(payload);
    archiveItem();
    sendJson(res, 200, { item, command, mission: payload.mission, run, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  if (action === 'task') {
    const task = gatewayStore.createTask({
      title: command.message,
      owner: 'Agent',
      status: 'Queued',
      date: body.date || dateStamp(),
      agent: resolveRequestedOfficialProfile({
        agentId: body.agentId || command.agent,
        agent: body.agent,
      }),
      model: body.model || command.model,
      source: item.source,
      project: body.project || 'Command Inbox',
      tags: ['inbox', item.source],
      notes: `Captured from ${item.sourceLabel || item.source}`,
      sourceId: item.id,
    });
    archiveItem();
    sendJson(res, 200, { item, command, task, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  sendJson(res, 405, { error: 'Unsupported command inbox action', gatewayFallback: true });
}

function fallbackTelegramWebhook({ res, body = {}, env = process.env, gatewayState, gatewayStore = null }) {
  if (!gatewayStore) {
    sendDatabaseRequired(res, 'telegram commands');
    return;
  }
  const parsed = parseTelegramUpdate(body);
  const allowedChatIds = String(env.HERMES_TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowedChatIds.length) {
    recordGatewayTelegramChatCandidate({
      gatewayState,
      gatewayStore,
      parsed,
      reason: 'chat allowlist not configured',
    });
    sendJson(res, 403, {
      accepted: false,
      reason: 'chat allowlist not configured',
      parsed,
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    });
    return;
  }
  if (!allowedChatIds.includes(String(parsed.chatId))) {
    recordGatewayTelegramChatCandidate({
      gatewayState,
      gatewayStore,
      parsed,
      reason: 'chat not allowed',
    });
    sendJson(res, 403, {
      accepted: false,
      reason: 'chat not allowed',
      parsed,
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    });
    return;
  }
  recordGatewayTelegramChatCandidate({
    gatewayState,
    gatewayStore,
    parsed,
    reason: parsed.shouldRun ? 'queued from telegram webhook' : 'telegram message captured',
  });
  if (!parsed.shouldRun) {
    sendJson(res, 200, { accepted: true, parsed, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  const run = typeof gatewayStore.saveRun === 'function'
    ? gatewayStore.saveRun(createGatewayRun(createRunPayloadFromTelegram(parsed)))
    : gatewayStore.createRun(createRunPayloadFromTelegram(parsed));
  sendJson(res, 200, { accepted: true, parsed, run, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
}

async function fallbackMailSync({
  res,
  body = {},
  env = process.env,
  fetchImpl = fetch,
  gatewayState,
  gatewayStore = null,
}) {
  if (!gatewayStore || typeof gatewayStore.setMailSyncStatus !== 'function') {
    sendDatabaseRequired(res, 'mail sync status');
    return;
  }
  await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
  const mergedState = () => mergeGatewayLiveState(gatewayState, gatewayState, env, gatewayStore);
  const commandItems = () => (gatewayStore && typeof gatewayStore.listCommandInbox === 'function'
    ? gatewayStore.listCommandInbox({ limit: 200 })
    : listGatewayCommandInbox(gatewayState, { limit: 200 }));
  const saveMailSyncStatus = (status) => {
    if (gatewayStore && typeof gatewayStore.setMailSyncStatus === 'function') {
      return gatewayStore.setMailSyncStatus(status);
    }
    gatewayState.mailSyncStatus = status;
    return status;
  };
  const accounts = parseGatewayMailAccounts(env);
  if (!accounts.length) {
    saveMailSyncStatus({
      checkedAt: new Date().toISOString(),
      accounts: [],
      importedCount: 0,
      ok: false,
      reason: 'missing-accounts',
    });
    const state = mergedState();
    sendJson(res, 200, {
      ok: true,
      imported: [],
      accounts: [],
      items: commandItems(),
      tasks: gatewayTasksFromState(state),
      state,
      gatewayMerged: true,
      gatewayFallback: true,
      detail: 'HERMES_MAIL_ACCOUNTS_JSON is not configured on Railway.',
    });
    return;
  }
  const syncResult = await syncMailAccounts({
    accounts,
    limit: Number(body.limit || 20),
  });
  const imported = gatewayStore && typeof gatewayStore.importMailMessages === 'function'
    ? gatewayStore.importMailMessages(syncResult.messages)
    : importGatewayMailMessages(gatewayState, syncResult.messages);
  saveMailSyncStatus({
    checkedAt: new Date().toISOString(),
    accounts: syncResult.accounts,
    importedCount: imported.length,
    ok: syncResult.accounts.some((account) => account.ok),
    reason: syncResult.accounts.find((account) => !account.ok)?.reason || '',
  });
  const state = mergedState();
  sendJson(res, 200, {
    ok: true,
    imported,
    accounts: syncResult.accounts,
    settings: { mail: { accounts: publicGatewayMailAccounts(env) } },
    items: commandItems(),
    tasks: gatewayTasksFromState(state),
    state,
    gatewayMerged: true,
    gatewayFallback: true,
  });
}

function buildRuntimeRecoveryCommand() {
  const updateUrl = 'https://hermes-os-production-e174.up.railway.app/hermes-runtime-update.tar.gz';
  return [
    'cd "${HERMES_RUNTIME_DIR:-$HOME/.hermes/os-runtime}"',
    'rm -rf /tmp/hermes-runtime-update',
    'mkdir -p /tmp/hermes-runtime-update',
    `curl -fsSL "${updateUrl}" -o /tmp/hermes-runtime-update.tar.gz`,
    'tar -xzf /tmp/hermes-runtime-update.tar.gz -C /tmp/hermes-runtime-update',
    `HERMES_RUNTIME_DIR="$PWD" HERMES_RUNTIME_UPDATE_URL="${updateUrl}" bash /tmp/hermes-runtime-update/scripts/apply-runtime-update.sh`,
  ].join(' && ');
}

function buildResidentInstallCommand() {
  const updateUrl = 'https://hermes-os-production-e174.up.railway.app/hermes-runtime-update.tar.gz';
  return [
    '# Install Hermes OS as launchd KeepAlive resident services on the Mac mini.',
    'cd "${HERMES_RUNTIME_DIR:-$HOME/.hermes/os-runtime}"',
    'rm -rf /tmp/hermes-runtime-update',
    'mkdir -p /tmp/hermes-runtime-update',
    `curl -fsSL "${updateUrl}" -o /tmp/hermes-runtime-update.tar.gz`,
    'tar -xzf /tmp/hermes-runtime-update.tar.gz -C /tmp/hermes-runtime-update',
    `HERMES_RUNTIME_DIR="$PWD" HERMES_RUNTIME_UPDATE_URL="${updateUrl}" bash /tmp/hermes-runtime-update/scripts/apply-runtime-update.sh`,
    'bash scripts/install-macmini-resident.sh',
  ].join(' && ');
}

function buildExecutionReceipt({ task, run } = {}) {
  if (!run) return null;
  return {
    kind: 'agent-run',
    taskId: task && task.id,
    runId: run.id,
    runStatus: run.status,
    runFile: run.file,
    wikiPath: run.file,
    runsView: 'runs',
    visualBriefPath: `/api/runs/${encodeURIComponent(run.id)}/visual-brief`,
    saveVisualBriefPath: `/api/runs/${encodeURIComponent(run.id)}/visual-brief/save`,
  };
}

function createGatewayTask(draft, { action = 'Create', run } = {}) {
  const status = action === 'Run now' && draft.owner !== 'Me' ? 'Running' : draft.status;
  return {
    id: createId('task'),
    title: draft.title,
    owner: draft.owner,
    status,
    due: [draft.date, draft.time].filter(Boolean).join(' ') || 'Unscheduled',
    date: draft.date,
    time: draft.time,
    lane: status,
    tag: draft.owner === 'Agent' ? 'mint' : draft.owner === 'Hybrid' ? 'amber' : 'blue',
    agent: draft.agent,
    model: draft.model,
    executable: draft.owner !== 'Me',
    successCriteria: draft.successCriteria || [],
    wikiDestination: draft.wikiDestination,
    priority: draft.priority || 'medium',
    tags: draft.tags || [],
    project: draft.project || '',
    notes: draft.content || draft.originalText || '',
    source: draft.source || 'calendar',
    runId: run ? run.id : '',
    runFile: run ? run.file : '',
    createdAt: new Date().toISOString(),
  };
}

function buildCalendarRunPayload(draft) {
  const wikiFile = `5_conversation/agent-runs/${draft.date || dateStamp()}-${slugify(draft.title, 'calendar-run')}.md`;
  return {
    name: draft.title,
    goal: [
      `Calendar work: ${draft.title}`,
      `Owner: ${draft.owner}`,
      `Scheduled: ${draft.date}${draft.time ? ` ${draft.time}` : ''}`,
      `LLM-Wiki write-back: ${draft.wikiDestination}`,
      `Exact result file: ${wikiFile}`,
      'When the work is complete, write the final summary, artifacts, and resume notes to that exact LLM-Wiki markdown file.',
      'Success criteria:',
      ...(draft.successCriteria || []).map((item) => `- ${item}`),
    ].join('\n'),
    file: wikiFile,
    agent: draft.agent,
    model: draft.model,
    source: 'calendar',
    noApproval: true,
    successCriteria: draft.successCriteria || [],
    wikiWriteBack: draft.wikiDestination,
    mission: {
      id: draft.routeTemplateId,
      label: 'Calendar quick-add',
      wikiWriteBack: draft.wikiDestination,
    },
  };
}

function buildChatRunPayload(command) {
  const wikiFile = `5_conversation/agent-runs/${dateStamp()}-${slugify(command.message, 'chat-run')}.md`;
  return {
    name: command.message,
    goal: [
      `Hermes chat: ${command.message}`,
      `Mode: ${command.templateId}`,
      `Agent: ${command.agent}`,
      `Model: ${command.model}`,
      `Exact result file: ${wikiFile}`,
      'Respond to the user conversationally, execute the work without human approval, and write resumable notes to the exact LLM-Wiki file.',
    ].join('\n'),
    agent: resolveOfficialProfileName(command.agent),
    model: command.model,
    source: 'chat',
    noApproval: true,
    file: wikiFile,
    wikiWriteBack: wikiFile,
    mission: {
      id: command.templateId,
      label: 'Hermes Chat',
      wikiWriteBack: wikiFile,
    },
  };
}

function normalizeRuntimeRun(run = {}, payload = {}) {
  const normalized = {
    ...run,
    id: run.id || createId('run'),
    name: run.name || payload.name || 'Hermes run',
    goal: run.goal || payload.goal || '',
    agent: run.agent || payload.agent || 'Hermes',
    model: run.model || payload.model || 'Codex',
    status: run.status || 'running',
    source: run.source || payload.source || 'calendar',
    toolId: run.toolId || payload.toolId || '',
    sourceTool: run.sourceTool || payload.sourceTool || null,
    file: run.file || run.wikiPath || payload.file || run.logPath || '',
    logs: Array.isArray(run.logs) && run.logs.length
      ? run.logs
      : [
        'run created',
        run.cwd ? `cwd=${run.cwd}` : '',
        run.logPath ? `log=${run.logPath}` : '',
        'wiki write-back ready',
      ].filter(Boolean),
  };
  return normalized;
}

async function postRuntimeRun({ env, fetchImpl, payload }) {
  const runtimeRequest = buildRuntimeProxyRequest({
    runtimeUrl: env.HERMES_RUNTIME_URL,
    runtimeToken: env.HERMES_RUNTIME_TOKEN,
    method: 'POST',
    path: ['runs'],
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const response = await fetchImpl(runtimeRequest.url, runtimeRequest.options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Runtime run request failed: ${response.status}`);
  }
  const parsed = text ? JSON.parse(text) : {};
  return normalizeRuntimeRun(parsed.run || parsed, payload);
}

function normalizeHermesApiServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function hermesApiServerChatUrl(env = process.env) {
  const baseUrl = normalizeHermesApiServerUrl(env.HERMES_API_SERVER_URL);
  if (!baseUrl) return '';
  return `${baseUrl}/chat/completions`;
}

function hermesApiServerPayload({ body = {}, command = {}, env = process.env } = {}) {
  const model = String(body.model || env.HERMES_API_SERVER_MODEL || 'hermes-agent').trim() || 'hermes-agent';
  const message = String(command.message || body.message || '').trim();
  const providedMessages = Array.isArray(body.messages)
    ? body.messages
      .filter((item) => item && typeof item === 'object' && item.role && item.content)
      .map((item) => ({ role: String(item.role), content: String(item.content) }))
    : [];
  const messages = providedMessages.length
    ? providedMessages
    : [
      {
        role: 'system',
        content: [
          'You are the Mac Mini Hermes agent behind Hermes OS.',
          'Answer the user directly and stream useful progress.',
          `Selected Hermes agent: ${command.agent || body.agentId || body.agent || 'default'}.`,
          `Hermes OS view: ${body.view || 'dashboard'}.`,
        ].join(' '),
      },
      { role: 'user', content: message },
    ];
  return {
    model,
    stream: true,
    messages,
  };
}

function openAiStreamDataFromRecord(record) {
  const data = String(record || '')
    .split(/\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace(/^data:\s?/, ''))
    .join('\n')
    .trim();
  return data || null;
}

function extractOpenAiStreamDelta(payload = {}) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const texts = [];
  const tools = [];
  choices.forEach((choice) => {
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string') texts.push(delta.content);
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall) => {
        const name = toolCall?.function?.name || toolCall?.name || toolCall?.id || 'tool_call';
        tools.push({
          tool: String(name),
          state: choice.finish_reason ? 'done' : 'streaming',
          detail: toolCall?.function?.arguments || toolCall?.id || 'Hermes tool call',
        });
      });
    }
  });
  return { text: texts.join(''), tools };
}

function extractRelayCompletionText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const direct = [
    value.text,
    value.content,
    value.message,
    value.response,
    value.output_text,
    value.outputText,
  ].find((item) => typeof item === 'string' && item.trim());
  if (direct) return direct;
  if (Array.isArray(value.choices)) {
    return value.choices.map((choice) => (
      choice?.message?.content
      || choice?.delta?.content
      || choice?.text
      || ''
    )).filter(Boolean).join('');
  }
  if (Array.isArray(value.output)) {
    return value.output.map((item) => (
      typeof item === 'string'
        ? item
        : Array.isArray(item?.content)
          ? item.content.map((content) => content?.text || content?.content || '').join('')
          : item?.text || item?.content || ''
    )).filter(Boolean).join('');
  }
  return extractRelayCompletionText(value.body)
    || extractRelayCompletionText(value.result)
    || extractRelayCompletionText(value.data);
}

async function streamHermesApiServerChat({
  res,
  body,
  command,
  env,
  fetchImpl,
  gatewayState,
  gatewayStore = null,
} = {}) {
  const chatUrl = hermesApiServerChatUrl(env);
  const apiKey = String(env.HERMES_API_SERVER_KEY || '').trim();
  if (!chatUrl || !apiKey) return false;

  let response;
  try {
    response = await fetchImpl(chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(hermesApiServerPayload({ body, command, env })),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  const run = normalizeRuntimeRun({
    id: createId('hermes-api'),
    name: command.message,
    goal: `Hermes API Server chat: ${command.message}`,
    agent: command.agent || body.agentId || body.agent || 'default',
    model: body.model || env.HERMES_API_SERVER_MODEL || 'hermes-agent',
    status: 'completed',
    source: 'mac-mini-hermes-api',
    file: `5_conversation/agent-runs/${dateStamp()}-${slugify(command.message, 'hermes-api-chat')}.md`,
    gatewayFallback: false,
    runtimeReachable: true,
    logs: [
      'mac-mini-hermes-api stream connected',
      'OpenAI-compatible SSE bridge active',
    ],
  }, {
    name: command.message,
    goal: command.message,
    agent: command.agent,
    model: body.model || env.HERMES_API_SERVER_MODEL || 'hermes-agent',
    source: 'mac-mini-hermes-api',
  });
  const visualization = {
    agentState: {
      agent: run.agent,
      model: run.model,
      mode: 'mac-mini-hermes-api',
      status: 'streaming',
      runId: run.id,
      reason: 'Mac Mini Hermes API Server OpenAI-compatible SSE stream.',
    },
    timeline: [
      { label: 'Message received', detail: command.message },
      { label: 'Legacy runtime checked', detail: 'Falling through to Hermes API Server.' },
      { label: 'API Server stream connected', detail: 'mac-mini-hermes-api' },
    ],
    toolActivity: [
      { tool: 'Hermes API Server', state: 'streaming', detail: 'OpenAI-compatible /v1/chat/completions' },
    ],
    memory: {
      wikiPath: run.file,
      savePolicy: 'chat transcript is persisted in the Railway gateway chat history',
      next: 'Use tool-call SSE chunks to render live Hermes activity when the model invokes tools.',
      source: 'mac-mini-hermes-api',
    },
  };
  const stateSummary = compactStateSummary(gatewaySnapshot(gatewayState, gatewayStore));
  const finalTextParts = [];
  let done = false;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  writeSseEvent(res, 'agent-state', visualization.agentState);
  writeSseEvent(res, 'timeline', visualization.timeline);
  writeSseEvent(res, 'tool-activity', visualization.toolActivity);
  writeSseEvent(res, 'memory', visualization.memory);

  const finish = () => {
    if (done) return;
    done = true;
    run.status = 'completed';
    run.logs = [...(run.logs || []), `assistant_text_chars=${finalTextParts.join('').length}`];
    const finalText = finalTextParts.join('');
    const userMessage = {
      role: 'user',
      text: command.message,
      runId: run.id,
      wikiPath: run.file,
      agent: run.agent,
      model: run.model,
      source: 'chat',
    };
    const assistantMessage = {
      role: 'assistant',
      text: finalText,
      runId: run.id,
      wikiPath: run.file,
      agent: run.agent,
      model: run.model,
      source: 'mac-mini-hermes-api',
    };
    if (gatewayStore) {
      gatewayStore.addChatMessage(userMessage);
      gatewayStore.addChatMessage(assistantMessage);
    }
    writeSseEvent(res, 'run', { run, stateSummary });
    writeSseEvent(res, 'done', {
      text: finalText,
      visualization,
      run,
      stateSummary,
      source: 'mac-mini-hermes-api',
    });
    res.end();
  };

  const consumeRecord = (record) => {
    const data = openAiStreamDataFromRecord(record);
    if (!data) return;
    if (data === '[DONE]') {
      finish();
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const { text, tools } = extractOpenAiStreamDelta(payload);
    if (tools.length) writeSseEvent(res, 'tool-activity', tools);
    if (text) {
      finalTextParts.push(text);
      writeSseEvent(res, 'delta', { text });
    }
  };

  const consumeBuffer = (input, flush = false) => {
    const parts = String(input || '').replace(/\r\n/g, '\n').split('\n\n');
    const remainder = flush ? '' : parts.pop();
    parts.forEach(consumeRecord);
    if (flush && parts.length === 0 && input) consumeRecord(input);
    return remainder || '';
  };

  let buffer = '';
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer = consumeBuffer(buffer + decoder.decode(value, { stream: true }));
      }
      if (!done) {
        buffer += decoder.decode();
        consumeBuffer(buffer, true);
      }
    } else {
      consumeBuffer(await response.text(), true);
    }
  } catch (error) {
    writeSseEvent(res, 'error', {
      error: safeRuntimeError(error.message || String(error), 'Hermes API Server stream failed'),
      source: 'mac-mini-hermes-api',
    });
  }
  finish();
  return true;
}

async function streamRailwayRelayChat({
  res,
  body,
  command,
  env,
  gatewayState,
  gatewayStore = null,
  relay = null,
} = {}) {
  if (!relay || !relayEnabled(env) || !relay.isBridgeOnline()) return false;

  const run = normalizeRuntimeRun({
    id: createId('relay'),
    name: command.message,
    goal: `Railway relay chat: ${command.message}`,
    agent: command.agent || body.agentId || body.agent || 'default',
    model: body.model || env.HERMES_API_SERVER_MODEL || 'hermes-agent',
    status: 'running',
    source: 'railway-relay',
    file: `5_conversation/agent-runs/${dateStamp()}-${slugify(command.message, 'railway-relay-chat')}.md`,
    gatewayFallback: false,
    runtimeReachable: true,
    logs: [
      'railway-relay job queued',
      'waiting for outbound Mac mini bridge',
    ],
  }, {
    name: command.message,
    goal: command.message,
    agent: command.agent,
    model: body.model || env.HERMES_API_SERVER_MODEL || 'hermes-agent',
    source: 'railway-relay',
  });
  const visualization = {
    agentState: {
      agent: run.agent,
      model: run.model,
      mode: 'railway-relay',
      status: 'streaming',
      runId: run.id,
      reason: 'Mac mini bridge connected outbound to Railway relay.',
    },
    timeline: [
      { label: 'Message received', detail: command.message },
      { label: 'Relay selected', detail: 'Using outbound Mac mini bridge instead of public inbound tunnel.' },
      { label: 'Bridge job queued', detail: 'Railway relay is waiting for Mac mini execution events.' },
    ],
    toolActivity: [
      { tool: 'Railway Relay', state: 'queued', detail: 'outbound bridge job' },
    ],
    memory: {
      wikiPath: run.file,
      savePolicy: 'chat transcript is persisted in the Railway gateway chat history',
      next: 'Mac mini bridge posts streaming tool and text events back to Railway.',
      source: 'railway-relay',
    },
  };
  const job = relay.enqueue({
    kind: 'chat.completions',
    payload: hermesApiServerPayload({ body, command, env }),
    meta: {
      runId: run.id,
      agent: run.agent,
      model: run.model,
      wikiPath: run.file,
      view: body.view || 'dashboard',
    },
  });
  const stateSummary = compactStateSummary(gatewaySnapshot(gatewayState, gatewayStore));
  const finalTextParts = [];
  let cursor = 0;
  let done = false;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  writeSseEvent(res, 'agent-state', visualization.agentState);
  writeSseEvent(res, 'timeline', visualization.timeline);
  writeSseEvent(res, 'tool-activity', visualization.toolActivity);
  writeSseEvent(res, 'memory', visualization.memory);

  const finish = ({ error = null } = {}) => {
    if (done) return;
    done = true;
    run.status = error ? 'failed' : 'completed';
    run.logs = [
      ...(run.logs || []),
      `railway-relay job=${job.id}`,
      error ? `railway-relay error=${error}` : `assistant_text_chars=${finalTextParts.join('').length}`,
    ];
    const finalText = finalTextParts.join('');
    const relayNoText = !finalText.trim() && !error
      ? `Mac mini relay completed but did not return assistant text. Run saved: ${run.file}`
      : '';
    const userMessage = {
      role: 'user',
      text: command.message,
      runId: run.id,
      wikiPath: run.file,
      agent: run.agent,
      model: run.model,
      source: 'chat',
    };
    const assistantMessage = {
      role: 'assistant',
      text: finalText || (error ? `Railway relay failed: ${error}` : relayNoText),
      runId: run.id,
      wikiPath: run.file,
      agent: run.agent,
      model: run.model,
      source: 'railway-relay',
    };
    if (gatewayStore) {
      gatewayStore.addChatMessage(userMessage);
      gatewayStore.addChatMessage(assistantMessage);
    }
    writeSseEvent(res, 'run', { run, stateSummary });
    writeSseEvent(res, 'done', {
      text: assistantMessage.text,
      visualization,
      run,
      stateSummary,
      source: 'railway-relay',
      gatewayFallback: false,
      runtimeReachable: !error,
      ...(error ? { error } : {}),
    });
    res.end();
  };

  const forwardRelayEvent = (record) => {
    if (!record || !record.event) return;
    if (record.event === 'delta' && record.data && typeof record.data.text === 'string') {
      finalTextParts.push(record.data.text);
    }
    if (record.event === 'error') {
      const error = safeRuntimeError(record.data?.error || 'Railway relay bridge failed', 'Railway relay bridge failed');
      writeSseEvent(res, 'error', { error, source: 'railway-relay' });
      finish({ error });
      return;
    }
    if (record.event === 'bridge-complete') {
      const completionText = extractRelayCompletionText(record.data);
      if (completionText && !finalTextParts.join('').trim()) {
        finalTextParts.push(completionText);
        writeSseEvent(res, 'delta', { text: completionText });
      }
      return;
    }
    writeSseEvent(res, record.event, record.data === undefined ? {} : record.data);
  };

  const timeoutMs = Number(env.HERMES_RELAY_STREAM_TIMEOUT_MS || 90_000);
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (!done && Date.now() < deadline) {
    const batch = await relay.waitForEvents(job.id, cursor, Math.min(5_000, Math.max(1, deadline - Date.now())));
    cursor = batch.cursor;
    (batch.events || []).forEach(forwardRelayEvent);
    if (!done && batch.complete) finish();
  }
  if (!done) {
    relay.fail(job.id, new Error('railway relay bridge timed out'));
    finish({ error: 'railway relay bridge timed out' });
  }
  return true;
}

function createGatewayRun(payload) {
  const name = payload.name || payload.goal || 'Hermes run';
  const file = payload.file
    || (payload.wikiWriteBack && String(payload.wikiWriteBack).startsWith('5_conversation/agent-runs/')
      ? payload.wikiWriteBack
      : `5_conversation/agent-runs/${dateStamp()}-${slugify(name, 'agent-run')}.md`);
  return normalizeRuntimeRun({
    id: createId('run'),
    name,
    goal: payload.goal,
    agent: payload.agent,
    model: payload.model,
    status: 'gateway-fallback',
    source: payload.source,
    file,
    gatewayFallback: true,
    runtimeReachable: false,
    logs: [
      'gateway fallback run created',
      `agent=${payload.agent || 'Hermes'}`,
      `model=${payload.model || 'Codex'}`,
      `wiki=${file}`,
    ],
  }, payload);
}

async function fallbackState(res, gatewayState, env = process.env, gatewayStore = null, fetchImpl = fetch) {
  await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    ...state,
    systemConnections: state.systemConnections || {
      managedBy: 'railway-gateway-env',
      reason: 'state-fallback',
      checkedAt: new Date().toISOString(),
      gatewayFallback: true,
      runtimeReachable: false,
      ticktick: {
        connected: Boolean(env.HERMES_TICKTICK_ACCESS_TOKEN),
        state: env.HERMES_TICKTICK_ACCESS_TOKEN ? 'ready' : 'missing',
        detail: env.HERMES_TICKTICK_ACCESS_TOKEN
          ? 'Railway gateway has HERMES_TICKTICK_ACCESS_TOKEN.'
          : 'HERMES_TICKTICK_ACCESS_TOKEN is not provisioned on Railway gateway.',
        token: env.HERMES_TICKTICK_ACCESS_TOKEN ? '••••' : '',
        importedCount: Array.isArray(state.ticktickTasks) ? state.ticktickTasks.length : 0,
      },
      telegram: {
        connected: Boolean(env.HERMES_TELEGRAM_BOT_TOKEN),
        state: env.HERMES_TELEGRAM_BOT_TOKEN ? 'ready' : 'missing',
        detail: env.HERMES_TELEGRAM_BOT_TOKEN
          ? 'Railway gateway has HERMES_TELEGRAM_BOT_TOKEN.'
          : 'HERMES_TELEGRAM_BOT_TOKEN is not provisioned on Railway gateway.',
        token: env.HERMES_TELEGRAM_BOT_TOKEN ? '••••' : '',
        allowedChatCount: String(env.HERMES_TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((item) => item.trim()).filter(Boolean).length,
        webhookUrl: gatewayPublicBaseUrl(env) ? `${gatewayPublicBaseUrl(env)}/api/telegram/webhook` : '',
        registered: false,
      },
      remote: {
        publicBaseUrl: gatewayPublicBaseUrl(env),
        authEnabled: Boolean(env.HERMES_RUNTIME_TOKEN),
      },
      wikiRoot: env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
    },
    gatewayFallback: true,
  });
}

function fallbackUsage({ res, gatewayState, gatewayStore = null, env = process.env }) {
  const now = new Date();
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const snapshot = readGatewayUsageSnapshot(env);
  const stateUsage = usageFromState(state, { now });
  const localUsage = snapshot?.usage && usageHasMetrics(snapshot.usage)
    ? null
    : readExternalUsageSources({ env, now });
  const usage = mergeUsageSummaries([
    snapshot?.usage || null,
    stateUsage,
    localUsage,
  ], { now });
  if (snapshot?.error) {
    usage.sourceStatus.push({ source: snapshot.source || 'local-usage-snapshot', ok: false, error: snapshot.error });
  }
  sendJson(res, 200, {
    ok: true,
    usage,
    state,
    gatewayFallback: true,
    runtimeReachable: false,
    fallbackReason: snapshot?.usage ? 'usage-snapshot' : 'railway-gateway-usage',
    snapshotSource: snapshot?.source || '',
  });
}

function buildOperationsOverview({ gatewayState, gatewayStore = null, env = process.env, relaySnapshot = null } = {}) {
  const now = new Date();
  const state = relaySnapshot
    ? relayStateFromSnapshot(relaySnapshot, gatewayState, env, gatewayStore)
    : gatewaySnapshot(gatewayState, gatewayStore);
  const snapshot = readGatewayUsageSnapshot(env);
  const usage = mergeUsageSummaries([
    snapshot?.usage || null,
    usageFromState(state, { now }),
    snapshot?.usage && usageHasMetrics(snapshot.usage) ? null : readExternalUsageSources({ env, now }),
  ], { now });
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const sessions = Array.isArray(relaySnapshot?.sessions)
    ? relaySnapshot.sessions
    : Array.isArray(state.sessions)
      ? state.sessions
      : [];
  const schedulerJobs = Array.isArray(state.schedulerJobs)
    ? state.schedulerJobs
    : Array.isArray(state.automationJobs)
      ? state.automationJobs
      : [];
  const runLogs = runs.flatMap((run) => (Array.isArray(run.logs) ? run.logs.map((line) => ({
    source: run.id || run.goal || 'run',
    level: String(line || '').toLowerCase().includes('error') ? 'error' : 'info',
    text: String(line || ''),
    time: run.updatedAt || run.createdAt || run.start || '',
  })) : []));
  const schedulerLogs = schedulerJobs
    .filter((job) => job.lastError || job.lastStatus)
    .map((job) => ({
      source: job.name || job.id || 'scheduler',
      level: job.lastError ? 'error' : 'info',
      text: String(job.lastError || job.lastStatus || ''),
      time: job.lastRunAt || '',
    }));
  const logs = [...runLogs, ...schedulerLogs].slice(-80).reverse();
  const models = (Array.isArray(usage.byModel) ? usage.byModel : []).map((model) => ({
    model: model.model || 'Other',
    totalTokens: Number(model.totalTokens || 0),
    inputTokens: Number(model.inputTokens || 0),
    outputTokens: Number(model.outputTokens || 0),
    runCount: Number(model.runCount || 0),
    source: 'usage-summary',
  }));
  const profiles = Array.isArray(state.agents) ? state.agents.map((agent) => ({
    id: agent.id || agent.name || agent.displayName || '',
    model: agent.model || agent.executionBackend?.model || agent.runtimeBinding?.model || '',
    provider: agent.profile?.provider || '',
    gateway: agent.profile?.gateway || '',
    skillCount: agent.profile?.skillCount || (Array.isArray(agent.skills) ? agent.skills.length : 0),
  })) : [];
  const system = {
    gateway: relaySnapshot ? 'relay-snapshot' : 'railway-gateway',
    runtimeReachable: Boolean(relaySnapshot),
    runtimeUrl: env.HERMES_RUNTIME_URL ? String(env.HERMES_RUNTIME_URL).replace(/\/\/[^/@]+@/, '//[redacted]@') : '',
    publicBaseUrl: gatewayPublicBaseUrl(env),
    checkedAt: now.toISOString(),
    schedulerJobs: schedulerJobs.length,
    agents: Array.isArray(state.agents) ? state.agents.length : 0,
    tools: Array.isArray(state.tools) ? state.tools.length : 0,
    usageSource: snapshot?.source || 'railway-gateway-usage',
    health: relaySnapshot?.health || null,
  };
  return {
    ok: true,
    operations: {
      sessions: {
        total: Number(usage.totalRuns || runs.length || sessions.length || 0),
        recent: sessions.slice(0, 30),
        runs: runs.slice(0, 30).map((run) => ({
          id: run.id || '',
          goal: run.goal || run.name || '',
          agent: run.agent || run.agentId || '',
          status: run.status || '',
          model: run.model || '',
          elapsed: run.elapsed || '',
          file: run.file || run.wikiPath || run.wikiWriteBack || '',
        })),
      },
      models,
      profiles,
      logs,
      system,
      sourceStatus: usage.sourceStatus || [],
    },
    state,
    gatewayFallback: !relaySnapshot,
    runtimeReachable: Boolean(relaySnapshot),
  };
}

function fallbackOperationsOverview({ res, gatewayState, gatewayStore = null, env = process.env, relaySnapshot = null }) {
  sendJson(res, 200, buildOperationsOverview({
    gatewayState,
    gatewayStore,
    env,
    relaySnapshot,
  }));
}

function fallbackHealth(res, runtimeResponse, env = process.env, error = null) {
  const runtimeUrl = (env.HERMES_RUNTIME_URL || '').replace(/\/+$/, '');
  const fallbackError = 'Mac mini runtime unreachable';
  const safeError = error
    ? safeRuntimeError(error.message || String(error), fallbackError)
    : fallbackError;
  sendJson(res, 200, {
    ok: false,
    name: 'Agent Calendar Railway Gateway',
    gatewayFallback: true,
    runtimeReachable: false,
    status: runtimeResponse ? runtimeResponse.status : 0,
    runtimeUrl,
    resident: {
      executionPlane: 'railway-control-plane',
      runtimeExecutionAvailable: false,
      process: null,
      schedulerDaemon: {
        running: false,
        isTicking: false,
        lastRun: null,
        lastError: safeError,
      },
      deploymentStatus: {
        ready: false,
        checks: {},
      },
      launchctl: {
        loaded: false,
        domainTarget: 'unavailable-from-railway',
        error: 'launchctl status can only be checked on the Mac mini runtime.',
      },
    },
    lastRuntimeUpdate: {
      status: 'unknown',
      updateUrl: '',
      backupDir: '',
      appliedAt: '',
      error: 'Mac mini runtime unreachable; check runtime health after recovery.',
    },
    ...(error ? { error: safeError } : {}),
    recoveryCommand: buildRuntimeRecoveryCommand(),
    residentInstallCommand: buildResidentInstallCommand(),
    message: 'Mac mini runtime is unreachable from the public gateway.',
    time: new Date().toISOString(),
  });
}

function fallbackSettings(res, env = process.env) {
  const ticktickAccessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  const ticktickClientId = env.HERMES_TICKTICK_CLIENT_ID || '';
  const ticktickClientSecret = env.HERMES_TICKTICK_CLIENT_SECRET || '';
  const telegramBotToken = env.HERMES_TELEGRAM_BOT_TOKEN || '';
  const allowedChatIds = String(env.HERMES_TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const settings = {
    ticktick: {
      connected: Boolean(ticktickAccessToken),
      accessToken: ticktickAccessToken ? '••••' : '',
      clientId: ticktickClientId,
      clientSecret: ticktickClientSecret ? '••••' : '',
      apiBase: env.HERMES_TICKTICK_API_BASE || 'https://api.ticktick.com',
    },
    telegram: {
      connected: Boolean(telegramBotToken),
      botToken: telegramBotToken ? '••••' : '',
      allowedChatIds,
    },
    mail: {
      accounts: publicGatewayMailAccounts(env),
    },
    runner: {
      mode: 'runtime-unreachable',
      allowShellCommands: false,
      commandConfigured: false,
      cwd: '',
      timeoutMs: Number(env.HERMES_RUN_TIMEOUT_MS || 86400000),
    },
    remote: {
      publicBaseUrl: env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '',
      tunnelProvider: 'cloudflare',
    },
    auth: { enabled: Boolean(env.HERMES_RUNTIME_TOKEN), accessToken: env.HERMES_RUNTIME_TOKEN ? '••••' : '' },
    autopilot: { enabled: false, intervalMs: 60000 },
    wikiRoot: env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
  };
  sendJson(res, 200, {
    ...settings,
    settings,
    gatewayFallback: true,
  });
}

function titleFromWikiPath(filePath = '') {
  return String(filePath || '')
    .split('/')
    .pop()
    ?.replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Untitled';
}

function fallbackWikiNotesFromState(gatewayState = {}, gatewayStore = null) {
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const documents = Array.isArray(state.documents) ? state.documents : [];
  const runNotes = runs
    .map((run) => {
      const filePath = run.file || run.wikiPath || run.wikiWriteBack || '';
      if (!filePath) return null;
      const title = run.goal || run.name || titleFromWikiPath(filePath);
      const content = [
        `# ${title}`,
        '',
        `- source: gateway-fallback`,
        `- agent: ${run.agent || run.agentId || ''}`,
        `- status: ${run.status || ''}`,
        `- run_id: ${run.id || ''}`,
        '',
        Array.isArray(run.logs) ? run.logs.join('\n') : '',
      ].join('\n').trim();
      return {
        path: filePath,
        title,
        folder: filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '',
        updatedAt: run.updatedAt || run.createdAt || new Date().toISOString(),
        createdAt: run.createdAt || new Date().toISOString(),
        bytes: Buffer.byteLength(content, 'utf8'),
        excerpt: run.goal || run.status || 'Gateway fallback run note',
        content,
      };
    })
    .filter(Boolean);
  const documentNotes = documents
    .map((document) => {
      const filePath = document.wikiPath || document.path || '';
      if (!filePath) return null;
      const title = document.title || document.name || document.filename || titleFromWikiPath(filePath);
      const content = [
        `# ${title}`,
        '',
        `- source: ${document.sourceLabel || document.source || 'gateway-document'}`,
        `- document_id: ${document.id || ''}`,
        '',
        document.extractedText || document.extract || document.summary || '',
      ].join('\n').trim();
      return {
        path: filePath,
        title,
        folder: filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '',
        updatedAt: document.updatedAt || document.createdAt || new Date().toISOString(),
        createdAt: document.createdAt || new Date().toISOString(),
        bytes: Buffer.byteLength(content, 'utf8'),
        excerpt: document.extract || document.summary || document.extractedText || 'Gateway fallback document note',
        content,
      };
    })
    .filter(Boolean);
  const byPath = new Map();
  [...runNotes, ...documentNotes].forEach((note) => {
    if (!byPath.has(note.path)) byPath.set(note.path, note);
  });
  return [...byPath.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path, 'ko'));
}

function fallbackWikiTree(notes = []) {
  const folders = new Map();
  notes.forEach((note) => {
    const parts = String(note.path || '').split('/').filter(Boolean);
    parts.slice(0, -1).forEach((_, index) => {
      const folderPath = parts.slice(0, index + 1).join('/');
      folders.set(folderPath, {
        id: `folder:${folderPath}`,
        kind: 'folder',
        path: folderPath,
        label: parts[index],
        depth: index,
        count: 0,
      });
    });
  });
  notes.forEach((note) => {
    const folder = note.folder || '';
    if (folders.has(folder)) folders.get(folder).count += 1;
  });
  const folderItems = [...folders.values()];
  const noteItems = notes.map((note) => ({
    id: `note:${note.path}`,
    kind: 'note',
    path: note.path,
    label: titleFromWikiPath(note.path),
    depth: Math.max(0, String(note.path || '').split('/').filter(Boolean).length - 1),
    updatedAt: note.updatedAt,
    bytes: note.bytes,
  }));
  return [...folderItems, ...noteItems].sort((a, b) => a.path.localeCompare(b.path, 'ko'));
}

function fallbackWikiGraph(notes = []) {
  const nodes = notes.slice(0, 80).map((note, index) => {
    const angle = (index / Math.max(1, notes.length)) * Math.PI * 2;
    const radius = 180 + (index % 5) * 18;
    return {
      id: note.path,
      path: note.path,
      label: note.title,
      group: note.folder || 'root',
      x: Math.round(480 + Math.cos(angle) * radius),
      y: Math.round(310 + Math.sin(angle) * radius),
      r: 4,
      linkCount: 0,
    };
  });
  return { nodes, edges: [], groups: [...new Set(nodes.map((node) => node.group))], viewBox: '0 0 960 620' };
}

function pendingWikiNote(selectedPath = '') {
  const cleanPath = String(selectedPath || '').trim();
  if (!cleanPath) return null;
  return {
    path: cleanPath,
    title: titleFromWikiPath(cleanPath),
    folder: cleanPath.split('/').slice(0, -1).join('/'),
    excerpt: '선택한 노트가 아직 현재 위키 스냅샷에 없습니다. iCloud/LLM-Wiki 동기화가 완료되면 이 경로의 내용이 표시됩니다.',
    content: '',
    syncStatus: 'pending',
  };
}

function candidateWikiRoots(env = process.env) {
  return [
    env.HERMES_WIKI_ROOT,
    '/Users/koyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
    '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
    env.HOME ? path.join(env.HOME, 'Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki') : '',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function resolveReadableWikiRoot(env = process.env) {
  for (const wikiRoot of candidateWikiRoots(env)) {
    try {
      if (fs.existsSync(wikiRoot) && fs.statSync(wikiRoot).isDirectory()) return wikiRoot;
    } catch {
      // Try the next configured/default wiki root.
    }
  }
  return '';
}

function localWikiRagNotes(wikiRoot = '', notes = []) {
  return (Array.isArray(notes) ? notes : []).map((note) => {
    const relativePath = String(note.path || '').replace(/^\/+/, '');
    let content = '';
    try {
      const absolutePath = path.resolve(wikiRoot, relativePath);
      const rootPath = path.resolve(wikiRoot);
      if (absolutePath.startsWith(`${rootPath}${path.sep}`) && fs.existsSync(absolutePath)) {
        content = fs.readFileSync(absolutePath, 'utf8');
      }
    } catch {
      content = '';
    }
    return {
      ...note,
      content: content || note.content || note.excerpt || '',
    };
  });
}

function fallbackWikiIndex({ gatewayState, gatewayStore = null, env = process.env, selectedPath = '', query = '' } = {}) {
  const localWikiRoot = resolveReadableWikiRoot(env);
  if (localWikiRoot) {
    try {
      const localIndex = buildWikiIndex({
        wikiRoot: localWikiRoot,
        selectedPath,
        query,
      });
      const result = {
        ...localIndex,
        wikiRoot: localWikiRoot,
        gatewayFallback: true,
        runtimeReachable: false,
        fallbackReason: 'local-wiki-root',
      };
      Object.defineProperty(result, 'ragNotes', {
        value: localWikiRagNotes(localWikiRoot, localIndex.notes),
        enumerable: false,
      });
      return result;
    } catch {
      // Fall through to snapshot/state fallbacks if the local vault cannot be indexed.
    }
  }
  const snapshotPath = path.join(SNAPSHOT_DIR, 'wiki-index-snapshot.json');
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const snapshotIndex = snapshot.wikiIndex && typeof snapshot.wikiIndex === 'object' ? snapshot.wikiIndex : {};
    const { noteContents, ...publicSnapshotIndex } = snapshotIndex;
    const notes = Array.isArray(snapshotIndex.notes) ? snapshotIndex.notes : [];
    const snapshotNoteContents = noteContents && typeof noteContents === 'object' && !Array.isArray(noteContents)
      ? noteContents
      : {};
    const requestedPath = String(selectedPath || '').trim();
    const selectedBase = requestedPath
      ? (notes.find((note) => note.path === requestedPath) || pendingWikiNote(requestedPath))
      : (snapshotIndex.selectedNote || notes[0] || null);
    const selectedContent = selectedBase
      ? String(snapshotNoteContents[selectedBase.path] || selectedBase.content || '')
      : '';
    const selected = selectedBase ? {
      ...selectedBase,
      ...(selectedContent ? { content: selectedContent } : {}),
    } : null;
    const needle = String(query || '').trim().toLowerCase();
    const searchResults = needle
      ? notes.filter((note) => [note.title, note.path, note.excerpt].some((value) => String(value || '').toLowerCase().includes(needle))).slice(0, 50)
      : [];
    return {
      ...publicSnapshotIndex,
      wikiRoot: snapshotIndex.wikiRoot || snapshot.wikiRoot || env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
      generatedAt: snapshot.generatedAt || snapshotIndex.generatedAt || new Date().toISOString(),
      selectedNote: selected,
      searchResults,
      gatewayFallback: true,
      runtimeReachable: false,
      fallbackReason: 'icloud-wiki-snapshot',
      snapshotSource: snapshot.source || 'icloud-llm-wiki-snapshot',
    };
  } catch {
    // Fall through to a minimal gateway-state index when no bundled snapshot exists.
  }
  const notes = fallbackWikiNotesFromState(gatewayState, gatewayStore);
  const noteSummaries = notes.map(({ content, ...note }) => note);
  const requestedPath = String(selectedPath || '').trim();
  const selected = requestedPath
    ? (notes.find((note) => note.path === requestedPath) || pendingWikiNote(requestedPath))
    : (notes[0] || null);
  const needle = String(query || '').trim().toLowerCase();
  const searchResults = needle
    ? noteSummaries.filter((note) => [note.title, note.path, note.excerpt].some((value) => String(value || '').toLowerCase().includes(needle))).slice(0, 50)
    : [];
  return {
    vaultName: 'LLM-Wiki',
    wikiRoot: env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
    generatedAt: new Date().toISOString(),
    totalNotes: notes.length,
    totalAssets: 0,
    topFolders: [...new Set(notes.map((note) => note.path.split('/')[0] || 'root'))].sort((a, b) => a.localeCompare(b, 'ko')),
    tree: fallbackWikiTree(noteSummaries),
    notes: noteSummaries,
    recent: noteSummaries.slice(0, 24),
    selectedNote: selected,
    backlinks: [],
    unresolvedLinks: [],
    searchResults,
    graph: fallbackWikiGraph(noteSummaries),
    gatewayFallback: true,
    runtimeReachable: false,
    fallbackReason: 'gateway-state-wiki-fallback',
  };
}

function fallbackWiki({ res, gatewayState, gatewayStore = null, env = process.env, query = {} }) {
  const wikiIndex = fallbackWikiIndex({
    gatewayState,
    gatewayStore,
    env,
    selectedPath: query.path || '',
    query: query.query || '',
  });
  const state = {
    ...gatewaySnapshot(gatewayState, gatewayStore),
    wikiIndex,
  };
  sendJson(res, 200, {
    ok: true,
    wikiRoot: wikiIndex.wikiRoot,
    wikiIndex,
    tree: wikiIndex.tree,
    notes: wikiIndex.notes,
    selectedNote: wikiIndex.selectedNote,
    backlinks: wikiIndex.backlinks,
    graph: wikiIndex.graph,
    state,
    gatewayFallback: true,
  });
}

async function fallbackWikiAsk({ res, body = {}, gatewayState, gatewayStore = null, env = process.env, fetchImpl = fetch }) {
  const question = String(body.question || body.message || '').trim();
  const wikiIndex = fallbackWikiIndex({
    gatewayState,
    gatewayStore,
    env,
    selectedPath: body.path || '',
    query: question,
  });
  const result = await answerWikiQuestion({
    question,
    path: body.path || '',
    limit: body.limit || 5,
    store: gatewayStore,
    wikiIndex,
    env,
    fetchImpl,
  });
  sendJson(res, 200, {
    ...result,
    wikiIndex,
    state: {
      ...gatewaySnapshot(gatewayState, gatewayStore),
      wikiIndex,
    },
    gatewayFallback: true,
  });
}

async function fallbackWikiSearch({ res, body = {}, gatewayState, gatewayStore = null, env = process.env, fetchImpl = fetch }) {
  const question = String(body.question || body.message || body.query || '').trim();
  const wikiIndex = fallbackWikiIndex({
    gatewayState,
    gatewayStore,
    env,
    selectedPath: body.path || '',
    query: question,
  });
  const result = await answerWikiQuestion({
    question,
    path: body.path || '',
    limit: body.limit || 4,
    store: gatewayStore,
    wikiIndex,
    env,
    fetchImpl,
    synthesize: false,
  });
  sendJson(res, result.ok === false ? 400 : 200, {
    ok: result.ok !== false,
    query: question,
    results: result.sources || [],
    sources: result.sources || [],
    answer: result.answer || '',
    retrieval: result.retrieval || {},
    llm: result.llm || { provider: 'none' },
    ...(result.llmAttempts ? { llmAttempts: result.llmAttempts } : {}),
    wikiIndex,
    gatewayFallback: true,
  });
}

function extractFallbackWikiQuestion(rawMessage = '') {
  const raw = String(rawMessage || '').trim();
  if (!raw) return '';

  const explicitQ = raw.match(/(?:^|\n)\s*Q\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:SOURCES?|근거|검색|Context)\s*[:：]|$)/i);
  if (explicitQ?.[1]?.trim()) return explicitQ[1].trim();

  const koreanQuestion = raw.match(/(?:^|\n)\s*질문\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:SOURCES?|근거|검색|Context)\s*[:：]|$)/i);
  if (koreanQuestion?.[1]?.trim()) return koreanQuestion[1].trim();

  return raw
    .split(/\n\s*(?:SOURCES?|근거|검색|Context)[:：]/i)[0]
    .trim() || raw;
}

async function fallbackWikiChatStream({ res, body = {}, gatewayState, gatewayStore = null, env = process.env, fetchImpl = fetch }) {
  const rawMessage = String(body.question || body.message || body.query || '').trim();
  const question = extractFallbackWikiQuestion(rawMessage);
  const wikiIndex = fallbackWikiIndex({
    gatewayState,
    gatewayStore,
    env,
    selectedPath: body.path || '',
    query: question,
  });
  const result = await answerWikiQuestion({
    question,
    path: body.path || '',
    limit: body.limit || 4,
    store: gatewayStore,
    wikiIndex,
    env,
    fetchImpl,
  });
  const answer = result.answer || '위키 검색 결과가 비어 있습니다.';
  sendSseStream(res, [
    {
      event: 'delta',
      data: {
        text: answer,
        source: 'wiki-fallback',
        gatewayFallback: true,
        run: { model: result.llm?.model || 'wiki-retrieval', agent: 'wiki-curator' },
      },
    },
    {
      event: 'done',
      data: {
        ok: result.ok !== false,
        text: answer,
        sources: result.sources || [],
        retrieval: result.retrieval || {},
        llm: result.llm || { provider: 'none' },
        ...(result.llmAttempts ? { llmAttempts: result.llmAttempts } : {}),
        source: 'wiki-fallback',
        gatewayFallback: true,
        run: { model: result.llm?.model || 'wiki-retrieval', agent: 'wiki-curator' },
      },
    },
  ]);
}

function gatewayPublicBaseUrl(env = process.env) {
  const explicit = env.HERMES_PUBLIC_BASE_URL || env.HERMES_REMOTE_PUBLIC_BASE_URL || '';
  if (explicit) return String(explicit).replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.RAILWAY_STATIC_URL) return String(env.RAILWAY_STATIC_URL).replace(/\/+$/, '');
  return '';
}

function fallbackSystemConnections({ res, env = process.env, gatewayState, gatewayStore = null }) {
  const storedState = gatewayStore && typeof gatewayStore.getState === 'function' ? gatewayStore.getState() : {};
  const ticktickAccessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  const telegramBotToken = env.HERMES_TELEGRAM_BOT_TOKEN || '';
  const allowedChatIds = String(env.HERMES_TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const publicBaseUrl = gatewayPublicBaseUrl(env);
  const status = {
    managedBy: 'railway-gateway-env',
    reason: 'gateway-fallback',
    checkedAt: new Date().toISOString(),
    gatewayFallback: true,
    runtimeReachable: false,
    envImported: [],
    ticktick: {
      connected: Boolean(ticktickAccessToken),
      state: ticktickAccessToken ? 'ready' : 'missing',
      detail: ticktickAccessToken
        ? 'Railway gateway has HERMES_TICKTICK_ACCESS_TOKEN; Mac mini runtime is currently unreachable.'
        : 'HERMES_TICKTICK_ACCESS_TOKEN is not provisioned on Railway gateway.',
      token: ticktickAccessToken ? '••••' : '',
      importedCount: gatewayTickTickTaskCount(gatewayState, gatewayStore),
    },
    telegram: {
      connected: Boolean(telegramBotToken),
      state: telegramBotToken && publicBaseUrl ? 'ready' : telegramBotToken ? 'waiting' : 'missing',
      detail: telegramBotToken
        ? (publicBaseUrl ? 'Railway gateway can register Telegram webhook server-side.' : 'Public Railway URL is required for Telegram webhook.')
        : 'HERMES_TELEGRAM_BOT_TOKEN is not provisioned on Railway gateway.',
      token: telegramBotToken ? '••••' : '',
      allowedChatCount: allowedChatIds.length,
      webhookUrl: publicBaseUrl ? `${publicBaseUrl}/api/telegram/webhook` : '',
      registered: Boolean((storedState.telegramWebhook || gatewayState.telegramWebhook) && (storedState.telegramWebhook || gatewayState.telegramWebhook).registered),
    },
    remote: {
      publicBaseUrl,
      authEnabled: Boolean(env.HERMES_RUNTIME_TOKEN),
    },
    wikiRoot: env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
  };
  gatewayState.systemConnections = status;
  sendJson(res, 200, status);
}

function buildGatewayChannelRoutingStatus({ env = process.env, gatewayState, gatewayStore = null }) {
  const ticktickAccessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  const telegramBotToken = env.HERMES_TELEGRAM_BOT_TOKEN || '';
  const mailAccounts = publicGatewayMailAccounts(env);
  const allowedChatIds = String(env.HERMES_TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const publicBaseUrl = gatewayPublicBaseUrl(env);
  const commandItems = gatewayStore && typeof gatewayStore.listCommandInbox === 'function'
    ? gatewayStore.listCommandInbox({ limit: 20, includeArchived: true })
    : listGatewayCommandInbox(gatewayState, { limit: 20, includeArchived: true });
  const commandRows = commandItems.map((item) => ({
    id: item.id,
    source: item.source,
    sourceLabel: item.sourceLabel,
    text: item.text || item.title || '',
    status: item.status || '',
    detail: item.detail || '',
    receivedAt: item.receivedAt || '',
    runId: item.runId || '',
    wikiPath: item.wikiPath || '',
  }));
  const ticktickImported = gatewayTickTickTaskCount(gatewayState, gatewayStore);
  const mailSyncStatus = gatewayState.mailSyncStatus && typeof gatewayState.mailSyncStatus === 'object'
    ? gatewayState.mailSyncStatus
    : null;
  const mailAttempted = Boolean(mailSyncStatus);
  const mailConnected = mailAttempted
    ? Boolean(mailSyncStatus.ok)
    : mailAccounts.some((account) => account.connected) && commandRows.some((item) => ['gmail', 'naver', 'mail'].includes(item.source));
  const mailImportCount = commandRows.filter((item) => ['gmail', 'naver', 'mail'].includes(item.source)).length;
  const mailFailedAccounts = Array.isArray(mailSyncStatus?.accounts)
    ? mailSyncStatus.accounts.filter((account) => account && account.ok === false)
    : [];
  const mailFailure = mailFailedAccounts.map((account) => `${account.provider || account.accountId || 'mail'}: ${account.reason || 'sync_failed'}`).join(' · ');
  const telegramWebhookUrl = publicBaseUrl ? `${publicBaseUrl}/api/telegram/webhook` : '';
  const channels = [
    {
      id: 'web',
      label: 'Web',
      connected: true,
      state: publicBaseUrl ? 'ready' : 'local',
      linkedAgent: 'default',
      model: 'Codex',
      endpoint: publicBaseUrl || 'Railway gateway',
      allowedChatCount: 0,
      candidateCount: 0,
      importedCount: commandRows.filter((item) => item.source === 'web').length,
      lastCommand: commandRows.find((item) => item.source === 'web') || null,
      detail: 'Browser commands are captured by the Railway gateway while the Mac mini runtime is unreachable.',
    },
    {
      id: 'telegram',
      label: 'Telegram',
      connected: Boolean(telegramBotToken),
      state: telegramBotToken && publicBaseUrl ? 'ready' : telegramBotToken ? 'waiting' : 'missing',
      linkedAgent: 'default',
      model: 'Codex',
      endpoint: telegramWebhookUrl,
      allowedChatCount: allowedChatIds.length,
      candidateCount: 0,
      importedCount: commandRows.filter((item) => item.source === 'telegram').length,
      lastCommand: commandRows.find((item) => item.source === 'telegram') || null,
      detail: telegramBotToken
        ? 'Telegram webhook can be registered from Railway without exposing the bot token.'
        : 'Telegram bot token is missing on Railway.',
    },
    {
      id: 'ticktick',
      label: 'TickTick',
      connected: Boolean(ticktickAccessToken),
      state: ticktickAccessToken ? 'ready' : 'missing',
      linkedAgent: 'Calendar',
      model: 'Codex',
      endpoint: env.HERMES_TICKTICK_API_BASE || 'https://api.ticktick.com',
      allowedChatCount: 0,
      candidateCount: 0,
      importedCount: ticktickImported,
      lastCommand: commandRows.find((item) => item.source === 'ticktick') || null,
      detail: ticktickAccessToken
        ? 'Executable TickTick tasks can be imported into Hermes Command Inbox.'
        : 'TickTick access token is missing on Railway.',
    },
    {
      id: 'email',
      label: 'Email',
      connected: mailConnected,
      state: mailConnected ? 'synced' : mailAccounts.length ? 'login_failed' : 'missing',
      linkedAgent: 'default',
      model: 'Codex',
      endpoint: mailAccounts.map((account) => account.host).filter(Boolean).join(', '),
      allowedChatCount: 0,
      candidateCount: 0,
      importedCount: mailImportCount,
      lastCommand: commandRows.find((item) => ['gmail', 'naver', 'mail'].includes(item.source)) || null,
      detail: mailConnected
        ? `${mailImportCount} mail commands imported through IMAP.`
        : mailAccounts.length
          ? (mailFailure || 'Mail accounts exist, but IMAP sync has not succeeded yet.')
          : 'HERMES_MAIL_ACCOUNTS_JSON is not provisioned on Railway.',
    },
  ];
  const connectedCount = channels.filter((channel) => channel.connected || channel.id === 'web').length;
  return {
    summary: {
      connected: connectedCount,
      total: channels.length,
      pendingCommands: commandRows.length,
      checkedAt: new Date().toISOString(),
    },
    channels,
    commandRows,
    endpoints: {
      webAppUrl: publicBaseUrl,
      telegramWebhookUrl,
      ticktickApiBase: env.HERMES_TICKTICK_API_BASE || 'https://api.ticktick.com',
    },
    settings: {
      ticktick: {
        connected: Boolean(ticktickAccessToken),
        token: ticktickAccessToken ? '••••' : '',
      },
      telegram: {
        connected: Boolean(telegramBotToken),
        token: telegramBotToken ? '••••' : '',
        allowedChatCount: allowedChatIds.length,
      },
    },
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  };
}

function fallbackChannelsStatus({ res, env = process.env, gatewayState, gatewayStore = null }) {
  sendJson(res, 200, buildGatewayChannelRoutingStatus({ env, gatewayState, gatewayStore }));
}

async function fallbackSystemConnectionsBootstrap({ res, env = process.env, fetchImpl = fetch, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.getState !== 'function') {
    sendDatabaseRequired(res, 'system connection bootstrap');
    return;
  }
  const storedState = gatewayStore.getState();
  const ticktickAccessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  const telegramBotToken = env.HERMES_TELEGRAM_BOT_TOKEN || '';
  const allowedChatIds = String(env.HERMES_TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const publicBaseUrl = gatewayPublicBaseUrl(env);
  const status = {
    managedBy: 'railway-gateway-env',
    reason: 'manual-bootstrap',
    checkedAt: new Date().toISOString(),
    gatewayFallback: true,
    runtimeReachable: false,
    envImported: [],
    ticktick: {
      connected: Boolean(ticktickAccessToken),
      state: ticktickAccessToken ? 'ready' : 'missing',
      detail: ticktickAccessToken
        ? 'Railway gateway has TickTick token.'
        : 'HERMES_TICKTICK_ACCESS_TOKEN is not provisioned on Railway gateway.',
      token: ticktickAccessToken ? '••••' : '',
      importedCount: gatewayTickTickTaskCount(gatewayState, gatewayStore),
      skippedCount: 0,
    },
    telegram: {
      connected: Boolean(telegramBotToken),
      state: telegramBotToken && publicBaseUrl ? 'ready' : telegramBotToken ? 'waiting' : 'missing',
      detail: telegramBotToken
        ? (publicBaseUrl ? 'Telegram bot token exists on Railway gateway.' : 'Public Railway URL is required for Telegram webhook.')
        : 'HERMES_TELEGRAM_BOT_TOKEN is not provisioned on Railway gateway.',
      token: telegramBotToken ? '••••' : '',
      allowedChatCount: allowedChatIds.length,
      webhookUrl: publicBaseUrl ? `${publicBaseUrl}/api/telegram/webhook` : '',
      registered: Boolean((storedState.telegramWebhook || gatewayState.telegramWebhook) && (storedState.telegramWebhook || gatewayState.telegramWebhook).registered),
    },
    remote: {
      publicBaseUrl,
      authEnabled: Boolean(env.HERMES_RUNTIME_TOKEN),
    },
    wikiRoot: env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
  };

  if (ticktickAccessToken) {
    try {
      const snapshot = await fetchGatewayTickTickSnapshot({ env, fetchImpl });
      const result = importGatewayTickTickTasks({ body: snapshot, gatewayState, gatewayStore });
      status.ticktick.state = 'synced';
      status.ticktick.detail = `${result.imported.length} executable tasks imported through Railway gateway.`;
      status.ticktick.importedCount = result.imported.length;
      status.ticktick.skippedCount = result.skipped.length;
      status.ticktick.completedSync = snapshot.completedSync;
      status.ticktick.calendarSync = snapshot.calendarSync;
    } catch (error) {
      status.ticktick.state = 'failed';
      status.ticktick.detail = error.message;
    }
  }

  if (telegramBotToken && publicBaseUrl) {
    const webhookUrl = `${publicBaseUrl}/api/telegram/webhook`;
    try {
      const result = await registerTelegramWebhook({
        botToken: telegramBotToken,
        webhookUrl,
        fetchImpl,
      });
      const webhookStatus = gatewayStore.setTelegramWebhookStatus({ webhookUrl, result });
      status.telegram.state = webhookStatus.registered ? 'registered' : 'failed';
      status.telegram.detail = webhookStatus.description || 'Telegram webhook registered from Railway gateway.';
      status.telegram.webhookUrl = webhookUrl;
      status.telegram.registered = webhookStatus.registered;
    } catch (error) {
      gatewayStore.setTelegramWebhookStatus({ webhookUrl, error: error.message || String(error) });
      status.telegram.state = 'failed';
      status.telegram.detail = error.message;
      status.telegram.webhookUrl = webhookUrl;
      status.telegram.registered = false;
    }
  }

  gatewayState.systemConnections = status;
  sendJson(res, 200, status);
}

function importGatewayTickTickTasks({ body = {}, gatewayState, gatewayStore = null }) {
  const tasks = Array.isArray(body.tasks)
    ? body.tasks
    : String(body.text || '')
      .split(/\r?\n/)
      .map((title, index) => ({ id: `text-${index}`, title }))
      .filter((task) => String(task.title || '').trim());
  const plan = createTickTickSyncPlan({ tasks });
  const now = new Date().toISOString();
  const imported = plan.executableTasks.map((task) => ({
    id: task.id || createId('ticktick'),
    title: task.title,
    original: task.original || task.title,
    tags: Array.isArray(task.tags) ? task.tags.join(' ') : String(task.tags || ''),
    action: 'Run',
    due: task.due || 'Imported',
    executable: true,
    importedAt: now,
    source: 'ticktick',
  }));
  const storedTasks = [...plan.executableTasks, ...plan.skippedTasks].map((task) => ({
    id: task.id || createId('ticktick'),
    title: task.title,
    original: task.original || task.title,
    content: task.content || '',
    tags: Array.isArray(task.tags) ? task.tags.join(' ') : String(task.tags || ''),
    action: task.executable ? 'Run' : 'Record',
    due: task.due || '',
    status: task.status || 'open',
    executable: Boolean(task.executable),
    importedAt: now,
    source: 'ticktick',
    projectId: task.projectId || task.ticktickProjectId || '',
  }));
  if (gatewayStore && typeof gatewayStore.importTickTickTasks === 'function') {
    gatewayStore.importTickTickTasks(storedTasks);
  } else {
    if (!Array.isArray(gatewayState.ticktickTasks)) gatewayState.ticktickTasks = [];
    const existing = new Map(gatewayState.ticktickTasks.map((task) => [String(task.id), task]));
    storedTasks.forEach((task) => existing.set(String(task.id), task));
    gatewayState.ticktickTasks = [...existing.values()].sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || ''))).slice(0, 500);
  }
  if (gatewayStore && Array.isArray(body.events) && typeof gatewayStore.importCalendarEvents === 'function') {
    gatewayStore.importCalendarEvents(body.events);
  } else if (Array.isArray(body.events)) {
    gatewayState.events = body.events;
  }
  if (gatewayStore && Array.isArray(body.externalCalendarEvents) && typeof gatewayStore.importExternalCalendarEvents === 'function') {
    gatewayStore.importExternalCalendarEvents(body.externalCalendarEvents);
  } else if (Array.isArray(body.externalCalendarEvents)) {
    gatewayState.externalCalendarEvents = body.externalCalendarEvents;
  }
  if (!gatewayStore) {
    gatewayState.sessions.unshift({
      time: now.slice(11, 16),
      text: `TickTick sync · ${imported.length} executable tasks`,
      state: imported.length ? 'Imported' : 'No executable tasks',
    });
  }
  return { imported, skipped: plan.skippedTasks, total: plan.total };
}

async function fallbackTickTickSync({ res, body = {}, env = process.env, fetchImpl = fetch, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.importTickTickTasks !== 'function') {
    sendDatabaseRequired(res, 'TickTick imports');
    return;
  }
  const storedState = gatewayStore ? gatewayStore.getState() : {};
  if (gatewayState.ticktickReplacement?.enabled || storedState.ticktickReplacement?.enabled) {
    const state = mergeGatewayLiveState(storedState, gatewayState, env, gatewayStore);
    sendJson(res, 200, {
      ok: true,
      connected: false,
      replaced: true,
      replacement: state.ticktickReplacement,
      detail: 'TickTick has been imported once. Hermes desktop task DB is now the source of truth.',
      tasks: gatewayTasksFromState(state),
      state,
      gatewayFallback: true,
      gatewayMerged: true,
    });
    return;
  }
  const accessToken = env.HERMES_TICKTICK_ACCESS_TOKEN || '';
  if (!body.tasks && !body.text && !accessToken) {
    sendJson(res, 200, {
      imported: [],
      skipped: [],
      connected: false,
      missing: ['HERMES_TICKTICK_ACCESS_TOKEN'],
      message: 'TickTick OAuth access token is required for live cloud sync.',
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    });
    return;
  }
  const syncBody = { ...body };
  if (!syncBody.tasks && !syncBody.text) {
    Object.assign(syncBody, await fetchGatewayTickTickSnapshot({ env, fetchImpl, body }));
  }
  const result = importGatewayTickTickTasks({ body: syncBody, gatewayState, gatewayStore });
  sendJson(res, 200, {
    ...result,
    completedSync: syncBody.completedSync,
    calendarSync: syncBody.calendarSync,
    connected: Boolean(accessToken),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

async function fallbackTickTickImportOnce({ res, body = {}, env = process.env, fetchImpl = fetch, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.importTickTickTasksAsNative !== 'function') {
    sendJson(res, 409, {
      ok: false,
      error: 'DATABASE_URL is required before one-time TickTick import can become the desktop task source of truth.',
      databaseConfigured: false,
      gatewayFallback: true,
    });
    return;
  }
  const storedState = gatewayStore.getState();
  if ((storedState.ticktickReplacement?.enabled || gatewayState.ticktickReplacement?.enabled) && !body.force) {
    const state = mergeGatewayLiveState(storedState, gatewayState, env, gatewayStore);
    sendJson(res, 200, {
      ok: true,
      alreadyImported: true,
      replacement: state.ticktickReplacement,
      tasks: gatewayTasksFromState(state),
      state,
      databaseConfigured: true,
      gatewayFallback: true,
      gatewayMerged: true,
    });
    return;
  }

  let snapshot = {
    tasks: Array.isArray(body.tasks) ? body.tasks : [],
    events: Array.isArray(body.events) ? body.events : [],
    externalCalendarEvents: Array.isArray(body.externalCalendarEvents) ? body.externalCalendarEvents : [],
    source: 'request-body',
  };
  if (!snapshot.tasks.length) {
    const envSnapshot = readGatewayTickTickSnapshotFromEnv(env);
    if (envSnapshot && !envSnapshot.error && envSnapshot.tasks.length) snapshot = envSnapshot;
  }
  if (!snapshot.tasks.length) {
    const liveState = {
      ...gatewayState,
      ...storedState,
      ticktickTasks: [
        ...(Array.isArray(gatewayState.ticktickTasks) ? gatewayState.ticktickTasks : []),
        ...(Array.isArray(storedState.ticktickTasks) ? storedState.ticktickTasks : []),
      ],
      events: [
        ...(Array.isArray(gatewayState.events) ? gatewayState.events : []),
        ...(Array.isArray(storedState.events) ? storedState.events : []),
      ],
      externalCalendarEvents: [
        ...(Array.isArray(gatewayState.externalCalendarEvents) ? gatewayState.externalCalendarEvents : []),
        ...(Array.isArray(storedState.externalCalendarEvents) ? storedState.externalCalendarEvents : []),
      ],
    };
    snapshot = {
      tasks: liveState.ticktickTasks,
      events: liveState.events,
      externalCalendarEvents: liveState.externalCalendarEvents,
      source: 'gateway-state',
    };
  }
  if (!snapshot.tasks.length) {
    snapshot = await fetchGatewayTickTickSnapshot({ env, fetchImpl, body });
    snapshot.source = snapshot.completedSync?.ok || snapshot.calendarSync?.ok ? 'ticktick-live' : 'ticktick-api';
  }
  if (!snapshot.tasks.length) {
    sendJson(res, 400, {
      ok: false,
      error: 'No TickTick tasks were available to import.',
      databaseConfigured: true,
      gatewayFallback: true,
    });
    return;
  }

  importGatewayTickTickTasks({ body: snapshot, gatewayState, gatewayStore });
  const result = gatewayStore.importTickTickTasksAsNative(snapshot.tasks, { force: Boolean(body.force) });
  const state = mergeGatewayLiveState(gatewayStore.getState(), gatewayState, env, gatewayStore);
  sendJson(res, 200, {
    ok: true,
    imported: result.imported,
    skipped: result.skipped,
    replacement: result.replacement,
    source: snapshot.source,
    sourceCount: snapshot.tasks.length,
    tasks: gatewayTasksFromState(state),
    state,
    databaseConfigured: true,
    gatewayFallback: true,
    gatewayMerged: true,
  });
}

async function fallbackCalendarDraft({ res, body }) {
  const draft = buildCalendarWorkDraft({
    text: body.text,
    selectedDate: body.selectedDate || new Date().toISOString().slice(0, 10),
  });
  sendJson(res, 200, { draft, gatewayFallback: true });
}

async function fallbackCalendarQuickAdd({ res, body, env, fetchImpl, gatewayState, gatewayStore = null }) {
  const draft = buildCalendarWorkDraft({
    text: body.text,
    selectedDate: body.selectedDate || new Date().toISOString().slice(0, 10),
  });
  if (!gatewayStore || typeof gatewayStore.createCalendarEvent !== 'function') {
    sendDatabaseRequired(res, 'calendar events');
    return;
  }
  const action = body.action || 'Create';
  let run = null;
  if (action === 'Run now' && draft.owner !== 'Me') {
    run = await postRuntimeRun({
      env,
      fetchImpl,
      payload: buildCalendarRunPayload(draft),
    });
    if (gatewayStore && typeof gatewayStore.saveRun === 'function') {
      run = gatewayStore.saveRun(run);
    }
  }
  const eventInput = {
    ...draft,
    status: action === 'Run now' && draft.owner !== 'Me' ? 'Running' : draft.status,
    source: 'calendar-quick-add',
    runId: run ? run.id : '',
    runFile: run ? run.file : '',
  };
  const event = gatewayStore.createCalendarEvent(eventInput);
  const task = null;
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    draft,
    event,
    task,
    run,
    execution: buildExecutionReceipt({ task, run }),
    state,
    gatewayFallback: true,
  });
}

async function fallbackWorkboardConvert({ res, body, env, fetchImpl, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.createTask !== 'function') {
    sendDatabaseRequired(res, 'workboard conversions');
    return;
  }
  const draft = buildWorkboardTaskDraft({
    title: body.title,
    content: body.content,
    selectedDate: body.selectedDate || new Date().toISOString().slice(0, 10),
    model: body.model || 'Codex',
  });
  const action = body.action || 'Create';
  let run = null;
  if (action === 'Run now') {
    const payload = buildWorkboardRunPayload(draft);
    try {
      run = await postRuntimeRun({ env, fetchImpl, payload });
      if (typeof gatewayStore.saveRun === 'function') {
        run = gatewayStore.saveRun(run);
      }
    } catch {
      run = typeof gatewayStore.saveRun === 'function'
        ? gatewayStore.saveRun(createGatewayRun(payload))
        : gatewayStore.createRun(payload);
    }
  }
  const task = gatewayStore.createTask({
    ...draft,
    status: action === 'Run now' ? 'Running' : draft.status,
    source: 'workboard',
    runId: run ? run.id : '',
    runFile: run ? run.file : '',
  });
  sendJson(res, 200, {
    draft,
    task,
    run,
    execution: buildExecutionReceipt({ task, run }),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function gatewayWorkboardPages(gatewayState, gatewayStore = null) {
  if (gatewayStore && typeof gatewayStore.listWorkboardPages === 'function') {
    return gatewayStore.listWorkboardPages();
  }
  if (!Array.isArray(gatewayState.workboardPages)) gatewayState.workboardPages = [];
  return gatewayState.workboardPages;
}

function createGatewayWorkboardId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${stamp}-${suffix}`;
}

function normalizeGatewayWorkboardPage(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const blocks = Array.isArray(input.blocks)
    ? input.blocks
    : Array.isArray(existing.blocks)
      ? existing.blocks
      : [];
  return {
    id: String(existing.id || input.id || createGatewayWorkboardId('wp')),
    title: String(input.title ?? existing.title ?? '제목 없음').trim() || '제목 없음',
    icon: String(input.icon ?? existing.icon ?? '▦'),
    tag: String(input.tag ?? existing.tag ?? ''),
    blocks: blocks.map((block, index) => ({
      id: String(block.id || createGatewayWorkboardId('wb')),
      kind: ['paragraph', 'heading', 'todo', 'bullet', 'divider', 'callout'].includes(String(block.kind)) ? String(block.kind) : 'paragraph',
      text: String(block.text || ''),
      ...(String(block.kind) === 'todo' ? { checked: Boolean(block.checked) } : {}),
      createdAt: String(block.createdAt || now),
      updatedAt: String(block.updatedAt || now),
      order: Number.isFinite(Number(block.order)) ? Number(block.order) : index,
    })),
    createdAt: String(existing.createdAt || input.createdAt || now),
    updatedAt: now,
  };
}

function fallbackWorkboardList({ res, gatewayState, gatewayStore = null }) {
  const pages = gatewayWorkboardPages(gatewayState, gatewayStore);
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    ok: true,
    pages,
    stages: [],
    state,
    gatewayFallback: true,
  });
}

function fallbackWorkboardPageCreate({ res, body, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.createWorkboardPage !== 'function') {
    sendDatabaseRequired(res, 'workboard pages');
    return;
  }
  const page = gatewayStore && typeof gatewayStore.createWorkboardPage === 'function'
    ? gatewayStore.createWorkboardPage(body)
    : normalizeGatewayWorkboardPage(body);
  const pages = gatewayWorkboardPages(gatewayState, gatewayStore);
  sendJson(res, 201, {
    ok: true,
    page,
    pages,
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackWorkboardPageUpdate({ res, pageId, body, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.updateWorkboardPage !== 'function') {
    sendDatabaseRequired(res, 'workboard pages');
    return;
  }
  let page = null;
  if (gatewayStore && typeof gatewayStore.updateWorkboardPage === 'function') {
    page = gatewayStore.updateWorkboardPage(pageId, body);
  }
  if (!page) {
    sendJson(res, 404, { ok: false, error: 'workboard_page_not_found', gatewayFallback: true });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    page,
    pages: gatewayWorkboardPages(gatewayState, gatewayStore),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackWorkboardPageDelete({ res, pageId, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.deleteWorkboardPage !== 'function') {
    sendDatabaseRequired(res, 'workboard pages');
    return;
  }
  let page = null;
  if (gatewayStore && typeof gatewayStore.deleteWorkboardPage === 'function') {
    page = gatewayStore.deleteWorkboardPage(pageId);
  }
  if (!page) {
    sendJson(res, 404, { ok: false, error: 'workboard_page_not_found', gatewayFallback: true });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    page,
    pages: gatewayWorkboardPages(gatewayState, gatewayStore),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackTasksList({ res, query = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore) {
    const filters = {
      view: query.view || '',
      owner: query.owner || '',
      status: query.status || '',
      date: query.date || '',
    };
    const tasks = gatewayStore.searchTasks(query.query || '', filters);
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { tasks, state }, tasks, state, gatewayFallback: true });
    return;
  }
  const search = String(query.query || '').toLowerCase();
  const owner = String(query.owner || '');
  const view = String(query.view || '');
  const selectedDate = String(query.date || dateStamp());
  const tasks = gatewayState.tasks.filter((task) => {
    if (['calendar', 'calendar-event', 'ticktick-calendar', 'external-calendar'].includes(String(task.source || '')) || ['calendar-event', 'event'].includes(String(task.kind || task.type || ''))) return false;
    if (owner && task.owner !== owner) return false;
    if (view === 'completed' && !(task.status === 'Done' || task.completedAt)) return false;
    if (view === 'today' && (task.date !== selectedDate || task.status === 'Done' || task.completedAt)) return false;
    if (view === 'upcoming' && (!task.date || task.date < selectedDate || task.status === 'Done' || task.completedAt)) return false;
    if (!search) return true;
    return [
      task.title,
      task.owner,
      task.status,
      task.due,
      task.agent,
      task.model,
      task.priority,
      task.project,
      ...(task.tags || []),
    ].some((value) => String(value || '').toLowerCase().includes(search));
  });
  sendJson(res, 200, {
    tasks,
    state: gatewayState,
    gatewayFallback: true,
  });
}

function fallbackTaskCreate({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore) {
    const task = gatewayStore.createTask({ ...body, source: body.source || 'railway-gateway' });
    const tasks = gatewayStore.searchTasks('');
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { task, tasks, state }, task, tasks, state, gatewayFallback: true });
    return;
  }
  sendDatabaseRequired(res, 'tasks');
}

function fallbackTaskShareDraft({ res, body = {}, gatewayState, gatewayStore = null }) {
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.map(String) : [];
  const search = String(body.query || '').toLowerCase();
  const sourceTasks = gatewayStore && typeof gatewayStore.searchTasks === 'function'
    ? gatewayStore.searchTasks(body.query || '', {
      owner: body.owner || '',
      view: body.view || '',
      date: body.date || '',
    })
    : gatewayState.tasks;
  const tasks = taskIds.length
    ? sourceTasks.filter((task) => taskIds.includes(String(task.id)))
    : sourceTasks.filter((task) => {
      if (body.owner && task.owner !== body.owner) return false;
      if (body.view === 'completed' && !(task.status === 'Done' || task.completedAt)) return false;
      if (!search) return true;
      return [task.title, task.owner, task.status, task.due, task.agent, task.project, ...(task.tags || [])]
        .some((value) => String(value || '').toLowerCase().includes(search));
    });
  const draft = buildTaskShareDraft({
    tasks,
    channel: body.channel || 'post',
    now: new Date(),
  });
  sendJson(res, 200, {
    draft,
    tasks,
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackLearningReflect({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.addReflection !== 'function') {
    sendDatabaseRequired(res, 'learning reflections');
    return;
  }
  const reflection = createReflection({
    run: body.run || {
      id: body.runId || 'gateway-run',
      name: body.runId || 'gateway-run',
      agent: 'Hermes',
      status: body.outcome === 'failure' ? 'failed' : 'done',
    },
    note: body.note || 'Gateway fallback reflection',
    outcome: body.outcome || 'success',
    createdAt: new Date().toISOString(),
  });
  gatewayStore.addReflection(reflection);
  sendJson(res, 200, {
    reflection,
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackLearningPromoteSkill({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.addSkillCandidate !== 'function') {
    sendDatabaseRequired(res, 'learning skill candidates');
    return;
  }
  const candidate = createSkillCandidate(body);
  const promoted = shouldPromoteSkill(candidate);
  const file = promoted ? `6_agents/skills/${slugify(candidate.name, 'skill')}.md` : null;
  gatewayStore.addSkillCandidate(candidate);
  sendJson(res, 200, {
    candidate,
    promoted,
    file,
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
    wikiWriteBack: promoted ? 'pending Mac mini LLM-Wiki write-back' : 'watch candidate',
  });
}

function fallbackTaskMutation({ res, method, taskId, body = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore) {
    const task = method === 'DELETE'
      ? gatewayStore.deleteTask(taskId)
      : gatewayStore.updateTask(taskId, body);
    if (!task) {
      sendJson(res, 404, { ok: false, error: 'Task not found in gateway Postgres state', gatewayFallback: true });
      return;
    }
    const tasks = gatewayStore.searchTasks('');
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { task, tasks, state }, task, tasks, state, gatewayFallback: true });
    return;
  }
  sendDatabaseRequired(res, 'tasks');
}

function fallbackCalendarEventsList({ res, query = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore && typeof gatewayStore.searchCalendarEvents === 'function') {
    const events = gatewayStore.searchCalendarEvents(query.query || '', {
      from: query.from || '',
      to: query.to || '',
    });
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { events, state }, events, state, gatewayFallback: true });
    return;
  }
  const from = String(query.from || '');
  const to = String(query.to || '');
  const search = String(query.query || '').toLowerCase();
  const events = (Array.isArray(gatewayState.events) ? gatewayState.events : []).filter((event) => {
    const date = String(event.date || event.startDate || '');
    if (from && date && date < from) return false;
    if (to && date && date > to) return false;
    if (!search) return true;
    return [event.title, event.original, event.date, event.startDate, event.time, event.owner, event.source]
      .some((value) => String(value || '').toLowerCase().includes(search));
  });
  sendJson(res, 200, { ok: true, data: { events, state: gatewayState }, events, state: gatewayState, gatewayFallback: true });
}

function fallbackCalendarEventCreate({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore && typeof gatewayStore.createCalendarEvent === 'function') {
    const event = gatewayStore.createCalendarEvent({ ...body, source: body.source || 'desktop-calendar-event' });
    const events = gatewayStore.searchCalendarEvents('');
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { event, events, state }, event, events, state, gatewayFallback: true });
    return;
  }
  sendDatabaseRequired(res, 'calendar events');
}

function fallbackCalendarEventMutation({ res, method, eventId, body = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore && typeof gatewayStore.updateCalendarEvent === 'function') {
    const event = method === 'DELETE'
      ? gatewayStore.deleteCalendarEvent(eventId)
      : gatewayStore.updateCalendarEvent(eventId, body);
    if (!event) {
      sendJson(res, 404, { ok: false, error: 'Calendar event not found in gateway Postgres state', gatewayFallback: true });
      return;
    }
    const events = gatewayStore.searchCalendarEvents('');
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { event, events, state }, event, events, state, gatewayFallback: true });
    return;
  }
  sendDatabaseRequired(res, 'calendar events');
}

function fallbackVisualBrief({ res, runId, action, gatewayState, gatewayStore = null }) {
  const run = gatewayStore && typeof gatewayStore.getRun === 'function'
    ? gatewayStore.getRun(runId)
    : gatewayState.runs.find((item) => item.id === runId);
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'Run not found in gateway fallback state' });
    return;
  }
  const generatedAt = new Date().toISOString();
  const brief = buildVisualBrief({ run, generatedAt });
  if (!action) {
    sendJson(res, 200, { brief, gatewayFallback: true });
    return;
  }
  sendJson(res, 200, {
    brief,
    saved: {
      markdownPath: run.file,
      svgPath: '',
      mode: 'existing-run-wiki-file',
    },
    gatewayFallback: true,
  });
}

function fallbackRunDetail({ res, runId, gatewayState, gatewayStore = null }) {
  const run = gatewayStore ? gatewayStore.getRun(runId) : gatewayState.runs.find((item) => item.id === runId);
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'Run not found in gateway fallback state' });
    return;
  }
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    ok: true,
    data: { run, state },
    run,
    state,
    gatewayFallback: true,
  });
}

function fallbackRunLogs({ res, runId, gatewayState, gatewayStore = null }) {
  const run = gatewayStore ? gatewayStore.getRun(runId) : gatewayState.runs.find((item) => item.id === runId);
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'Run not found in gateway fallback state', gatewayFallback: true });
    return;
  }
  const logs = Array.isArray(run.logs) ? run.logs : [];
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, { ok: true, data: { run, logs }, run, logs, state, gatewayFallback: true });
}

function fallbackRunAction({ res, action, runId, gatewayState, gatewayStore = null }) {
  if (!gatewayStore) {
    sendDatabaseRequired(res, 'run actions');
    return;
  }
  const run = gatewayStore ? gatewayStore.getRun(runId) : gatewayState.runs.find((item) => item.id === runId);
  if (!run) {
    sendJson(res, 404, { ok: false, error: 'Run not found in gateway fallback state', gatewayFallback: true });
    return;
  }
  if (action === 'stop') {
    const stopped = gatewayStore ? gatewayStore.updateRunStatus(runId, 'stopped') : Object.assign(run, { status: 'stopped' });
    if (gatewayStore) gatewayStore.appendRunLog(runId, 'gateway stop requested');
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { run: stopped, state }, run: stopped, state, gatewayFallback: true });
    return;
  }
  if (action === 'approve') {
    const approved = gatewayStore ? gatewayStore.updateRunStatus(runId, 'approved') : Object.assign(run, { status: 'approved' });
    if (gatewayStore) gatewayStore.appendRunLog(runId, 'gateway approval recorded');
    const state = gatewaySnapshot(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { run: approved, state }, run: approved, state, gatewayFallback: true });
    return;
  }
  const retryPayload = {
    goal: run.goal,
    agent: run.agent,
    model: run.model,
    source: 'gateway-retry',
    sourceRunId: run.id,
  };
  const retryRun = gatewayStore ? gatewayStore.createRun(retryPayload) : createGatewayRun(retryPayload);
  if (!gatewayStore) gatewayState.runs.unshift(retryRun);
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, { ok: true, data: { run: retryRun, retriedFrom: run.id, state }, run: retryRun, retriedFrom: run.id, state, gatewayFallback: true });
}

function fallbackMissionTemplates(res) {
  sendJson(res, 200, {
    templates: listMissionTemplates(),
    gatewayFallback: true,
  });
}

function fallbackRunnerAdapters({
  res,
  env = process.env,
  gatewayState = createGatewayState(),
  gatewayStore = null,
} = {}) {
  const runner = {
    mode: 'runtime-unreachable',
    allowShellCommands: false,
    command: '',
    cwd: '',
    timeoutMs: Number(env.HERMES_RUN_TIMEOUT_MS || 86400000),
  };
  const catalog = buildRunnerAdapterCatalog({
    settings: { runner },
  });
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const agentBindings = (Array.isArray(state.agents) ? state.agents : []).map((agent) => {
    const executionBackend = agent.executionBackend || null;
    const adapterId = executionBackend?.id || agent.runtimeBinding?.executionBackendId || agent.runtimeBinding?.adapterId || '';
    const commandTemplate = executionBackend?.commandTemplate || agent.runtimeBinding?.commandTemplate || '';
    return {
      agentId: agent.id,
      displayName: agent.displayName || agent.name,
      agentIdentity: agent.agentIdentity,
      executionBackend,
      runnerAdapter: agent.runnerAdapter,
      runtimeBinding: agent.runtimeBinding,
      adapterId,
      commandTemplate,
      model: executionBackend?.model || agent.runtimeBinding?.model || agent.model || '',
      ready: false,
    };
  });
  sendJson(res, 200, {
    ...catalog,
    catalog,
    agentBindings,
    agentSourceStatus: state.agentSourceStatus || fallbackAgentSourceStatus(),
    gatewayFallback: true,
  });
}

function fallbackProductStatus(res, gatewayState, env = process.env) {
  const status = buildProductStatus({
    settings: {
      wikiRoot: env.HERMES_WIKI_ROOT || '/Users/goyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki',
      runner: {
        mode: 'runtime-unreachable',
        allowShellCommands: false,
        command: '',
        commandConfigured: false,
      },
      remote: {
        publicBaseUrl: env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '',
      },
    },
    state: gatewayState,
    publicUrl: env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '',
  });
  sendJson(res, 200, { status, gatewayFallback: true });
}

function fallbackAgentCreate({
  res,
  body = {},
  gatewayState,
  gatewayStore = null,
}) {
  if (!gatewayStore || typeof gatewayStore.createAgentProfileRequest !== 'function') {
    sendDatabaseRequired(res, 'agents');
    return;
  }
  const profileRequest = gatewayStore.createAgentProfileRequest(body);
  const state = gatewayProfileState(gatewayState, gatewayStore);
  const profileRequests = Array.isArray(state.agentProfileRequests) ? state.agentProfileRequests : [];
  sendJson(res, 200, {
    ok: true,
    profileRequest,
    data: { profileRequest, state, agents: state.agents || [], profileRequests },
    agents: state.agents || [],
    profileRequests,
    state,
    gatewayFallback: true,
  });
}

function fallbackAgentDelete({
  res,
  agentId,
  gatewayState,
  gatewayStore = null,
  extraStates = [],
}) {
  const rawId = decodeURIComponent(String(agentId || '')).trim();
  if (!rawId) {
    sendJson(res, 400, { ok: false, error: 'agent_id_required', gatewayFallback: true });
    return;
  }
  const currentAgent = findGatewayAgentById(rawId, gatewayState, gatewayStore, extraStates);
  if (isProtectedGatewayAgent(currentAgent || rawId)) {
    sendJson(res, 409, { ok: false, error: 'protected_agent', agentId: rawId, gatewayFallback: true });
    return;
  }
  let agent = null;
  if (gatewayStore && typeof gatewayStore.deleteAgent === 'function') {
    agent = gatewayStore.deleteAgent(rawId);
  }
  if (!Array.isArray(gatewayState.agents)) gatewayState.agents = [];
  const index = gatewayState.agents.findIndex((item) => gatewayAgentKeys(item).includes(rawId));
  if (index >= 0) [agent] = gatewayState.agents.splice(index, 1);
  if (!agent) agent = { id: rawId, displayName: rawId, name: rawId };
  const deletedIds = new Set([
    ...(Array.isArray(gatewayState.deletedAgentIds) ? gatewayState.deletedAgentIds : []),
    ...gatewayAgentKeys(agent),
    rawId,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  [...PROTECTED_AGENT_IDS].forEach((id) => deletedIds.delete(id));
  gatewayState.deletedAgentIds = [...deletedIds];
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    ok: true,
    agent,
    deletedAgentIds: state.deletedAgentIds || [],
    state,
    gatewayFallback: true,
  });
}

function fallbackAgentRestore({
  res,
  agentId,
  gatewayState,
  gatewayStore = null,
}) {
  const rawId = decodeURIComponent(String(agentId || '')).trim();
  if (!rawId) {
    sendJson(res, 400, { ok: false, error: 'agent_id_required', gatewayFallback: true });
    return;
  }
  const normalized = rawId.toLowerCase();
  if (gatewayStore && typeof gatewayStore.restoreAgent === 'function') {
    gatewayStore.restoreAgent(rawId);
  }
  gatewayState.deletedAgentIds = (Array.isArray(gatewayState.deletedAgentIds) ? gatewayState.deletedAgentIds : [])
    .filter((id) => String(id || '').trim().toLowerCase() !== normalized);
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  sendJson(res, 200, {
    ok: true,
    agentId: rawId,
    restored: true,
    deletedAgentIds: state.deletedAgentIds || [],
    state,
    agents: state.agents || [],
    gatewayFallback: true,
  });
}

function fallbackAgentUpdate({
  res,
  agentId,
  body = {},
  gatewayState,
  gatewayStore = null,
}) {
  const rawId = decodeURIComponent(String(agentId || '')).trim();
  if (!rawId) {
    sendJson(res, 400, { ok: false, error: 'agent_id_required', gatewayFallback: true });
    return;
  }
  let agent = null;
  if (gatewayStore && typeof gatewayStore.updateAgent === 'function') {
    agent = gatewayStore.updateAgent(rawId, body);
  } else {
    if (!Array.isArray(gatewayState.agents)) gatewayState.agents = [];
    const index = gatewayState.agents.findIndex((item) => gatewayAgentKeys(item).includes(rawId));
    const current = index >= 0 ? gatewayState.agents[index] : { id: rawId, displayName: rawId, name: rawId };
    const dashboardSettings = {
      ...(current.dashboardSettings || {}),
      ...(body.dashboardSettings || {}),
      ...(body.displayName !== undefined ? { displayName: String(body.displayName || '').trim() } : {}),
      ...(body.persona !== undefined ? { persona: String(body.persona || '') } : {}),
      ...(body.role !== undefined ? { role: String(body.role || '') } : {}),
      ...(body.model !== undefined ? { model: String(body.model || '') } : {}),
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    };
    agent = {
      ...current,
      displayName: dashboardSettings.displayName || current.displayName || rawId,
      name: dashboardSettings.displayName || current.name || current.displayName || rawId,
      persona: dashboardSettings.persona ?? current.persona ?? '',
      role: dashboardSettings.role ?? current.role ?? '',
      model: dashboardSettings.model || current.model || 'Recommended',
      enabled: dashboardSettings.enabled !== false,
      status: dashboardSettings.enabled === false ? 'Idle' : (current.status === 'Idle' ? 'Active' : (current.status || 'Active')),
      dashboardSettings,
      updatedAt: new Date().toISOString(),
    };
    if (index >= 0) gatewayState.agents[index] = agent;
    else gatewayState.agents.push(agent);
  }
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const projectedAgent = (state.agents || []).find((item) => gatewayAgentKeys(item).includes(rawId)) || agent;
  sendJson(res, 200, {
    ok: true,
    agent: projectedAgent,
    agents: state.agents || [],
    state,
    gatewayFallback: true,
  });
}

function fallbackAgentsList({ res, gatewayState, gatewayStore = null }) {
  const state = gatewayProfileState(gatewayState, gatewayStore);
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const agentSourceStatus = state.agentSourceStatus || fallbackAgentSourceStatus();
  const profileRequests = Array.isArray(state.agentProfileRequests) ? state.agentProfileRequests : [];
  sendJson(res, 200, {
    ok: true,
    data: { agents, state, agentSourceStatus, deletedAgentIds: state.deletedAgentIds || [], profileRequests },
    agents,
    deletedAgentIds: state.deletedAgentIds || [],
    profileRequests,
    state,
    agentSourceStatus,
    gatewayFallback: true,
  });
}

function sameGatewayAgentKey(agent = {}, rawId = '') {
  const id = decodeURIComponent(String(rawId || '')).trim().toLowerCase();
  if (!id) return false;
  return [agent.id, agent.name, agent.displayName, agent.runtimeBinding?.agentKey, agent.profile?.name]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .includes(id);
}

function gatewayAgentRuns(state = {}, agent = {}) {
  const agentKeys = [agent.id, agent.name, agent.displayName, agent.runtimeBinding?.agentKey, agent.profile?.name]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return (Array.isArray(state.runs) ? state.runs : []).filter((run) => {
    const runKeys = [run.agent, run.agentId, run.assignee, run.profile]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return runKeys.some((key) => agentKeys.includes(key));
  });
}

function findGatewayRun(state = {}, rawRunId = '') {
  const runId = decodeURIComponent(String(rawRunId || '')).trim();
  if (!runId) return null;
  return (Array.isArray(state.runs) ? state.runs : []).find((run) => String(run.id || '') === runId) || null;
}

function sendGatewayRunDetail({ res, state, rawRunId, gatewayFallback = true }) {
  const run = findGatewayRun(state, rawRunId);
  if (!run) {
    sendJson(res, 404, {
      ok: false,
      error: gatewayFallback ? 'Run not found in gateway fallback state' : 'Run not found in live relay state',
      runId: decodeURIComponent(String(rawRunId || '')),
      state,
      gatewayFallback,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: { run, state },
    run,
    state,
    gatewayFallback,
  });
}

function sendGatewayRunLogs({ res, state, rawRunId, gatewayFallback = true }) {
  const run = findGatewayRun(state, rawRunId);
  if (!run) {
    sendJson(res, 404, {
      ok: false,
      error: gatewayFallback ? 'Run not found in gateway fallback state' : 'Run not found in live relay state',
      runId: decodeURIComponent(String(rawRunId || '')),
      gatewayFallback,
    });
    return;
  }
  const logs = Array.isArray(run.logs) ? run.logs : [];
  sendJson(res, 200, {
    ok: true,
    data: { run, logs },
    run,
    logs,
    state,
    gatewayFallback,
  });
}

function sendGatewayAgentDetail({ res, state, rawAgentId, gatewayFallback = true, agentSourceStatus = null }) {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const agent = agents.find((item) => sameGatewayAgentKey(item, rawAgentId));
  if (!agent) {
    sendJson(res, 404, {
      ok: false,
      error: 'agent_not_found',
      agentId: decodeURIComponent(String(rawAgentId || '')),
      data: { agents, state, agentSourceStatus: agentSourceStatus || state.agentSourceStatus || null },
      agents,
      state,
      agentSourceStatus: agentSourceStatus || state.agentSourceStatus || null,
      gatewayFallback,
    });
    return;
  }
  const recentRuns = gatewayAgentRuns(state, agent);
  sendJson(res, 200, {
    ok: true,
    agentId: agent.id || agent.name || rawAgentId,
    data: {
      agent,
      agents,
      recentRuns,
      state,
      agentSourceStatus: agentSourceStatus || state.agentSourceStatus || null,
      profileReadiness: state.profileReadiness || null,
    },
    agent,
    agents,
    recentRuns,
    profileReadiness: state.profileReadiness || null,
    state,
    agentSourceStatus: agentSourceStatus || state.agentSourceStatus || null,
    gatewayFallback,
  });
}

function fallbackAgentRunCreate({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (gatewayStore) {
    const profileState = gatewayProfileState(gatewayState, gatewayStore);
    const profileAgent = resolveGatewayRunProfile(body, profileState);
    const run = gatewayStore.createRun({
      ...body,
      agentId: profileAgent.id,
      agent: profileAgent.displayName || profileAgent.name || profileAgent.id,
      profileAgents: profileState.agents,
      source: body.source || 'railway-gateway',
    });
    const state = gatewayProfileState(gatewayState, gatewayStore);
    sendJson(res, 200, { ok: true, data: { run, state }, run, state, gatewayFallback: true });
    return;
  }
  sendDatabaseRequired(res, 'runs');
}

function fallbackMissionLaunch({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.saveRun !== 'function') {
    sendDatabaseRequired(res, 'mission runs');
    return;
  }
  const payload = buildMissionRunPayload(body);
  const run = gatewayStore.saveRun(createGatewayRun(payload));
  sendJson(res, 200, {
    mission: payload.mission,
    run,
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function normalizeGatewaySchedulerJob(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || createId('job'),
    name: input.name || 'scheduled-job',
    goal: input.goal || 'Scheduled Hermes run',
    agent: resolveRequestedOfficialProfile({ agentId: input.agentId, agent: input.agent }),
    model: input.model || 'Codex',
    intervalMinutes: Math.max(1, Math.round(Number(input.intervalMinutes) || 60)),
    enabled: input.enabled !== false,
    runCount: Number(input.runCount || 0),
    lastRunAt: input.lastRunAt || '',
    createdAt: input.createdAt || now,
    gatewayFallback: true,
  };
}

function fallbackMissionSchedule({ res, body = {}, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.createSchedulerJob !== 'function') {
    sendDatabaseRequired(res, 'scheduler jobs');
    return;
  }
  const job = gatewayStore.createSchedulerJob(buildMissionSchedulePayload(body));
  sendJson(res, 200, {
    job,
    jobs: gatewayStore.getSchedulerJobs(),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackSchedulerJobs({ res, method, body = {}, jobId = '', action = '', gatewayState, gatewayStore = null }) {
  if (method === 'GET') {
    const jobs = gatewayStore && typeof gatewayStore.getSchedulerJobs === 'function'
      ? gatewayStore.getSchedulerJobs()
      : gatewayState.schedulerJobs;
    sendJson(res, 200, { jobs, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  if (!gatewayStore) {
    sendDatabaseRequired(res, 'scheduler jobs');
    return;
  }
  if (method === 'POST' && !jobId) {
    const job = gatewayStore.createSchedulerJob(body);
    sendJson(res, 200, { job, jobs: gatewayStore.getSchedulerJobs(), state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  const jobs = gatewayStore.getSchedulerJobs();
  const currentJob = jobs.find((job) => String(job.id || job.name) === String(jobId));
  if (!currentJob) {
    sendJson(res, 404, { error: 'Scheduler job not found in gateway fallback state', gatewayFallback: true });
    return;
  }
  if (method === 'PATCH' && !action) {
    const job = gatewayStore.updateSchedulerJob(currentJob.id, {
      ...currentJob,
      ...body,
      id: currentJob.id,
      runCount: currentJob.runCount,
      lastRunAt: currentJob.lastRunAt,
      createdAt: currentJob.createdAt,
    });
    sendJson(res, 200, {
      job,
      jobs: gatewayStore.getSchedulerJobs(),
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    });
    return;
  }
  if (method === 'DELETE' && !action) {
    const deleted = gatewayStore.deleteSchedulerJob(currentJob.id);
    sendJson(res, 200, { deleted, jobs: gatewayStore.getSchedulerJobs(), state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  if (method === 'POST' && action === 'run') {
    const job = currentJob;
    const run = createGatewayRun({
      name: job.name,
      goal: job.goal,
      agent: job.agent,
      model: job.model,
      source: 'scheduler',
      mission: { id: job.id, label: job.name, wikiWriteBack: '5_conversation/agent-runs' },
    });
    const savedRun = typeof gatewayStore.saveRun === 'function' ? gatewayStore.saveRun(run) : run;
    const updatedJob = gatewayStore.updateSchedulerJob(job.id, {
      runCount: Number(job.runCount || 0) + 1,
      lastRunAt: new Date().toISOString(),
      lastRunId: savedRun.id,
    });
    sendJson(res, 200, { run: savedRun, job: updatedJob, jobs: gatewayStore.getSchedulerJobs(), state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
    return;
  }
  sendJson(res, 405, { error: 'Unsupported scheduler fallback action', gatewayFallback: true });
}

function fallbackSchedulerTick({ res, gatewayState, gatewayStore = null }) {
  if (!gatewayStore || typeof gatewayStore.setDaemonStatus !== 'function') {
    sendDatabaseRequired(res, 'scheduler daemon state');
    return;
  }
  const checkedAt = new Date().toISOString();
  const daemon = gatewayStore.setDaemonStatus({
    ...(gatewayStore.getState().daemon || {}),
    lastRun: { checkedAt, createdRuns: 0 },
    lastError: null,
  });
  sendJson(res, 200, {
    checkedAt,
    daemon,
    createdRuns: [],
    jobs: gatewayStore.getSchedulerJobs(),
    state: gatewaySnapshot(gatewayState, gatewayStore),
    gatewayFallback: true,
  });
}

function fallbackSchedulerDaemon({ res, method, action = '', body = {}, gatewayState, gatewayStore = null }) {
  if (method !== 'GET' && (!gatewayStore || typeof gatewayStore.setDaemonStatus !== 'function')) {
    sendDatabaseRequired(res, 'scheduler daemon state');
    return;
  }
  let daemon = gatewayStore && typeof gatewayStore.getState === 'function'
    ? gatewayStore.getState().daemon
    : gatewayState.daemon;
  if (method === 'POST' && action === 'start') {
    daemon = gatewayStore.setDaemonStatus({
      ...(gatewayStore.getState().daemon || {}),
      running: true,
      intervalMs: Number(body.intervalMs || 60000),
      lastError: null,
    });
  }
  if (method === 'POST' && action === 'stop') {
    daemon = gatewayStore.setDaemonStatus({
      ...(gatewayStore.getState().daemon || {}),
      running: false,
      lastError: null,
    });
  }
  sendJson(res, 200, { daemon, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
}

function fallbackEvents(res) {
  sendSseStream(res, [
    {
      event: 'connected',
      data: {
        gatewayFallback: true,
        message: 'event stream fallback polling',
        time: new Date().toISOString(),
      },
    },
  ]);
}

async function fallbackScheduleAssistantAsk({ res, body = {}, gatewayState, gatewayStore = null, env = process.env, fetchImpl = fetch }) {
  const question = String(body.question || body.message || body.query || '').trim();
  if (!question) {
    sendJson(res, 400, {
      ok: false,
      error: 'question is required',
      gatewayFallback: true,
    });
    return null;
  }
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const result = await buildScheduleAssistantAnswer({
    question,
    filters: body.filters || {},
    state,
    env,
    fetchImpl,
  });
  sendJson(res, 200, {
    ...result,
    state,
    gatewayFallback: true,
  });
  return result;
}

async function streamScheduleAssistantAsk({ res, body = {}, gatewayState, gatewayStore = null, env = process.env, fetchImpl = fetch }) {
  const question = String(body.question || body.message || body.query || '').trim();
  if (!question) {
    sendSseStream(res, [
      { event: 'error', data: { ok: false, error: 'question is required', gatewayFallback: true } },
      { event: 'done', data: { ok: false, text: '', error: 'question is required', gatewayFallback: true } },
    ]);
    return;
  }
  const state = gatewaySnapshot(gatewayState, gatewayStore);
  const result = await buildScheduleAssistantAnswer({
    question,
    filters: body.filters || {},
    state,
    env,
    fetchImpl,
  });
  const userMessage = {
    role: 'user',
    text: question,
    source: 'schedule-assistant',
  };
  const assistantMessage = {
    role: 'assistant',
    text: result.answer,
    source: 'schedule-assistant',
  };
  if (gatewayStore && typeof gatewayStore.addChatMessage === 'function') {
    gatewayStore.addChatMessage(userMessage);
    gatewayStore.addChatMessage(assistantMessage);
  } else {
    addGatewayChatMessage(gatewayState, userMessage);
    addGatewayChatMessage(gatewayState, assistantMessage);
  }
  sendSseStream(res, [
    {
      event: 'delta',
      data: {
        text: result.answer,
        source: 'schedule-assistant',
        search: result.search,
      },
    },
    {
      event: 'done',
      data: {
        ok: true,
        text: result.answer,
        answer: result.answer,
        sources: result.sources,
        computed: result.computed,
        search: result.search,
        gatewayFallback: true,
      },
    },
  ]);
}

function buildRuntimeRecoveryChatEvents({ message, command } = {}) {
  const recoveryCommand = buildRuntimeRecoveryCommand();
  const visual = {
    agentState: {
      agent: 'Hermes Runtime',
      model: 'Codex',
      mode: 'runtime-recovery',
      status: 'recovery-required',
      runId: '',
      reason: 'Mac mini runtime is unreachable from the public gateway.',
    },
    timeline: [
      { label: 'Message received', detail: message || '' },
      { label: 'Runtime checked', detail: 'Gateway received a 5xx response from the Mac mini tunnel.' },
      { label: 'Recovery prepared', detail: 'Copy recovery command from Runtime Recovery.' },
    ],
    toolActivity: [
      { tool: 'Hermes Router', state: 'done', detail: command && command.templateId ? command.templateId : 'runtime-recovery' },
      { tool: 'Mac mini Hermes', state: 'down', detail: 'local runtime unreachable' },
      { tool: 'Runtime Recovery', state: 'ready', detail: 'Copy recovery command' },
    ],
    memory: {
      wikiPath: '5_conversation/agent-runs/runtime-update.md',
      savePolicy: 'recovery command is kept in the gateway health response',
      next: 'Copy recovery in Dashboard, run it on the Mac mini, then press Check again.',
      recoveryCommand,
    },
  };
  const deltas = [
    '맥미니 Hermes 런타임이 지금 public gateway에서 닿지 않습니다. ',
    '그래서 새 agent run을 만들기 전에 Runtime Recovery 모드로 전환했어요. ',
    'Dashboard의 Runtime Recovery 패널에서 Copy recovery를 눌러 맥미니에서 실행한 뒤 Check again을 누르면 됩니다.',
  ];
  return [
    { event: 'agent-state', data: visual.agentState },
    { event: 'timeline', data: visual.timeline },
    { event: 'tool-activity', data: visual.toolActivity },
    { event: 'memory', data: visual.memory },
    ...deltas.map((delta) => ({ event: 'delta', data: { text: delta } })),
    {
      event: 'done',
      data: {
        text: deltas.join(''),
        visualization: visual,
        run: null,
        state: null,
        recoveryCommand,
      },
    },
  ];
}

async function fallbackChatStream({ res, body, env, fetchImpl, gatewayState, gatewayStore = null }) {
  if (!gatewayStore) {
    sendDatabaseRequired(res, 'chat commands');
    return;
  }
  const command = routeWebCommand({
    message: body.message,
    view: body.view,
    agent: body.agent,
    agentId: body.agentId,
  });
  let run = null;
  try {
    run = await postRuntimeRun({
      env,
      fetchImpl,
      payload: buildChatRunPayload(command),
    });
  } catch (error) {
    const payload = buildChatRunPayload(command);
    run = typeof gatewayStore.saveRun === 'function'
      ? gatewayStore.saveRun({
        ...createGatewayRun(payload),
        source: payload.source || 'chat',
        gatewayFallback: true,
        runtimeReachable: false,
      })
      : gatewayStore.createRun({ ...payload, source: payload.source || 'chat' });
    run.gatewayFallback = true;
    run.runtimeReachable = false;
    run.logs = [
      ...(run.logs || []),
      `runtime unreachable: ${error.message}`,
      `recoveryCommand=${buildRuntimeRecoveryCommand()}`,
    ];
    run.logs.forEach((line) => gatewayStore.appendRunLog(run.id, line));
    const userMessage = {
      role: 'user',
      text: command.message,
      runId: run.id,
      wikiPath: run.file,
      agent: command.agent,
      model: command.model,
      source: 'chat',
    };
    const assistantMessage = {
      role: 'assistant',
      text: `${buildHermesChatDeltas({ command, run }).join('')} 런타임 복구가 필요해.`,
      runId: run.id,
      wikiPath: run.file,
      agent: run.agent || command.agent,
      model: run.model || command.model,
      source: 'chat',
    };
    gatewayStore.addChatMessage(userMessage);
    gatewayStore.addChatMessage(assistantMessage);
    sendSseStream(res, buildHermesChatStreamEvents({
      message: command.message,
      command,
      run,
      state: gatewaySnapshot(gatewayState, gatewayStore),
    }));
    return;
  }
  run = typeof gatewayStore.saveRun === 'function' ? gatewayStore.saveRun(run) : run;
  const userMessage = {
    role: 'user',
    text: command.message,
    runId: run.id,
    wikiPath: run.file,
    agent: run.agent || command.agent,
    model: run.model || command.model,
    source: 'chat',
  };
  const assistantMessage = {
    role: 'assistant',
    text: buildHermesChatDeltas({ command, run }).join(''),
    runId: run.id,
    wikiPath: run.file,
    agent: run.agent || command.agent,
    model: run.model || command.model,
    source: 'chat',
  };
  gatewayStore.addChatMessage(userMessage);
  gatewayStore.addChatMessage(assistantMessage);
  sendSseStream(res, buildHermesChatStreamEvents({
    message: command.message,
    command,
    run,
    state: gatewaySnapshot(gatewayState, gatewayStore),
  }));
}

async function handleApi(req, res, requestUrl, env = process.env, fetchImpl = fetch, gatewayState = createGatewayState(), gatewayStore = null, relay = null) {
  const pathSegments = requestUrl.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);

  if (pathSegments[0] === 'gateway-status') {
    const status = await buildGatewayStatus({
      runtimeUrl: env.HERMES_RUNTIME_URL,
      runtimeToken: env.HERMES_RUNTIME_TOKEN,
      buildCommit: env.RAILWAY_GIT_COMMIT_SHA || env.RAILWAY_GIT_COMMIT || env.SOURCE_COMMIT || '',
      deploymentId: env.RAILWAY_DEPLOYMENT_ID || '',
      fetchImpl,
    });
    const relayStatus = relayEnabled(env) && relay && typeof relay.status === 'function'
      ? relay.status({ env })
      : null;
    const relayReachable = Boolean(relayStatus?.bridgeOnline && relayStatus?.liveSnapshotOnline);
    sendJson(res, 200, {
      ...status,
      relay: relayStatus ? {
        ok: relayStatus.ok,
        mode: relayStatus.mode,
        bridgeOnline: relayStatus.bridgeOnline,
        liveSnapshotOnline: relayStatus.liveSnapshotOnline,
        lastSnapshotAt: relayStatus.lastSnapshotAt,
        pendingJobs: relayStatus.pendingJobs,
        activeJobs: relayStatus.activeJobs,
      } : null,
      effectiveRuntimeReachable: Boolean(status.runtimeReachable || relayReachable),
      runtimeAccessMode: status.runtimeReachable ? 'direct' : (relayReachable ? 'relay' : 'offline'),
    });
    return;
  }

  const method = req.method || 'GET';
  const bodyBuffer = ['GET', 'HEAD'].includes(method) ? undefined : await readRequestBody(req);
  if (pathSegments[0] === 'relay') {
    if (!relayEnabled(env)) {
      sendJson(res, 404, { ok: false, error: 'relay_not_configured' });
      return;
    }
    if (method === 'GET' && pathSegments[1] === 'status') {
      sendJson(res, 200, relay ? relay.status({ env }) : { ok: false, mode: 'railway-relay', bridgeOnline: false });
      return;
    }
    if (method === 'GET' && pathSegments[1] === 'snapshot') {
      const snapshot = relay && typeof relay.snapshot === 'function'
        ? relay.snapshot({ env, allowStale: requestUrl.searchParams.get('stale') === '1' })
        : null;
      sendJson(res, snapshot ? 200 : 404, snapshot || { ok: false, error: 'relay_snapshot_not_found' });
      return;
    }
    if (!isRelayAuthorized(req, env)) {
      sendJson(res, 401, { ok: false, error: 'relay_unauthorized' });
      return;
    }
    if (method === 'POST' && pathSegments[1] === 'snapshot') {
      const body = parseJsonBuffer(bodyBuffer);
      const snapshot = relay.updateSnapshot(body);
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }
    if (method === 'GET' && pathSegments[1] === 'poll') {
      const timeout = Number(requestUrl.searchParams.get('timeout') || env.HERMES_RELAY_POLL_TIMEOUT_MS || 25_000);
      sendJson(res, 200, await relay.poll({ timeoutMs: timeout }));
      return;
    }
    const relayJobMatch = pathSegments[1] === 'jobs' && pathSegments[2];
    if (relayJobMatch && method === 'POST' && pathSegments[3] === 'events') {
      const body = parseJsonBuffer(bodyBuffer);
      const event = relay.appendEvent(decodeURIComponent(pathSegments[2]), body);
      if (!event) {
        sendJson(res, 404, { ok: false, error: 'relay_job_not_found' });
        return;
      }
      sendJson(res, 200, { ok: true, event });
      return;
    }
    if (relayJobMatch && method === 'POST' && pathSegments[3] === 'complete') {
      const body = parseJsonBuffer(bodyBuffer);
      const job = relay.complete(decodeURIComponent(pathSegments[2]), body);
      if (!job) {
        sendJson(res, 404, { ok: false, error: 'relay_job_not_found' });
        return;
      }
      sendJson(res, 200, { ok: true, job: { id: job.id, complete: job.complete, updatedAt: job.updatedAt } });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'relay_not_found' });
    return;
  }
  const requestBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? parseJsonBuffer(bodyBuffer) : {};
  if (
    method === 'POST'
    && pathSegments[0] === 'chat'
    && pathSegments[1] === 'stream'
    && (String(requestBody.view || '') === 'wiki' || String(requestBody.agent || requestBody.agentId || '').includes('wiki'))
  ) {
    await fallbackWikiChatStream({
      res,
      body: requestBody,
      gatewayState,
      gatewayStore,
      env,
      fetchImpl,
    });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'chat' && pathSegments[1] === 'stream' && isScheduleQuestion(requestBody.message || requestBody.question || requestBody.query)) {
    await streamScheduleAssistantAsk({
      res,
      body: requestBody,
      gatewayState,
      gatewayStore,
      env,
      fetchImpl,
    });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'assistant' && pathSegments[1] === 'ask') {
    await fallbackScheduleAssistantAsk({
      res,
      body: requestBody,
      gatewayState,
      gatewayStore,
      env,
      fetchImpl,
    });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'wiki' && pathSegments[1] === 'search') {
    await fallbackWikiSearch({
      res,
      body: requestBody,
      gatewayState,
      gatewayStore,
      env,
      fetchImpl,
    });
    return;
  }
  const schedulerWriteRequest = pathSegments[0] === 'scheduler' && method !== 'GET';
  const missionScheduleRequest = method === 'POST' && pathSegments[0] === 'missions' && pathSegments[1] === 'schedule';
  const agentProfileCreateRequest = method === 'POST' && pathSegments[0] === 'agents' && !pathSegments[1];
  const runCreateRequest = method === 'POST' && pathSegments[0] === 'runs' && !pathSegments[1];
  const settingsRuntimeRequest = pathSegments[0] === 'settings' && ['GET', 'POST'].includes(method);
  const schedulerTranslation = schedulerRelayTranslation({ method, pathSegments, body: requestBody });
  const toolTranslation = toolRelayTranslation({
    method,
    pathSegments,
    body: requestBody,
    query: queryObject(requestUrl.searchParams),
  });
  if (toolTranslation || schedulerTranslation || schedulerWriteRequest || missionScheduleRequest || agentProfileCreateRequest || runCreateRequest || settingsRuntimeRequest) {
    const profileCreateBody = agentProfileCreateRequest ? buildHermesProfileCreateBody(requestBody) : null;
    const relayResponse = await relayRuntimeJsonRequest({
      relay,
      env,
      method: toolTranslation?.method || schedulerTranslation?.method || (agentProfileCreateRequest ? 'POST' : method),
      pathSegments,
      pathOverride: toolTranslation?.pathOverride || schedulerTranslation?.pathOverride || (agentProfileCreateRequest ? '/api/profiles' : ''),
      query: toolTranslation?.query || schedulerTranslation?.query || queryObject(requestUrl.searchParams),
      bodyBuffer,
      bodyText: toolTranslation?.bodyText || schedulerTranslation?.bodyText || (profileCreateBody ? JSON.stringify(profileCreateBody) : ''),
    });
    if (relayResponse) {
      const body = relayResponse.body || {};
      let responseBody = body && typeof body === 'object' && !Array.isArray(body) && body.state
        ? mergeGatewayResponseBody(body, gatewayState, env, gatewayStore)
        : body;
      if (schedulerTranslation?.kind === 'cron-create') {
        const cronJob = body.job || (body.id || body.name ? body : null);
        if (cronJob) responseBody = { ok: body.ok !== false, ...body, job: normalizeHermesCronResponseJob(cronJob) };
      }
      if (schedulerTranslation?.kind?.startsWith('cron-') && schedulerTranslation.kind !== 'cron-create') {
        const cronJob = body.job || body.updated || body.deleted || (body.id || body.name ? body : null);
        if (cronJob) responseBody = { ok: body.ok !== false, ...body, job: normalizeHermesCronResponseJob(cronJob) };
      }
      if (agentProfileCreateRequest) {
        const profileCreateOk = relayResponse.status < 400 && body.ok !== false;
        const agent = profileCreateOk
          ? normalizeHermesProfileAgent({ ...profileCreateBody, ...body, name: body.name || profileCreateBody.name })
          : null;
        responseBody = {
          ok: profileCreateOk,
          ...body,
          ok: profileCreateOk,
          ...(!profileCreateOk && !body.error ? { error: 'Hermes profile creation failed' } : {}),
          ...(agent ? { agent, data: { agent } } : {}),
        };
      }
      if (toolTranslation) {
        responseBody = {
          ok: body.ok !== false,
          ...body,
          tool: {
            ...toolTranslation.tool,
            ...(body.name ? { name: body.name } : {}),
            lastTest: toolTranslation.kind.endsWith('-test')
              ? { status: body.ok === false ? 'failed' : 'ok', checkedAt: new Date().toISOString(), result: body }
              : undefined,
          },
        };
      }
      sendJson(res, relayResponse.status, {
        ...responseBody,
        gatewayFallback: false,
        relayRuntimeRequest: true,
        ...(schedulerTranslation ? { relayTarget: schedulerTranslation.kind } : {}),
        ...(toolTranslation ? { relayTarget: toolTranslation.kind } : {}),
      });
      return;
    }
  }
  const liveRelaySnapshot = relayLiveSnapshot(relay, env);
  if (liveRelaySnapshot) {
    if (method === 'GET' && pathSegments[0] === 'state') {
      const state = relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore);
      sendJson(res, 200, state);
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'agents') {
      const state = relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore);
      if (pathSegments[1]) {
        sendGatewayAgentDetail({
          res,
          state,
          rawAgentId: pathSegments[1],
          gatewayFallback: false,
          agentSourceStatus: state.agentSourceStatus || liveRelaySnapshot.agentSourceStatus || null,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          agents: state.agents || [],
          state,
          agentSourceStatus: state.agentSourceStatus || liveRelaySnapshot.agentSourceStatus || null,
          profileReadiness: state.profileReadiness || null,
        },
        agents: state.agents || [],
        profileReadiness: state.profileReadiness || null,
        state,
        agentSourceStatus: state.agentSourceStatus || liveRelaySnapshot.agentSourceStatus || null,
        gatewayFallback: false,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'runs' && pathSegments[1] && !pathSegments[2]) {
      const state = relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore);
      sendGatewayRunDetail({
        res,
        state,
        rawRunId: pathSegments[1],
        gatewayFallback: false,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'runs' && pathSegments[1] && pathSegments[2] === 'logs') {
      const state = relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore);
      sendGatewayRunLogs({
        res,
        state,
        rawRunId: pathSegments[1],
        gatewayFallback: false,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'scheduler' && pathSegments[1] === 'jobs') {
      const state = relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore);
      const jobs = Array.isArray(liveRelaySnapshot.schedulerJobs)
        ? liveRelaySnapshot.schedulerJobs
        : Array.isArray(state.schedulerJobs)
          ? state.schedulerJobs
          : Array.isArray(state.automationJobs)
            ? state.automationJobs
            : [];
      sendJson(res, 200, { ok: true, jobs, state, gatewayFallback: false });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'tools' && !pathSegments[1]) {
      const state = relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore);
      const tools = Array.isArray(liveRelaySnapshot.tools)
        ? filterActualGatewayTools(liveRelaySnapshot.tools)
        : filterActualGatewayTools(state.tools);
      sendJson(res, 200, {
        ok: true,
        tools,
        skills: liveRelaySnapshot.skills || state.skills || [],
        toolsets: liveRelaySnapshot.toolsets || state.toolsets || [],
        mcpServers: liveRelaySnapshot.mcpServers || state.mcpServers || [],
        state,
        gatewayFallback: false,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'operations' && pathSegments[1] === 'overview') {
      fallbackOperationsOverview({
        res,
        gatewayState,
        gatewayStore,
        env,
        relaySnapshot: liveRelaySnapshot,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'health' && liveRelaySnapshot.health) {
      sendJson(res, 200, {
        ...liveRelaySnapshot.health,
        ok: liveRelaySnapshot.health.ok !== false,
        gatewayFallback: false,
        runtimeReachable: true,
        relaySnapshot: {
          source: liveRelaySnapshot.source || 'railway-relay-bridge',
          receivedAt: liveRelaySnapshot.receivedAt || '',
          ageMs: liveRelaySnapshot.ageMs,
          ttlMs: liveRelaySnapshot.ttlMs,
        },
      });
      return;
    }
  }
  if (method === 'GET' && pathSegments[0] === 'chat' && pathSegments[1] === 'messages') {
    fallbackChatMessages({
      res,
      gatewayState,
      gatewayStore,
      limit: requestUrl.searchParams.get('limit') || 80,
    });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'events') {
    fallbackEvents(res);
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'ticktick' && pathSegments[1] === 'setup') {
    sendJson(res, 200, buildTickTickSetupSummary({
      requestUrl,
      env,
      state: requestUrl.searchParams.get('state') || 'hermes-os',
    }));
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'ticktick' && pathSegments[1] === 'oauth-url') {
    const setup = buildTickTickSetupSummary({
      requestUrl,
      env,
      state: requestUrl.searchParams.get('state') || 'hermes-os',
    });
    sendJson(res, 200, { ok: true, url: setup.oauthUrl });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'ticktick' && pathSegments[1] === 'import') {
    if (!gatewayStore || typeof gatewayStore.importTickTickTasks !== 'function') {
      sendDatabaseRequired(res, 'TickTick imports');
      return;
    }
    const body = parseJsonBuffer(bodyBuffer);
    const result = importGatewayTickTickTasks({ body, gatewayState, gatewayStore });
    sendJson(res, 200, mergeGatewayResponseBody({
      ...result,
      state: gatewaySnapshot(gatewayState, gatewayStore),
      gatewayFallback: true,
    }, gatewayState, env, gatewayStore));
    return;
  }
  if (
    method === 'POST'
    && pathSegments[0] === 'ticktick'
    && ['import-once', 'replace-with-db'].includes(pathSegments[1])
  ) {
    const body = parseJsonBuffer(bodyBuffer);
    await fallbackTickTickImportOnce({ res, body, env, fetchImpl, gatewayState, gatewayStore });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'ticktick' && pathSegments[1] === 'sync') {
    const body = parseJsonBuffer(bodyBuffer);
    await fallbackTickTickSync({
      res,
      body,
      env,
      fetchImpl,
      gatewayState,
      gatewayStore,
    });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'settings' && publicGatewayMailAccounts(env).length) {
    fallbackSettings(res, env);
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'channels' && pathSegments[1] === 'status' && publicGatewayMailAccounts(env).length) {
    await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
    fallbackChannelsStatus({ res, env, gatewayState, gatewayStore });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'usage') {
    fallbackUsage({ res, gatewayState, gatewayStore, env });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'operations' && pathSegments[1] === 'overview') {
    fallbackOperationsOverview({ res, gatewayState, gatewayStore, env });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'mail' && pathSegments[1] === 'sync') {
    const body = parseJsonBuffer(bodyBuffer);
    await fallbackMailSync({ res, body, env, fetchImpl, gatewayState, gatewayStore });
    return;
  }
  if (method === 'DELETE' && pathSegments[0] === 'agents' && pathSegments[1] && !pathSegments[2]) {
    const relayState = liveRelaySnapshot
      ? relayStateFromSnapshot(liveRelaySnapshot, gatewayState, env, gatewayStore)
      : null;
    fallbackAgentDelete({
      res,
      agentId: pathSegments[1],
      gatewayState,
      gatewayStore,
      extraStates: relayState ? [relayState] : [],
    });
    return;
  }
  if (method === 'PATCH' && pathSegments[0] === 'agents' && pathSegments[1] && !pathSegments[2]) {
    const body = parseJsonBuffer(bodyBuffer);
    fallbackAgentUpdate({
      res,
      agentId: pathSegments[1],
      body,
      gatewayState,
      gatewayStore,
    });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'agents' && pathSegments[1] && pathSegments[2] === 'restore') {
    fallbackAgentRestore({
      res,
      agentId: pathSegments[1],
      gatewayState,
      gatewayStore,
    });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'workboard' && !pathSegments[1]) {
    fallbackWorkboardList({
      res,
      gatewayState,
      gatewayStore,
    });
    return;
  }
  if (pathSegments[0] === 'workboard' && pathSegments[1] === 'pages') {
    const body = parseJsonBuffer(bodyBuffer);
    if (method === 'POST' && !pathSegments[2]) {
      fallbackWorkboardPageCreate({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'PATCH' && pathSegments[2]) {
      fallbackWorkboardPageUpdate({
        res,
        body,
        gatewayState,
        gatewayStore,
        pageId: decodeURIComponent(pathSegments[2]),
      });
      return;
    }
    if (method === 'DELETE' && pathSegments[2]) {
      fallbackWorkboardPageDelete({
        res,
        gatewayState,
        gatewayStore,
        pageId: decodeURIComponent(pathSegments[2]),
      });
      return;
    }
  }
  let runtimeRequest;
  let runtimeResponse;
  try {
    runtimeRequest = buildRuntimeProxyRequest({
      runtimeUrl: env.HERMES_RUNTIME_URL,
      runtimeToken: env.HERMES_RUNTIME_TOKEN,
      method,
      path: pathSegments,
      query: queryObject(requestUrl.searchParams),
      headers: req.headers || {},
      body: bodyBuffer,
    });
    runtimeResponse = await fetchImpl(runtimeRequest.url, runtimeRequest.options);
  } catch (error) {
    if (method === 'GET' && pathSegments[0] === 'health') {
      fallbackHealth(res, null, env, error);
      return;
    }
    runtimeResponse = new Response(JSON.stringify({
      ok: false,
      error: error.message || String(error),
    }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (method === 'GET' && pathSegments[0] === 'health' && runtimeResponse.ok) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      fallbackHealth(res, runtimeResponse, env, new Error(`Invalid Mac mini health JSON: ${error.message}`));
      return;
    }
    sendJson(res, runtimeResponse.status, {
      ...body,
      gatewayFallback: false,
      runtimeReachable: true,
      gateway: redactGatewayConfig({
        runtimeUrl: env.HERMES_RUNTIME_URL,
        runtimeToken: env.HERMES_RUNTIME_TOKEN,
      }),
    });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'health' && runtimeResponse.status >= 500) {
    fallbackHealth(res, runtimeResponse, env);
    return;
  }
  if (runtimeResponse.status === 404 || runtimeResponse.status >= 500) {
    const body = parseJsonBuffer(bodyBuffer);
    if (method === 'GET' && pathSegments[0] === 'state') {
      await fallbackState(res, gatewayState, env, gatewayStore, fetchImpl);
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'wiki') {
      fallbackWiki({
        res,
        gatewayState,
        gatewayStore,
        env,
        query: queryObject(requestUrl.searchParams),
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'wiki' && pathSegments[1] === 'ask') {
      await fallbackWikiAsk({
        res,
        body,
        gatewayState,
        gatewayStore,
        env,
        fetchImpl,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'wiki' && pathSegments[1] === 'search') {
      await fallbackWikiSearch({
        res,
        body,
        gatewayState,
        gatewayStore,
        env,
        fetchImpl,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'system' && pathSegments[1] === 'connections') {
      fallbackSystemConnections({ res, env, gatewayState, gatewayStore });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'channels' && pathSegments[1] === 'status') {
      await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
      fallbackChannelsStatus({ res, env, gatewayState, gatewayStore });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'system' && pathSegments[1] === 'connections' && pathSegments[2] === 'bootstrap') {
      await fallbackSystemConnectionsBootstrap({ res, env, fetchImpl, gatewayState, gatewayStore });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'settings') {
      fallbackSettings(res, env);
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'mail' && pathSegments[1] === 'sync') {
      await fallbackMailSync({ res, body, env, fetchImpl, gatewayState, gatewayStore });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'telegram' && pathSegments[1] === 'webhook') {
      fallbackTelegramWebhook({ res, body, env, gatewayState, gatewayStore });
      return;
    }
    if (pathSegments[0] === 'inbox' && pathSegments[1] === 'commands') {
      if (method === 'GET' && !pathSegments[2]) {
        fallbackCommandInboxList({ res, gatewayState, gatewayStore, query: queryObject(requestUrl.searchParams) });
        return;
      }
      if (method === 'POST' && pathSegments[2] && pathSegments[3]) {
        fallbackCommandInboxAction({
          res,
          gatewayState,
          gatewayStore,
          itemId: decodeURIComponent(pathSegments[2]),
          action: pathSegments[3],
          body,
        });
        return;
      }
    }
    if (pathSegments[0] === 'documents') {
      if (method === 'GET' && !pathSegments[1]) {
        fallbackDocumentsList({ res, gatewayState, gatewayStore, query: queryObject(requestUrl.searchParams) });
        return;
      }
      if (method === 'POST' && !pathSegments[1]) {
        await fallbackDocumentCreate({ res, gatewayState, gatewayStore, body });
        return;
      }
      if (method === 'POST' && pathSegments[1] && pathSegments[2] === 'analyze') {
        fallbackDocumentAnalyze({
          res,
          gatewayState,
          documentId: decodeURIComponent(pathSegments[1]),
          body,
        });
        return;
      }
    }
    if (pathSegments[0] === 'tools') {
      if (method === 'GET' && !pathSegments[1]) {
        fallbackToolsList({ res, gatewayState, gatewayStore, query: queryObject(requestUrl.searchParams) });
        return;
      }
      if (method === 'POST' && !pathSegments[1]) {
        fallbackToolCreate({ res, gatewayState, gatewayStore, body });
        return;
      }
      if (method === 'PATCH' && pathSegments[1] && !pathSegments[2]) {
        fallbackToolPatch({ res, gatewayState, gatewayStore, toolId: decodeURIComponent(pathSegments[1]), body });
        return;
      }
      if (method === 'POST' && pathSegments[1] && pathSegments[2] === 'test') {
        fallbackToolTest({ res, gatewayState, gatewayStore, toolId: decodeURIComponent(pathSegments[1]), body });
        return;
      }
    }
    if (method === 'GET' && pathSegments[0] === 'missions' && pathSegments[1] === 'templates') {
      fallbackMissionTemplates(res);
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'missions' && pathSegments[1] === 'launch') {
      fallbackMissionLaunch({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'missions' && pathSegments[1] === 'schedule') {
      fallbackMissionSchedule({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'runner' && pathSegments[1] === 'adapters') {
      fallbackRunnerAdapters({
        res,
        env,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'product' && pathSegments[1] === 'status') {
      fallbackProductStatus(res, gatewayState, env);
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'agents') {
      if (pathSegments[1]) {
        const state = gatewaySnapshot(gatewayState, gatewayStore);
        sendGatewayAgentDetail({
          res,
          state,
          rawAgentId: pathSegments[1],
          gatewayFallback: true,
          agentSourceStatus: state.agentSourceStatus || fallbackAgentSourceStatus(),
        });
      } else {
        fallbackAgentsList({
          res,
          gatewayState,
          gatewayStore,
        });
      }
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'agents' && !pathSegments[1]) {
      fallbackAgentCreate({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'runs' && !pathSegments[1]) {
      fallbackAgentRunCreate({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'events') {
      fallbackEvents(res);
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'calendar' && pathSegments[1] === 'draft') {
      await fallbackCalendarDraft({ res, body });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'calendar' && pathSegments[1] === 'quick-add') {
      await fallbackCalendarQuickAdd({ res, body, env, fetchImpl, gatewayState, gatewayStore });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'workboard' && !pathSegments[1]) {
      fallbackWorkboardList({
        res,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'workboard' && pathSegments[1] === 'pages' && !pathSegments[2]) {
      fallbackWorkboardPageCreate({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'PATCH' && pathSegments[0] === 'workboard' && pathSegments[1] === 'pages' && pathSegments[2]) {
      fallbackWorkboardPageUpdate({
        res,
        body,
        gatewayState,
        gatewayStore,
        pageId: decodeURIComponent(pathSegments[2]),
      });
      return;
    }
    if (method === 'DELETE' && pathSegments[0] === 'workboard' && pathSegments[1] === 'pages' && pathSegments[2]) {
      fallbackWorkboardPageDelete({
        res,
        gatewayState,
        gatewayStore,
        pageId: decodeURIComponent(pathSegments[2]),
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'workboard' && pathSegments[1] === 'convert') {
      await fallbackWorkboardConvert({ res, body, env, fetchImpl, gatewayState, gatewayStore });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'calendar' && pathSegments[1] === 'events' && !pathSegments[2]) {
      fallbackCalendarEventsList({
        res,
        query: queryObject(requestUrl.searchParams),
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'calendar' && pathSegments[1] === 'events' && !pathSegments[2]) {
      fallbackCalendarEventCreate({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if ((method === 'PATCH' || method === 'DELETE') && pathSegments[0] === 'calendar' && pathSegments[1] === 'events' && pathSegments[2]) {
      fallbackCalendarEventMutation({
        res,
        method,
        eventId: decodeURIComponent(pathSegments[2]),
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'tasks' && !pathSegments[1]) {
      fallbackTaskCreate({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'tasks' && pathSegments[1] === 'share-draft') {
      fallbackTaskShareDraft({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'ticktick' && pathSegments[1] === 'import') {
      if (!gatewayStore || typeof gatewayStore.importTickTickTasks !== 'function') {
        sendDatabaseRequired(res, 'TickTick imports');
        return;
      }
      const result = importGatewayTickTickTasks({ body, gatewayState, gatewayStore });
      sendJson(res, 200, { ...result, state: gatewaySnapshot(gatewayState, gatewayStore), gatewayFallback: true });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'ticktick' && pathSegments[1] === 'sync') {
      await fallbackTickTickSync({
        res,
        body,
        env,
        fetchImpl,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'tasks' && !pathSegments[1]) {
      fallbackTasksList({
        res,
        query: queryObject(requestUrl.searchParams),
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if ((method === 'PATCH' || method === 'DELETE') && pathSegments[0] === 'tasks' && pathSegments[1]) {
      fallbackTaskMutation({
        res,
        method,
        taskId: decodeURIComponent(pathSegments[1]),
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'chat' && pathSegments[1] === 'stream') {
      const command = routeWebCommand({
        message: body.message,
        view: body.view,
        agent: body.agent,
        agentId: body.agentId,
      });
      if (await streamRailwayRelayChat({ res, body, command, env, gatewayState, gatewayStore, relay })) {
        return;
      }
      if (await streamHermesApiServerChat({ res, body, command, env, fetchImpl, gatewayState, gatewayStore })) {
        return;
      }
      await fallbackChatStream({ res, body, env, fetchImpl, gatewayState, gatewayStore });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'chat' && pathSegments[1] === 'messages') {
      fallbackChatMessages({
        res,
        gatewayState,
        gatewayStore,
        limit: requestUrl.searchParams.get('limit') || 80,
      });
      return;
    }
    if (pathSegments[0] === 'scheduler' && pathSegments[1] === 'jobs') {
      fallbackSchedulerJobs({
        res,
        method,
        body,
        jobId: pathSegments[2] ? decodeURIComponent(pathSegments[2]) : '',
        action: pathSegments[3] || '',
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'scheduler' && pathSegments[1] === 'tick') {
      fallbackSchedulerTick({ res, gatewayState, gatewayStore });
      return;
    }
    if (pathSegments[0] === 'scheduler' && pathSegments[1] === 'daemon') {
      fallbackSchedulerDaemon({
        res,
        method,
        action: pathSegments[2] || '',
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'learning' && pathSegments[1] === 'reflect') {
      fallbackLearningReflect({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'learning' && pathSegments[1] === 'promote-skill') {
      fallbackLearningPromoteSkill({
        res,
        body,
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'runs' && pathSegments[1] && !pathSegments[2]) {
      fallbackRunDetail({
        res,
        runId: decodeURIComponent(pathSegments[1]),
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'GET' && pathSegments[0] === 'runs' && pathSegments[1] && pathSegments[2] === 'logs') {
      fallbackRunLogs({
        res,
        runId: decodeURIComponent(pathSegments[1]),
        gatewayState,
        gatewayStore,
      });
      return;
    }
    if (method === 'POST' && pathSegments[0] === 'runs' && pathSegments[1] && ['stop', 'retry', 'approve'].includes(pathSegments[2])) {
      fallbackRunAction({
        res,
        action: pathSegments[2],
        runId: decodeURIComponent(pathSegments[1]),
        gatewayState,
        gatewayStore,
      });
      return;
    }
    const runVisualBrief = pathSegments[0] === 'runs' && pathSegments[1] && pathSegments[2] === 'visual-brief';
    if (runVisualBrief && (method === 'GET' || method === 'POST')) {
      fallbackVisualBrief({
        res,
        runId: decodeURIComponent(pathSegments[1]),
        action: pathSegments[3],
        gatewayState,
        gatewayStore,
      });
      return;
    }
  }
  if (method === 'POST' && pathSegments[0] === 'chat' && pathSegments[1] === 'stream' && runtimeResponse.ok) {
    const body = parseJsonBuffer(bodyBuffer);
    if (body && typeof body.message === 'string' && body.message.trim()) {
      addGatewayChatMessage(gatewayState, {
        role: 'user',
        text: body.message.trim(),
        source: 'chat',
      });
    }
  }
  if (method === 'GET' && pathSegments[0] === 'state' && runtimeResponse.ok) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      fallbackHealth(res, runtimeResponse, env, new Error(`Invalid runtime state JSON: ${error.message}`));
      return;
    }
    await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
    sendJson(res, runtimeResponse.status, mergeGatewayLiveState(body, gatewayState, env, gatewayStore));
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'tasks' && !pathSegments[1] && runtimeResponse.ok) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      sendJson(res, 502, { error: `Invalid runtime tasks JSON: ${error.message}` });
      return;
    }
    await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
    const runtimeState = body.state && typeof body.state === 'object' && !Array.isArray(body.state)
      ? body.state
      : body;
    const state = mergeGatewayLiveState(runtimeState, gatewayState, env, gatewayStore);
    sendJson(res, runtimeResponse.status, {
      ...body,
      tasks: gatewayTasksFromState(state),
      state,
      gatewayMerged: true,
    });
    return;
  }
  if (method === 'POST' && pathSegments[0] === 'mail' && pathSegments[1] === 'sync' && runtimeResponse.ok) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      sendJson(res, 502, { error: `Invalid runtime mail sync JSON: ${error.message}` });
      return;
    }
    await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
    const runtimeState = body.state && typeof body.state === 'object' && !Array.isArray(body.state)
      ? body.state
      : {};
    const state = mergeGatewayLiveState(runtimeState, gatewayState, env, gatewayStore);
    sendJson(res, runtimeResponse.status, {
      ...body,
      state,
      tasks: Array.isArray(body.tasks) && body.tasks.length ? body.tasks : gatewayTasksFromState(state),
      gatewayMerged: true,
    });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'usage' && runtimeResponse.ok) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      sendJson(res, 502, { error: `Invalid runtime usage JSON: ${error.message}` });
      return;
    }
    const now = new Date();
    const runtimeState = body.state && typeof body.state === 'object' && !Array.isArray(body.state)
      ? body.state
      : {};
    const state = mergeGatewayLiveState(runtimeState, gatewayState, env, gatewayStore);
    const usage = mergeUsageSummaries([
      body.usage,
      body.usage && Number(body.usage.totalTokens || 0) > 0 ? null : usageFromState(state, { now }),
      body.usage && Number(body.usage.totalTokens || 0) > 0 ? null : readExternalUsageSources({ env, now }),
    ], { now });
    sendJson(res, runtimeResponse.status, {
      ...body,
      usage,
      state,
      gatewayMerged: true,
    });
    return;
  }
  if (method === 'GET' && pathSegments[0] === 'tools' && runtimeResponse.ok) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      sendJson(res, 502, { error: `Invalid runtime tools JSON: ${error.message}` });
      return;
    }
    sendJson(res, runtimeResponse.status, mergeGatewayResponseBody(body, gatewayState, env, gatewayStore));
    return;
  }
  if (
    runtimeResponse.ok
    && /application\/json/i.test(runtimeResponse.headers.get('content-type') || '')
  ) {
    const text = await runtimeResponse.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      sendJson(res, 502, { error: `Invalid runtime JSON: ${error.message}` });
      return;
    }
    const shouldMergeGatewayBody = body
      && typeof body === 'object'
      && !Array.isArray(body)
      && (
        (body.state && typeof body.state === 'object' && !Array.isArray(body.state))
        || Array.isArray(body.agents)
        || (body.data && typeof body.data === 'object' && !Array.isArray(body.data) && Array.isArray(body.data.agents))
      );
    if (shouldMergeGatewayBody) {
      await ensureGatewayTickTickSnapshot({ gatewayState, gatewayStore, env, fetchImpl });
      sendJson(res, runtimeResponse.status, mergeGatewayResponseBody(body, gatewayState, env, gatewayStore));
      return;
    }
    sendJson(res, runtimeResponse.status, body);
    return;
  }
  if (
    runtimeResponse.ok
    && method === 'POST'
    && pathSegments[0] === 'chat'
    && pathSegments[1] === 'stream'
    && String(requestBody.view || '') === 'inbox'
    && gatewayStore
    && typeof gatewayStore.addChatMessage === 'function'
  ) {
    gatewayStore.addChatMessage({
      role: 'user',
      text: requestBody.message || '',
      source: 'chat',
    });
  }
  await pipeRuntimeResponse(runtimeResponse, res);
}

function createRailwayGatewayServer({ env = process.env, fetchImpl = fetch, gatewayStore: injectedGatewayStore = null } = {}) {
  const gatewayState = createGatewayState();
  const relay = new HermesRailwayRelay();
  const gatewayStore = injectedGatewayStore || (env.DATABASE_URL
    ? createStore({
      env,
      dataDir: path.join(ROOT_DIR, 'work', 'hermes-gateway-data'),
    })
    : null);
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && requestUrl.pathname === '/ticktick/callback') {
        const tokens = await exchangeTickTickCode({
          clientId: env.HERMES_TICKTICK_CLIENT_ID,
          clientSecret: env.HERMES_TICKTICK_CLIENT_SECRET,
          redirectUri: tickTickCallbackRedirectUri({ requestUrl, env }),
          code: requestUrl.searchParams.get('code'),
          fetchImpl,
        });
        env.HERMES_TICKTICK_ACCESS_TOKEN = tokens.accessToken || env.HERMES_TICKTICK_ACCESS_TOKEN || '';
        if (tokens.refreshToken) env.HERMES_TICKTICK_REFRESH_TOKEN = tokens.refreshToken;
        sendText(res, 200, '<html><body><h1>TickTick connected</h1><p>Access token saved server-side for this Agent Calendar gateway process. Persist it in Railway Variables for restarts.</p></body></html>', 'text/html; charset=utf-8');
        return;
      }
      if (requestUrl.pathname.startsWith('/api/')) {
        await waitForStoreReady(gatewayStore);
        await handleApi(req, res, requestUrl, env, fetchImpl, gatewayState, gatewayStore, relay);
        return;
      }
      sendJson(res, 404, {
        ok: false,
        error: 'Agent Calendar backend only serves API routes. Use the desktop app for the frontend.',
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message,
      });
    }
  });
}

if (require.main === module) {
  const server = createRailwayGatewayServer();
  server.listen(PORT, () => {
    process.stdout.write(`Agent Calendar Railway gateway listening on ${PORT}\n`);
  });
}

module.exports = {
  createRailwayGatewayServer,
  normalizeLiveAgentSkillOrigins,
};
