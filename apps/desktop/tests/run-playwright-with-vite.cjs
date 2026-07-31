const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  DEFAULT_EVIDENCE_DIR,
  assertPlaywrightAppRoot,
  startViteHarness,
} = require('./support/playwright-vite-harness.cjs');

function runScenario(scenarioPath, args, environment) {
  let child;
  const completed = new Promise((resolve, reject) => {
    child = spawn(process.execPath, [scenarioPath, ...args], {
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Playwright scenario exited with ${signal || `code ${code}`}`));
    });
  });
  return {
    completed,
    async stop(signal) {
      if (child && child.exitCode === null && !child.killed) child.kill(signal);
      try {
        await completed;
      } catch {
        // A signal-terminated scenario is expected while the wrapper cleans up.
      }
    },
  };
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

function preserveWrapperSignalOwnership(existingListeners, signal, onSignal) {
  for (const listener of process.listeners(signal)) {
    if (!existingListeners.has(listener) && listener !== onSignal) process.off(signal, listener);
  }
}

async function main() {
  const [scenarioArgument, ...args] = process.argv.slice(2);
  if (!scenarioArgument) throw new Error('Usage: node tests/run-playwright-with-vite.cjs <scenario.cjs> [args...]');
  const scenarioPath = path.resolve(process.cwd(), scenarioArgument);
  const evidenceDir = path.resolve(process.env.PLAYWRIGHT_VITE_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const manualUrl = process.env.HERMES_UI_URL;
  const existingSignalListeners = new Map([
    ['SIGINT', new Set(process.listeners('SIGINT'))],
    ['SIGTERM', new Set(process.listeners('SIGTERM'))],
  ]);
  let interruptSignal = '';
  let signalResolver;
  const interrupted = new Promise((resolve) => { signalResolver = resolve; });
  let scenario = null;
  const onSignal = (signal) => {
    if (interruptSignal) return;
    interruptSignal = signal;
    void scenario?.stop(signal);
    signalResolver(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let harness = null;
  let url = manualUrl || '';
  let cleanup = { url, cleanupOrder: ['scenario child/browser'], cacheRemoved: false };
  try {
    harness = manualUrl ? null : await startViteHarness();
    // Vite installs a SIGTERM handler that calls process.exit() before this
    // wrapper can persist its receipt. Keep pre-existing handlers intact while
    // making this wrapper responsible for its own child/server teardown.
    preserveWrapperSignalOwnership(existingSignalListeners.get('SIGTERM'), 'SIGTERM', onSignal);
    url = manualUrl || harness.url;
    cleanup.url = url;
    const readiness = assertPlaywrightAppRoot({
      url,
      evidenceDir,
      timeoutMs: 20_000,
      screenshotPath: path.join(evidenceDir, 'playwright-app-root-ready.png'),
    });
    await Promise.race([readiness, interrupted.then((signal) => { throw new Error(`Interrupted by ${signal}`); })]);
    scenario = runScenario(scenarioPath, args, {
      ...process.env,
      HERMES_UI_URL: url,
      PLAYWRIGHT_VITE_EVIDENCE_DIR: evidenceDir,
    });
    await Promise.race([scenario.completed, interrupted.then((signal) => { throw new Error(`Interrupted by ${signal}`); })]);
  } catch (error) {
    if (!interruptSignal) throw error;
  } finally {
    if (scenario && interruptSignal) await scenario.stop(interruptSignal);
    if (harness) {
      const serverCleanup = await harness.close();
      cleanup = {
        url,
        cleanupOrder: [...cleanup.cleanupOrder, ...serverCleanup.cleanupOrder],
        cacheRemoved: serverCleanup.cacheRemoved,
      };
    }
    if (interruptSignal) cleanup = { ...cleanup, signal: interruptSignal };
    fs.writeFileSync(path.join(evidenceDir, 'playwright-vite-cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (interruptSignal) {
    process.exitCode = signalExitCode(interruptSignal);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = process.exitCode || 1;
});
