const { HermesStore } = require('./store');
const { PostgresHermesStore } = require('./postgres-store');

function createStore({
  env = process.env,
  dataDir,
  clock,
  pool,
} = {}) {
  if (env.DATABASE_URL) {
    return new PostgresHermesStore({
      env,
      dataDir,
      clock,
      pool,
    });
  }
  return new HermesStore({ dataDir, clock });
}

module.exports = {
  createStore,
};
