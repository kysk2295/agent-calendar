const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrations } = require('../db/migrate');
const { AgentWorkContractError } = require('./agent-work-contract');
const { deliveryFromEvent, deliveryMetadata } = require('./agent-work-delivery');
const { chunksFromDocument, chunksFromWikiNotes, rankWikiChunks } = require('./wiki-rag');
const { HermesStore, createDefaultState } = require('./store');

function createPool({ env = process.env } = {}) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
}

function safeJson(value) {
  return value && typeof value === 'object' ? value : {};
}

function vectorLiteral(value = []) {
  const vector = Array.isArray(value) ? value : [];
  return `[${vector.map((entry) => {
    const number = Number(entry);
    return Number.isFinite(number) ? number : 0;
  }).join(',')}]`;
}

function mergeRecordsById(primary = [], secondary = []) {
  const records = new Map();
  for (const item of [...(Array.isArray(secondary) ? secondary : []), ...(Array.isArray(primary) ? primary : [])]) {
    if (!item || typeof item !== 'object') continue;
    records.set(String(item.id || records.size), item);
  }
  return [...records.values()];
}

class PostgresHermesStore extends HermesStore {
  constructor({
    pool,
    env = process.env,
    dataDir = path.join(os.tmpdir(), 'hermes-os-postgres-cache'),
    clock,
    autoMigrate = env.HERMES_DB_AUTO_MIGRATE !== 'false',
  } = {}) {
    super({ dataDir, clock });
    this.pool = pool || createPool({ env });
    this.persistErrors = [];
    this.taskPersistChains = new Map();
    this.agentSessionPersistChains = new Map();
    this.delegatedWorkChains = new Map();
    this.suppressAgentWorkPersistence = false;
    const migrationReady = autoMigrate
      ? runMigrations({ pool: this.pool }).catch((error) => {
        this.persistErrors.push(error.message);
        return { migrations: [] };
      })
      : Promise.resolve({ migrations: [] });
    this.ready = migrationReady.then(async (result) => {
      await this.#hydrateFromPostgres();
      return result;
    });
  }

  createAgent(input = {}) {
    const agent = super.createAgent(input);
    this.#upsertAgent(agent);
    return agent;
  }

  updateAgent(agentId, patch = {}) {
    const agent = super.updateAgent(agentId, patch);
    if (agent) this.#upsertAgent(agent);
    return agent;
  }

  syncAgents(agents = []) {
    const state = this.getState();
    const nextAgents = [];
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (!agent || !agent.id) continue;
      this.#upsertAgent(agent);
      nextAgents.push(agent);
    }
    if (nextAgents.length) {
      state.agents = [
        ...nextAgents,
        ...(Array.isArray(state.agents) ? state.agents : []).filter((agent) => (
          !nextAgents.some((next) => next.id === agent.id)
        )),
      ];
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }
    return nextAgents;
  }

  deleteAgent(agentId) {
    const agent = super.deleteAgent(agentId);
    if (agent) {
      this.#deleteAgent(agent);
      this.#upsertStateMeta('deletedAgentIds', this.getState().deletedAgentIds || []);
    }
    return agent;
  }

  createDelegatedWork(records = {}) {
    const key = String(records.mission?.clientRequestId || records.mission?.id || 'work');
    const previous = this.delegatedWorkChains.get(key) || Promise.resolve();
    const operation = previous.then(async () => {
      const persisted = await this.#persistDelegatedWork(records);
      const local = super.createDelegatedWork(persisted.records);
      return { ...local, idempotentReplay: persisted.idempotentReplay };
    });
    const tracked = operation.catch(() => null);
    this.delegatedWorkChains.set(key, tracked);
    tracked.finally(() => {
      if (this.delegatedWorkChains.get(key) === tracked) this.delegatedWorkChains.delete(key);
    });
    return operation;
  }

  async addDelegatedWorkMessage(input = {}) {
    const state = super.getState();
    const mission = state.agentMissions.find((item) => item.id === input.missionId);
    if (!mission) return super.addDelegatedWorkMessage(input);
    const conversation = state.agentSessions.find((item) => item.id === mission.missionThreadId);
    const existing = state.agentSessionEvents.find((event) => (
      event.sessionId === conversation?.id
      && event.metadata?.clientMessageId === input.clientMessageId
    ));
    if (existing) return super.addDelegatedWorkMessage(input);
    const sequence = state.agentSessionEvents
      .filter((event) => event.sessionId === conversation?.id)
      .reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0) + 1;
    const event = {
      id: input.eventId,
      sessionId: conversation?.id || '',
      sequence,
      kind: 'user_message',
      text: input.text,
      createdAt: input.acceptedAt,
      metadata: {
        clientMessageId: input.clientMessageId,
        ...deliveryMetadata(input.delivery || {
          status: 'accepted',
          applicationMode: 'mission_context',
        }, input.acceptedAt),
      },
    };
    const persisted = await this.#persistDelegatedWorkMessage({ conversation, event });
    const local = super.addDelegatedWorkMessage({
      ...input,
      authoritativeEvent: persisted.event,
    });
    return {
      message: local.message,
      delivery: deliveryFromEvent(local.message),
      idempotentReplay: persisted.idempotentReplay,
    };
  }

  async applyDelegatedWorkCommand(input = {}, apply) {
    await this.ready;
    await this.#hydrateFromPostgres();
    const localState = super.getState();
    const mission = localState.agentMissions.find((item) => item.id === input.missionId);
    const conversation = localState.agentSessions.find((item) => (
      item.id === mission?.missionThreadId && item.type === 'mission-thread'
    ));
    if (!mission || !conversation) {
      throw new AgentWorkContractError('work_not_found', 'Delegated work was not found', 404);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [mission.id]);
      const existingResult = await client.query(
        'select payload from agent_session_events where id = $1 for update',
        [input.eventId],
      );
      const existing = safeJson(existingResult?.rows?.[0]?.payload);
      if (Object.keys(existing).length) {
        if (
          existing.sessionId !== conversation.id
          || existing.text !== input.text
          || existing.metadata?.clientMessageId !== input.clientMessageId
        ) {
          throw new AgentWorkContractError(
            'work_message_idempotency_conflict',
            'clientMessageId was already used for different text',
            409,
          );
        }
        await client.query('commit');
        await this.#hydrateFromPostgres();
        return {
          message: existing,
          delivery: deliveryFromEvent(existing),
          idempotentReplay: true,
        };
      }
      const targetTaskId = String(input.delivery?.targetTaskId || '').trim();
      if (targetTaskId) {
        const taskResult = await client.query(
          'select payload from tasks where id = $1 for update',
          [targetTaskId],
        );
        const authoritativeTask = safeJson(taskResult?.rows?.[0]?.payload);
        if (!Object.keys(authoritativeTask).length) {
          throw new AgentWorkContractError('task_not_found', 'Agent Task was not found', 404);
        }
        HermesStore.prototype.updateTask.call(this, targetTaskId, authoritativeTask);
      }
      const before = structuredClone(super.getState());
      this.suppressAgentWorkPersistence = true;
      let applied;
      try {
        applied = super.applyDelegatedWorkCommand(input, apply);
      } finally {
        this.suppressAgentWorkPersistence = false;
      }
      const after = super.getState();
      const beforeTasks = new Map(before.tasks.map((item) => [item.id, JSON.stringify(item)]));
      const beforeSessions = new Map(before.agentSessions.map((item) => [item.id, JSON.stringify(item)]));
      const beforeEvents = new Map(before.agentSessionEvents.map((item) => [item.id, JSON.stringify(item)]));
      const changedTasks = after.tasks.filter((item) => beforeTasks.get(item.id) !== JSON.stringify(item));
      const changedSessions = after.agentSessions.filter((item) => beforeSessions.get(item.id) !== JSON.stringify(item));
      const changedEvents = after.agentSessionEvents.filter((item) => beforeEvents.get(item.id) !== JSON.stringify(item));
      for (const task of changedTasks) {
        await client.query(
          `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, now())
           on conflict (id) do update set
             status = excluded.status,
             payload = excluded.payload,
             updated_at = now()`,
          [task.id, task.title, task.status, task.owner, task.dueAt || '', task.missionId, task.sessionId, JSON.stringify(safeJson(task)), task.createdAt],
        );
      }
      for (const session of changedSessions) {
        await client.query(
          `insert into agent_sessions (id, mission_id, task_id, status, payload, created_at, updated_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())
           on conflict (id) do update set
             status = excluded.status,
             payload = excluded.payload,
             updated_at = now()`,
          [session.id, session.missionId, session.taskId || '', session.status, JSON.stringify(safeJson(session)), session.createdAt],
        );
      }
      for (const event of changedEvents) {
        await client.query(
          `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
           on conflict (id) do update set payload = excluded.payload`,
          [event.id, event.sessionId, event.sequence, event.kind, JSON.stringify(safeJson(event)), event.createdAt],
        );
      }
      await client.query('commit');
      return applied;
    } catch (error) {
      this.suppressAgentWorkPersistence = false;
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        const combined = new Error(`PostgreSQL rollback failed: ${rollbackError.message}`);
        combined.cause = error;
        throw combined;
      }
      await this.#hydrateFromPostgres();
      throw error;
    } finally {
      client.release();
    }
  }

  async createRevisionCycle(input = {}) {
    const persisted = await this.#persistRevisionCycle(input);
    await this.#hydrateFromPostgres();
    const message = super.getDelegatedWorkMessage(
      input.message?.missionId,
      input.message?.clientMessageId,
    );
    if (!message) throw new Error('PostgreSQL revision message was not hydrated after commit');
    const state = super.getState();
    const task = state.tasks.find((item) => item.id === input.task?.id) || null;
    const session = state.agentSessions.find((item) => item.id === input.session?.id) || null;
    const mission = state.agentMissions.find((item) => item.id === input.message?.missionId) || null;
    return {
      message,
      delivery: deliveryFromEvent(message),
      idempotentReplay: persisted.idempotentReplay,
      mission,
      task,
      session,
      revisionId: task?.revisionId || message.metadata?.revisionId || '',
      revisionNumber: task?.revisionNumber || 0,
    };
  }

  async completeRevisionCycle(input = {}) {
    await this.ready;
    await this.#persistRevisionCompletion(input);
    await this.#hydrateFromPostgres();
    const state = super.getState();
    return {
      mission: state.agentMissions.find((item) => item.id === input.missionId) || null,
      report: state.agentReports.find((item) => item.id === input.report?.id) || null,
      previousReport: state.agentReports.find((item) => item.id === input.task?.revisesReportId) || null,
      event: state.agentSessionEvents.find((item) => item.id === input.event?.id) || null,
    };
  }

  async refreshAgentOperations() {
    await this.ready;
    await Promise.all([
      ...this.taskPersistChains.values(),
      ...this.agentSessionPersistChains.values(),
    ]);
    await this.#hydrateFromPostgres();
  }

  async refreshAgentWork() {
    return this.refreshAgentOperations();
  }

  restoreAgent(agentId) {
    const result = super.restoreAgent(agentId);
    if (result) this.#upsertStateMeta('deletedAgentIds', this.getState().deletedAgentIds || []);
    return result;
  }

  createAgentMission(input = {}) {
    const mission = super.createAgentMission(input);
    this.#upsertAgentMission(mission);
    return mission;
  }

  updateAgentMission(missionId, patch = {}) {
    const mission = super.updateAgentMission(missionId, patch);
    if (mission) this.#upsertAgentMission(mission);
    return mission;
  }

  createAgentSession(input = {}) {
    const session = super.createAgentSession(input);
    this.#upsertAgentSession(session);
    if (session.taskId) {
      const task = super.getState().tasks.find((item) => item.id === session.taskId);
      if (task) this.#upsertTask(task);
    }
    return session;
  }

  updateAgentSession(sessionId, patch = {}) {
    const session = super.updateAgentSession(sessionId, patch);
    if (session && !this.suppressAgentWorkPersistence) this.#upsertAgentSession(session);
    return session;
  }

  appendAgentSessionEvent(sessionId, input = {}) {
    const event = super.appendAgentSessionEvent(sessionId, input);
    if (!this.suppressAgentWorkPersistence) this.#insertAgentSessionEvent(event);
    const session = super.getAgentSession(sessionId);
    if (session && !this.suppressAgentWorkPersistence) this.#upsertAgentSession(session);
    return event;
  }

  updateAgentSessionEvent(eventId, patch = {}) {
    const event = super.updateAgentSessionEvent(eventId, patch);
    if (event && !this.suppressAgentWorkPersistence) this.#insertAgentSessionEvent(event);
    return event;
  }

  createAgentReport(input = {}) {
    const report = super.createAgentReport(input);
    this.#upsertAgentReport(report);
    return report;
  }

  updateAgentReport(reportId, patch = {}) {
    const report = super.updateAgentReport(reportId, patch);
    if (report) this.#upsertAgentReport(report);
    return report;
  }

  createTask(input = {}) {
    const task = super.createTask(input);
    this.#upsertTask(task);
    return task;
  }

  async waitForTaskPersistence(taskId) {
    const pending = this.taskPersistChains.get(taskId);
    if (pending) await pending;
  }

  updateTask(taskId, patch = {}) {
    const task = super.updateTask(taskId, patch);
    if (task && !this.suppressAgentWorkPersistence) {
      this.#upsertTask(task);
    }
    return task;
  }

  async claimAgentTask(taskId, patch = {}) {
    const pendingPersistence = this.taskPersistChains.get(taskId);
    if (pendingPersistence) await pendingPersistence;
    const current = super.getState().tasks.find((task) => task.id === taskId);
    if (!current || current.status !== 'scheduled') return null;
    const claimedPayload = {
      ...current,
      ...patch,
      status: 'running',
      attempt: Number.isFinite(Number(patch.attempt)) ? Number(patch.attempt) : Number(current.attempt || 0),
      updatedAt: this.clock().toISOString(),
    };
    const result = await this.#query(
      `update tasks
       set status = $2, payload = $3::jsonb, updated_at = now()
       where id = $1 and status = 'scheduled'
       returning id`,
      [taskId, 'running', JSON.stringify(claimedPayload)],
    );
    if (!result || !Array.isArray(result.rows) || !result.rows.length) return null;
    return super.updateTask(taskId, { ...patch, status: 'running' });
  }

  deleteTask(taskId) {
    const task = super.deleteTask(taskId);
    if (task) this.#deleteTask(taskId);
    return task;
  }

  createCalendarEvent(input = {}) {
    const event = super.createCalendarEvent(input);
    this.#upsertCalendarEvent(event);
    return event;
  }

  updateCalendarEvent(eventId, patch = {}) {
    const event = super.updateCalendarEvent(eventId, patch);
    if (event) this.#upsertCalendarEvent(event);
    return event;
  }

  deleteCalendarEvent(eventId) {
    const event = super.deleteCalendarEvent(eventId);
    if (event) this.#deleteCalendarEvent(eventId);
    return event;
  }

  migrateCalendarTasksToEvents() {
    const migrated = super.migrateCalendarTasksToEvents();
    migrated.forEach((event) => this.#upsertCalendarEvent(event));
    migrated.forEach((event) => {
      if (event.taskId) this.#deleteTask(event.taskId);
    });
    return migrated;
  }

  createRun(input = {}) {
    const run = super.createRun(input);
    this.#upsertRun(run);
    (run.logs || []).forEach((line) => this.#insertRunLog(run.id, line));
    return run;
  }

  saveRun(input = {}) {
    const run = super.saveRun(input);
    this.#upsertRun(run);
    (run.logs || []).forEach((line) => this.#insertRunLog(run.id, line));
    return run;
  }

  updateRunStatus(runId, status) {
    const run = super.updateRunStatus(runId, status);
    if (run) this.#upsertRun(run);
    return run;
  }

  appendRunLog(runId, line) {
    const run = super.appendRunLog(runId, line);
    if (run) {
      this.#upsertRun(run);
      this.#insertRunLog(runId, line);
    }
    return run;
  }

  updateRunFile(runId, relativePath) {
    const run = super.updateRunFile(runId, relativePath);
    if (run) {
      this.#upsertRun(run);
      this.#upsertWikiArtifact(run);
    }
    return run;
  }

  addChatMessage(input = {}) {
    const message = super.addChatMessage(input);
    this.#insertChatMessage(message);
    return message;
  }

  createDocument(input = {}) {
    const document = super.createDocument(input);
    this.#upsertDocument(document);
    return document;
  }

  async indexDocumentChunks(document = {}) {
    const chunks = chunksFromDocument(document);
    if (!document.id && !chunks.length) return { indexed: 0 };
    await this.#query('delete from wiki_chunks where source = $1 and source_id = $2', ['document', document.id || document.wikiPath || document.title || '']);
    for (const chunk of chunks) {
      await this.#upsertWikiChunk(chunk);
    }
    return { indexed: chunks.length };
  }

  async indexWikiNotes(notes = []) {
    const chunks = chunksFromWikiNotes(notes);
    for (const chunk of chunks) {
      await this.#upsertWikiChunk(chunk);
    }
    return { indexed: chunks.length };
  }

  async searchWikiChunks(question = '', options = {}) {
    const pathPrefix = String(options.path || '').trim();
    const limit = Math.max(1, Number(options.limit) || 5);
    const queryVector = vectorLiteral(chunksFromWikiNotes([{ title: 'query', content: question }])[0]?.embedding || []);
    const result = await this.#query(
      `select id, source, source_id, document_id, path, title, chunk_index, content, excerpt, embedding, metadata, updated_at,
         case when embedding_vector is null then 1 else embedding_vector <=> $2::vector end as vector_distance
       from wiki_chunks
       where ($1 = '' or path = $1 or path like ($1 || '/%'))
       order by vector_distance asc, updated_at desc
       limit 800`,
      [pathPrefix, queryVector],
    );
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    return rankWikiChunks(question, rows.map((row) => ({
      id: row.id,
      source: row.source,
      sourceId: row.source_id,
      documentId: row.document_id,
      path: row.path,
      title: row.title,
      chunkIndex: row.chunk_index,
      content: row.content,
      excerpt: row.excerpt,
      embedding: row.embedding,
      metadata: safeJson(row.metadata),
      updatedAt: row.updated_at,
    })), { limit, path: pathPrefix });
  }

  importTickTickTasksAsNative(tasks = [], options = {}) {
    const result = super.importTickTickTasksAsNative(tasks, options);
    this.#upsertStateMeta('ticktickReplacement', result.replacement);
    return result;
  }

  importTickTickTasks(tasks = []) {
    const imported = super.importTickTickTasks(tasks);
    this.#upsertStateMeta('ticktickTasks', super.getState().ticktickTasks || []);
    return imported;
  }

  importCalendarEvents(events = []) {
    const imported = super.importCalendarEvents(events);
    this.#upsertStateMeta('events', super.getState().events || []);
    return imported;
  }

  importExternalCalendarEvents(events = []) {
    const imported = super.importExternalCalendarEvents(events);
    this.#upsertStateMeta('externalCalendarEvents', super.getState().externalCalendarEvents || []);
    return imported;
  }

  importMailMessages(messages = []) {
    const imported = super.importMailMessages(messages);
    this.#upsertStateMeta('mailMessages', super.getState().mailMessages || []);
    return imported;
  }

  archiveCommandInboxItem(itemId) {
    const archived = super.archiveCommandInboxItem(itemId);
    this.#upsertStateMeta('commandInboxArchivedIds', archived || []);
    return archived;
  }

  setCommandInboxItemStarred(itemId, starred = true) {
    const starredIds = super.setCommandInboxItemStarred(itemId, starred);
    this.#upsertStateMeta('commandInboxStarredIds', starredIds || []);
    return starredIds;
  }

  setMailSyncStatus(status = {}) {
    const mailSyncStatus = super.setMailSyncStatus(status);
    this.#upsertStateMeta('mailSyncStatus', mailSyncStatus);
    return mailSyncStatus;
  }

  setTelegramWebhookStatus(input = {}) {
    const telegramWebhook = super.setTelegramWebhookStatus(input);
    this.#upsertStateMeta('telegramWebhook', telegramWebhook);
    return telegramWebhook;
  }

  setDaemonStatus(status = {}) {
    const daemon = super.setDaemonStatus(status);
    this.#upsertStateMeta('daemon', daemon);
    return daemon;
  }

  async #hydrateFromPostgres() {
    const [
      agents,
      tasks,
      events,
      runs,
      chatMessages,
      documents,
      schedulerJobs,
      workboardPages,
      agentMissions,
      agentSessions,
      agentSessionEvents,
      agentReports,
      stateMeta,
    ] = await Promise.all([
      this.#selectPayloads('agents', 'created_at asc'),
      this.#selectPayloads('tasks', 'created_at desc'),
      this.#selectPayloads('calendar_events', 'starts_at asc, updated_at desc'),
      this.#selectPayloads('runs', 'created_at desc'),
      this.#selectPayloads('chat_messages', 'created_at asc'),
      this.#selectPayloads('documents', 'created_at desc'),
      this.#selectPayloads('scheduler_jobs', 'created_at desc'),
      this.#selectPayloads('workboard_pages', 'updated_at desc'),
      this.#selectPayloads('agent_missions', 'created_at desc'),
      this.#selectPayloads('agent_sessions', 'created_at desc'),
      this.#selectPayloads('agent_session_events', 'session_id asc, sequence asc'),
      this.#selectPayloads('agent_reports', 'created_at desc'),
      this.#selectStateMeta(),
    ]);
    const now = this.clock().toISOString();
    const fallbackState = super.getState();
    const state = {
      ...createDefaultState(now),
      ...fallbackState,
      agents,
      tasks,
      events: mergeRecordsById(events, Array.isArray(stateMeta.events) ? stateMeta.events : []),
      runs,
      chatMessages,
      documents,
      schedulerJobs,
      workboardPages,
      agentMissions,
      agentSessions,
      agentSessionEvents,
      agentReports,
      ...(Array.isArray(stateMeta.deletedAgentIds) ? { deletedAgentIds: stateMeta.deletedAgentIds } : {}),
      ...(Array.isArray(stateMeta.ticktickTasks) ? { ticktickTasks: stateMeta.ticktickTasks } : {}),
      ...(Array.isArray(stateMeta.externalCalendarEvents) ? { externalCalendarEvents: stateMeta.externalCalendarEvents } : {}),
      ...(Array.isArray(stateMeta.mailMessages) ? { mailMessages: stateMeta.mailMessages } : {}),
      ...(Array.isArray(stateMeta.commandInboxArchivedIds) ? { commandInboxArchivedIds: stateMeta.commandInboxArchivedIds } : {}),
      ...(Array.isArray(stateMeta.commandInboxStarredIds) ? { commandInboxStarredIds: stateMeta.commandInboxStarredIds } : {}),
      ...(stateMeta.mailSyncStatus ? { mailSyncStatus: stateMeta.mailSyncStatus } : {}),
      ...(stateMeta.telegramWebhook ? { telegramWebhook: stateMeta.telegramWebhook } : {}),
      ...(stateMeta.daemon ? { daemon: stateMeta.daemon } : {}),
      ...(stateMeta.ticktickReplacement ? { ticktickReplacement: stateMeta.ticktickReplacement } : {}),
      meta: {
        ...(fallbackState.meta || {}),
        updatedAt: now,
      },
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async #selectPayloads(table, orderBy) {
    const result = await this.#query(`select payload from ${table} order by ${orderBy}`);
    return (result && Array.isArray(result.rows) ? result.rows : [])
      .map((row) => safeJson(row.payload))
      .filter((row) => row && typeof row === 'object' && Object.keys(row).length > 0);
  }

  async #selectStateMeta() {
    const result = await this.#query('select key, payload from state_meta');
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    return Object.fromEntries(rows.map((row) => [String(row.key || ''), safeJson(row.payload)]).filter(([key]) => key));
  }

  async #persistDelegatedWork({ mission, conversation, message } = {}) {
    if (!this.pool || typeof this.pool.connect !== 'function') {
      throw new Error('PostgreSQL pool does not support awaited transactions');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [mission.clientRequestId]);
      const existing = await client.query(
        'select payload from agent_missions where id = $1 for update',
        [mission.id],
      );
      const existingMission = safeJson(existing?.rows?.[0]?.payload);
      const idempotentReplay = Object.keys(existingMission).length > 0;
      if (idempotentReplay) {
        if (existingMission.requestFingerprint !== mission.requestFingerprint) {
          throw new AgentWorkContractError(
            'work_idempotency_conflict',
            'clientRequestId was already used for different work',
            409,
          );
        }
        if (existingMission.missionThreadId !== conversation.id) {
          throw new AgentWorkContractError(
            'work_persistence_incomplete',
            'Delegated work points to a different Work Conversation',
            500,
          );
        }
      } else {
        await client.query(
          `insert into agent_missions (id, status, agent_id, report_due_at, payload, created_at, updated_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())`,
          [
            mission.id,
            mission.status || 'draft',
            mission.agentId || '',
            mission.reportDueAt || '',
            JSON.stringify(safeJson(mission)),
            mission.createdAt,
          ],
        );
      }
      const existingSessionResult = await client.query(
        'select payload from agent_sessions where id = $1 for update',
        [conversation.id],
      );
      const existingConversation = safeJson(existingSessionResult?.rows?.[0]?.payload);
      const hasConversation = Object.keys(existingConversation).length > 0;
      if (
        hasConversation
        && (
          existingConversation.missionId !== mission.id
          || existingConversation.type !== 'mission-thread'
        )
      ) {
        throw new AgentWorkContractError(
          'work_persistence_incomplete',
          'Stored Work Conversation does not match the Delegated Work',
          500,
        );
      }
      if (!hasConversation) {
        await client.query(
          `insert into agent_sessions (id, mission_id, task_id, status, payload, created_at, updated_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())`,
          [
            conversation.id,
            conversation.missionId,
            conversation.taskId || '',
            conversation.status || 'draft',
            JSON.stringify(safeJson(conversation)),
            conversation.createdAt,
          ],
        );
      }
      const existingEventResult = await client.query(
        'select payload from agent_session_events where id = $1 for update',
        [message.id],
      );
      const existingMessage = safeJson(existingEventResult?.rows?.[0]?.payload);
      const hasMessage = Object.keys(existingMessage).length > 0;
      if (
        hasMessage
        && (
          existingMessage.sessionId !== conversation.id
          || existingMessage.kind !== 'user_message'
          || existingMessage.text !== message.text
        )
      ) {
        throw new AgentWorkContractError(
          'work_persistence_incomplete',
          'Stored initial message does not match the Delegated Work',
          500,
        );
      }
      if (!hasMessage) {
        await client.query(
          `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
          [
            message.id,
            message.sessionId,
            Number(message.sequence),
            message.kind,
            JSON.stringify(safeJson(message)),
            message.createdAt,
          ],
        );
      }
      await client.query('commit');
      return {
        idempotentReplay,
        records: {
          mission: idempotentReplay ? existingMission : mission,
          conversation: hasConversation ? existingConversation : conversation,
          message: hasMessage ? existingMessage : message,
        },
      };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        const combined = new Error(`PostgreSQL rollback failed: ${rollbackError.message}`);
        combined.cause = error;
        throw combined;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #persistDelegatedWorkMessage({ conversation, event } = {}) {
    if (!conversation || !this.pool || typeof this.pool.connect !== 'function') {
      throw new Error('PostgreSQL Work Conversation persistence is unavailable');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [conversation.id]);
      const existingResult = await client.query(
        'select payload from agent_session_events where id = $1 for update',
        [event.id],
      );
      const existing = safeJson(existingResult?.rows?.[0]?.payload);
      if (Object.keys(existing).length > 0) {
        if (
          existing.sessionId !== conversation.id
          || existing.kind !== 'user_message'
          || existing.text !== event.text
          || existing.metadata?.clientMessageId !== event.metadata?.clientMessageId
        ) {
          throw new AgentWorkContractError(
            'work_message_idempotency_conflict',
            'clientMessageId was already used for different text',
            409,
          );
        }
        await client.query('commit');
        return { event: existing, idempotentReplay: true };
      }
      const sequenceResult = await client.query(
        `select coalesce(max(sequence), 0) as max_sequence
           from agent_session_events
          where session_id = $1`,
        [conversation.id],
      );
      const maximumSequence = Number(sequenceResult?.rows?.[0]?.max_sequence);
      const authoritativeEvent = {
        ...event,
        sequence: Number.isFinite(maximumSequence)
          ? maximumSequence + 1
          : Number(event.sequence),
      };
      await client.query(
        `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         returning payload`,
        [
          authoritativeEvent.id,
          authoritativeEvent.sessionId,
          Number(authoritativeEvent.sequence),
          authoritativeEvent.kind,
          JSON.stringify(safeJson(authoritativeEvent)),
          authoritativeEvent.createdAt,
        ],
      );
      await client.query('commit');
      return { event: authoritativeEvent, idempotentReplay: false };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        const combined = new Error(`PostgreSQL rollback failed: ${rollbackError.message}`);
        combined.cause = error;
        throw combined;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #persistRevisionCycle(input = {}) {
    if (!this.pool || typeof this.pool.connect !== 'function') {
      throw new Error('PostgreSQL revision transaction is unavailable');
    }
    const messageInput = input.message || {};
    const localState = super.getState();
    const localMission = localState.agentMissions.find((item) => item.id === messageInput.missionId);
    const conversation = localState.agentSessions.find((item) => (
      item.id === localMission?.missionThreadId && item.type === 'mission-thread'
    ));
    if (!localMission || !conversation) {
      throw new AgentWorkContractError('work_not_found', 'Delegated work was not found', 404);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [localMission.id]);
      const existingMessageResult = await client.query(
        'select payload from agent_session_events where id = $1 for update',
        [messageInput.eventId],
      );
      const existingMessage = safeJson(existingMessageResult?.rows?.[0]?.payload);
      if (Object.keys(existingMessage).length > 0) {
        if (
          existingMessage.sessionId !== conversation.id
          || existingMessage.text !== messageInput.text
          || existingMessage.metadata?.clientMessageId !== messageInput.clientMessageId
        ) {
          throw new AgentWorkContractError(
            'work_message_idempotency_conflict',
            'clientMessageId was already used for different text',
            409,
          );
        }
        await client.query('commit');
        return { idempotentReplay: true };
      }
      const missionResult = await client.query(
        'select payload from agent_missions where id = $1 for update',
        [localMission.id],
      );
      const mission = safeJson(missionResult?.rows?.[0]?.payload);
      if (!Object.keys(mission).length) {
        throw new AgentWorkContractError('work_not_found', 'Delegated work was not found', 404);
      }
      if (mission.pendingRevisionId) {
        throw new AgentWorkContractError(
          'revision_already_pending',
          'Complete or retry the pending revision before starting another',
          409,
        );
      }
      if (mission.currentResultReportId !== input.baseReportId) {
        throw new AgentWorkContractError(
          'revision_result_required',
          'The current result changed before the revision could be created',
          409,
        );
      }
      const sequenceResult = await client.query(
        `select coalesce(max(sequence), 0) as max_sequence
           from agent_session_events
          where session_id = $1`,
        [conversation.id],
      );
      const maximumSequence = Number(sequenceResult?.rows?.[0]?.max_sequence);
      const message = {
        id: messageInput.eventId,
        sessionId: conversation.id,
        sequence: Number.isFinite(maximumSequence) ? maximumSequence + 1 : Number(messageInput.sequence || 2),
        kind: 'user_message',
        text: messageInput.text,
        createdAt: messageInput.acceptedAt,
        metadata: {
          clientMessageId: messageInput.clientMessageId,
          ...deliveryMetadata(input.delivery, messageInput.acceptedAt),
        },
      };
      const now = messageInput.acceptedAt;
      const task = { ...input.task, sessionId: input.session.id, createdAt: input.task.createdAt || now, updatedAt: now };
      const session = { ...input.session, taskId: task.id, createdAt: input.session.createdAt || now, updatedAt: now };
      const events = (input.events || []).map((event, index) => ({
        ...event,
        sessionId: session.id,
        sequence: index + 1,
        createdAt: event.createdAt || now,
      }));
      const updatedMission = { ...mission, ...input.missionPatch, updatedAt: now };

      await client.query(
        `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, now())`,
        [
          task.id,
          task.title,
          task.status,
          task.owner,
          task.dueAt || '',
          task.missionId,
          task.sessionId,
          JSON.stringify(safeJson(task)),
          task.createdAt,
        ],
      );
      await client.query(
        `insert into agent_sessions (id, mission_id, task_id, status, payload, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())`,
        [session.id, session.missionId, session.taskId, session.status, JSON.stringify(safeJson(session)), session.createdAt],
      );
      for (const event of events) {
        await client.query(
          `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
          [event.id, event.sessionId, event.sequence, event.kind, JSON.stringify(safeJson(event)), event.createdAt],
        );
      }
      await client.query(
        `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
        [message.id, message.sessionId, message.sequence, message.kind, JSON.stringify(safeJson(message)), message.createdAt],
      );
      await client.query(
        `insert into agent_missions (id, status, agent_id, report_due_at, payload, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())
         on conflict (id) do update set
           status = excluded.status,
           agent_id = excluded.agent_id,
           report_due_at = excluded.report_due_at,
           payload = excluded.payload,
           updated_at = now()`,
        [
          updatedMission.id,
          updatedMission.status,
          updatedMission.agentId || '',
          updatedMission.reportDueAt || '',
          JSON.stringify(safeJson(updatedMission)),
          updatedMission.createdAt,
        ],
      );
      await client.query('commit');
      return { idempotentReplay: false };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        const combined = new Error(`PostgreSQL rollback failed: ${rollbackError.message}`);
        combined.cause = error;
        throw combined;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #persistRevisionCompletion({ missionId, task, report, event } = {}) {
    if (!this.pool || typeof this.pool.connect !== 'function') {
      throw new Error('PostgreSQL revision completion transaction is unavailable');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [missionId]);
      const missionResult = await client.query(
        'select payload from agent_missions where id = $1 for update',
        [missionId],
      );
      const previousResult = await client.query(
        'select payload from agent_reports where id = $1 for update',
        [task?.revisesReportId],
      );
      const mission = safeJson(missionResult?.rows?.[0]?.payload);
      const previous = safeJson(previousResult?.rows?.[0]?.payload);
      const current = safeJson(report);
      if (
        !Object.keys(mission).length
        || !Object.keys(previous).length
        || !Object.keys(current).length
        || mission.pendingRevisionId !== task?.revisionId
        || mission.currentResultReportId !== previous.id
        || current.taskId !== task?.id
      ) {
        throw new AgentWorkContractError(
          'revision_completion_invalid',
          'Revision completion records do not match the pending revision',
          409,
        );
      }
      const completedAt = event.createdAt || this.clock().toISOString();
      const previousReport = { ...previous, supersededByReportId: current.id, updatedAt: completedAt };
      const updatedReport = { ...current, supersedesReportId: previous.id, updatedAt: completedAt };
      const updatedMission = {
        ...mission,
        pendingRevisionId: '',
        currentResultReportId: current.id,
        updatedAt: completedAt,
      };
      const sequenceResult = await client.query(
        `select coalesce(max(sequence), 0) as max_sequence
           from agent_session_events
          where session_id = $1`,
        [task.sessionId],
      );
      const completionEvent = {
        ...event,
        sessionId: task.sessionId,
        sequence: Number(sequenceResult?.rows?.[0]?.max_sequence || 0) + 1,
        createdAt: completedAt,
      };
      for (const value of [previousReport, updatedReport]) {
        await client.query(
          `insert into agent_reports (id, mission_id, session_id, status, payload, created_at, updated_at)
           values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())
           on conflict (id) do update set
             status = excluded.status,
             payload = excluded.payload,
             updated_at = now()`,
          [
            value.id,
            value.missionId,
            value.sessionId || '',
            value.status || 'ready',
            JSON.stringify(safeJson(value)),
            value.createdAt,
          ],
        );
      }
      await client.query(
        `insert into agent_missions (id, status, agent_id, report_due_at, payload, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, now())
         on conflict (id) do update set
           status = excluded.status,
           agent_id = excluded.agent_id,
           report_due_at = excluded.report_due_at,
           payload = excluded.payload,
           updated_at = now()`,
        [
          updatedMission.id,
          updatedMission.status,
          updatedMission.agentId || '',
          updatedMission.reportDueAt || '',
          JSON.stringify(safeJson(updatedMission)),
          updatedMission.createdAt,
        ],
      );
      await client.query(
        `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
        [
          completionEvent.id,
          completionEvent.sessionId,
          completionEvent.sequence,
          completionEvent.kind,
          JSON.stringify(safeJson(completionEvent)),
          completionEvent.createdAt,
        ],
      );
      await client.query('commit');
    } catch (error) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        const combined = new Error(`PostgreSQL rollback failed: ${rollbackError.message}`);
        combined.cause = error;
        throw combined;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  #query(sql, values = []) {
    try {
      const result = this.pool.query(sql, values);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => this.persistErrors.push(error.message));
      }
      return result;
    } catch (error) {
      this.persistErrors.push(error.message);
      return null;
    }
  }

  #upsertAgent(agent) {
    this.#query(
      `insert into agents (id, payload, created_at, updated_at)
       values ($1, $2::jsonb, coalesce($3::timestamptz, now()), now())
       on conflict (id) do update set payload = excluded.payload, updated_at = now()
       returning payload`,
      [agent.id, JSON.stringify(safeJson(agent)), agent.createdAt || null],
    );
  }

  #upsertAgentMission(mission) {
    this.#query(
      `insert into agent_missions (id, status, agent_id, report_due_at, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), now())
       on conflict (id) do update set
         status = excluded.status,
         agent_id = excluded.agent_id,
         report_due_at = excluded.report_due_at,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        mission.id,
        mission.status || 'draft',
        mission.agentId || '',
        mission.reportDueAt || '',
        JSON.stringify(safeJson(mission)),
        mission.createdAt || null,
      ],
    );
  }

  #upsertAgentSession(session) {
    const payload = { ...session };
    delete payload.events;
    const snapshot = JSON.parse(JSON.stringify(safeJson(payload)));
    return this.#queueAgentSessionPersistence(session.id, () => this.#writeAgentSession(snapshot));
  }

  #queueAgentSessionPersistence(sessionId, operation) {
    const previous = this.agentSessionPersistChains.get(sessionId);
    const pending = previous
      ? previous.then(operation, operation)
      : Promise.resolve(operation());
    const tracked = pending.catch(() => null);
    this.agentSessionPersistChains.set(sessionId, tracked);
    tracked.then(() => {
      if (this.agentSessionPersistChains.get(sessionId) === tracked) {
        this.agentSessionPersistChains.delete(sessionId);
      }
    });
    return tracked;
  }

  #writeAgentSession(session) {
    return this.#query(
      `insert into agent_sessions (id, mission_id, task_id, status, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), now())
       on conflict (id) do update set
         mission_id = excluded.mission_id,
         task_id = excluded.task_id,
         status = excluded.status,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        session.id,
        session.missionId || '',
        session.taskId || '',
        session.status || 'proposed',
        JSON.stringify(safeJson(session)),
        session.createdAt || null,
      ],
    );
  }

  #insertAgentSessionEvent(event) {
    this.#query(
      `insert into agent_session_events (id, session_id, sequence, kind, payload, created_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()))
       on conflict (id) do update set payload = excluded.payload
       returning payload`,
      [
        event.id,
        event.sessionId,
        Number(event.sequence),
        event.kind || 'progress',
        JSON.stringify(safeJson(event)),
        event.createdAt || null,
      ],
    );
  }

  #upsertAgentReport(report) {
    this.#query(
      `insert into agent_reports (id, mission_id, session_id, status, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), now())
       on conflict (id) do update set
         mission_id = excluded.mission_id,
         session_id = excluded.session_id,
         status = excluded.status,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        report.id,
        report.missionId || '',
        report.sessionId || '',
        report.status || 'ready',
        JSON.stringify(safeJson(report)),
        report.createdAt || null,
      ],
    );
  }

  #upsertTask(task) {
    const snapshot = JSON.parse(JSON.stringify(safeJson(task)));
    return this.#queueTaskPersistence(snapshot.id, () => this.#writeTask(snapshot));
  }

  #queueTaskPersistence(taskId, operation) {
    const previous = this.taskPersistChains.get(taskId);
    const pending = previous
      ? previous.then(operation, operation)
      : Promise.resolve(operation());
    this.taskPersistChains.set(taskId, pending);
    pending.catch(() => null).then(() => {
      if (this.taskPersistChains.get(taskId) === pending) {
        this.taskPersistChains.delete(taskId);
      }
    });
    return pending;
  }

  #writeTask(task) {
    return this.#query(
      `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, coalesce($9::timestamptz, now()), now())
       on conflict (id) do update set
         title = excluded.title,
         status = excluded.status,
         owner = excluded.owner,
         due_at = excluded.due_at,
         mission_id = excluded.mission_id,
         session_id = excluded.session_id,
         payload = excluded.payload,
         updated_at = now()
       where not (
         tasks.payload ->> 'origin' = 'agent'
         and tasks.status in ('running', 'completed', 'cancelled')
         and excluded.status in ('proposed', 'approved', 'scheduled')
       )
       returning payload`,
      [
        task.id,
        task.title || '',
        task.status || '',
        task.owner || '',
        task.due || '',
        task.missionId || '',
        task.sessionId || '',
        JSON.stringify(safeJson(task)),
        task.createdAt || null,
      ],
    );
  }

  #upsertStateMeta(key, payload) {
    this.#query(
      `insert into state_meta (key, payload, created_at, updated_at)
       values ($1, $2::jsonb, now(), now())
       on conflict (key) do update set payload = excluded.payload, updated_at = now()
       returning payload`,
      [String(key || ''), JSON.stringify(safeJson(payload))],
    );
  }

  #deleteTask(taskId) {
    return this.#queueTaskPersistence(
      taskId,
      () => this.#query('delete from tasks where id = $1', [taskId]),
    );
  }

  #deleteAgent(agent = {}) {
    const ids = [
      agent.id,
      agent.displayName,
      agent.name,
      agent.agentIdentity?.id,
      agent.agentIdentity?.displayName,
      agent.runtimeBinding?.agentKey,
      agent.profile?.name,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (!ids.length) return;
    this.#query('delete from agents where id = any($1::text[])', [ids]);
  }

  createSchedulerJob(input = {}) {
    const job = super.createSchedulerJob(input);
    this.#upsertSchedulerJob(job);
    return job;
  }

  updateSchedulerJob(jobId, patch = {}) {
    const job = super.updateSchedulerJob(jobId, patch);
    if (job) this.#upsertSchedulerJob(job);
    return job;
  }

  deleteSchedulerJob(jobId) {
    const job = super.deleteSchedulerJob(jobId);
    if (job) this.#deleteSchedulerJob(jobId);
    return job;
  }

  createWorkboardPage(input = {}) {
    const page = super.createWorkboardPage(input);
    this.#upsertWorkboardPage(page);
    return page;
  }

  updateWorkboardPage(pageId, patch = {}) {
    const page = super.updateWorkboardPage(pageId, patch);
    if (page) this.#upsertWorkboardPage(page);
    return page;
  }

  deleteWorkboardPage(pageId) {
    const page = super.deleteWorkboardPage(pageId);
    if (page) this.#deleteWorkboardPage(pageId);
    return page;
  }

  #upsertCalendarEvent(event) {
    this.#query(
      `insert into calendar_events (id, task_id, title, starts_at, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), now())
       on conflict (id) do update set
         task_id = excluded.task_id,
         title = excluded.title,
         starts_at = excluded.starts_at,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        event.id,
        event.taskId || null,
        event.title || '',
        [event.date || event.startDate, event.time].filter(Boolean).join(' '),
        JSON.stringify(event),
        event.createdAt || null,
      ],
    );
  }

  #deleteCalendarEvent(eventId) {
    this.#query('delete from calendar_events where id = $1', [eventId]);
  }

  #upsertRun(run) {
    this.#query(
      `insert into runs (id, goal, agent, model, status, wiki_path, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now()), now())
       on conflict (id) do update set
         goal = excluded.goal,
         agent = excluded.agent,
         model = excluded.model,
         status = excluded.status,
         wiki_path = excluded.wiki_path,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        run.id,
        run.goal || '',
        run.agent || '',
        run.model || '',
        run.status || '',
        run.file || run.wikiWriteBack || '',
        JSON.stringify(safeJson(run)),
        run.createdAt || null,
      ],
    );
  }

  #insertRunLog(runId, line) {
    this.#query(
      `insert into run_logs (run_id, line, payload)
       values ($1, $2, $3::jsonb)
       returning payload`,
      [runId, String(line || ''), JSON.stringify({ runId, line: String(line || '') })],
    );
  }

  #insertChatMessage(message) {
    this.#query(
      `insert into chat_messages (id, role, text, run_id, payload, created_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()))
       on conflict (id) do update set payload = excluded.payload`,
      [
        message.id,
        message.role || '',
        message.text || '',
        message.runId || '',
        JSON.stringify(safeJson(message)),
        message.createdAt || null,
      ],
    );
  }

  #upsertDocument(document) {
    this.#query(
      `insert into documents (id, title, path, source, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()), coalesce($7::timestamptz, now()))
       on conflict (id) do update set
         title = excluded.title,
         path = excluded.path,
         source = excluded.source,
         payload = excluded.payload,
         updated_at = excluded.updated_at
       returning payload`,
      [
        document.id,
        document.title || document.name || '',
        document.wikiPath || document.path || '',
        document.source || '',
        JSON.stringify(safeJson(document)),
        document.createdAt || null,
        document.updatedAt || null,
      ],
    );
  }

  async #upsertWikiChunk(chunk) {
    return this.#query(
      `insert into wiki_chunks (
         id, source, source_id, document_id, path, title, chunk_index, content, excerpt,
         embedding, embedding_vector, embedding_model, metadata, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::vector, $12, $13::jsonb, now(), now())
       on conflict (id) do update set
         source = excluded.source,
         source_id = excluded.source_id,
         document_id = excluded.document_id,
         path = excluded.path,
         title = excluded.title,
         chunk_index = excluded.chunk_index,
         content = excluded.content,
         excerpt = excluded.excerpt,
         embedding = excluded.embedding,
         embedding_vector = excluded.embedding_vector,
         embedding_model = excluded.embedding_model,
         metadata = excluded.metadata,
         updated_at = now()
       returning id`,
      [
        chunk.id,
        chunk.source || '',
        chunk.sourceId || '',
        chunk.documentId || null,
        chunk.path || '',
        chunk.title || '',
        Number(chunk.chunkIndex) || 0,
        chunk.content || '',
        chunk.excerpt || '',
        JSON.stringify(Array.isArray(chunk.embedding) ? chunk.embedding : []),
        vectorLiteral(chunk.embedding),
        'hermes-hash-embedding-v1',
        JSON.stringify(safeJson(chunk.metadata)),
      ],
    );
  }

  #upsertSchedulerJob(job) {
    this.#query(
      `insert into scheduler_jobs (id, name, agent, model, enabled, interval_minutes, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now()), now())
       on conflict (id) do update set
         name = excluded.name,
         agent = excluded.agent,
         model = excluded.model,
         enabled = excluded.enabled,
         interval_minutes = excluded.interval_minutes,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        job.id,
        job.name || '',
        job.agent || '',
        job.model || '',
        job.enabled !== false,
        Math.max(1, Math.round(Number(job.intervalMinutes) || 60)),
        JSON.stringify(safeJson(job)),
        job.createdAt || null,
      ],
    );
  }

  #deleteSchedulerJob(jobId) {
    this.#query('delete from scheduler_jobs where id = $1', [jobId]);
  }

  #upsertWorkboardPage(page) {
    this.#query(
      `insert into workboard_pages (id, title, payload, created_at, updated_at)
       values ($1, $2, $3::jsonb, coalesce($4::timestamptz, now()), coalesce($5::timestamptz, now()))
       on conflict (id) do update set
         title = excluded.title,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [
        page.id,
        page.title || '',
        JSON.stringify(safeJson(page)),
        page.createdAt || null,
        page.updatedAt || null,
      ],
    );
  }

  #deleteWorkboardPage(pageId) {
    this.#query('delete from workboard_pages where id = $1', [pageId]);
  }

  #upsertWikiArtifact(run) {
    const pathValue = run.file || run.wikiWriteBack || '';
    if (!pathValue) return;
    this.#query(
      `insert into wiki_artifacts (id, run_id, path, status, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, now(), now())
       on conflict (id) do update set
         path = excluded.path,
         status = excluded.status,
         payload = excluded.payload,
         updated_at = now()
       returning payload`,
      [`run:${run.id}`, run.id, pathValue, run.status || 'running', JSON.stringify({ runId: run.id, path: pathValue })],
    );
  }
}

module.exports = {
  PostgresHermesStore,
  createPool,
};
