'use strict';

/**
 * Deterministic Fake Engine Adapter — injected only by tests.
 * Emits plan/progress/artifact/result checkpoints through the real Runner loop.
 */

const { assertSafeArgv } = require('./contract');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFakeEngine(input = {}) {
  const {
    goal = 'fake work',
    onCheckpoint,
    signal,
    forceCrash = false,
    forceFail = false,
    stepDelayMs = Number(process.env.AGENT_CALENDAR_FAKE_ENGINE_STEP_MS || 1200),
    /** Hold mid-run so heartbeat can extend lease / cancel can abort (ms). */
    longRunMs = 0,
  } = input;

  assertSafeArgv([]);

  const emit = async (phase, text, extra = {}) => {
    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      throw err;
    }
    if (typeof onCheckpoint === 'function') {
      await onCheckpoint({ phase, text, kind: phase, ...extra });
    }
    if (stepDelayMs > 0) await delay(stepDelayMs);
  };

  await emit('plan', `Plan: execute delegated work — ${String(goal).slice(0, 120)}`);
  await emit('progress', 'Progress: starting fake engine steps');

  if (forceCrash) {
    const err = new Error('forced crash');
    err.code = 'FORCED_CRASH';
    err.retryable = true;
    throw err;
  }

  // Long-run window: poll abort for cancel tests and lease survival via heartbeat.
  if (longRunMs > 0) {
    const deadline = Date.now() + Number(longRunMs);
    while (Date.now() < deadline) {
      if (signal && signal.aborted) {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      await delay(Math.min(200, deadline - Date.now()));
    }
  }

  await emit('progress', 'Progress: mid-work checkpoint');
  const artifact = {
    name: 'fake-result.md',
    content: `# Fake result\n\nGoal: ${goal}\nStatus: ok\n`,
    contentType: 'text/markdown',
  };
  await emit('artifact', `Artifact ready: ${artifact.name}`, { artifactName: artifact.name });

  if (forceFail) {
    return {
      ok: false,
      errorCode: 'forced_fail',
      errorMessage: 'forced failure',
      retryable: false,
      artifacts: [artifact],
    };
  }

  await emit('result', `Completed fake execution for: ${String(goal).slice(0, 160)}`);
  return {
    ok: true,
    summary: `Completed: ${String(goal).slice(0, 200)}`,
    artifacts: [artifact],
  };
}

module.exports = {
  id: 'fake',
  run: runFakeEngine,
};
