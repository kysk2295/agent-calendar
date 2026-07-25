import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const automation = await vite.ssrLoadModule('/src/features/agent-operations/hermesAutomation.ts');

after(async () => {
  await vite.close();
});

test('Connected Automation presentation preserves source capabilities, freshness, and receipt truth', () => {
  const sources = automation.parseConnectedAutomationSources([{
    id: 'source-1',
    runnerId: 'runner-1',
    adapterKind: 'hermes',
    displayName: 'Mac mini Hermes',
    status: 'connected',
    capabilities: {
      list: true,
      create: true,
      update: true,
      pause: true,
      resume: true,
      run: true,
      delete: false,
    },
    lastSyncedAt: '2026-07-25T00:00:00.000Z',
    staleAfter: '2026-07-25T00:05:00.000Z',
  }]);
  assert.deepEqual(sources[0], {
    id: 'source-1',
    runnerId: 'runner-1',
    adapterKind: 'hermes',
    displayName: 'Mac mini Hermes',
    status: 'connected',
    capabilities: {
      list: true,
      create: true,
      update: true,
      pause: true,
      resume: true,
      run: true,
      delete: false,
    },
    lastSyncedAt: '2026-07-25T00:00:00.000Z',
    staleAfter: '2026-07-25T00:05:00.000Z',
  });

  const jobs = automation.parseConnectedAutomations([{
    id: 'automation-1',
    sourceId: 'source-1',
    externalId: 'cron-1',
    name: '주간 일정 브리프',
    goal: '다음 주 일정을 요약한다.',
    agentId: 'calendar',
    schedule: '0 9 * * 1',
    status: 'active',
    enabled: true,
    sourceRevision: 'rev-1',
    lastSyncedAt: '2026-07-25T00:00:00.000Z',
    staleAfter: '2026-07-25T00:05:00.000Z',
    source: {
      id: 'source-1',
      displayName: 'Mac mini Hermes',
      adapterKind: 'hermes',
      status: 'connected',
    },
    capabilities: {
      update: true,
      pause: true,
      resume: true,
      run: true,
      delete: false,
    },
    lastReceipt: {
      id: 'receipt-1',
      status: 'unknown',
      operation: 'run',
      errorCode: 'SOURCE_TIMEOUT',
      errorMessage: 'source timed out',
      createdAt: '2026-07-25T00:01:00.000Z',
    },
  }]);
  assert.equal(jobs[0].sourceId, 'source-1');
  assert.equal(jobs[0].externalId, 'cron-1');
  assert.equal(jobs[0].source, 'Mac mini Hermes');
  assert.equal(jobs[0].capabilities.run, true);
  assert.equal(jobs[0].lastReceipt.status, 'unknown');
  assert.equal(jobs[0].lastReceipt.errorCode, 'SOURCE_TIMEOUT');
  assert.equal(jobs[0].sourceRevision, 'rev-1');
});
