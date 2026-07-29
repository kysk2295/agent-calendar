#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { runMigrations } = require('../app/db/migrate');
const { defaultRunBin: runBin } = require('../app/lib/local-postgres-lifecycle');
const { resolvePostgresBinDir, EXPECTED_PERSISTED_TABLES } = require('../app/lib/phase0-snapshot-restore');
const { issueSessionForVerifiedSubject, refreshSession } = require('../app/lib/workspace-auth-session');
const { WorkspaceScopedProductService } = require('../app/lib/workspace-scoped-product-service');
const { LEGACY_PERSONAL_WORKSPACE_ID } = require('../app/lib/workspace-scope');
const { recordEmbeddingCacheKey, clearRecordEmbeddingCacheForTests } = require('../app/lib/schedule-assistant');
const { createPhase1Runtime } = require('../app/lib/phase1-auth-routes');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');

const LOCAL_ROLE = 'phase1secqa';
const DATABASE = 'phase1_sec_qa';
const EVIDENCE_PATH = path.resolve(__dirname, '../../../docs/operations/evidence/2026-07-24-phase1-backend-security-boundary.json');

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
  for (let i = 0; i < 50; i += 1) {
    try {
      runBin(binDir, 'pg_isready', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE], { timeout: 2000 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('postgres not ready');
}

function stopCluster(binDir, dataDir) {
  try {
    runBin(binDir, 'pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30_000 });
  } catch { /* ignore */ }
  try {
    const status = String(runBin(binDir, 'pg_ctl', ['-D', dataDir, 'status'], { timeout: 10_000 }) || '');
    return !/server is running/i.test(status);
  } catch (error) {
    const text = `${error.stdout || ''}${error.stderr || ''}`;
    return !/server is running/i.test(text);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  if (process.env.DATABASE_URL) {
    throw new Error('external DATABASE_URL forbidden for Phase 1 security QA');
  }
  const binDir = resolvePostgresBinDir(process.env);
  if (!binDir) {
    process.stdout.write(`${JSON.stringify({ ok: false, prerequisite: 'postgresql_binaries_missing', clusterStopped: true }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-sec-qa-'));
  const dataDir = path.join(workDir, 'pgdata');
  const socketDir = path.join(workDir, 'socket');
  fs.mkdirSync(socketDir, { recursive: true });
  const port = await freePort();
  let started = false;
  let pool = null;
  const report = {
    schemaVersion: 2,
    kind: 'phase1-backend-security-boundary-qa',
    ok: false,
    clusterStopped: false,
    workDir: '$WORK_DIR',
    preMigrationCounts: {},
    postMigrationCounts: {},
    checks: {},
    error: '',
    generatedAt: '2026-07-24T12:00:00.000Z',
    durationMs: 0,
    note: 'Expanded evidence after security hardening (trusted verifier, atomic refresh, SSE stream, vector wiki, composite FKs).',
  };
  const startedAt = Date.now();

  try {
    runBin(binDir, 'initdb', ['-D', dataDir, '-A', 'trust', '-U', LOCAL_ROLE, '--locale=C', '--encoding=UTF8'], { timeout: 60_000 });
    started = true;
    runBin(binDir, 'pg_ctl', [
      '-D', dataDir, '-l', path.join(workDir, 'postgres.log'),
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=localhost -c unix_socket_directories=${socketDir}`,
      'start',
    ], { timeout: 30_000 });
    await waitForReady(binDir, socketDir, port);
    runBin(binDir, 'createdb', ['-h', socketDir, '-p', String(port), '-U', LOCAL_ROLE, DATABASE], { timeout: 15_000 });
    const connectionString = `postgresql://${encodeURIComponent(LOCAL_ROLE)}@/${encodeURIComponent(DATABASE)}?host=${encodeURIComponent(socketDir)}&port=${port}`;
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, ssl: false });

    const migrationsDir = path.join(__dirname, '../app/db/migrations');
    for (const file of fs.readdirSync(migrationsDir).filter((f) => /^000[1-7]_/.test(f)).sort()) {
      await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
    await pool.query(`insert into agents (id, payload) values ('legacy-agent-1', '{}'::jsonb)`);
    await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload)
      values ('legacy-task-1', 't', 'open', '', '', '', '', '{}'::jsonb)`);
    await pool.query(`insert into calendar_events (id, task_id, title, starts_at, payload)
      values ('legacy-event-1', 'legacy-task-1', 'e', '2026-07-24 09:00', '{}'::jsonb)`);
    await pool.query(`insert into runs (id, goal, agent, model, status, wiki_path, payload)
      values ('legacy-run-1', 'g', 'a', 'm', 'done', '', '{}'::jsonb)`);
    await pool.query(`insert into run_logs (run_id, line, payload) values ('legacy-run-1', 'l', '{}'::jsonb)`);
    await pool.query(`insert into chat_messages (id, role, text, run_id, payload)
      values ('legacy-chat-1', 'user', 'hi', 'legacy-run-1', '{}'::jsonb)`);
    await pool.query(`insert into wiki_artifacts (id, run_id, path, status, payload)
      values ('legacy-wa-1', 'legacy-run-1', 'p', 'ok', '{}'::jsonb)`);
    await pool.query(`insert into scheduler_jobs (id, name, agent, model, enabled, interval_minutes, payload)
      values ('legacy-job-1', 'j', 'a', 'm', true, 60, '{}'::jsonb)`);
    await pool.query(`insert into state_meta (key, payload) values ('legacy-meta', '{}'::jsonb)`);
    await pool.query(`insert into workboard_pages (id, title, payload) values ('legacy-wb-1', 'w', '{}'::jsonb)`);
    await pool.query(`insert into documents (id, title, path, source, payload)
      values ('legacy-doc-1', 'd', 'wiki/d.md', 'wiki', '{}'::jsonb)`);
    await pool.query(`insert into wiki_chunks (id, source, source_id, document_id, path, title, chunk_index, content, excerpt)
      values ('legacy-chunk-1', 'wiki', 'legacy-doc-1', 'legacy-doc-1', 'wiki/d.md', 'd', 0, 'c', 'e')`);
    await pool.query(`insert into agent_missions (id, status, agent_id, report_due_at, payload)
      values ('legacy-mission-1', 'active', 'legacy-agent-1', '', '{}'::jsonb)`);
    await pool.query(`insert into agent_sessions (id, mission_id, task_id, status, payload)
      values ('legacy-session-1', 'legacy-mission-1', 'legacy-task-1', 'active', '{}'::jsonb)`);
    await pool.query(`insert into agent_session_events (id, session_id, sequence, kind, payload)
      values ('legacy-sevt-1', 'legacy-session-1', 1, 'checkpoint', '{}'::jsonb)`);
    await pool.query(`insert into agent_reports (id, mission_id, session_id, status, payload)
      values ('legacy-report-1', 'legacy-mission-1', 'legacy-session-1', 'ready', '{}'::jsonb)`);

    const count = async (t) => Number((await pool.query(`select count(*)::int as n from ${t}`)).rows[0].n);
    for (const table of EXPECTED_PERSISTED_TABLES) {
      report.preMigrationCounts[table] = await count(table);
    }
    await runMigrations({ pool });
    for (const table of EXPECTED_PERSISTED_TABLES) {
      report.postMigrationCounts[table] = await count(table);
    }

    await pool.query(`insert into users (id, display_name, status) values ('user-a','A','active'),('user-b','B','active') on conflict do nothing`);
    await pool.query(`insert into workspaces (id, name, status) values ('ws-a','A','active'),('ws-b','B','active') on conflict do nothing`);
    await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
      ('mem-a','user-a','ws-a','owner','active'),('mem-b','user-b','ws-b','owner','active') on conflict do nothing`);
    await pool.query(`insert into auth_identities (id, user_id, provider, provider_subject) values
      ('id-a','user-a','test','subject-a'),('id-b','user-b','test','subject-b') on conflict do nothing`);
    await pool.query(`insert into tasks (id, title, status, owner, due_at, mission_id, session_id, payload, workspace_id) values
      ('task-a','T','open','','','','','{}'::jsonb,'ws-a'),('task-b','T','open','','','','','{}'::jsonb,'ws-b')`);

    // No verifier → public session rejected
    const runtimeNoVerifier = createPhase1Runtime({ pool });
    const serverNo = createRailwayGatewayServer({
      env: { WORKSPACE_AUTH_MODE: 'production' },
      phase1Runtime: runtimeNoVerifier,
      gatewayStore: null,
      fetchImpl: async () => ({ ok: false }),
    });
    const baseNo = await listen(serverNo);
    const untrusted = await fetch(`${baseNo}/api/phase1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a' }),
    });
    const untrustedJson = await untrusted.json();
    await close(serverNo);

    const sessA = await issueSessionForVerifiedSubject(pool, { provider: 'test', providerSubject: 'subject-a', workspaceId: 'ws-a' });
    const product = new WorkspaceScopedProductService({ pool, useAppRole: true });
    const tasksA = await product.listTasks(sessA.scope);
    const cross = await product.getTaskById(sessA.scope, 'task-b');

    // RLS clean separate transactions
    let rlsSelectHides = false;
    let rlsUpdateZero = false;
    let rlsDeleteZero = false;
    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        rlsSelectHides = (await client.query(`select id from tasks where id='task-b'`)).rowCount === 0;
        await client.query('rollback');
      } finally { client.release(); }
    }
    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        rlsUpdateZero = (await client.query(`update tasks set title='X' where id='task-b'`)).rowCount === 0;
        await client.query('commit');
      } finally { client.release(); }
    }
    {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role agent_calendar_app');
        await client.query(`select set_config('app.workspace_id','ws-a',true)`);
        await client.query(`select set_config('app.user_id','user-a',true)`);
        rlsDeleteZero = (await client.query(`delete from tasks where id='task-b'`)).rowCount === 0;
        await client.query('commit');
      } finally { client.release(); }
    }
    const victimStill = (await pool.query(`select 1 from tasks where id='task-b'`)).rowCount === 1;

    clearRecordEmbeddingCacheForTests();
    const keyA = recordEmbeddingCacheKey({ id: 'i', updatedAt: 't' }, 'src', { model: 'm', workspaceId: 'ws-a' });
    const keyB = recordEmbeddingCacheKey({ id: 'i', updatedAt: 't' }, 'src', { model: 'm', workspaceId: 'ws-b' });

    let refreshReplayRejected = false;
    const results = await Promise.allSettled([
      refreshSession(pool, { refreshToken: sessA.refreshToken }),
      refreshSession(pool, { refreshToken: sessA.refreshToken }),
    ]);
    refreshReplayRejected = results.some((r) => r.status === 'rejected');

    const accessHashUnique = (await pool.query(
      `select 1 from pg_constraint where conname='auth_sessions_access_token_hash_key'`,
    )).rowCount === 1;
    const wikiFkDef = await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname='wiki_artifacts_workspace_run_fkey'`,
    );
    const wikiFkColumnListSetNull = /set null \(run_id\)/i.test(String(wikiFkDef.rows[0]?.def || ''));
    const refreshIdentityFk = (await pool.query(
      `select 1 from pg_constraint where conname='auth_refresh_tokens_session_identity_fkey'`,
    )).rowCount === 1;

    // Delete own run: artifact keeps workspace_id.
    await pool.query(`insert into runs (id, goal, agent, model, status, wiki_path, payload, workspace_id)
      values ('run-del', 'g', 'a', 'm', 'done', '', '{}'::jsonb, 'ws-a')`);
    await pool.query(`insert into wiki_artifacts (id, run_id, path, status, payload, workspace_id)
      values ('wa-del', 'run-del', 'p', 'ok', '{}'::jsonb, 'ws-a')`);
    await pool.query(`delete from runs where id='run-del'`);
    const waAfter = await pool.query(`select workspace_id, run_id from wiki_artifacts where id='wa-del'`);
    const artifactDeleteKeepsWorkspace = waAfter.rowCount === 1
      && waAfter.rows[0].workspace_id === 'ws-a'
      && waAfter.rows[0].run_id == null;

    let all16LegacyWorkspace = true;
    for (const table of EXPECTED_PERSISTED_TABLES) {
      const n = Number((await pool.query(
        `select count(*)::int as n from ${table} where workspace_id='legacy-personal-workspace'`,
      )).rows[0].n);
      if (n < 1) all16LegacyWorkspace = false;
    }

    let rlsForceAll = true;
    for (const table of [
      'tasks', 'auth_sessions', 'auth_refresh_tokens', 'audit_events', 'idempotency_keys',
    ]) {
      const flags = await pool.query(
        `select relrowsecurity, relforcerowsecurity from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relname=$1`,
        [table],
      );
      if (!flags.rows[0]?.relrowsecurity || !flags.rows[0]?.relforcerowsecurity) rlsForceAll = false;
    }

    report.checks = {
      countsPreserved: JSON.stringify(report.preMigrationCounts) === JSON.stringify(report.postMigrationCounts),
      all16TablesCounted: Object.keys(report.preMigrationCounts).length === 16,
      all16LegacyWorkspace,
      legacyOwned: (await pool.query(`select workspace_id from tasks where id='legacy-task-1'`)).rows[0]?.workspace_id === LEGACY_PERSONAL_WORKSPACE_ID,
      untrustedBodySessionRejected: untrusted.status !== 200 && /verifier|identity/i.test(String(untrustedJson.error || '')),
      scopedList: tasksA.some((t) => t.id === 'task-a') && !tasksA.some((t) => t.id === 'task-b'),
      crossDirectNull: cross === null,
      rlsSelectHides,
      rlsUpdateZero,
      rlsDeleteZero,
      victimStill,
      rlsForceAll,
      scheduleCacheKeysIsolated: keyA !== keyB,
      concurrentRefreshRejectsOne: refreshReplayRejected,
      accessHashUnique,
      wikiFkColumnListSetNull,
      artifactDeleteKeepsWorkspace,
      refreshIdentityFk,
      errorBodyDoesNotEchoSql: !/relation |syntax error/i.test(JSON.stringify(untrustedJson)),
    };
    report.ok = Object.values(report.checks).every(Boolean);
    if (!report.ok) report.error = 'checks_failed';
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.message ? error.message : error).replace(/\/[^\s]+/g, '$PATH');
  } finally {
    if (pool) {
      try { await pool.end(); } catch { /* ignore */ }
    }
    if (started) {
      report.clusterStopped = stopCluster(binDir, dataDir);
      if (!report.clusterStopped) {
        report.ok = false;
        report.error = report.error ? `${report.error},cluster_not_stopped` : 'cluster_not_stopped';
      }
    } else {
      report.clusterStopped = true;
    }
    report.durationMs = Date.now() - startedAt;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (report.ok && report.clusterStopped) {
    fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.evidencePath = 'docs/operations/evidence/2026-07-24-phase1-backend-security-boundary.json';
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok && report.clusterStopped ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
