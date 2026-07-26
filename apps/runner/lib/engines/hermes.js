'use strict';

/**
 * Hermes Adapter — known safe profile form with -t safe --source tool.
 * Honest capability: no fabricated stream schema; batch result only.
 * Never yolo / one-shot bypass flags.
 */

const { assertSafeArgv, normalizeModelId, redactPrivatePaths } = require('./contract');
const { spawnSafe } = require('./spawn-safe');

const SECRET_RE = /sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+|HERMES_API_KEY\s*=\s*\S+/gi;

function buildHermesArgv({ sessionId, model } = {}) {
  const requestedModel = normalizeModelId(model);
  const args = [
    '--cli',
    ...(sessionId ? ['--resume', String(sessionId)] : []),
    ...(requestedModel ? ['--model', requestedModel] : []),
    '-t', 'safe',
  ];
  assertSafeArgv(args);
  return args;
}

function redact(text) {
  return redactPrivatePaths(
    String(text || '').replace(SECRET_RE, '[redacted]'),
  ).slice(0, 400);
}

function capabilityContract() {
  return {
    id: 'hermes',
    streaming: false,
    streamingSchema: null,
    status: 'limited',
    modelSelection: 'identifier',
    models: [],
    defaultModel: null,
    message: 'Hermes safe profile runs batch tool source; no stable stream schema claimed',
  };
}

async function probeHermes({ timeoutMs = 8_000 } = {}) {
  try {
    const result = await spawnSafe({
      command: 'hermes',
      args: ['--help'],
      timeoutMs,
    });
    const out = String(result.output || '').toLowerCase();
    if (result.code !== 0 && !out.includes('usage') && !out.includes('hermes')) {
      return {
        available: false,
        status: 'unavailable',
        message: 'hermes --help failed',
        ...capabilityContract(),
      };
    }
    return {
      available: true,
      status: 'limited',
      version: null,
      authStatus: 'unknown',
      message: capabilityContract().message,
      ...capabilityContract(),
    };
  } catch (error) {
    return {
      available: false,
      status: 'unavailable',
      message: error && error.code === 'ENGINE_UNAVAILABLE' ? 'hermes not installed' : String(error.message || error),
      ...capabilityContract(),
    };
  }
}

async function runHermes(input = {}) {
  const {
    goal, cwd, model, onCheckpoint, signal, timeoutMs = 180_000, providerSession,
  } = input;
  const requestedModel = normalizeModelId(model);
  const boundSessionId = providerSession?.externalSessionId || '';
  const args = buildHermesArgv({ sessionId: boundSessionId, model: requestedModel });
  const contract = capabilityContract();

  if (typeof onCheckpoint === 'function') {
    await onCheckpoint({
      phase: 'plan',
      text: `Hermes: ${contract.message}`,
      kind: 'checkpoint',
    });
  }

  try {
    const result = await spawnSafe({
      command: 'hermes',
      args,
      cwd,
      stdin: String(goal || ''),
      timeoutMs,
      signal,
    });
    const preview = redact(result.output);
    if (result.code !== 0) {
      return {
        ok: false,
        errorCode: 'hermes_exit',
        errorMessage: `hermes exited ${result.code}`,
        retryable: true,
        capability: contract,
      };
    }
    if (typeof onCheckpoint === 'function') {
      await onCheckpoint({
        phase: 'result',
        text: 'Hermes safe-profile execution completed',
        kind: 'checkpoint',
      });
    }
    return {
      ok: true,
      summary: 'Hermes execution completed (safe profile, batch)',
      ...(requestedModel ? { model: requestedModel } : {}),
      capability: contract,
      artifacts: preview ? [{ name: 'hermes-preview.txt', content: preview, contentType: 'text/plain' }] : [],
      resume: boundSessionId ? { sessionId: boundSessionId } : undefined,
    };
  } catch (error) {
    if (error && error.code === 'ENGINE_UNAVAILABLE') {
      return {
        ok: false,
        errorCode: 'unavailable',
        errorMessage: 'hermes not installed',
        retryable: false,
        capability: contract,
      };
    }
    if (error && error.code === 'CANCELLED') {
      return { ok: false, errorCode: 'cancelled', errorMessage: 'cancelled', retryable: false, capability: contract };
    }
    return {
      ok: false,
      errorCode: error.code || 'hermes_error',
      errorMessage: String(error.message || error).slice(0, 300),
      retryable: error.code === 'TIMEOUT',
      capability: contract,
    };
  }
}

module.exports = {
  id: 'hermes',
  buildArgv: buildHermesArgv,
  capabilityContract,
  probeHermes,
  run: runHermes,
};
