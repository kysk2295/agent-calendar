'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { matchProductionRoute } = require('../app/lib/production-route-registry');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

const LOCAL_ROLE = 'phase7automation';
const DATABASE = 'phase7_automation';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function runBin(binDir, name, args, options = {}) {
  return execFileSync(path.join(binDir, name), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

async function waitForReady(binDir, socketDir, port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      runBin(binDir, 'pg_isready', [
        '-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE,
      ], { timeout: 2_000 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Postgres did not become ready');
}

function stopCluster(binDir, dataDir) {
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
  } catch {
    return;
  }
}

async function withPostgres(fn) {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) throw new Error('Postgres binaries missing');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-automation-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  let pool = null;
  try {
    runBin(binDir, 'initdb', [
      '-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8',
    ], { timeout: 60_000 });
    runBin(binDir, 'pg_ctl', [
      '-D', dataDir,
      '-l', path.join(workDir, 'postgres.log'),
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
      'start',
    ], { timeout: 30_000 });
    await waitForReady(binDir, socketDir, port);
    runBin(binDir, 'createdb', [
      '-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE, DATABASE,
    ], { timeout: 15_000 });
    const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${DATABASE}?host=${encodeURIComponent(socketDir)}&port=${port}`;
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
    await runMigrations({ pool });
    await pool.query(`insert into users (id, display_name, status) values
      ('user-a', 'Alex', 'active'), ('user-b', 'Blair', 'active')`);
    await pool.query(`insert into workspaces (id, name, status) values
      ('ws-a', 'A', 'active'), ('ws-b', 'B', 'active')`);
    await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
      ('m-a', 'user-a', 'ws-a', 'owner', 'active'),
      ('m-b', 'user-b', 'ws-b', 'owner', 'active')`);
    await pool.query(
      `insert into runners (
         id, workspace_id, status, connection_state, capabilities, last_seen_at
       ) values
       ('runner-a', 'ws-a', 'active', 'connected',
        '{"automationSources":["fake"]}'::jsonb, now()),
       ('runner-b', 'ws-b', 'active', 'connected',
        '{"automationSources":["fake"]}'::jsonb, now())`,
    );
    await fn({ pool });
  } finally {
    if (pool) await pool.end().catch(() => {});
    stopCluster(binDir, dataDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function sourceAutomation({
  id = 'weekly-brief',
  name = '주간 일정 브리프',
  revision = 'rev-1',
  enabled = true,
} = {}) {
  return {
    externalId: id,
    name,
    goal: '다가오는 일정을 요약한다.',
    agentId: 'calendar',
    schedule: '0 9 * * 1',
    status: enabled ? 'active' : 'paused',
    enabled,
    revision,
    nextRunAt: '2026-07-27T00:00:00.000Z',
  };
}

function createFakeAutomationAdapter({ limited = false } = {}) {
  const state = {
    items: [sourceAutomation()],
    occurrences: [{
      externalOccurrenceId: 'weekly-brief:2026-07-27T00:00:00.000Z',
      automationExternalId: 'weekly-brief',
      scheduledAt: '2026-07-27T00:00:00.000Z',
      status: 'scheduled',
      revision: 'occ-rev-1',
    }],
    calls: [],
    mode: '',
  };
  const capabilities = {
    list: true,
    create: !limited,
    update: !limited,
    pause: !limited,
    resume: !limited,
    run: !limited,
    delete: false,
    triggers: ['cron'],
    runHistory: true,
  };
  const maybeFail = () => {
    if (state.mode === 'timeout') {
      const error = new Error('source timed out');
      error.code = 'SOURCE_TIMEOUT';
      throw error;
    }
    if (state.mode === 'conflict') {
      const error = new Error('source revision conflict');
      error.code = 'SOURCE_REVISION_CONFLICT';
      error.currentRevision = 'rev-current';
      throw error;
    }
  };
  const mutate = (operation, input) => {
    maybeFail();
    const externalId = String(input.externalId || input.automation?.externalId || 'created-automation');
    const index = state.items.findIndex((item) => item.externalId === externalId);
    const current = index >= 0 ? state.items[index] : null;
    const next = sourceAutomation({
      ...(current || {}),
      id: externalId,
      name: input.name || current?.name || '새 자동화',
      revision: `rev-${state.calls.length + 1}`,
      enabled: operation === 'pause' ? false : operation === 'resume' ? true : current?.enabled ?? false,
    });
    if (operation === 'update') {
      Object.assign(next, {
        goal: input.goal ?? current?.goal ?? '',
        agentId: input.agentId ?? current?.agentId ?? '',
        schedule: input.schedule ?? current?.schedule ?? '',
      });
    }
    if (index >= 0) state.items[index] = next;
    else state.items.push(next);
    return {
      automation: next,
      sourceRevision: next.revision,
      run: operation === 'run'
        ? {
          externalOccurrenceId: `${externalId}:manual-1`,
          automationExternalId: externalId,
          scheduledAt: '2026-07-25T01:00:00.000Z',
          status: 'succeeded',
          revision: 'run-rev-1',
        }
        : null,
    };
  };
  return {
    state,
    async capabilities() {
      state.calls.push({ operation: 'capabilities' });
      return capabilities;
    },
    async list() {
      state.calls.push({ operation: 'list' });
      maybeFail();
      return {
        items: state.items.map((item) => ({ ...item })),
        occurrences: state.occurrences.map((item) => ({ ...item })),
        cursor: 'cursor-1',
        sourceRevision: 'source-rev-1',
      };
    },
    async create(_connection, input) {
      state.calls.push({ operation: 'create', input });
      return mutate('create', input);
    },
    async update(_connection, input) {
      state.calls.push({ operation: 'update', input });
      return mutate('update', input);
    },
    async pause(_connection, input) {
      state.calls.push({ operation: 'pause', input });
      return mutate('pause', input);
    },
    async resume(_connection, input) {
      state.calls.push({ operation: 'resume', input });
      return mutate('resume', input);
    },
    async run(_connection, input) {
      state.calls.push({ operation: 'run', input });
      return mutate('run', input);
    },
  };
}

test('Phase 7 automation federation routes are registered', () => {
  assert.ok(matchProductionRoute('GET', '/api/automation/sources'));
  assert.ok(matchProductionRoute('POST', '/api/automation/sources'));
  assert.ok(matchProductionRoute('POST', '/api/automation/sources/source-1/sync'));
  assert.ok(matchProductionRoute('GET', '/api/automation/automations'));
  assert.ok(matchProductionRoute('POST', '/api/automation/changes'));
  assert.ok(matchProductionRoute('POST', '/api/automation/changes/change-1/approve'));
});

test('Migration 0024 creates the Workspace-isolated automation federation records', async () => {
  await withPostgres(async ({ pool }) => {
    const tables = await pool.query(
      `select table_name
       from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name`,
      [[
        'automation_sources',
        'connected_automations',
        'automation_changes',
        'automation_change_receipts',
        'automation_occurrences',
        'automation_sync_cursors',
      ]],
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'automation_change_receipts',
      'automation_changes',
      'automation_occurrences',
      'automation_sources',
      'automation_sync_cursors',
      'connected_automations',
    ]);

    const forced = await pool.query(
      `select relname, relforcerowsecurity
       from pg_class
       where relname = any($1::text[])
       order by relname`,
      [[
        'automation_sources',
        'connected_automations',
        'automation_changes',
        'automation_change_receipts',
        'automation_occurrences',
        'automation_sync_cursors',
      ]],
    );
    assert.equal(forced.rows.length, 6);
    assert.equal(forced.rows.every((row) => row.relforcerowsecurity === true), true);
  });
});

test('Automation federation synchronizes source-owned records and applies capability-probed changes', async () => {
  await withPostgres(async ({ pool }) => {
    const fake = createFakeAutomationAdapter();
    const limited = createFakeAutomationAdapter({ limited: true });
    const runtime = createPhase1Runtime({
      pool,
      env: {
        AUTOMATION_FEDERATION_ENABLED: '1',
        AUTOMATION_WRITES_ENABLED: '1',
        CALENDAR_AI_V2_ENABLED: '1',
        CALENDAR_AI_ACTIONS_ENABLED: '1',
        DURABLE_EXECUTION_BACKGROUND_WORKERS: '0',
        UNIFIED_CALENDAR_BACKGROUND_WORKERS: '0',
        CALENDAR_AI_RUNNER_MODEL_ENABLED: '0',
        CALENDAR_AI_CLOUD_MODEL_ENABLED: '0',
      },
      automationAdapters: {
        fake,
        limited,
      },
    });
    const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const scopeB = await resolveWorkspaceScope(pool, { userId: 'user-b', workspaceId: 'ws-b' });

    const connected = await runtime.automationFederation.connectSource(scopeA, {
      adapterKind: 'fake',
      displayName: 'Mac mini Hermes',
      runnerId: 'runner-a',
      requestId: 'connect-a-1',
    });
    assert.equal(connected.source.capabilities.create, true);
    assert.equal(connected.source.connectionRef.providerCredentialsStored, false);

    const firstSync = await runtime.automationFederation.synchronize(scopeA, connected.source.id);
    const replaySync = await runtime.automationFederation.synchronize(scopeA, connected.source.id);
    assert.equal(firstSync.automations.length, 1);
    assert.equal(replaySync.automations.length, 1);
    assert.equal(firstSync.occurrences.length, 1);
    assert.equal(replaySync.occurrences.length, 1);
    assert.equal(fake.state.calls.filter((call) => call.operation === 'list').length, 2);
    assert.equal(
      fake.state.calls.some((call) => call.operation === 'run'),
      false,
      'shadow synchronization never executes a duplicate run',
    );
    assert.equal((await runtime.automationFederation.listAutomations(scopeB)).automations.length, 0);
    assert.equal((await runtime.automationFederation.listSources(scopeB)).sources.length, 0);
    const calendar = await runtime.unifiedCalendar.queryRange(scopeA, {
      from: '2026-07-26T00:00:00.000Z',
      to: '2026-07-28T00:00:00.000Z',
    });
    const automationEntries = calendar.entries.filter((entry) => entry.sourceKind === 'automation');
    assert.equal(automationEntries.length, 1);
    assert.equal(automationEntries[0].title, '주간 일정 브리프');
    assert.equal(
      calendar.coverage.some((item) => item.sourceKind === 'automation' && item.state === 'complete'),
      true,
    );

    const created = await runtime.automationFederation.requestChange(scopeA, {
      sourceId: connected.source.id,
      operation: 'create',
      requestId: 'create-a-1',
      input: {
        name: '매일 아침 브리프',
        goal: '오늘 일정 요약',
        schedule: '0 8 * * *',
        agentId: 'calendar',
      },
    });
    const createdReplay = await runtime.automationFederation.requestChange(scopeA, {
      sourceId: connected.source.id,
      operation: 'create',
      requestId: 'create-a-1',
      input: {
        name: '무시되어야 할 재시도',
        schedule: '0 7 * * *',
      },
    });
    assert.equal(created.change.status, 'succeeded');
    assert.equal(created.receipt.id, createdReplay.receipt.id);
    assert.equal(fake.state.calls.filter((call) => call.operation === 'create').length, 1);
    assert.equal(created.automation.enabled, false, 'new source automation starts disabled');

    const approval = await runtime.automationFederation.requestChange(scopeA, {
      sourceId: connected.source.id,
      operation: 'update',
      automationId: created.automation.id,
      requestId: 'sensitive-update-a-1',
      expectedRevision: created.automation.sourceRevision,
      input: {
        goal: '새 외부 채널로 일정을 전송',
        externalDelivery: true,
      },
    });
    assert.equal(approval.change.status, 'pending_approval');
    assert.equal(approval.approvalGate.required, true);
    assert.equal(
      fake.state.calls.filter((call) => call.operation === 'update').length,
      0,
    );
    const approved = await runtime.automationFederation.approveChange(
      scopeA,
      approval.change.id,
      { requestId: 'approve-sensitive-a-1' },
    );
    assert.equal(approved.receipt.status, 'succeeded');
    assert.equal(fake.state.calls.filter((call) => call.operation === 'update').length, 1);

    const calendarAiDraft = await runtime.calendarAi.chat(scopeA, {
      message: '주간 일정 브리프 자동화를 일시정지해줘',
      requestId: 'calendar-ai-pause-a-1',
    });
    assert.equal(calendarAiDraft.actionDraft.actionKind, 'automation_change');
    assert.equal(calendarAiDraft.actionDraft.input.operation, 'pause');
    const calendarAiApproved = await runtime.calendarAi.approveAction(
      scopeA,
      calendarAiDraft.actionDraft.id,
      { requestId: 'calendar-ai-pause-approve-a-1' },
    );
    assert.equal(calendarAiApproved.receipt.status, 'succeeded');
    assert.equal(calendarAiApproved.receipt.result.automationReceipt.status, 'succeeded');

    const limitedSource = await runtime.automationFederation.connectSource(scopeA, {
      adapterKind: 'limited',
      displayName: 'Read-only source',
      runnerId: 'runner-a',
      requestId: 'connect-limited-a-1',
    });
    await assert.rejects(
      () => runtime.automationFederation.requestChange(scopeA, {
        sourceId: limitedSource.source.id,
        operation: 'run',
        requestId: 'unsupported-run-a-1',
        input: { externalId: 'weekly-brief' },
      }),
      (error) => error.code === 'AUTOMATION_CAPABILITY_UNSUPPORTED' && error.statusHint === 409,
    );

    fake.state.mode = 'timeout';
    const timedOut = await runtime.automationFederation.requestChange(scopeA, {
      sourceId: connected.source.id,
      operation: 'update',
      automationId: created.automation.id,
      requestId: 'timeout-a-1',
      expectedRevision: approved.automation.sourceRevision,
      input: { goal: '시간 초과 후 상태 미확정' },
    });
    assert.equal(timedOut.change.status, 'unknown');
    assert.equal(timedOut.receipt.status, 'unknown');

    fake.state.mode = 'conflict';
    const conflict = await runtime.automationFederation.requestChange(scopeA, {
      sourceId: connected.source.id,
      operation: 'update',
      automationId: created.automation.id,
      requestId: 'conflict-a-1',
      expectedRevision: 'stale-revision',
      input: { goal: '덮어쓰면 안 됨' },
    });
    assert.equal(conflict.change.status, 'conflict');
    assert.equal(conflict.receipt.sourceRevision, 'rev-current');

    const counts = await pool.query(
      `select
         (select count(*)::int from automation_sources where workspace_id = 'ws-a') as sources_a,
         (select count(*)::int from automation_sources where workspace_id = 'ws-b') as sources_b,
         (select count(*)::int from connected_automations where workspace_id = 'ws-a') as automations_a,
         (select count(*)::int from connected_automations where workspace_id = 'ws-b') as automations_b,
         (select count(*)::int from automation_occurrences where workspace_id = 'ws-a') as occurrences_a`,
    );
    assert.deepEqual(counts.rows[0], {
      sources_a: 2,
      sources_b: 0,
      automations_a: 2,
      automations_b: 0,
      occurrences_a: 1,
    });
    runtime.durableExecution.stopBackgroundWorkers();
    runtime.unifiedCalendar.stopBackgroundWorkers();
  });
});

test('Hermes source Adapter maps cron authority without executing during list', async () => {
  const { HermesAutomationSourceAdapter } = require('../app/lib/hermes-automation-source-adapter');
  const calls = [];
  const adapter = new HermesAutomationSourceAdapter({
    request: async ({ method, path: requestPath, body, idempotencyKey }) => {
      calls.push({ method, path: requestPath, body, idempotencyKey });
      if (method === 'GET') {
        return {
          ok: true,
          sourceRevision: 'hermes-source-rev-1',
          jobs: [{
            id: 'cron-1',
            name: 'Hermes 오전 브리프',
            profile: 'calendar',
            schedule: '0 8 * * *',
            enabled: true,
            revision: 'cron-rev-1',
            nextRunAt: '2026-07-26T23:00:00.000Z',
          }],
        };
      }
      return {
        ok: true,
        job: {
          id: 'cron-1',
          name: body?.name || 'Hermes 오전 브리프',
          profile: body?.agentId || 'calendar',
          schedule: body?.schedule || '0 8 * * *',
          enabled: body?.enabled ?? true,
          revision: 'cron-rev-2',
        },
        run: requestPath.endsWith('/trigger')
          ? {
            id: 'manual-run-1',
            jobId: 'cron-1',
            scheduledAt: '2026-07-25T01:00:00.000Z',
            status: 'succeeded',
          }
          : null,
      };
    },
  });
  const source = {
    id: 'source-hermes',
    adapterKind: 'hermes',
    connectionRef: { runnerId: 'runner-a', providerCredentialsStored: false },
  };

  const capabilities = await adapter.capabilities(source);
  assert.equal(capabilities.delete, false);
  assert.equal(capabilities.run, true);
  const listed = await adapter.list(source, '');
  assert.equal(listed.items[0].externalId, 'cron-1');
  assert.equal(listed.occurrences[0].externalOccurrenceId, 'cron-1:2026-07-26T23:00:00.000Z');
  assert.deepEqual(calls.map((call) => call.method), ['GET']);

  await adapter.update(source, {
    externalId: 'cron-1',
    name: '수정된 브리프',
    schedule: '0 9 * * *',
    expectedRevision: 'cron-rev-1',
    idempotencyKey: 'change-1',
  });
  await adapter.pause(source, {
    externalId: 'cron-1',
    expectedRevision: 'cron-rev-2',
    idempotencyKey: 'pause-1',
  });
  await adapter.resume(source, {
    externalId: 'cron-1',
    expectedRevision: 'cron-rev-3',
    idempotencyKey: 'resume-1',
  });
  const run = await adapter.run(source, {
    externalId: 'cron-1',
    idempotencyKey: 'run-1',
  });
  assert.equal(run.run.externalOccurrenceId, 'manual-run-1');
  assert.deepEqual(
    calls.slice(1).map((call) => [call.method, call.path]),
    [
      ['PUT', '/api/cron/jobs/cron-1'],
      ['POST', '/api/cron/jobs/cron-1/pause'],
      ['POST', '/api/cron/jobs/cron-1/resume'],
      ['POST', '/api/cron/jobs/cron-1/trigger'],
    ],
  );
  assert.equal(calls.some((call) => /credential|token|secret/i.test(JSON.stringify(call))), false);
});
