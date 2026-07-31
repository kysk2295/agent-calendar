'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DurableExecution,
  isPublicResolvedEngine,
  resolveEngine,
} = require('../app/lib/durable-execution');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { RunnerControl, normalizeRunnerCapabilities } = require('../app/lib/runner-control');
const { publicSessionEventRecord } = require('../app/lib/public-agent-records');

const FAKE_CAPABILITY = {
  available: true,
  status: 'available',
  authStatus: 'ok',
};

test('Backend ignores stored Fake capability for production auto and explicit resolution', () => {
  // Given: a legacy runner capability record containing only Fake.
  const capabilities = { engines: { fake: FAKE_CAPABILITY } };
  const env = { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' };

  // When: production resolves automatic and explicit requests.
  const automatic = resolveEngine('auto', capabilities, env);
  const explicit = resolveEngine('fake', capabilities, env);

  // Then: neither request becomes eligible.
  assert.equal(automatic.resolved, '');
  assert.equal(explicit.resolved, '');
});

test('Backend capability normalization rejects production Fake before persistence', () => {
  // Given: a production capability payload that includes Fake.
  const env = { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' };

  // When: the Gateway normalizes the report.
  const normalize = () => normalizeRunnerCapabilities({ fake: FAKE_CAPABILITY }, env);

  // Then: it rejects at the boundary with no normalized persistence payload.
  assert.throws(normalize, (error) => error.code === 'FAKE_ENGINE_FORBIDDEN' && error.statusHint === 422);
});

test('Gateway capability boundary rejects Fake before any persistence query', async () => {
  // Given: an authenticated production Runner and a query counter.
  let queries = 0;
  const control = new RunnerControl({
    pool: { query: async () => { queries += 1; return { rowCount: 0, rows: [] }; } },
    env: { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
  });
  control.authenticateDeviceRequest = async () => ({ runner: { id: 'runner-1', workspace_id: 'workspace-1' } });

  // When: the device reports Fake as a capability.
  const report = () => control.deviceCapabilities({ engines: { fake: FAKE_CAPABILITY } });

  // Then: it returns the boundary error before it can persist capabilities or audit data.
  await assert.rejects(report, (error) => error.code === 'FAKE_ENGINE_FORBIDDEN' && error.statusHint === 422);
  assert.equal(queries, 0);
});

test('Gateway rejects explicit production Fake work before any durable query', async () => {
  // Given: a real server-issued scope and a query counter.
  let queries = 0;
  const pool = {
    query: async () => {
      queries += 1;
      return { rowCount: 1, rows: [{ role: 'member' }] };
    },
  };
  const scope = await resolveWorkspaceScope(pool, { userId: 'user-1', workspaceId: 'workspace-1' });
  queries = 0;
  const durable = new DurableExecution({
    pool,
    env: { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
  });

  // When: the user explicitly requests Fake work.
  const create = () => durable.acceptWork(scope, { goal: 'forbidden', executionEngine: 'fake' });

  // Then: no mission, session, job, offer, audit, or calendar write is reached.
  await assert.rejects(create, (error) => error.code === 'FAKE_ENGINE_FORBIDDEN' && error.statusHint === 422);
  assert.equal(queries, 0);
});

test('Backend test policy admits Fake only with both exact keys', () => {
  // Given: a deterministic Fake-only capability payload and exact test policy keys.
  const env = { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' };

  // When: the policy boundary normalizes and resolves Fake.
  const capabilities = normalizeRunnerCapabilities({ fake: FAKE_CAPABILITY }, env);
  const resolved = resolveEngine('auto', { engines: capabilities }, env);

  // Then: the test harness can still exercise the deterministic Fake Engine.
  assert.equal(resolved.resolved, 'fake');
});

test('Backend public projection never recognizes Fake as a resolved engine', () => {
  // Given: legacy persisted execution metadata naming Fake.
  // When: it is considered for a public projection.
  const projected = isPublicResolvedEngine('fake');

  // Then: Fake is absent from the public engine allowlist.
  assert.equal(projected, false);
});

test('Public completion projection strips Fake and unknown engine metadata but retains recognized engines', () => {
  // Given: completion events with Fake, unknown, and recognized engine metadata.
  const fake = publicSessionEventRecord({
    id: 'event-fake',
    kind: 'completion',
    text: 'done',
    metadata: { executionEngine: 'fake', resolvedExecutionEngine: 'fake' },
  });
  const unknown = publicSessionEventRecord({
    id: 'event-unknown',
    kind: 'completion',
    text: 'done',
    metadata: { executionEngine: 'unknown', resolvedExecutionEngine: 'unknown' },
  });
  const recognized = publicSessionEventRecord({
    id: 'event-codex',
    kind: 'completion',
    text: 'done',
    metadata: { executionEngine: 'codex', resolvedExecutionEngine: 'codex' },
  });

  // When: the real public projector sanitizes each event.
  // Then: forbidden values are omitted while the recognized contract survives.
  assert.deepEqual(fake.metadata, undefined);
  assert.deepEqual(unknown.metadata, undefined);
  assert.deepEqual(recognized.metadata, { executionEngine: 'codex', resolvedExecutionEngine: 'codex' });
});
