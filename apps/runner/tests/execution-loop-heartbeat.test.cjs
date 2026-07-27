'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { runOnce } = require('../lib/execution-loop');
const { runnerCapabilityCatalog, stableJson } = require('../lib/capability-grants');

function backendAuthorizedLease(lease, state) {
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
      agentId: 'default',
      displayName: 'Default agent',
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
    snapshotId: `ecfg_${crypto
      .createHash('sha256')
      .update(JSON.stringify(configuration))
      .digest('hex')
      .slice(0, 32)}`,
    executable: true,
  };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const unsignedLease = {
    offerId: String(lease.offerId || 'offer-fixture'),
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
  const transcript = `lease-authorization-v1\n${stableJson({
    authorization,
    lease: unsignedLease,
  })}`;
  const key = crypto.createHash('sha256').update(state.deviceCredential, 'utf8').digest();
  return {
    ...unsignedLease,
    authorization: {
      ...authorization,
      mac: crypto.createHmac('sha256', key).update(transcript, 'utf8').digest('base64url'),
    },
  };
}

function mockClient({ cancelAfterHeartbeats = 0 } = {}) {
  let heartbeats = 0;
  let cancelAcked = false;
  const calls = [];
  return {
    calls,
    cancelAcked: () => cancelAcked,
    state: {
      runnerId: 'runner-heartbeat-fixture',
      workspaceId: 'workspace-heartbeat-fixture',
      credentialVersion: 1,
      deviceCredential: 'runner-heartbeat-fixture-credential',
    },
    persist(patch) { Object.assign(this.state, patch); },
    async deviceRequest(method, path, body) {
      calls.push({ method, path, body });
      if (path === '/api/runner/device/next-offer') {
        return {
          offer: {
            offerId: 'off1',
            jobId: 'job1',
            missionId: 'm1',
            sessionId: 's1',
            goal: 'long',
            resolvedEngine: 'fake',
          },
        };
      }
      if (path === '/api/runner/device/lease') {
        return {
          lease: backendAuthorizedLease({
            offerId: 'off1',
            attemptId: 'att1',
            jobId: 'job1',
            missionId: 'm1',
            sessionId: 's1',
            leaseEpoch: 1,
            engine: 'fake',
            goal: 'long',
          }, this.state),
        };
      }
      if (path === '/api/runner/device/attempt-heartbeat') {
        heartbeats += 1;
        return {
          ok: true,
          cancellationRequested: cancelAfterHeartbeats > 0 && heartbeats >= cancelAfterHeartbeats,
          leaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
        };
      }
      if (path === '/api/runner/device/event') return { ok: true, event: { sequence: 1 } };
      if (path === '/api/runner/device/artifact') return { ok: true };
      if (path === '/api/runner/device/complete') return { ok: true, status: 'completed' };
      if (path === '/api/runner/device/fail') return { ok: true, status: 'failed' };
      if (path === '/api/runner/device/cancel-ack') {
        cancelAcked = true;
        return { ok: true, status: 'cancelled' };
      }
      return { ok: true };
    },
  };
}

test('execution-loop heartbeats during long fake run then completes', async () => {
  process.env.AGENT_CALENDAR_FAKE_ENGINE_STEP_MS = '0';
  const client = mockClient({ cancelAfterHeartbeats: 0 });
  const result = await runOnce(client, {
    env: { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
    longRunMs: 350,
    heartbeatIntervalMs: 80,
  });
  assert.equal(result.completed, true);
  const hbCount = client.calls.filter((c) => c.path === '/api/runner/device/attempt-heartbeat').length;
  assert.ok(hbCount >= 2, `expected heartbeats, got ${hbCount}`);
  assert.equal(client.cancelAcked(), false);
});

test('execution-loop cancel-acks only when server requested cancellation', async () => {
  process.env.AGENT_CALENDAR_FAKE_ENGINE_STEP_MS = '0';
  const client = mockClient({ cancelAfterHeartbeats: 2 });
  const result = await runOnce(client, {
    env: { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
    longRunMs: 800,
    heartbeatIntervalMs: 60,
  });
  assert.equal(result.cancelled, true);
  assert.equal(client.cancelAcked(), true);
  assert.equal(client.calls.some((c) => c.path === '/api/runner/device/complete'), false);
});

test('execution-loop sends the exact provider session to the adapter and returns captured resume metadata', async () => {
  const client = mockClient();
  const providerSession = {
    id: 'provider-session-a',
    provider: 'codex',
    externalSessionId: 'codex-thread-a',
    status: 'active',
  };
  client.deviceRequest = async function deviceRequest(method, path, body) {
    this.calls.push({ method, path, body });
    if (path === '/api/runner/device/next-offer') {
      return {
        offer: {
          offerId: 'off-provider',
          jobId: 'job-provider',
          missionId: 'mission-provider',
          sessionId: 'conversation-provider',
          goal: 'continue the same work',
          resolvedEngine: 'codex',
          providerSession,
        },
      };
    }
    if (path === '/api/runner/device/lease') {
      return {
        lease: backendAuthorizedLease({
          offerId: 'off-provider',
          attemptId: 'attempt-provider',
          jobId: 'job-provider',
          missionId: 'mission-provider',
          sessionId: 'conversation-provider',
          leaseEpoch: 1,
          engine: 'codex',
          requestedModel: 'gpt-5.6-codex',
          goal: 'continue the same work',
          providerSession,
        }, this.state),
      };
    }
    if (path === '/api/runner/device/attempt-heartbeat') return { ok: true, cancellationRequested: false };
    if (path === '/api/runner/device/complete') return { ok: true, status: 'completed' };
    if (path === '/api/runner/device/event') return { ok: true };
    if (path === '/api/runner/device/artifact') return { ok: true };
    return { ok: true };
  };

  let adapterInput = null;
  const result = await runOnce(client, {
    heartbeatIntervalMs: 0,
    adapterResolver: () => ({
      run: async (input) => {
        adapterInput = input;
        return {
          ok: true,
          summary: 'continued',
          model: 'gpt-5.6-codex',
          resume: { sessionId: 'codex-thread-a' },
          artifacts: [],
        };
      },
    }),
  });

  assert.equal(result.completed, true);
  assert.equal(adapterInput.providerSession.externalSessionId, 'codex-thread-a');
  assert.equal(adapterInput.model, 'gpt-5.6-codex');
  const completed = client.calls.find((call) => call.path === '/api/runner/device/complete');
  assert.equal(completed.body.resolvedModel, 'gpt-5.6-codex');
  assert.deepEqual(completed.body.providerSession, {
    id: 'provider-session-a',
    externalSessionId: 'codex-thread-a',
  });
});

test('execution-loop durably binds a newly reported provider session before terminal completion', async () => {
  const client = mockClient();
  const persisted = [];
  client.persist = function persist(patch) {
    persisted.push(structuredClone(patch));
    Object.assign(this.state, patch);
  };
  const providerSession = {
    id: 'provider-session-new',
    provider: 'codex',
    externalSessionId: '',
    status: 'pending',
  };
  client.deviceRequest = async function deviceRequest(method, path, body) {
    this.calls.push({ method, path, body });
    if (path === '/api/runner/device/next-offer') {
      return {
        offer: {
          offerId: 'offer-new',
          jobId: 'job-new',
          missionId: 'mission-new',
          sessionId: 'conversation-new',
          goal: 'start provider session',
          resolvedEngine: 'codex',
          providerSession,
        },
      };
    }
    if (path === '/api/runner/device/lease') {
      return {
        lease: backendAuthorizedLease({
          offerId: 'offer-new',
          attemptId: 'attempt-new',
          jobId: 'job-new',
          missionId: 'mission-new',
          sessionId: 'conversation-new',
          leaseEpoch: 1,
          engine: 'codex',
          goal: 'start provider session',
          providerSession,
        }, this.state),
      };
    }
    if (path === '/api/runner/device/attempt-heartbeat') return { ok: true, cancellationRequested: false };
    if (path === '/api/runner/device/provider-session/bind') return { ok: true, status: 'active' };
    if (path === '/api/runner/device/event') return { ok: true };
    if (path === '/api/runner/device/complete') return { ok: true, status: 'completed' };
    return { ok: true };
  };

  const result = await runOnce(client, {
    heartbeatIntervalMs: 0,
    adapterResolver: () => ({
      run: async ({ onCheckpoint }) => {
        await onCheckpoint({
          phase: 'plan',
          kind: 'checkpoint',
          text: 'provider session accepted',
          providerSession: {
            externalSessionId: 'codex-thread-new',
          },
        });
        return {
          ok: true,
          summary: 'created',
          resume: { threadId: 'codex-thread-new' },
          artifacts: [],
        };
      },
    }),
  });

  assert.equal(result.completed, true);
  const bindIndex = client.calls.findIndex((call) => call.path === '/api/runner/device/provider-session/bind');
  const eventIndex = client.calls.findIndex((call) => call.path === '/api/runner/device/event');
  const completeIndex = client.calls.findIndex((call) => call.path === '/api/runner/device/complete');
  assert.ok(bindIndex >= 0);
  assert.ok(bindIndex < eventIndex);
  assert.ok(bindIndex < completeIndex);
  assert.deepEqual(client.calls[bindIndex].body, {
    providerSessionId: 'provider-session-new',
    externalSessionId: 'codex-thread-new',
  });
  assert.ok(persisted.some((patch) => (
    patch.activeAttempt?.providerSession?.externalSessionId === 'codex-thread-new'
  )));
});

test('execution-loop restores a locally captured provider session before polling another offer', async () => {
  const client = mockClient();
  client.state.activeAttempt = {
    attemptId: 'attempt-interrupted',
    jobId: 'job-interrupted',
    providerSession: {
      id: 'provider-session-interrupted',
      externalSessionId: 'codex-thread-interrupted',
    },
  };
  client.deviceRequest = async function deviceRequest(method, path, body) {
    this.calls.push({ method, path, body });
    if (path === '/api/runner/device/provider-session/bind') {
      return { ok: true, status: 'active', replay: true };
    }
    if (path === '/api/runner/device/next-offer') {
      return { offer: null, reason: 'active_attempt_recovery' };
    }
    return { ok: true };
  };

  const result = await runOnce(client, { heartbeatIntervalMs: 0 });

  assert.equal(result.idle, true);
  assert.equal(client.calls[0].path, '/api/runner/device/provider-session/bind');
  assert.deepEqual(client.calls[0].body, {
    providerSessionId: 'provider-session-interrupted',
    externalSessionId: 'codex-thread-interrupted',
  });
  assert.equal(client.state.activeAttempt.providerSession, null);
});
