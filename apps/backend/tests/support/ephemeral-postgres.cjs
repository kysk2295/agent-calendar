'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_LOCAL_POSTGRES_PORT,
  createLocalPostgresCluster,
  defaultRunBin,
  runWithCleanup,
} = require('../../app/lib/local-postgres-lifecycle');
const { resolvePostgresBinDir } = require('../../app/lib/phase0-snapshot-restore');

async function withEphemeralPostgres({
  binDir = resolvePostgresBinDir(process.env),
  prefix = 'agent-calendar-pg-',
  role,
  database,
  port = DEFAULT_LOCAL_POSTGRES_PORT,
  config = {},
  retainWorkDir = false,
  poolOptions = {},
} = {}, body) {
  if (!binDir) {
    throw Object.assign(new Error('PostgreSQL binaries missing'), { code: 'PG_BIN_MISSING' });
  }
  if (!role || !database) throw new Error('Ephemeral PostgreSQL role and database are required');
  if (typeof body !== 'function') throw new TypeError('Ephemeral PostgreSQL body is required');

  let workDir = '';
  let cluster = null;
  let pool = null;
  let stop = null;
  return runWithCleanup(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cluster = createLocalPostgresCluster({
      binDir,
      workDir,
      role,
      port,
      ownsWorkDir: !retainWorkDir,
    });
    await cluster.start({ config });
    defaultRunBin(binDir, 'createdb', [
      '-h', cluster.socketDir,
      '-p', String(cluster.port),
      '-U', role,
      database,
    ], { timeout: 15_000 });
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: cluster.connectionString(database),
      ssl: false,
      connectionTimeoutMillis: 10_000,
      ...poolOptions,
    });
    return body({
      pool,
      cluster,
      binDir,
      workDir,
      dataDir: cluster.dataDir,
      socketDir: cluster.socketDir,
      logFile: cluster.logFile,
      port: cluster.port,
      connectionString: cluster.connectionString(database),
    });
  }, async () => {
    if (!cluster) {
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      return;
    }
    stop = await cluster.stop({ pool });
    if (!stop.stopped) {
      const error = new Error(`ephemeral PostgreSQL teardown unconfirmed; retained ${workDir}`);
      error.code = 'PG_TEARDOWN_UNCONFIRMED';
      error.stop = stop;
      throw error;
    }
  });
}

module.exports = {
  withEphemeralPostgres,
};
