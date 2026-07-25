'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const workspaceScope = require('../app/lib/workspace-scope');
const {
  LEGACY_OWNER_USER_ID,
  LEGACY_PERSONAL_WORKSPACE_ID,
  SCOPE_KIND,
  resolveWorkspaceScope,
  assertActiveMembership,
} = workspaceScope;
const {
  WorkspaceScopedCalendarRepository,
} = require('../app/lib/workspace-scoped-calendar-repository');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase1';
const DATABASE = 'phase1_workspace';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
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

async function waitForReady(binDir, socketDir, port, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('ephemeral PostgreSQL did not become ready');
}

function stopCluster(binDir, dataDir) {
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
  } catch {
    // best-effort
  }
  try {
    const status = runBin(binDir, 'pg_ctl', ['-D', dataDir, 'status'], { timeout: 10_000 });
    if (/server is running/i.test(String(status || ''))) {
      throw new Error('postgres still running after stop');
    }
  } catch (error) {
    const text = `${error && error.stdout != null ? error.stdout : ''}${error && error.stderr != null ? error.stderr : ''}${error && error.message ? error.message : ''}`;
    if (/server is running/i.test(text)) {
      throw new Error('postgres still running after stop');
    }
  }
}

async function withEphemeralPostgres(fn) {
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    const err = new Error('PostgreSQL 17+ binaries not found (set PHASE0_PG_BIN)');
    err.code = 'PG_BIN_MISSING';
    throw err;
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-workspace-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  let started = false;
  let pool = null;
  try {
    runBin(binDir, 'initdb', [
      '-D', dataDir,
      '-A', 'trust',
      '-U', LOCAL_ROLE,
      '--locale=C',
      '--encoding=UTF8',
    ], { timeout: 60_000 });
    started = true;
    runBin(binDir, 'pg_ctl', [
      '-D', dataDir,
      '-l', logFile,
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
      'start',
    ], { timeout: 30_000 });
    await waitForReady(binDir, socketDir, port);
    runBin(binDir, 'createdb', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE, DATABASE], { timeout: 15_000 });
    const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${encodeURIComponent(DATABASE)}?host=${encodeURIComponent(socketDir)}&port=${port}`;
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, ssl: false, connectionTimeoutMillis: 10_000 });
    return await fn({ pool, binDir, workDir, dataDir, socketDir, port, connectionString });
  } finally {
    if (pool) {
      try { await pool.end(); } catch { /* ignore */ }
    }
    if (started) {
      stopCluster(binDir, dataDir);
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function countRows(pool, table) {
  const result = await pool.query(`select count(*)::int as n from ${table}`);
  return Number(result.rows[0].n) || 0;
}

async function tableExists(pool, table) {
  const result = await pool.query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return result.rowCount > 0;
}

async function seedBaselineAndPhase1(pool) {
  const migrationsDir = path.join(__dirname, '../app/db/migrations');
  const baselineFiles = fs.readdirSync(migrationsDir)
    .filter((file) => /^000[1-7]_.*\.sql$/i.test(file))
    .sort();
  for (const file of baselineFiles) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(
    `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload)
     values ('legacy-task-1', 'Shared title', 'open', 'OwnerLabel', '', '', '', '{}'::jsonb)`,
  );
  await pool.query(
    `insert into calendar_events (id, task_id, title, starts_at, payload)
     values ('legacy-event-1', 'legacy-task-1', 'Shared title', '2026-07-24 09:00', '{}'::jsonb)`,
  );
  await pool.query(`insert into agents (id, payload) values ('legacy-agent-1', '{}'::jsonb)`);
  const preCounts = {
    tasks: await countRows(pool, 'tasks'),
    calendar_events: await countRows(pool, 'calendar_events'),
    agents: await countRows(pool, 'agents'),
  };
  await runMigrations({ pool });
  return preCounts;
}

test('WorkspaceScope is only server-issued; createWorkspaceScope is not a public constructor', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(workspaceScope, 'createWorkspaceScope'),
    false,
    'createWorkspaceScope must not be publicly exported',
  );
  assert.equal(typeof workspaceScope.createWorkspaceScope, 'undefined');
  assert.equal(typeof resolveWorkspaceScope, 'function');
});

test('WorkspaceScope is immutable and rejects empty identity fields via resolveWorkspaceScope', async () => {
  const mockPool = {
    async query(sql, params) {
      if (/from\s+workspace_memberships/i.test(sql) || /join\s+workspace_memberships/i.test(sql) || /workspace_memberships/i.test(sql)) {
        if (!params[0] || !params[1]) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [{ role: 'owner' }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const scope = await resolveWorkspaceScope(mockPool, { userId: 'user-a', workspaceId: 'ws-a' });
  assert.equal(scope.userId, 'user-a');
  assert.equal(scope.workspaceId, 'ws-a');
  assert.equal(scope.role, 'owner');
  assert.equal(scope.kind, SCOPE_KIND);
  assert.throws(() => {
    scope.workspaceId = 'ws-other';
  }, TypeError);
  await assert.rejects(() => resolveWorkspaceScope(mockPool, { userId: '', workspaceId: 'ws-a' }));
  await assert.rejects(() => resolveWorkspaceScope(mockPool, { userId: 'user-a', workspaceId: '' }));
});

test('hostile two-Workspace isolation on real PostgreSQL for tasks and calendar_events', async () => {
  await withEphemeralPostgres(async ({ pool }) => {
    const preCounts = await seedBaselineAndPhase1(pool);

    assert.equal(await tableExists(pool, 'users'), true, 'users table must exist after 0008');
    assert.equal(await tableExists(pool, 'workspaces'), true, 'workspaces table must exist after 0008');
    assert.equal(await tableExists(pool, 'workspace_memberships'), true, 'workspace_memberships must exist after 0008');

    const postCounts = {
      tasks: await countRows(pool, 'tasks'),
      calendar_events: await countRows(pool, 'calendar_events'),
      agents: await countRows(pool, 'agents'),
    };
    assert.deepEqual(postCounts, preCounts, 'row counts must be preserved across Phase 1 ownership migrations');

    const legacyTask = await pool.query(`select workspace_id from tasks where id = 'legacy-task-1'`);
    assert.equal(legacyTask.rows[0].workspace_id, LEGACY_PERSONAL_WORKSPACE_ID);
    const legacyEvent = await pool.query(`select workspace_id from calendar_events where id = 'legacy-event-1'`);
    assert.equal(legacyEvent.rows[0].workspace_id, LEGACY_PERSONAL_WORKSPACE_ID);

    const membership = await pool.query(
      `select role from workspace_memberships where user_id = $1 and workspace_id = $2`,
      [LEGACY_OWNER_USER_ID, LEGACY_PERSONAL_WORKSPACE_ID],
    );
    assert.equal(membership.rowCount, 1);
    assert.equal(membership.rows[0].role, 'owner');

    await pool.query(
      `insert into users (id, display_name, status) values
       ('user-a', 'Alex', 'active'),
       ('user-b', 'Blair', 'active'),
       ('user-member', 'Member Only', 'active')
       on conflict (id) do nothing`,
    );
    await pool.query(
      `insert into workspaces (id, name, status) values
       ('ws-a', 'Workspace A', 'active'),
       ('ws-b', 'Workspace B', 'active')
       on conflict (id) do nothing`,
    );
    await pool.query(
      `insert into workspace_memberships (id, user_id, workspace_id, role, status) values
       ('mem-a', 'user-a', 'ws-a', 'owner', 'active'),
       ('mem-b', 'user-b', 'ws-b', 'owner', 'active'),
       ('mem-member', 'user-member', 'ws-a', 'member', 'active')
       on conflict (id) do nothing`,
    );

    await pool.query(
      `insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id) values
       ('task-collide-a', 'Colliding title', 'open', 'SameOwnerLabel', '', '', '', '{"note":"a"}'::jsonb, 'ws-a'),
       ('task-collide-b', 'Colliding title', 'open', 'SameOwnerLabel', '', '', '', '{"note":"b"}'::jsonb, 'ws-b')`,
    );
    await pool.query(
      `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id) values
       ('event-collide-a', 'task-collide-a', 'Colliding title', '2026-07-25 10:00', '{"note":"a"}'::jsonb, 'ws-a'),
       ('event-collide-b', 'task-collide-b', 'Colliding title', '2026-07-25 10:00', '{"note":"b"}'::jsonb, 'ws-b')`,
    );

    const repo = new WorkspaceScopedCalendarRepository({ pool });

    const scopeA = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const scopeB = await resolveWorkspaceScope(pool, { userId: 'user-b', workspaceId: 'ws-b' });
    assert.equal(scopeA.workspaceId, 'ws-a');
    assert.equal(scopeB.workspaceId, 'ws-b');
    assert.equal(scopeA.role, 'owner');

    const tasksA = await repo.listTasks(scopeA);
    assert.equal(tasksA.some((row) => row.id === 'task-collide-a'), true);
    assert.equal(tasksA.some((row) => row.id === 'task-collide-b'), false);
    assert.equal(tasksA.some((row) => row.id === 'legacy-task-1'), false);

    const taskA = await repo.getTaskById(scopeA, 'task-collide-a');
    assert.ok(taskA);
    assert.equal(taskA.id, 'task-collide-a');

    const eventsA = await repo.listCalendarEvents(scopeA);
    assert.equal(eventsA.some((row) => row.id === 'event-collide-a'), true);
    assert.equal(eventsA.some((row) => row.id === 'event-collide-b'), false);

    const eventA = await repo.getCalendarEventById(scopeA, 'event-collide-a');
    assert.ok(eventA);
    assert.equal(eventA.id, 'event-collide-a');

    assert.equal(await repo.getTaskById(scopeA, 'task-collide-b'), null);
    assert.equal(await repo.getCalendarEventById(scopeA, 'event-collide-b'), null);
    const tasksB = await repo.listTasks(scopeB);
    assert.equal(tasksB.some((row) => row.id === 'task-collide-a'), false);
    assert.equal(tasksB.some((row) => row.id === 'task-collide-b'), true);

    await assert.rejects(
      () => resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-b' }),
      /membership|forbidden|scope|inactive/i,
    );
    await assert.rejects(
      () => repo.getTaskById({ userId: 'user-a', workspaceId: 'ws-a' }, 'task-collide-a'),
      /WorkspaceScope|invalid|scope|server-issued/i,
    );

    // --- Security: forged same-workspace owner role elevation ---
    const realMemberScope = await resolveWorkspaceScope(pool, {
      userId: 'user-member',
      workspaceId: 'ws-a',
    });
    assert.equal(realMemberScope.role, 'member');
    const forgedOwner = Object.freeze({
      kind: SCOPE_KIND,
      userId: 'user-member',
      workspaceId: 'ws-a',
      role: 'owner',
    });
    await assert.rejects(
      () => assertActiveMembership(pool, forgedOwner),
      /server-issued|invalid WorkspaceScope|forbidden/i,
    );
    await assert.rejects(
      () => repo.listTasks(forgedOwner),
      /server-issued|invalid WorkspaceScope|forbidden/i,
    );
    // Revalidation keeps role from membership, not a caller-selected owner claim.
    const revalidated = await assertActiveMembership(pool, realMemberScope);
    assert.equal(revalidated.role, 'member');
    assert.notEqual(revalidated.role, 'owner');

    // --- Security: hand-built frozen scope is never accepted ---
    const handBuilt = Object.freeze({
      kind: SCOPE_KIND,
      userId: 'user-a',
      workspaceId: 'ws-a',
      role: 'owner',
    });
    await assert.rejects(
      () => assertActiveMembership(pool, handBuilt),
      /server-issued|invalid WorkspaceScope/i,
    );
    await assert.rejects(
      () => repo.listTasks(handBuilt),
      /server-issued|invalid WorkspaceScope/i,
    );

    // --- Security: inactive user / inactive workspace rejected ---
    await pool.query(
      `insert into users (id, display_name, status) values
       ('user-inactive', 'Inactive User', 'inactive'),
       ('user-active-ws-off', 'Active User Dead WS', 'active')
       on conflict (id) do nothing`,
    );
    await pool.query(
      `insert into workspaces (id, name, status) values
       ('ws-inactive', 'Inactive Workspace', 'inactive')
       on conflict (id) do nothing`,
    );
    await pool.query(
      `insert into workspace_memberships (id, user_id, workspace_id, role, status) values
       ('mem-inactive-user', 'user-inactive', 'ws-a', 'member', 'active'),
       ('mem-inactive-ws', 'user-active-ws-off', 'ws-inactive', 'owner', 'active')
       on conflict (id) do nothing`,
    );
    await assert.rejects(
      () => resolveWorkspaceScope(pool, { userId: 'user-inactive', workspaceId: 'ws-a' }),
      /inactive|forbidden|membership/i,
    );
    await assert.rejects(
      () => resolveWorkspaceScope(pool, { userId: 'user-active-ws-off', workspaceId: 'ws-inactive' }),
      /inactive|forbidden|membership/i,
    );

    // Issued scope becomes unusable if user later goes inactive.
    await pool.query(`update users set status = 'inactive' where id = 'user-member'`);
    await assert.rejects(
      () => assertActiveMembership(pool, realMemberScope),
      /inactive|forbidden|membership/i,
    );
    await pool.query(`update users set status = 'active' where id = 'user-member'`);

    // --- Security: cross-workspace event→task linkage rejected by composite FK ---
    await assert.rejects(
      () => pool.query(
        `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
         values ('event-cross-ws', 'task-collide-b', 'Cross link', '2026-07-26 11:00', '{}'::jsonb, 'ws-a')`,
      ),
      /foreign key|violates|workspace/i,
    );
    // Same-workspace linkage still allowed; null task_id still allowed.
    await pool.query(
      `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
       values ('event-same-ws', 'task-collide-a', 'Same link', '2026-07-26 12:00', '{}'::jsonb, 'ws-a')`,
    );
    await pool.query(
      `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
       values ('event-null-task', null, 'No task', '2026-07-26 13:00', '{}'::jsonb, 'ws-a')`,
    );

    // Deleting a task must null only task_id (column-list SET NULL), keep workspace_id NOT NULL.
    await pool.query(`delete from tasks where id = 'task-collide-a'`);
    const afterDelete = await pool.query(
      `select workspace_id, task_id from calendar_events where id = 'event-same-ws'`,
    );
    assert.equal(afterDelete.rowCount, 1);
    assert.equal(afterDelete.rows[0].workspace_id, 'ws-a');
    assert.equal(afterDelete.rows[0].task_id, null);
    const afterDeleteCollide = await pool.query(
      `select workspace_id, task_id from calendar_events where id = 'event-collide-a'`,
    );
    assert.equal(afterDeleteCollide.rows[0].workspace_id, 'ws-a');
    assert.equal(afterDeleteCollide.rows[0].task_id, null);
    // Event remains listable in its workspace after parent task deletion.
    const scopeAAfterDelete = await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-a' });
    const eventsAfterDelete = await repo.listCalendarEvents(scopeAAfterDelete);
    assert.equal(eventsAfterDelete.some((row) => row.id === 'event-same-ws'), true);

    const stillCounts = {
      tasks: await countRows(pool, 'tasks'),
      calendar_events: await countRows(pool, 'calendar_events'),
      agents: await countRows(pool, 'agents'),
    };
    assert.equal(stillCounts.tasks, 2); // legacy + b (a deleted)
    assert.equal(stillCounts.agents, 1);
    assert.equal(stillCounts.calendar_events >= 5, true); // legacy + 2 collide + same + null
  });
});
