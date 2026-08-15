'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DurableExecution } = require('../app/lib/durable-execution');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

function interruptIsolationPool() {
  const jobs = new Map([
    ['job-a', {
      id: 'job-a',
      workspace_id: 'workspace-interrupt',
      mission_id: 'mission-a',
      session_id: 'session-a',
      status: 'running',
      cancellation_requested: false,
      turn_index: 1,
      turn_target_index: 0,
    }],
    ['job-b', {
      id: 'job-b',
      workspace_id: 'workspace-interrupt',
      mission_id: 'mission-b',
      session_id: 'session-b',
      status: 'leased',
      cancellation_requested: false,
      turn_index: 1,
      turn_target_index: 0,
    }],
  ]);
  const attempts = new Map([
    ['attempt-a', {
      id: 'attempt-a',
      workspace_id: 'workspace-interrupt',
      runner_id: 'runner-interrupt',
      job_id: 'job-a',
      lease_epoch: 1,
      status: 'running',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
    ['attempt-b', {
      id: 'attempt-b',
      workspace_id: 'workspace-interrupt',
      runner_id: 'runner-interrupt',
      job_id: 'job-b',
      lease_epoch: 2,
      status: 'leased',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
  ]);

  const query = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (/select m\.role as role/.test(normalized)) {
      return { rowCount: 1, rows: [{ role: 'owner' }] };
    }
    if (/select \* from execution_jobs/.test(normalized) && /mission_id = \$2/.test(normalized)) {
      const rows = [...jobs.values()]
        .filter((job) => job.workspace_id === params[0] && job.mission_id === params[1]);
      return { rowCount: rows.length, rows: rows.map((job) => ({ ...job })) };
    }
    if (/update execution_jobs set cancellation_requested = true/.test(normalized)) {
      for (const jobId of params[1]) {
        jobs.get(jobId).cancellation_requested = true;
      }
      return { rowCount: params[1].length, rows: [] };
    }
    if (/select a\.\*, j\.session_id/.test(normalized)) {
      const attempt = attempts.get(params[0]);
      const job = attempt ? jobs.get(attempt.job_id) : null;
      if (!attempt || !job || attempt.workspace_id !== params[1]) {
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [{
          ...attempt,
          session_id: job.session_id,
          mission_id: job.mission_id,
          cancellation_requested: job.cancellation_requested,
          job_status: job.status,
          turn_index: job.turn_index,
          turn_target_index: job.turn_target_index,
          turn_mode: 'single',
        }],
      };
    }
    if (/select coalesce\(max\(sequence\), 0\)::int as seq/.test(normalized)) {
      return { rowCount: 1, rows: [{ seq: 0 }] };
    }
    return { rowCount: 1, rows: [] };
  };
  const client = { query, release() {} };
  return {
    jobs,
    attempts,
    pool: {
      query,
      async connect() { return client; },
    },
  };
}

test('requestCancel on one running Work leaves the other running Work leased', async () => {
  const fixture = interruptIsolationPool();
  const scope = await resolveWorkspaceScope(fixture.pool, {
    userId: 'user-interrupt',
    workspaceId: 'workspace-interrupt',
  });
  const durable = new DurableExecution({ pool: fixture.pool });
  const runner = {
    id: 'runner-interrupt',
    workspace_id: 'workspace-interrupt',
    status: 'active',
    connection_state: 'connected',
    capabilities: { maxConcurrentWork: 2 },
  };

  const cancelled = await durable.requestCancel(scope, 'mission-a');
  const otherHeartbeat = await durable.heartbeatAttempt(runner, {
    attemptId: 'attempt-b',
    leaseEpoch: 2,
  });

  assert.equal(cancelled.status, 'cancellation_requested');
  assert.deepEqual(cancelled.jobIds, ['job-a']);
  assert.equal(fixture.jobs.get('job-a').cancellation_requested, true);
  assert.equal(fixture.jobs.get('job-b').cancellation_requested, false);
  assert.equal(fixture.jobs.get('job-b').status, 'leased');
  assert.equal(fixture.attempts.get('attempt-b').status, 'leased');
  assert.equal(otherHeartbeat.cancellationRequested, false);
  assert.equal(otherHeartbeat.jobId, 'job-b');
});
