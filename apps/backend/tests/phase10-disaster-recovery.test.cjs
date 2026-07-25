'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  CURRENT_PERSISTED_TABLES,
  PITR_RESTORE_POINT,
  assertSafeRecoveryWorkDir,
  buildDamageSql,
  buildPhase10EvidenceReport,
  buildTwoWorkspaceFixtureSql,
  compareCurrentInventory,
  evaluatePitrState,
  extractCurrentTableNamesFromMigrations,
  resolvePhase10PostgresBinDir,
} = require('../app/lib/phase10-disaster-recovery');

const CLI_PATH = path.join(__dirname, '../tools/phase10-disaster-recovery-rehearsal.cjs');
const MIGRATIONS_DIR = path.join(__dirname, '../app/db/migrations');
const EVIDENCE_PATH = path.join(
  __dirname,
  '../../../docs/operations/evidence/2026-07-25-phase10-disaster-recovery.json',
);

function makeEmptyWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-recovery-test-'));
}

test('current table inventory is derived from every migration through 0024', () => {
  const fromDisk = extractCurrentTableNamesFromMigrations(MIGRATIONS_DIR);
  assert.deepEqual(CURRENT_PERSISTED_TABLES, fromDisk);
  for (const table of [
    'users',
    'workspaces',
    'tasks',
    'runners',
    'execution_jobs',
    'calendar_sources',
    'knowledge_sources',
    'calendar_ai_conversations',
    'automation_sources',
  ]) {
    assert.equal(CURRENT_PERSISTED_TABLES.includes(table), true, `missing ${table}`);
  }
  assert.equal(PITR_RESTORE_POINT, 'phase10_before_accidental_delete');
});

test('fixture and damage SQL encode two isolated Workspaces and one bounded incident', () => {
  const fixture = buildTwoWorkspaceFixtureSql();
  assert.match(fixture, /phase10-workspace-a/);
  assert.match(fixture, /phase10-workspace-b/);
  assert.match(fixture, /phase10-task-a/);
  assert.match(fixture, /phase10-task-b/);
  assert.match(fixture, /phase10-event-a/);
  assert.doesNotMatch(fixture, /postgresql:\/\/|password|token/i);

  const damage = buildDamageSql();
  assert.match(damage, /delete from tasks/i);
  assert.match(damage, /phase10-task-a/);
  assert.match(damage, /phase10-damage-marker/);
  assert.doesNotMatch(damage, /phase10-task-b[\s\S]*delete/i);
});

test('inventory comparison requires exact current table, count, and digest parity', () => {
  const counts = Object.fromEntries(CURRENT_PERSISTED_TABLES.map((table) => [table, 0]));
  const digests = Object.fromEntries(CURRENT_PERSISTED_TABLES.map((table) => [table, 'digest']));
  const source = { tables: CURRENT_PERSISTED_TABLES, rowCounts: counts, digests };
  const matching = compareCurrentInventory(source, source);
  assert.equal(matching.matchesSource, true);
  assert.deepEqual(matching.mismatches, []);

  const mismatch = compareCurrentInventory(source, {
    tables: CURRENT_PERSISTED_TABLES.filter((table) => table !== 'tasks'),
    rowCounts: { ...counts, tasks: 1 },
    digests: { ...digests, tasks: 'changed' },
  });
  assert.equal(mismatch.matchesSource, false);
  assert.equal(mismatch.mismatches.some((item) => item.includes('table_set')), true);
  assert.equal(mismatch.mismatches.some((item) => item.includes('tasks')), true);
});

test('PITR state fails closed on lost safe data, surviving damage, or Workspace leakage', () => {
  const valid = evaluatePitrState({
    taskA: 1,
    taskB: 1,
    safeMarker: 1,
    damageMarker: 0,
    workspaceAIds: ['phase10-safe-task-a', 'phase10-task-a'],
    workspaceBIds: ['phase10-task-b'],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.failures, []);

  const invalid = evaluatePitrState({
    taskA: 0,
    taskB: 1,
    safeMarker: 0,
    damageMarker: 1,
    workspaceAIds: ['phase10-task-b'],
    workspaceBIds: ['phase10-task-a'],
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.failures.includes('task_a_missing'), true);
  assert.equal(invalid.failures.includes('safe_marker_missing'), true);
  assert.equal(invalid.failures.includes('damage_marker_present'), true);
  assert.equal(invalid.failures.some((item) => item.includes('workspace_leak')), true);
});

test('safety rejects external URLs and nonempty recovery paths', () => {
  const nonempty = makeEmptyWorkDir();
  fs.writeFileSync(path.join(nonempty, 'marker'), 'x', 'utf8');
  assert.throws(() => assertSafeRecoveryWorkDir(nonempty, ''), /empty/i);
  fs.rmSync(nonempty, { recursive: true, force: true });

  const empty = makeEmptyWorkDir();
  assert.throws(
    () => assertSafeRecoveryWorkDir(empty, 'postgresql://production.internal/app'),
    /forbidden/i,
  );
  fs.rmSync(empty, { recursive: true, force: true });
});

test('evidence report is bounded and contains no connection or row payload data', () => {
  const workDir = '/tmp/phase10-recovery-redaction';
  const report = buildPhase10EvidenceReport({
    workDir,
    ok: true,
    postgresVersion: 'postgres (PostgreSQL) 17.x',
    migrations: ['0001_core_loop.sql', '0024_automation_federation.sql'],
    logical: {
      sourceTableCount: CURRENT_PERSISTED_TABLES.length,
      restoreTableCount: CURRENT_PERSISTED_TABLES.length,
      matchesSource: true,
      mismatches: [],
    },
    pitr: {
      restorePoint: PITR_RESTORE_POINT,
      safeMarkerPresent: true,
      damageMarkerAbsent: true,
      workspaceIsolation: true,
    },
    clustersStopped: true,
    durationMs: 10,
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.ok, true);
  assert.equal(report.clustersStopped, true);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.expectedTables, CURRENT_PERSISTED_TABLES);
  assert.doesNotMatch(serialized, /postgresql:\/\//);
  assert.doesNotMatch(serialized, /\/Users\/[^/\s"']+/);
  assert.doesNotMatch(serialized, /phase10-task-a.*title/i);
  assert.doesNotMatch(serialized, /"(password|access_token|refresh_token)"\s*:/i);
});

test('CLI rejects DATABASE_URL flags and nonempty work directories', () => {
  const rejectedUrl = spawnSync(
    process.execPath,
    [CLI_PATH, '--database-url', 'postgresql://x/y'],
    { encoding: 'utf8' },
  );
  assert.notEqual(rejectedUrl.status, 0);
  assert.match(`${rejectedUrl.stdout}\n${rejectedUrl.stderr}`, /forbidden|DATABASE_URL/i);

  const nonempty = makeEmptyWorkDir();
  fs.writeFileSync(path.join(nonempty, 'marker'), 'x', 'utf8');
  const rejectedDir = spawnSync(
    process.execPath,
    [CLI_PATH, '--work-dir', nonempty],
    { encoding: 'utf8' },
  );
  assert.notEqual(rejectedDir.status, 0);
  assert.match(`${rejectedDir.stdout}\n${rejectedDir.stderr}`, /empty/i);
  fs.rmSync(nonempty, { recursive: true, force: true });
});

test('full current-schema logical restore and WAL PITR rehearsal succeeds', () => {
  const binDir = resolvePhase10PostgresBinDir(process.env);
  if (!binDir) {
    assert.ok(true, 'PostgreSQL disaster recovery binaries missing; pure contracts still run');
    return;
  }

  const beforeEvidence = fs.existsSync(EVIDENCE_PATH)
    ? fs.readFileSync(EVIDENCE_PATH, 'utf8')
    : null;
  const workDir = makeEmptyWorkDir();
  try {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, '--work-dir', workDir],
      {
        encoding: 'utf8',
        timeout: 240_000,
        env: {
          ...process.env,
          PHASE10_PG_BIN: binDir,
          DATABASE_URL: '',
        },
      },
    );
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.clustersStopped, true);
    assert.equal(report.logical.matchesSource, true);
    assert.equal(report.pitr.safeMarkerPresent, true);
    assert.equal(report.pitr.damageMarkerAbsent, true);
    assert.equal(report.pitr.workspaceIsolation, true);
    assert.equal(report.pitr.restorePoint, PITR_RESTORE_POINT);
    assert.deepEqual(report.expectedTables, CURRENT_PERSISTED_TABLES);
    assert.doesNotMatch(result.stdout, /postgresql:\/\//);
    assert.doesNotMatch(result.stdout, /\/Users\/[^/\s"']+/);
    assert.equal(fs.existsSync(path.join(workDir, 'logical-backup.dump')), true);
    assert.equal(fs.existsSync(path.join(workDir, 'base-backup')), true);

    const afterEvidence = fs.existsSync(EVIDENCE_PATH)
      ? fs.readFileSync(EVIDENCE_PATH, 'utf8')
      : null;
    assert.equal(afterEvidence, beforeEvidence);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
