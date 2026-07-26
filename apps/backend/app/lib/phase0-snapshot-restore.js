'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OWNERSHIP_STATE = 'global_unowned_pre_phase1';
const FIXED_NOW = '2026-07-24T12:00:00.000Z';
const LOCAL_ROLE = 'rehearsal';
const SOURCE_DB = 'phase0_source';
const RESTORE_DB = 'phase0_restore';
const ABSOLUTE_USER_PATH_RE = /\/Users\/[^/\s"']+/g;
const SECRET_SHAPED_RE = /(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9_]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/gi;
const CREATE_TABLE_RE = /create\s+table\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)/gi;

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '../db/migrations');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractCreateTableNamesFromSql(sql = '') {
  const names = [];
  const text = String(sql || '');
  let match;
  const re = new RegExp(CREATE_TABLE_RE.source, 'gi');
  while ((match = re.exec(text)) !== null) {
    const name = String(match[1] || '').toLowerCase();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function extractCreateTableNamesFromMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR, fsModule = fs) {
  const files = fsModule.readdirSync(migrationsDir)
    .filter((file) => /^000[1-7]_.*\.sql$/i.test(file))
    .sort();
  const names = [];
  for (const file of files) {
    const sql = fsModule.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const table of extractCreateTableNamesFromSql(sql)) {
      if (!names.includes(table)) names.push(table);
    }
  }
  return names;
}

/** Tables created by migrations 0001–0007 (Phase 0, pre-Workspace). Derived from CREATE TABLE inventory. */
const EXPECTED_PERSISTED_TABLES = Object.freeze(extractCreateTableNamesFromMigrations());

function assertSafeWorkDir(workDir) {
  const resolved = path.resolve(String(workDir || ''));
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error('work directory must be a non-root path created for this rehearsal');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('work directory does not exist');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error('work directory path is not a directory');
  }
  const entries = fs.readdirSync(resolved).filter((name) => name !== '.DS_Store');
  if (entries.length > 0) {
    throw new Error('work directory must be empty before rehearsal start');
  }
  return resolved;
}

function assertNotProductionDatabaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  throw new Error('external DATABASE_URL is forbidden for Phase 0 snapshot restore rehearsal');
}

function buildLocalConnectionString({ host, port, database, user = LOCAL_ROLE } = {}) {
  if (!host || !port || !database) {
    throw new Error('local connection string requires host, port, and database');
  }
  const encodedHost = encodeURIComponent(String(host));
  return `postgresql://${encodeURIComponent(user)}@/${encodeURIComponent(database)}?host=${encodedHost}&port=${Number(port)}`;
}

function toWorkDirRelative(filePath, workDir) {
  const absolute = path.resolve(String(filePath || ''));
  const root = path.resolve(String(workDir || ''));
  if (root && (absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    return rel ? `$WORK_DIR/${rel}` : '$WORK_DIR';
  }
  return path.basename(absolute) || 'path';
}

function redactReportText(value = '', workDir = '') {
  let text = String(value || '');
  if (workDir) {
    const root = path.resolve(workDir).split(path.sep).join('/');
    text = text.split(path.resolve(workDir)).join('$WORK_DIR');
    text = text.split(root).join('$WORK_DIR');
  }
  return text
    .replace(ABSOLUTE_USER_PATH_RE, '$HOME')
    .replace(SECRET_SHAPED_RE, '[redacted-secret-shaped]');
}

function redactReportValue(value, workDir = '') {
  if (typeof value === 'string') return redactReportText(value, workDir);
  if (Array.isArray(value)) return value.map((item) => redactReportValue(item, workDir));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (['password', 'token', 'secret', 'connectionString', 'databaseUrl', 'DATABASE_URL'].includes(key)) {
        out[key] = child ? '[redacted]' : '';
        continue;
      }
      out[key] = redactReportValue(child, workDir);
    }
    return out;
  }
  return value;
}

function buildSyntheticSeedSql({ now = FIXED_NOW } = {}) {
  const payload = (obj) => JSON.stringify(obj).replace(/'/g, "''");
  return `
BEGIN;

INSERT INTO agents (id, payload, created_at, updated_at) VALUES
  ('agent-default', '${payload({ id: 'default', displayName: 'default', source: 'fixture' })}'::jsonb, '${now}', '${now}'),
  ('agent-biz', '${payload({ id: 'bizconsultant', displayName: 'bizconsultant', source: 'fixture' })}'::jsonb, '${now}', '${now}');

INSERT INTO agent_missions (id, status, agent_id, report_due_at, payload, created_at, updated_at) VALUES
  ('mission-1', 'active', 'bizconsultant', '2026-07-31', '${payload({ title: 'Synthetic mission', origin: 'fixture' })}'::jsonb, '${now}', '${now}');

INSERT INTO tasks (id, title, status, owner, due_at, mission_id, session_id, payload, created_at, updated_at) VALUES
  ('task-1', 'Synthetic task', 'scheduled', 'Me', '2026-07-25', 'mission-1', 'session-1', '${payload({ origin: 'agent', createdByAgentId: 'bizconsultant', agent: 'bizconsultant' })}'::jsonb, '${now}', '${now}'),
  ('task-2', 'Human task', 'Planned', 'Me', '2026-07-26', '', '', '${payload({ origin: 'human', list: 'ops' })}'::jsonb, '${now}', '${now}');

INSERT INTO calendar_events (id, task_id, title, starts_at, payload, created_at, updated_at) VALUES
  ('event-1', 'task-2', 'Synthetic event', '2026-07-26T10:00:00.000Z', '${payload({ kind: 'calendar-event', allDay: false })}'::jsonb, '${now}', '${now}');

INSERT INTO runs (id, goal, agent, model, status, wiki_path, payload, created_at, updated_at) VALUES
  ('run-1', 'Synthetic run goal', 'bizconsultant', 'fixture-model', 'completed', '2_wiki/fixture.md', '${payload({ source: 'fixture' })}'::jsonb, '${now}', '${now}');

INSERT INTO run_logs (run_id, line, payload, created_at) VALUES
  ('run-1', 'synthetic log line', '${payload({ level: 'info' })}'::jsonb, '${now}');

INSERT INTO chat_messages (id, role, text, run_id, payload, created_at) VALUES
  ('chat-1', 'user', 'synthetic chat', 'run-1', '${payload({ target: 'calendar' })}'::jsonb, '${now}');

INSERT INTO wiki_artifacts (id, run_id, path, status, payload, created_at, updated_at) VALUES
  ('wiki-art-1', 'run-1', '2_wiki/fixture.md', 'written', '${payload({ source: 'fixture' })}'::jsonb, '${now}', '${now}');

INSERT INTO scheduler_jobs (id, name, agent, model, enabled, interval_minutes, payload, created_at, updated_at) VALUES
  ('job-1', 'Synthetic schedule', 'bizconsultant', 'fixture-model', true, 60, '${payload({ source: 'scheduler' })}'::jsonb, '${now}', '${now}');

INSERT INTO state_meta (key, payload, created_at, updated_at) VALUES
  ('fixture-meta', '${payload({ schema: 'phase0', ownership: OWNERSHIP_STATE })}'::jsonb, '${now}', '${now}');

INSERT INTO workboard_pages (id, title, payload, created_at, updated_at) VALUES
  ('page-1', 'Synthetic board', '${payload({ columns: [] })}'::jsonb, '${now}', '${now}');

INSERT INTO documents (id, title, path, source, payload, created_at, updated_at) VALUES
  ('doc-1', 'Synthetic document', '2_wiki/fixture.md', 'fixture', '${payload({ excerpt: 'synthetic' })}'::jsonb, '${now}', '${now}');

INSERT INTO wiki_chunks (
  id, source, source_id, document_id, path, title, chunk_index, content, excerpt,
  embedding, embedding_vector, embedding_model, metadata, created_at, updated_at
) VALUES (
  'chunk-1', 'fixture', 'doc-1', 'doc-1', '2_wiki/fixture.md', 'Synthetic document', 0,
  'Synthetic wiki chunk content for restore rehearsal.', 'Synthetic wiki chunk',
  '[]'::jsonb, array_fill(0::float4, ARRAY[256])::vector, 'fixture-embedding-v1',
  '${payload({ source: 'fixture' })}'::jsonb, '${now}', '${now}'
);

INSERT INTO agent_sessions (id, mission_id, task_id, status, payload, created_at, updated_at) VALUES
  ('session-1', 'mission-1', 'task-1', 'running', '${payload({ type: 'task' })}'::jsonb, '${now}', '${now}');

INSERT INTO agent_session_events (id, session_id, sequence, kind, payload, created_at) VALUES
  ('event-sess-1', 'session-1', 1, 'progress', '${payload({ text: 'synthetic progress' })}'::jsonb, '${now}');

INSERT INTO agent_reports (id, mission_id, session_id, status, payload, created_at, updated_at) VALUES
  ('report-1', 'mission-1', 'session-1', 'ready', '${payload({ findings: ['synthetic'] })}'::jsonb, '${now}', '${now}');

COMMIT;
`.trim();
}

function tablesCoveredBySeedSql(seedSql = '') {
  const text = String(seedSql || '');
  return EXPECTED_PERSISTED_TABLES.filter((table) => new RegExp(`INSERT INTO\\s+${table}\\b`, 'i').test(text));
}

function buildTableDigestSql(table) {
  return `
SELECT COALESCE(md5(string_agg(row_digest, '|' ORDER BY row_digest)), md5('')) AS digest
FROM (
  SELECT md5(COALESCE(row_to_json(t)::text, '')) AS row_digest
  FROM ${table} AS t
) rows
`.trim();
}

function buildRowCountSql(table) {
  return `SELECT count(*)::int AS count FROM ${table}`;
}

function buildPublicTableListSql() {
  return `
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
`.trim();
}

function buildSequenceStateSql() {
  // bigserial run_logs.id uses sequence run_logs_id_seq; capture last_value + is_called for next-insert integrity.
  return `
SELECT json_build_object(
  'name', 'run_logs_id_seq',
  'last_value', last_value,
  'is_called', is_called
)::text
FROM run_logs_id_seq
`.trim();
}

function parseSequenceState(text = '') {
  try {
    const parsed = JSON.parse(String(text || '').trim() || '{}');
    return {
      name: String(parsed.name || 'run_logs_id_seq'),
      lastValue: Number(parsed.last_value) || 0,
      isCalled: Boolean(parsed.is_called),
    };
  } catch {
    return { name: 'run_logs_id_seq', lastValue: 0, isCalled: false };
  }
}

function sequenceStatesMatch(sourceSeq = {}, restoreSeq = {}) {
  return String(sourceSeq.name || '') === String(restoreSeq.name || '')
    && Number(sourceSeq.lastValue) === Number(restoreSeq.lastValue)
    && Boolean(sourceSeq.isCalled) === Boolean(restoreSeq.isCalled);
}

function normalizeTableList(tables = []) {
  return [...new Set((Array.isArray(tables) ? tables : []).map((table) => String(table || '')).filter(Boolean))].sort();
}

function compareInventory(source, restore) {
  const mismatches = [];
  const sourceTables = normalizeTableList(source.tables || Object.keys(source.rowCounts || {}));
  const restoreTables = normalizeTableList(restore.tables || Object.keys(restore.rowCounts || {}));
  const expected = normalizeTableList(EXPECTED_PERSISTED_TABLES);

  if (JSON.stringify(sourceTables) !== JSON.stringify(restoreTables)) {
    mismatches.push('table_set_source_restore');
  }
  if (JSON.stringify(sourceTables) !== JSON.stringify(expected)) {
    mismatches.push('table_set_source_expected');
    for (const table of expected) {
      if (!sourceTables.includes(table)) mismatches.push(`source_missing:${table}`);
    }
    for (const table of sourceTables) {
      if (!expected.includes(table)) mismatches.push(`source_extra:${table}`);
    }
  }
  if (JSON.stringify(restoreTables) !== JSON.stringify(expected)) {
    mismatches.push('table_set_restore_expected');
    for (const table of expected) {
      if (!restoreTables.includes(table)) mismatches.push(`restore_missing:${table}`);
    }
    for (const table of restoreTables) {
      if (!expected.includes(table)) mismatches.push(`restore_extra:${table}`);
    }
  }

  const tablesForCounts = [...new Set([...sourceTables, ...restoreTables, ...expected])].sort();
  for (const table of tablesForCounts) {
    if ((source.rowCounts || {})[table] !== (restore.rowCounts || {})[table]) {
      mismatches.push(`count:${table}`);
    }
    if ((source.digests || {})[table] !== (restore.digests || {})[table]) {
      mismatches.push(`digest:${table}`);
    }
  }

  if (!sequenceStatesMatch(source.sequences?.run_logs_id_seq, restore.sequences?.run_logs_id_seq)) {
    mismatches.push('sequence:run_logs_id_seq');
  }

  return {
    matchesSource: mismatches.length === 0,
    mismatches,
    sourceTables,
    restoreTables,
  };
}

function hasExplicitNoServerEvidence(statusOutput = '') {
  const text = String(statusOutput || '');
  // Only recognized no-server evidence. Ambiguous nonzero statuses must fail closed.
  return /no server running/i.test(text)
    || /PID file .* does not exist/i.test(text)
    || /pid file does not exist/i.test(text);
}

function interpretProcessKillOutcome({ signalCheckError = null, termError = null } = {}) {
  // process.kill errors: only ESRCH means the process is already gone.
  if (signalCheckError) {
    if (signalCheckError.code === 'ESRCH') {
      return { succeeded: true, alreadyGone: true, reason: 'ESRCH' };
    }
    return {
      succeeded: false,
      alreadyGone: false,
      reason: String(signalCheckError.code || signalCheckError.message || 'signal_check_failed'),
    };
  }
  if (termError) {
    if (termError.code === 'ESRCH') {
      return { succeeded: true, alreadyGone: true, reason: 'ESRCH' };
    }
    return {
      succeeded: false,
      alreadyGone: false,
      reason: String(termError.code || termError.message || 'term_failed'),
    };
  }
  // Signal delivered (or no term needed) — not proof the process exited.
  return { succeeded: true, alreadyGone: false, reason: '' };
}

/**
 * Probe whether a known PID is still alive.
 * - no error from kill(pid, 0) → still running
 * - ESRCH → gone
 * - EPERM / other → ambiguous (cannot treat as stopped)
 */
function probeProcessLiveness(pid, killFn = process.kill.bind(process)) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return { alive: false, gone: false, ambiguous: true, reason: 'invalid_pid' };
  }
  try {
    killFn(n, 0);
    return { alive: true, gone: false, ambiguous: false, reason: 'alive' };
  } catch (error) {
    if (error && error.code === 'ESRCH') {
      return { alive: false, gone: true, ambiguous: false, reason: 'ESRCH' };
    }
    return {
      alive: false,
      gone: false,
      ambiguous: true,
      reason: String(error?.code || error?.message || 'probe_failed'),
    };
  }
}

function defaultSleepMs(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    const end = Date.now() + wait;
    while (Date.now() < end) {
      // bounded busy-wait fallback when Atomics.wait is unavailable
    }
  }
}

/**
 * After SIGTERM (or any stop attempt), wait boundedly and re-probe the known PID.
 * Only ESRCH yields gone=true. EPERM/other stays ambiguous; no error means still alive.
 */
function waitForKnownPidGone(pid, {
  probe = probeProcessLiveness,
  sleep = defaultSleepMs,
  attempts = 10,
  intervalMs = 200,
} = {}) {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  const interval = Math.max(0, Number(intervalMs) || 0);
  let last = { alive: false, gone: false, ambiguous: true, reason: 'not_probed' };
  for (let i = 0; i < maxAttempts; i += 1) {
    last = probe(pid);
    if (last && last.gone) {
      return { gone: true, alive: false, ambiguous: false, reason: last.reason || 'ESRCH' };
    }
    if (last && last.ambiguous) {
      return {
        gone: false,
        alive: false,
        ambiguous: true,
        reason: last.reason || 'ambiguous',
      };
    }
    if (i < maxAttempts - 1) sleep(interval);
  }
  last = probe(pid);
  return {
    gone: Boolean(last && last.gone),
    alive: Boolean(last && last.alive),
    ambiguous: Boolean(last && last.ambiguous),
    reason: (last && last.reason) || '',
  };
}

function evaluateClusterStopResult({
  stopSucceeded = false,
  statusOutput = '',
  statusExitCode = 1,
  postmasterPid = 0,
  fallbackKillAttempted = false,
  fallbackKillSucceeded = false,
  knownPidGone = false,
} = {}) {
  const statusText = String(statusOutput || '');
  const stillRunning = /server is running/i.test(statusText);
  // Real pg_ctl no-server text only — never synthesize from existsSync / missing paths.
  const noServer = hasExplicitNoServerEvidence(statusText) && !stillRunning;
  const pid = Number(postmasterPid) || 0;
  // Reliable known-PID-gone (ESRCH probe) is the only non-pg_ctl path to accept stopped.
  const reliablePidGone = Boolean(knownPidGone) && pid > 0 && !stillRunning;
  const stopped = Boolean(noServer || reliablePidGone);
  return {
    stopped,
    stopSucceeded: Boolean(stopSucceeded),
    noServer,
    stillRunning,
    ambiguousStatus: !stillRunning && !noServer && !reliablePidGone && String(statusText || '').trim() !== '',
    statusExitCode: Number(statusExitCode) || 0,
    postmasterPid: pid,
    fallbackKillAttempted: Boolean(fallbackKillAttempted),
    fallbackKillSucceeded: Boolean(fallbackKillSucceeded),
    knownPidGone: Boolean(knownPidGone) && pid > 0,
    okToReportSuccess: stopped,
  };
}

function readPostmasterPid(dataDir, fsModule = fs) {
  const pidPath = path.join(String(dataDir || ''), 'postmaster.pid');
  try {
    const firstLine = String(fsModule.readFileSync(pidPath, 'utf8') || '').split(/\r?\n/)[0] || '';
    const pid = Number(firstLine.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function finalizeRehearsalOutcome({ verificationOk = false, clusterStop = {} } = {}) {
  // Accept either raw status inputs or an already-evaluated stop result.
  const stop = clusterStop && Object.hasOwn(clusterStop, 'okToReportSuccess')
    ? clusterStop
    : evaluateClusterStopResult(clusterStop);
  const ok = Boolean(verificationOk) && Boolean(stop.okToReportSuccess);
  const errors = [];
  if (!verificationOk) errors.push('verification_failed');
  if (!stop.okToReportSuccess) errors.push('cluster_not_stopped');
  return {
    ok,
    clusterStopped: Boolean(stop.stopped),
    stop,
    error: ok ? '' : errors.join(','),
  };
}

function buildRedactedEvidenceReport({
  workDir,
  ok,
  postgresVersion = '',
  migrations = [],
  source = {},
  restore = {},
  ownershipState = OWNERSHIP_STATE,
  archiveRelativePath = '',
  durationMs = 0,
  error = '',
  clusterStopped = false,
} = {}) {
  const sourceTables = normalizeTableList(source.tables || []);
  const restoreTables = normalizeTableList(restore.tables || []);
  const report = {
    schemaVersion: 1,
    kind: 'phase0-snapshot-restore-rehearsal',
    ok: Boolean(ok),
    ownershipState,
    clusterStopped: Boolean(clusterStopped),
    migrations: Array.isArray(migrations) ? migrations.slice() : [],
    expectedTables: EXPECTED_PERSISTED_TABLES.slice(),
    source: {
      database: SOURCE_DB,
      tableCount: Number(source.tableCount) || sourceTables.length,
      tables: sourceTables,
      rowCounts: source.rowCounts || {},
      digests: source.digests || {},
      sequences: source.sequences || {},
    },
    restore: {
      database: RESTORE_DB,
      tableCount: Number(restore.tableCount) || restoreTables.length,
      tables: restoreTables,
      rowCounts: restore.rowCounts || {},
      digests: restore.digests || {},
      sequences: restore.sequences || {},
      matchesSource: Boolean(restore.matchesSource),
      mismatches: Array.isArray(restore.mismatches) ? restore.mismatches.slice() : [],
    },
    archive: archiveRelativePath ? toWorkDirRelative(archiveRelativePath, workDir) : '',
    postgresVersion: redactReportText(postgresVersion, workDir),
    durationMs: Number(durationMs) || 0,
    workDir: '$WORK_DIR',
    error: error ? redactReportText(error, workDir) : '',
    generatedAt: FIXED_NOW,
  };
  return redactReportValue(report, workDir);
}

function resolvePostgresBinDir(env = process.env, fsModule = fs) {
  const candidates = [
    env.PHASE0_PG_BIN,
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@16/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);

  for (const dir of candidates) {
    const required = ['initdb', 'pg_ctl', 'postgres', 'psql', 'pg_dump', 'pg_restore', 'pg_isready'];
    if (required.every((name) => {
      try {
        fsModule.accessSync(path.join(dir, name), fsModule.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })) {
      return dir;
    }
  }
  return '';
}

module.exports = {
  EXPECTED_PERSISTED_TABLES,
  FIXED_NOW,
  LOCAL_ROLE,
  OWNERSHIP_STATE,
  RESTORE_DB,
  SOURCE_DB,
  assertNotProductionDatabaseUrl,
  assertSafeWorkDir,
  buildLocalConnectionString,
  buildPublicTableListSql,
  buildRedactedEvidenceReport,
  buildRowCountSql,
  buildSequenceStateSql,
  buildSyntheticSeedSql,
  buildTableDigestSql,
  compareInventory,
  evaluateClusterStopResult,
  extractCreateTableNamesFromMigrations,
  extractCreateTableNamesFromSql,
  finalizeRehearsalOutcome,
  hasExplicitNoServerEvidence,
  interpretProcessKillOutcome,
  normalizeTableList,
  parseSequenceState,
  probeProcessLiveness,
  readPostmasterPid,
  redactReportText,
  redactReportValue,
  resolvePostgresBinDir,
  sequenceStatesMatch,
  tablesCoveredBySeedSql,
  toWorkDirRelative,
  waitForKnownPidGone,
};
