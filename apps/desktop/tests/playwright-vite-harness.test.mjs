import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import harness from './support/playwright-vite-harness.cjs';

const temporaryPaths = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
after(async () => Promise.all(temporaryPaths.map((entry) => rm(entry, { force: true, recursive: true }))));

async function refusesConnection(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return true;
  }
}

async function startFixture(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function occupyPort(port) {
  const server = createServer((_request, response) => response.end(`occupied ${port}`));
  const outcome = await new Promise((resolve) => {
    server.once('listening', () => resolve({ server, owned: true }));
    server.once('error', (error) => resolve({ error, owned: false }));
    server.listen(port, '127.0.0.1');
  });
  if (!outcome.owned && outcome.error?.code !== 'EADDRINUSE') throw outcome.error;
  return outcome;
}

async function waitForFile(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('two Vite harnesses bind distinct ephemeral URLs and release them after cleanup', async () => {
  const blockerPorts = [5173, 24678];
  const fixedBlockers = await Promise.all(blockerPorts.map(occupyPort));
  const [first, second] = await Promise.all([harness.startViteHarness(), harness.startViteHarness()]);
  let firstCleanup;
  let secondCleanup;
  try {
    assert.notEqual(first.url, second.url);
    assert.notEqual(first.cacheDir, second.cacheDir);
    assert.doesNotMatch(first.url, /:(5173|24678)\//);
    assert.doesNotMatch(second.url, /:(5173|24678)\//);
    assert.equal((await fetch(first.url)).status, 200);
    assert.equal((await fetch(second.url)).status, 200);
    await Promise.all([
      harness.assertPlaywrightAppRoot({ url: first.url, timeoutMs: 20_000 }),
      harness.assertPlaywrightAppRoot({ url: second.url, timeoutMs: 20_000 }),
    ]);
  } finally {
    [firstCleanup, secondCleanup] = await Promise.all([first.close(), second.close()]);
    await Promise.all(fixedBlockers.filter((entry) => entry.owned).map(({ server }) => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
  assert.equal(await refusesConnection(first.url), true);
  assert.equal(await refusesConnection(second.url), true);
  assert.equal(firstCleanup.cacheRemoved, true);
  assert.equal(secondCleanup.cacheRemoved, true);
  await assert.rejects(access(first.cacheDir));
  await assert.rejects(access(second.cacheDir));
});

test('a non-success app response writes bounded diagnostics instead of timing out on .app-root', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const fixture = await startFixture((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>broken fixture</title><main>fixture failure</main>');
  });
  try {
    await assert.rejects(
      harness.assertPlaywrightAppRoot({ url: fixture.url, evidenceDir, timeoutMs: 2_000 }),
      (error) => {
        assert.match(error.message, /status 500/i);
        assert.doesNotMatch(error.message, /selector timeout/i);
        assert.ok(error.diagnosticPath);
        assert.ok(error.htmlPath);
        return true;
      },
    );
    const diagnostic = JSON.parse(await readFile(path.join(evidenceDir, 'playwright-app-root-diagnostic.json'), 'utf8'));
    assert.equal(diagnostic.phase, 'navigation-response');
    assert.equal(diagnostic.navigation.status, 500);
    assert.ok(diagnostic.error.message.length <= 1_000);
    assert.match(await readFile(path.join(evidenceDir, 'playwright-app-root-final.html'), 'utf8'), /fixture failure/);
  } finally {
    await fixture.close();
  }
});

test('a pre-root page error writes explicit diagnostics before a selector timeout', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const fixture = await startFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><script>throw new Error("pre-root React fixture failure")</script>');
  });
  try {
    await assert.rejects(
      harness.assertPlaywrightAppRoot({ url: fixture.url, evidenceDir, timeoutMs: 2_000 }),
      (error) => {
        assert.match(error.message, /page-error.*pre-root React fixture failure/i);
        assert.doesNotMatch(error.message, /selector timeout/i);
        return true;
      },
    );
    const diagnostic = JSON.parse(await readFile(path.join(evidenceDir, 'playwright-app-root-diagnostic.json'), 'utf8'));
    assert.equal(diagnostic.phase, 'page-error');
    assert.match(diagnostic.pageErrors[0], /pre-root React fixture failure/);
  } finally {
    await fixture.close();
  }
});

test('a delayed pre-root page error wins the readiness race instead of becoming a selector timeout', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const fixture = await startFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><script>setTimeout(() => { throw new Error("delayed React fixture failure"); }, 75)</script>');
  });
  try {
    await assert.rejects(
      harness.assertPlaywrightAppRoot({ url: fixture.url, evidenceDir, timeoutMs: 1_000 }),
      (error) => {
        assert.match(error.message, /page-error.*delayed React fixture failure/i);
        assert.doesNotMatch(error.message, /locator\.waitFor.*timeout|selector timeout/i);
        return true;
      },
    );
    const diagnostic = JSON.parse(await readFile(path.join(evidenceDir, 'playwright-app-root-diagnostic.json'), 'utf8'));
    assert.equal(diagnostic.phase, 'page-error');
    assert.match(diagnostic.pageErrors[0], /delayed React fixture failure/);
  } finally {
    await fixture.close();
  }
});

test('failure HTML is UTF-8 valid and bounded by bytes for hostile multibyte output', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const hostileHtml = `<main>${'🧪한'.repeat(20_000)}</main>`;
  const fixture = await startFixture((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    response.end(hostileHtml);
  });
  try {
    await assert.rejects(harness.assertPlaywrightAppRoot({ url: fixture.url, evidenceDir, timeoutMs: 2_000 }));
    const htmlBytes = await readFile(path.join(evidenceDir, 'playwright-app-root-final.html'));
    assert.ok(htmlBytes.byteLength <= 100_000, `HTML artifact must be <=100000 bytes, received ${htmlBytes.byteLength}`);
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(htmlBytes));
  } finally {
    await fixture.close();
  }
});

test('the wrapper preserves HERMES_UI_URL and does not start a Vite server for manual overrides', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const fixture = await startFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><div class="app-root">manual override</div>');
  });
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      'apps/desktop/tests/run-playwright-with-vite.cjs',
      'apps/desktop/tests/playwright-app-root-smoke.cjs',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, HERMES_UI_URL: fixture.url, PLAYWRIGHT_VITE_EVIDENCE_DIR: evidenceDir },
    });
    assert.match(stdout, new RegExp(`\\"url\\":\\"${fixture.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\"`));
    const cleanup = JSON.parse(await readFile(path.join(evidenceDir, 'playwright-vite-cleanup.json'), 'utf8'));
    assert.deepEqual(cleanup.cleanupOrder, ['scenario child/browser']);
  } finally {
    await fixture.close();
  }
});

test('a failed scenario records Vite and cache-directory cleanup before returning failure', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const scenarioPath = path.join(evidenceDir, 'failing-scenario.cjs');
  await writeFile(scenarioPath, 'process.exit(1);\n');
  await assert.rejects(
    execFileAsync(process.execPath, [
      'apps/desktop/tests/run-playwright-with-vite.cjs',
      scenarioPath,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, PLAYWRIGHT_VITE_EVIDENCE_DIR: evidenceDir },
    }),
    /Playwright scenario exited with code 1/,
  );
  const cleanup = JSON.parse(await readFile(path.join(evidenceDir, 'playwright-vite-cleanup.json'), 'utf8'));
  assert.deepEqual(cleanup.cleanupOrder, [
    'scenario child/browser',
    'server.httpServer.closeAllConnections()',
    'vite.close()',
    'cacheDir.remove()',
  ]);
  assert.equal(cleanup.cacheRemoved, true);
  assert.equal(await refusesConnection(cleanup.url), true);
});

test('the wrapper records ordered cleanup before re-raising SIGTERM', async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'playwright-vite-harness-'));
  temporaryPaths.push(evidenceDir);
  const startedPath = path.join(evidenceDir, 'scenario-started');
  const stoppedPath = path.join(evidenceDir, 'scenario-stopped');
  const pidPath = path.join(evidenceDir, 'scenario-pid');
  const scenarioPath = path.join(evidenceDir, 'interruptible-scenario.cjs');
  await writeFile(scenarioPath, [
    "const fs = require('node:fs');",
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stoppedPath)}, 'stopped'); process.exit(0); });`,
    `fs.writeFileSync(${JSON.stringify(startedPath)}, 'started');`,
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'setInterval(() => {}, 1_000);',
  ].join('\n'));
  const wrapper = spawn(process.execPath, [
    'apps/desktop/tests/run-playwright-with-vite.cjs',
    scenarioPath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, PLAYWRIGHT_VITE_EVIDENCE_DIR: evidenceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wrapperStderr = '';
  wrapper.stderr.on('data', (chunk) => { wrapperStderr += String(chunk); });
  try {
    await waitForFile(startedPath);
    wrapper.kill('SIGTERM');
    const exit = await waitForExit(wrapper);
    assert.deepEqual(exit, { code: 143, signal: null });
    assert.equal((await readFile(stoppedPath, 'utf8')).trim(), 'stopped');
    let cleanup;
    try {
      cleanup = JSON.parse(await readFile(path.join(evidenceDir, 'playwright-vite-cleanup.json'), 'utf8'));
    } catch (error) {
      throw new Error(`Wrapper did not record cleanup: ${wrapperStderr || error.message}`);
    }
    assert.equal(cleanup.signal, 'SIGTERM');
    assert.deepEqual(cleanup.cleanupOrder, [
      'scenario child/browser',
      'server.httpServer.closeAllConnections()',
      'vite.close()',
      'cacheDir.remove()',
    ]);
    assert.equal(cleanup.cacheRemoved, true);
    assert.equal(await refusesConnection(cleanup.url), true);
  } finally {
    try {
      const pid = Number((await readFile(pidPath, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      // The fixed wrapper already stopped the child; the RED implementation may not have.
    }
  }
});
