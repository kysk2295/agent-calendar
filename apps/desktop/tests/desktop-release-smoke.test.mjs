import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const runnerPath = path.join(desktopRoot, 'tests', 'run-desktop-release-smoke.cjs');

function waitFor(condition, timeoutMs = 5_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out waiting for scenario process'));
      setTimeout(check, 25);
    };
    check();
  });
}

function hasScenarioChild(parentPid) {
  const processList = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return String(processList.stdout || '').split('\n').some((line) => {
    const [pid, ppid, ...command] = line.trim().split(/\s+/);
    return Number(ppid) === parentPid && Number(pid) > 0 && command.join(' ').includes('run-playwright-with-vite.cjs');
  });
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('forced release-smoke wrapper failure writes a SHA-bound truthful partial manifest', async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'desktop-release-smoke-'));
  try {
    const result = await execFileAsync(process.execPath, [runnerPath], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        AGENT_CALENDAR_RELEASE_SMOKE_ARTIFACT_DIR: artifactDir,
        AGENT_CALENDAR_RELEASE_SMOKE_FORCE_FAILURE: 'app-root-smoke',
      },
    }).then(
      (result) => result,
      (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
    );
    assert.notEqual(result.code, 0, 'forced wrapper failure must make release smoke fail');
    const { stdout, stderr } = result;
    const manifest = JSON.parse(await readFile(path.join(artifactDir, 'desktop-release-smoke-manifest.json'), 'utf8'));
    assert.match(`${stdout || ''}${stderr || ''}`, /desktop release smoke/i);
    assert.equal(manifest.sourceSha.length, 40);
    assert.equal(manifest.evidence.liveProduction, false);
    assert.equal(manifest.evidence.fixture, 'injected-authkit-fake-engine');
    assert.equal(manifest.scenarios[0].name, 'app-root-smoke');
    assert.equal(manifest.scenarios[0].status, 'failed');
    assert.equal(manifest.scenarios[1].status, 'not-run');
    assert.equal(manifest.cleanup.userDataDirectories.every((entry) => entry.existsAfterCleanup === false), true);
    assert.ok(manifest.generatedAt);
  } finally {
    await rm(artifactDir, { force: true, recursive: true });
  }
});

test('release smoke is exposed through explicit package scripts and a pinned macOS CI receipt', async () => {
  const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const script of [
    'test:ui:smoke',
    'test:ui:phase8-session-truth',
    'test:ui:phase8-offline-reconnect',
    'test:ui:phase8-desktop-release',
    'test:release-smoke',
  ]) assert.ok(desktopPackage.scripts[script], `missing Desktop script ${script}`);
  assert.equal(rootPackage.scripts['test:desktop-release-smoke'], 'npm --workspace apps/desktop run test:release-smoke');
  assert.match(workflow, /desktop-release-smoke:[\s\S]*?runs-on: macos-14/);
  assert.match(workflow, /Build Electron before release smoke[\s\S]*?Run deterministic Desktop release smoke/);
  assert.match(workflow, /Retain SHA-bound Desktop release-smoke receipt[\s\S]*?if: \$\{\{ always\(\) \}\}/);
});

test('SIGTERM during the first scenario leaves an interrupted manifest and cleanup receipt', async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'desktop-release-smoke-interrupt-'));
  const runner = spawn(process.execPath, [runnerPath], {
    cwd: desktopRoot,
    env: { ...process.env, AGENT_CALENDAR_RELEASE_SMOKE_ARTIFACT_DIR: artifactDir },
    stdio: 'ignore',
  });
  try {
    await waitFor(() => hasScenarioChild(runner.pid));
    runner.kill('SIGTERM');
    assert.deepEqual(await childExit(runner), { code: 143, signal: null });
    const manifest = JSON.parse(await readFile(path.join(artifactDir, 'desktop-release-smoke-manifest.json'), 'utf8'));
    const cleanup = JSON.parse(await readFile(path.join(artifactDir, 'desktop-release-smoke-cleanup.json'), 'utf8'));
    assert.equal(manifest.scenarios[0].status, 'interrupted');
    assert.equal(manifest.scenarios[1].status, 'not-run');
    assert.equal(cleanup.reason, 'SIGTERM');
    assert.equal(cleanup.scenarioProcess.exited, true);
  } finally {
    try { runner.kill('SIGKILL'); } catch {}
    await rm(artifactDir, { force: true, recursive: true });
  }
});

test('scenario timeout emits the same partial manifest and cleanup receipt', async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'desktop-release-smoke-timeout-'));
  try {
    const result = await execFileAsync(process.execPath, [runnerPath], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        AGENT_CALENDAR_RELEASE_SMOKE_ARTIFACT_DIR: artifactDir,
        AGENT_CALENDAR_RELEASE_SMOKE_SCENARIO_TIMEOUT_MS: '1',
      },
    }).then(
      (output) => output,
      (error) => ({ code: error.code }),
    );
    assert.notEqual(result.code, 0);
    const manifest = JSON.parse(await readFile(path.join(artifactDir, 'desktop-release-smoke-manifest.json'), 'utf8'));
    const cleanup = JSON.parse(await readFile(path.join(artifactDir, 'desktop-release-smoke-cleanup.json'), 'utf8'));
    assert.equal(manifest.scenarios[0].status, 'timed_out');
    assert.equal(cleanup.reason, 'timeout');
    assert.equal(cleanup.scenarioProcess.exited, true);
  } finally {
    await rm(artifactDir, { force: true, recursive: true });
  }
});

test('a scenario missing its required screenshot fails without claiming screenshot completeness', async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'desktop-release-smoke-no-screenshot-'));
  try {
    const result = await execFileAsync(process.execPath, [runnerPath], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_CALENDAR_RELEASE_SMOKE_ARTIFACT_DIR: artifactDir,
        AGENT_CALENDAR_RELEASE_SMOKE_TEST_MISSING_SCREENSHOTS: 'app-root-smoke',
      },
    }).then(
      (output) => output,
      (error) => ({ code: error.code }),
    );
    assert.notEqual(result.code, 0);
    const manifest = JSON.parse(await readFile(path.join(artifactDir, 'desktop-release-smoke-manifest.json'), 'utf8'));
    assert.equal(manifest.scenarios[0].status, 'failed');
    assert.deepEqual(manifest.scenarios[0].screenshots, []);
    assert.equal(manifest.scenarios[0].screenshotReceipt.required, true);
    assert.equal(manifest.scenarios[0].screenshotReceipt.complete, false);
    assert.equal(existsSync(path.join(artifactDir, 'screenshots', 'app-root-smoke')), false);
  } finally {
    await rm(artifactDir, { force: true, recursive: true });
  }
});
