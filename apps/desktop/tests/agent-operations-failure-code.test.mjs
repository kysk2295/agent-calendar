import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const operationsModule = await vite.ssrLoadModule('/src/features/agent-operations/agentOperations.ts');

after(async () => {
  await vite.close();
});

function task(failureCode) {
  return {
    id: `task-${failureCode || 'none'}`,
    missionId: 'mission-1',
    origin: 'agent',
    status: 'blocked',
    title: '수정 결과 생성',
    failureCode,
  };
}

test('Given public failure codes When parsing agent tasks Then known codes survive and unknown codes fail closed', () => {
  const parsed = operationsModule.parseAgentOperationsEnvelope({
    tasks: [task('budget_exhausted'), task('relay_cancel_unconfirmed'), task('future_code'), task(undefined)],
  });

  assert.deepEqual(parsed.tasks.map((item) => item.failureCode), [
    'budget_exhausted',
    'relay_cancel_unconfirmed',
    undefined,
    undefined,
  ]);
});

test('Given workspace runner snapshot When parsing agent operations Then runner connected/ready fields survive', () => {
  const parsed = operationsModule.parseAgentOperationsEnvelope({
    missions: [],
    tasks: [],
    sessions: [],
    reports: [],
    daemon: { running: true, mode: 'workspace_runner', lastRun: null, lastError: null },
    runner: {
      connected: true,
      status: 'connected',
      message: 'Workspace Runner connected',
    },
  });

  assert.equal(parsed.daemon.running, true);
  assert.equal(parsed.daemon.mode, 'workspace_runner');
  assert.ok(parsed.runner);
  assert.equal(parsed.runner.connected, true);
  assert.equal(parsed.runner.status, 'connected');
  assert.match(String(parsed.runner.message || ''), /connected/i);
});

test('Given runner_required snapshot When parsing agent operations Then disconnected state is explicit', () => {
  const parsed = operationsModule.parseAgentOperationsEnvelope({
    daemon: { running: false, mode: 'runner_required' },
    runner: {
      connected: false,
      status: 'runner_required',
      message: 'Workspace Runner is not connected',
    },
  });

  assert.equal(parsed.daemon.running, false);
  assert.equal(parsed.daemon.mode, 'runner_required');
  assert.equal(parsed.runner?.connected, false);
  assert.equal(parsed.runner?.status, 'runner_required');
});
