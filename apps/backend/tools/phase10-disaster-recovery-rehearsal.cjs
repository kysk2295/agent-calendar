#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../app/db/migrate');
const {
  buildLocalConnectionString,
  buildPublicTableListSql,
  buildRowCountSql,
  buildTableDigestSql,
  evaluateClusterStopResult,
  probeProcessLiveness,
  readPostmasterPid,
  waitForKnownPidGone,
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

function runBin(binDir, name, args, options = {}) {
  return execFileSync(path.join(binDir, name), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
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

function startCluster(binDir, dataDir, logFile, socketDir, port) {
  runBin(binDir, 'pg_ctl', [
    '-D', dataDir,
    '-l', logFile,
    '-o', `-p ${port} -k ${socketDir}`,
    'start',
  ], { timeout: 30_000 });
}

function readPgCtlStatus(binDir, dataDir) {
  try {
    const output = runBin(binDir, 'pg_ctl', ['-D', dataDir, 'status'], { timeout: 10_000 });
    return { statusOutput: String(output || ''), statusExitCode: 0 };
  } catch (error) {
    return {
      statusOutput: `${error?.stdout || ''}${error?.stderr || ''}`,
      statusExitCode: typeof error?.status === 'number' ? error.status : 1,
    };
  }
}

function stopCluster(binDir, dataDir) {
  const postmasterPid = readPostmasterPid(dataDir);
  let stopSucceeded = false;
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
    stopSucceeded = true;
  } catch {
    stopSucceeded = false;
  }

  let knownPidGone = postmasterPid <= 0 || probeProcessLiveness(postmasterPid).gone;
  if (!knownPidGone && postmasterPid > 0) {
    try {
      process.kill(postmasterPid, 'SIGTERM');
    } catch (error) {
      if (error?.code === 'ESRCH') knownPidGone = true;
    }
    if (!knownPidGone) {
      knownPidGone = waitForKnownPidGone(postmasterPid, {
        attempts: 20,
        intervalMs: 200,
      }).gone;
    }
  }

  const { statusOutput, statusExitCode } = readPgCtlStatus(binDir, dataDir);
  return evaluateClusterStopResult({
    stopSucceeded,
    statusOutput,
    statusExitCode,
    postmasterPid,
    knownPidGone,
    fallbackKillAttempted: !stopSucceeded,
    fallbackKillSucceeded: knownPidGone,
  });
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

async function waitForArchiveCount(
  binDir,
  socketDir,
  port,
  database,
  minimum,
  attempts = 120,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const count = Number(queryText(
      binDir,
      socketDir,
      port,
      database,
      'select archived_count::int from pg_stat_archiver',
    )) || 0;
    if (count >= minimum) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`WAL archive did not reach count ${minimum}`);
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
  ];
  const direct = known.find((code) => message === code || message.startsWith(`${code}:`));
  if (direct) return message;
  if (message.startsWith('pitr_verification_failed:')) return message;
  if (message.startsWith('WAL archive did not reach count')) return 'wal_archive_timeout';
  if (message.includes('vector')) return 'vector_extension_unavailable';
  if (message.includes('did not become ready')) return 'postgres_readiness_timeout';
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
  const shortSocketRoot = fs.mkdtempSync(
    path.join(shortTempRoot, 'agent-calendar-p10-'),
  );
  const sourceSocketDir = path.join(shortSocketRoot, 'source');
  const recoverySocketDir = path.join(shortSocketRoot, 'recovery');
  fs.mkdirSync(sourceSocketDir, { recursive: true });
  fs.mkdirSync(recoverySocketDir, { recursive: true });
  fs.mkdirSync(walArchiveDir, { recursive: true });

  const sourcePort = await freePort();
  const recoveryPort = await freePort();
  const startedAt = Date.now();
  let sourceStartAttempted = false;
  let recoveryStartAttempted = false;
  let sourceStop = { stopped: true };
  let recoveryStop = { stopped: true };
  let migrations = [];
  let sourceInventory = null;
  let logicalRestoreInventory = null;
  let logicalComparison = { matchesSource: false, mismatches: ['not_run'] };
  let logicalIsolation = { ok: false };
  let pitrState = { ok: false, failures: ['not_run'] };
  let postgresVersion = '';
  let verificationError = '';

  try {
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

    sourceStartAttempted = true;
    startCluster(
      binDir,
      sourceDataDir,
      sourceLogFile,
      sourceSocketDir,
      sourcePort,
    );
    await waitForReady(binDir, sourceSocketDir, sourcePort);

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
      buildSafeMutationSql(),
    );
    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      `select pg_create_restore_point('${PITR_RESTORE_POINT}')`,
    );
    const firstArchiveCount = Number(queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select archived_count::int from pg_stat_archiver',
    )) || 0;
    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_switch_wal()',
    );
    await waitForArchiveCount(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      firstArchiveCount + 1,
    );

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
    const secondArchiveCount = Number(queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select archived_count::int from pg_stat_archiver',
    )) || 0;
    queryText(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      'select pg_switch_wal()',
    );
    await waitForArchiveCount(
      binDir,
      sourceSocketDir,
      sourcePort,
      SOURCE_DB,
      secondArchiveCount + 1,
    );

    sourceStop = stopCluster(binDir, sourceDataDir);
    if (!sourceStop.stopped) {
      throw new Error('source_cluster_did_not_stop_before_recovery');
    }

    fs.cpSync(baseBackupDir, recoveryDataDir, { recursive: true });
    fs.chmodSync(recoveryDataDir, 0o700);
    fs.writeFileSync(path.join(recoveryDataDir, 'recovery.signal'), '', 'utf8');
    appendConfig(path.join(recoveryDataDir, 'postgresql.auto.conf'), {
      restore_command: `'cp ${walArchiveDir}/%f %p'`,
      recovery_target_name: `'${PITR_RESTORE_POINT}'`,
      recovery_target_action: "'promote'",
      archive_mode: 'off',
    });

    recoveryStartAttempted = true;
    startCluster(
      binDir,
      recoveryDataDir,
      recoveryLogFile,
      recoverySocketDir,
      recoveryPort,
    );
    await waitForReady(binDir, recoverySocketDir, recoveryPort);

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
    postgresVersion = runBin(
      binDir,
      'postgres',
      ['--version'],
      { timeout: 5000 },
    ).trim();
  } catch (error) {
    verificationError = safeErrorCode(error);
  }

  if (recoveryStartAttempted || fs.existsSync(path.join(recoveryDataDir, 'postmaster.pid'))) {
    recoveryStop = stopCluster(binDir, recoveryDataDir);
  }
  if (sourceStartAttempted && !sourceStop.stopped) {
    sourceStop = stopCluster(binDir, sourceDataDir);
  }
  const clustersStopped = Boolean(sourceStop.stopped && recoveryStop.stopped);
  fs.rmSync(shortSocketRoot, { recursive: true, force: true });
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
