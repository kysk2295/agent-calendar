'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { ProviderAgentBridge } = require('../app/lib/provider-agent-session-bridge');
const {
  probeProcessLiveness,
  resolvePostgresBinDir,
} = require('../app/lib/phase0-snapshot-restore');
const { WorkspaceAgentBuilderService } = require('../app/lib/workspace-agent-builder-service');
const { WorkspaceScopedProductService } = require('../app/lib/workspace-scoped-product-service');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { withEphemeralPostgres } = require('./support/ephemeral-postgres.cjs');

async function completeBuilderTest(bridge, pool, result) {
  const runner = (await pool.query(
    `select * from runners where workspace_id = 'ws-builder' and id = 'runner-builder'`,
  )).rows[0];
  const next = await bridge.nextConnectorRequest(runner);
  assert.equal(next.request.kind, 'agent_builder_test');
  await bridge.completeConnectorRequest(runner, {
    requestId: next.request.id,
    result,
  });
  return next.request.id;
}

test('PostgreSQL lifecycle persists fail→pass→v1→edit→v2 without side effects or history rewrite', async () => {
  const binDir = resolvePostgresBinDir(process.env);
  assert.ok(binDir, 'PostgreSQL binaries are required for the persisted lifecycle proof');

  let postmasterPid = 0;
  let ownedWorkDir = '';
  let ownedPort = 0;
  await withEphemeralPostgres({
    binDir,
    prefix: 'agent-builder-lifecycle-',
    role: 'agentbuilder',
    database: 'agent_builder_lifecycle',
  }, async ({ pool, cluster, workDir, port }) => {
    postmasterPid = cluster.postmasterPid;
    ownedWorkDir = workDir;
    ownedPort = port;
    await runMigrations({ pool });
    await pool.query(`insert into users (id, display_name, status)
      values ('user-builder', 'Builder Owner', 'active')`);
    await pool.query(`insert into workspaces (id, name, status)
      values ('ws-builder', 'Builder Workspace', 'active')`);
    await pool.query(`insert into workspace_memberships (
      id, user_id, workspace_id, role, status
    ) values (
      'membership-builder', 'user-builder', 'ws-builder', 'owner', 'active'
    )`);
    await pool.query(`insert into runners (
      id, workspace_id, status, connection_state, capabilities, last_seen_at
    ) values (
      'runner-builder', 'ws-builder', 'active', 'connected',
      '{"catalog":{"catalogId":"builder","version":1,"entries":[]}}'::jsonb,
      now()
    )`);

    const scope = await resolveWorkspaceScope(pool, {
      userId: 'user-builder',
      workspaceId: 'ws-builder',
    });
    const service = new WorkspaceAgentBuilderService({ pool });
    const bridge = new ProviderAgentBridge({ pool });
    const product = new WorkspaceScopedProductService({ pool, useAppRole: true });
    const runner = (await pool.query(
      `select * from runners where workspace_id = 'ws-builder' and id = 'runner-builder'`,
    )).rows[0];
    const hostileRequest = '<img src=x onerror=alert(1)> Summarize three sources; do not ask for credentials.';
    const draft = await service.createDraft(scope, { request: hostileRequest });
    assert.equal(draft.lifecycle.state, 'draft');
    assert.equal(draft.enabled, false);
    assert.equal(draft.lifecycle.request, hostileRequest);
    assert.deepEqual(draft.grants, { allow: [], deny: [] });
    assert.equal(JSON.stringify(draft).includes('apiKey'), false);

    const reloaded = (await product.listAgents(scope)).find((agent) => agent.id === draft.id);
    assert.equal(reloaded.lifecycle.state, 'draft');
    assert.equal(reloaded.enabled, false);
    await assert.rejects(
      () => service.activate(scope, draft.id, {
        expectedRevision: 1,
        requestId: 'missing',
      }),
      (error) => error?.code === 'agent_activation_ineligible' && error?.statusHint === 409,
    );

    await service.reviewDraft(scope, draft.id, { expectedRevision: 1 });
    const lateStart = await service.startTest(scope, draft.id, {
      expectedRevision: 1,
      timeoutMs: 500,
    });
    await pool.query(
      `update runner_connector_requests
       set expires_at = now() - interval '1 millisecond'
       where id = $1`,
      [lateStart.request.id],
    );
    const lateCompletion = await bridge.completeConnectorRequest(runner, {
      requestId: lateStart.request.id,
      result: {
        passed: true,
        summary: 'This success arrived after the authoritative deadline.',
        durationMs: 501,
        sideEffects: { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
      },
    });
    assert.equal(lateCompletion.status, 'failed');
    const lateEvidence = await service.getTest(scope, draft.id, lateStart.request.id);
    assert.equal(lateEvidence.request.status, 'timed_out');
    assert.equal(lateEvidence.agent.lifecycle.state, 'draft');
    assert.equal(lateEvidence.agent.enabled, false);

    const failedStart = await service.startTest(scope, draft.id, {
      expectedRevision: 1,
      timeoutMs: 2_000,
    });
    const failedRequestId = await completeBuilderTest(bridge, pool, {
      passed: false,
      summary: 'Bounded sample failed its explicit assertion.',
      durationMs: 35,
      sideEffects: { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
    });
    assert.equal(failedRequestId, failedStart.request.id);
    const failed = await service.getTest(scope, draft.id, failedRequestId);
    assert.equal(failed.request.status, 'failed');
    assert.equal(failed.agent.lifecycle.state, 'draft');
    assert.equal(failed.agent.enabled, false);
    await assert.rejects(
      () => service.activate(scope, draft.id, {
        expectedRevision: 1,
        requestId: failedRequestId,
      }),
      (error) => error?.code === 'agent_activation_ineligible',
    );

    const failedCounts = await pool.query(`select
      (select count(*)::int from calendar_events where workspace_id = 'ws-builder') as calendar,
      (select count(*)::int from scheduler_jobs where workspace_id = 'ws-builder') as jobs,
      (
        select count(*)::int from work_conversation_channel_receipts
        where workspace_id = 'ws-builder' and direction = 'outbound'
      ) as delivery`);
    assert.deepEqual(failedCounts.rows[0], { calendar: 0, jobs: 0, delivery: 0 });

    await service.reviewDraft(scope, draft.id, { expectedRevision: 1 });
    const passedStart = await service.startTest(scope, draft.id, {
      expectedRevision: 1,
      timeoutMs: 2_000,
    });
    const passedRequestId = await completeBuilderTest(bridge, pool, {
      passed: true,
      summary: 'Bounded sample passed with no side effects.',
      durationMs: 42,
      sideEffects: { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
    });
    assert.equal(passedRequestId, passedStart.request.id);
    const passed = await service.getTest(scope, draft.id, passedRequestId);
    assert.equal(passed.request.status, 'passed');
    assert.equal(passed.agent.lifecycle.state, 'tested');
    assert.equal(passed.agent.enabled, false);
    const activeV1 = await service.activate(scope, draft.id, {
      expectedRevision: 1,
      requestId: passedRequestId,
    });
    assert.equal(activeV1.lifecycle.state, 'active');
    assert.equal(activeV1.profileVersion, 1);
    assert.equal(activeV1.enabled, true);

    await pool.query(
      `insert into scheduler_jobs (
         id, name, agent, model, enabled, interval_minutes, payload, workspace_id
       ) values (
         'historical-v1', 'Historical v1', $1, 'codex', true, 60, $2::jsonb, 'ws-builder'
       )`,
      [
        activeV1.id,
        JSON.stringify({
          profileSnapshot: {
            agentId: activeV1.id,
            profileVersion: 1,
            responseStyle: activeV1.responseStyle,
          },
        }),
      ],
    );
    const historicalBefore = (await pool.query(
      `select payload::text as payload from scheduler_jobs where id = 'historical-v1'`,
    )).rows[0].payload;

    const draftV2 = await product.updateAgent(scope, draft.id, {
      responseStyle: 'Cite the evidence before the conclusion.',
    });
    assert.equal(draftV2.profileVersion, 2);
    assert.equal(draftV2.lifecycle.state, 'draft');
    assert.equal(draftV2.enabled, false);
    await assert.rejects(
      () => service.reviewDraft(scope, draft.id, { expectedRevision: 1 }),
      (error) => error?.code === 'agent_builder_stale' && error?.statusHint === 409,
    );
    await service.reviewDraft(scope, draft.id, { expectedRevision: 2 });
    const v2Start = await service.startTest(scope, draft.id, {
      expectedRevision: 2,
      timeoutMs: 2_000,
    });
    const v2RequestId = await completeBuilderTest(bridge, pool, {
      passed: true,
      summary: 'Version two passed with no side effects.',
      durationMs: 39,
      sideEffects: { calendar: 0, externalDelivery: 0, schedulerJobs: 0 },
    });
    assert.equal(v2RequestId, v2Start.request.id);
    await service.getTest(scope, draft.id, v2RequestId);
    const activeV2 = await service.activate(scope, draft.id, {
      expectedRevision: 2,
      requestId: v2RequestId,
    });
    assert.equal(activeV2.profileVersion, 2);
    assert.equal(activeV2.lifecycle.activeVersion, 2);
    const versions = await service.listVersions(scope, draft.id);
    assert.deepEqual(versions.map((version) => version.profileVersion), [2, 1]);
    assert.deepEqual(versions.find((version) => version.profileVersion === 1).historicalJobs, [{
      id: 'historical-v1',
      name: 'Historical v1',
      profileVersion: 1,
    }]);
    const historicalAfter = (await pool.query(
      `select payload::text as payload from scheduler_jobs where id = 'historical-v1'`,
    )).rows[0].payload;
    assert.equal(historicalAfter, historicalBefore);
    assert.match(historicalAfter, /"profileVersion": 1/);

    const finalCounts = await pool.query(`select
      (select count(*)::int from agents where workspace_id = 'ws-builder') as agents,
      (select count(*)::int from agent_profile_versions where workspace_id = 'ws-builder') as versions,
      (select count(*)::int from calendar_events where workspace_id = 'ws-builder') as calendar,
      (
        select count(*)::int from work_conversation_channel_receipts
        where workspace_id = 'ws-builder' and direction = 'outbound'
      ) as delivery`);
    assert.deepEqual(finalCounts.rows[0], {
      agents: 1,
      versions: 2,
      calendar: 0,
      delivery: 0,
    });
    process.stdout.write(`${JSON.stringify({
      scenario: 'persisted-agent-builder-lifecycle',
      postgresPid: cluster.postmasterPid,
      port,
      workDir,
      lateCompletionStatus: lateCompletion.status,
      lateEvidenceStatus: lateEvidence.request.status,
      failedTestStatus: failed.request.status,
      activeVersions: versions.map((version) => version.profileVersion),
      historicalProfileVersion: 1,
      rowCounts: finalCounts.rows[0],
    })}\n`);
  });
  assert.equal(probeProcessLiveness(postmasterPid).gone, true);
  assert.equal(fs.existsSync(ownedWorkDir), false);
  const refused = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: ownedPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(true);
    });
  });
  assert.equal(refused, true);
  process.stdout.write(`${JSON.stringify({
    cleanup: 'ephemeral-postgres',
    postmasterPid,
    processGone: true,
    port: ownedPort,
    connectionRefused: true,
    workDir: ownedWorkDir,
    workDirRemoved: true,
  })}\n`);
});
