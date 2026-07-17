import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const apiModule = await vite.ssrLoadModule('/src/api/hermesApi.ts');
const appSource = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8');
const viteConfigSource = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
const viteTypesSource = readFileSync(fileURLToPath(new URL('../src/vite-env.d.ts', import.meta.url)), 'utf8');

after(async () => {
  await vite.close();
});

test('desktop reads deployment provenance from the public gateway status endpoint', async () => {
  const calls = [];
  const server = createHttpServer((request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      buildCommit: '0123456789ab',
      deploymentId: 'deployment-123',
      runtimeAccessMode: 'relay',
      effectiveRuntimeReachable: true,
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  apiModule.setApiBaseUrl(`http://127.0.0.1:${address.port}`);

  try {
    const status = await apiModule.hermesApi.getGatewayStatus();

    assert.equal(status.buildCommit, '0123456789ab');
    assert.deepEqual(calls, [{ method: 'GET', url: '/api/gateway-status' }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('desktop build identity is embedded and compared with the Railway source commit', () => {
  assert.match(viteConfigSource, /__AGENT_CALENDAR_BUILD_ID__/);
  assert.match(viteConfigSource, /SOURCE_COMMIT/);
  assert.match(viteTypesSource, /declare const __AGENT_CALENDAR_BUILD_ID__: string/);
  assert.match(appSource, /Desktop build/);
  assert.match(appSource, /버전 불일치/);
});
