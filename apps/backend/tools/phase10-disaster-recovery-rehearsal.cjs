#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../app/db/migrate');
const {
  DEFAULT_LOCAL_POSTGRES_PORT,
  createLocalPostgresCluster,
  defaultRunBin: runBin,
} = require('../app/lib/local-postgres-lifecycle');
const {
  buildLocalConnectionString,
  buildPublicTableListSql,
  buildRowCountSql,
  buildTableDigestSql,
} = require('../app/lib/phase0-snapshot-restore');
const {
  CURRENT_PERSISTED_TABLES,
  PITR_RESTORE_POINT,
  assertSafeRecoveryWorkDir,
  buildDamageSql,
  buildPhase10EvidenceReport,
  buildSafeMutationSql,
  buildTwoWorkspaceFixtureSql,
  compareCurrentInventory,
  evaluatePitrState,
  resolvePhase10PostgresBinDir,
} = require('../app/lib/phase10-disaster-recovery');

const LOCAL_ROLE = 'rehearsal';
const SOURCE_DB = 'phase10_source';
const LOGICAL_RESTORE_DB = 'phase10_logical_restore';

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node apps/backend/tools/phase10-disaster-recovery-rehearsal.cjs --work-dir <empty-dir> [--write-evidence]',
    '',
    'Creates isolated local PostgreSQL clusters, applies every current migration,',
    'verifies logical dump/restore and a named WAL restore point, then stops both clusters.',
    'External DATABASE_URL values are forbidden.',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { workDir: '', writeEvidence: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--work-dir') {
      args.workDir = String(argv[index + 1] || '');
      index += 1;
    } else if (item === '--write-evidence') {
      args.writeEvidence = true;
    } else if (item === '--database-url' || item === '--DATABASE_URL') {
      throw new Error('external DATABASE_URL is forbidden for Phase 10 disaster recovery rehearsal');
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

async function waitForReady(binDir, socketDir, port, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runBin(
        binDir,
        'pg_isready',
        ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE],
        { timeout: 2000 },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('ephemeral PostgreSQL did not become ready');
}

async function waitForPromotion(
  binDir,
  socketDir,
  port,
  database,
  attempts = 120,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const promoted = queryText(
        binDir,
        socketDir,
        port,
        database,
        'select (not pg_is_in_recovery())::text',
      );
      if (promoted === 'true' || promoted === 't') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ephemeral PostgreSQL recovery did not promote');
}

function queryText(binDir, socketDir, port, database, sql) {
  const result = runBin(binDir, 'psql', [
    '-h', socketDir,
    '-p', String(port),
    '-U', LOCAL_ROLE,
    '-d', database,
    '-v', 'ON_ERROR_STOP=1',
    '-qAt',
    '-F', '\t',
    '-c', sql,
  ], { timeout: 30_000 });
  return String(result || '').trim();
}

function collectInventory(binDir, socketDir, port, database) {
  const tableText = queryText(binDir, socketDir, port, database, buildPublicTableListSql());
  const tables = tableText ? tableText.split(/\r?\n/).filter(Boolean) : [];
  const rowCounts = {};
  const digests = {};
  for (const table of tables) {
    rowCounts[table] = Number(
      queryText(binDir, socketDir, port, database, buildRowCountSql(table)),
    ) || 0;
    digests[table] = queryText(
      binDir,
      socketDir,
      port,
      database,
      buildTableDigestSql(table),
    );
  }
  for (const table of CURRENT_PERSISTED_TABLES) {
    if (!Object.hasOwn(rowCounts, table)) {
      rowCounts[table] = 0;
      digests[table] = '';
    }
  }
  return { tables, rowCounts, digests };
}

function createPool(connectionString) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 10_000,
  });
}

function appendConfig(filePath, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key} = ${value}`);
  fs.appendFileSync(filePath, `\n${lines.join('\n')}\n`, 'utf8');
}

function parseWorkspaceIds(output, marker) {
  const line = String(output || '')
    .split(/\r?\n/)
    .find((item) => item.startsWith(`${marker}:`));
  if (!line) return [];
  const value = line.slice(marker.length + 1);
  return value ? value.split(',').filter(Boolean) : [];
}

function queryWorkspaceTaskIds(binDir, socketDir, port, database, {
  workspaceId,
  userId,
  marker,
}) {
  const output = queryText(binDir, socketDir, port, database, `
begin;
set local role agent_calendar_app;
select set_config('app.workspace_id', '${workspaceId}', true);
select set_config('app.user_id', '${userId}', true);
select '${marker}:' || coalesce(string_agg(id, ',' order by id), '') from tasks;
rollback;
`);
  return parseWorkspaceIds(output, marker);
}

function verifyWorkspaceIsolation(binDir, socketDir, port, database, expectedA, expectedB) {
  const workspaceAIds = queryWorkspaceTaskIds(binDir, socketDir, port, database, {
    workspaceId: 'phase10-workspace-a',
    userId: 'phase10-user-a',
    marker: 'WORKSPACE_A',
  });
  const workspaceBIds = queryWorkspaceTaskIds(binDir, socketDir, port, database, {
    workspaceId: 'phase10-workspace-b',
    userId: 'phase10-user-b',
    marker: 'WORKSPACE_B',
  });
  return {
    workspaceAIds,
    workspaceBIds,
    ok: JSON.stringify(workspaceAIds.sort()) === JSON.stringify([...expectedA].sort())
      && JSON.stringify(workspaceBIds.sort()) === JSON.stringify([...expectedB].sort()),
  };
}

async function waitForArchivedWalFile(walArchiveDir, walFile, attempts = 120) {
  const safeName = String(walFile || '').trim();
  if (!/^[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?$/.test(safeName)) {
    throw new Error('archived WAL filename is invalid');
  }
  const target = path.join(walArchiveDir, safeName);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return safeName;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`WAL archive file did not arrive: ${safeName}`);
}

function emitReport(report, { writeEvidence = false } = {}) {
  if (writeEvidence && report.ok) {
    const evidenceDir = path.resolve(__dirname, '../../../docs/operations/evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(
      evidenceDir,
      '2026-07-25-phase10-disaster-recovery.json',
    );
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function safeErrorCode(error) {
  const message = String(error?.message || error || '');
  const known = [
    'logical_restore_verification_failed',
    'bounded_incident_did_not_apply',
    'source_cluster_did_not_stop_before_recovery',
    'restore_point_lsn_invalid',
    'safe_marker_missing_before_damage',
  ];
  const direct = known.find((code) => message === code || message.startsWith(`${code}:`));
  if (direct) return message;
  if (message.startsWith('pitr_verification_failed:')) return message;
  if (message.startsWith('WAL archive did not reach count')) return 'wal_archive_timeout';
  if (message.startsWith('WAL archive file did not arrive')) return 'wal_archive_timeout';
  if (message === 'archived WAL filename is invalid') return 'wal_archive_filename_invalid';
  if (message.includes('vector')) return 'vector_extension_unavailable';
  if (message.includes('did not become ready')) return 'postgres_readiness_timeout';
  if (message.includes('recovery did not promote')) return 'postgres_recovery_promotion_timeout';
  if (message.includes('Command failed:')) return 'postgres_command_failed';
  return 'disaster_recovery_rehearsal_failed';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.workDir) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const workDir = assertSafeRecoveryWorkDir(
    args.workDir,
    process.env.DATABASE_URL_FOR_REHEARSAL || '',
  );
  const binDir = resolvePhase10PostgresBinDir(process.env);
  if (!binDir) {
    emitReport({
      ok: false,
      prerequisite: 'postgresql_disaster_recovery_binaries_missing',
      clustersStopped: true,
    });
    process.exitCode = 2;
    return;
  }

  const sourceDataDir = path.join(workDir, 'source-pgdata');
  const sourceLogFile = path.join(workDir, 'source-postgres.log');
  const recoveryDataDir = path.join(workDir, 'recovery-pgdata');
  const recoveryLogFile = path.join(workDir, 'recovery-postgres.log');
  const walArchiveDir = path.join(workDir, 'wal-archive');
  const logicalBackupPath = path.join(workDir, 'logical-backup.dump');
  const baseBackupDir = path.join(workDir, 'base-backup');
  const shortTempRoot = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  let shortSocketRoot = '';
  let sourceSocketDir = '';
  let recoverySocketDir = '';
  const sourcePort = DEFAULT_LOCAL_POSTGRES_PORT;
  const recoveryPort = DEFAULT_LOCAL_POSTGRES_PORT;
  const startedAt = Date.now();
  let sourceCluster = null;
  let recoveryCluster = null;
  let sourceStop = { stopped: true };
  let recoveryStop = { stopped: true };
  let migrations = [];
  let sourceInventory = null;
  let logicalRestoreInventory = null;
  let logicalComparison = { matchesSource: false, mismatches: ['not_run'] };
  let logicalIsolation = { ok: false };
  let pitrState = { ok: false, failures: ['not_run'] };
  let criticalDomains = {
    calendar: false,
    delegatedWork: false,
    automation: false,
    runner: false,
  };
  let postgresVersion = '';
  let restorePointLsn = '';
  let verificationError = '';

  try {
    shortSocketRoot = fs.mkdtempSync(
      path.join(shortTempRoot, 'agent-calendar-p10-'),
    );
    sourceSocketDir = path.join(shortSocketRoot, 'source');
    recoverySocketDir = path.join(shortSocketRoot, 'recovery');
    fs.mkdirSync(sourceSocketDir, { recursive: true });
    fs.mkdirSync(recoverySocketDir, { recursive: true });
    fs.mkdirSync(walArchiveDir, { recursive: true });

    runBin(binDir, 'initdb', [
      '-D', sourceDataDir,
      '-A', 'trust',
      '-U', LOCAL_ROLE,
      '--locale=C',
      '--encoding=UTF8',
    ], { timeout: 60_000 });
    appendConfig(path.join(sourceDataDir, 'postgresql.conf'), {
      wal_level: 'replica',
      archive_mode: 'on',
      archive_command: `'test ! -f ${walArchiveDir}/%f && cp %p ${walArchiveDir}/%f'`,
      max_wal_senders: '4',
      full_page_writes: 'on',
      listen_addresses: "''",
    });

    sourceCluster = createLocalPostgresCluster({
      binDir,
      workDir,
      dataDir: sourceDataDir,
      logFile: sourceLogFile,
      socketDir: sourceSocketDir,
      role: LOCAL_ROLE,
      port: sourcePort,
    });
    await sourceCluster.start({ initialize: false, readyAttempts: 120 });
    await waitForReady(binDir, sourceSocketDir, sourcePort);
    if (process.env.NODE_ENV === 'test'
      && process.env.PHASE10_TEST_FAIL_AFTER_SOURCE_READY === '1') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      throw new Error('intentional_phase10_verification_failure');
    }

    queryText(binDir, sourceSocketDir, sourcePort, 'postgres', `create database ${SOURCE_DB}`);
    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      'postgres',
      `create database ${LOGICAL_RESTORE_DB}`,
    );

    const sourcePool = createPool(buildLocalConnectionString({
      host: sourceSocketDir,
      port: sourcePort,
      database: SOURCE_DB,
      user: LOCAL_ROLE,
    }));
    try {
      const migrationResult = await runMigrations({ pool: sourcePool });
      migrations = migrationResult.migrations || [];
      await sourcePool.query(buildTwoWorkspaceFixtureSql());
    } finally {
      await sourcePool.end();
    }

    runBin(binDir, 'pg_dump', [
      '-h', sourceSocketDir,
      '-p', String(sourcePort),
      '-U', LOCAL_ROLE,
      '-d', SOURCE_DB,
      '-Fc',
      '-f', logicalBackupPath,
    ], { timeout: 90_000 });
    runBin(binDir, 'pg_restore', [
      '-h', sourceSocketDir,
      '-p', String(sourcePort),
      '-U', LOCAL_ROLE,
      '-d', LOGICAL_RESTORE_DB,
      '--no-owner',
      logicalBackupPath,
    ], { timeout: 90_000 });

    sourceInventory = collectInventory(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
    );
    logicalRestoreInventory = collectInventory(
      binDir,
      sourceSocketDir,
      sourcePort,
      LOGICAL_RESTORE_DB,
    );
    logicalComparison = compareCurrentInventory(
      sourceInventory,
      logicalRestoreInventory,
    );
    const sourceMissing = CURRENT_PERSISTED_TABLES.filter(
      (table) => !sourceInventory.tables.includes(table),
    );
    const sourceUnexpected = sourceInventory.tables.filter(
      (table) => !CURRENT_PERSISTED_TABLES.includes(table),
    );
    if (sourceMissing.length || sourceUnexpected.length) {
      logicalComparison = {
        matchesSource: false,
        mismatches: [
          ...logicalComparison.mismatches,
          ...sourceMissing.map((table) => `missing:${table}`),
          ...sourceUnexpected.map((table) => `unexpected:${table}`),
        ],
      };
    }
    logicalIsolation = verifyWorkspaceIsolation(
      binDir,
      sourceSocketDir,
      sourcePort,
      LOGICAL_RESTORE_DB,
      ['phase10-task-a'],
      ['phase10-task-b'],
    );
    if (!logicalComparison.matchesSource || !logicalIsolation.ok) {
      throw new Error('logical_restore_verification_failed');
    }

    runBin(binDir, 'pg_basebackup', [
      '-D', baseBackupDir,
      '-Fp',
      '-X', 'stream',
      '-c', 'fast',
      '-h', sourceSocketDir,
      '-p', String(sourcePort),
      '-U', LOCAL_ROLE,
    ], { timeout: 120_000 });

    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      `
begin;
${buildSafeMutationSql()}
commit;
select pg_create_restore_point('${PITR_RESTORE_POINT}');
`,
    );
    restorePointLsn = queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_current_wal_insert_lsn()',
    );
    if (!restorePointLsn) {
      throw new Error('restore_point_lsn_invalid');
    }
    const safeTaskBeforeDamage = Number(queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      "select count(*)::int from tasks where id = 'phase10-safe-task-a'",
    )) || 0;
    if (safeTaskBeforeDamage !== 1) {
      throw new Error('safe_marker_missing_before_damage');
    }
    const restorePointWalFile = queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_walfile_name(pg_current_wal_insert_lsn())',
    );
    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_switch_wal()',
    );
    await waitForArchivedWalFile(walArchiveDir, restorePointWalFile);

    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      buildDamageSql(),
    );
    const damagedTaskCount = Number(queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      "select count(*)::int from tasks where id = 'phase10-task-a'",
    )) || 0;
    const damageMarkerCount = Number(queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      "select count(*)::int from state_meta where key = 'phase10-damage-marker'",
    )) || 0;
    if (damagedTaskCount !== 0 || damageMarkerCount !== 1) {
      throw new Error('bounded_incident_did_not_apply');
    }
    const damageWalFile = queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_walfile_name(pg_current_wal_insert_lsn())',
    );
    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_switch_wal()',
    );
    await waitForArchivedWalFile(walArchiveDir, damageWalFile);

    sourceStop = await sourceCluster.stop();
    if (!sourceStop.stopped) {
      throw new Error('source_cluster_did_not_stop_before_recovery');
    }

    fs.cpSync(baseBackupDir, recoveryDataDir, { recursive: true });
    fs.chmodSync(recoveryDataDir, 0o700);
    fs.writeFileSync(path.join(recoveryDataDir, 'recovery.signal'), '', 'utf8');
    appendConfig(path.join(recoveryDataDir, 'postgresql.auto.conf'), {
      restore_command: `'cp ${walArchiveDir}/%f %p'`,
      recovery_target_lsn: `'${restorePointLsn}'`,
      recovery_target_action: "'promote'",
      archive_mode: 'off',
    });

    recoveryCluster = createLocalPostgresCluster({
      binDir,
      workDir,
      dataDir: recoveryDataDir,
      logFile: recoveryLogFile,
      socketDir: recoverySocketDir,
      role: LOCAL_ROLE,
      port: recoveryPort,
    });
    await recoveryCluster.start({ initialize: false, readyAttempts: 120 });
    await waitForReady(binDir, recoverySocketDir, recoveryPort);
    await waitForPromotion(
      binDir,
      recoverySocketDir,
      recoveryPort,
      SOURCE_DB,
    );

    const taskA = Number(queryText(
      binDir,
      recoverySocketDir,
      recoveryPort,
      SOURCE_DB,
      "select count(*)::int from tasks where id = 'phase10-task-a'",
    )) || 0;
    const taskB = Number(queryText(
      binDir,
      recoverySocketDir,
      recoveryPort,
      SOURCE_DB,
      "select count(*)::int from tasks where id = 'phase10-task-b'",
    )) || 0;
    const safeMarker = Number(queryText(
      binDir,
      recoverySocketDir,
      recoveryPort,
      SOURCE_DB,
      "select count(*)::int from tasks where id = 'phase10-safe-task-a'",
    )) || 0;
    const damageMarker = Number(queryText(
      binDir,
      recoverySocketDir,
      recoveryPort,
      SOURCE_DB,
      "select count(*)::int from state_meta where key = 'phase10-damage-marker'",
    )) || 0;
    const recoveredIsolation = verifyWorkspaceIsolation(
      binDir,
      recoverySocketDir,
      recoveryPort,
      SOURCE_DB,
      ['phase10-task-a', 'phase10-safe-task-a'],
      ['phase10-task-b'],
    );
    pitrState = evaluatePitrState({
      taskA,
      taskB,
      safeMarker,
      damageMarker,
      workspaceAIds: recoveredIsolation.workspaceAIds,
      workspaceBIds: recoveredIsolation.workspaceBIds,
    });
    if (!pitrState.ok) {
      throw new Error(`pitr_verification_failed:${pitrState.failures.join(',')}`);
    }
    criticalDomains = {
      calendar: Number(queryText(
        binDir,
        recoverySocketDir,
        recoveryPort,
        SOURCE_DB,
        "select count(*)::int from calendar_events where id = 'phase10-event-a' and workspace_id = 'phase10-workspace-a'",
      )) === 1,
      delegatedWork: Number(queryText(
        binDir,
        recoverySocketDir,
        recoveryPort,
        SOURCE_DB,
        "select count(*)::int from tasks where id = 'phase10-task-a' and workspace_id = 'phase10-workspace-a'",
      )) === 1,
      automation: Number(queryText(
        binDir,
        recoverySocketDir,
        recoveryPort,
        SOURCE_DB,
        "select count(*)::int from automation_sources where id = 'phase10-automation-a' and workspace_id = 'phase10-workspace-a'",
      )) === 1,
      runner: Number(queryText(
        binDir,
        recoverySocketDir,
        recoveryPort,
        SOURCE_DB,
        "select count(*)::int from runners where id = 'phase10-runner-a' and workspace_id = 'phase10-workspace-a'",
      )) === 1,
    };
    if (Object.values(criticalDomains).some((present) => !present)) {
      throw new Error('pitr_verification_failed:critical_domain_missing');
    }
    postgresVersion = runBin(
      binDir,
      'postgres',
      ['--version'],
      { timeout: 5000 },
    ).trim();
  } catch (error) {
    verificationError = safeErrorCode(error);
  }

  if (recoveryCluster && !recoveryCluster.stopResult?.stopped) {
    recoveryStop = await recoveryCluster.stop();
  }
  if (sourceCluster && !sourceCluster.stopResult?.stopped) {
    sourceStop = await sourceCluster.stop();
  }
  const clustersStopped = Boolean(sourceStop.stopped && recoveryStop.stopped);
  if (clustersStopped && shortSocketRoot) {
    fs.rmSync(shortSocketRoot, { recursive: true, force: true });
  }
  const ok = Boolean(
    !verificationError
    && logicalComparison.matchesSource
    && logicalIsolation.ok
    && pitrState.ok
    && clustersStopped,
  );
  const report = buildPhase10EvidenceReport({
    workDir,
    ok,
    postgresVersion,
    migrations,
    logical: {
      sourceTableCount: sourceInventory?.tables?.length || 0,
      restoreTableCount: logicalRestoreInventory?.tables?.length || 0,
      matchesSource: logicalComparison.matchesSource,
      mismatches: logicalComparison.mismatches,
    },
    pitr: {
      restorePoint: PITR_RESTORE_POINT,
      safeMarkerPresent: pitrState.ok && !pitrState.failures.includes('safe_marker_missing'),
      damageMarkerAbsent: pitrState.ok && !pitrState.failures.includes('damage_marker_present'),
      workspaceIsolation: pitrState.ok
        && !pitrState.failures.some((item) => item.startsWith('workspace_leak')),
      criticalDomains,
    },
    clustersStopped,
    durationMs: Date.now() - startedAt,
    error: ok ? '' : verificationError || 'verification_failed',
  });
  emitReport(report, { writeEvidence: args.writeEvidence });
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: false,
    clustersStopped: false,
    error: String(error?.message || error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
