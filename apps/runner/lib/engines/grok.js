'use strict';

/**
 * Grok Engine Adapter — honest limited capability contract.
 * No stable streaming schema is assumed; fail-closed on missing CLI / help/version.
 * Never invent progress events from opaque output.
 */

const { assertSafeArgv, redactPrivatePaths } = require('./contract');
const { spawnSafe } = require('./spawn-safe');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET_RE = /sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+|XAI_API_KEY\s*=\s*\S+/gi;

function buildGrokArgv({ promptFile, sessionId } = {}) {
  if (!promptFile) throw new Error('Grok prompt file is required');
  const args = [
    '--prompt-file', promptFile,
    ...(sessionId ? ['--resume', String(sessionId)] : []),
    '--output-format', 'json',
    '--permission-mode', 'default',
    '--no-subagents',
    '--disable-web-search',
  ];
  assertSafeArgv(args);
  return args;
}

function redact(text) {
  return redactPrivatePaths(
    String(text || '').replace(SECRET_RE, '[redacted]'),
  ).slice(0, 400);
}

function classifyExitFailure(output) {
  const text = String(output || '');
  if (/402|payment required|balance exhausted|quota exhausted/i.test(text)) {
    return {
      errorCode: 'quota_exhausted',
      errorMessage: 'Grok usage balance is exhausted on this Runner host. Add usage balance and retry.',
      retryable: false,
    };
  }
  if (/not logged|unauthenticated|login required|sign in/i.test(text)) {
    return {
      errorCode: 'auth_required',
      errorMessage: 'Grok authentication is required on this Runner host.',
      retryable: false,
    };
  }
  return {
    errorCode: 'grok_exit',
    errorMessage: 'Grok CLI exited before producing a result.',
    retryable: true,
  };
}

/**
 * Capability contract: streaming is not claimed without a stable schema.
 */
function capabilityContract() {
  return {
    id: 'grok',
    streaming: false,
    streamingSchema: null,
    status: 'limited',
    message: 'Grok CLI has no stable public streaming schema in Agent Calendar; batch result only when installed',
  };
}

async function probeGrok({ timeoutMs = 8_000 } = {}) {
  try {
    const result = await spawnSafe({
      command: 'grok',
      args: ['--help'],
      timeoutMs,
    });
    if (result.code !== 0 && !String(result.output || '').toLowerCase().includes('usage')) {
      return {
        available: false,
        status: 'unavailable',
        message: 'grok --help failed',
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
      message: error && error.code === 'ENGINE_UNAVAILABLE' ? 'grok not installed' : String(error.message || error),
      ...capabilityContract(),
    };
  }
}

async function runGrok(input = {}) {
  const { goal, cwd, onCheckpoint, signal, timeoutMs = 180_000, providerSession } = input;
  const contract = capabilityContract();
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-grok-'));
  const promptFile = path.join(promptDir, 'prompt.txt');
  fs.writeFileSync(promptFile, String(goal || ''), { mode: 0o600 });
  const boundSessionId = providerSession?.externalSessionId || '';
  const args = buildGrokArgv({ promptFile, sessionId: boundSessionId });

  if (typeof onCheckpoint === 'function') {
    await onCheckpoint({
      phase: 'plan',
      text: `Grok: ${contract.message}`,
      kind: 'checkpoint',
    });
  }

  try {
    const result = await spawnSafe({
      command: 'grok',
      args,
      cwd,
      timeoutMs,
      signal,
    });
    const preview = redact(result.output);
    if (result.code !== 0) {
      const failure = classifyExitFailure(result.output);
      return {
        ok: false,
        ...failure,
        capability: contract,
      };
    }
    if (typeof onCheckpoint === 'function') {
      // Honest: single result checkpoint, no fake mid-stream progress.
      await onCheckpoint({
        phase: 'result',
        text: preview ? 'Grok batch execution completed' : 'Grok finished with empty output',
        kind: 'checkpoint',
      });
    }
    return {
      ok: true,
      summary: 'Grok execution completed (batch, no stream schema)',
      capability: contract,
      artifacts: preview ? [{ name: 'grok-preview.txt', content: preview, contentType: 'text/plain' }] : [],
      resume: boundSessionId ? { sessionId: boundSessionId } : undefined,
    };
  } catch (error) {
    if (error && error.code === 'ENGINE_UNAVAILABLE') {
      return {
        ok: false,
        errorCode: 'unavailable',
        errorMessage: 'grok not installed or unsupported',
        retryable: false,
        capability: contract,
      };
    }
    if (error && error.code === 'CANCELLED') {
      return { ok: false, errorCode: 'cancelled', errorMessage: 'cancelled', retryable: false, capability: contract };
    }
    return {
      ok: false,
      errorCode: error.code || 'grok_error',
      errorMessage: String(error.message || error).slice(0, 300),
      retryable: error.code === 'TIMEOUT',
      capability: contract,
    };
  } finally {
    fs.rmSync(promptDir, { recursive: true, force: true });
  }
}

module.exports = {
  id: 'grok',
  buildArgv: buildGrokArgv,
  classifyExitFailure,
  capabilityContract,
  probeGrok,
  run: runGrok,
};
