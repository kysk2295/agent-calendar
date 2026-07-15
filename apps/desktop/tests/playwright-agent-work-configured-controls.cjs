const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('server did not bind'));
      resolve({ port: address.port, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function closeVite(vite) {
  vite.server.httpServer?.closeAllConnections?.();
  await vite.server.close();
}

async function reservePort() {
  const server = http.createServer();
  const { port } = await listen(server);
  await close(server);
  return port;
}

function configuredSettings() {
  const settingsPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Agent Calendar', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const apiBaseUrl = String(settings.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const apiToken = String(settings.apiToken || '').trim();
  if (!apiBaseUrl || !apiToken) throw new Error('Configured Agent Calendar API credentials are required for this real-runtime test.');
  return { apiBaseUrl, apiToken };
}

async function startVite(apiProxyBaseUrl, credential, port) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve('apps/desktop'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiProxyBaseUrl,
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

async function main() {
  const workId = String(process.env.WORK_ID || '').trim();
  if (!workId) throw new Error('WORK_ID must name a dedicated configured-runtime verification work.');
  const settings = configuredSettings();
  const vitePort = await reservePort();
  const credential = `configured-controls-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { createApiProxyServer } = await import(pathToFileURL(path.resolve('apps/desktop/dist-electron/proxy.js')).href);
  const proxy = createApiProxyServer({
    allowedDevOrigin: `http://127.0.0.1:${vitePort}`,
    credential,
    getSettings: () => settings,
  });
  const proxyAddress = await listen(proxy);
  const vite = await startVite(proxyAddress.baseUrl, credential, vitePort);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await page.goto(vite.url);
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    const recentWork = page.locator(`.agent-recent-work-card[data-work-mission="${workId}"]`);
    await recentWork.waitFor({ timeout: 30_000 });
    await recentWork.click();
    await page.locator('.agent-work-header b', { hasText: '운영 중' }).waitFor({ timeout: 30_000 });

    const missionActions = page.locator('.agent-work-mission-actions');
    const pauseResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/missions/${workId}/pause`));
    await missionActions.getByRole('button', { name: '전체 일시정지', exact: true }).click();
    assert.equal((await pauseResponsePromise).status(), 200);
    await page.locator('.agent-work-header b', { hasText: '일시정지' }).waitFor({ timeout: 30_000 });
    await missionActions.getByRole('button', { name: '재개', exact: true }).waitFor({ timeout: 30_000 });

    const resumeResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/missions/${workId}/activate`));
    await missionActions.getByRole('button', { name: '재개', exact: true }).click();
    assert.equal((await resumeResponsePromise).status(), 200);
    await page.locator('.agent-work-header b', { hasText: '운영 중' }).waitFor({ timeout: 30_000 });

    await page.reload();
    await page.locator('.nav-item').filter({ hasText: '에이전트' }).click();
    await recentWork.waitFor({ timeout: 30_000 });
    await recentWork.click();
    await page.locator('.agent-work-header b', { hasText: '운영 중' }).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('.api-banner').count(), 0);
    assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
    console.log(JSON.stringify({ ok: true, workId, controlCycle: 'pause-resume-reload' }, null, 2));
  } finally {
    await browser.close();
    await closeVite(vite);
    if (proxy.listening) {
      proxy.closeAllConnections?.();
      await close(proxy);
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
