const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LocalCommandRunner,
  isSafeHermesProfileCommand,
} = require('../app/lib/command-runner');
const { profilesToHermesAgents } = require('../app/lib/hermes-cli-profiles');
const { buildMissionRunPayload } = require('../app/lib/missions');
const { HermesRunner } = require('../app/lib/runner');

const SAFE_DEFAULT_COMMAND = '/opt/hermes chat -q "$HERMES_GOAL" -Q -t safe --source tool';
const SAFE_PROFILE_COMMAND = '/opt/hermes -p bizconsultant chat -q "$HERMES_GOAL" -Q -t safe --source tool';

function hermesProfileRun() {
  return {
    id: 'run-safe-contract',
    goal: 'Return a bounded internal result.',
    agentId: 'bizconsultant',
    agentIdentity: { id: 'bizconsultant', kind: 'mac-mini-hermes-profile' },
    executionBackend: { id: 'hermes-cli' },
    runtimeBinding: { executionBackendId: 'hermes-cli', agentKey: 'bizconsultant' },
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function forceKill(pid) {
  if (!processAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort test cleanup only.
  }
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test process state');
}

test('Hermes profile commands pin the selected profile and safe toolset without approval bypasses', () => {
  const agents = profilesToHermesAgents([
    { name: 'default', model: 'openai/gpt-5.5', gateway: 'running' },
    { name: 'bizconsultant', alias: 'bizconsultant', model: 'openai/gpt-5.5', gateway: 'running' },
  ], { cliPath: '/opt/hermes' });
  const byId = Object.fromEntries(agents.map((agent) => [agent.id, agent]));

  assert.equal(byId.default.executionBackend.commandTemplate, SAFE_DEFAULT_COMMAND);
  assert.equal(byId.bizconsultant.executionBackend.commandTemplate, SAFE_PROFILE_COMMAND);
  assert.equal(isSafeHermesProfileCommand(SAFE_DEFAULT_COMMAND), true);
  assert.equal(isSafeHermesProfileCommand(SAFE_PROFILE_COMMAND), true);
  assert.equal(isSafeHermesProfileCommand('hermes --yolo -z "$HERMES_GOAL"'), false);
  assert.equal(isSafeHermesProfileCommand('hermes -t safe -z "$HERMES_GOAL"'), false);
  assert.equal(isSafeHermesProfileCommand('hermes chat -q "$HERMES_GOAL" -Q -t terminal --source tool'), false);
});

test('Hermes profile execution rejects persisted or configured unsafe runner commands before spawn', async () => {
  const runner = new LocalCommandRunner({
    allowShellCommands: true,
    command: 'node -e "process.exit(0)"',
  });

  await assert.rejects(
    runner.execute(hermesProfileRun()),
    /safe Hermes profile runner command is required/i,
  );

  const legacyRunner = new LocalCommandRunner({
    allowShellCommands: true,
    command: 'hermes --yolo -z "$HERMES_GOAL"',
  });
  await assert.rejects(
    legacyRunner.execute({ id: 'legacy-run', goal: 'Do nothing.' }),
    /approval-bypassing runner command is blocked/i,
  );
});

test('runtime mission payload fails closed against hostile safety overrides', () => {
  const payload = buildMissionRunPayload({
    templateId: 'product-build',
    goal: 'Bounded internal verification only.',
    agentId: 'bizconsultant',
    noApproval: true,
    yolo: true,
    toolsets: ['all', 'terminal'],
    timeoutMs: 360_000,
    deadlineAt: '2026-07-15T12:00:00.000Z',
    idempotencyKey: 'beta-safe-contract',
  });

  assert.equal(payload.noApproval, false);
  assert.equal(payload.yolo, false);
  assert.deepEqual(payload.toolsets, ['safe']);
  assert.equal(payload.timeoutMs, 360_000);
  assert.equal(payload.deadlineAt, '2026-07-15T12:00:00.000Z');
  assert.equal(payload.idempotencyKey, 'beta-safe-contract');
});

test('local command timeout terminates the complete shell process tree', {
  skip: process.platform === 'win32',
}, async () => {
  const runner = new LocalCommandRunner({
    allowShellCommands: true,
    command: `sh -c 'trap "" HUP TERM; sleep 30 & child=$!; echo "$$:$child"; wait "$child"'`,
    timeoutMs: 80,
    terminationGraceMs: 40,
  });
  const pids = [];

  try {
    await assert.rejects(
      runner.execute({ id: 'run-timeout-tree', goal: 'bounded timeout test' }, {
        onLog: ({ stream, line }) => {
          if (stream !== 'stdout' || !/^\d+:\d+$/.test(line)) return;
          pids.push(...line.split(':').map(Number));
        },
      }),
      /timed out/i,
    );
    await waitFor(() => pids.length === 2);
    assert.deepEqual(pids.map(processAlive), [false, false]);
  } finally {
    pids.forEach(forceKill);
  }
});

test('local command stop confirms process-tree termination before returning', {
  skip: process.platform === 'win32',
}, async () => {
  const runner = new LocalCommandRunner({
    allowShellCommands: true,
    command: `sh -c 'trap "" HUP TERM; sleep 30 & child=$!; echo "$$:$child"; wait "$child"'`,
    timeoutMs: 30_000,
    terminationGraceMs: 40,
  });
  const pids = [];
  const execution = runner.execute({ id: 'run-explicit-stop', goal: 'bounded stop test' }, {
    onLog: ({ stream, line }) => {
      if (stream !== 'stdout' || !/^\d+:\d+$/.test(line)) return;
      pids.push(...line.split(':').map(Number));
    },
  });

  try {
    await waitFor(() => pids.length === 2);
    assert.equal(typeof runner.stop, 'function');
    assert.equal(await runner.stop('run-explicit-stop'), true);
    await assert.rejects(execution, /stopped/i);
    assert.deepEqual(pids.map(processAlive), [false, false]);
  } finally {
    pids.forEach(forceKill);
    await execution.catch(() => {});
  }
});

test('Hermes runner preserves stopped state when active adapter cancellation rejects execution', async () => {
  const run = { id: 'run-stop-contract', name: 'Stop contract', status: 'queued' };
  const records = new Map([[run.id, { ...run, logs: [] }]]);
  const store = {
    getRun(id) {
      return records.get(id) || null;
    },
    updateRunStatus(id, status) {
      const current = records.get(id);
      if (!current) return null;
      const updated = { ...current, status };
      records.set(id, updated);
      return updated;
    },
    appendRunLog(id, line) {
      const current = records.get(id);
      if (!current) return null;
      const updated = { ...current, logs: [...current.logs, line] };
      records.set(id, updated);
      return updated;
    },
  };
  let rejectExecution;
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  const adapter = {
    id: 'cancellable-test-adapter',
    execute: () => new Promise((resolve, reject) => {
      rejectExecution = reject;
      executionStarted();
    }),
    stop: async () => {
      rejectExecution(new Error('Runner command stopped'));
      return true;
    },
  };
  const runner = new HermesRunner({ store, stepDelayMs: 1 });
  runner.setAdapter(adapter);
  const running = runner.runOnce(run);

  await started;
  assert.equal(typeof runner.stopRun, 'function');
  assert.equal(await runner.stopRun(run.id), true);
  await running;

  assert.equal(store.getRun(run.id).status, 'stopped');
  assert.equal(store.getRun(run.id).logs.some((line) => /runner completed/i.test(line)), false);
  assert.equal(store.getRun(run.id).logs.some((line) => /adapter error|runner failed/i.test(line)), false);
});

test('Hermes runner never starts a run stopped before its deferred enqueue', async () => {
  const run = { id: 'run-stop-before-enqueue', name: 'Deferred stop', status: 'queued' };
  const records = new Map([[run.id, { ...run, logs: [] }]]);
  const store = {
    getRun: (id) => records.get(id) || null,
    updateRunStatus(id, status) {
      const current = records.get(id);
      if (!current) return null;
      const updated = { ...current, status };
      records.set(id, updated);
      return updated;
    },
    appendRunLog(id, line) {
      const current = records.get(id);
      if (!current) return null;
      const updated = { ...current, logs: [...current.logs, line] };
      records.set(id, updated);
      return updated;
    },
  };
  let executionCount = 0;
  const runner = new HermesRunner({ store, stepDelayMs: 1 });
  runner.setAdapter({
    id: 'must-not-run',
    execute: async () => {
      executionCount += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(await runner.stopRun(run.id), true);
  runner.enqueueRun(run);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(store.getRun(run.id).status, 'stopped');
  assert.equal(executionCount, 0);
});
