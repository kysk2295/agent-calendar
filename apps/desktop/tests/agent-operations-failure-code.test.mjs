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
