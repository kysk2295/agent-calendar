'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, '..', '..');
const MAX_LOG_BYTES = 8_000;
const MAX_SCREENSHOTS_PER_SCENARIO = 20;
const DEFAULT_SCENARIO_TIMEOUT_MS = 120_000;
const MAX_SCENARIO_TIMEOUT_MS = 300_000;
const CHILD_STOP_TIMEOUT_MS = 10_000;
const FIXTURE_EVIDENCE = Object.freeze({
  fixture: 'injected-authkit-fake-engine',
  liveProduction: false,
  scope: 'local deterministic Desktop release smoke only',
});

function boundedText(value, maximum = MAX_LOG_BYTES) {
  const text = String(value || '')
    .split(REPOSITORY_ROOT).join('<repository>')
    .split(DESKTOP_ROOT).join('<desktop>')
    .split(os.homedir()).join('<home>')
    .replace(/https?:\/\/[^\s"']+/g, '<url>');
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text;
  const suffix = '\n…[bounded]';
  const remaining = Math.max(0, maximum - Buffer.byteLength(suffix, 'utf8'));
  return `${Buffer.from(text, 'utf8').subarray(Math.max(0, Buffer.byteLength(text, 'utf8') - remaining)).toString('utf8')}${suffix}`;
}

function sourceSha(environment = process.env) {
  const checkout = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  const localSha = String(checkout.stdout || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(localSha)) throw new Error('Unable to resolve a 40-character checkout source SHA');
  const expectedSha = environment.AGENT_CALENDAR_SOURCE_SHA || environment.GITHUB_SHA || localSha;
  if (!/^[a-f0-9]{40}$/i.test(expectedSha)) throw new Error('AGENT_CALENDAR_SOURCE_SHA/GITHUB_SHA must be a 40-character SHA');
  if (expectedSha.toLowerCase() !== localSha.toLowerCase()) {
    throw new Error(`Source SHA mismatch: checkout=${localSha} expected=${expectedSha}`);
  }
  return localSha.toLowerCase();
}

function artifactDirectory(environment = process.env) {
  const requested = environment.AGENT_CALENDAR_RELEASE_SMOKE_ARTIFACT_DIR
    || path.join(REPOSITORY_ROOT, '.ci-artifacts', 'desktop-release-smoke');
  return path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(REPOSITORY_ROOT, requested);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function pngFiles(directory) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) files.push(entryPath);
    }
  }
  await walk(directory);
  return files.sort().slice(0, MAX_SCREENSHOTS_PER_SCENARIO);
}

async function copyScreenshots({ from, into, artifactRoot }) {
  await fsp.mkdir(into, { recursive: true });
  const copied = [];
  for (const sourcePath of await pngFiles(from)) {
    const fileName = path.basename(sourcePath);
    const destination = path.join(into, fileName);
    await fsp.copyFile(sourcePath, destination);
    const stat = await fsp.stat(destination);
    copied.push({
      path: path.relative(artifactRoot, destination),
      bytes: stat.size,
      sha256: sha256(destination),
    });
  }
  return copied;
}

async function collectScenarioScreenshots({ scenario, from, into, artifactRoot, environment }) {
  if (environment.NODE_ENV === 'test' && environment.AGENT_CALENDAR_RELEASE_SMOKE_TEST_MISSING_SCREENSHOTS === scenario.name) return [];
  return copyScreenshots({ from, into, artifactRoot });
}

function taggedElectronProcesses(userDataName) {
  const result = spawnSync('ps', ['eww', '-ax', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) return { available: false, pids: [] };
  const pids = String(result.stdout || '')
    .split('\n')
    .filter((line) => line.includes(userDataName))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return { available: true, pids: [...new Set(pids)] };
}

function boundedTimeout(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_SCENARIO_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_SCENARIO_TIMEOUT_MS);
}

function waitForCompletion(completed, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    completed.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function startChild({ name, scriptPath, args = [], environment }) {
  let child;
  let stopPromise = null;
  const completed = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: DESKTOP_ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => {
      output = boundedText(`${output}${String(chunk)}`);
    };
    child.stdout.on('data', (chunk) => {
      append(chunk);
    });
    child.stderr.on('data', (chunk) => {
      append(chunk);
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({
      childPid: child.pid,
      durationMs: Date.now() - startedAt,
      exitCode: exitCode ?? (signal ? 1 : 0),
      logTail: boundedText(output),
      name,
      signal: signal || null,
    }));
  });
  return {
    get childPid() { return child?.pid || null; },
    completed,
    async stop(signal) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (child?.exitCode === null && !child.killed) child.kill(signal);
        let result = await waitForCompletion(completed, CHILD_STOP_TIMEOUT_MS);
        let escalated = false;
        if (!result && child?.exitCode === null && !child.killed) {
          escalated = true;
          child.kill('SIGKILL');
          result = await waitForCompletion(completed, CHILD_STOP_TIMEOUT_MS);
        }
        return { exited: Boolean(result), escalated, result };
      })();
      return stopPromise;
    },
  };
}

function scenarios(artifactRoot) {
  return [
    {
      name: 'app-root-smoke',
      scriptPath: path.join(DESKTOP_ROOT, 'tests', 'run-playwright-with-vite.cjs'),
    },
    {
      name: 'phase8-session-truth',
      scriptPath: path.join(DESKTOP_ROOT, 'tests', 'playwright-phase8-session-truth.cjs'),
      screenshotSource: path.join(DESKTOP_ROOT, 'test-results', 'phase8-session-truth'),
    },
    {
      name: 'phase8-offline-reconnect',
      scriptPath: path.join(DESKTOP_ROOT, 'tests', 'playwright-phase8-offline-reconnect.cjs'),
      screenshotSource: path.join(DESKTOP_ROOT, 'test-results', 'phase8-offline-reconnect'),
    },
    {
      name: 'phase8-desktop-release',
      scriptPath: path.join(DESKTOP_ROOT, 'tests', 'playwright-phase8-desktop-release.cjs'),
      screenshotSource: path.join(DESKTOP_ROOT, 'test-results', 'phase8-desktop-release'),
    },
  ];
}

async function executeScenario(scenario, artifactRoot, environment, control) {
  const screenshotDirectory = path.join(artifactRoot, 'screenshots', scenario.name);
  if (scenario.name !== 'app-root-smoke') await fsp.rm(scenario.screenshotSource, { recursive: true, force: true });
  const childEnvironment = { ...environment };
  delete childEnvironment.HERMES_UI_URL;
  if (scenario.name === 'app-root-smoke') {
    const temporaryEvidenceDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-calendar-release-smoke-'));
    childEnvironment.PLAYWRIGHT_VITE_EVIDENCE_DIR = temporaryEvidenceDirectory;
    try {
      const child = startChild({
        name: scenario.name,
        scriptPath: scenario.scriptPath,
        environment: childEnvironment,
        args: ['tests/playwright-app-root-smoke.cjs'],
      });
      control.setCurrentScenario(scenario.name, child);
      const result = await child.completed;
      return {
        ...result,
        screenshots: await collectScenarioScreenshots({ scenario, from: temporaryEvidenceDirectory, into: screenshotDirectory, artifactRoot, environment }),
      };
    } finally {
      control.clearCurrentScenario();
      await fsp.rm(temporaryEvidenceDirectory, { recursive: true, force: true });
    }
  }
  const child = startChild({ name: scenario.name, scriptPath: scenario.scriptPath, environment: childEnvironment });
  control.setCurrentScenario(scenario.name, child);
  try {
    const result = await child.completed;
    return {
      ...result,
      screenshots: await collectScenarioScreenshots({ scenario, from: scenario.screenshotSource, into: screenshotDirectory, artifactRoot, environment }),
    };
  } finally {
    control.clearCurrentScenario();
  }
}

function screenshotReceipt(screenshots, interrupted = false) {
  return {
    required: true,
    collected: screenshots.length,
    complete: !interrupted && screenshots.length > 0,
  };
}

function cleanupFor(scenario, result, control) {
  const userDataName = scenario.name === 'app-root-smoke' ? null : `Agent Calendar AuthKit E2E ${result?.childPid}`;
  const userDataDirectory = userDataName ? path.join(os.homedir(), 'Library', 'Application Support', userDataName) : null;
  const electron = userDataName ? taggedElectronProcesses(userDataName) : { available: true, pids: [] };
  return {
    userDataDirectoryName: userDataName,
    existsAfterCleanup: userDataDirectory ? fs.existsSync(userDataDirectory) : false,
    electronProcessAuditAvailable: electron.available,
    survivingElectronPids: electron.pids,
    wrapperExited: result ? true : Boolean(control.lastStopReceipt?.exited),
    wrapperEscalated: Boolean(control.lastStopReceipt?.escalated),
  };
}

async function runScenario(scenario, artifactRoot, environment, forcedFailure, control) {
  if (forcedFailure === scenario.name) {
    return {
      name: scenario.name,
      status: 'failed',
      durationMs: 0,
      exitCode: 1,
      signal: null,
      logTail: 'Forced failure requested by AGENT_CALENDAR_RELEASE_SMOKE_FORCE_FAILURE.',
      screenshots: [],
      screenshotReceipt: screenshotReceipt([]),
      cleanup: { userDataDirectoryName: null, existsAfterCleanup: false, electronProcessAuditAvailable: true, survivingElectronPids: [], wrapperExited: true, wrapperEscalated: false },
    };
  }
  try {
    const result = await executeScenario(scenario, artifactRoot, environment, control);
    await control.waitForStop();
    const interrupted = control.reason?.kind === 'interrupted';
    const timedOut = control.reason?.kind === 'timeout';
    const screenshots = result.screenshots;
    const receipt = screenshotReceipt(screenshots, interrupted || timedOut);
    const cleanup = cleanupFor(scenario, result, control);
    const passed = result.exitCode === 0 && receipt.complete && !cleanup.existsAfterCleanup && cleanup.survivingElectronPids.length === 0 && cleanup.electronProcessAuditAvailable;
    return {
      ...result,
      screenshots,
      screenshotReceipt: receipt,
      status: interrupted ? 'interrupted' : timedOut ? 'timed_out' : passed ? 'passed' : 'failed',
      cleanup,
    };
  } catch (error) {
    await control.waitForStop();
    const interrupted = control.reason?.kind === 'interrupted';
    const timedOut = control.reason?.kind === 'timeout';
    return {
      name: scenario.name,
      status: interrupted ? 'interrupted' : timedOut ? 'timed_out' : 'failed',
      durationMs: 0,
      exitCode: 1,
      signal: null,
      logTail: boundedText(error.stack || error.message),
      screenshots: [],
      screenshotReceipt: screenshotReceipt([], interrupted || timedOut),
      cleanup: { userDataDirectoryName: null, existsAfterCleanup: false, electronProcessAuditAvailable: false, survivingElectronPids: [], wrapperExited: Boolean(control.lastStopReceipt?.exited), wrapperEscalated: Boolean(control.lastStopReceipt?.escalated) },
    };
  }
}

function createExecutionControl(timeoutMs) {
  let currentScenario = null;
  let currentChild = null;
  let timer = null;
  let stopPromise = null;
  const control = {
    reason: null,
    lastStopReceipt: null,
    setCurrentScenario(name, child) {
      currentScenario = name;
      currentChild = child;
      if (control.reason) {
        void control.stopCurrent();
        return;
      }
      timer = setTimeout(() => {
        control.reason = { kind: 'timeout', scenario: name };
        void control.stopCurrent();
      }, timeoutMs);
    },
    clearCurrentScenario() {
      if (timer) clearTimeout(timer);
      timer = null;
      currentScenario = null;
      currentChild = null;
    },
    interrupt(signal) {
      if (control.reason) return;
      control.reason = { kind: 'interrupted', signal, scenario: currentScenario };
      void control.stopCurrent();
    },
    async stopCurrent() {
      if (stopPromise) return stopPromise;
      if (!currentChild) return null;
      stopPromise = currentChild.stop('SIGTERM').then((receipt) => {
        control.lastStopReceipt = receipt;
        return receipt;
      });
      return stopPromise;
    },
    async waitForStop() {
      if (stopPromise) await stopPromise;
      return control.lastStopReceipt;
    },
    cleanupReceipt() {
      return {
        reason: control.reason?.kind === 'interrupted' ? control.reason.signal : control.reason?.kind || null,
        scenario: control.reason?.scenario || currentScenario,
        scenarioProcess: {
          exited: Boolean(control.lastStopReceipt?.exited),
          escalated: Boolean(control.lastStopReceipt?.escalated),
          childPid: control.lastStopReceipt?.result?.childPid || null,
        },
      };
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return control;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(temporaryPath, filePath);
}

function notRunScenario(scenario, reason) {
  return {
    name: scenario.name,
    status: 'not-run',
    durationMs: 0,
    exitCode: null,
    signal: null,
    logTail: reason,
    screenshots: [],
    screenshotReceipt: screenshotReceipt([], true),
    cleanup: { userDataDirectoryName: null, existsAfterCleanup: false, electronProcessAuditAvailable: true, survivingElectronPids: [], wrapperExited: true, wrapperEscalated: false },
  };
}

async function main(environment = process.env) {
  const artifactRoot = artifactDirectory(environment);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const control = createExecutionControl(boundedTimeout(environment.AGENT_CALENDAR_RELEASE_SMOKE_SCENARIO_TIMEOUT_MS));
  const onSigint = () => control.interrupt('SIGINT');
  const onSigterm = () => control.interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let sha = '';
  const results = [];
  let setupError = null;
  try {
    sha = sourceSha(environment);
    for (const scenario of scenarios(artifactRoot)) {
      if (control.reason) {
        results.push({
          ...notRunScenario(scenario, 'Not run because Desktop release smoke was interrupted before this scenario started.'),
          status: control.reason.kind === 'interrupted' ? 'interrupted' : 'timed_out',
        });
        break;
      }
      const result = await runScenario(scenario, artifactRoot, environment, environment.AGENT_CALENDAR_RELEASE_SMOKE_FORCE_FAILURE || '', control);
      results.push(result);
      if (result.status !== 'passed') break;
    }
  } catch (error) {
    setupError = boundedText(error.stack || error.message);
  }
  for (const scenario of scenarios(artifactRoot).slice(results.length)) {
    results.push(notRunScenario(scenario, 'Not run because an earlier release-smoke stage failed.'));
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    durationMs: Date.now() - startedMs,
    sourceSha: sha,
    evidence: FIXTURE_EVIDENCE,
    setupError,
    scenarios: results,
    cleanup: {
      electronProcesses: results.flatMap((result) => result.cleanup.survivingElectronPids),
      userDataDirectories: results.map((result) => ({
        scenario: result.name,
        existsAfterCleanup: result.cleanup.existsAfterCleanup,
        name: result.cleanup.userDataDirectoryName,
      })),
    },
  };
  const manifestPath = path.join(artifactRoot, 'desktop-release-smoke-manifest.json');
  const cleanupPath = path.join(artifactRoot, 'desktop-release-smoke-cleanup.json');
  await writeJsonAtomically(manifestPath, manifest);
  await writeJsonAtomically(cleanupPath, {
    ...control.cleanupReceipt(),
    generatedAt: new Date().toISOString(),
    sourceSha: sha,
    scenarios: results.map((result) => ({ name: result.name, status: result.status, cleanup: result.cleanup })),
  });
  control.close();
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  const passed = !setupError && results.every((result) => result.status === 'passed');
  console.log(`Desktop release smoke ${passed ? 'passed' : 'failed'}; manifest=${path.relative(REPOSITORY_ROOT, manifestPath)}`);
  if (control.reason?.kind === 'interrupted') process.exitCode = control.reason.signal === 'SIGINT' ? 130 : 143;
  else if (!passed) process.exitCode = 1;
  return manifest;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { FIXTURE_EVIDENCE, artifactDirectory, main, sourceSha };
