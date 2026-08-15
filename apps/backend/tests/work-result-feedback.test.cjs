'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const {
  buildCompletedWorkResultProjection,
} = require('../app/lib/agent-work-wiki-archive');
const { UnifiedCalendar } = require('../app/lib/unified-calendar');
const { DurableExecution } = require('../app/lib/durable-execution');
const { publicMissionRecord } = require('../app/lib/public-agent-records');
const { WorkspaceScopedProductService } = require('../app/lib/workspace-scoped-product-service');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { withEphemeralPostgres } = require('./support/ephemeral-postgres.cjs');

const NOW = Date.parse('2026-08-02T09:00:00.000Z');

async function withPostgres(fn) {
  return withEphemeralPostgres({
    prefix: 'work-result-feedback-',
    role: 'workresultfeedback',
    database: 'work_result_feedback',
  }, async ({ pool }) => {
    await runMigrations({ pool });
    await pool.query("insert into users (id, display_name, status) values ('user-a', 'Alex', 'active'), ('user-b', 'Blair', 'active')");
    await pool.query("insert into workspaces (id, name, status) values ('ws-a', 'A', 'active'), ('ws-b', 'B', 'active')");
    await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status)
      values ('membership-a', 'user-a', 'ws-a', 'owner', 'active'),
        ('membership-b', 'user-b', 'ws-b', 'owner', 'active')`);
    return fn({ pool });
  });
}

function completedWorkFixture() {
  const fullText = `# 최종 결과\n\n${'상세 근거 문장입니다. '.repeat(360)}\n\nEND-OF-FULL-RESULT`;
  const mission = {
    id: 'mission-current',
    workspaceId: 'ws-a',
    status: 'completed',
    title: 'Atlas 출시 조사',
    missionThreadId: 'conversation-current',
    currentResultReportId: 'report-current',
    completedAt: '2026-08-02T08:30:00.000Z',
  };
  const report = {
    id: 'report-current',
    missionId: mission.id,
    workspaceId: 'ws-a',
    status: 'ready',
    title: 'Atlas 출시 조사 결과',
    fullText,
    citations: [
      { handle: 'wiki:atlas:launch', label: 'Wiki · Atlas launch' },
      { handle: 'calendar:launch', label: 'Calendar · Launch review' },
    ],
    artifacts: [
      { id: 'artifact-current', name: 'atlas-report.md', contentType: 'text/markdown' },
    ],
    createdAt: '2026-08-02T08:30:00.000Z',
  };
  return { mission, report, fullText };
}

test('completed Work projection preserves one current result identity, citations, artifacts, and full Markdown', () => {
  const { mission, report, fullText } = completedWorkFixture();
  const projection = buildCompletedWorkResultProjection({
    workspaceId: 'ws-a',
    mission,
    report,
  });
  const replay = buildCompletedWorkResultProjection({
    workspaceId: 'ws-a',
    mission,
    report,
  });

  assert.match(projection.workResultId, /^work_result_[a-f0-9]{28}$/);
  assert.equal(replay.workResultId, projection.workResultId);
  assert.equal(projection.missionId, mission.id);
  assert.equal(projection.workConversationId, mission.missionThreadId);
  assert.equal(projection.reportId, report.id);
  assert.equal(projection.finalText, fullText);
  assert.match(projection.finalText, /END-OF-FULL-RESULT$/);
  assert.deepEqual(projection.citations, report.citations);
  assert.deepEqual(projection.artifacts, report.artifacts);
  assert.equal(projection.wiki.status, 'pending_local');
  assert.equal(projection.wiki.projectionId, `work-result-wiki:${projection.workResultId}`);
  assert.equal(
    projection.wiki.relativePath,
    `5_conversation/agent-runs/${projection.workResultId}.md`,
  );
  assert.match(projection.wiki.markdown, new RegExp(`work_result_id: ${projection.workResultId}`));
  assert.match(projection.wiki.markdown, /END-OF-FULL-RESULT$/);
  assert.doesNotMatch(JSON.stringify(projection), /\/Users\/|wikiRoot|absolutePath/);
  assert.deepEqual(publicMissionRecord({
    ...mission,
    wikiArchive: projection.wiki,
  }).wikiArchive, {
    status: 'pending_local',
    relativePath: projection.wiki.relativePath,
    archivedAt: '',
  });

  assert.equal(buildCompletedWorkResultProjection({
    workspaceId: 'ws-a',
    mission: { ...mission, status: 'failed' },
    report,
  }), null);
  assert.equal(buildCompletedWorkResultProjection({
    workspaceId: 'ws-a',
    mission: { ...mission, status: 'cancelled' },
    report,
  }), null);
  assert.equal(buildCompletedWorkResultProjection({
    workspaceId: 'ws-a',
    mission,
    report: { ...report, id: 'report-stale' },
  }), null);
});

test('Unified Calendar exposes completed terminal result identity but never projects failed or cancelled as success', async () => {
  await withPostgres(async ({ pool }) => {
    const { mission, report, fullText } = completedWorkFixture();
    const projection = buildCompletedWorkResultProjection({ workspaceId: 'ws-a', mission, report });
    const base = {
      source: 'agent-work',
      startsAt: '2026-08-02T08:00:00.000Z',
      endsAt: '2026-08-02T09:00:00.000Z',
      missionId: mission.id,
      sessionId: mission.missionThreadId,
      reportId: report.id,
    };
    await pool.query(`insert into calendar_events (id, title, starts_at, payload, workspace_id) values
      ('calendar-completed', 'Completed Work', $1::timestamptz, $2::jsonb, 'ws-a'),
      ('calendar-failed', 'Failed Work', $1::timestamptz, $3::jsonb, 'ws-a'),
      ('calendar-cancelled', 'Cancelled Work', $1::timestamptz, $4::jsonb, 'ws-a')`, [
      base.startsAt,
      JSON.stringify({ ...base, lifecycleStatus: 'completed', status: 'completed', workResult: projection }),
      JSON.stringify({ ...base, lifecycleStatus: 'failed', status: 'failed', workResult: projection }),
      JSON.stringify({ ...base, lifecycleStatus: 'cancelled', status: 'cancelled', workResult: projection }),
    ]);
    const scope = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const calendar = new UnifiedCalendar({
      pool,
      env: { UNIFIED_CALENDAR_EXTERNAL_ENABLED: '0', AGENT_CALENDAR_FAKE_GOOGLE: '1' },
      clock: () => NOW,
    });
    const result = await calendar.queryRange(scope, {
      from: '2026-08-02T07:00:00.000Z',
      to: '2026-08-02T10:00:00.000Z',
    });
    const completed = result.entries.find((entry) => entry.entryId === 'calendar-completed');
    assert.equal(completed.workResultId, projection.workResultId);
    assert.equal(completed.workConversationId, mission.missionThreadId);
    assert.equal(completed.reportId, report.id);
    assert.equal(completed.result.finalText, fullText);
    assert.deepEqual(completed.result.citations, report.citations);
    assert.deepEqual(completed.result.artifacts, report.artifacts);
    for (const terminal of result.entries.filter((entry) => ['failed', 'cancelled'].includes(entry.lifecycleStatus))) {
      assert.equal(terminal.workResultId, undefined);
      assert.equal(terminal.result, undefined);
    }
  });
});

test('DurableExecution completion persists one scoped pending Wiki projection across fresh service instances', async () => {
  await withPostgres(async ({ pool }) => {
    const fullText = `# Durable result\n\n${'persisted evidence '.repeat(360)}\nEND-OF-DURABLE-RESULT`;
    await pool.query(`insert into runners
      (id, workspace_id, status, connection_state, capabilities)
      values ('runner-result', 'ws-a', 'active', 'connected', '{"maxConcurrentWork":1}'::jsonb)`);
    await pool.query(`insert into agent_missions
      (id, workspace_id, status, agent_id, report_due_at, payload)
      values ('mission-result', 'ws-a', 'active', 'agent-result', '', $1::jsonb)`, [JSON.stringify({
      goal: 'Durable result',
      title: 'Durable result',
      status: 'active',
      missionThreadId: 'conversation-result',
      workConversationId: 'conversation-result',
    })]);
    await pool.query(`insert into agent_sessions
      (id, workspace_id, mission_id, task_id, status, payload)
      values ('conversation-result', 'ws-a', 'mission-result', '', 'active', '{}'::jsonb)`);
    await pool.query(`insert into execution_jobs
      (id, workspace_id, mission_id, session_id, requested_engine, resolved_engine,
       engine_reason, preferred_runner_id, status, goal, payload, projection_key,
       turn_index, turn_target_index, turn_mode)
      values ('job-result', 'ws-a', 'mission-result', 'conversation-result', 'fake', 'fake',
       'test', 'runner-result', 'running', 'Durable result', '{}'::jsonb, 'projection-result',
       1, 0, 'single')`);
    await pool.query(`insert into execution_offers
      (id, workspace_id, job_id, runner_id, status, expires_at)
      values ('offer-result', 'ws-a', 'job-result', 'runner-result', 'accepted',
       '2026-08-02T09:10:00.000Z')`);
    await pool.query(`insert into execution_attempts
      (id, workspace_id, job_id, runner_id, offer_id, attempt_number, lease_epoch,
       status, engine, lease_expires_at)
      values ('attempt-result', 'ws-a', 'job-result', 'runner-result', 'offer-result', 1, 1,
       'running', 'fake', '2026-08-02T09:10:00.000Z')`);
    await pool.query(`insert into execution_artifacts
      (id, workspace_id, job_id, attempt_id, kind, name, content_type, content, metadata, idempotency_key)
      values ('artifact-result', 'ws-a', 'job-result', 'attempt-result', 'file',
       'final-result.md', 'text/markdown', $1, $2::jsonb, 'artifact-result')`, [
      fullText,
      JSON.stringify({ citations: [{ handle: 'wiki:durable:1', label: 'Durable evidence' }] }),
    ]);
    const runner = (await pool.query("select * from runners where id = 'runner-result'")).rows[0];
    const completion = await new DurableExecution({
      pool,
      env: { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
      clock: () => NOW,
    }).completeAttempt(runner, {
      attemptId: 'attempt-result',
      leaseEpoch: 1,
      summary: 'Durable result completed',
      idempotencyKey: 'terminal:durable-result',
    });

    assert.match(completion.workResultId, /^work_result_[a-f0-9]{28}$/);
    const current = await pool.query(`select report_id from agent_work_current_results
      where workspace_id = 'ws-a' and mission_id = 'mission-result'`);
    assert.equal(current.rows[0].report_id, completion.reportId);
    const missionRow = await pool.query(`select payload from agent_missions
      where workspace_id = 'ws-a' and id = 'mission-result'`);
    assert.equal(missionRow.rows[0].payload.wikiArchive.status, 'pending_local');
    assert.equal(missionRow.rows[0].payload.workResultId, completion.workResultId);
    const eventRow = await pool.query(`select payload from calendar_events
      where workspace_id = 'ws-a' and payload->>'missionId' = 'mission-result'`);
    assert.equal(eventRow.rows[0].payload.workResult.workResultId, completion.workResultId);
    assert.equal(eventRow.rows[0].payload.workResult.finalText, fullText);

    const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const scopeB = await resolveWorkspaceScope(pool, { userId: 'user-b', workspaceId: 'ws-b' });
    const restarted = new WorkspaceScopedProductService({
      pool,
      env: { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
    });
    const conversation = await restarted.getAgentWorkConversation(scopeA, 'mission-result');
    assert.equal(conversation.work.currentResultReportId, completion.reportId);
    assert.equal(conversation.work.wikiArchive.status, 'pending_local');
    await pool.query(`update agent_missions
      set payload = payload || $1::jsonb
      where workspace_id = 'ws-a' and id = 'mission-result'`, [JSON.stringify({
      wikiArchive: {
        status: 'pending_local',
        relativePath: '/Users/alex/private-vault/result.md',
        wikiRoot: '/Users/alex/private-vault',
      },
    })]);
    const pathSafeConversation = await restarted.getAgentWorkConversation(scopeA, 'mission-result');
    assert.equal(pathSafeConversation.work.wikiArchive.relativePath, '');
    assert.doesNotMatch(JSON.stringify(pathSafeConversation), /\/Users\/|wikiRoot/);
    assert.equal(
      await restarted.getAgentWorkConversation(scopeB, 'mission-result'),
      null,
    );

    const restartedCalendar = new UnifiedCalendar({
      pool,
      env: { UNIFIED_CALENDAR_EXTERNAL_ENABLED: '0', AGENT_CALENDAR_FAKE_GOOGLE: '1' },
      clock: () => NOW,
    });
    const range = { from: '2026-08-02T08:00:00.000Z', to: '2026-08-02T10:00:00.000Z' };
    const [calendarA, calendarB] = await Promise.all([
      restartedCalendar.queryRange(scopeA, range),
      restartedCalendar.queryRange(scopeB, range),
    ]);
    assert.equal(calendarA.entries[0].workResultId, completion.workResultId);
    assert.equal(calendarB.entries.length, 0);

    const { mission, report } = completedWorkFixture();
    for (const invalid of [
      { mission: { ...mission, status: 'failed' }, report },
      { mission: { ...mission, status: 'cancelled' }, report },
      { mission, report: { ...report, status: 'stale' } },
      { mission, report: { ...report, id: 'report-not-current' } },
    ]) {
      assert.equal(buildCompletedWorkResultProjection({ workspaceId: 'ws-a', ...invalid }), null);
    }
  });
});
