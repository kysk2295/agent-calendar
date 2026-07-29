#!/usr/bin/env node
'use strict';

/**
 * Manual QA for Phase 1 first vertical slice against a fresh ephemeral PostgreSQL cluster.
 * Writes redaction-safe evidence only. Never accepts external DATABASE_URL.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { runMigrations } = require('../app/db/migrate');
const { defaultRunBin: runBin } = require('../app/lib/local-postgres-lifecycle');
const {
  LEGACY_OWNER_USER_ID,
  LEGACY_PERSONAL_WORKSPACE_ID,
  SCOPE_KIND,
  resolveWorkspaceScope,
  assertActiveMembership,
} = require('../app/lib/workspace-scope');
const { WorkspaceScopedCalendarRepository } = require('../app/lib/workspace-scoped-calendar-repository');
const { resolvePostgresBinDir } = require('../app/lib/phase0-snapshot-restore');

const LOCAL_ROLE = 'phase1qa';
const DATABASE = 'phase1_qa';
const EVIDENCE_PATH = path.resolve(__dirname, '../../../docs/operations/evidence/2026-07-24-phase1-workspace-isolation.json');

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

async function waitForReady(binDir, socketDir, port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
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
    // continue to status check
  }
  try {
    const status = String(runBin(binDir, 'pg_ctl', ['-D', dataDir, 'status'], { timeout: 10_000 }) || '');
    if (/server is running/i.test(status)) {
      return { stopped: false, statusOutput: status };
    }
    return { stopped: true, statusOutput: status };
  } catch (error) {
    const statusOutput = `${error && error.stdout != null ? error.stdout : ''}${error && error.stderr != null ? error.stderr : ''}`;
    const stopped = /no server running|PID file .* does not exist|pid file does not exist/i.test(statusOutput)
      || !/server is running/i.test(statusOutput);
    return { stopped, statusOutput };
  }
}

async function count(pool, table) {
  const result = await pool.query(`select count(*)::int as n from ${table}`);
  return Number(result.rows[0].n) || 0;
}

async function main() {
  if (process.env.DATABASE_URL) {
    throw new Error('external DATABASE_URL is forbidden for Phase 1 isolation QA');
  }
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      prerequisite: 'postgresql_binaries_missing',
      clusterStopped: true,
    }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-qa-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  const logFile = path.join(workDir, 'postgres.log');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  let started = false;
  let pool = null;
  const startedAt = Date.now();
  const report = {
    schemaVersion: 1,
    kind: 'phase1-workspace-isolation-qa',
    ok: false,
    clusterStopped: false,
    workDir: '$WORK_DIR',
    migrationsApplied: [],
    preMigrationCounts: {},
    postMigrationCounts: {},
    checks: {},
    error: '',
    generatedAt: '2026-07-24T12:00:00.000Z',
    durationMs: 0,
  };

  try {
    runBin(binDir, 'initdb', [
      '-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8',
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

    const migrationsDir = path.join(__dirname, '../app/db/migrations');
    const baseline = fs.readdirSync(migrationsDir).filter((f) => /^000[1-7]_.*\.sql$/i.test(f)).sort();
    for (const file of baseline) {
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

    report.preMigrationCounts = {
      tasks: await count(pool, 'tasks'),
      calendar_events: await count(pool, 'calendar_events'),
      agents: await count(pool, 'agents'),
    };

    const migrated = await runMigrations({ pool });
    report.migrationsApplied = migrated.migrations || [];

    report.postMigrationCounts = {
      tasks: await count(pool, 'tasks'),
      calendar_events: await count(pool, 'calendar_events'),
      agents: await count(pool, 'agents'),
    };

    const countsPreserved = JSON.stringify(report.preMigrationCounts) === JSON.stringify(report.postMigrationCounts);
    const legacyTask = await pool.query(`select workspace_id from tasks where id = 'legacy-task-1'`);
    const legacyOwned = legacyTask.rows[0]?.workspace_id === LEGACY_PERSONAL_WORKSPACE_ID;

    await pool.query(
      `insert into users (id, display_name, status) values
       ('user-a', 'Alex', 'active'),
       ('user-b', 'Blair', 'active'),
       ('user-member', 'Member Only', 'active'),
       ('user-inactive', 'Inactive User', 'inactive')
       on conflict (id) do nothing`,
    );
    await pool.query(
      `insert into workspaces (id, name, status) values
       ('ws-a', 'Workspace A', 'active'),
       ('ws-b', 'Workspace B', 'active'),
       ('ws-inactive', 'Inactive Workspace', 'inactive')
       on conflict (id) do nothing`,
    );
    await pool.query(
      `insert into workspace_memberships (id, user_id, workspace_id, role, status) values
       ('mem-a', 'user-a', 'ws-a', 'owner', 'active'),
       ('mem-b', 'user-b', 'ws-b', 'owner', 'active'),
       ('mem-member', 'user-member', 'ws-a', 'member', 'active'),
       ('mem-inactive-user', 'user-inactive', 'ws-a', 'member', 'active'),
       ('mem-inactive-ws', 'user-a', 'ws-inactive', 'owner', 'active')
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
    const memberScope = await resolveWorkspaceScope(pool, { userId: 'user-member', workspaceId: 'ws-a' });

    const tasksA = await repo.listTasks(scopeA);
    const taskA = await repo.getTaskById(scopeA, 'task-collide-a');
    const crossTask = await repo.getTaskById(scopeA, 'task-collide-b');
    const eventsA = await repo.listCalendarEvents(scopeA);
    const eventA = await repo.getCalendarEventById(scopeA, 'event-collide-a');
    const crossEvent = await repo.getCalendarEventById(scopeA, 'event-collide-b');
    const tasksB = await repo.listTasks(scopeB);

    let nonMemberRejected = false;
    try {
      await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-b' });
    } catch {
      nonMemberRejected = true;
    }

    const handBuilt = Object.freeze({
      kind: SCOPE_KIND,
      userId: 'user-a',
      workspaceId: 'ws-a',
      role: 'owner',
    });
    let handBuiltRejected = false;
    try {
      await repo.listTasks(handBuilt);
    } catch {
      handBuiltRejected = true;
    }

    const forgedOwner = Object.freeze({
      kind: SCOPE_KIND,
      userId: 'user-member',
      workspaceId: 'ws-a',
      role: 'owner',
    });
    let roleElevationRejected = false;
    try {
      await assertActiveMembership(pool, forgedOwner);
    } catch {
      roleElevationRejected = true;
    }
    let memberRolePreserved = false;
    try {
      const revalidated = await assertActiveMembership(pool, memberScope);
      memberRolePreserved = revalidated.role === 'member';
    } catch {
      memberRolePreserved = false;
    }

    let plainObjectRejected = false;
    try {
      await repo.getTaskById({ userId: 'user-a', workspaceId: 'ws-a' }, 'task-collide-a');
    } catch {
      plainObjectRejected = true;
    }

    let inactiveUserRejected = false;
    try {
      await resolveWorkspaceScope(pool, { userId: 'user-inactive', workspaceId: 'ws-a' });
    } catch {
      inactiveUserRejected = true;
    }
    let inactiveWorkspaceRejected = false;
    try {
      await resolveWorkspaceScope(pool, { userId: 'user-a', workspaceId: 'ws-inactive' });
    } catch {
      inactiveWorkspaceRejected = true;
    }

    let crossWorkspaceTaskLinkRejected = false;
    try {
      await pool.query(
        `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
         values ('event-cross-ws', 'task-collide-b', 'Cross link', '2026-07-26 11:00', '{}'::jsonb, 'ws-a')`,
      );
    } catch {
      crossWorkspaceTaskLinkRejected = true;
    }
    await pool.query(
      `insert into calendar_events (id, task_id, title, starts_at, payload, workspace_id)
       values ('event-same-ws', 'task-collide-a', 'Same link', '2026-07-26 12:00', '{}'::jsonb, 'ws-a')`,
    );

    // ON DELETE SET NULL (task_id) only — workspace_id must remain after task deletion.
    await pool.query(`delete from tasks where id = 'task-collide-a'`);
    const afterTaskDelete = await pool.query(
      `select workspace_id, task_id from calendar_events where id = 'event-same-ws'`,
    );
    const taskDeleteNullsTaskIdOnly = afterTaskDelete.rowCount === 1
      && afterTaskDelete.rows[0].workspace_id === 'ws-a'
      && afterTaskDelete.rows[0].task_id == null;

    report.checks = {
      countsPreserved,
      legacyOwned,
      legacyMembership: LEGACY_OWNER_USER_ID,
      sameScopeList: tasksA.some((row) => row.id === 'task-collide-a') && !tasksA.some((row) => row.id === 'task-collide-b'),
      sameScopeDirect: Boolean(taskA) && taskA.id === 'task-collide-a',
      crossScopeDirectNull: crossTask === null && crossEvent === null,
      sameScopeEvents: Boolean(eventA) && eventsA.some((row) => row.id === 'event-collide-a') && !eventsA.some((row) => row.id === 'event-collide-b'),
      otherScopeList: tasksB.some((row) => row.id === 'task-collide-b') && !tasksB.some((row) => row.id === 'task-collide-a'),
      nonMemberRejected,
      handBuiltScopeRejected: handBuiltRejected,
      roleElevationRejected,
      memberRolePreserved,
      plainObjectScopeRejected: plainObjectRejected,
      inactiveUserRejected,
      inactiveWorkspaceRejected,
      crossWorkspaceTaskLinkRejected,
      taskDeleteNullsTaskIdOnly,
    };

    report.ok = Object.values(report.checks).every((value) => value === true || typeof value === 'string');
    if (!report.ok) {
      report.error = 'one_or_more_isolation_checks_failed';
    }
  } catch (error) {
    report.ok = false;
    report.error = error && error.message ? String(error.message).replace(/\/[^\s]+/g, '$PATH') : 'unknown_error';
  } finally {
    if (pool) {
      try { await pool.end(); } catch { /* ignore */ }
    }
    if (started) {
      const stop = stopCluster(binDir, dataDir);
      report.clusterStopped = Boolean(stop.stopped);
      if (!stop.stopped) {
        report.ok = false;
        report.error = report.error ? `${report.error},cluster_not_stopped` : 'cluster_not_stopped';
      }
    } else {
      report.clusterStopped = true;
    }
    report.durationMs = Date.now() - startedAt;
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (report.ok && report.clusterStopped) {
    fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.evidencePath = 'docs/operations/evidence/2026-07-24-phase1-workspace-isolation.json';
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok && report.clusterStopped ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
