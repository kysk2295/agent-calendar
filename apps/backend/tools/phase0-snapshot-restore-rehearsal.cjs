#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { runMigrations } = require('../app/db/migrate');
const {
  EXPECTED_PERSISTED_TABLES,
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
  finalizeRehearsalOutcome,
  interpretProcessKillOutcome,
  parseSequenceState,
  probeProcessLiveness,
  readPostmasterPid,
  resolvePostgresBinDir,
  waitForKnownPidGone,
} = require('../app/lib/phase0-snapshot-restore');

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node apps/backend/tools/phase0-snapshot-restore-rehearsal.cjs --work-dir <empty-dir> [--write-evidence]',
    '',
    'Creates an ephemeral local PostgreSQL cluster under work-dir, applies real migrations,',
    'seeds synthetic data, dumps, restores, and verifies digests. Never accepts DATABASE_URL.',
    'ok=true is emitted only after the cluster is confirmed stopped.',
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
      throw new Error('external DATABASE_URL is forbidden for Phase 0 snapshot restore rehearsal');
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function runBin(binDir, name, args, options = {}) {
  const bin = path.join(binDir, name);
  return execFileSync(bin, args, {
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

async function waitForReady(binDir, socketDir, port, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('ephemeral PostgreSQL did not become ready');
}

function queryText(binDir, socketDir, port, database, sql) {
  const text = runBin(binDir, 'psql', [
    '-h', socketDir,
    '-p', String(port),
    '-U', LOCAL_ROLE,
    '-d', database,
    '-v', 'ON_ERROR_STOP=1',
    '-At',
    '-F', '\t',
    '-c', sql,
  ], { timeout: 30_000 });
  return String(text || '').trim();
}

function collectInventory(binDir, socketDir, port, database) {
  const tablesText = queryText(binDir, socketDir, port, database, buildPublicTableListSql());
  const tables = tablesText ? tablesText.split(/\r?\n/).filter(Boolean) : [];
  const rowCounts = {};
  const digests = {};
  for (const table of tables) {
    rowCounts[table] = Number(queryText(binDir, socketDir, port, database, buildRowCountSql(table))) || 0;
    digests[table] = queryText(binDir, socketDir, port, database, buildTableDigestSql(table));
  }
  // Also record expected tables that are missing so comparison can fail clearly.
  for (const table of EXPECTED_PERSISTED_TABLES) {
    if (!Object.hasOwn(rowCounts, table)) {
      rowCounts[table] = 0;
      digests[table] = '';
    }
  }

  let sequences = {};
  if (tables.includes('run_logs')) {
    try {
      const seqText = queryText(binDir, socketDir, port, database, buildSequenceStateSql());
      const seq = parseSequenceState(seqText);
      sequences = { run_logs_id_seq: seq };
    } catch {
      sequences = { run_logs_id_seq: { name: 'run_logs_id_seq', lastValue: 0, isCalled: false } };
    }
  }

  return {
    tables,
    tableCount: tables.length,
    rowCounts,
    digests,
    sequences,
  };
}

async function createPool(connectionString) {
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 10_000,
  });
}

function readPgCtlStatus(binDir, dataDir) {
  try {
    const statusOutput = runBin(binDir, 'pg_ctl', ['-D', dataDir, 'status'], { timeout: 10_000 });
    return { statusOutput: String(statusOutput || ''), statusExitCode: 0 };
  } catch (error) {
    // Prefer real pg_ctl stdout/stderr only — never the Node wrapper message alone.
    const statusOutput = `${error && error.stdout != null ? String(error.stdout) : ''}${error && error.stderr != null ? String(error.stderr) : ''}`;
    return {
      statusOutput,
      statusExitCode: typeof error?.status === 'number' ? error.status : 1,
    };
  }
}

function stopCluster(binDir, dataDir, workDir) {
  let stopSucceeded = false;
  // Capture known postmaster PID before stopping — never infer gone from missing path later.
  let postmasterPid = readPostmasterPid(dataDir);
  let fallbackKillAttempted = false;
  let fallbackKillSucceeded = false;
  let knownPidGone = false;

  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
    stopSucceeded = true;
  } catch {
    stopSucceeded = false;
  }

  // Real pg_ctl status only — do not synthesize no-server text from existsSync/path absence.
  let { statusOutput, statusExitCode } = readPgCtlStatus(binDir, dataDir);

  if (postmasterPid > 0) {
    const liveness = probeProcessLiveness(postmasterPid);
    if (liveness.gone) {
      knownPidGone = true;
    }
  }

  let stop = evaluateClusterStopResult({
    stopSucceeded,
    statusOutput,
    statusExitCode,
    postmasterPid,
    knownPidGone,
  });

  if (!stop.stopped && postmasterPid > 0 && !knownPidGone) {
    // Safe fallback only against the postmaster pid captured from this workDir cluster.
    fallbackKillAttempted = true;
    const liveness = probeProcessLiveness(postmasterPid);

    if (liveness.gone) {
      knownPidGone = true;
      fallbackKillSucceeded = true;
    } else if (liveness.ambiguous) {
      // EPERM/other: cannot claim stopped from process probe.
      fallbackKillSucceeded = false;
    } else {
      // Still alive: SIGTERM, then wait boundedly and re-probe for ESRCH only.
      let termError = null;
      try {
        process.kill(postmasterPid, 'SIGTERM');
      } catch (error) {
        termError = error;
      }
      const killOutcome = interpretProcessKillOutcome({ signalCheckError: null, termError });
      if (killOutcome.alreadyGone) {
        knownPidGone = true;
        fallbackKillSucceeded = true;
      } else if (!killOutcome.succeeded) {
        fallbackKillSucceeded = false;
      } else {
        const waited = waitForKnownPidGone(postmasterPid, {
          attempts: 15,
          intervalMs: 200,
        });
        if (waited.gone) {
          knownPidGone = true;
          fallbackKillSucceeded = true;
        } else {
          fallbackKillSucceeded = false;
        }
      }
    }

    ({ statusOutput, statusExitCode } = readPgCtlStatus(binDir, dataDir));
    stop = evaluateClusterStopResult({
      stopSucceeded,
      statusOutput,
      statusExitCode,
      postmasterPid,
      fallbackKillAttempted,
      fallbackKillSucceeded,
      knownPidGone,
    });
  }

  return {
    ...stop,
    workDirToken: workDir ? path.basename(workDir) : '',
  };
}

function emitReport(report, { writeEvidence = false } = {}) {
  if (writeEvidence && report.ok) {
    const evidenceDir = path.resolve(__dirname, '../../../docs/operations/evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, '2026-07-24-phase0-snapshot-restore-rehearsal.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.evidencePath = 'docs/operations/evidence/2026-07-24-phase0-snapshot-restore-rehearsal.json';
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.workDir) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  assertNotProductionDatabaseUrl(process.env.DATABASE_URL_FOR_REHEARSAL || '');
  const workDir = assertSafeWorkDir(args.workDir);
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      prerequisite: 'postgresql_binaries_missing',
      message: 'PostgreSQL client/server binaries with initdb/pg_ctl/psql/pg_dump/pg_restore were not found',
      clusterStopped: true,
    }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  const archivePath = path.join(workDir, 'phase0-sanitized.dump');
  const seedPath = path.join(workDir, 'seed.sql');
  fs.mkdirSync(socketDir, { recursive: true });

  const port = await freePort();
  let clusterStartAttempted = false;
  const startedAt = Date.now();
  let migrations = [];
  let verificationOk = false;
  let sourceInventory = null;
  let restoreInventory = null;
  let comparison = null;
  let postgresVersion = '';
  let verificationError = '';

  try {
    runBin(binDir, 'initdb', [
      '-D', dataDir,
      '-A', 'trust',
      '-U', LOCAL_ROLE,
      '--locale=C',
      '--encoding=UTF8',
    ], { timeout: 60_000 });

    // Mark start attempted before pg_ctl so a partial start that throws still triggers stop.
    clusterStartAttempted = true;
    runBin(binDir, 'pg_ctl', [
      '-D', dataDir,
      '-l', logFile,
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
      'start',
    ], { timeout: 30_000 });
    await waitForReady(binDir, socketDir, port);

    try {
      queryText(binDir, socketDir, port, 'postgres', 'CREATE EXTENSION IF NOT EXISTS vector;');
    } catch {
      throw new Error('vector_extension_unavailable: install a pgvector build matching the selected PostgreSQL major version');
    }

    queryText(binDir, socketDir, port, 'postgres', `CREATE DATABASE ${SOURCE_DB};`);
    queryText(binDir, socketDir, port, 'postgres', `CREATE DATABASE ${RESTORE_DB};`);

    const sourceUrl = buildLocalConnectionString({ host: socketDir, port, database: SOURCE_DB });
    const sourcePool = await createPool(sourceUrl);
    try {
      // Phase 0 rehearsal freezes pre-Workspace schema (0001-0007) only.
      // Phase 1+ migrations are exercised by dedicated Phase 1 tests.
      const migrationResult = await runMigrations({
        pool: sourcePool,
        fileFilter: (file) => /^000[1-7]_.*\.sql$/i.test(file),
      });
      migrations = migrationResult.migrations || [];
      fs.writeFileSync(seedPath, `${buildSyntheticSeedSql()}\n`, 'utf8');
      await sourcePool.query(fs.readFileSync(seedPath, 'utf8'));
    } finally {
      await sourcePool.end();
    }

    runBin(binDir, 'pg_dump', [
      '-h', socketDir,
      '-p', String(port),
      '-U', LOCAL_ROLE,
      '-d', SOURCE_DB,
      '-Fc',
      '-f', archivePath,
    ], { timeout: 60_000 });

    const preRestore = collectInventory(binDir, socketDir, port, RESTORE_DB);
    if (preRestore.tables.length > 0) {
      throw new Error('restore target database is not empty');
    }

    runBin(binDir, 'pg_restore', [
      '-h', socketDir,
      '-p', String(port),
      '-U', LOCAL_ROLE,
      '-d', RESTORE_DB,
      '--no-owner',
      '--no-acl',
      archivePath,
    ], { timeout: 60_000 });

    sourceInventory = collectInventory(binDir, socketDir, port, SOURCE_DB);
    restoreInventory = collectInventory(binDir, socketDir, port, RESTORE_DB);
    comparison = compareInventory(sourceInventory, restoreInventory);
    postgresVersion = runBin(binDir, 'postgres', ['--version'], { timeout: 5000 }).trim();

    const missingExpected = EXPECTED_PERSISTED_TABLES.filter((table) => !sourceInventory.tables.includes(table));
    verificationOk = comparison.matchesSource
      && missingExpected.length === 0
      && EXPECTED_PERSISTED_TABLES.every((table) => (sourceInventory.rowCounts[table] || 0) > 0);
    if (!verificationOk) {
      verificationError = `verification_failed:${(comparison.mismatches || []).concat(missingExpected.map((t) => `missing:${t}`)).join(',')}`;
    }
  } catch (error) {
    verificationOk = false;
    verificationError = error && error.message ? error.message : String(error);
  }

  // Always stop before emitting success whenever start was attempted or a pid file exists.
  let clusterStop = { stopped: true, okToReportSuccess: true };
  const postmasterExists = fs.existsSync(path.join(dataDir, 'postmaster.pid'));
  if (clusterStartAttempted || postmasterExists) {
    clusterStop = stopCluster(binDir, dataDir, workDir);
  }
  const outcome = finalizeRehearsalOutcome({
    verificationOk,
    clusterStop,
  });

  const report = buildRedactedEvidenceReport({
    workDir,
    ok: outcome.ok,
    postgresVersion,
    migrations,
    source: sourceInventory || {},
    restore: {
      ...(restoreInventory || {}),
      matchesSource: Boolean(comparison?.matchesSource),
      mismatches: comparison?.mismatches || [],
    },
    ownershipState: OWNERSHIP_STATE,
    archiveRelativePath: fs.existsSync(path.join(workDir, 'phase0-sanitized.dump'))
      ? path.join(workDir, 'phase0-sanitized.dump')
      : '',
    durationMs: Date.now() - startedAt,
    error: outcome.ok ? '' : [verificationError, outcome.error].filter(Boolean).join(';'),
    clusterStopped: outcome.clusterStopped,
  });

  emitReport(report, { writeEvidence: args.writeEvidence });
  if (!binDir) {
    process.exitCode = 2;
  } else if (/vector_extension|binaries_missing|prerequisite/i.test(String(verificationError))) {
    process.exitCode = 2;
  } else {
    process.exitCode = outcome.ok ? 0 : 1;
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    clusterStopped: false,
    error: String(error && error.message ? error.message : error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
