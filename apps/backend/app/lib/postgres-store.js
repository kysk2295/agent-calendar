const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrations } = require('../db/migrate');
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
    if (session) this.#upsertAgentSession(session);
    return session;
  }

  appendAgentSessionEvent(sessionId, input = {}) {
    const event = super.appendAgentSessionEvent(sessionId, input);
    this.#insertAgentSessionEvent(event);
    const session = super.getAgentSession(sessionId);
    if (session) this.#upsertAgentSession(session);
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

  updateTask(taskId, patch = {}) {
    const task = super.updateTask(taskId, patch);
    if (task) {
      this.#upsertTask(task);
    }
    return task;
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
    this.#query(
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
        JSON.stringify(safeJson(payload)),
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
    this.#query(
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
    this.#query('delete from tasks where id = $1', [taskId]);
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
