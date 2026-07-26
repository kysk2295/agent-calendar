'use strict';

/**
 * Durable execution loop: poll offer → lease → heartbeat while engine runs →
 * events/artifacts → complete/fail/cancel-ack.
 */

const { getEngineAdapter } = require('./engines');
const { listKnowledgeSources } = require('./store');

const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_CALENDAR_ATTEMPT_HEARTBEAT_MS || 15_000);

async function restoreCapturedProviderSession(client) {
  const activeAttempt = client.state?.activeAttempt;
  const providerSession = activeAttempt?.providerSession;
  if (!providerSession?.id || !providerSession?.externalSessionId) return false;
  await client.deviceRequest('POST', '/api/runner/device/provider-session/bind', {
    providerSessionId: providerSession.id,
    externalSessionId: providerSession.externalSessionId,
  });
  client.persist({
    activeAttempt: {
      ...activeAttempt,
      providerSession: null,
    },
  });
  return true;
}

async function runOnce(client, {
  allowFake = false,
  forceCrash = false,
  forceFail = false,
  longRunMs = 0,
  cwd = process.cwd(),
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  adapterResolver = getEngineAdapter,
} = {}) {
  await restoreCapturedProviderSession(client);
  const offerRes = await client.deviceRequest('POST', '/api/runner/device/next-offer', {});
  if (!offerRes.offer) {
    return { ok: true, idle: true, reason: offerRes.reason || 'no_offer' };
  }
  const offer = offerRes.offer;
  const leaseRes = await client.deviceRequest('POST', '/api/runner/device/lease', {
    offerId: offer.offerId,
  });
  const lease = leaseRes.lease;
  client.persist({
    activeAttempt: {
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
    },
  });

  const adapter = adapterResolver(lease.engine, { allowFake: allowFake || lease.engine === 'fake' });
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

    const result = await adapter.run({
      goal: lease.goal,
      model: lease.requestedModel || '',
      cwd,
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
          client.persist({
            activeAttempt: {
              ...client.state.activeAttempt,
              providerSession,
            },
          });
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
      client.persist({ activeAttempt: null });
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
        client.persist({ activeAttempt: null });
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
      client.persist({ activeAttempt: null });
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
    client.persist({ activeAttempt: null });
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
          client.persist({ activeAttempt: null });
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
    client.persist({ activeAttempt: null });
    return { ok: false, error: error.code || error.message, lease };
  } finally {
    clearHeartbeat();
  }
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
