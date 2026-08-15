'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  listDesktopApiPaths,
  matchProductionRoute,
} = require('../app/lib/production-route-registry');
const { clientV1ContractManifest } = require('../app/lib/client-v1-contract');
const { DurableExecution } = require('../app/lib/durable-execution');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { dispatchProductionApi } = require('../app/lib/production-gateway-dispatch');
const { handleScopedProductRoute } = require('../app/lib/production-product-routes');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

function responseHarness() {
  return {
    status: 0,
    headers: {},
    json: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(payload = '') { this.json = payload ? JSON.parse(String(payload)) : null; },
  };
}

test('production exposes authenticated Work Intake preview and start routes', () => {
  const expected = [
    ['POST', '/api/work-intake/preview', 'work_intake_preview'],
    ['POST', '/api/work-intake/start', 'work_intake_start'],
  ];
  for (const [method, routePath, action] of expected) {
    const matched = matchProductionRoute(method, routePath);
    assert.ok(matched);
    assert.equal(matched.route.class, 'scoped_product');
    assert.equal(matched.route.role, 'member');
    assert.equal(matched.route.persistence, 'write');
    assert.equal(matched.route.idempotent, true);
    assert.equal(matched.route.action, action);
    assert.equal(listDesktopApiPaths().includes(`${method} ${routePath}`), true);
  }
  const operations = clientV1ContractManifest.families
    .find((family) => family.id === 'agent-work')?.operations || [];
  assert.equal(operations.some((operation) => operation.id === 'work-intake.preview'), true);
  assert.equal(operations.some((operation) => operation.id === 'work-intake.start'), true);
});

test('DurableExecution previews an active Responsible Agent without persisting Work', async () => {
  const queries = [];
  const query = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/select m\.role as role/.test(normalized)) {
      return { rowCount: 1, rows: [{ role: 'owner' }] };
    }
    if (/select id, payload from agents/.test(normalized)) {
      return {
        rowCount: 1,
        rows: [{
          id: 'agent-research',
          payload: {
            displayName: 'Research agent',
            enabled: true,
            profileVersion: 3,
            lifecycle: { state: 'active' },
            role: 'Researcher',
            responsibility: 'Research and write cited briefs.',
            instructions: 'Separate evidence from inference.',
            specialties: ['research'],
          },
        }],
      };
    }
    if (/from runners/.test(normalized)) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  };
  const client = { query, release() {} };
  const pool = { query, async connect() { return client; } };
  const scope = await resolveWorkspaceScope(pool, {
    workspaceId: 'workspace-preview-a',
    userId: 'user-preview-a',
  });

  const preview = await new DurableExecution({ pool }).previewWork(scope, {
    agentId: 'agent-research',
    goal: 'Prepare an evidence-backed brief.',
  });

  assert.equal(preview.workspaceId, 'workspace-preview-a');
  assert.equal(preview.responsibleAgent.agentId, 'agent-research');
  assert.equal(preview.effectiveConfiguration.executable, true);
  assert.match(preview.effectiveConfiguration.snapshotId, /^ecfg_/);
  assert.equal(queries.some(({ sql }) => /insert into agent_missions/.test(sql)), false);
  const agentQuery = queries.find(({ sql }) => /select id, payload from agents/.test(sql));
  assert.deepEqual(agentQuery?.params, ['workspace-preview-a', 'agent-research']);
});

test('phase1 runtime composes exactly one Work Intake boundary over its DurableExecution', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '../app/lib/phase1-auth-routes.js',
  ), 'utf8');
  const start = source.indexOf('function createPhase1Runtime');
  const end = source.indexOf('\nasync function readJsonBody', start);
  const runtimeSource = source.slice(start, end);
  assert.equal((runtimeSource.match(/new DurableExecution\(/g) || []).length, 1);
  assert.equal((runtimeSource.match(/new WorkContextAssembler\(/g) || []).length, 1);
  assert.equal((runtimeSource.match(/new WorkIntake\(/g) || []).length, 1);
  assert.equal((runtimeSource.match(/product\.setWorkIntake\(/g) || []).length, 1);

  const pool = {
    query: async () => ({ rowCount: 0, rows: [] }),
    async connect() {
      return { query: this.query, release() {} };
    },
  };
  const runtime = createPhase1Runtime({
    pool,
    authKit: null,
    workosConfig: null,
    env: {
      DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
      UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
    },
  });
  assert.ok(runtime.workIntake);
  assert.equal(runtime.product.workIntake, runtime.workIntake);
  assert.equal(runtime.workIntake.durableExecution, runtime.durableExecution);
});

test('Work Intake HTTP is authenticated, caller-Workspace scoped, and rejects unavailable envelopes', async () => {
  const anonymous = responseHarness();
  const request = Readable.from([Buffer.from('{}')]);
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  await dispatchProductionApi(request, anonymous, new URL('https://example.test/api/work-intake/preview'), {
    env: {},
    runtime: {
      pool: { query: async () => ({ rowCount: 0, rows: [] }) },
      product: {},
    },
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, 'workspace_auth_required');

  const calls = [];
  const runtime = {
    product: {},
    workIntake: {
      async preview(scope, body) {
        calls.push({ kind: 'preview', scope, body });
        return { snapshotId: 'wip-a', workspaceId: scope.workspaceId };
      },
      async start(scope, body) {
        calls.push({ kind: 'start', scope, body });
        return {
          ok: true,
          missionId: 'mission-a',
          work: { id: 'mission-a' },
          conversation: { id: 'session-a' },
          message: { id: 'message-a' },
          idempotentReplay: false,
          workspaceId: scope.workspaceId,
        };
      },
    },
  };
  const startResponse = responseHarness();
  await handleScopedProductRoute({
    req: {},
    res: startResponse,
    method: 'POST',
    pathname: '/api/work-intake/start',
    params: {},
    route: { action: 'work_intake_start' },
    body: { previewSnapshotId: 'wip-a', workspaceId: 'workspace-attacker' },
    query: {},
    scope: { workspaceId: 'workspace-caller', userId: 'user-caller', role: 'member' },
    runtime,
  });
  assert.equal(startResponse.status, 200);
  assert.equal(startResponse.json.workspaceId, 'workspace-caller');
  assert.equal(calls[0].scope.workspaceId, 'workspace-caller');

  const unavailable = responseHarness();
  await handleScopedProductRoute({
    req: {},
    res: unavailable,
    method: 'POST',
    pathname: '/api/work-intake/preview',
    params: {},
    route: { action: 'work_intake_preview' },
    body: { goal: 'Use a persisted context envelope', contextEnvelopeId: 'ctx-missing' },
    query: {},
    scope: { workspaceId: 'workspace-caller', userId: 'user-caller', role: 'member' },
    runtime,
  });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.json.error, 'CONTEXT_ENVELOPE_UNAVAILABLE');
  assert.equal(calls.some((call) => call.kind === 'preview'), false);
});
