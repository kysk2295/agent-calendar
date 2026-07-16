import assert from 'node:assert/strict';
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
