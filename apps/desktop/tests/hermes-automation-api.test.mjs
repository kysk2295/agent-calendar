import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const apiModule = await vite.ssrLoadModule('/src/api/hermesApi.ts');

after(async () => {
  await vite.close();
});

async function listenJson(calls) {
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    calls.push({ method: request.method, url: request.url, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('scheduler client sends edit, status, and delete mutations to one encoded job resource', async () => {
  // Given
  const calls = [];
  const server = await listenJson(calls);
  apiModule.setApiBaseUrl(server.baseUrl);

  try {
    // When
    await apiModule.hermesApi.updateSchedulerJob('hermes-cron:weekly brief', {
      name: '주간 브리프',
      goal: '이번 주 일정을 요약한다.',
      agentId: 'default',
      schedule: '0 9 * * 1',
    });
    await apiModule.hermesApi.updateSchedulerJob('hermes-cron:weekly brief', { enabled: false });
    await apiModule.hermesApi.deleteSchedulerJob('hermes-cron:weekly brief');

    // Then
    assert.deepEqual(calls, [
      {
        method: 'PATCH',
        url: '/api/scheduler/jobs/hermes-cron%3Aweekly%20brief',
        body: { name: '주간 브리프', goal: '이번 주 일정을 요약한다.', agentId: 'default', schedule: '0 9 * * 1' },
      },
      {
        method: 'PATCH',
        url: '/api/scheduler/jobs/hermes-cron%3Aweekly%20brief',
        body: { enabled: false },
      },
      {
        method: 'DELETE',
        url: '/api/scheduler/jobs/hermes-cron%3Aweekly%20brief',
        body: null,
      },
    ]);
  } finally {
    await server.close();
  }
});

test('federation client sends source, sync, change, and approval requests to typed resources', async () => {
  const calls = [];
  const server = await listenJson(calls);
  apiModule.setApiBaseUrl(server.baseUrl);

  try {
    await apiModule.hermesApi.listAutomationSources();
    await apiModule.hermesApi.connectAutomationSource({
      adapterKind: 'hermes',
      displayName: 'Mac mini Hermes',
      runnerId: 'runner-a',
      requestId: 'connect-1',
    });
    await apiModule.hermesApi.syncAutomationSource('source one');
    await apiModule.hermesApi.listConnectedAutomations();
    await apiModule.hermesApi.requestAutomationChange({
      sourceId: 'source one',
      automationId: 'automation one',
      operation: 'pause',
      requestId: 'pause-1',
      input: {},
    });
    await apiModule.hermesApi.approveAutomationChange('change one', {
      requestId: 'approve-1',
    });

    assert.deepEqual(calls, [
      { method: 'GET', url: '/api/automation/sources', body: null },
      {
        method: 'POST',
        url: '/api/automation/sources',
        body: {
          adapterKind: 'hermes',
          displayName: 'Mac mini Hermes',
          runnerId: 'runner-a',
          requestId: 'connect-1',
        },
      },
      { method: 'POST', url: '/api/automation/sources/source%20one/sync', body: {} },
      { method: 'GET', url: '/api/automation/automations', body: null },
      {
        method: 'POST',
        url: '/api/automation/changes',
        body: {
          sourceId: 'source one',
          automationId: 'automation one',
          operation: 'pause',
          requestId: 'pause-1',
          input: {},
        },
      },
      {
        method: 'POST',
        url: '/api/automation/changes/change%20one/approve',
        body: { requestId: 'approve-1' },
      },
    ]);
  } finally {
    await server.close();
  }
});

test('Desktop keeps approval-required automation changes behind an explicit user gate', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../src/App.tsx', import.meta.url)),
    'utf8',
  );
  const dashboardSource = readFileSync(
    fileURLToPath(new URL('../src/features/agent-operations/HermesAutomationDashboard.tsx', import.meta.url)),
    'utf8',
  );
  const applyStart = appSource.indexOf('async function applyAutomationChange');
  const applyEnd = appSource.indexOf('async function connectAutomationSource');
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  const applySource = appSource.slice(applyStart, applyEnd);

  assert.doesNotMatch(applySource, /approveAutomationChange/);
  assert.match(dashboardSource, /승인하고 적용/);
  assert.match(dashboardSource, /onApprove/);
});
