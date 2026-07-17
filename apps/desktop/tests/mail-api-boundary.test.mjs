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
    response.end(JSON.stringify({ ok: true, items: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('desktop mail client uses only the mail messages boundary', async () => {
  const calls = [];
  const server = await listenJson(calls);
  apiModule.setApiBaseUrl(server.baseUrl);

  try {
    await apiModule.hermesApi.getMailMessages();
    await apiModule.hermesApi.runMailAction('mail:owner@gmail.com:message-1', 'star');

    assert.deepEqual(calls, [
      {
        method: 'GET',
        url: '/api/mail/messages?limit=200',
        body: null,
      },
      {
        method: 'POST',
        url: '/api/mail/messages/mail%3Aowner%40gmail.com%3Amessage-1/star',
        body: {},
      },
    ]);
    assert.equal(calls.some((call) => call.url.startsWith('/api/inbox/commands')), false);
  } finally {
    await server.close();
  }
});
