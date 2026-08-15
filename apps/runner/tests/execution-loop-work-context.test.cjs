'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runOnce } = require('../lib/execution-loop');
const { runnerCapabilityCatalog, stableJson } = require('../lib/capability-grants');
const { registerKnowledgeSource } = require('../lib/store');

function authorizedLease(lease, state) {
  const catalog = runnerCapabilityCatalog();
  const configuration = {
    schemaVersion: 1,
    engine: {
      requested: lease.engine,
      resolved: lease.engine,
      model: String(lease.requestedModel || ''),
      reason: 'runner_available',
    },
    runner: {
      ref: state.runnerId,
      catalogId: catalog.catalogId,
      catalogVersion: catalog.version,
      catalogRevision: catalog.revision,
    },
    profile: {
      agentId: 'fixture-agent',
      displayName: 'Fixture agent',
      version: 1,
    },
    rules: {
      base: 'workspace_agent',
      profileInstructionsApplied: false,
      defaultDeny: true,
      denyPrecedence: true,
    },
    grants: {
      allowed: catalog.entries.filter((entry) => entry.id === 'tool:workspace.read'),
      denied: [],
      approvalRequired: [],
    },
    memoryScopes: ['agent_profile'],
    approvalPolicy: {
      grantExpansion: 'required',
      externalDelivery: 'required',
    },
    requiredCapabilities: ['tool:workspace.read'],
  };
  const effectiveConfiguration = {
    ...configuration,
    snapshotId: `ecfg_${crypto.createHash('sha256').update(stableJson(configuration)).digest('hex').slice(0, 32)}`,
    executable: true,
  };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const unsignedLease = {
    offerId: lease.offerId,
    leaseExpiresAt: expiresAt,
    workspaceId: state.workspaceId,
    ...lease,
    effectiveConfiguration,
  };
  const authorization = {
    schemaVersion: 1,
    algorithm: 'hmac-sha256',
    runnerId: state.runnerId,
    workspaceId: state.workspaceId,
    credentialVersion: state.credentialVersion,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt,
  };
  const transcript = `lease-authorization-v1\n${stableJson({ authorization, lease: unsignedLease })}`;
  const key = crypto.createHash('sha256').update(state.deviceCredential, 'utf8').digest();
  return {
    ...unsignedLease,
    authorization: {
      ...authorization,
      mac: crypto.createHmac('sha256', key).update(transcript, 'utf8').digest('base64url'),
    },
  };
}

function offerFixture(index, workingContext, overrides = {}) {
  const suffix = String(index);
  return {
    offerId: `offer-${suffix}`,
    jobId: overrides.jobId || `job-${suffix}`,
    missionId: overrides.missionId || `mission-${suffix}`,
    sessionId: overrides.sessionId || `session-${suffix}`,
    goal: overrides.goal || `complete work ${suffix}`,
    resolvedEngine: overrides.engine || 'codex',
    attemptId: overrides.attemptId || `attempt-${suffix}`,
    leaseEpoch: overrides.leaseEpoch || Number(index),
    payload: {
      workIntake: { workingContext },
    },
  };
}

function clientFixture({ stateDir, offers }) {
  const queue = [...offers];
  const byOfferId = new Map(offers.map((offer, index) => [offer.offerId, { offer, index }]));
  const calls = [];
  const state = {
    runnerId: 'runner-context-fixture',
    workspaceId: 'workspace-context-fixture',
    credentialVersion: 1,
    deviceCredential: 'runner-context-fixture-credential',
  };
  return {
    stateDir,
    state,
    calls,
    remainingOffers: () => queue.length,
    persist(patchValue) { Object.assign(this.state, patchValue); },
    async deviceRequest(method, requestPath, body) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === '/api/runner/device/next-offer') {
        return queue.length ? { offer: queue.shift() } : { offer: null, reason: 'no_offer' };
      }
      if (requestPath === '/api/runner/device/lease') {
        const item = byOfferId.get(body.offerId);
        const offer = item.offer;
        return {
          lease: authorizedLease({
            offerId: offer.offerId,
            attemptId: offer.attemptId || `attempt-${item.index + 1}`,
            jobId: offer.jobId,
            missionId: offer.missionId,
            sessionId: offer.sessionId,
            leaseEpoch: offer.leaseEpoch || item.index + 1,
            engine: offer.resolvedEngine,
            goal: offer.goal,
          }, state),
        };
      }
      if (requestPath === '/api/runner/device/attempt-heartbeat') {
        return { ok: true, cancellationRequested: false };
      }
      if (requestPath === '/api/runner/device/complete') return { ok: true, status: 'completed' };
      if (requestPath === '/api/runner/device/fail') return { ok: true, status: 'failed' };
      if (requestPath === '/api/runner/device/event') return { ok: true };
      if (requestPath === '/api/runner/device/artifact') return { ok: true };
      if (requestPath === '/api/runner/device/provider-session/bind') return { ok: true };
      throw new Error(`unexpected request ${requestPath}`);
    },
  };
}

function successfulAdapter(run) {
  return {
    run: async (input) => {
      if (run) await run(input);
      return { ok: true, summary: 'completed', artifacts: [] };
    },
  };
}

test('workspace_general Work uses a stable per-Work directory independent of daemon cwd', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-general-state-'));
  const daemonCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-daemon-cwd-'));
  t.after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(daemonCwd, { recursive: true, force: true });
  });
  const offers = [
    offerFixture(1, { kind: 'workspace_general' }, { jobId: 'job-stable' }),
    offerFixture(2, { kind: 'workspace_general' }, { jobId: 'job-stable' }),
  ];
  const client = clientFixture({ stateDir, offers });
  const observedCwds = [];
  const options = {
    cwd: daemonCwd,
    heartbeatIntervalMs: 0,
    adapterResolver: () => successfulAdapter(async ({ cwd }) => {
      observedCwds.push(cwd);
      fs.writeFileSync(path.join(cwd, 'result.txt'), 'done');
    }),
  };

  assert.equal((await runOnce(client, options)).completed, true);
  assert.equal((await runOnce(client, options)).completed, true);

  assert.equal(observedCwds.length, 2);
  assert.equal(observedCwds[0], observedCwds[1]);
  assert.notEqual(observedCwds[0], daemonCwd);
  assert.ok(observedCwds[0].startsWith(`${fs.realpathSync(stateDir)}${path.sep}`));
  assert.equal(fs.readFileSync(path.join(observedCwds[0], 'result.txt'), 'utf8'), 'done');
});

test('local_folder resolves only a registered opaque handle and rejects raw or unknown paths', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-local-state-'));
  const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-allowed-folder-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-outside-folder-'));
  t.after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(allowedDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
  const handle = 'folder_abcdEFGH1234';
  registerKnowledgeSource(stateDir, { sourceId: handle, path: allowedDir });
  const client = clientFixture({
    stateDir,
    offers: [
      offerFixture(1, { kind: 'local_folder', handle }),
      offerFixture(2, { kind: 'local_folder', handle, path: outsideDir }),
      offerFixture(3, { kind: 'local_folder', handle: 'folder_unknown1234' }),
    ],
  });
  let adapterRuns = 0;
  const options = {
    cwd: outsideDir,
    heartbeatIntervalMs: 0,
    adapterResolver: () => successfulAdapter(async ({ cwd }) => {
      adapterRuns += 1;
      assert.equal(cwd, fs.realpathSync(allowedDir));
    }),
  };

  assert.equal((await runOnce(client, options)).completed, true);
  assert.equal((await runOnce(client, options)).error, 'WORKING_CONTEXT_RAW_PATH_FORBIDDEN');
  assert.equal((await runOnce(client, options)).error, 'LOCAL_FOLDER_HANDLE_NOT_FOUND');
  assert.equal(adapterRuns, 1);
});

test('the Codex process adapter completes workspace_general and local_folder Work in their resolved directories', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-codex-state-'));
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-codex-local-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-codex-bin-'));
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });
  const executable = path.join(binDir, 'codex');
  fs.writeFileSync(executable, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "const target = args[args.indexOf('-C') + 1];",
    "fs.writeFileSync(path.join(target, 'codex-engine-completed.txt'), 'completed');",
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-fixture' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Work completed' } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
  ].join('\n'), { mode: 0o700 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ''}`;

  const handle = 'folder_codexLocal1234';
  registerKnowledgeSource(stateDir, { sourceId: handle, path: localDir });
  const client = clientFixture({
    stateDir,
    offers: [
      offerFixture(1, { kind: 'workspace_general' }, { jobId: 'job-real-general' }),
      offerFixture(2, { kind: 'local_folder', handle }, { jobId: 'job-real-local' }),
    ],
  });

  const general = await runOnce(client, { heartbeatIntervalMs: 0 });
  const local = await runOnce(client, { heartbeatIntervalMs: 0 });

  assert.equal(general.completed, true);
  assert.equal(local.completed, true);
  assert.equal(local.result.summary, 'Codex: Work completed');
  assert.equal(fs.readFileSync(path.join(localDir, 'codex-engine-completed.txt'), 'utf8'), 'completed');
  const workspaceMarker = path.join(
    stateDir,
    'execution-workspaces',
  );
  const markerPaths = [];
  for (const workspaceName of fs.readdirSync(workspaceMarker)) {
    for (const workName of fs.readdirSync(path.join(workspaceMarker, workspaceName))) {
      markerPaths.push(path.join(workspaceMarker, workspaceName, workName, 'codex-engine-completed.txt'));
    }
  }
  assert.equal(markerPaths.length, 1);
  assert.equal(fs.readFileSync(markerPaths[0], 'utf8'), 'completed');
});

test('Runner capacity 2 overlaps two leases while capacity 1 leaves the second Work queued', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-capacity-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const concurrentClient = clientFixture({
    stateDir,
    offers: [
      offerFixture(1, { kind: 'workspace_general' }),
      offerFixture(2, { kind: 'workspace_general' }),
      offerFixture(3, { kind: 'workspace_general' }),
    ],
  });
  let active = 0;
  let maximumActive = 0;
  const concurrent = await runOnce(concurrentClient, {
    maxConcurrentWork: 2,
    heartbeatIntervalMs: 0,
    adapterResolver: () => successfulAdapter(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
    }),
  });

  assert.equal(concurrent.capacity, 2);
  assert.equal(concurrent.results.filter((result) => result.completed).length, 2);
  assert.equal(maximumActive, 2);
  assert.equal(concurrentClient.remainingOffers(), 1);
  assert.equal(
    concurrentClient.calls.filter((call) => call.path === '/api/runner/device/lease').length,
    2,
  );

  const serialClient = clientFixture({
    stateDir,
    offers: [
      offerFixture(4, { kind: 'workspace_general' }),
      offerFixture(5, { kind: 'workspace_general' }),
    ],
  });
  const serial = await runOnce(serialClient, {
    maxConcurrentWork: 1,
    heartbeatIntervalMs: 0,
    adapterResolver: () => successfulAdapter(),
  });
  assert.equal(serial.completed, true);
  assert.equal(serialClient.remainingOffers(), 1);
  assert.equal(serialClient.calls.filter((call) => call.path === '/api/runner/device/lease').length, 1);
});

test('an interrupted attempt remains durable and a restarted retry clears only that Work', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-recovery-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const offers = [
    offerFixture(1, { kind: 'workspace_general' }, {
      jobId: 'job-recovered',
      attemptId: 'attempt-interrupted',
      leaseEpoch: 1,
    }),
    offerFixture(2, { kind: 'workspace_general' }, {
      jobId: 'job-recovered',
      attemptId: 'attempt-retry',
      leaseEpoch: 2,
    }),
  ];
  const otherAttempt = {
    attemptId: 'attempt-other',
    jobId: 'job-other',
    leaseEpoch: 7,
  };
  const firstClient = clientFixture({ stateDir, offers });
  firstClient.persist({
    activeAttempts: { [otherAttempt.attemptId]: otherAttempt },
    activeAttempt: otherAttempt,
  });
  const crashed = await runOnce(firstClient, {
    heartbeatIntervalMs: 0,
    adapterResolver: () => ({
      run: async () => {
        throw Object.assign(new Error('simulated process crash'), { code: 'FORCED_CRASH' });
      },
    }),
  });

  assert.equal(crashed.crashed, true);
  assert.equal(firstClient.state.activeAttempts['attempt-interrupted'].jobId, 'job-recovered');
  assert.equal(firstClient.state.activeAttempts['attempt-other'].jobId, 'job-other');

  const restartedClient = clientFixture({ stateDir, offers: [offers[1]] });
  restartedClient.state = structuredClone(firstClient.state);
  const resumed = await runOnce(restartedClient, {
    heartbeatIntervalMs: 0,
    adapterResolver: () => successfulAdapter(),
  });

  assert.equal(resumed.completed, true);
  assert.deepEqual(Object.keys(restartedClient.state.activeAttempts), ['attempt-other']);
  assert.equal(restartedClient.state.activeAttempts['attempt-other'].jobId, 'job-other');
});
