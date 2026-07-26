import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as proxyModule from '../dist-electron/proxy.js';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const apiModule = await vite.ssrLoadModule('/src/api/hermesApi.ts');
const root = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

after(async () => {
  await vite.close();
});

test('Electron creates one ephemeral proxy credential and exposes only a narrow connection object', () => {
  // Given
  const mainSource = source('electron/main.ts');
  const preloadSource = source('electron/preload.cts');

  // When / Then
  assert.match(mainSource, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(mainSource, /createApiProxyServer\(\{[\s\S]*credential:\s*proxyCredential/);
  assert.match(mainSource, /registerTrustedIpcHandle\(ipcMain,\s*'hermes:get-connection',\s*requireTrustedRenderer,[\s\S]*credential:\s*proxyCredential/);
  assert.doesNotMatch(mainSource, /logLifecycle\([^\n]*proxyCredential/);
  assert.match(preloadSource, /getHermesConnection:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('hermes:get-connection'\)/);
  assert.doesNotMatch(preloadSource, /authorization|apiToken/i);
});

test('packaged renderer trust accepts only canonical app index URLs and the configured dev origin', () => {
  // Given
  const trustRenderer = proxyModule.isTrustedProxyRendererUrl;
  assert.equal(typeof trustRenderer, 'function', 'proxy renderer trust predicate must exist');
  const packagedIndexPath = '/Applications/Agent Calendar.app/Contents/Resources/app.asar/dist/index.html';
  const packagedUrl = pathToFileURL(packagedIndexPath).href;
  const packagedOverlayUrl = `${packagedUrl}?overlay=widgets`;
  const packagedRecoveryUrl = `${packagedUrl}?recovery=manual`;
  const options = {
    allowedDevOrigin: 'http://127.0.0.1:5173',
    packagedIndexPath,
  };

  // When / Then
  assert.equal(trustRenderer(packagedUrl, options), true);
  assert.equal(trustRenderer(packagedOverlayUrl, options), true);
  assert.equal(trustRenderer(packagedRecoveryUrl, options), true);
  assert.equal(trustRenderer('http://127.0.0.1:5173/', options), true);
  assert.equal(trustRenderer('http://127.0.0.1:5173/widgets?overlay=widgets', options), true);
  assert.equal(trustRenderer('file:///tmp/attacker.html', options), false);
  assert.equal(trustRenderer(packagedUrl.replace('/dist/index.html', '/dist/nested/../index.html'), options), false);
  assert.equal(trustRenderer(packagedUrl.replace('/dist/index.html', '/dist/nested/%2e%2e/index.html'), options), false);
  assert.equal(trustRenderer(packagedUrl.replace('/dist/index.html', '/dist/%69ndex.html'), options), false);
  assert.equal(trustRenderer(`${packagedUrl}?recovery=automatic`, options), false);
  assert.equal(trustRenderer(`${packagedRecoveryUrl}&extra=value`, options), false);
  assert.equal(trustRenderer('http://localhost:5173/', options), false);
  assert.equal(trustRenderer('http://127.0.0.1:5174/', options), false);
  assert.equal(trustRenderer('https://attacker.example/', options), false);
});

test('desktop exposes one composite Hermes connection and no legacy base-only IPC surface', () => {
  // Given
  const productSources = [
    source('electron/main.ts'),
    source('electron/preload.ts'),
    source('electron/preload.cts'),
    source('src/vite-env.d.ts'),
    source('src/App.tsx'),
  ].join('\n');

  // When / Then
  assert.match(productSources, /getHermesConnection/);
  assert.doesNotMatch(productSources, /getProxyBaseUrl|proxy:get-base-url|getProxyConnection|proxy:get-connection/);
});

test('renderer API attaches the proxy credential centrally without putting it in the URL', async () => {
  // Given
  const calls = [];
  const server = createHttpServer((request, response) => {
    calls.push({ headers: request.headers, url: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const credential = 'renderer-process-credential';

  try {
    // When
    apiModule.setApiProxyConnection({
      baseUrl: `http://127.0.0.1:${address.port}`,
      credential,
    });
    await apiModule.hermesApi.getDashboardState();
    await apiModule.hermesApi.getEvents();
    await apiModule.hermesApi.streamChat({ message: 'hello' });

    // Then
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.headers['x-agent-calendar-proxy-credential'], credential);
      assert.doesNotMatch(call.url, new RegExp(credential));
      assert.equal(call.headers.authorization, undefined);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
