'use strict';

/**
 * Machine-checkable production API route inventory.
 * Source of truth for WORKSPACE_AUTH_MODE=production dispatch classification.
 *
 * Classes:
 * - public_infra: no product tenant data
 * - auth_public: AuthKit start/complete (no session)
 * - auth_session: refresh/logout/select/trusted session issue
 * - scoped_product: requires app access token → WorkspaceScope + RLS
 * - operations_private: separate operator bearer; never a user/Workspace session
 * - provider_webhook: provider signature path (not user product auth)
 * - runner_device: device-authenticated Runner protocol (no user session)
 * - production_disabled: explicit fail-closed contract (no legacy fallthrough)
 * - legacy_only: reachable only when WORKSPACE_AUTH_MODE=legacy
 */

/** @typedef {'public_infra'|'operations_private'|'auth_public'|'auth_session'|'scoped_product'|'provider_webhook'|'runner_device'|'production_disabled'|'legacy_only'} RouteClass */
/** @typedef {'none'|'read'|'write'|'stream'|'auth'|'webhook'} PersistenceKind */
/** @typedef {'anonymous'|'session'|'owner'|'member'|'provider'|'none'} RoleRequirement */

/**
 * @typedef {object} ProductionRoute
 * @property {string} method
 * @property {string} pathPattern  // /api/... with :param segments
 * @property {RouteClass} class
 * @property {PersistenceKind} persistence
 * @property {string} action
 * @property {boolean} idempotent
 * @property {RoleRequirement} role
 * @property {string} [notes]
 */

/** @type {ProductionRoute[]} */
const PRODUCTION_ROUTES = [
  // Public infrastructure
  {
    method: 'GET', pathPattern: '/api/health', class: 'public_infra',
    persistence: 'none', action: 'health', idempotent: true, role: 'anonymous',
  },
  {
    method: 'GET', pathPattern: '/api/gateway-status', class: 'public_infra',
    persistence: 'none', action: 'gateway_status', idempotent: true, role: 'anonymous',
    notes: 'Infra-only; must not leak tenant/global product rows',
  },
  {
    method: 'GET', pathPattern: '/api/contracts/client-v1', class: 'public_infra',
    persistence: 'none', action: 'client_v1_contract', idempotent: true, role: 'anonymous',
    notes: 'Tenant-free Desktop/Mobile contract discovery',
  },
  {
    method: 'GET', pathPattern: '/api/ready', class: 'public_infra',
    persistence: 'none', action: 'readiness', idempotent: true, role: 'anonymous',
    notes: 'Public boolean readiness only; component detail remains operator-private',
  },
  {
    method: 'GET', pathPattern: '/api/operations/status', class: 'operations_private',
    persistence: 'none', action: 'operations_status', idempotent: true, role: 'none',
    notes: 'Separate AGENT_CALENDAR_OPERATIONS_TOKEN; no Workspace or user identity',
  },

  // Auth — public Desktop AuthKit
  {
    method: 'POST', pathPattern: '/api/phase1/auth/desktop/start', class: 'auth_public',
    persistence: 'write', action: 'desktop_login_start', idempotent: false, role: 'anonymous',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/auth/desktop/complete', class: 'auth_public',
    persistence: 'write', action: 'desktop_login_complete', idempotent: false, role: 'anonymous',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/auth/desktop/select-workspace', class: 'auth_session',
    persistence: 'write', action: 'desktop_select_workspace', idempotent: false, role: 'session',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/auth/session', class: 'auth_session',
    persistence: 'write', action: 'session_issue_trusted', idempotent: false, role: 'none',
    notes: 'Trusted identityVerifier only; not Desktop public login',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/auth/refresh', class: 'auth_session',
    persistence: 'write', action: 'session_refresh', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/auth/logout', class: 'auth_session',
    persistence: 'write', action: 'session_logout', idempotent: false, role: 'session',
  },

  // Phase 1 product aliases (scoped)
  {
    method: 'GET', pathPattern: '/api/phase1/tasks', class: 'scoped_product',
    persistence: 'read', action: 'tasks_list', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/phase1/tasks/:id', class: 'scoped_product',
    persistence: 'read', action: 'tasks_get', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/phase1/calendar-events', class: 'scoped_product',
    persistence: 'read', action: 'calendar_list', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/phase1/calendar-events/:id', class: 'scoped_product',
    persistence: 'read', action: 'calendar_get', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/phase1/wiki/search', class: 'scoped_product',
    persistence: 'read', action: 'wiki_search', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/phase1/agent-work/:sessionId/events', class: 'scoped_product',
    persistence: 'read', action: 'agent_work_events', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/phase1/agent-work/:sessionId/stream', class: 'scoped_product',
    persistence: 'stream', action: 'agent_work_stream', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/agent-work/:sessionId/publish', class: 'production_disabled',
    persistence: 'write', action: 'agent_work_publish_forbidden', idempotent: false, role: 'none',
    notes: 'Never public; 404',
  },
  {
    method: 'POST', pathPattern: '/api/phase1/schedule/embed-probe', class: 'production_disabled',
    persistence: 'none', action: 'embed_probe_removed', idempotent: false, role: 'none',
  },

  // Desktop product surfaces — scoped
  {
    method: 'GET', pathPattern: '/api/state', class: 'scoped_product',
    persistence: 'read', action: 'state_aggregate', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/tasks', class: 'scoped_product',
    persistence: 'read', action: 'tasks_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/tasks', class: 'scoped_product',
    persistence: 'write', action: 'tasks_create', idempotent: true, role: 'member',
  },
  {
    method: 'PATCH', pathPattern: '/api/tasks/:id', class: 'scoped_product',
    persistence: 'write', action: 'tasks_update', idempotent: true, role: 'member',
  },
  {
    method: 'DELETE', pathPattern: '/api/tasks/:id', class: 'scoped_product',
    persistence: 'write', action: 'tasks_delete', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/tasks/share-draft', class: 'production_disabled',
    persistence: 'none', action: 'tasks_share_draft_disabled', idempotent: false, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/calendar/events', class: 'scoped_product',
    persistence: 'read', action: 'calendar_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/events', class: 'scoped_product',
    persistence: 'write', action: 'calendar_create', idempotent: true, role: 'member',
  },
  {
    method: 'PATCH', pathPattern: '/api/calendar/events/:id', class: 'scoped_product',
    persistence: 'write', action: 'calendar_update', idempotent: true, role: 'member',
  },
  {
    method: 'DELETE', pathPattern: '/api/calendar/events/:id', class: 'scoped_product',
    persistence: 'write', action: 'calendar_delete', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/draft', class: 'production_disabled',
    persistence: 'none', action: 'calendar_draft_disabled', idempotent: false, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/quick-add', class: 'scoped_product',
    persistence: 'write', action: 'calendar_quick_add', idempotent: true, role: 'member',
  },
  // Phase 4 Unified Calendar
  {
    method: 'GET', pathPattern: '/api/calendar/unified', class: 'scoped_product',
    persistence: 'read', action: 'calendar_unified_range', idempotent: true, role: 'member',
    notes: 'Exact range query with coverage statements',
  },
  {
    method: 'GET', pathPattern: '/api/calendar/sources', class: 'scoped_product',
    persistence: 'read', action: 'calendar_sources_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/sources/google/authorize', class: 'scoped_product',
    persistence: 'write', action: 'calendar_google_authorize', idempotent: false, role: 'owner',
    notes: 'Workspace-scoped Google OAuth start (not WorkOS)',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/sources/google/callback', class: 'scoped_product',
    persistence: 'write', action: 'calendar_google_callback', idempotent: true, role: 'owner',
    notes: 'Workspace-scoped Google OAuth finalize; session workspace is authority',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/sources/:id/sync', class: 'scoped_product',
    persistence: 'write', action: 'calendar_source_sync', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/sources/:id/disconnect', class: 'scoped_product',
    persistence: 'write', action: 'calendar_source_disconnect', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/sources/:id/watch', class: 'scoped_product',
    persistence: 'write', action: 'calendar_source_watch', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/calendar/external/events', class: 'scoped_product',
    persistence: 'write', action: 'calendar_external_create', idempotent: true, role: 'member',
  },
  {
    method: 'PATCH', pathPattern: '/api/calendar/external/events/:providerEventId', class: 'scoped_product',
    persistence: 'write', action: 'calendar_external_update', idempotent: true, role: 'member',
  },
  {
    method: 'DELETE', pathPattern: '/api/calendar/external/events/:providerEventId', class: 'scoped_product',
    persistence: 'write', action: 'calendar_external_delete', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/hooks/google-calendar', class: 'provider_webhook',
    persistence: 'write', action: 'calendar_google_webhook', idempotent: true, role: 'provider',
    notes: 'Channel id + token digest authority; never body workspace',
  },
  {
    method: 'GET', pathPattern: '/api/agents', class: 'scoped_product',
    persistence: 'read', action: 'agents_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agents', class: 'scoped_product',
    persistence: 'write', action: 'agents_create', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agents/catalog/requests', class: 'scoped_product',
    persistence: 'write', action: 'agent_catalog_request', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/agents/catalog/requests/:id', class: 'scoped_product',
    persistence: 'read', action: 'agent_catalog_request_get', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agents/catalog/requests/:id/import', class: 'scoped_product',
    persistence: 'write', action: 'agent_catalog_import', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agents/:id/sessions/catalog/requests', class: 'scoped_product',
    persistence: 'write', action: 'provider_agent_session_catalog_request', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agents/:id/sessions/catalog/requests/:requestId/import', class: 'scoped_product',
    persistence: 'write', action: 'provider_agent_session_catalog_import', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/agents/:id/sessions', class: 'scoped_product',
    persistence: 'read', action: 'provider_agent_sessions_list', idempotent: true, role: 'member',
  },
  {
    method: 'PATCH', pathPattern: '/api/agent-sessions/:id', class: 'scoped_product',
    persistence: 'write', action: 'provider_agent_session_update', idempotent: true, role: 'member',
  },
  {
    method: 'PATCH', pathPattern: '/api/agents/:id', class: 'scoped_product',
    persistence: 'write', action: 'agents_update', idempotent: true, role: 'owner',
  },
  {
    method: 'DELETE', pathPattern: '/api/agents/:id', class: 'scoped_product',
    persistence: 'write', action: 'agents_delete', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agents/:id/restore', class: 'scoped_product',
    persistence: 'write', action: 'agents_restore', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/documents', class: 'scoped_product',
    persistence: 'read', action: 'documents_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/documents', class: 'scoped_product',
    persistence: 'write', action: 'documents_create', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/wiki', class: 'scoped_product',
    persistence: 'read', action: 'wiki_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/wiki/search', class: 'scoped_product',
    persistence: 'read', action: 'wiki_search', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/wiki/ask', class: 'scoped_product',
    persistence: 'write', action: 'wiki_ask_scoped', idempotent: true, role: 'member',
    notes: 'Knowledge v2 ask when enabled; legacy wiki keyword when KNOWLEDGE_V2_ENABLED=0',
  },
  // Phase 5 Knowledge v2
  {
    method: 'GET', pathPattern: '/api/knowledge/sources', class: 'scoped_product',
    persistence: 'read', action: 'knowledge_sources_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/knowledge/sources', class: 'scoped_product',
    persistence: 'write', action: 'knowledge_sources_create', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/knowledge/sources/:id/revoke', class: 'scoped_product',
    persistence: 'write', action: 'knowledge_source_revoke', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/knowledge/ingest', class: 'scoped_product',
    persistence: 'write', action: 'knowledge_ingest_cloud', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/knowledge/private-local/register', class: 'scoped_product',
    persistence: 'write', action: 'knowledge_private_local_register', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/knowledge/search', class: 'scoped_product',
    persistence: 'read', action: 'knowledge_search', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/knowledge/ask', class: 'scoped_product',
    persistence: 'write', action: 'knowledge_ask', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/knowledge/evidence/:handle', class: 'scoped_product',
    persistence: 'read', action: 'knowledge_evidence_resolve', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/knowledge/search/jobs/:id', class: 'scoped_product',
    persistence: 'read', action: 'knowledge_search_job', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/automation/sources', class: 'scoped_product',
    persistence: 'read', action: 'automation_sources_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/automation/sources', class: 'scoped_product',
    persistence: 'write', action: 'automation_sources_connect', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/automation/sources/:id/sync', class: 'scoped_product',
    persistence: 'write', action: 'automation_sources_sync', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/automation/automations', class: 'scoped_product',
    persistence: 'read', action: 'automation_list', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/automation/occurrences', class: 'scoped_product',
    persistence: 'read', action: 'automation_occurrences_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/automation/changes', class: 'scoped_product',
    persistence: 'write', action: 'automation_change_create', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/automation/changes/:id/approve', class: 'scoped_product',
    persistence: 'write', action: 'automation_change_approve', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/scheduler/jobs', class: 'scoped_product',
    persistence: 'read', action: 'scheduler_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/scheduler/jobs', class: 'scoped_product',
    persistence: 'write', action: 'scheduler_create', idempotent: true, role: 'owner',
  },
  {
    method: 'PATCH', pathPattern: '/api/scheduler/jobs/:id', class: 'scoped_product',
    persistence: 'write', action: 'scheduler_update', idempotent: true, role: 'owner',
  },
  {
    method: 'DELETE', pathPattern: '/api/scheduler/jobs/:id', class: 'scoped_product',
    persistence: 'write', action: 'scheduler_delete', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/scheduler/jobs/:id/run', class: 'scoped_product',
    persistence: 'write', action: 'scheduler_run_deferred', idempotent: true, role: 'owner',
    notes: 'Marks occurrence deferred/runner_required; no external side effect',
  },
  {
    method: 'POST', pathPattern: '/api/scheduler/tick', class: 'production_disabled',
    persistence: 'none', action: 'scheduler_tick_disabled', idempotent: false, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/settings', class: 'scoped_product',
    persistence: 'read', action: 'settings_get', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/settings', class: 'scoped_product',
    persistence: 'write', action: 'settings_save', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/chat/messages', class: 'scoped_product',
    persistence: 'read', action: 'chat_messages_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/chat/stream', class: 'scoped_product',
    persistence: 'stream', action: 'chat_stream_scoped', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/assistant/ask', class: 'scoped_product',
    persistence: 'write', action: 'assistant_ask_scoped', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/assistant/ingest', class: 'scoped_product',
    persistence: 'read', action: 'assistant_ingest_scoped', idempotent: false, role: 'member',
    notes: 'Workspace-scoped review drafts only; never persists events or tasks',
  },
  {
    method: 'GET', pathPattern: '/api/calendar-ai/conversations', class: 'scoped_product',
    persistence: 'read', action: 'calendar_ai_conversations_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar-ai/conversations', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_conversation_create', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/calendar-ai/conversations/:id', class: 'scoped_product',
    persistence: 'read', action: 'calendar_ai_conversation_get', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar-ai/conversations/:id/turns', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_turn_create', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/calendar-ai/memories', class: 'scoped_product',
    persistence: 'read', action: 'calendar_ai_memories_list', idempotent: true, role: 'member',
  },
  {
    method: 'PATCH', pathPattern: '/api/calendar-ai/memories/:id', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_memory_update', idempotent: true, role: 'member',
  },
  {
    method: 'DELETE', pathPattern: '/api/calendar-ai/memories/:id', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_memory_forget', idempotent: true, role: 'member',
  },
  {
    method: 'DELETE', pathPattern: '/api/calendar-ai/memories/:id/purge', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_memory_purge', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/calendar-ai/actions/:id/approve', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_action_approve', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar-ai/actions/:id/revise', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_action_revise', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/calendar-ai/actions/:id/cancel', class: 'scoped_product',
    persistence: 'write', action: 'calendar_ai_action_cancel', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/events', class: 'scoped_product',
    persistence: 'stream', action: 'events_sse', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/usage', class: 'scoped_product',
    persistence: 'read', action: 'usage_empty', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/tools', class: 'scoped_product',
    persistence: 'read', action: 'tools_empty', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/channels/status', class: 'scoped_product',
    persistence: 'read', action: 'channels_status', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/workboard', class: 'scoped_product',
    persistence: 'read', action: 'workboard_list', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/workboard/convert', class: 'production_disabled',
    persistence: 'none', action: 'workboard_convert_disabled', idempotent: false, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/runs/:id', class: 'scoped_product',
    persistence: 'read', action: 'runs_get', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/runs', class: 'scoped_product',
    persistence: 'write', action: 'runs_create_deferred', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/runs/:id/approve', class: 'scoped_product',
    persistence: 'write', action: 'runs_approve', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/missions/launch', class: 'scoped_product',
    persistence: 'write', action: 'missions_launch_deferred', idempotent: true, role: 'member',
  },

  // Agent operations (Desktop Agent Work)
  {
    method: 'GET', pathPattern: '/api/agent-operations', class: 'scoped_product',
    persistence: 'read', action: 'agent_ops_snapshot', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/work', class: 'scoped_product',
    persistence: 'write', action: 'agent_work_create_deferred', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/agent-operations/work/:missionId/conversation', class: 'scoped_product',
    persistence: 'read', action: 'agent_work_conversation', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/work/:missionId/messages', class: 'scoped_product',
    persistence: 'write', action: 'agent_work_message', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/work/:missionId/live', class: 'scoped_product',
    persistence: 'stream', action: 'agent_work_live_deferred', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/missions', class: 'scoped_product',
    persistence: 'write', action: 'missions_create_deferred', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/missions/:id/plan', class: 'scoped_product',
    persistence: 'write', action: 'missions_plan_deferred', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/missions/:id/activate', class: 'scoped_product',
    persistence: 'write', action: 'missions_activate_deferred', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/missions/:id/pause', class: 'scoped_product',
    persistence: 'write', action: 'missions_pause', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/missions/:id/cancel', class: 'scoped_product',
    persistence: 'write', action: 'missions_cancel', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/tasks/:id/:action', class: 'scoped_product',
    persistence: 'write', action: 'agent_task_transition', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/agent-operations/sessions/:id', class: 'scoped_product',
    persistence: 'read', action: 'agent_session_get', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/sessions/:id/messages', class: 'scoped_product',
    persistence: 'write', action: 'agent_session_message', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/reports/:id/feedback', class: 'scoped_product',
    persistence: 'write', action: 'agent_report_feedback', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/reports/:id/follow-ups', class: 'scoped_product',
    persistence: 'write', action: 'agent_report_followups', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/agent-operations/tick', class: 'production_disabled',
    persistence: 'none', action: 'agent_ops_tick_disabled', idempotent: false, role: 'owner',
  },

  // Mail list is a required Desktop hydrate read — scoped empty inbox until connector cutover.
  {
    method: 'GET', pathPattern: '/api/mail/messages', class: 'scoped_product',
    persistence: 'read', action: 'mail_list', idempotent: true, role: 'member',
    notes: 'Returns workspace-empty mailbox; does not call external mail providers',
  },
  // Mail mutations / TickTick — external connectors not safely scoped yet
  {
    method: 'POST', pathPattern: '/api/mail/accounts', class: 'production_disabled',
    persistence: 'none', action: 'mail_accounts_disabled', idempotent: false, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/mail/sync', class: 'production_disabled',
    persistence: 'none', action: 'mail_sync_disabled', idempotent: false, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/mail/messages/:id/:action', class: 'production_disabled',
    persistence: 'none', action: 'mail_action_disabled', idempotent: false, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/ticktick/import', class: 'production_disabled',
    persistence: 'none', action: 'ticktick_import_disabled', idempotent: false, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/ticktick/sync', class: 'production_disabled',
    persistence: 'none', action: 'ticktick_sync_disabled', idempotent: false, role: 'owner',
  },

  // Provider webhooks
  {
    method: 'POST', pathPattern: '/api/telegram/webhook', class: 'provider_webhook',
    persistence: 'write', action: 'telegram_webhook', idempotent: true, role: 'provider',
  },

  // Relay (device bridge — separate device token; not Workspace product identity)
  {
    method: 'GET', pathPattern: '/api/relay/status', class: 'provider_webhook',
    persistence: 'read', action: 'relay_status', idempotent: true, role: 'provider',
  },
  {
    method: 'GET', pathPattern: '/api/relay/snapshot', class: 'provider_webhook',
    persistence: 'read', action: 'relay_snapshot', idempotent: true, role: 'provider',
  },
  {
    method: 'POST', pathPattern: '/api/relay/snapshot', class: 'provider_webhook',
    persistence: 'write', action: 'relay_snapshot_push', idempotent: true, role: 'provider',
  },
  {
    method: 'GET', pathPattern: '/api/relay/poll', class: 'provider_webhook',
    persistence: 'read', action: 'relay_poll', idempotent: true, role: 'provider',
  },
  {
    method: 'POST', pathPattern: '/api/relay/jobs/:id/events', class: 'provider_webhook',
    persistence: 'write', action: 'relay_job_events', idempotent: true, role: 'provider',
  },
  {
    method: 'POST', pathPattern: '/api/relay/jobs/:id/complete', class: 'provider_webhook',
    persistence: 'write', action: 'relay_job_complete', idempotent: true, role: 'provider',
  },

  // Runner user-scoped (Phase 2 account-bound enrollment)
  {
    method: 'GET', pathPattern: '/api/runners', class: 'scoped_product',
    persistence: 'read', action: 'runners_list', idempotent: true, role: 'member',
  },
  {
    method: 'GET', pathPattern: '/api/runners/release-manifest', class: 'scoped_product',
    persistence: 'read', action: 'runners_release_manifest', idempotent: true, role: 'member',
  },
  {
    method: 'POST', pathPattern: '/api/runners/enrollments', class: 'scoped_product',
    persistence: 'write', action: 'runners_enrollment_start', idempotent: true, role: 'owner',
  },
  {
    method: 'GET', pathPattern: '/api/runners/enrollments/:id', class: 'scoped_product',
    persistence: 'read', action: 'runners_enrollment_get', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/runners/enrollments/:id/confirm', class: 'scoped_product',
    persistence: 'write', action: 'runners_enrollment_confirm', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/runners/enrollments/:id/reject', class: 'scoped_product',
    persistence: 'write', action: 'runners_enrollment_reject', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/runners/:id/test', class: 'scoped_product',
    persistence: 'write', action: 'runners_test', idempotent: true, role: 'owner',
  },
  {
    method: 'POST', pathPattern: '/api/runners/:id/revoke', class: 'scoped_product',
    persistence: 'write', action: 'runners_revoke', idempotent: true, role: 'owner',
  },

  // Runner device-auth (no user session; Phase 2)
  {
    method: 'POST', pathPattern: '/api/runner/device/enroll', class: 'runner_device',
    persistence: 'write', action: 'runner_device_enroll', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/claim', class: 'runner_device',
    persistence: 'write', action: 'runner_device_claim', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/connect', class: 'runner_device',
    persistence: 'write', action: 'runner_device_connect', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/heartbeat', class: 'runner_device',
    persistence: 'write', action: 'runner_device_heartbeat', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/capabilities', class: 'runner_device',
    persistence: 'write', action: 'runner_device_capabilities', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/rotate', class: 'runner_device',
    persistence: 'write', action: 'runner_device_rotate', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/disconnect', class: 'runner_device',
    persistence: 'write', action: 'runner_device_disconnect', idempotent: false, role: 'none',
  },

  // Phase 3 durable execution device routes
  {
    method: 'POST', pathPattern: '/api/runner/device/next-offer', class: 'runner_device',
    persistence: 'write', action: 'runner_device_next_offer', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/lease', class: 'runner_device',
    persistence: 'write', action: 'runner_device_lease', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/event', class: 'runner_device',
    persistence: 'write', action: 'runner_device_event', idempotent: true, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/provider-session/bind', class: 'runner_device',
    persistence: 'write', action: 'runner_device_provider_session_bind', idempotent: true, role: 'none',
    notes: 'Persist a newly observed provider session identity before terminal completion',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/artifact', class: 'runner_device',
    persistence: 'write', action: 'runner_device_artifact', idempotent: true, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/complete', class: 'runner_device',
    persistence: 'write', action: 'runner_device_complete', idempotent: true, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/fail', class: 'runner_device',
    persistence: 'write', action: 'runner_device_fail', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/cancel-ack', class: 'runner_device',
    persistence: 'write', action: 'runner_device_cancel_ack', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/attempt-heartbeat', class: 'runner_device',
    persistence: 'write', action: 'runner_device_attempt_heartbeat', idempotent: false, role: 'none',
    notes: 'Extend attempt lease and return cancellationRequested for long-running engines',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/connectors/next', class: 'runner_device',
    persistence: 'write', action: 'runner_device_connector_next', idempotent: false, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/connectors/complete', class: 'runner_device',
    persistence: 'write', action: 'runner_device_connector_complete', idempotent: true, role: 'none',
  },
  {
    method: 'POST', pathPattern: '/api/runner/device/connectors/fail', class: 'runner_device',
    persistence: 'write', action: 'runner_device_connector_fail', idempotent: true, role: 'none',
  },

  // Legacy adapter path disabled in production (use Runner capabilities)
  {
    method: 'GET', pathPattern: '/api/runner/adapters', class: 'production_disabled',
    persistence: 'none', action: 'runner_adapters_disabled', idempotent: true, role: 'none',
    notes: 'Legacy Hermes adapters; production uses account-bound Runner capabilities',
  },
  {
    method: 'POST', pathPattern: '/api/runner/enroll', class: 'production_disabled',
    persistence: 'none', action: 'runner_enroll_legacy_disabled', idempotent: false, role: 'none',
    notes: 'Use POST /api/runners/enrollments (owner session)',
  },
];

/** Desktop hermesApi paths used for inventory completeness checks. */
const DESKTOP_API_PATHS = [
  'GET /api/gateway-status',
  'GET /api/contracts/client-v1',
  'GET /api/state',
  'GET /api/tasks',
  'POST /api/tasks',
  'PATCH /api/tasks/:id',
  'DELETE /api/tasks/:id',
  'GET /api/calendar/events',
  'POST /api/calendar/events',
  'PATCH /api/calendar/events/:id',
  'DELETE /api/calendar/events/:id',
  'GET /api/mail/messages',
  'GET /api/workboard',
  'GET /api/documents',
  'POST /api/documents',
  'GET /api/wiki',
  'POST /api/wiki/ask',
  'POST /api/wiki/search',
  'POST /api/assistant/ask',
  'POST /api/assistant/ingest',
  'GET /api/agents',
  'GET /api/agent-operations',
  'POST /api/agent-operations/work',
  'GET /api/agent-operations/work/:missionId/conversation',
  'POST /api/agent-operations/work/:missionId/messages',
  'POST /api/agent-operations/work/:missionId/live',
  'POST /api/agent-operations/missions',
  'POST /api/agent-operations/missions/:id/plan',
  'POST /api/agent-operations/missions/:id/activate',
  'POST /api/agent-operations/missions/:id/pause',
  'POST /api/agent-operations/missions/:id/cancel',
  'POST /api/agent-operations/tasks/:id/:action',
  'GET /api/agent-operations/sessions/:id',
  'POST /api/agent-operations/sessions/:id/messages',
  'POST /api/agent-operations/reports/:id/feedback',
  'POST /api/agent-operations/reports/:id/follow-ups',
  'POST /api/agents',
  'GET /api/channels/status',
  'GET /api/automation/sources',
  'POST /api/automation/sources',
  'POST /api/automation/sources/:id/sync',
  'GET /api/automation/automations',
  'GET /api/automation/occurrences',
  'POST /api/automation/changes',
  'POST /api/automation/changes/:id/approve',
  'GET /api/scheduler/jobs',
  'POST /api/scheduler/jobs',
  'PATCH /api/scheduler/jobs/:id',
  'DELETE /api/scheduler/jobs/:id',
  'POST /api/scheduler/jobs/:id/run',
  'GET /api/usage',
  'GET /api/tools',
  'GET /api/settings',
  'POST /api/settings',
  'GET /api/chat/messages',
  'GET /api/events',
  'POST /api/runs',
  'POST /api/missions/launch',
  'GET /api/runs/:id',
  'POST /api/runs/:id/approve',
  'POST /api/calendar/quick-add',
  'POST /api/chat/stream',
  'GET /api/runners',
  'GET /api/runners/release-manifest',
  'POST /api/runners/enrollments',
  'GET /api/runners/enrollments/:id',
  'POST /api/runners/enrollments/:id/confirm',
  'POST /api/runners/enrollments/:id/reject',
  'POST /api/runners/:id/test',
  'POST /api/runners/:id/revoke',
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegExp(pathPattern) {
  const parts = String(pathPattern || '').split('/').map((segment) => {
    if (segment.startsWith(':')) return '([^/]+)';
    return escapeRegex(segment);
  });
  return new RegExp(`^${parts.join('/')}$`);
}

/**
 * Match method+pathname to a registered route.
 * Prefer more specific patterns (more static segments).
 * @returns {{ route: ProductionRoute, params: Record<string,string> } | null}
 */
function matchProductionRoute(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(pathname || '').split('?')[0];
  const candidates = PRODUCTION_ROUTES.filter((route) => route.method === m);
  let best = null;
  let bestScore = -1;
  for (const route of candidates) {
    const re = patternToRegExp(route.pathPattern);
    const match = re.exec(p);
    if (!match) continue;
    const staticScore = route.pathPattern.split('/').filter((s) => s && !s.startsWith(':')).length;
    if (staticScore < bestScore) continue;
    const paramNames = (route.pathPattern.match(/:([A-Za-z0-9_]+)/g) || [])
      .map((name) => name.slice(1));
    const params = {};
    paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] || '');
    });
    best = { route, params };
    bestScore = staticScore;
  }
  return best;
}

function listProductionRoutes() {
  return PRODUCTION_ROUTES.slice();
}

function countRoutesByClass() {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const route of PRODUCTION_ROUTES) {
    counts[route.class] = (counts[route.class] || 0) + 1;
  }
  return {
    total: PRODUCTION_ROUTES.length,
    byClass: counts,
  };
}

function listDesktopApiPaths() {
  return DESKTOP_API_PATHS.slice();
}

/**
 * Assert every Desktop API path is registered. Throws if missing.
 */
function assertDesktopInventoryCovered() {
  const missing = [];
  for (const entry of DESKTOP_API_PATHS) {
    const [method, pathPattern] = entry.split(' ');
    // Replace :params with sample values for match, or match by pattern equality
    const found = PRODUCTION_ROUTES.some(
      (route) => route.method === method && route.pathPattern === pathPattern,
    );
    if (!found) missing.push(entry);
  }
  if (missing.length) {
    const error = new Error(`Desktop API paths missing from production registry: ${missing.join(', ')}`);
    error.code = 'DESKTOP_ROUTE_INVENTORY_GAP';
    error.missing = missing;
    throw error;
  }
  return true;
}

/**
 * Whether production mode may execute a legacy unscoped product handler for this path.
 * Always false — production never falls through for unregistered or product routes.
 */
function allowsLegacyProductFallthrough() {
  return false;
}

function isMutatingMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

module.exports = {
  PRODUCTION_ROUTES,
  DESKTOP_API_PATHS,
  allowsLegacyProductFallthrough,
  assertDesktopInventoryCovered,
  countRoutesByClass,
  isMutatingMethod,
  listDesktopApiPaths,
  listProductionRoutes,
  matchProductionRoute,
  patternToRegExp,
};
