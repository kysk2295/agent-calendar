const fs = require('node:fs');
const path = require('node:path');

function createPoolFromEnv(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run Hermes DB migrations');
  }
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
}

async function runMigrations({
  pool,
  env = process.env,
  migrationsDir = path.join(__dirname, 'migrations'),
} = {}) {
  const ownedPool = pool || createPoolFromEnv(env);
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await ownedPool.query(sql);
  }

  if (!pool && ownedPool.end) {
    await ownedPool.end();
  }

  return { migrations: files };
}

module.exports = {
  createPoolFromEnv,
  runMigrations,
};
