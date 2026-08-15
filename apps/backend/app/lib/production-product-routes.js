'use strict';

const { buildWorkspaceScheduleIngestDrafts } = require('./workspace-schedule-ingest');
const { SecondBrain } = require('./second-brain');
const { SourceLibrary } = require('./source-library');

const secondBrainByRuntime = new WeakMap();

function getSecondBrain(runtime) {
  if (runtime.secondBrain) return runtime.secondBrain;
  let service = secondBrainByRuntime.get(runtime);
  if (!service) {
    service = new SecondBrain({
      pool: runtime.pool,
      sourceLibrary: new SourceLibrary({
        pool: runtime.pool,
        unifiedCalendar: runtime.unifiedCalendar,
        knowledge: runtime.knowledge,
      }),
      inferenceBroker: runtime.inferenceBroker,
    });
    secondBrainByRuntime.set(runtime, service);
  }
  return service;
}

/**
 * Desktop-shaped product handlers for WORKSPACE_AUTH_MODE=production.
 * Every handler receives a server-issued WorkspaceScope; never trusts body workspaceId.
 */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: 'not_found', message: 'not_found' });
}

function productionDisabled(res, action) {
  sendJson(res, 403, {
    ok: false,
    error: 'production_disabled',
    action: String(action || ''),
    message: 'This route is explicitly disabled in production Workspace mode',
  });
}

function runnerFuture(res, action) {
  sendJson(res, 501, {
    ok: false,
    error: 'runner_required',
    action: String(action || ''),
    message: 'Runner enrollment is not available in this slice',
  });
}

/**
 * @returns {Promise<boolean>} true if handled
 */
async function handleScopedProductRoute({
  req,
  res,
  method,
  pathname,
  params,
  route,
  body,
  query,
  scope,
  runtime,
}) {
  const product = runtime.product;
  const action = route.action;

  // ── Aggregate / state ──────────────────────────────────────────────
  if (action === 'state_aggregate') {
    const state = await product.getAggregateState(scope);
    sendJson(res, 200, state);
    return true;
  }

  // ── Tasks ──────────────────────────────────────────────────────────
  if (action === 'tasks_list') {
    const tasks = await product.listTasks(scope);
    sendJson(res, 200, { ok: true, tasks, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'tasks_get') {
    const task = await product.getTaskById(scope, params.id);
    if (!task) return notFound(res), true;
    sendJson(res, 200, { ok: true, task, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'tasks_create') {
    const task = await product.createTask(scope, body || {});
    const tasks = await product.listTasks(scope);
    const state = await product.getAggregateState(scope);
    sendJson(res, 200, { ok: true, task, tasks, state, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'tasks_update') {
    const task = await product.updateTask(scope, params.id, body || {});
    if (!task) return notFound(res), true;
    const tasks = await product.listTasks(scope);
    sendJson(res, 200, { ok: true, task, tasks, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'tasks_delete') {
    const deleted = await product.deleteTask(scope, params.id);
    if (!deleted) return notFound(res), true;
    const tasks = await product.listTasks(scope);
    sendJson(res, 200, { ok: true, deleted: true, tasks, workspaceId: scope.workspaceId });
    return true;
  }

  // ── Calendar ───────────────────────────────────────────────────────
  if (action === 'calendar_list') {
    const events = await product.listCalendarEvents(scope, {
      from: query.from,
      to: query.to,
    });
    sendJson(res, 200, {
      ok: true,
      events,
      calendarEvents: events,
      workspaceId: scope.workspaceId,
    });
    return true;
  }
  if (action === 'calendar_get') {
    const event = await product.getCalendarEventById(scope, params.id);
    if (!event) return notFound(res), true;
    sendJson(res, 200, { ok: true, event, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'calendar_create' || action === 'calendar_quick_add') {
    const event = await product.createCalendarEvent(scope, body || {});
    const events = await product.listCalendarEvents(scope);
    sendJson(res, 200, {
      ok: true, event, events, calendarEvents: events, workspaceId: scope.workspaceId,
    });
    return true;
  }
  if (action === 'calendar_update') {
    const event = await product.updateCalendarEvent(scope, params.id, body || {});
    if (!event) return notFound(res), true;
    sendJson(res, 200, { ok: true, event, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'calendar_delete') {
    const deleted = await product.deleteCalendarEvent(scope, params.id);
    if (!deleted) return notFound(res), true;
    sendJson(res, 200, { ok: true, deleted: true, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'assistant_ingest_scoped') {
    const result = await buildWorkspaceScheduleIngestDrafts({
      scope,
      request: body || {},
      runtime,
      env: runtime.env || process.env,
    });
    sendJson(res, result.ok === false ? 400 : 200, result);
    return true;
  }

  // ── Phase 4 Unified Calendar ───────────────────────────────────────
  if (action === 'calendar_unified_range') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.queryRange(scope, {
        from: query.from,
        to: query.to,
        sourceIds: query.sourceIds ? String(query.sourceIds).split(',').filter(Boolean) : null,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'unified_query_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_sources_list') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    const result = await cal.listSources(scope);
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'calendar_google_authorize') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.startGoogleAuthorize(scope);
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'authorize_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_google_callback') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      // body.workspaceId is never authority — scope from session only.
      const result = await cal.finalizeGoogleOAuth(scope, {
        code: body && body.code,
        state: body && body.state,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'callback_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_source_sync') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.syncSource(scope, params.id, body || {});
      if (!result) return notFound(res), true;
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'sync_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_source_disconnect') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    const result = await cal.disconnectSource(scope, params.id);
    if (!result) return notFound(res), true;
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'calendar_source_watch') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.registerWatch(scope, params.id, body || {});
      if (!result) return notFound(res), true;
      // Never expose setupToken on the public HTTP boundary.
      const { setupToken, ...publicWatch } = result;
      void setupToken;
      sendJson(res, 200, publicWatch);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'watch_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_external_create') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.createExternalEvent(scope, body || {});
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'mutation_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_external_update') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.updateExternalEvent(scope, {
        ...(body || {}),
        providerEventId: params.providerEventId,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'mutation_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'calendar_external_delete') {
    const cal = runtime.unifiedCalendar;
    if (!cal) {
      sendJson(res, 503, { ok: false, error: 'unified_calendar_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      const result = await cal.deleteExternalEvent(scope, {
        ...(body || {}),
        providerEventId: params.providerEventId,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'mutation_failed', message: error.message || 'bad_request' });
    }
    return true;
  }

  // ── Agents ─────────────────────────────────────────────────────────
  if (action === 'agents_list') {
    const agents = await product.listAgents(scope);
    sendJson(res, 200, { ok: true, agents, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agents_create') {
    const agent = await product.createAgent(scope, body || {});
    const agents = await product.listAgents(scope);
    sendJson(res, 200, { ok: true, agent, agents, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_create') {
    const agent = await runtime.agentBuilder.createDraft(scope, body || {});
    sendJson(res, 201, { ok: true, agent, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_review') {
    const agent = await runtime.agentBuilder.reviewDraft(scope, params.id, body || {});
    if (!agent) return notFound(res), true;
    sendJson(res, 200, { ok: true, agent, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_test_start') {
    const result = await runtime.agentBuilder.startTest(scope, params.id, body || {});
    if (!result) return notFound(res), true;
    sendJson(res, 202, { ok: true, ...result, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_test_get') {
    const result = await runtime.agentBuilder.getTest(scope, params.id, params.requestId);
    if (!result) return notFound(res), true;
    sendJson(res, 200, { ok: true, ...result, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_test_cancel') {
    const result = await runtime.agentBuilder.cancelTest(scope, params.id, params.requestId);
    if (!result) return notFound(res), true;
    sendJson(res, 200, { ok: true, ...result, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_activate') {
    const agent = await runtime.agentBuilder.activate(scope, params.id, body || {});
    if (!agent) return notFound(res), true;
    sendJson(res, 200, { ok: true, agent, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_builder_versions_list') {
    const versions = await runtime.agentBuilder.listVersions(scope, params.id);
    sendJson(res, 200, { ok: true, versions, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_catalog_request') {
    const request = await runtime.providerAgentBridge.requestCatalog(scope, body || {});
    sendJson(res, 202, { ok: true, request, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_catalog_request_get') {
    const request = await runtime.providerAgentBridge.getCatalogRequest(scope, params.id);
    if (!request) return notFound(res), true;
    sendJson(res, 200, { ok: true, request, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_catalog_import') {
    const agent = await runtime.providerAgentBridge.importAgent(scope, params.id, body || {});
    sendJson(res, 200, { ok: true, agent, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'provider_agent_session_catalog_request') {
    const request = await runtime.providerAgentBridge.requestSessionCatalog(scope, params.id, body || {});
    sendJson(res, 202, { ok: true, request, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'provider_agent_session_catalog_import') {
    const imported = await runtime.providerAgentBridge.importProviderSession(
      scope,
      params.id,
      params.requestId,
      body || {},
    );
    sendJson(res, 200, { ok: true, ...imported, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'provider_agent_sessions_list') {
    const sessions = await runtime.providerAgentBridge.listSessions(scope, params.id, {
      search: query.search,
      archived: query.archived === 'true',
    });
    sendJson(res, 200, { ok: true, sessions, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'provider_agent_session_update') {
    const session = await runtime.providerAgentBridge.updateSession(scope, params.id, body || {});
    if (!session) return notFound(res), true;
    sendJson(res, 200, { ok: true, session, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agents_update' || action === 'agents_restore') {
    const agent = await product.updateAgent(scope, params.id, body || {});
    if (!agent) return notFound(res), true;
    sendJson(res, 200, { ok: true, agent, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agents_delete') {
    const deleted = await product.deleteAgent(scope, params.id);
    if (!deleted) return notFound(res), true;
    sendJson(res, 200, { ok: true, deleted: true, workspaceId: scope.workspaceId });
    return true;
  }

  // ── Documents / wiki ───────────────────────────────────────────────
  if (action === 'documents_list') {
    const documents = await product.listDocuments(scope);
    sendJson(res, 200, { ok: true, documents, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'documents_create') {
    const document = await product.createDocument(scope, body || {});
    sendJson(res, 200, { ok: true, document, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'wiki_list') {
    const wiki = await product.listWiki(scope, {
      path: query.path,
      query: query.query,
    });
    const knowledge = runtime.knowledge;
    let knowledgeMeta = null;
    if (knowledge && knowledge.enabled()) {
      try {
        const sources = await knowledge.listSources(scope);
        knowledgeMeta = {
          knowledgeV2: true,
          sources: sources.sources || [],
        };
      } catch {
        knowledgeMeta = { knowledgeV2: true, sources: [] };
      }
    }
    sendJson(res, 200, {
      ...wiki,
      workspaceId: scope.workspaceId,
      ...(knowledgeMeta || { knowledgeV2: false }),
    });
    return true;
  }
  if (action === 'wiki_search') {
    const q = (body && (body.query || body.q)) || query.q || query.query || '';
    const mode = (body && body.mode) || query.mode || 'keyword';
    const knowledge = runtime.knowledge;
    if (knowledge && knowledge.enabled()) {
      const result = await knowledge.search(scope, {
        query: q,
        mode: mode === 'vector' ? 'vector' : 'hybrid',
        waitForRunnerMs: Number(body?.waitForRunnerMs || 0),
        requestId: body?.requestId || '',
      });
      sendJson(res, 200, result);
      return true;
    }
    let results;
    if (mode === 'vector') {
      results = await product.searchWikiVector(scope, q, { limit: 20 });
    } else {
      results = await product.searchWiki(scope, q);
    }
    sendJson(res, 200, {
      ok: true, query: q, mode, results, workspaceId: scope.workspaceId, knowledgeV2: false,
    });
    return true;
  }
  if (action === 'wiki_ask_scoped') {
    const question = (body && (body.question || body.query || body.message)) || '';
    const knowledge = runtime.knowledge;
    if (knowledge && knowledge.enabled()) {
      const answer = await knowledge.ask(scope, {
        question,
        waitForRunnerMs: Number(body?.waitForRunnerMs || 0),
        requestId: body?.requestId || '',
      });
      sendJson(res, 200, answer);
      return true;
    }
    const answer = await product.askWikiScoped(scope, question);
    sendJson(res, 200, { ...answer, knowledgeV2: false });
    return true;
  }

  // ── Knowledge v2 ───────────────────────────────────────────────────
  if (action === 'knowledge_sources_list') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.listSources(scope);
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_sources_create') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.registerSource(scope, body || {});
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_source_revoke') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.revokeSource(scope, params.id);
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_ingest_cloud') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.ingestCloudDocument(scope, body || {});
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_private_local_register') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.registerPrivateLocalDocument(scope, body || {});
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_search') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.search(scope, {
      query: (body && (body.query || body.q)) || '',
      mode: (body && body.mode) || 'hybrid',
      waitForRunnerMs: Number(body?.waitForRunnerMs || 0),
      requestId: body?.requestId || '',
    });
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_ask') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.ask(scope, {
      question: (body && (body.question || body.query || body.message)) || '',
      waitForRunnerMs: Number(body?.waitForRunnerMs || 0),
      requestId: body?.requestId || '',
    });
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_evidence_resolve') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.resolveEvidence(scope, params.handle);
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'knowledge_search_job') {
    const knowledge = runtime.knowledge;
    if (!knowledge) return notFound(res), true;
    const result = await knowledge.getSearchJob(scope, params.id);
    sendJson(res, 200, result);
    return true;
  }

  if (action === 'automation_sources_list') {
    sendJson(res, 200, await runtime.automationFederation.listSources(scope));
    return true;
  }
  if (action === 'automation_sources_connect') {
    sendJson(res, 200, await runtime.automationFederation.connectSource(scope, body || {}));
    return true;
  }
  if (action === 'automation_sources_sync') {
    sendJson(res, 200, await runtime.automationFederation.synchronize(scope, params.id));
    return true;
  }
  if (action === 'automation_list') {
    sendJson(res, 200, await runtime.automationFederation.listAutomations(scope, {
      sourceId: query.sourceId || '',
    }));
    return true;
  }
  if (action === 'automation_occurrences_list') {
    sendJson(res, 200, await runtime.automationFederation.listOccurrences(scope, {
      from: query.from || '',
      to: query.to || '',
      automationId: query.automationId || '',
    }));
    return true;
  }
  if (action === 'automation_change_create') {
    sendJson(res, 200, await runtime.automationFederation.requestChange(scope, body || {}));
    return true;
  }
  if (action === 'automation_change_approve') {
    sendJson(res, 200, await runtime.automationFederation.approveChange(
      scope,
      params.id,
      body || {},
    ));
    return true;
  }

  // ── Scheduler ──────────────────────────────────────────────────────
  if (action === 'scheduler_list') {
    const jobs = await product.listSchedulerJobs(scope);
    sendJson(res, 200, { ok: true, jobs, schedulerJobs: jobs, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'scheduler_create') {
    const job = await product.createSchedulerJob(scope, body || {});
    const jobs = await product.listSchedulerJobs(scope);
    sendJson(res, 200, { ok: true, job, jobs, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'scheduler_update') {
    const job = await product.updateSchedulerJob(scope, params.id, body || {});
    if (!job) return notFound(res), true;
    sendJson(res, 200, { ok: true, job, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'scheduler_delete') {
    const deleted = await product.deleteSchedulerJob(scope, params.id);
    if (!deleted) return notFound(res), true;
    sendJson(res, 200, { ok: true, deleted: true, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'scheduler_run_deferred') {
    const result = await product.markSchedulerRunDeferred(scope, params.id);
    if (!result) return notFound(res), true;
    sendJson(res, 200, result);
    return true;
  }

  // ── Settings ───────────────────────────────────────────────────────
  if (action === 'settings_get') {
    const settings = await product.getSettings(scope);
    sendJson(res, 200, { ok: true, ...settings, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'settings_save') {
    const settings = await product.saveSettings(scope, body || {});
    sendJson(res, 200, { ok: true, ...settings, workspaceId: scope.workspaceId });
    return true;
  }

  if (action === 'calendar_ai_conversations_list') {
    sendJson(res, 200, await runtime.calendarAi.listConversations(scope));
    return true;
  }
  if (action === 'calendar_ai_conversation_create') {
    const result = await runtime.calendarAi.chat(scope, {
      message: body?.message || body?.question || '',
      requestId: body?.requestId || '',
    });
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'calendar_ai_conversation_get') {
    const result = await runtime.calendarAi.listConversation(scope, params.id);
    if (!result) return notFound(res), true;
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'calendar_ai_turn_create') {
    const result = await runtime.calendarAi.chat(scope, {
      conversationId: params.id,
      message: body?.message || body?.question || '',
      requestId: body?.requestId || '',
    });
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'calendar_ai_memories_list') {
    sendJson(res, 200, await runtime.calendarAi.listMemories(scope));
    return true;
  }
  if (action === 'calendar_ai_memory_update') {
    sendJson(res, 200, await runtime.calendarAi.updateMemory(scope, params.id, body || {}));
    return true;
  }
  if (action === 'calendar_ai_memory_forget') {
    sendJson(res, 200, await runtime.calendarAi.forgetMemory(scope, params.id));
    return true;
  }
  if (action === 'calendar_ai_memory_purge') {
    sendJson(res, 200, await runtime.calendarAi.purgeMemory(scope, params.id));
    return true;
  }
  if (action === 'calendar_ai_action_approve') {
    sendJson(res, 200, await runtime.calendarAi.approveAction(scope, params.id, body || {}));
    return true;
  }
  if (action === 'calendar_ai_action_revise') {
    sendJson(res, 200, await runtime.calendarAi.reviseAction(scope, params.id, body || {}));
    return true;
  }
  if (action === 'calendar_ai_action_cancel') {
    sendJson(res, 200, await runtime.calendarAi.cancelAction(scope, params.id));
    return true;
  }

  // ── Chat ───────────────────────────────────────────────────────────
  if (action === 'chat_messages_list') {
    if (runtime.calendarAi?.enabled()) {
      const conversations = await runtime.calendarAi.listConversations(scope);
      const latest = conversations.conversations[0];
      const conversation = latest
        ? await runtime.calendarAi.listConversation(scope, latest.id)
        : null;
      const messages = (conversation?.conversation?.turns || []).map((turn) => ({
        id: turn.id,
        role: turn.role,
        text: turn.text,
        target: 'calendar',
        view: 'calendar',
        kind: turn.kind,
        metadata: turn.metadata,
        sources: turn.sources,
        coverage: turn.coverage,
        actionDraft: turn.actionDraft,
      }));
      sendJson(res, 200, {
        ok: true,
        messages,
        chatMessages: messages,
        conversationId: latest?.id || null,
        actionDrafts: conversation?.conversation?.actionDrafts || [],
        workspaceId: scope.workspaceId,
      });
      return true;
    }
    const messages = await product.listChatMessages(scope, { target: query.target });
    sendJson(res, 200, {
      ok: true, messages, chatMessages: messages, workspaceId: scope.workspaceId,
    });
    return true;
  }
  if (action === 'chat_stream_scoped' || action === 'assistant_ask_scoped') {
    if (runtime.calendarAi?.enabled()) {
      const result = await runtime.calendarAi.chat(scope, {
        conversationId: body?.conversationId || '',
        message: body?.message || body?.question || body?.query || '',
        requestId: body?.requestId || req.headers['x-idempotency-key'] || '',
      });
      if (action === 'chat_stream_scoped') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: delta\ndata: ${JSON.stringify({ type: 'token', text: result.answer })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', text: result.answer, ...result })}\n\n`);
        res.end();
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }
    const message = String((body && (body.message || body.question || body.query)) || '');
    await product.createChatMessage(scope, {
      role: 'user',
      text: message,
      target: (body && body.view) || 'calendar',
      view: (body && body.view) || 'calendar',
    });
    // Keyword answer from workspace calendar/tasks (no external model / no global store).
    const tasks = await product.listTasks(scope);
    const events = await product.listCalendarEvents(scope);
    const answer = [
      `Workspace ${scope.workspaceId} schedule summary:`,
      `tasks=${tasks.length}, events=${events.length}`,
      message ? `You asked: ${message.slice(0, 200)}` : '',
      events.slice(0, 5).map((e) => `- ${e.title} @ ${e.startsAt}`).join('\n'),
    ].filter(Boolean).join('\n');
    await product.createChatMessage(scope, {
      role: 'assistant',
      text: answer,
      target: (body && body.view) || 'calendar',
      view: (body && body.view) || 'calendar',
    });
    if (action === 'chat_stream_scoped') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'token', text: answer })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', workspaceId: scope.workspaceId })}\n\n`);
      res.end();
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      answer,
      workspaceId: scope.workspaceId,
      mode: 'workspace_schedule_summary',
    });
    return true;
  }

  // ── SSE events ─────────────────────────────────────────────────────
  if (action === 'events_sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`: connected workspace=${scope.workspaceId}\n\n`);
    const channel = query.channel || 'workspace-events';
    const payload = await runtime.sseHub.subscribe(scope, channel, {
      timeoutMs: Math.min(Number(query.waitMs || 1500), 10_000),
    });
    res.write(`data: ${JSON.stringify({ ...payload, workspaceId: scope.workspaceId })}\n\n`);
    res.end();
    return true;
  }

  // ── Mail (hydrate-safe empty workspace mailbox) ────────────────────
  if (action === 'mail_list') {
    const result = runtime.unifiedCalendar && typeof runtime.unifiedCalendar.listMailMessages === 'function'
      ? await runtime.unifiedCalendar.listMailMessages(scope)
      : {
          ok: true,
          items: [],
          messages: [],
          workspaceId: scope.workspaceId,
          connector: 'not_linked',
        };
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'mail_google_authorize') {
    if (!runtime.unifiedCalendar || typeof runtime.unifiedCalendar.startGoogleMailAuthorize !== 'function') {
      sendJson(res, 503, { ok: false, error: 'mail_connector_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      sendJson(res, 200, await runtime.unifiedCalendar.startGoogleMailAuthorize(scope));
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'authorize_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'mail_google_callback') {
    if (!runtime.unifiedCalendar || typeof runtime.unifiedCalendar.finalizeGoogleMailOAuth !== 'function') {
      sendJson(res, 503, { ok: false, error: 'mail_connector_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      sendJson(res, 200, await runtime.unifiedCalendar.finalizeGoogleMailOAuth(scope, {
        code: body && body.code,
        state: body && body.state,
      }));
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'callback_failed', message: error.message || 'bad_request' });
    }
    return true;
  }
  if (action === 'mail_google_disconnect') {
    if (!runtime.unifiedCalendar || typeof runtime.unifiedCalendar.disconnectGoogleMail !== 'function') {
      sendJson(res, 503, { ok: false, error: 'mail_connector_unavailable', message: 'service_unavailable' });
      return true;
    }
    try {
      sendJson(res, 200, await runtime.unifiedCalendar.disconnectGoogleMail(scope));
    } catch (error) {
      const status = error && error.statusHint ? error.statusHint : 400;
      sendJson(res, status, { ok: false, error: error.code || 'disconnect_failed', message: error.message || 'bad_request' });
    }
    return true;
  }

  // ── Personal second brain ─────────────────────────────────────────
  if (action === 'second_brain_run_create') {
    try {
      sendJson(res, 200, await getSecondBrain(runtime).createRun(scope, body || {}));
    } catch (error) {
      sendJson(res, error.statusHint || 400, { ok: false, error: error.code || 'second_brain_run_failed', message: error.message });
    }
    return true;
  }
  if (action === 'second_brain_run_get') {
    const result = await getSecondBrain(runtime).getRun(scope, params.id);
    if (!result) return notFound(res), true;
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'second_brain_current') {
    sendJson(res, 200, await getSecondBrain(runtime).getCurrent(scope));
    return true;
  }
  if (action === 'second_brain_snapshot_review') {
    try {
      const result = await getSecondBrain(runtime).reviewSnapshot(scope, params.id, body || {});
      if (!result) return notFound(res), true;
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusHint || 400, { ok: false, error: error.code || 'second_brain_review_failed', message: error.message });
    }
    return true;
  }

  // ── Usage / tools / channels / workboard empties ───────────────────
  if (action === 'usage_empty') {
    sendJson(res, 200, { ok: true, usage: {}, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'tools_empty') {
    sendJson(res, 200, { ok: true, tools: [], workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'channels_status') {
    sendJson(res, 200, { ok: true, channels: [], workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'workboard_list') {
    const pages = await product.listWorkboard(scope);
    sendJson(res, 200, { ok: true, pages, items: pages, workspaceId: scope.workspaceId });
    return true;
  }

  // ── Runs ───────────────────────────────────────────────────────────
  if (action === 'runs_get') {
    const run = await product.getRunById(scope, params.id);
    if (!run) return notFound(res), true;
    sendJson(res, 200, { ok: true, run, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'runs_create_deferred' || action === 'missions_launch_deferred') {
    const result = await product.createRunDeferred(scope, body || {});
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'runs_approve') {
    const run = await product.approveRun(scope, params.id);
    if (!run) return notFound(res), true;
    sendJson(res, 200, { ok: true, run, workspaceId: scope.workspaceId });
    return true;
  }

  // ── Agent operations ───────────────────────────────────────────────
  if (action === 'agent_ops_snapshot') {
    const snapshot = await product.getAgentOperationsSnapshot(scope);
    sendJson(res, 200, snapshot);
    return true;
  }
  if (action === 'agent_work_create_deferred' || action === 'missions_create_deferred') {
    const result = await product.createDeferredAgentWork(scope, body || {});
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'agent_work_conversation') {
    const conversation = await product.getAgentWorkConversation(scope, params.missionId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    if (!conversation) return notFound(res), true;
    sendJson(res, 200, conversation);
    return true;
  }
  if (action === 'agent_work_message') {
    const result = await product.addAgentWorkMessage(scope, params.missionId, body || {});
    if (!result) return notFound(res), true;
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'agent_work_handoffs_list') {
    const result = await product.listAgentWorkHandoffs(scope, params.missionId);
    sendJson(res, 200, {
      ok: true,
      ...result,
      workspaceId: scope.workspaceId,
    });
    return true;
  }
  if (action === 'agent_work_handoff_create') {
    const result = await product.createAgentWorkHandoff(
      scope,
      params.missionId,
      body || {},
    );
    sendJson(res, result.idempotentReplay ? 200 : 201, result);
    return true;
  }
  if (action === 'agent_work_handoff_cancel') {
    const result = await product.cancelAgentWorkHandoff(
      scope,
      params.missionId,
      params.handoffId,
      body || {},
    );
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'agent_work_provider_session_transition') {
    const result = await product.transitionAgentWorkProviderSession(
      scope,
      params.missionId,
      body || {},
    );
    sendJson(res, result.idempotentReplay ? 200 : 201, result);
    return true;
  }
  if (action === 'agent_work_comparison_adopt') {
    const result = await product.adoptAgentWorkComparisonResult(
      scope,
      params.missionId,
      body || {},
    );
    sendJson(res, 200, result);
    return true;
  }
  if (action === 'agent_work_live_deferred') {
    // Phase 3: durable execution is Runner-driven. Live SSE only acknowledges user turns /
    // initial open so Desktop can refresh conversation checkpoints — never a terminal
    // blocked_runner_required (create already accepted work via DurableExecution).
    if (body && (body.text || body.message) && body.initial !== true) {
      await product.addAgentWorkMessage(scope, params.missionId, body);
    }
    const acceptedAt = new Date().toISOString();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`event: accepted\ndata: ${JSON.stringify({
      delivery: {
        status: 'accepted',
        applicationMode: 'mission_context',
        acceptedAt,
      },
      idempotentReplay: false,
    })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ idempotentReplay: false })}\n\n`);
    res.end();
    return true;
  }
  if (action === 'missions_plan_deferred' || action === 'missions_activate_deferred') {
    sendJson(res, 200, {
      ok: true,
      status: 'blocked_runner_required',
      error: 'runner_required',
      missionId: params.id,
      workspaceId: scope.workspaceId,
    });
    return true;
  }
  if (action === 'missions_pause' || action === 'missions_cancel') {
    const actionName = action === 'missions_pause' ? 'pause' : 'cancel';
    if (actionName === 'cancel' && typeof product.requestCancelAgentWork === 'function') {
      const cancelled = await product.requestCancelAgentWork(scope, params.id);
      if (cancelled) {
        sendJson(res, 200, { ok: true, ...cancelled });
        return true;
      }
    }
    const result = await product.transitionMission(scope, params.id, actionName);
    if (!result) return notFound(res), true;
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }
  if (action === 'agent_task_transition') {
    sendJson(res, 200, {
      ok: true,
      status: 'blocked_runner_required',
      error: 'runner_required',
      taskId: params.id,
      action: params.action,
      workspaceId: scope.workspaceId,
    });
    return true;
  }
  if (action === 'agent_session_get') {
    const session = await product.getAgentSession(scope, params.id);
    if (!session) return notFound(res), true;
    sendJson(res, 200, { ok: true, session, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_session_message') {
    // Treat as work message on owning mission if present
    const session = await product.getAgentSession(scope, params.id);
    if (!session) return notFound(res), true;
    if (session.missionId) {
      const result = await product.addAgentWorkMessage(scope, session.missionId, body || {});
      sendJson(res, 200, result || { ok: true, workspaceId: scope.workspaceId });
      return true;
    }
    sendJson(res, 200, { ok: true, workspaceId: scope.workspaceId });
    return true;
  }
  if (action === 'agent_report_feedback' || action === 'agent_report_followups') {
    sendJson(res, 200, {
      ok: true,
      recorded: true,
      workspaceId: scope.workspaceId,
      reportId: params.id,
    });
    return true;
  }

  // Phase1-style agent work events/stream under /api/phase1
  if (action === 'agent_work_events') {
    const session = await product.getAgentSession(scope, params.sessionId);
    if (!session) return notFound(res), true;
    const events = await product.listAgentSessionEvents(scope, params.sessionId);
    sendJson(res, 200, {
      ok: true, workspaceId: scope.workspaceId, sessionId: params.sessionId, events,
    });
    return true;
  }
  if (action === 'agent_work_stream') {
    const session = await product.getAgentSession(scope, params.sessionId);
    if (!session) return notFound(res), true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`: connected workspace=${scope.workspaceId} session=${params.sessionId}\n\n`);
    const payload = await runtime.sseHub.subscribe(scope, `agent-session:${params.sessionId}`, {
      timeoutMs: Math.min(Number(query.waitMs || 15_000), 30_000),
    });
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
    return true;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'scoped_action_not_implemented',
    action,
    message: 'not_found',
  });
  return true;
}

module.exports = {
  handleScopedProductRoute,
  productionDisabled,
  runnerFuture,
  sendJson,
  notFound,
};
