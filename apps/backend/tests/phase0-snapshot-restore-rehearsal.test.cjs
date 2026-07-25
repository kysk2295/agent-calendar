const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  EXPECTED_PERSISTED_TABLES,
  OWNERSHIP_STATE,
  assertNotProductionDatabaseUrl,
  assertSafeWorkDir,
  buildLocalConnectionString,
  buildRedactedEvidenceReport,
  buildSyntheticSeedSql,
  compareInventory,
  evaluateClusterStopResult,
  extractCreateTableNamesFromMigrations,
  extractCreateTableNamesFromSql,
  finalizeRehearsalOutcome,
  interpretProcessKillOutcome,
  probeProcessLiveness,
  redactReportText,
  resolvePostgresBinDir,
  tablesCoveredBySeedSql,
  toWorkDirRelative,
  waitForKnownPidGone,
} = require('../app/lib/phase0-snapshot-restore');

const CLI_PATH = path.join(__dirname, '../tools/phase0-snapshot-restore-rehearsal.cjs');
const MIGRATIONS_DIR = path.join(__dirname, '../app/db/migrations');
const EVIDENCE_PATH = path.join(__dirname, '../../../docs/operations/evidence/2026-07-24-phase0-snapshot-restore-rehearsal.json');

function makeEmptyWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-rehearsal-test-'));
}

test('EXPECTED_PERSISTED_TABLES equals CREATE TABLE inventory from migrations 0001-0007', () => {
  const fromDisk = extractCreateTableNamesFromMigrations(MIGRATIONS_DIR);
  assert.deepEqual(EXPECTED_PERSISTED_TABLES.slice().sort(), fromDisk.slice().sort());
  assert.equal(EXPECTED_PERSISTED_TABLES.includes('agents'), true);
  assert.equal(EXPECTED_PERSISTED_TABLES.includes('wiki_chunks'), true);
  assert.equal(EXPECTED_PERSISTED_TABLES.includes('agent_reports'), true);
  assert.equal(OWNERSHIP_STATE, 'global_unowned_pre_phase1');

  const raw = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^000[1-7]_.*\.sql$/i.test(file))
    .sort()
    .map((file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    .join('\n');
  const parsed = extractCreateTableNamesFromSql(raw);
  assert.deepEqual(parsed.slice().sort(), fromDisk.slice().sort());
});

test('synthetic seed SQL inserts into every expected persisted table', () => {
  const sql = buildSyntheticSeedSql();
  const covered = tablesCoveredBySeedSql(sql);
  assert.deepEqual(covered.slice().sort(), EXPECTED_PERSISTED_TABLES.slice().sort());
  assert.match(sql, /INSERT INTO calendar_events/);
  assert.match(sql, /INSERT INTO agent_session_events/);
  assert.match(sql, /INSERT INTO wiki_chunks/);
  assert.doesNotMatch(sql, /workspace_id|user_id|tenant_id/i);
});

test('safety helpers reject external database URLs and nonempty work directories', () => {
  assert.throws(
    () => assertNotProductionDatabaseUrl('postgresql://example.internal/db'),
    /forbidden/i,
  );
  assert.equal(assertNotProductionDatabaseUrl(''), '');

  const nonempty = makeEmptyWorkDir();
  fs.writeFileSync(path.join(nonempty, 'marker.txt'), 'x', 'utf8');
  assert.throws(() => assertSafeWorkDir(nonempty), /empty/i);
  fs.rmSync(nonempty, { recursive: true, force: true });

  const empty = makeEmptyWorkDir();
  assert.equal(assertSafeWorkDir(empty), path.resolve(empty));
  fs.rmSync(empty, { recursive: true, force: true });
});

test('local connection strings are socket-scoped and never accept host secrets', () => {
  const url = buildLocalConnectionString({
    host: '/tmp/work/socket',
    port: 55432,
    database: 'phase0_source',
  });
  assert.match(url, /phase0_source/);
  assert.match(url, /port=55432/);
  assert.match(url, /host=%2Ftmp%2Fwork%2Fsocket|host=\/tmp\/work\/socket/);
  assert.doesNotMatch(url, /password=|sslmode=require/i);
});

test('report redaction strips absolute user paths and secret-shaped fragments', () => {
  const workDir = '/tmp/phase0-work-abc';
  const text = redactReportText(
    `cwd=${workDir}/pgdata token=sk-abcdefghijklmnop path=/Users/example/.hermes`,
    workDir,
  );
  assert.match(text, /\$WORK_DIR/);
  assert.doesNotMatch(text, /\/Users\/example/);
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/);

  const relative = toWorkDirRelative(`${workDir}/phase0-sanitized.dump`, workDir);
  assert.equal(relative, '$WORK_DIR/phase0-sanitized.dump');
});

test('inventory comparison fails when public table sets differ even if expected digests match', () => {
  const matchingCounts = Object.fromEntries(EXPECTED_PERSISTED_TABLES.map((table) => [table, 1]));
  const matchingDigests = Object.fromEntries(EXPECTED_PERSISTED_TABLES.map((table) => [table, 'digest']));
  const seq = { name: 'run_logs_id_seq', lastValue: 1, isCalled: true };

  const source = {
    tables: [...EXPECTED_PERSISTED_TABLES, 'extra_side_table'],
    rowCounts: { ...matchingCounts, extra_side_table: 1 },
    digests: { ...matchingDigests, extra_side_table: 'digest' },
    sequences: { run_logs_id_seq: seq },
  };
  const restore = {
    tables: EXPECTED_PERSISTED_TABLES.slice(),
    rowCounts: matchingCounts,
    digests: matchingDigests,
    sequences: { run_logs_id_seq: seq },
  };
  const result = compareInventory(source, restore);
  assert.equal(result.matchesSource, false);
  assert.equal(result.mismatches.some((item) => item.includes('table_set') || item.includes('extra')), true);

  const countMismatch = compareInventory(
    {
      tables: EXPECTED_PERSISTED_TABLES.slice(),
      rowCounts: { ...matchingCounts, tasks: 2 },
      digests: matchingDigests,
      sequences: { run_logs_id_seq: seq },
    },
    {
      tables: EXPECTED_PERSISTED_TABLES.slice(),
      rowCounts: matchingCounts,
      digests: matchingDigests,
      sequences: { run_logs_id_seq: seq },
    },
  );
  assert.equal(countMismatch.matchesSource, false);
  assert.equal(countMismatch.mismatches.some((item) => item.includes('tasks')), true);

  const sequenceMismatch = compareInventory(
    {
      tables: EXPECTED_PERSISTED_TABLES.slice(),
      rowCounts: matchingCounts,
      digests: matchingDigests,
      sequences: { run_logs_id_seq: { name: 'run_logs_id_seq', lastValue: 1, isCalled: true } },
    },
    {
      tables: EXPECTED_PERSISTED_TABLES.slice(),
      rowCounts: matchingCounts,
      digests: matchingDigests,
      sequences: { run_logs_id_seq: { name: 'run_logs_id_seq', lastValue: 9, isCalled: true } },
    },
  );
  assert.equal(sequenceMismatch.matchesSource, false);
  assert.equal(sequenceMismatch.mismatches.includes('sequence:run_logs_id_seq'), true);
});

test('cluster stop evaluation and finalize outcome require stopped postgres before ok', () => {
  const stopped = evaluateClusterStopResult({
    stopSucceeded: true,
    statusOutput: 'pg_ctl: no server running\n',
    statusExitCode: 3,
  });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.okToReportSuccess, true);
  assert.equal(stopped.noServer, true);

  const running = evaluateClusterStopResult({
    stopSucceeded: false,
    statusOutput: 'pg_ctl: server is running (PID: 12345)\n',
    statusExitCode: 0,
    postmasterPid: 12345,
  });
  assert.equal(running.stopped, false);
  assert.equal(running.okToReportSuccess, false);

  // Ambiguous nonzero status must not be treated as stopped even if stop() returned success.
  const ambiguous = evaluateClusterStopResult({
    stopSucceeded: true,
    statusOutput: 'pg_ctl: permission denied\n',
    statusExitCode: 1,
    postmasterPid: 99999,
  });
  assert.equal(ambiguous.noServer, false);
  assert.equal(ambiguous.stopped, false);
  assert.equal(ambiguous.okToReportSuccess, false);
  assert.equal(ambiguous.ambiguousStatus, true);
  const ambiguousFinal = finalizeRehearsalOutcome({
    verificationOk: true,
    clusterStop: ambiguous,
  });
  assert.equal(ambiguousFinal.ok, false);
  assert.match(ambiguousFinal.error, /cluster_not_stopped/);

  const pidMissing = evaluateClusterStopResult({
    stopSucceeded: true,
    statusOutput: 'pg_ctl: PID file "/tmp/x/postmaster.pid" does not exist\n',
    statusExitCode: 3,
  });
  assert.equal(pidMissing.noServer, true);
  assert.equal(pidMissing.okToReportSuccess, true);

  const finalFail = finalizeRehearsalOutcome({
    verificationOk: true,
    clusterStop: running,
  });
  assert.equal(finalFail.ok, false);
  assert.match(finalFail.error, /cluster_not_stopped/);

  const finalOk = finalizeRehearsalOutcome({
    verificationOk: true,
    clusterStop: stopped,
  });
  assert.equal(finalOk.ok, true);
});

test('kill fallback succeeds only for ESRCH already-gone, otherwise fails closed', () => {
  const gone = interpretProcessKillOutcome({ signalCheckError: { code: 'ESRCH' } });
  assert.equal(gone.succeeded, true);
  assert.equal(gone.alreadyGone, true);

  const eperm = interpretProcessKillOutcome({ signalCheckError: { code: 'EPERM' } });
  assert.equal(eperm.succeeded, false);
  assert.equal(eperm.alreadyGone, false);

  const termGone = interpretProcessKillOutcome({ termError: { code: 'ESRCH' } });
  assert.equal(termGone.succeeded, true);

  const termFail = interpretProcessKillOutcome({ termError: { code: 'EPERM' } });
  assert.equal(termFail.succeeded, false);

  const ok = interpretProcessKillOutcome({});
  assert.equal(ok.succeeded, true);
  assert.equal(ok.alreadyGone, false);

  const fallbackAmbiguous = evaluateClusterStopResult({
    stopSucceeded: false,
    statusOutput: 'pg_ctl: permission denied\n',
    statusExitCode: 1,
    postmasterPid: 42,
    fallbackKillAttempted: true,
    fallbackKillSucceeded: false,
  });
  assert.equal(fallbackAmbiguous.okToReportSuccess, false);
});

test('ambiguous status + missing/inaccessible pid path cannot upgrade to success; known PID ESRCH can', () => {
  // Ambiguous pg_ctl output with no known PID (missing/inaccessible postmaster.pid path)
  // must never be treated as stopped — existsSync=false is not no-server evidence.
  const missingPidPath = evaluateClusterStopResult({
    stopSucceeded: true,
    statusOutput: 'pg_ctl: could not open PID file: Permission denied\n',
    statusExitCode: 1,
    postmasterPid: 0,
    knownPidGone: false,
  });
  assert.equal(missingPidPath.noServer, false);
  assert.equal(missingPidPath.stopped, false);
  assert.equal(missingPidPath.okToReportSuccess, false);
  assert.equal(missingPidPath.ambiguousStatus, true);

  // Synthesized "PID file does not exist" from path absence is no longer how we succeed;
  // without real pg_ctl no-server text or knownPidGone, still fail closed.
  const ambiguousOnly = evaluateClusterStopResult({
    stopSucceeded: true,
    statusOutput: 'pg_ctl: error: could not send stop signal\n',
    statusExitCode: 1,
    postmasterPid: 0,
  });
  assert.equal(ambiguousOnly.okToReportSuccess, false);

  // Known postmaster PID with reliable ESRCH (gone) may accept stopped even when status is ambiguous.
  const knownPidGone = evaluateClusterStopResult({
    stopSucceeded: false,
    statusOutput: 'pg_ctl: permission denied\n',
    statusExitCode: 1,
    postmasterPid: 4242,
    knownPidGone: true,
    fallbackKillAttempted: true,
    fallbackKillSucceeded: true,
  });
  assert.equal(knownPidGone.stopped, true);
  assert.equal(knownPidGone.okToReportSuccess, true);
  assert.equal(knownPidGone.knownPidGone, true);

  // knownPidGone without a positive known PID is not reliable.
  const fakeGone = evaluateClusterStopResult({
    stopSucceeded: false,
    statusOutput: 'pg_ctl: permission denied\n',
    statusExitCode: 1,
    postmasterPid: 0,
    knownPidGone: true,
  });
  assert.equal(fakeGone.okToReportSuccess, false);

  // Process liveness probe: ESRCH=gone, EPERM=ambiguous, no error=alive.
  const probeGone = probeProcessLiveness(999001, () => {
    const err = new Error('kill ESRCH');
    err.code = 'ESRCH';
    throw err;
  });
  assert.equal(probeGone.gone, true);
  assert.equal(probeGone.alive, false);
  assert.equal(probeGone.ambiguous, false);

  const probeEperm = probeProcessLiveness(999002, () => {
    const err = new Error('kill EPERM');
    err.code = 'EPERM';
    throw err;
  });
  assert.equal(probeEperm.gone, false);
  assert.equal(probeEperm.ambiguous, true);
  assert.equal(probeEperm.alive, false);

  const probeAlive = probeProcessLiveness(999003, () => undefined);
  assert.equal(probeAlive.alive, true);
  assert.equal(probeAlive.gone, false);
  assert.equal(probeAlive.ambiguous, false);

  // After SIGTERM, wait boundedly and re-probe — only ESRCH yields gone.
  let probeCalls = 0;
  const waited = waitForKnownPidGone(555, {
    attempts: 3,
    intervalMs: 0,
    sleep: () => {},
    probe: () => {
      probeCalls += 1;
      if (probeCalls < 2) {
        return { alive: true, gone: false, ambiguous: false, reason: 'alive' };
      }
      return { alive: false, gone: true, ambiguous: false, reason: 'ESRCH' };
    },
  });
  assert.equal(waited.gone, true);
  assert.equal(probeCalls >= 2, true);

  const stillAlive = waitForKnownPidGone(556, {
    attempts: 2,
    intervalMs: 0,
    sleep: () => {},
    probe: () => ({ alive: true, gone: false, ambiguous: false, reason: 'alive' }),
  });
  assert.equal(stillAlive.gone, false);
  assert.equal(stillAlive.alive, true);

  const finalOk = finalizeRehearsalOutcome({
    verificationOk: true,
    clusterStop: knownPidGone,
  });
  assert.equal(finalOk.ok, true);

  const finalFail = finalizeRehearsalOutcome({
    verificationOk: true,
    clusterStop: missingPidPath,
  });
  assert.equal(finalFail.ok, false);
  assert.match(finalFail.error, /cluster_not_stopped/);
});

test('CLI stop path must not synthesize no-server evidence from existsSync', () => {
  const cliSource = fs.readFileSync(CLI_PATH, 'utf8');
  assert.doesNotMatch(
    cliSource,
    /existsSync\([^)]*postmaster\.pid[^)]*\)[\s\S]{0,200}PID file does not exist/,
  );
  assert.doesNotMatch(cliSource, /augmentStatusWithPidFileEvidence/);
  assert.match(cliSource, /probeProcessLiveness|waitForKnownPidGone|knownPidGone/);
});

test('redacted evidence report includes table lists and clusterStopped without secrets', () => {
  const workDir = path.join(os.tmpdir(), 'phase0-report-home');
  const report = buildRedactedEvidenceReport({
    workDir,
    ok: true,
    migrations: ['0001_core_loop.sql'],
    source: {
      tableCount: 16,
      tables: EXPECTED_PERSISTED_TABLES.slice(),
      rowCounts: { agents: 1 },
      digests: { agents: 'abc' },
      sequences: { run_logs_id_seq: { name: 'run_logs_id_seq', lastValue: 1, isCalled: true } },
    },
    restore: {
      tableCount: 16,
      tables: EXPECTED_PERSISTED_TABLES.slice(),
      rowCounts: { agents: 1 },
      digests: { agents: 'abc' },
      matchesSource: true,
      sequences: { run_logs_id_seq: { name: 'run_logs_id_seq', lastValue: 1, isCalled: true } },
    },
    archiveRelativePath: path.join(workDir, 'phase0-sanitized.dump'),
    postgresVersion: 'postgres (PostgreSQL) 17.x',
    durationMs: 12,
    clusterStopped: true,
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.ok, true);
  assert.equal(report.clusterStopped, true);
  assert.deepEqual(report.source.tables, EXPECTED_PERSISTED_TABLES.slice().sort());
  assert.deepEqual(report.restore.tables, EXPECTED_PERSISTED_TABLES.slice().sort());
  assert.equal(report.source.sequences.run_logs_id_seq.lastValue, 1);
  assert.equal(report.workDir, '$WORK_DIR');
  assert.equal(report.archive, '$WORK_DIR/phase0-sanitized.dump');
  assert.doesNotMatch(serialized, /\/Users\/[^/\s"']+/);
  assert.doesNotMatch(serialized, /postgresql:\/\//);
  assert.doesNotMatch(serialized, /DATABASE_URL/);
});

test('CLI rejects DATABASE_URL flags and nonempty work directories', () => {
  const nonempty = makeEmptyWorkDir();
  fs.writeFileSync(path.join(nonempty, 'x'), '1', 'utf8');
  const rejectedUrl = spawnSync(process.execPath, [CLI_PATH, '--database-url', 'postgresql://x/y'], {
    encoding: 'utf8',
  });
  assert.notEqual(rejectedUrl.status, 0);
  assert.match(`${rejectedUrl.stdout}\n${rejectedUrl.stderr}`, /forbidden|Unknown argument|DATABASE_URL/i);

  const rejectedDir = spawnSync(process.execPath, [CLI_PATH, '--work-dir', nonempty], {
    encoding: 'utf8',
  });
  assert.notEqual(rejectedDir.status, 0);
  assert.match(`${rejectedDir.stdout}\n${rejectedDir.stderr}`, /empty/i);
  fs.rmSync(nonempty, { recursive: true, force: true });
});

test('full ephemeral dump/restore rehearsal succeeds without writing docs evidence', async () => {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    assert.ok(true, 'postgresql binaries missing; pure safety tests still cover contracts');
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
        timeout: 180_000,
        env: {
          ...process.env,
          PHASE0_PG_BIN: binDir,
          DATABASE_URL: '',
        },
      },
    );
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, output);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.clusterStopped, true);
    assert.equal(report.ownershipState, OWNERSHIP_STATE);
    assert.equal(report.restore.matchesSource, true);
    assert.deepEqual(report.source.tables, EXPECTED_PERSISTED_TABLES.slice().sort());
    assert.deepEqual(report.restore.tables, EXPECTED_PERSISTED_TABLES.slice().sort());
    assert.equal(report.source.sequences.run_logs_id_seq.lastValue >= 1, true);
    assert.equal(
      report.source.sequences.run_logs_id_seq.lastValue,
      report.restore.sequences.run_logs_id_seq.lastValue,
    );
    for (const table of EXPECTED_PERSISTED_TABLES) {
      assert.equal(report.source.rowCounts[table] > 0, true, `${table} should be seeded`);
      assert.equal(report.source.rowCounts[table], report.restore.rowCounts[table], `${table} count mismatch`);
      assert.equal(report.source.digests[table], report.restore.digests[table], `${table} digest mismatch`);
    }
    assert.doesNotMatch(result.stdout, /\/Users\/[^/\s"']+/);
    assert.doesNotMatch(result.stdout, /sk-[A-Za-z0-9]{8,}/);
    assert.equal(report.archive, '$WORK_DIR/phase0-sanitized.dump');
    assert.equal(Object.hasOwn(report, 'evidencePath'), false);
    assert.equal(fs.existsSync(path.join(workDir, 'phase0-sanitized.dump')), true);

    // Automated tests must not mutate the durable evidence file.
    const afterEvidence = fs.existsSync(EVIDENCE_PATH)
      ? fs.readFileSync(EVIDENCE_PATH, 'utf8')
      : null;
    assert.equal(afterEvidence, beforeEvidence);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
