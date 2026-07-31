const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../../..');
const DESKTOP_ROOT = path.join(REPOSITORY_ROOT, 'apps', 'desktop');
const DEFAULT_EVIDENCE_DIR = path.join(REPOSITORY_ROOT, '.omo', 'evidence', 'production-readiness-completion', 'task-4');
const MAX_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_ITEMS = 20;
const MAX_DIAGNOSTIC_TEXT = 1_000;
const MAX_HTML_BYTES = 100_000;

function boundedText(value, maximum = MAX_DIAGNOSTIC_TEXT) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function boundedUtf8(value, maximum) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text;
  const suffix = '…';
  const availableBytes = Math.max(0, maximum - Buffer.byteLength(suffix, 'utf8'));
  let result = '';
  let usedBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > availableBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return availableBytes === 0 ? result : `${result}${suffix}`;
}

function timeoutFor(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return MAX_TIMEOUT_MS;
  return Math.min(Math.max(requested, 1), MAX_TIMEOUT_MS);
}

function prepareEvidenceDirectory(evidenceDir) {
  const directory = path.resolve(evidenceDir || DEFAULT_EVIDENCE_DIR);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function artifactPaths(evidenceDir) {
  const directory = prepareEvidenceDirectory(evidenceDir);
  return {
    diagnosticPath: path.join(directory, 'playwright-app-root-diagnostic.json'),
    htmlPath: path.join(directory, 'playwright-app-root-final.html'),
    screenshotPath: path.join(directory, 'playwright-app-root-failure.png'),
  };
}

async function listenOnEphemeralPort(httpServer) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off('error', onError);
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
}

async function startViteHarness() {
  const { createServer } = await import('vite');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-playwright-vite-'));
  let vite;

  try {
    vite = await createServer({
      root: DESKTOP_ROOT,
      cacheDir,
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        hmr: false,
      },
    });
    // Vite's convenience listen method treats 0 as falsy. Its HTTP server is
    // still Vite-owned, so binding that server directly retains port 0's atomic
    // OS allocation rather than reserving and releasing a separate probe port.
    await listenOnEphemeralPort(vite.httpServer);
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Vite did not expose a TCP address');
    }
    const url = `http://127.0.0.1:${address.port}/`;
    let closed = false;
    return {
      url,
      async close() {
        if (closed) return { url, cleanupOrder: [], cacheRemoved: !fs.existsSync(cacheDir) };
        closed = true;
        const cleanupOrder = [];
        let cacheRemoved = false;
        try {
          vite.httpServer?.closeAllConnections?.();
          cleanupOrder.push('server.httpServer.closeAllConnections()');
          await vite.close();
          cleanupOrder.push('vite.close()');
        } finally {
          fs.rmSync(cacheDir, { force: true, recursive: true });
          cacheRemoved = !fs.existsSync(cacheDir);
          cleanupOrder.push('cacheDir.remove()');
        }
        return { url, cleanupOrder, cacheRemoved };
      },
      cacheDir,
    };
  } catch (error) {
    vite?.httpServer?.closeAllConnections?.();
    try {
      await vite?.close();
    } finally {
      fs.rmSync(cacheDir, { force: true, recursive: true });
    }
    throw error;
  }
}

async function writeFailureArtifacts({ evidenceDir, phase, url, navigation, consoleMessages, pageErrors, error, page }) {
  const paths = artifactPaths(evidenceDir);
  let finalHtml = '';
  if (page) {
    try {
      finalHtml = await page.content();
    } catch {
      finalHtml = '';
    }
    try {
      await page.screenshot({ path: paths.screenshotPath, fullPage: true });
    } catch {
      // The page may not have reached a renderable state.
    }
  }
  fs.writeFileSync(paths.htmlPath, boundedUtf8(finalHtml, MAX_HTML_BYTES), 'utf8');
  fs.writeFileSync(paths.diagnosticPath, `${JSON.stringify({
    ok: false,
    phase,
    url,
    navigation,
    console: consoleMessages,
    pageErrors,
    error: { name: error?.name || 'Error', message: boundedText(error?.message) },
  }, null, 2)}\n`);
  return paths;
}

async function assertPlaywrightAppRoot({ url, evidenceDir, timeoutMs, screenshotPath } = {}) {
  if (!url) throw new Error('HERMES_UI_URL is required for the Playwright app-root check');
  const { chromium } = require('playwright');
  const timeout = timeoutFor(timeoutMs);
  const consoleMessages = [];
  const pageErrors = [];
  let rejectPageError;
  const pageErrorDuringReadiness = new Promise((_, reject) => {
    rejectPageError = reject;
  });
  // A page error can arrive during navigation before the readiness race starts.
  // Keep the rejection observed until it is raced below, then surface it there.
  pageErrorDuringReadiness.catch(() => {});
  let browser;
  let page;
  let phase = 'browser-launch';
  let navigation = { response: false, status: null };

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1320, height: 824 } });
    page = await context.newPage();
    page.on('console', (message) => {
      if (consoleMessages.length < MAX_DIAGNOSTIC_ITEMS) {
        consoleMessages.push({ type: message.type(), text: boundedText(message.text()) });
      }
    });
    page.on('pageerror', (error) => {
      const message = boundedText(error.message);
      if (pageErrors.length < MAX_DIAGNOSTIC_ITEMS) pageErrors.push(message);
      if (rejectPageError) {
        rejectPageError(new Error(`App-root page error: ${message}`));
        rejectPageError = null;
      }
    });

    phase = 'navigation';
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    navigation = { response: Boolean(response), status: response?.status() ?? null };
    if (!response) throw new Error('App-root navigation did not return a response');
    if (response.status() >= 400) {
      phase = 'navigation-response';
      throw new Error(`App-root navigation returned status ${response.status()}`);
    }

    phase = 'app-root';
    if (pageErrors.length > 0) {
      phase = 'page-error';
      throw new Error(`App-root page error: ${pageErrors[0]}`);
    }
    try {
      await Promise.race([
        page.locator('.app-root').waitFor({ state: 'attached', timeout }),
        pageErrorDuringReadiness,
      ]);
    } catch (error) {
      if (pageErrors.length > 0) phase = 'page-error';
      throw error;
    } finally {
      rejectPageError = null;
    }
    if (pageErrors.length > 0) {
      phase = 'page-error';
      throw new Error(`App-root page error: ${pageErrors[0]}`);
    }
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    return { url, navigation, consoleMessages, pageErrors };
  } catch (error) {
    const paths = await writeFailureArtifacts({ evidenceDir, phase, url, navigation, consoleMessages, pageErrors, error, page });
    const diagnostic = new Error(`[${phase}] ${boundedText(error.message)}`);
    diagnostic.diagnosticPath = paths.diagnosticPath;
    diagnostic.htmlPath = paths.htmlPath;
    diagnostic.screenshotPath = paths.screenshotPath;
    throw diagnostic;
  } finally {
    await browser?.close();
  }
}

module.exports = {
  DEFAULT_EVIDENCE_DIR,
  assertPlaywrightAppRoot,
  boundedUtf8,
  startViteHarness,
};
