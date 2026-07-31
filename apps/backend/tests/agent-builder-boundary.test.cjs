'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PRODUCTION_ROUTES } = require('../app/lib/production-route-registry');
const { clientV1ContractManifest } = require('../app/lib/client-v1-contract');
const { runConnectorOnce } = require('../../runner/lib/connector-loop');
const { buildArgv: buildCodexArgv } = require('../../runner/lib/engines/codex');

const migrationsDir = path.join(__dirname, '../app/db/migrations');

function lifecycleRoute(method, pathPattern) {
  return PRODUCTION_ROUTES.find((route) => (
    route.method === method && route.pathPattern === pathPattern
  ));
}

test('migration inventory persists immutable activated agent profile versions', () => {
  const sql = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    .join('\n');

  assert.match(sql, /create table if not exists agent_profile_versions/i);
  assert.match(sql, /primary key\s*\(\s*workspace_id\s*,\s*agent_id\s*,\s*profile_version\s*\)/i);
  assert.match(sql, /profile_snapshot\s+jsonb\s+not null/i);
  assert.match(sql, /test_evidence\s+jsonb\s+not null/i);
});

test('production and Desktop contracts expose owner-only builder lifecycle routes', () => {
  const expected = [
    ['POST', '/api/agents/builder', 'agent_builder_create'],
    ['POST', '/api/agents/:id/review', 'agent_builder_review'],
    ['POST', '/api/agents/:id/tests', 'agent_builder_test_start'],
    ['GET', '/api/agents/:id/tests/:requestId', 'agent_builder_test_get'],
    ['POST', '/api/agents/:id/tests/:requestId/cancel', 'agent_builder_test_cancel'],
    ['POST', '/api/agents/:id/activate', 'agent_builder_activate'],
    ['GET', '/api/agents/:id/profile-versions', 'agent_builder_versions_list'],
  ];
  for (const [method, pathPattern, action] of expected) {
    const route = lifecycleRoute(method, pathPattern);
    assert.ok(route, `${method} ${pathPattern} must be registered`);
    assert.equal(route.action, action);
    assert.equal(route.class, 'scoped_product');
    assert.equal(route.role, 'owner');
  }

  const operations = clientV1ContractManifest.families
    .flatMap((family) => family.operations)
    .filter((operation) => operation.id.startsWith('agent-control.builder'));
  assert.deepEqual(
    operations.map((operation) => [operation.method, operation.pathPattern, operation.action]),
    expected.map(([method, routePath, action]) => [method, routePath, action]),
  );
});

test('Runner executes a dedicated builder test with bounded no-side-effect policy', async () => {
  const requests = [];
  const client = {
    state: {},
    async deviceRequest(method, requestPath, body) {
      requests.push({ method, path: requestPath, body });
      if (requestPath === '/api/runner/device/connectors/next') {
        return {
          request: {
            id: 'builder-test-1',
            kind: 'agent_builder_test',
            provider: 'codex',
            payload: {
              agentId: 'agent-1',
              revision: 1,
              prompt: 'Return one bounded summary.',
              timeoutMs: 500,
            },
          },
        };
      }
      return { ok: true };
    },
  };
  let received = null;
  const result = await runConnectorOnce(client, {
    builderTestRunner: async (input) => {
      received = input;
      return {
        passed: true,
        summary: 'Bounded response.',
        durationMs: 25,
      };
    },
  });

  assert.equal(result.completed, true);
  assert.deepEqual(received.policy, {
    disposable: true,
    calendarProjection: false,
    externalDelivery: false,
    defaultDeny: true,
    maxOutputBytes: 16_384,
  });
  assert.equal(received.timeoutMs, 500);
  const completion = requests.find((entry) => entry.path.endsWith('/complete'));
  assert.deepEqual(completion.body.result.sideEffects, {
    calendar: 0,
    externalDelivery: 0,
    schedulerJobs: 0,
  });
});

test('hung disposable Runner test fails with a bounded timeout instead of false success', async () => {
  const requests = [];
  const client = {
    state: {},
    async deviceRequest(method, requestPath, body) {
      requests.push({ method, path: requestPath, body });
      if (requestPath.endsWith('/next')) {
        return {
          request: {
            id: 'builder-test-hung',
            kind: 'agent_builder_test',
            provider: 'codex',
            payload: {
              agentId: 'agent-1',
              revision: 1,
              prompt: 'Never resolves',
              timeoutMs: 10,
            },
          },
        };
      }
      return { ok: true };
    },
  };

  const result = await runConnectorOnce(client, {
    builderTestRunner: async () => new Promise(() => {}),
  });
  assert.equal(result.failed, true);
  assert.equal(result.error, 'AGENT_BUILDER_TEST_TIMEOUT');
  const failed = requests.find((entry) => entry.path.endsWith('/fail'));
  assert.equal(failed.body.errorCode, 'AGENT_BUILDER_TEST_TIMEOUT');
});

test('production builder evaluator ignores user tools and enforces read-only no-network Codex isolation', () => {
  const args = buildCodexArgv({
    cwd: '/tmp/disposable-builder',
    model: 'gpt-5',
    disposableNoTools: true,
  });
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--ephemeral'));
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), [
    '--sandbox',
    'read-only',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--disable'), args.indexOf('--disable') + 2), [
    '--disable',
    'web_search',
  ]);
  assert.equal(args.includes('workspace-write'), false);
  assert.equal(args.includes('resume'), false);
});

test('production builder evaluator refuses an engine without the enforced isolation profile', async () => {
  const requests = [];
  const client = {
    state: {},
    async deviceRequest(method, requestPath, body) {
      requests.push({ method, path: requestPath, body });
      if (requestPath.endsWith('/next')) {
        return {
          request: {
            id: 'builder-test-unsafe-provider',
            kind: 'agent_builder_test',
            provider: 'claude',
            payload: {
              agentId: 'agent-1',
              revision: 1,
              prompt: 'Must not launch an ordinary provider process.',
              timeoutMs: 500,
            },
          },
        };
      }
      return { ok: true };
    },
  };
  const result = await runConnectorOnce(client);
  assert.equal(result.failed, true);
  assert.equal(result.error, 'AGENT_BUILDER_TEST_PROVIDER_UNSAFE');
  const failed = requests.find((entry) => entry.path.endsWith('/fail'));
  assert.equal(failed.body.errorCode, 'AGENT_BUILDER_TEST_PROVIDER_UNSAFE');
});
