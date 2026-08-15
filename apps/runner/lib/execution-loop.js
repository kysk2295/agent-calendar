'use strict';

/**
 * Durable execution loop: poll offer → lease → heartbeat while engine runs →
 * events/artifacts → complete/fail/cancel-ack.
 */

const { getEngineAdapter } = require('./engines');
const { assertAuthorizedLease, assertEffectiveConfiguration } = require('./capability-grants');
const { normalizeMaxConcurrentWork } = require('./capabilities');
const { listKnowledgeSources } = require('./store');
const { isFakeEngineAllowed } = require('./runtime-policy');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_CALENDAR_ATTEMPT_HEARTBEAT_MS || 15_000);
const OPAQUE_LOCAL_FOLDER_HANDLE = /^[A-Za-z][A-Za-z0-9_-]{7,199}$/;
const RAW_LOCAL_KEY = /^(?:path|cwd|root|wikiRoot|localPath|absolutePath)$/i;

function codedError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function stableWorkDirectory(client, lease) {
  if (!client.stateDir) {
    throw codedError('RUNNER_STATE_DIR_REQUIRED', 'workspace_general Work requires Runner state storage');
  }
  const workspaceKey = crypto.createHash('sha256')
    .update(String(lease.workspaceId || client.state?.workspaceId || 'workspace'))
    .digest('hex')
    .slice(0, 24);
  const workKey = crypto.createHash('sha256')
    .update(String(lease.jobId || lease.missionId || lease.attemptId))
    .digest('hex')
    .slice(0, 24);
  const directory = path.join(client.stateDir, 'execution-workspaces', workspaceKey, workKey);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  return fs.realpathSync(directory);
}

function resolveWorkingContext(client, offer, lease, legacyCwd) {
  const payload = offer?.payload && typeof offer.payload === 'object' ? offer.payload : {};
  const intake = payload.workIntake && typeof payload.workIntake === 'object'
    ? payload.workIntake
    : null;
  const context = intake?.workingContext;
  if (!context) {
    return { kind: 'legacy', cwd: legacyCwd };
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw codedError('WORKING_CONTEXT_INVALID', 'Working context is invalid');
  }
  for (const key of Object.keys(context)) {
    if (RAW_LOCAL_KEY.test(key)) {
      throw codedError(
        'WORKING_CONTEXT_RAW_PATH_FORBIDDEN',
        'Working context must not contain raw local coordinates',
      );
    }
  }
  if (context.kind === 'workspace_general') {
    return { kind: 'workspace_general', cwd: stableWorkDirectory(client, lease) };
  }
  if (context.kind !== 'local_folder') {
    throw codedError('WORKING_CONTEXT_INVALID', 'Working context kind is invalid');
  }
  const handle = String(context.handle || '').trim();
  if (!OPAQUE_LOCAL_FOLDER_HANDLE.test(handle)) {
    throw codedError('LOCAL_FOLDER_HANDLE_REQUIRED', 'Local folder Work requires an opaque handle');
  }
  if (!client.stateDir) {
    throw codedError('RUNNER_STATE_DIR_REQUIRED', 'Local folder Work requires Runner state storage');
  }
  const source = listKnowledgeSources(client.stateDir)
    .find((candidate) => candidate.sourceId === handle);
  if (!source) {
    throw codedError('LOCAL_FOLDER_HANDLE_NOT_FOUND', 'Local folder handle is not registered on this Runner');
  }
  const resolved = fs.realpathSync(source.path);
  if (!fs.statSync(resolved).isDirectory()) {
    throw codedError('LOCAL_FOLDER_HANDLE_NOT_DIRECTORY', 'Local folder handle is not a directory');
  }
  return {
    kind: 'local_folder',
    handle,
    cwd: resolved,
  };
}

function activeAttempts(client) {
  const attempts = client.state?.activeAttempts;
  const normalized = attempts && typeof attempts === 'object' && !Array.isArray(attempts)
    ? { ...attempts }
    : {};
  const legacy = client.state?.activeAttempt;
  if (legacy?.attemptId && !normalized[legacy.attemptId]) {
    normalized[legacy.attemptId] = legacy;
  }
  return normalized;
}

function persistActiveAttempt(client, attempt) {
  const attempts = activeAttempts(client);
  for (const [attemptId, current] of Object.entries(attempts)) {
    if (attemptId !== attempt.attemptId && current?.jobId === attempt.jobId) {
      delete attempts[attemptId];
    }
  }
  attempts[attempt.attemptId] = attempt;
  client.persist({
    activeAttempts: attempts,
    activeAttempt: attempt,
  });
}

function updateActiveAttempt(client, attemptId, patchValue) {
  const attempts = activeAttempts(client);
  if (!attempts[attemptId]) return;
  attempts[attemptId] = { ...attempts[attemptId], ...patchValue };
  client.persist({
    activeAttempts: attempts,
    activeAttempt: client.state?.activeAttempt?.attemptId === attemptId
      ? attempts[attemptId]
      : client.state?.activeAttempt || attempts[attemptId],
  });
}

function clearActiveAttempt(client, attemptId) {
  const attempts = activeAttempts(client);
  delete attempts[attemptId];
  const remaining = Object.values(attempts);
  client.persist({
    activeAttempts: attempts,
    activeAttempt: remaining.length ? remaining[remaining.length - 1] : null,
  });
}

async function restoreCapturedProviderSession(client) {
  let restored = false;
  for (const attempt of Object.values(activeAttempts(client))) {
    const providerSession = attempt?.providerSession;
    if (!providerSession?.id || !providerSession?.externalSessionId) continue;
    // eslint-disable-next-line no-await-in-loop
    await client.deviceRequest('POST', '/api/runner/device/provider-session/bind', {
      providerSessionId: providerSession.id,
      externalSessionId: providerSession.externalSessionId,
    });
    updateActiveAttempt(client, attempt.attemptId, { providerSession: null });
    restored = true;
  }
  return restored;
}

async function runSingle(client, {
  env = {},
  forceCrash = false,
  forceFail = false,
  longRunMs = 0,
  cwd = process.cwd(),
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  adapterResolver = getEngineAdapter,
} = {}) {
  const offerRes = await client.deviceRequest('POST', '/api/runner/device/next-offer', {});
  if (!offerRes.offer) {
    return { ok: true, idle: true, reason: offerRes.reason || 'no_offer' };
  }
  const offer = offerRes.offer;
  const leaseRes = await client.deviceRequest('POST', '/api/runner/device/lease', {
    offerId: offer.offerId,
  });
  const lease = leaseRes.lease;
  if (String(lease.engine || '').toLowerCase() === 'fake' && !isFakeEngineAllowed(env)) {
    const error = new Error('fake engine not allowed outside explicit tests');
    error.code = 'FAKE_ENGINE_FORBIDDEN';
    throw error;
  }
  assertEffectiveConfiguration(lease.effectiveConfiguration);
  const consumedLeaseAuthorization = assertAuthorizedLease(lease, client.state);
  const attempt = {
    attemptId: lease.attemptId,
    jobId: lease.jobId,
    leaseEpoch: lease.leaseEpoch,
    engine: lease.engine,
    requestedModel: String(lease.requestedModel || ''),
    missionId: lease.missionId,
    sessionId: lease.sessionId,
    providerSession: lease.providerSession?.id && lease.providerSession?.externalSessionId
      ? {
        id: lease.providerSession.id,
        externalSessionId: lease.providerSession.externalSessionId,
      }
      : null,
  };
  client.persist({
    consumedLeaseAuthorizations: [
      ...(Array.isArray(client.state?.consumedLeaseAuthorizations)
        ? client.state.consumedLeaseAuthorizations
        : []),
      consumedLeaseAuthorization,
    ].slice(-128),
  });
  persistActiveAttempt(client, attempt);

  const adapter = adapterResolver(lease.engine, { env });
  const controller = new AbortController();
  let heartbeatTimer = null;
  let heartbeatChain = Promise.resolve();
  let cancelAcked = false;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const runHeartbeat = () => {
    heartbeatChain = heartbeatChain.then(async () => {
      if (controller.signal.aborted || cancelAcked) return;
      const hb = await client.deviceRequest('POST', '/api/runner/device/attempt-heartbeat', {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
      });
      if (hb && hb.cancellationRequested) {
        controller.abort();
      }
    }).catch(() => {
      /* heartbeat failures do not crash the loop immediately; engine may still fail/complete */
    });
    return heartbeatChain;
  };

  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => { void runHeartbeat(); }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  try {
    // Initial heartbeat immediately after lease.
    await runHeartbeat();

    const workingContext = resolveWorkingContext(client, offer, lease, cwd);
    const result = await adapter.run({
      goal: lease.goal,
      model: lease.requestedModel || '',
      cwd: workingContext.cwd,
      workingContext: workingContext.kind === 'local_folder'
        ? { kind: workingContext.kind, handle: workingContext.handle }
        : { kind: workingContext.kind },
      jobPayload: offer.payload && typeof offer.payload === 'object' ? offer.payload : {},
      providerSession: lease.providerSession || offer.providerSession || null,
      knowledgeSources: client.stateDir
        ? listKnowledgeSources(client.stateDir)
        : (Array.isArray(client.state?.knowledgeSources) ? client.state.knowledgeSources : []),
      signal: controller.signal,
      forceCrash,
      forceFail,
      longRunMs,
      onCheckpoint: async (event) => {
        const externalSessionId = String(event.providerSession?.externalSessionId || '').slice(0, 200);
        if (lease.providerSession?.id && externalSessionId) {
          const providerSession = {
            id: lease.providerSession.id,
            externalSessionId,
          };
          updateActiveAttempt(client, lease.attemptId, { providerSession });
          await client.deviceRequest('POST', '/api/runner/device/provider-session/bind', {
            providerSessionId: providerSession.id,
            externalSessionId: providerSession.externalSessionId,
          });
        }
        await client.deviceRequest('POST', '/api/runner/device/event', {
          attemptId: lease.attemptId,
          leaseEpoch: lease.leaseEpoch,
          kind: event.kind || 'checkpoint',
          phase: event.phase || 'progress',
          text: event.text || '',
          idempotencyKey: `cp:${event.phase}:${String(event.text || '').slice(0, 40)}`,
          payload: { phase: event.phase },
        });
      },
    });

    clearHeartbeat();
    await heartbeatChain;

    // If cancel was requested during run, ack cancel — do not complete.
    const finalHb = await client.deviceRequest('POST', '/api/runner/device/attempt-heartbeat', {
      attemptId: lease.attemptId,
      leaseEpoch: lease.leaseEpoch,
    }).catch(() => null);
    if (finalHb && finalHb.cancellationRequested) {
      await client.deviceRequest('POST', '/api/runner/device/cancel-ack', {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
      });
      cancelAcked = true;
      clearActiveAttempt(client, lease.attemptId);
      return { ok: true, cancelled: true, lease };
    }

    if (result && result.errorCode === 'cancelled') {
      // Engine aborted; only cancel-ack when server requested cancel.
      const check = await client.deviceRequest('POST', '/api/runner/device/attempt-heartbeat', {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
      }).catch(() => null);
      if (check && check.cancellationRequested) {
        await client.deviceRequest('POST', '/api/runner/device/cancel-ack', {
          attemptId: lease.attemptId,
          leaseEpoch: lease.leaseEpoch,
        });
        cancelAcked = true;
        clearActiveAttempt(client, lease.attemptId);
        return { ok: true, cancelled: true, lease };
      }
    }

    if (result.artifacts && result.artifacts.length) {
      for (const art of result.artifacts) {
        // eslint-disable-next-line no-await-in-loop
        await client.deviceRequest('POST', '/api/runner/device/artifact', {
          attemptId: lease.attemptId,
          leaseEpoch: lease.leaseEpoch,
          name: art.name,
          content: art.content,
          contentType: art.contentType || 'text/plain',
          idempotencyKey: `art:${art.name}`,
        });
      }
    }

    if (!result.ok) {
      const failedExternalSessionId = result.resume?.sessionId || result.resume?.threadId
        || lease.providerSession?.externalSessionId || '';
      await client.deviceRequest('POST', '/api/runner/device/fail', {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        errorCode: result.errorCode || 'execution_failed',
        errorMessage: result.errorMessage || 'failed',
        retryable: result.retryable !== false,
        ...(lease.providerSession?.id ? {
          providerSession: {
            id: lease.providerSession.id,
            externalSessionId: failedExternalSessionId,
          },
        } : {}),
      });
      clearActiveAttempt(client, lease.attemptId);
      return { ok: false, failed: true, lease, result };
    }

    const externalSessionId = result.resume?.sessionId || result.resume?.threadId
      || lease.providerSession?.externalSessionId || '';
    await client.deviceRequest('POST', '/api/runner/device/complete', {
      attemptId: lease.attemptId,
      leaseEpoch: lease.leaseEpoch,
      summary: result.summary || 'completed',
      resolvedModel: result.model || '',
      idempotencyKey: 'terminal:complete',
      ...(lease.providerSession?.id ? {
        providerSession: {
          id: lease.providerSession.id,
          externalSessionId,
        },
      } : {}),
    });
    clearActiveAttempt(client, lease.attemptId);
    return { ok: true, completed: true, lease, result };
  } catch (error) {
    clearHeartbeat();
    try { await heartbeatChain; } catch { /* ignore */ }

    if (error && error.code === 'FORCED_CRASH') {
      return { ok: false, crashed: true, lease };
    }

    // Cancellation abort path
    if (error && (error.code === 'CANCELLED' || controller.signal.aborted)) {
      try {
        const check = await client.deviceRequest('POST', '/api/runner/device/attempt-heartbeat', {
          attemptId: lease.attemptId,
          leaseEpoch: lease.leaseEpoch,
        });
        if (check && check.cancellationRequested) {
          await client.deviceRequest('POST', '/api/runner/device/cancel-ack', {
            attemptId: lease.attemptId,
            leaseEpoch: lease.leaseEpoch,
          });
          cancelAcked = true;
          clearActiveAttempt(client, lease.attemptId);
          return { ok: true, cancelled: true, lease };
        }
      } catch {
        /* fall through to fail */
      }
    }

    try {
      await client.deviceRequest('POST', '/api/runner/device/fail', {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        errorCode: error.code || 'execution_error',
        errorMessage: String(error.message || error).slice(0, 300),
        retryable: true,
      });
    } catch {
      // ignore
    }
    clearActiveAttempt(client, lease.attemptId);
    return { ok: false, error: error.code || error.message, lease };
  } finally {
    clearHeartbeat();
  }
}

async function runOnce(client, options = {}) {
  await restoreCapturedProviderSession(client);
  const capacity = normalizeMaxConcurrentWork(
    options.maxConcurrentWork === undefined ? options.env : options.maxConcurrentWork,
  );
  if (capacity === 1) {
    return runSingle(client, options);
  }
  const results = await Promise.all(
    Array.from({ length: capacity }, () => runSingle(client, options)),
  );
  return {
    ok: results.every((result) => result.ok),
    capacity,
    completed: results.some((result) => result.completed),
    completedCount: results.filter((result) => result.completed).length,
    idle: results.every((result) => result.idle),
    results,
  };
}

/**
 * Attach deviceRequest helper onto RunnerClient if missing.
 */
function ensureDeviceRequest(client) {
  if (typeof client.deviceRequest === 'function') return client;
  client.deviceRequest = async function deviceRequest(method, urlPath, body = {}) {
    const {
      bodySha256,
      deviceTranscript,
      newNonce,
      sign,
    } = require('./crypto');
    const runnerId = this.state.runnerId;
    const credential = this.state.deviceCredential;
    if (!runnerId || !credential) {
      throw Object.assign(new Error('device not claimed'), { code: 'DEVICE_NOT_CLAIMED' });
    }
    const timestampMs = this.clock();
    const nonce = newNonce();
    const sessionId = this.state.sessionId || '';
    const cursor = this.state.cursor != null ? this.state.cursor : '';
    const payload = { ...body, runnerId };
    const bodyHash = bodySha256(payload);
    const transcript = deviceTranscript({
      method,
      path: urlPath,
      bodyHash,
      timestampMs,
      nonce,
      runnerId,
      sessionId,
      cursor,
    });
    const signature = sign(this.identity.privateKey, transcript);
    const headers = {
      'x-runner-id': runnerId,
      'x-runner-timestamp': String(timestampMs),
      'x-runner-nonce': nonce,
      'x-runner-session': sessionId,
      'x-runner-cursor': cursor === '' ? '' : String(cursor),
      'x-runner-credential': credential,
      'x-runner-signature': signature,
    };
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400 || !json.ok) {
      const err = new Error(json.error || 'device_request_failed');
      err.code = json.error || 'device_request_failed';
      err.status = res.status;
      throw err;
    }
    return json;
  };
  return client;
}

module.exports = {
  runOnce,
  restoreCapturedProviderSession,
  ensureDeviceRequest,
  HEARTBEAT_INTERVAL_MS,
};
