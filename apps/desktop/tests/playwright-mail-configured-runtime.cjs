const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

function configuredSettings() {
  const settingsPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Agent Calendar', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!settings.apiBaseUrl || !settings.apiToken) throw new Error('Configured Agent Calendar API credentials are required.');
  return settings;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not reserve Vite port.'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Proxy did not bind.'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startVite(proxyBaseUrl, credential, port) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: proxyBaseUrl,
          changeOrigin: true,
          secure: false,
          headers: { 'x-agent-calendar-proxy-credential': credential },
        },
      },
    },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function stopVite(vite) {
  vite.server.httpServer?.closeAllConnections?.();
  await vite.server.close();
}

async function main() {
  const settings = configuredSettings();
  const port = await reservePort();
  const credential = `mail-live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { createApiProxyServer } = await import(pathToFileURL(path.resolve('apps/desktop/dist-electron/proxy.js')).href);
  const proxy = createApiProxyServer({
    allowedDevOrigin: `http://127.0.0.1:${port}`,
    credential,
    getSettings: () => settings,
  });
  const proxyBaseUrl = await listen(proxy);
  const vite = await startVite(proxyBaseUrl, credential, port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 824 } });
  const apiResponses = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) apiResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });

  try {
    const mailResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/mail/messages';
    }, { timeout: 30_000 });
    await page.goto(vite.url);
    const mailResponse = await mailResponsePromise;
    assert.equal(mailResponse.status(), 200, `Mail boundary returned ${mailResponse.status()}`);
    await page.getByRole('button', { name: /메일함/ }).click();
    await page.waitForFunction(() => document.querySelector('.mail-list-empty, .mail-item'), undefined, { timeout: 30_000 });
    const mailResponses = apiResponses.filter((item) => item.method === 'GET' && item.path === '/api/mail/messages');
    assert.ok(mailResponses.length > 0, 'Desktop proxy did not request the Mail boundary.');
    assert.ok(mailResponses.every((item) => item.status === 200), `Mail boundary status: ${JSON.stringify(mailResponses)}`);
    assert.equal(apiResponses.some((item) => item.path === '/api/inbox/commands'), false);
    assert.equal(await page.locator('.mail-list-error').count(), 0);
    console.log(JSON.stringify({ ok: true, mailResponses, mailItems: await page.locator('.mail-item').count() }, null, 2));
  } finally {
    await browser.close();
    await stopVite(vite);
    proxy.closeAllConnections?.();
    if (proxy.listening) await close(proxy);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
