'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  probeProcessLiveness,
  readPostmasterPid,
  waitForKnownPidGone,
} = require('./phase0-snapshot-restore');

const DEFAULT_LOCAL_POSTGRES_PORT = 55432;

function defaultRunBin(binDir, name, args, options = {}) {
  return execFileSync(path.join(binDir, name), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function commandOutput(error) {
  return `${error?.stdout || ''}${error?.stderr || ''}${error?.message || ''}`;
}

function explicitNoServer(output) {
  return /no server running|PID file .* does not exist/i.test(String(output || ''));
}

function quotePostgresValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function appendPostgresConfig(filePath, values, fsModule = fs) {
  const lines = Object.entries(values).map(([key, value]) => `${key} = ${value}`);
  fsModule.appendFileSync(filePath, `\n${lines.join('\n')}\n`, 'utf8');
}

async function defaultWaitForReady({
  binDir,
  socketDir,
  port,
  role,
  runBin,
  attempts = 80,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runBin(
        binDir,
        'pg_isready',
        ['-h', socketDir, '-p', String(port), '-U', role],
        { timeout: 2_000 },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('ephemeral PostgreSQL did not become ready');
}

async function runWithCleanup(body, cleanup) {
  let value;
  let bodyError;
  try {
    value = await body();
  } catch (error) {
    bodyError = error;
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (bodyError && cleanupError) {
    throw new AggregateError(
      [bodyError, cleanupError],
      'PostgreSQL scenario and teardown both failed',
    );
  }
  if (bodyError) throw bodyError;
  if (cleanupError) throw cleanupError;
  return value;
}

function createLocalPostgresCluster({
  binDir,
  workDir,
  dataDir = path.join(workDir, 'pgdata'),
  socketDir = path.join(workDir, 'socket'),
  logFile = path.join(workDir, 'postgres.log'),
  role,
  port = DEFAULT_LOCAL_POSTGRES_PORT,
  ownsWorkDir = false,
  expectedPostmasterPid = 0,
  fsModule = fs,
  runBin = defaultRunBin,
  probeProcess = probeProcessLiveness,
  waitForPidGone = waitForKnownPidGone,
  killProcess = process.kill.bind(process),
  waitForReady = defaultWaitForReady,
} = {}) {
  if (!binDir) throw new Error('PostgreSQL bin directory is required');
  if (!workDir || !dataDir || !socketDir || !logFile) {
    throw new Error('PostgreSQL lifecycle paths are required');
  }
  if (!role) throw new Error('PostgreSQL local role is required');

  let postmasterPid = Number(expectedPostmasterPid) > 0
    ? Number(expectedPostmasterPid)
    : 0;
  let startAttempted = false;
  let stopResult = null;

  const cluster = {
    binDir,
    workDir,
    dataDir,
    socketDir,
    logFile,
    role,
    port: Number(port),
    get postmasterPid() {
      return postmasterPid;
    },
    get startAttempted() {
      return startAttempted;
    },
    get stopResult() {
      return stopResult;
    },
    connectionString(database) {
      return `postgresql://${encodeURIComponent(role)}@/${encodeURIComponent(database)}`
        + `?host=${encodeURIComponent(socketDir)}&port=${Number(port)}`;
    },
    async start({
      initialize = true,
      config = {},
      readyAttempts = 80,
    } = {}) {
      fsModule.mkdirSync(socketDir, { recursive: true });
      if (initialize) {
        runBin(binDir, 'initdb', [
          '-D', dataDir,
          '-A', 'trust',
          '-U', role,
          '--locale=C',
          '--encoding=UTF8',
        ], { timeout: 60_000 });
      }
      if (Object.keys(config).length > 0) {
        appendPostgresConfig(path.join(dataDir, 'postgresql.conf'), config, fsModule);
      }

      startAttempted = true;
      runBin(binDir, 'pg_ctl', [
        '-D', dataDir,
        '-l', logFile,
        '-o', [
          `-p ${Number(port)}`,
          `-k ${quotePostgresValue(socketDir)}`,
          "-c listen_addresses=''",
          `-c unix_socket_directories=${quotePostgresValue(socketDir)}`,
        ].join(' '),
        'start',
      ], { timeout: 30_000 });
      await waitForReady({
        binDir,
        socketDir,
        port: Number(port),
        role,
        runBin,
        attempts: readyAttempts,
      });
      postmasterPid = readPostmasterPid(dataDir, fsModule);
      if (postmasterPid <= 0) {
        throw new Error('PostgreSQL started without a readable postmaster PID');
      }
      const live = probeProcess(postmasterPid);
      if (!live?.alive || live?.ambiguous) {
        throw new Error('PostgreSQL postmaster PID could not be verified after start');
      }
      return cluster;
    },
    async stop({ pool = null } = {}) {
      let poolError;
      if (pool && typeof pool.end === 'function') {
        try {
          await pool.end();
        } catch (error) {
          poolError = error;
        }
      }

      const diskPid = readPostmasterPid(dataDir, fsModule);
      const knownPid = postmasterPid || (startAttempted ? diskPid : 0);
      if (knownPid > 0) postmasterPid = knownPid;
      let stopSucceeded = false;
      let stopError = '';
      if (startAttempted || postmasterPid > 0) {
        try {
          runBin(
            binDir,
            'pg_ctl',
            ['-D', dataDir, '-m', 'fast', 'stop'],
            { timeout: 15_000 },
          );
          stopSucceeded = true;
        } catch (error) {
          stopError = commandOutput(error);
        }
      }

      let pidState = knownPid > 0
        ? probeProcess(knownPid)
        : { gone: false, alive: false, ambiguous: true, reason: 'pid_unavailable' };
      let fallbackKillAttempted = false;
      if (knownPid > 0 && !pidState?.gone && !pidState?.ambiguous) {
        fallbackKillAttempted = true;
        try {
          killProcess(knownPid, 'SIGTERM');
        } catch (error) {
          if (error?.code === 'ESRCH') {
            pidState = { gone: true, alive: false, ambiguous: false, reason: 'ESRCH' };
          } else {
            pidState = { gone: false, alive: false, ambiguous: true, reason: error?.code || 'kill_failed' };
          }
        }
        if (!pidState.gone && !pidState.ambiguous) {
          pidState = waitForPidGone(knownPid, {
            probe: probeProcess,
            attempts: 20,
            intervalMs: 100,
          });
        }
      }

      let statusOutput = '';
      let statusExitCode = 0;
      try {
        statusOutput = String(
          runBin(binDir, 'pg_ctl', ['-D', dataDir, 'status'], { timeout: 5_000 }) || '',
        );
      } catch (error) {
        statusOutput = commandOutput(error);
        statusExitCode = Number(error?.status) || 1;
      }

      const exactPidGone = knownPid > 0 && Boolean(pidState?.gone);
      const noPidAndNoServer = knownPid <= 0 && explicitNoServer(statusOutput);
      const neverStarted = !startAttempted && knownPid <= 0 && diskPid <= 0;
      const stopped = exactPidGone || noPidAndNoServer || neverStarted;
      stopResult = {
        stopped,
        stopSucceeded,
        stopError,
        statusOutput,
        statusExitCode,
        postmasterPid: knownPid,
        knownPidGone: exactPidGone,
        fallbackKillAttempted,
        fallbackKillSucceeded: fallbackKillAttempted && exactPidGone,
        retainedWorkDir: stopped || !fsModule.existsSync(workDir) ? '' : workDir,
        logFile,
      };

      if (stopped && ownsWorkDir && fsModule.existsSync(workDir)) {
        fsModule.rmSync(workDir, { recursive: true, force: true });
      }
      if (poolError) throw poolError;
      return stopResult;
    },
  };

  return cluster;
}

module.exports = {
  DEFAULT_LOCAL_POSTGRES_PORT,
  appendPostgresConfig,
  createLocalPostgresCluster,
  defaultRunBin,
  runWithCleanup,
};
