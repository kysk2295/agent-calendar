'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  assertNotProductionDatabaseUrl,
  assertSafeWorkDir,
  redactReportValue,
} = require('./phase0-snapshot-restore');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '../db/migrations');
const PITR_RESTORE_POINT = 'phase10_before_accidental_delete';
const CREATE_TABLE_RE = /create\s+table\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)/gi;

function extractCurrentTableNamesFromMigrations(
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  fsModule = fs,
) {
  const tables = new Set();
  const files = fsModule.readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.*\.sql$/i.test(file))
    .sort();
  for (const file of files) {
    const sql = fsModule.readFileSync(path.join(migrationsDir, file), 'utf8');
    let match;
    const re = new RegExp(CREATE_TABLE_RE.source, 'gi');
    while ((match = re.exec(sql)) !== null) {
      tables.add(String(match[1] || '').toLowerCase());
    }
  }
  return [...tables].sort();
}

const CURRENT_PERSISTED_TABLES = Object.freeze(extractCurrentTableNamesFromMigrations());

function assertSafeRecoveryWorkDir(workDir, externalDatabaseUrl = '') {
  assertNotProductionDatabaseUrl(externalDatabaseUrl);
  const resolved = assertSafeWorkDir(workDir);
  if (!/^[A-Za-z0-9_./-]+$/.test(resolved)) {
    throw new Error('work directory contains characters forbidden by PostgreSQL recovery config');
  }
  return resolved;
}

function buildTwoWorkspaceFixtureSql() {
  return `
insert into users (id, display_name, status, payload, created_at, updated_at)
values
  ('phase10-user-a', 'Workspace A Owner', 'active', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
  ('phase10-user-b', 'Workspace B Owner', 'active', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');

insert into workspaces (id, name, status, payload, created_at, updated_at)
values
  ('phase10-workspace-a', 'Workspace A', 'active', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
  ('phase10-workspace-b', 'Workspace B', 'active', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');

insert into workspace_memberships
  (id, user_id, workspace_id, role, status, payload, created_at, updated_at)
values
  ('phase10-membership-a', 'phase10-user-a', 'phase10-workspace-a', 'owner', 'active', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
  ('phase10-membership-b', 'phase10-user-b', 'phase10-workspace-b', 'owner', 'active', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');

insert into tasks
  (id, title, status, owner, due_at, mission_id, session_id, payload, created_at, updated_at, workspace_id)
values
  ('phase10-task-a', 'Recovery fixture A', 'scheduled', 'phase10-user-a', '', '', '', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z', 'phase10-workspace-a'),
  ('phase10-task-b', 'Recovery fixture B', 'scheduled', 'phase10-user-b', '', '', '', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z', 'phase10-workspace-b');

insert into calendar_events
  (id, task_id, title, starts_at, payload, created_at, updated_at, workspace_id)
values
  ('phase10-event-a', 'phase10-task-a', 'Recovery fixture event', '2026-07-25T09:00:00Z', '{}'::jsonb, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z', 'phase10-workspace-a');
`.trim();
}

function buildSafeMutationSql() {
  return `
insert into tasks
  (id, title, status, owner, due_at, mission_id, session_id, payload, created_at, updated_at, workspace_id)
values
  ('phase10-safe-task-a', 'Safe mutation before restore point', 'scheduled', 'phase10-user-a', '', '', '', '{}'::jsonb, '2026-07-25T01:00:00Z', '2026-07-25T01:00:00Z', 'phase10-workspace-a');
`.trim();
}

function buildDamageSql() {
  return `
delete from tasks
where id = 'phase10-task-a'
  and workspace_id = 'phase10-workspace-a';

insert into state_meta (workspace_id, key, payload, created_at, updated_at)
values (
  'phase10-workspace-a',
  'phase10-damage-marker',
  '{"kind":"accidental_delete_after_restore_point"}'::jsonb,
  '2026-07-25T02:00:00Z',
  '2026-07-25T02:00:00Z'
)
on conflict (workspace_id, key) do update set payload = excluded.payload;
`.trim();
}

function normalizeInventoryTables(value) {
  return [...new Set(Array.isArray(value) ? value.map(String) : [])].sort();
}

function compareCurrentInventory(source = {}, restore = {}) {
  const mismatches = [];
  const sourceTables = normalizeInventoryTables(source.tables);
  const restoreTables = normalizeInventoryTables(restore.tables);
  if (JSON.stringify(sourceTables) !== JSON.stringify(restoreTables)) {
    mismatches.push('table_set');
  }

  for (const table of CURRENT_PERSISTED_TABLES) {
    const sourceCount = Number(source.rowCounts?.[table] || 0);
    const restoreCount = Number(restore.rowCounts?.[table] || 0);
    if (sourceCount !== restoreCount) {
      mismatches.push(`${table}:row_count`);
    }
    const sourceDigest = String(source.digests?.[table] || '');
    const restoreDigest = String(restore.digests?.[table] || '');
    if (sourceDigest !== restoreDigest) {
      mismatches.push(`${table}:digest`);
    }
  }

  return {
    matchesSource: mismatches.length === 0,
    mismatches,
  };
}

function evaluatePitrState({
  taskA = 0,
  taskB = 0,
  safeMarker = 0,
  damageMarker = 0,
  workspaceAIds = [],
  workspaceBIds = [],
} = {}) {
  const failures = [];
  if (Number(taskA) !== 1) failures.push('task_a_missing');
  if (Number(taskB) !== 1) failures.push('task_b_missing');
  if (Number(safeMarker) !== 1) failures.push('safe_marker_missing');
  if (Number(damageMarker) !== 0) failures.push('damage_marker_present');

  const expectedA = ['phase10-safe-task-a', 'phase10-task-a'];
  const expectedB = ['phase10-task-b'];
  const actualA = normalizeInventoryTables(workspaceAIds);
  const actualB = normalizeInventoryTables(workspaceBIds);
  if (JSON.stringify(actualA) !== JSON.stringify(expectedA)) {
    failures.push('workspace_leak_a');
  }
  if (JSON.stringify(actualB) !== JSON.stringify(expectedB)) {
    failures.push('workspace_leak_b');
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

function buildPhase10EvidenceReport({
  workDir = '',
  ok = false,
  postgresVersion = '',
  migrations = [],
  logical = {},
  pitr = {},
  clustersStopped = false,
  durationMs = 0,
  error = '',
} = {}) {
  const report = {
    schemaVersion: 1,
    rehearsal: 'phase10_current_schema_disaster_recovery',
    generatedAt: new Date().toISOString(),
    ok: Boolean(ok),
    expectedTables: CURRENT_PERSISTED_TABLES,
    postgresVersion: String(postgresVersion || ''),
    migrations: Array.isArray(migrations) ? migrations.map(String) : [],
    logical: {
      sourceTableCount: Number(logical.sourceTableCount || 0),
      restoreTableCount: Number(logical.restoreTableCount || 0),
      matchesSource: Boolean(logical.matchesSource),
      mismatches: Array.isArray(logical.mismatches) ? logical.mismatches.map(String) : [],
    },
    pitr: {
      restorePoint: String(pitr.restorePoint || PITR_RESTORE_POINT),
      safeMarkerPresent: Boolean(pitr.safeMarkerPresent),
      damageMarkerAbsent: Boolean(pitr.damageMarkerAbsent),
      workspaceIsolation: Boolean(pitr.workspaceIsolation),
    },
    clustersStopped: Boolean(clustersStopped),
    durationMs: Math.max(0, Number(durationMs) || 0),
    workDir: '$WORK_DIR',
    error: String(error || ''),
  };
  return redactReportValue(report, workDir);
}

function resolvePhase10PostgresBinDir(env = process.env, fsModule = fs) {
  const candidates = [
    env.PHASE10_PG_BIN,
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@16/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);
  const required = [
    'initdb',
    'pg_ctl',
    'postgres',
    'psql',
    'pg_dump',
    'pg_restore',
    'pg_isready',
    'pg_basebackup',
  ];
  for (const dir of candidates) {
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
  CURRENT_PERSISTED_TABLES,
  PITR_RESTORE_POINT,
  assertSafeRecoveryWorkDir,
  buildDamageSql,
  buildPhase10EvidenceReport,
  buildSafeMutationSql,
  buildTwoWorkspaceFixtureSql,
  compareCurrentInventory,
  evaluatePitrState,
  extractCurrentTableNamesFromMigrations,
  resolvePhase10PostgresBinDir,
};
