'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RunnerControl,
  normalizeRunnerCapacity,
} = require('../app/lib/runner-control');
const {
  acquireRunnerCapacitySlot,
  DurableExecution,
} = require('../app/lib/durable-execution');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

test('Gateway persists a bounded Runner capacity report', async () => {
  assert.equal(normalizeRunnerCapacity(2), 2);
  assert.equal(normalizeRunnerCapacity(0), 1);
  assert.equal(normalizeRunnerCapacity(999), 8);
  const queries = [];
  const control = new RunnerControl({
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
    },
  });
  control.authenticateDeviceRequest = async () => ({
    runner: { id: 'runner-capacity', workspace_id: 'workspace-capacity' },
  });

  const result = await control.deviceCapabilities({
    engines: {},
    maxConcurrentWork: 2,
  });

  assert.equal(result.capabilities.maxConcurrentWork, 2);
  const persisted = JSON.parse(queries[0].params[0]);
  assert.equal(persisted.maxConcurrentWork, 2);
});

test('Runner list projects the connected Runner maxConcurrentWork capacity', async () => {
  const scope = await resolveWorkspaceScope({
    query: async () => ({ rowCount: 1, rows: [{ role: 'owner' }] }),
  }, {
    userId: 'user-capacity',
    workspaceId: 'workspace-capacity',
  });
  const control = new RunnerControl({
    pool: {
      query: async (sql) => {
        if (/select \* from runners/.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'runner-capacity',
              workspace_id: 'workspace-capacity',
              status: 'active',
              connection_state: 'connected',
              fingerprint_sha256: 'abcd',
              capabilities: { maxConcurrentWork: 2 },
            }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    },
  });

  const runners = await control.listRunners(scope);

  assert.equal(runners.length, 1);
  assert.equal(runners[0].connectionState, 'connected');
  assert.equal(runners[0].maxConcurrentWork, 2);
});

test('Gateway capacity slot counts open offers and live attempts before another offer', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/count\(\*\)::int as load/.test(sql)) {
        return { rowCount: 1, rows: [{ load: 2 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const runner = {
    id: 'runner-capacity',
    workspace_id: 'workspace-capacity',
    capabilities: { maxConcurrentWork: 2 },
  };

  const slot = await acquireRunnerCapacitySlot(client, runner, { includeOpenOffers: true });

  assert.deepEqual(slot, { available: false, capacity: 2, load: 2 });
  assert.match(queries[0].sql, /pg_advisory_xact_lock/);
  assert.match(queries[1].sql, /execution_attempts/);
  assert.match(queries[1].sql, /execution_offers/);
  assert.deepEqual(queries[1].params, ['workspace-capacity', 'runner-capacity']);
});

test('Gateway lease capacity ignores queued offers but refuses a third live attempt', async () => {
  const loads = [1, 2];
  const client = {
    query: async (sql) => {
      if (/count\(\*\)::int as load/.test(sql)) {
        return { rowCount: 1, rows: [{ load: loads.shift() }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const runner = {
    id: 'runner-capacity',
    workspace_id: 'workspace-capacity',
    capabilities: { maxConcurrentWork: 2 },
  };

  assert.deepEqual(
    await acquireRunnerCapacitySlot(client, runner, { includeOpenOffers: false }),
    { available: true, capacity: 2, load: 1 },
  );
  assert.deepEqual(
    await acquireRunnerCapacitySlot(client, runner, { includeOpenOffers: false }),
    { available: false, capacity: 2, load: 2 },
  );
});

test('Durable execution does not offer or lease above the reported Runner capacity', async () => {
  const queried = [];
  const pool = {
    query: async (sql) => {
      queried.push(sql);
      if (/select a\.\*, j\.session_id/.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/count\(\*\)::int as load/.test(sql)) {
        return { rowCount: 1, rows: [{ load: 1 }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const durable = new DurableExecution({ pool });
  const runner = {
    id: 'runner-capacity',
    workspace_id: 'workspace-capacity',
    status: 'active',
    connection_state: 'connected',
    capabilities: { maxConcurrentWork: 1 },
  };

  const next = await durable.nextOffer(runner);

  assert.deepEqual(next, {
    ok: true,
    offer: null,
    reason: 'runner_capacity_reached',
    capacity: 1,
  });
  assert.equal(queried.some((sql) => /from execution_jobs\s+where/.test(sql)), false);
  await assert.rejects(
    () => durable.leaseOffer(runner, { offerId: 'offer-over-capacity' }),
    (error) => error.code === 'RUNNER_CAPACITY_REACHED' && error.statusHint === 409,
  );
  assert.equal(queried.some((sql) => /select o\.\*, j\.attempt_count/.test(sql)), false);
});
