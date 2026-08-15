'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  generateEd25519Keypair,
  sign,
  enrollTranscript,
  fingerprint,
  formatFingerprint,
  PROTOCOL_VERSION,
} = require('../lib/crypto');
const {
  assertSafeArgs,
  BANNED_ARGS,
  normalizeMaxConcurrentWork,
  probeAllEngines,
} = require('../lib/capabilities');
const {
  loadOrCreateIdentity,
  defaultStateDir,
  writePrivateFile,
} = require('../lib/store');
const { RunnerClient } = require('../lib/client');

test('runner generates stable ed25519 identity with restrictive store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-id-'));
  const first = loadOrCreateIdentity(dir);
  const second = loadOrCreateIdentity(dir);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(first.fingerprint, fingerprint(first.publicKey));
  assert.ok(formatFingerprint(first.fingerprint).includes(' '));
  const keyPath = path.join(dir, 'device-key.json');
  const mode = fs.statSync(keyPath).mode & 0o777;
  // On macOS/unix expect 0600; skip hard fail on platforms that ignore mode.
  if (process.platform !== 'win32') {
    assert.equal(mode, 0o600);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runner process restart restores enrollment and active attempt state from its local store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-restart-'));
  const first = new RunnerClient({ baseUrl: 'http://127.0.0.1:1', stateDir: dir });
  first.persist({
    runnerId: 'run-a',
    workspaceId: 'ws-a',
    deviceCredential: 'local-device-credential',
    status: 'active',
    activeAttempt: {
      attemptId: 'attempt-a',
      jobId: 'job-a',
      providerSessionId: 'provider-session-a',
    },
  });

  const restarted = new RunnerClient({ baseUrl: 'http://127.0.0.1:1', stateDir: dir });
  assert.equal(restarted.identity.publicKey, first.identity.publicKey);
  assert.equal(restarted.state.runnerId, 'run-a');
  assert.equal(restarted.state.workspaceId, 'ws-a');
  assert.equal(restarted.state.status, 'active');
  assert.equal(restarted.state.activeAttempt.providerSessionId, 'provider-session-a');
  const stateMode = fs.statSync(path.join(dir, 'state.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(stateMode, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Runner private state replaces the destination through an owner-only temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-atomic-state-'));
  const filePath = path.join(dir, 'state.json');
  const originalRenameSync = fs.renameSync;
  const renames = [];
  fs.renameSync = (source, destination) => {
    renames.push({ source, destination });
    return originalRenameSync(source, destination);
  };
  try {
    writePrivateFile(filePath, '{"status":"active"}\n');
    assert.equal(renames.length, 1);
    assert.equal(renames[0].destination, filePath);
    assert.match(path.basename(renames[0].source), /^\.state\.json\..+\.tmp$/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{"status":"active"}\n');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    }
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner capability probes reject banned args', () => {
  assert.throws(() => assertSafeArgs(['--yolo']), /banned/);
  assert.throws(() => assertSafeArgs(['--dangerously-skip-permissions']), /banned/);
  assert.throws(() => assertSafeArgs(['--dangerously-bypass-approvals-and-sandbox']), /banned/);
  assert.ok(BANNED_ARGS.length >= 3);
  assertSafeArgs(['--version']);
});

test('runner probeAllEngines uses injected probe and never banned args', async () => {
  const called = [];
  const report = await probeAllEngines({
    probeRunner: async ({ engine, args }) => {
      called.push({ engine, args });
      assertSafeArgs(args);
      return {
        available: engine === 'codex',
        status: engine === 'codex' ? 'available' : 'unavailable',
        version: engine === 'codex' ? '1.2.3' : null,
        authStatus: engine === 'codex' ? 'ok' : 'missing',
        message: 'injected',
      };
    },
  });
  assert.equal(called.length, 4);
  assert.equal(report.engines.codex.available, true);
  assert.equal(report.engines.claude.available, false);
  assert.equal(report.engines.grok.available, false);
  assert.equal(report.engines.hermes.available, false);
});

test('Runner reports its bounded execution capacity to the Gateway', async (t) => {
  assert.equal(normalizeMaxConcurrentWork('0'), 1);
  assert.equal(normalizeMaxConcurrentWork('999'), 8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-capacity-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new RunnerClient({
    baseUrl: 'http://127.0.0.1:1',
    stateDir: dir,
    env: { AGENT_CALENDAR_MAX_CONCURRENT_WORK: '999' },
    probeRunner: async () => ({
      available: false,
      status: 'unavailable',
      authStatus: 'missing',
      message: 'fixture',
    }),
  });
  let reported = null;
  client.deviceRequest = async (_method, requestPath, body) => {
    assert.equal(requestPath, '/api/runner/device/capabilities');
    reported = body;
    return { ok: true, capabilities: { engines: body.engines } };
  };

  await client.reportCapabilities();

  assert.equal(reported.maxConcurrentWork, 8);
  assert.equal(client.state.capabilities.maxConcurrentWork, 8);
});

test('enroll transcript is stable and signable', () => {
  const keys = generateEd25519Keypair();
  const t = enrollTranscript({
    challengeId: 'ench_1',
    challengeCode: 'ABCD-EFGH-IJKL',
    devicePublicKey: keys.publicKey,
    protocolVersion: PROTOCOL_VERSION,
    hostName: 'mac',
    hostOs: 'darwin',
    runnerVersion: '0.1.0',
  });
  const sig = sign(keys.privateKey, t);
  assert.ok(sig.length > 20);
  assert.match(t, /^enroll-v1/);
});
