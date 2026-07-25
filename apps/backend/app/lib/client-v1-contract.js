'use strict';

const {
  listProductionRoutes,
  matchProductionRoute,
} = require('./production-route-registry');

const CLIENT_V1_CONTRACT_ID = 'client-v1';
const CLIENT_V1_MEDIA_TYPE = 'application/vnd.agent-calendar.client-v1+json';
const CLIENT_V1_RESPONSE_HEADER = 'x-agent-calendar-contract';
const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id';
const CLIENT_IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const CLIENT_V1_DISCOVERY_PATH = '/api/contracts/client-v1';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function operation(
  id,
  method,
  pathPattern,
  action,
  routeClass,
  persistence,
  idempotent,
  role,
) {
  const mutating = ['write', 'stream'].includes(persistence) && method !== 'GET';
  return {
    id,
    method,
    pathPattern,
    action,
    class: routeClass,
    persistence,
    idempotent,
    role,
    requestShape: mutating ? `${id}.request` : null,
    responseShape: `${id}.response`,
    idempotencyKey: mutating ? (idempotent ? 'required' : 'not-supported') : 'none',
  };
}

function family(id, operations) {
  return { id, operations };
}

const clientV1ContractManifest = deepFreeze({
  contractId: CLIENT_V1_CONTRACT_ID,
  schemaVersion: 1,
  audiences: ['desktop', 'mobile'],
  discovery: {
    method: 'GET',
    path: CLIENT_V1_DISCOVERY_PATH,
    mediaType: CLIENT_V1_MEDIA_TYPE,
    responseHeader: CLIENT_V1_RESPONSE_HEADER,
  },
  compatibility: {
    withinMajor: 'additive-only',
    breakingChange: 'new-major-contract',
    unversionedClients: 'supported-during-explicit-removal-window',
  },
  requestIdentity: {
    requestIdHeader: CLIENT_REQUEST_ID_HEADER,
    idempotencyKeyHeader: CLIENT_IDEMPOTENCY_KEY_HEADER,
    mutationPolicy: 'required-for-idempotent-mutations',
  },
  streams: {
    agentWork: {
      contentType: 'text/event-stream',
      events: ['accepted', 'delta', 'checkpoint', 'error', 'done'],
    },
    notifications: {
      contentType: 'text/event-stream',
      events: ['message'],
    },
  },
  families: [
    family('identity', [
      operation('identity.desktop-login-start', 'POST', '/api/phase1/auth/desktop/start', 'desktop_login_start', 'auth_public', 'write', false, 'anonymous'),
      operation('identity.desktop-login-complete', 'POST', '/api/phase1/auth/desktop/complete', 'desktop_login_complete', 'auth_public', 'write', false, 'anonymous'),
      operation('identity.workspace-select', 'POST', '/api/phase1/auth/desktop/select-workspace', 'desktop_select_workspace', 'auth_session', 'write', false, 'session'),
      operation('identity.session-refresh', 'POST', '/api/phase1/auth/refresh', 'session_refresh', 'auth_session', 'write', false, 'none'),
      operation('identity.session-logout', 'POST', '/api/phase1/auth/logout', 'session_logout', 'auth_session', 'write', false, 'session'),
    ]),
    family('unified-calendar', [
      operation('calendar.events-list', 'GET', '/api/calendar/events', 'calendar_list', 'scoped_product', 'read', true, 'member'),
      operation('calendar.event-create', 'POST', '/api/calendar/events', 'calendar_create', 'scoped_product', 'write', true, 'member'),
      operation('calendar.event-update', 'PATCH', '/api/calendar/events/:id', 'calendar_update', 'scoped_product', 'write', true, 'member'),
      operation('calendar.event-delete', 'DELETE', '/api/calendar/events/:id', 'calendar_delete', 'scoped_product', 'write', true, 'member'),
      operation('calendar.schedule-ingest', 'POST', '/api/assistant/ingest', 'assistant_ingest_scoped', 'scoped_product', 'read', false, 'member'),
      operation('calendar.unified-range', 'GET', '/api/calendar/unified', 'calendar_unified_range', 'scoped_product', 'read', true, 'member'),
      operation('calendar.sources-list', 'GET', '/api/calendar/sources', 'calendar_sources_list', 'scoped_product', 'read', true, 'member'),
      operation('calendar.google-authorize', 'POST', '/api/calendar/sources/google/authorize', 'calendar_google_authorize', 'scoped_product', 'write', false, 'owner'),
      operation('calendar.google-callback', 'POST', '/api/calendar/sources/google/callback', 'calendar_google_callback', 'scoped_product', 'write', true, 'owner'),
      operation('calendar.source-sync', 'POST', '/api/calendar/sources/:id/sync', 'calendar_source_sync', 'scoped_product', 'write', true, 'member'),
      operation('calendar.source-disconnect', 'POST', '/api/calendar/sources/:id/disconnect', 'calendar_source_disconnect', 'scoped_product', 'write', true, 'owner'),
      operation('calendar.external-create', 'POST', '/api/calendar/external/events', 'calendar_external_create', 'scoped_product', 'write', true, 'member'),
      operation('calendar.external-update', 'PATCH', '/api/calendar/external/events/:providerEventId', 'calendar_external_update', 'scoped_product', 'write', true, 'member'),
      operation('calendar.external-delete', 'DELETE', '/api/calendar/external/events/:providerEventId', 'calendar_external_delete', 'scoped_product', 'write', true, 'member'),
    ]),
    family('calendar-ai', [
      operation('calendar-ai.conversations-list', 'GET', '/api/calendar-ai/conversations', 'calendar_ai_conversations_list', 'scoped_product', 'read', true, 'member'),
      operation('calendar-ai.conversation-create', 'POST', '/api/calendar-ai/conversations', 'calendar_ai_conversation_create', 'scoped_product', 'write', true, 'member'),
      operation('calendar-ai.conversation-get', 'GET', '/api/calendar-ai/conversations/:id', 'calendar_ai_conversation_get', 'scoped_product', 'read', true, 'member'),
      operation('calendar-ai.turn-create', 'POST', '/api/calendar-ai/conversations/:id/turns', 'calendar_ai_turn_create', 'scoped_product', 'write', true, 'member'),
      operation('calendar-ai.memories-list', 'GET', '/api/calendar-ai/memories', 'calendar_ai_memories_list', 'scoped_product', 'read', true, 'member'),
      operation('calendar-ai.memory-update', 'PATCH', '/api/calendar-ai/memories/:id', 'calendar_ai_memory_update', 'scoped_product', 'write', true, 'member'),
      operation('calendar-ai.memory-forget', 'DELETE', '/api/calendar-ai/memories/:id', 'calendar_ai_memory_forget', 'scoped_product', 'write', true, 'member'),
      operation('calendar-ai.memory-purge', 'DELETE', '/api/calendar-ai/memories/:id/purge', 'calendar_ai_memory_purge', 'scoped_product', 'write', true, 'owner'),
      operation('calendar-ai.action-approve', 'POST', '/api/calendar-ai/actions/:id/approve', 'calendar_ai_action_approve', 'scoped_product', 'write', true, 'member'),
      operation('calendar-ai.action-revise', 'POST', '/api/calendar-ai/actions/:id/revise', 'calendar_ai_action_revise', 'scoped_product', 'write', true, 'member'),
      operation('calendar-ai.action-cancel', 'POST', '/api/calendar-ai/actions/:id/cancel', 'calendar_ai_action_cancel', 'scoped_product', 'write', true, 'member'),
    ]),
    family('agent-work', [
      operation('agent-work.snapshot', 'GET', '/api/agent-operations', 'agent_ops_snapshot', 'scoped_product', 'read', true, 'member'),
      operation('agent-work.create', 'POST', '/api/agent-operations/work', 'agent_work_create_deferred', 'scoped_product', 'write', true, 'member'),
      operation('agent-work.conversation', 'GET', '/api/agent-operations/work/:missionId/conversation', 'agent_work_conversation', 'scoped_product', 'read', true, 'member'),
      operation('agent-work.message', 'POST', '/api/agent-operations/work/:missionId/messages', 'agent_work_message', 'scoped_product', 'write', true, 'member'),
      operation('agent-work.live', 'POST', '/api/agent-operations/work/:missionId/live', 'agent_work_live_deferred', 'scoped_product', 'stream', true, 'member'),
      operation('agent-work.pause', 'POST', '/api/agent-operations/missions/:id/pause', 'missions_pause', 'scoped_product', 'write', true, 'owner'),
      operation('agent-work.cancel', 'POST', '/api/agent-operations/missions/:id/cancel', 'missions_cancel', 'scoped_product', 'write', true, 'owner'),
      operation('agent-work.task-transition', 'POST', '/api/agent-operations/tasks/:id/:action', 'agent_task_transition', 'scoped_product', 'write', true, 'owner'),
      operation('agent-work.session-get', 'GET', '/api/agent-operations/sessions/:id', 'agent_session_get', 'scoped_product', 'read', true, 'member'),
      operation('agent-work.session-message', 'POST', '/api/agent-operations/sessions/:id/messages', 'agent_session_message', 'scoped_product', 'write', true, 'member'),
    ]),
    family('runner-control', [
      operation('runner-control.list', 'GET', '/api/runners', 'runners_list', 'scoped_product', 'read', true, 'member'),
      operation('runner-control.release-manifest', 'GET', '/api/runners/release-manifest', 'runners_release_manifest', 'scoped_product', 'read', true, 'member'),
      operation('runner-control.enrollment-start', 'POST', '/api/runners/enrollments', 'runners_enrollment_start', 'scoped_product', 'write', true, 'owner'),
      operation('runner-control.enrollment-get', 'GET', '/api/runners/enrollments/:id', 'runners_enrollment_get', 'scoped_product', 'read', true, 'owner'),
      operation('runner-control.enrollment-confirm', 'POST', '/api/runners/enrollments/:id/confirm', 'runners_enrollment_confirm', 'scoped_product', 'write', true, 'owner'),
      operation('runner-control.enrollment-reject', 'POST', '/api/runners/enrollments/:id/reject', 'runners_enrollment_reject', 'scoped_product', 'write', true, 'owner'),
      operation('runner-control.test', 'POST', '/api/runners/:id/test', 'runners_test', 'scoped_product', 'write', true, 'owner'),
      operation('runner-control.revoke', 'POST', '/api/runners/:id/revoke', 'runners_revoke', 'scoped_product', 'write', true, 'owner'),
    ]),
    family('automation', [
      operation('automation.sources-list', 'GET', '/api/automation/sources', 'automation_sources_list', 'scoped_product', 'read', true, 'member'),
      operation('automation.source-connect', 'POST', '/api/automation/sources', 'automation_sources_connect', 'scoped_product', 'write', true, 'owner'),
      operation('automation.source-sync', 'POST', '/api/automation/sources/:id/sync', 'automation_sources_sync', 'scoped_product', 'write', true, 'owner'),
      operation('automation.list', 'GET', '/api/automation/automations', 'automation_list', 'scoped_product', 'read', true, 'member'),
      operation('automation.occurrences-list', 'GET', '/api/automation/occurrences', 'automation_occurrences_list', 'scoped_product', 'read', true, 'member'),
      operation('automation.change-create', 'POST', '/api/automation/changes', 'automation_change_create', 'scoped_product', 'write', true, 'owner'),
      operation('automation.change-approve', 'POST', '/api/automation/changes/:id/approve', 'automation_change_approve', 'scoped_product', 'write', true, 'owner'),
    ]),
    family('knowledge', [
      operation('knowledge.sources-list', 'GET', '/api/knowledge/sources', 'knowledge_sources_list', 'scoped_product', 'read', true, 'member'),
      operation('knowledge.source-create', 'POST', '/api/knowledge/sources', 'knowledge_sources_create', 'scoped_product', 'write', true, 'member'),
      operation('knowledge.source-revoke', 'POST', '/api/knowledge/sources/:id/revoke', 'knowledge_source_revoke', 'scoped_product', 'write', true, 'owner'),
      operation('knowledge.ingest', 'POST', '/api/knowledge/ingest', 'knowledge_ingest_cloud', 'scoped_product', 'write', true, 'member'),
      operation('knowledge.private-local-register', 'POST', '/api/knowledge/private-local/register', 'knowledge_private_local_register', 'scoped_product', 'write', true, 'member'),
      operation('knowledge.search', 'POST', '/api/knowledge/search', 'knowledge_search', 'scoped_product', 'read', true, 'member'),
      operation('knowledge.ask', 'POST', '/api/knowledge/ask', 'knowledge_ask', 'scoped_product', 'write', true, 'member'),
      operation('knowledge.evidence-resolve', 'GET', '/api/knowledge/evidence/:handle', 'knowledge_evidence_resolve', 'scoped_product', 'read', true, 'member'),
      operation('knowledge.search-job', 'GET', '/api/knowledge/search/jobs/:id', 'knowledge_search_job', 'scoped_product', 'read', true, 'member'),
    ]),
    family('notifications', [
      operation('notifications.events', 'GET', '/api/events', 'events_sse', 'scoped_product', 'stream', true, 'member'),
    ]),
  ],
});

function routeKey(route) {
  return `${String(route.method || '').toUpperCase()} ${String(route.pathPattern || '')}`;
}

function assertClientV1Contract(routes = listProductionRoutes()) {
  const routeIndex = new Map();
  for (const route of routes) {
    const key = routeKey(route);
    const matches = routeIndex.get(key) || [];
    matches.push(route);
    routeIndex.set(key, matches);
  }

  const discoveryMatches = routeIndex.get(`GET ${CLIENT_V1_DISCOVERY_PATH}`) || [];
  if (discoveryMatches.length !== 1 || discoveryMatches[0].action !== 'client_v1_contract') {
    throw new Error('client_v1_route_missing:contract-discovery');
  }

  const operationIds = new Set();
  for (const familyEntry of clientV1ContractManifest.families) {
    for (const expected of familyEntry.operations) {
      if (operationIds.has(expected.id)) {
        throw new Error(`client_v1_operation_duplicate:${expected.id}`);
      }
      operationIds.add(expected.id);
      const matches = routeIndex.get(routeKey(expected)) || [];
      if (matches.length !== 1) {
        throw new Error(`client_v1_route_missing:${expected.id}`);
      }
      const actual = matches[0];
      for (const field of ['action', 'class', 'persistence', 'idempotent', 'role']) {
        if (actual[field] !== expected[field]) {
          throw new Error(
            `client_v1_route_drift:${expected.id}:${field}:${String(actual[field])}`,
          );
        }
      }
      if (
        ['write', 'stream'].includes(expected.persistence)
        && expected.method !== 'GET'
        && expected.idempotent
        && expected.idempotencyKey !== 'required'
      ) {
        throw new Error(`client_v1_idempotency_policy_missing:${expected.id}`);
      }
    }
  }

  return deepFreeze({
    ok: true,
    contractId: CLIENT_V1_CONTRACT_ID,
    operationCount: operationIds.size,
  });
}

function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === expected) {
      return String(Array.isArray(value) ? value[0] : value || '').trim();
    }
  }
  return '';
}

function negotiateClientContract(headers = {}) {
  const requestedHeader = readHeader(headers, CLIENT_V1_RESPONSE_HEADER).toLowerCase();
  if (requestedHeader) {
    return {
      requested: true,
      supported: requestedHeader === CLIENT_V1_CONTRACT_ID,
      contractId: requestedHeader,
    };
  }

  const mediaTypes = readHeader(headers, 'accept')
    .split(',')
    .map((value) => value.split(';')[0].trim().toLowerCase())
    .filter(Boolean);
  const requestedContracts = mediaTypes
    .map((mediaType) => (
      /^application\/vnd\.agent-calendar\.([a-z0-9.-]+)\+json$/.exec(mediaType)
    ))
    .filter(Boolean)
    .map((match) => match[1]);

  if (!requestedContracts.length) {
    return { requested: false, supported: true, contractId: null };
  }
  if (requestedContracts.includes(CLIENT_V1_CONTRACT_ID)) {
    return {
      requested: true,
      supported: true,
      contractId: CLIENT_V1_CONTRACT_ID,
    };
  }
  return {
    requested: true,
    supported: false,
    contractId: requestedContracts[0],
  };
}

function validateClientV1Request({
  method = 'GET',
  pathname = '',
  headers = {},
} = {}) {
  const negotiation = negotiateClientContract(headers);
  if (!negotiation.supported) {
    return {
      ok: false,
      status: 406,
      error: 'client_contract_not_acceptable',
      contractId: negotiation.contractId,
    };
  }
  if (!negotiation.requested) {
    return { ok: true, status: 200, contractId: null };
  }

  const matched = matchProductionRoute(method, pathname);
  const expected = matched
    ? clientV1ContractManifest.families
      .flatMap((familyEntry) => familyEntry.operations)
      .find((entry) => (
        entry.method === matched.route.method
        && entry.pathPattern === matched.route.pathPattern
      ))
    : null;
  if (
    expected
    && expected.idempotencyKey === 'required'
    && !readHeader(headers, CLIENT_IDEMPOTENCY_KEY_HEADER)
  ) {
    return {
      ok: false,
      status: 400,
      error: 'client_idempotency_key_required',
      contractId: CLIENT_V1_CONTRACT_ID,
    };
  }
  return {
    ok: true,
    status: 200,
    contractId: CLIENT_V1_CONTRACT_ID,
  };
}

function applyClientV1ResponseHeaders(res) {
  res.setHeader(CLIENT_V1_RESPONSE_HEADER, CLIENT_V1_CONTRACT_ID);
  const existing = String(res.getHeader('vary') || '');
  const values = existing
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of ['Accept', CLIENT_V1_RESPONSE_HEADER]) {
    if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
      values.push(value);
    }
  }
  res.setHeader('vary', values.join(', '));
}

module.exports = {
  CLIENT_IDEMPOTENCY_KEY_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_V1_CONTRACT_ID,
  CLIENT_V1_DISCOVERY_PATH,
  CLIENT_V1_MEDIA_TYPE,
  CLIENT_V1_RESPONSE_HEADER,
  applyClientV1ResponseHeaders,
  assertClientV1Contract,
  clientV1ContractManifest,
  negotiateClientContract,
  validateClientV1Request,
};
