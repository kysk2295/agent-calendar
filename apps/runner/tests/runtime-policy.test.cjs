'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { getEngineAdapter } = require('../lib/engines');
const { isFakeEngineAllowed } = require('../lib/runtime-policy');
const { runOnce } = require('../lib/execution-loop');
const { probeAllEngines } = require('../lib/capabilities');
const { runnerCapabilityCatalog } = require('../lib/capability-grants');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validEffectiveConfiguration() {
  const catalog = runnerCapabilityCatalog();
  const configuration = {
    schemaVersion: 1,
    engine: {
      requested: 'codex',
      resolved: 'codex',
      model: '',
      reason: 'runner_available',
    },
    runner: {
      ref: 'runner_aaaaaaaaaaaaaaaaaaaaaaaa',
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
  return configurationWithSnapshot(configuration, true);
}

function configurationWithSnapshot(configuration, executable) {
  const snapshotId = `ecfg_${crypto
    .createHash('sha256')
    .update(JSON.stringify(configuration))
    .digest('hex')
    .slice(0, 32)}`;
  return { ...configuration, snapshotId, executable };
}

function authorizeLease(lease, {
  credential,
  runnerId,
  workspaceId,
  credentialVersion,
  issuedAt,
  expiresAt,
}) {
  const authorization = {
    schemaVersion: 1,
    algorithm: 'hmac-sha256',
    runnerId,
    workspaceId,
    credentialVersion,
    issuedAt,
    expiresAt,
  };
  const transcript = `lease-authorization-v1\n${stableJson({ authorization, lease })}`;
  const key = crypto.createHash('sha256').update(credential, 'utf8').digest();
  return {
    ...lease,
    authorization: {
      ...authorization,
      mac: crypto.createHmac('sha256', key).update(transcript, 'utf8').digest('base64url'),
    },
  };
}

function executableLease(now = Date.now()) {
  return {
    offerId: 'offer-authentic',
    attemptId: 'attempt-authentic',
    jobId: 'job-authentic',
    missionId: 'mission-authentic',
    sessionId: 'session-authentic',
    attemptNumber: 1,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(now + 60_000).toISOString(),
    engine: 'codex',
    requestedModel: '',
    goal: 'read harmless Workspace context',
    turnIndex: 1,
    turnTargetIndex: 0,
    turnMode: 'single',
    workspaceId: 'workspace-authentic',
    effectiveConfiguration: validEffectiveConfiguration(),
  };
}

function executionClient(lease, state) {
  return {
    state: { ...state },
    persist(patch) {
      this.state = { ...this.state, ...patch };
    },
    async deviceRequest(_method, path) {
      if (path === '/api/runner/device/next-offer') {
        return { offer: { offerId: lease.offerId, payload: {} } };
      }
      if (path === '/api/runner/device/lease') return { lease };
      if (path === '/api/runner/device/attempt-heartbeat') {
        return { ok: true, cancellationRequested: false };
      }
      if (path === '/api/runner/device/complete') return { ok: true };
      throw new Error(`unexpected device path: ${path}`);
    },
  };
}

test('Runner test harness can opt into the Fake Engine adapter with both policy keys', () => {
  // Given: a test harness injects the exact policy environment.
  // When: it requests the Fake Engine adapter.
  const adapter = getEngineAdapter('fake', {
    env: { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
  });

  // Then: the deterministic Fake adapter is available to the harness.
  assert.equal(adapter.id, 'fake');
});

test('Runner Fake Engine policy allows only the exact two-key test environment', () => {
  // Given: injected environments that include each supported and unsupported boundary case.
  const cases = [
    [{ NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, true],
    [{ NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, false],
    [{ AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, false],
    [{ NODE_ENV: 'test' }, false],
    [{ NODE_ENV: 'Test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' }, false],
    [{ NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1 ' }, false],
  ];

  // When: the runtime evaluates each injected environment.
  const actual = cases.map(([env]) => isFakeEngineAllowed(env));

  // Then: Fake is enabled only by the exact two-key test opt-in.
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
});

test('Runner Fake Engine policy fails closed for malformed injected environments', () => {
  // Given: malformed environment inputs.
  const inputs = [null, 1, 'test'];

  // When: the runtime evaluates them.
  const actual = inputs.map((env) => isFakeEngineAllowed(env));

  // Then: no malformed input enables Fake.
  assert.deepEqual(actual, [false, false, false]);
});

test('Runner adapter rejects a production Fake request despite legacy opt-in options', () => {
  // Given: production receives both the legacy opt-in option and the flag.
  const env = { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' };

  // When: the adapter resolver receives a Fake request.
  const resolve = () => getEngineAdapter('fake', { allowFake: true, env });

  // Then: the policy rejects it with the stable boundary code.
  assert.throws(resolve, (error) => error.code === 'FAKE_ENGINE_FORBIDDEN');
});

test('Runner probe reports Fake only for the injected two-key test environment', async () => {
  // Given: a deterministic probe and an exact test-only environment.
  const probeRunner = async () => ({ available: false, status: 'unavailable' });
  const env = { NODE_ENV: 'test', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' };

  // When: capabilities are collected.
  const report = await probeAllEngines({ env, probeRunner });

  // Then: Fake is explicitly present for the test harness only.
  assert.equal(report.engines.fake?.available, true);
});

test('Runner refuses a hostile production Fake lease before resolving an adapter', async () => {
  // Given: a production runner receives a forged Fake offer and lease.
  let resolverCalled = false;
  const client = {
    state: {},
    persist() {},
    async deviceRequest(_method, path) {
      if (path === '/api/runner/device/next-offer') return { offer: { offerId: 'offer-1' } };
      if (path === '/api/runner/device/lease') {
        return { lease: { attemptId: 'attempt-1', jobId: 'job-1', leaseEpoch: 1, engine: 'fake', goal: 'forged' } };
      }
      throw new Error(`unexpected device path: ${path}`);
    },
  };

  // When: the execution loop processes the forged lease.
  const run = () => runOnce(client, {
    env: { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' },
    adapterResolver: () => {
      resolverCalled = true;
      return { run: async () => ({ ok: true }) };
    },
  });

  // Then: no adapter is invoked and the lease is rejected.
  await assert.rejects(run, (error) => error.code === 'FAKE_ENGINE_FORBIDDEN');
  assert.equal(resolverCalled, false);
});

test('Runner refuses a denied capability before resolving or executing an adapter', async () => {
  let resolverCalled = false;
  const client = {
    state: {},
    persist() {},
    async deviceRequest(_method, path) {
      if (path === '/api/runner/device/next-offer') return { offer: { offerId: 'offer-denied' } };
      if (path === '/api/runner/device/lease') {
        return {
          lease: {
            attemptId: 'attempt-denied',
            jobId: 'job-denied',
            leaseEpoch: 1,
            engine: 'codex',
            goal: 'forged denied capability',
            effectiveConfiguration: {
              schemaVersion: 1,
              snapshotId: 'ecfg_00000000000000000000000000000000',
              executable: false,
              requiredCapabilities: ['tool:external.delivery'],
              grants: {
                allowed: [],
                denied: ['tool:external.delivery'],
                approvalRequired: [],
              },
            },
          },
        };
      }
      throw new Error(`unexpected device path: ${path}`);
    },
  };

  await assert.rejects(
    () => runOnce(client, {
      adapterResolver: () => {
        resolverCalled = true;
        return { run: async () => ({ ok: true }) };
      },
    }),
    (error) => error.code === 'CAPABILITY_GRANT_DENIED',
  );
  assert.equal(resolverCalled, false);
});

test('Runner rejects a recomputed unkeyed effective-configuration forgery before adapter resolution', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-recomputed-forgery';
  const state = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
  };
  const legitimateConfiguration = validEffectiveConfiguration();
  const deniedConfiguration = configurationWithSnapshot({
    ...legitimateConfiguration,
    grants: {
      allowed: [],
      denied: ['tool:workspace.read'],
      approvalRequired: [],
    },
    snapshotId: undefined,
    executable: undefined,
  }, false);
  delete deniedConfiguration.snapshotId;
  delete deniedConfiguration.executable;
  const serverLease = authorizeLease({
    ...executableLease(now),
    effectiveConfiguration: configurationWithSnapshot(deniedConfiguration, false),
  }, {
    credential,
    runnerId: state.runnerId,
    workspaceId: state.workspaceId,
    credentialVersion: state.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const forgedConfiguration = {
    ...serverLease.effectiveConfiguration,
    grants: {
      allowed: runnerCapabilityCatalog().entries.filter(
        (entry) => entry.id === 'tool:workspace.read',
      ),
      denied: [],
      approvalRequired: [],
    },
  };
  delete forgedConfiguration.snapshotId;
  delete forgedConfiguration.executable;
  const forgedLease = {
    ...serverLease,
    effectiveConfiguration: configurationWithSnapshot(forgedConfiguration, true),
  };
  let resolverCalled = false;

  await assert.rejects(
    () => runOnce(executionClient(forgedLease, state), {
      heartbeatIntervalMs: 0,
      adapterResolver: () => {
        resolverCalled = true;
        return { run: async () => ({ ok: true }) };
      },
    }),
    (error) => error.code === 'LEASE_AUTHORIZATION_INVALID',
  );
  assert.equal(resolverCalled, false);
});

test('Runner rejects a stripped effective configuration before resolver or adapter execution', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-stripped-effective';
  const state = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
    consumedLeaseAuthorizations: [],
  };
  const signedLease = authorizeLease(executableLease(now), {
    credential,
    runnerId: state.runnerId,
    workspaceId: state.workspaceId,
    credentialVersion: state.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const strippedLease = { ...signedLease };
  delete strippedLease.effectiveConfiguration;
  let resolverCalls = 0;
  let adapterCalls = 0;
  const client = executionClient(strippedLease, state);

  await assert.rejects(
    () => runOnce(client, {
      heartbeatIntervalMs: 0,
      adapterResolver: () => {
        resolverCalls += 1;
        return {
          run: async () => {
            adapterCalls += 1;
            return { ok: true };
          },
        };
      },
    }),
    (error) => error.code === 'EFFECTIVE_CONFIGURATION_REQUIRED',
  );
  assert.equal(resolverCalls, 0);
  assert.equal(adapterCalls, 0);
  assert.deepEqual(client.state.consumedLeaseAuthorizations, []);
});

test('Runner rejects a stripped effective configuration and authorization before resolver or adapter execution', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-stripped-envelope';
  const state = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
    consumedLeaseAuthorizations: [],
  };
  const signedLease = authorizeLease(executableLease(now), {
    credential,
    runnerId: state.runnerId,
    workspaceId: state.workspaceId,
    credentialVersion: state.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const strippedLease = { ...signedLease };
  delete strippedLease.effectiveConfiguration;
  delete strippedLease.authorization;
  let resolverCalls = 0;
  let adapterCalls = 0;
  const client = executionClient(strippedLease, state);

  await assert.rejects(
    () => runOnce(client, {
      heartbeatIntervalMs: 0,
      adapterResolver: () => {
        resolverCalls += 1;
        return {
          run: async () => {
            adapterCalls += 1;
            return { ok: true };
          },
        };
      },
    }),
    (error) => error.code === 'EFFECTIVE_CONFIGURATION_REQUIRED',
  );
  assert.equal(resolverCalls, 0);
  assert.equal(adapterCalls, 0);
  assert.deepEqual(client.state.consumedLeaseAuthorizations, []);
});

test('Runner rejects malformed lease envelope fields before resolver or adapter execution', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-malformed-envelope';
  const state = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
    consumedLeaseAuthorizations: [],
  };
  const signedLease = authorizeLease(executableLease(now), {
    credential,
    runnerId: state.runnerId,
    workspaceId: state.workspaceId,
    credentialVersion: state.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const malformedLeases = [
    ...[null, 42, 'invalid', []].map((effectiveConfiguration) => ({
      ...signedLease,
      effectiveConfiguration,
    })),
    ...[null, 42, 'invalid', []].map((authorization) => ({
      ...signedLease,
      authorization,
    })),
  ];

  for (const lease of malformedLeases) {
    let resolverCalls = 0;
    let adapterCalls = 0;
    const client = executionClient(lease, state);
    await assert.rejects(
      () => runOnce(client, {
        heartbeatIntervalMs: 0,
        adapterResolver: () => {
          resolverCalls += 1;
          return {
            run: async () => {
              adapterCalls += 1;
              return { ok: true };
            },
          };
        },
      }),
      (error) => [
        'EFFECTIVE_CONFIGURATION_REQUIRED',
        'LEASE_AUTHORIZATION_REQUIRED',
      ].includes(error.code),
    );
    assert.equal(resolverCalls, 0);
    assert.equal(adapterCalls, 0);
    assert.deepEqual(client.state.consumedLeaseAuthorizations, []);
  }
});

test('Runner rejects every authenticated lease-field tamper before adapter resolution', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-tamper-matrix';
  const state = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
  };
  const signedLease = authorizeLease(executableLease(now), {
    credential,
    runnerId: state.runnerId,
    workspaceId: state.workspaceId,
    credentialVersion: state.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const tampered = [
    { ...signedLease, jobId: 'job-forged' },
    { ...signedLease, workspaceId: 'workspace-foreign' },
    {
      ...signedLease,
      effectiveConfiguration: {
        ...signedLease.effectiveConfiguration,
        executable: false,
      },
    },
    {
      ...signedLease,
      effectiveConfiguration: {
        ...signedLease.effectiveConfiguration,
        snapshotId: 'ecfg_ffffffffffffffffffffffffffffffff',
      },
    },
    {
      ...signedLease,
      effectiveConfiguration: {
        ...signedLease.effectiveConfiguration,
        grants: {
          ...signedLease.effectiveConfiguration.grants,
          allowed: [],
        },
      },
    },
    {
      ...signedLease,
      effectiveConfiguration: {
        ...signedLease.effectiveConfiguration,
        grants: {
          ...signedLease.effectiveConfiguration.grants,
          denied: ['tool:workspace.read'],
        },
      },
    },
    {
      ...signedLease,
      authorization: {
        ...signedLease.authorization,
        credentialVersion: state.credentialVersion + 1,
      },
    },
  ];

  for (const lease of tampered) {
    let resolverCalled = false;
    await assert.rejects(
      () => runOnce(executionClient(lease, state), {
        heartbeatIntervalMs: 0,
        adapterResolver: () => {
          resolverCalled = true;
          return { run: async () => ({ ok: true }) };
        },
      }),
      (error) => [
        'CAPABILITY_GRANT_DENIED',
        'EFFECTIVE_CONFIGURATION_INVALID',
        'LEASE_AUTHORIZATION_INVALID',
        'LEASE_CREDENTIAL_VERSION_STALE',
        'LEASE_WORKSPACE_MISMATCH',
      ].includes(error.code),
    );
    assert.equal(resolverCalled, false);
  }
});

test('Runner rejects wrong-Runner, wrong-Workspace, stale, and replayed lease bindings', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-binding-matrix';
  const baseState = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
  };
  const signedLease = authorizeLease(executableLease(now), {
    credential,
    runnerId: baseState.runnerId,
    workspaceId: baseState.workspaceId,
    credentialVersion: baseState.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const cases = [
    [{ ...baseState, runnerId: 'runner-foreign' }, signedLease, 'LEASE_RUNNER_MISMATCH'],
    [{ ...baseState, workspaceId: 'workspace-foreign' }, signedLease, 'LEASE_WORKSPACE_MISMATCH'],
    [
      baseState,
      authorizeLease(executableLease(now), {
        credential,
        runnerId: baseState.runnerId,
        workspaceId: baseState.workspaceId,
        credentialVersion: baseState.credentialVersion,
        issuedAt: new Date(now - 120_000).toISOString(),
        expiresAt: new Date(now - 60_000).toISOString(),
      }),
      'LEASE_AUTHORIZATION_STALE',
    ],
  ];

  for (const [state, lease, code] of cases) {
    let resolverCalled = false;
    await assert.rejects(
      () => runOnce(executionClient(lease, state), {
        heartbeatIntervalMs: 0,
        adapterResolver: () => {
          resolverCalled = true;
          return { run: async () => ({ ok: true }) };
        },
      }),
      (error) => error.code === code,
    );
    assert.equal(resolverCalled, false);
  }

  const replayClient = executionClient(signedLease, baseState);
  let adapterCalls = 0;
  const options = {
    heartbeatIntervalMs: 0,
    adapterResolver: () => ({
      run: async () => {
        adapterCalls += 1;
        return { ok: true };
      },
    }),
  };
  assert.equal((await runOnce(replayClient, options)).completed, true);
  await assert.rejects(
    () => runOnce(replayClient, options),
    (error) => error.code === 'LEASE_AUTHORIZATION_REPLAY',
  );
  assert.equal(adapterCalls, 1);
});

test('a valid Backend-authorized lease remains verifiable after Runner restart', async () => {
  const now = Date.now();
  const credential = 'runner-device-credential-restart';
  const persistedState = {
    runnerId: 'runner-authentic',
    workspaceId: 'workspace-authentic',
    credentialVersion: 4,
    deviceCredential: credential,
  };
  const signedLease = authorizeLease(executableLease(now), {
    credential,
    runnerId: persistedState.runnerId,
    workspaceId: persistedState.workspaceId,
    credentialVersion: persistedState.credentialVersion,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const restartedClient = executionClient(
    JSON.parse(JSON.stringify(signedLease)),
    JSON.parse(JSON.stringify(persistedState)),
  );
  let adapterCalls = 0;

  const result = await runOnce(restartedClient, {
    heartbeatIntervalMs: 0,
    adapterResolver: () => ({
      run: async () => {
        adapterCalls += 1;
        return { ok: true };
      },
    }),
  });

  assert.equal(result.completed, true);
  assert.equal(adapterCalls, 1);
  assert.equal(restartedClient.state.consumedLeaseAuthorizations.length, 1);

  const replayedAfterRestart = executionClient(
    JSON.parse(JSON.stringify(signedLease)),
    JSON.parse(JSON.stringify(restartedClient.state)),
  );
  await assert.rejects(
    () => runOnce(replayedAfterRestart, {
      heartbeatIntervalMs: 0,
      adapterResolver: () => ({
        run: async () => {
          adapterCalls += 1;
          return { ok: true };
        },
      }),
    }),
    (error) => error.code === 'LEASE_AUTHORIZATION_REPLAY',
  );
  assert.equal(adapterCalls, 1);
  assert.equal(replayedAfterRestart.state.consumedLeaseAuthorizations.length, 1);
});
