'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { handleScopedProductRoute } = require('../app/lib/production-product-routes');
const { matchProductionRoute } = require('../app/lib/production-route-registry');
const { SecondBrain } = require('../app/lib/second-brain');
const { SourceLibrary } = require('../app/lib/source-library');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { withEphemeralPostgres } = require('./support/ephemeral-postgres.cjs');

function response() {
  return {
    status: 0, body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function invoke({ scope, service, runtime, action, method = 'GET', params = {}, body = {} }) {
  const res = response();
  const handled = await handleScopedProductRoute({
    req: {}, res, method, pathname: '', params, query: {}, body,
    route: { action }, scope, runtime: runtime || { product: {}, secondBrain: service },
  });
  assert.equal(handled, true);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function eventually(read, predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`condition not reached: ${JSON.stringify(value)}`);
}

test('Second Brain public lifecycle is user-isolated, restart-safe, evidence-grounded, and observable', async () => {
  await withEphemeralPostgres({
    prefix: 'second-brain-foundation-', role: 'second_brain_foundation', database: 'second_brain_foundation',
  }, async ({ pool }) => {
    await runMigrations({ pool });
    await pool.query(`insert into users (id, display_name, status) values
      ('second-user-a','A','active'), ('second-user-b','B','active')`);
    await pool.query(`insert into workspaces (id, name, status)
      values ('second-workspace','Second Brain','active')`);
    await pool.query(`insert into workspace_memberships (id,user_id,workspace_id,role,status) values
      ('second-member-a','second-user-a','second-workspace','owner','active'),
      ('second-member-b','second-user-b','second-workspace','member','active')`);
    const scopeA = await resolveWorkspaceScope(pool, { workspaceId: 'second-workspace', userId: 'second-user-a' });
    const scopeB = await resolveWorkspaceScope(pool, { workspaceId: 'second-workspace', userId: 'second-user-b' });

    const route = matchProductionRoute('POST', '/api/second-brain/runs')?.route;
    assert.deepEqual([route?.class, route?.action, route?.role], [
      'scoped_product', 'second_brain_run_create', 'member',
    ]);

    let inferenceCalls = 0;
    const inferenceInputs = [];
    const evidence = {
      id: 'file:evidence-1',
      origin: 'file',
      label: '실제 회고',
      evidenceHandle: 'knowledge:handle-1',
      citation: '회고.md · 3행',
      content: '금요일마다 프로젝트 위험을 검토한다.',
    };
    let userAHasEvidence = true;
    const sourceLibrary = {
      async listBootstrapSources(scope) {
        return scope.userId === 'second-user-a' && userAHasEvidence ? [evidence] : [];
      },
    };
    const inferenceBroker = {
      async complete(input) {
        inferenceCalls += 1;
        inferenceInputs.push(input);
        return {
          text: JSON.stringify({ claims: [{
            id: 'claim-review',
            text: '금요일마다 프로젝트 위험을 검토합니다.',
            sourceId: evidence.id,
            evidenceHandle: evidence.evidenceHandle,
            citation: evidence.citation,
          }] }),
        };
      },
    };

    // The first public response is a persisted collecting checkpoint, not a synchronous final result.
    const heldCallbacks = [];
    const held = new SecondBrain({
      pool, sourceLibrary, inferenceBroker,
      schedule(callback) { heldCallbacks.push(callback); return null; },
    });
    const started = await invoke({
      scope: scopeA, service: held, action: route.action, method: 'POST',
      body: { idempotencyKey: 'restart-safe-key', sourceIds: ['work_result:ignored', evidence.id] },
    });
    assert.equal(started.run.stage, 'collecting');
    assert.equal(started.run.status, 'running');
    assert.equal(inferenceCalls, 0);

    // Guessed IDs and current state never cross the user boundary.
    assert.equal(await held.getRun(scopeB, started.run.id), null);
    assert.deepEqual(await held.getCurrent(scopeB), {
      ok: true, run: null, snapshot: null, draftRun: null,
    });

    // A fresh instance resolves the canonical DB idempotency row instead of returning a phantom run.
    const restarted = new SecondBrain({ pool, sourceLibrary, inferenceBroker });
    const replay = await restarted.createRun(scopeA, { idempotencyKey: 'restart-safe-key' });
    assert.equal(replay.run.id, started.run.id);
    assert.equal(replay.run.stage, 'collecting');

    const reviewReady = await eventually(
      () => restarted.getRun(scopeA, started.run.id),
      (value) => value?.run?.status === 'ready_for_review',
    );
    assert.deepEqual(reviewReady.run.stageHistory.map((entry) => entry.stage), [
      'collecting', 'indexing', 'extracting', 'linking', 'ready_for_review',
    ]);
    assert.equal(reviewReady.snapshot.claims.length, 1);
    assert.equal(reviewReady.snapshot.claims[0].citation, evidence.citation);
    assert.match(inferenceInputs[0].messages[0].content, /금요일마다 프로젝트 위험을 검토한다/);
    assert.deepEqual(inferenceInputs[0].context.evidence, [{
      sourceId: evidence.id,
      origin: 'file',
      evidenceHandle: evidence.evidenceHandle,
      citation: evidence.citation,
    }]);

    const afterRestart = new SecondBrain({ pool, sourceLibrary, inferenceBroker });
    assert.equal((await afterRestart.getCurrent(scopeA)).snapshot.id, reviewReady.snapshot.id);
    const reviewed = await invoke({
      scope: scopeA, service: afterRestart, action: 'second_brain_snapshot_review', method: 'POST',
      params: { id: reviewReady.snapshot.id },
      body: {
        decisions: [{
          claimId: 'claim-review', action: 'correct',
          text: '매주 금요일 프로젝트 위험을 검토합니다.', basis: '원문과 실제 습관을 대조함',
        }],
        activate: true,
      },
    });
    assert.equal(reviewed.snapshot.version, 2);
    assert.equal(reviewed.snapshot.status, 'active');
    assert.equal(reviewed.audit[0].basis, '원문과 실제 습관을 대조함');
    assert.equal((await new SecondBrain({ pool, sourceLibrary, inferenceBroker }).getCurrent(scopeA)).run.status, 'active');
    assert.equal(await afterRestart.reviewSnapshot(scopeB, reviewReady.snapshot.id, {}), null);

    // A newer incomplete draft cannot erase the last activated personal snapshot.
    userAHasEvidence = false;
    const newerDraft = await new SecondBrain({ pool, sourceLibrary, inferenceBroker }).createRun(scopeA, {
      idempotencyKey: 'newer-empty-draft',
    });
    await eventually(
      () => new SecondBrain({ pool, sourceLibrary, inferenceBroker }).getRun(scopeA, newerDraft.run.id),
      (value) => value?.run?.status === 'source_required',
    );
    const currentWithDraft = await new SecondBrain({ pool, sourceLibrary, inferenceBroker }).getCurrent(scopeA);
    assert.equal(currentWithDraft.run.status, 'active');
    assert.equal(currentWithDraft.snapshot.id, reviewed.snapshot.id);
    assert.equal(currentWithDraft.draftRun.status, 'source_required');
    userAHasEvidence = true;

    // An empty user remains source_required and derived IDs/skip flags never invoke inference.
    const beforeEmpty = inferenceCalls;
    const empty = await new SecondBrain({ pool, sourceLibrary, inferenceBroker }).createRun(scopeB, {
      idempotencyKey: 'empty-bootstrap',
      sourceIds: ['work_result:report-1'],
      skipped: ['calendar', 'mail', 'file'],
    });
    const sourceRequired = await eventually(
      () => new SecondBrain({ pool, sourceLibrary, inferenceBroker }).getRun(scopeB, empty.run.id),
      (value) => value?.run?.status === 'source_required',
    );
    assert.equal(sourceRequired.run.stage, 'source_required');
    assert.equal(sourceRequired.run.processed, 0);
    assert.equal(sourceRequired.run.total, 0);
    assert.equal(inferenceCalls, beforeEmpty);

    // Actual adapters expose item-level content and citation handles, never connection labels alone.
    await pool.query(`insert into calendar_sources
      (id,workspace_id,provider,source_kind,label,external_calendar_id,status,writable,timezone)
      values ('second-cal','second-workspace','google','external_calendar','업무 일정','primary','connected',false,'Asia/Seoul')`);
    await pool.query(`insert into calendar_occurrences
      (id,workspace_id,source_id,provider_event_id,occurrence_key,title,starts_at,ends_at,timezone,status)
      values ('second-occ','second-workspace','second-cal','provider-event','once','고객 검토 회의',
        '2026-08-21T01:00:00Z','2026-08-21T02:00:00Z','Asia/Seoul','confirmed')`);
    await pool.query(`insert into knowledge_collections (id,workspace_id,name,status)
      values ('second-collection','second-workspace','회고','active')`);
    await pool.query(`insert into knowledge_sources
      (id,workspace_id,collection_id,source_kind,label,path,status,cloud_opt_in,encryption_required)
      values ('second-file','second-workspace','second-collection','cloud_indexed','회고','review.md','ready',true,true)`);
    await pool.query(`insert into knowledge_evidence_handles
      (id,workspace_id,source_id,handle_token,citation_label,excerpt,status)
      values ('second-handle','second-workspace','second-file','opaque-review','회고.md · 3행','실제 파일 문장','active')`);
    const adapterLibrary = new SourceLibrary({
      pool,
      unifiedCalendar: {
        async listMailMessages() {
          return { connector: 'connected', items: [{
            id: 'mail-1', from: 'sender@example.com', subject: '분기 목표',
            snippet: '다음 분기 목표 초안을 검토해 주세요.', receivedAt: '2026-08-20T00:00:00Z',
          }] };
        },
      },
      knowledge: {
        async resolveEvidence(_scope, handle) {
          assert.equal(handle, 'opaque-review');
          return { handle, title: '회고.md · 3행', excerpt: '실제 파일 문장' };
        },
      },
    });
    const actualEvidence = await adapterLibrary.listBootstrapSources(scopeA);
    assert.deepEqual(new Set(actualEvidence.map((item) => item.origin)), new Set(['calendar', 'mail', 'file']));
    assert.match(actualEvidence.find((item) => item.origin === 'calendar').content, /고객 검토 회의/);
    assert.match(actualEvidence.find((item) => item.origin === 'mail').content, /다음 분기 목표 초안/);
    assert.match(actualEvidence.find((item) => item.origin === 'file').content, /실제 파일 문장/);
    assert.equal(actualEvidence.every((item) => item.evidenceHandle && item.citation), true);

    const productionRuntime = {
      pool,
      product: {},
      unifiedCalendar: adapterLibrary.unifiedCalendar,
      knowledge: adapterLibrary.knowledge,
      inferenceBroker: {
        async complete(input) {
          const source = input.context.evidence[0];
          return { text: JSON.stringify({ claims: [{
            id: 'production-wired-claim', text: '실제 원본에 근거한 항목',
            sourceId: source.sourceId,
            evidenceHandle: source.evidenceHandle,
            citation: source.citation,
          }] }) };
        },
      },
    };
    const wiredStart = await invoke({
      scope: scopeA, runtime: productionRuntime, action: 'second_brain_run_create', method: 'POST',
      body: { idempotencyKey: 'production-runtime-wiring' },
    });
    assert.equal(wiredStart.run.stage, 'collecting');
    const wiredReady = await eventually(
      () => invoke({
        scope: scopeA, runtime: productionRuntime, action: 'second_brain_run_get',
        params: { id: wiredStart.run.id },
      }),
      (value) => value?.run?.status === 'ready_for_review',
    );
    assert.equal(wiredReady.snapshot.claims[0].id, 'production-wired-claim');
  });
});

test('0037 migration persists user-scoped runs, versioned snapshots, and review audit', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../app/db/migrations/0037_personal_second_brain.sql'), 'utf8');
  assert.match(sql, /create table if not exists second_brain_runs/i);
  assert.match(sql, /create table if not exists second_brain_snapshots/i);
  assert.match(sql, /create table if not exists second_brain_reviews/i);
  assert.match(sql, /unique \(workspace_id, user_id, idempotency_key\)/i);
  assert.match(sql, /current_setting\(''?app\.user_id/i);
});
