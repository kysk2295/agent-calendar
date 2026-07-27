'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createLocalPostgresCluster,
  runWithCleanup,
} = require('../app/lib/local-postgres-lifecycle');
const {
  withEphemeralPostgres,
} = require('./support/ephemeral-postgres.cjs');
const {
  probeProcessLiveness,
  resolvePostgresBinDir,
} = require('../app/lib/phase0-snapshot-restore');

function fakeClusterPaths(prefix) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    workDir,
    dataDir: path.join(workDir, 'pgdata'),
    socketDir: path.join(workDir, 'socket'),
    logFile: path.join(workDir, 'postgres.log'),
  };
}

test('partial pg_ctl start failure still attempts verified cleanup', async () => {
  const paths = fakeClusterPaths('local-pg-partial-');
  const calls = [];
  const cluster = createLocalPostgresCluster({
    ...paths,
    binDir: '/postgres/bin',
    role: 'tester',
    runBin(_binDir, name, args) {
      calls.push([name, args]);
      if (name === 'initdb') {
        fs.mkdirSync(paths.dataDir, { recursive: true });
        fs.writeFileSync(path.join(paths.dataDir, 'postmaster.pid'), '4242\n', 'utf8');
        return '';
      }
      if (name === 'pg_ctl' && args.includes('start')) throw new Error('start interrupted');
      if (name === 'pg_ctl' && args.includes('stop')) return '';
      if (name === 'pg_ctl' && args.includes('status')) {
        const error = new Error('no server');
        error.status = 3;
        error.stderr = 'pg_ctl: no server running\n';
        throw error;
      }
      return '';
    },
    probeProcess(pid) {
      assert.equal(pid, 4242);
      return { gone: true, alive: false, ambiguous: false, reason: 'ESRCH' };
    },
  });

  await assert.rejects(cluster.start(), /start interrupted/);
  const stop = await cluster.stop();
  assert.equal(stop.stopped, true);
  assert.equal(calls.some(([name, args]) => name === 'pg_ctl' && args.includes('stop')), true);
  fs.rmSync(paths.workDir, { recursive: true, force: true });
});

test('live PID after stop failure retains workdir and log', async () => {
  const paths = fakeClusterPaths('local-pg-retain-');
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'postmaster.pid'), '4343\n', 'utf8');
  fs.writeFileSync(paths.logFile, 'bounded postgres diagnostic\n', 'utf8');
  const cluster = createLocalPostgresCluster({
    ...paths,
    binDir: '/postgres/bin',
    role: 'tester',
    expectedPostmasterPid: 4343,
    runBin(_binDir, name, args) {
      if (name === 'pg_ctl' && args.includes('stop')) throw new Error('hung pg_ctl');
      if (name === 'pg_ctl' && args.includes('status')) return 'server is running (PID: 4343)\n';
      return '';
    },
    probeProcess: () => ({ gone: false, alive: true, ambiguous: false, reason: 'alive' }),
    killProcess: () => {},
    waitForPidGone: () => ({ gone: false, alive: true, ambiguous: false, reason: 'timeout' }),
  });

  const result = await cluster.stop();
  assert.equal(result.stopped, false);
  assert.equal(result.retainedWorkDir, paths.workDir);
  assert.equal(fs.existsSync(paths.workDir), true);
  assert.equal(fs.readFileSync(paths.logFile, 'utf8'), 'bounded postgres diagnostic\n');
  fs.rmSync(paths.workDir, { recursive: true, force: true });
});

test('confirmed exact PID exit permits owned workdir deletion', async () => {
  const paths = fakeClusterPaths('local-pg-delete-');
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'postmaster.pid'), '4444\n', 'utf8');
  const cluster = createLocalPostgresCluster({
    ...paths,
    binDir: '/postgres/bin',
    role: 'tester',
    ownsWorkDir: true,
    expectedPostmasterPid: 4444,
    runBin(_binDir, name, args) {
      if (name === 'pg_ctl' && args.includes('status')) {
        const error = new Error('no server');
        error.status = 3;
        error.stderr = 'pg_ctl: no server running\n';
        throw error;
      }
      return '';
    },
    probeProcess: () => ({ gone: true, alive: false, ambiguous: false, reason: 'ESRCH' }),
  });

  const result = await cluster.stop();
  assert.equal(result.stopped, true);
  assert.equal(result.postmasterPid, 4444);
  assert.equal(fs.existsSync(paths.workDir), false);
});

test('stale unowned PID file is never signaled and retains diagnostics', async () => {
  const paths = fakeClusterPaths('local-pg-stale-pid-');
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'postmaster.pid'), `${process.pid}\n`, 'utf8');
  let signaled = false;
  const cluster = createLocalPostgresCluster({
    ...paths,
    binDir: '/postgres/bin',
    role: 'tester',
    runBin(_binDir, name, args) {
      if (name === 'pg_ctl' && args.includes('status')) return 'server is running\n';
      throw new Error('unowned cluster');
    },
    killProcess: () => {
      signaled = true;
    },
  });

  const result = await cluster.stop();
  assert.equal(signaled, false);
  assert.equal(result.stopped, false);
  assert.equal(result.postmasterPid, 0);
  assert.equal(result.retainedWorkDir, paths.workDir);
  fs.rmSync(paths.workDir, { recursive: true, force: true });
});

test('scenario and teardown failures are preserved in an AggregateError', async () => {
  const bodyError = new Error('scenario failed');
  const teardownError = new Error('teardown failed');
  await assert.rejects(
    runWithCleanup(
      async () => { throw bodyError; },
      async () => { throw teardownError; },
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [bodyError, teardownError]);
      return true;
    },
  );
});

test('two real socket-only clusters use the same port and stop their exact PIDs', async (t) => {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    t.skip('PostgreSQL binaries missing');
    return;
  }

  const port = 55439;
  const clusters = await Promise.all([
    withEphemeralPostgres({
      binDir,
      prefix: 'local-pg-concurrent-a-',
      role: 'sameport',
      database: 'sameport_a',
      port,
      retainWorkDir: true,
    }, async ({ pool, cluster }) => {
      const selected = await pool.query('select 1 as n');
      return { pid: cluster.postmasterPid, n: selected.rows[0].n, workDir: cluster.workDir };
    }),
    withEphemeralPostgres({
      binDir,
      prefix: 'local-pg-concurrent-b-',
      role: 'sameport',
      database: 'sameport_b',
      port,
      retainWorkDir: true,
    }, async ({ pool, cluster }) => {
      const selected = await pool.query('select 1 as n');
      return { pid: cluster.postmasterPid, n: selected.rows[0].n, workDir: cluster.workDir };
    }),
  ]);

  try {
    assert.deepEqual(clusters.map(({ n }) => n), [1, 1]);
    for (const { pid } of clusters) {
      assert.equal(probeProcessLiveness(pid).gone, true, `postmaster ${pid} survived`);
    }
  } finally {
    for (const { workDir } of clusters) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test('real scenario failure closes pool, stops exact PID, and leaves no postmaster', async (t) => {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    t.skip('PostgreSQL binaries missing');
    return;
  }
  let pid = 0;
  await assert.rejects(
    withEphemeralPostgres({
      binDir,
      prefix: 'local-pg-failing-body-',
      role: 'failurecase',
      database: 'failurecase',
    }, async ({ cluster }) => {
      pid = cluster.postmasterPid;
      throw new Error('intentional PITR-style verification failure');
    }),
    /intentional PITR-style verification failure/,
  );
  assert.ok(pid > 0);
  assert.equal(probeProcessLiveness(pid).gone, true);
});
