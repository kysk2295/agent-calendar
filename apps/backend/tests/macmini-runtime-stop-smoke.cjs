const { execFileSync } = require('node:child_process');

const runtimeBase = String(
  process.env.HERMES_REMOTE_RUNTIME_URL
  || `http://${process.env.HERMES_RUNTIME_HOST || '127.0.0.1'}:${process.env.HERMES_RUNTIME_PORT || '64369'}`,
)
  .replace(/\/+$/, '');
const runtimeToken = String(
  process.env.HERMES_REMOTE_RUNTIME_TOKEN || process.env.HERMES_REMOTE_AUTH_TOKEN || '',
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hermesProcessRows() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }))
    .filter((row) => /\/hermes(?:\s|$)/.test(row.command) && /\s+chat\s+/.test(row.command) && /\s-q\s/.test(row.command));
}

async function runtimeJson(pathname, options = {}) {
  const response = await fetch(`${runtimeBase}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Runtime request failed with HTTP ${response.status}`);
  return body;
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

async function main() {
  if (!runtimeToken) throw new Error('HERMES_REMOTE_RUNTIME_TOKEN is required');
  const beforePids = new Set(hermesProcessRows().map((row) => row.pid));
  let runId = '';
  try {
    const created = await runtimeJson('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        goal: 'AC-BETA cancellation smoke. Do not use tools or perform side effects. Draft a long internal-only analysis so the operator can cancel this run immediately.',
        agentId: 'bizconsultant',
        source: 'agent-calendar-beta-verification',
        idempotencyKey: `beta-runtime-stop-${Date.now()}`,
      }),
    });
    const run = created.run || created.data?.run;
    runId = String(run?.id || '');
    if (!runId) throw new Error('Runtime did not return a run id');

    const activeRow = await waitFor(
      () => hermesProcessRows().find((row) => !beforePids.has(row.pid)),
      15_000,
      'Hermes child process did not start',
    );
    const targetPgid = activeRow.pgid;
    const startedGroupSize = hermesProcessRows().filter((row) => row.pgid === targetPgid).length;
    const stopStartedAt = Date.now();
    const stopped = await runtimeJson(`/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      body: '{}',
    });
    const stopLatencyMs = Date.now() - stopStartedAt;
    const stoppedRun = stopped.run || stopped.data?.run;
    if (stoppedRun?.status !== 'stopped') throw new Error('Runtime stop response was not terminal');

    await waitFor(
      () => !hermesProcessRows().some((row) => row.pgid === targetPgid),
      10_000,
      'Hermes process group survived a confirmed stop',
    );
    await delay(5_000);
    const detail = await runtimeJson(`/api/runs/${encodeURIComponent(runId)}`);
    const persistedRun = detail.run || detail.data?.run;
    if (persistedRun?.status !== 'stopped') throw new Error('Stopped run transitioned after cancellation');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      runId,
      startedGroupSize,
      stopLatencyMs,
      processGroupAlive: false,
      persistedStatus: persistedRun.status,
      lateCompletion: false,
    })}\n`);
  } catch (error) {
    if (runId) {
      await runtimeJson(`/api/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        body: '{}',
      }).catch(() => {});
    }
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
