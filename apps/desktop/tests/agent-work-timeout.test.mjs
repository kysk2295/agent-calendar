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

async function listenDelayedConversation() {
  const server = createHttpServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      work: {
        id: 'long-history-work',
        title: '긴 작업 이력',
        agentId: 'default',
        missionThreadId: 'long-history-thread',
      },
      conversation: {
        id: 'long-history-thread',
        missionId: 'long-history-work',
        type: 'mission-thread',
        title: '긴 작업 이력',
        status: 'planning',
      },
      checkpoints: [],
      nextCursor: null,
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('work conversation reads retain the Agent Operations request budget for long histories', async () => {
  // Given
  const server = await listenDelayedConversation();
  apiModule.setApiBaseUrl(server.baseUrl);

  try {
    // When
    const conversation = await apiModule.hermesApi.getAgentWorkConversation('long-history-work', { limit: 200 });

    // Then
    assert.equal(conversation.work.id, 'long-history-work');
    assert.equal(conversation.nextCursor, null);
  } finally {
    await server.close();
  }
});
