'use strict';

const { spawn } = require('node:child_process');
const { assertSafeArgv } = require('./contract');

/**
 * Spawn fixed argv with shell:false, time/output limits, process-tree cancel.
 * Line callbacks are ordered and fully awaited before resolve/reject so adapters
 * cannot race terminal completion with pending checkpoint posts.
 */
function spawnSafe({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = 120_000,
  maxOutputBytes = 256_000,
  maxLineBytes = 16_000,
  stdin = null,
  signal = null,
  onStdoutLine = null,
  onStderrLine = null,
}) {
  assertSafeArgv(args);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      shell: false,
      cwd: cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = Buffer.alloc(0);
    let stdoutCarry = '';
    let stderrCarry = '';
    /** @type {Promise<void>} */
    let callbackChain = Promise.resolve();
    let callbackFailed = null;

    const enqueueCallback = (fn, line) => {
      if (typeof fn !== 'function' || callbackFailed) return;
      callbackChain = callbackChain.then(async () => {
        if (callbackFailed) return;
        await fn(line);
      }).catch((error) => {
        if (!callbackFailed) callbackFailed = error instanceof Error ? error : new Error(String(error));
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      });
    };

    const pushLine = (carry, chunk, onLine) => {
      const text = carry + chunk.toString('utf8');
      const parts = text.split('\n');
      const nextCarry = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.length > maxLineBytes ? line.slice(0, maxLineBytes) : line;
        if (trimmed.length) enqueueCallback(onLine, trimmed);
      }
      return nextCarry.length > maxLineBytes ? nextCarry.slice(-maxLineBytes) : nextCarry;
    };

    const onChunk = (stream, chunk) => {
      if (out.length < maxOutputBytes) {
        out = Buffer.concat([out, chunk]).subarray(0, maxOutputBytes);
      }
      if (stream === 'stdout') {
        stdoutCarry = pushLine(stdoutCarry, chunk, onStdoutLine);
      } else {
        stderrCarry = pushLine(stderrCarry, chunk, onStderrLine);
      }
    };
    child.stdout.on('data', (chunk) => onChunk('stdout', chunk));
    child.stderr.on('data', (chunk) => onChunk('stderr', chunk));
    if (stdin != null) {
      child.stdin.write(String(stdin));
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const finish = async (builder) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutCarry && typeof onStdoutLine === 'function') {
        enqueueCallback(onStdoutLine, stdoutCarry.slice(0, maxLineBytes));
        stdoutCarry = '';
      }
      if (stderrCarry && typeof onStderrLine === 'function') {
        enqueueCallback(onStderrLine, stderrCarry.slice(0, maxLineBytes));
        stderrCarry = '';
      }
      try {
        await callbackChain;
      } catch {
        /* chain stores failure */
      }
      if (callbackFailed) {
        reject(callbackFailed);
        return;
      }
      builder();
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      void finish(() => {
        const err = new Error(`timeout after ${timeoutMs}ms`);
        err.code = 'TIMEOUT';
        reject(err);
      });
    }, timeoutMs);

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      void finish(() => {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        reject(err);
      });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      void finish(() => {
        if (error && error.code === 'ENOENT') {
          const err = new Error(`${command} not found`);
          err.code = 'ENGINE_UNAVAILABLE';
          reject(err);
          return;
        }
        reject(error);
      });
    });
    child.on('close', (code) => {
      void finish(() => {
        resolve({
          code,
          output: out.toString('utf8'),
        });
      });
    });
  });
}

module.exports = {
  spawnSafe,
};
