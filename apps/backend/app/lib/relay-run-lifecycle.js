function profileCompletionError(code, message, jobId = '', runId = '') {
  const error = new Error(message);
  error.code = code;
  error.jobId = jobId;
  error.runId = runId;
  return error;
}

function runFromRuntimeBody(body = {}) {
  return body.run || body.data?.run || (body.id ? body : null);
}

function snapshotRuns(snapshot) {
  return Array.isArray(snapshot?.state?.runs)
    ? snapshot.state.runs
    : (Array.isArray(snapshot?.runs) ? snapshot.runs : []);
}

function runFromSnapshot(snapshot, runId) {
  return snapshotRuns(snapshot).find((run) => run.id === runId) || null;
}

function runFromSnapshotByIdempotencyKey(snapshot, idempotencyKey) {
  if (!idempotencyKey) return null;
  return snapshotRuns(snapshot).find((run) => (
    String(run.idempotencyKey || run.meta?.idempotencyKey || run.mission?.idempotencyKey || '')
      === idempotencyKey
  )) || null;
}

function isTerminalRunStatus(status) {
  return ['done', 'completed', 'failed', 'cancelled', 'stopped'].includes(
    String(status || '').toLowerCase(),
  );
}

async function waitForRelayRun({ relay, job, deadline, now }) {
  let cursor = 0;
  let lastError = '';
  while (now() < deadline) {
    const batch = await relay.waitForEvents(
      job.id,
      cursor,
      Math.min(5_000, Math.max(1, deadline - now())),
    );
    cursor = batch.cursor || cursor;
    for (const record of batch.events || []) {
      if (record.event === 'error') lastError = String(record.data?.error || 'Hermes profile launch failed');
      if (record.event === 'bridge-complete') {
        const run = runFromRuntimeBody(record.data?.body || {});
        if (run) return run;
      }
    }
    if (batch.complete) break;
  }
  throw profileCompletionError(
    lastError ? 'relay_failed' : 'relay_timeout',
    lastError || 'Mac mini Hermes profile launch timed out',
    job.id,
  );
}

async function requestRelayRunStop({ relay, env, runId, now, sleep, pollIntervalMs }) {
  if (!runId) return false;
  const job = relay.enqueue({
    kind: 'runtime.request',
    payload: {
      method: 'POST',
      path: `/api/runs/${encodeURIComponent(runId)}/stop`,
      query: {},
      body: '{}',
    },
    meta: { source: 'agent-operations-timeout-cancel', runId },
  });
  const deadline = now() + 30_000;
  let cursor = 0;
  let stopAccepted = false;
  while (now() < deadline) {
    if (!stopAccepted) {
      const batch = await relay.waitForEvents(
        job.id,
        cursor,
        Math.min(5_000, Math.max(1, deadline - now())),
      );
      cursor = batch.cursor || cursor;
      for (const record of batch.events || []) {
        if (record.event === 'error') return false;
        if (record.event !== 'bridge-complete') continue;
        if (record.data?.ok === false || record.data?.body?.ok === false) return false;
        stopAccepted = true;
        const run = runFromRuntimeBody(record.data?.body || {});
        if (isTerminalRunStatus(run?.status)) return true;
      }
      if (batch.complete && !stopAccepted) return false;
    }
    const latest = runFromSnapshot(relay.snapshot({ env, allowStale: true }), runId);
    if (isTerminalRunStatus(latest?.status)) return true;
    if (stopAccepted) {
      await sleep(Math.min(Math.max(1, pollIntervalMs), Math.max(1, deadline - now())));
    }
  }
  return false;
}

module.exports = {
  isTerminalRunStatus,
  profileCompletionError,
  requestRelayRunStop,
  runFromSnapshot,
  runFromSnapshotByIdempotencyKey,
  waitForRelayRun,
};
