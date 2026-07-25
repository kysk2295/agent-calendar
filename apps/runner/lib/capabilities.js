'use strict';

/**
 * Independently probe Codex / Claude / Grok / Hermes on the host.
 * Production: spawn fixed argv, shell=false, strict time/output limits.
 * Tests: inject probeRunner.
 * Never use banned permission-bypass flags.
 */

const { spawn } = require('node:child_process');

const BANNED_ARGS = Object.freeze([
  '--yolo',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--approval-mode=yolo',
]);

const DEFAULT_PROBES = Object.freeze({
  codex: { command: 'codex', args: ['--version'], authArgs: ['login', 'status'] },
  claude: { command: 'claude', args: ['--version'], authArgs: ['auth', 'status'] },
  grok: { command: 'grok', args: ['--version'], authArgs: ['models'] },
  hermes: { command: 'hermes', args: ['--version'], authArgs: ['status'] },
});

function assertSafeArgs(args) {
  for (const arg of args || []) {
    const s = String(arg);
    for (const banned of BANNED_ARGS) {
      if (s === banned || s.includes(banned)) {
        const error = new Error(`banned launch arg refused: ${banned}`);
        error.code = 'BANNED_LAUNCH_ARGS';
        throw error;
      }
    }
  }
}

function runBoundedCommand({ command, args, timeoutMs, maxOutputBytes }) {
  assertSafeArgs(args);
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = Buffer.alloc(0);
    const onChunk = (chunk) => {
      if (out.length >= maxOutputBytes) return;
      out = Buffer.concat([out, chunk]).subarray(0, maxOutputBytes);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ code: null, output: '', timedOut: true, missing: false });
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        output: '',
        timedOut: false,
        missing: Boolean(error && error.code === 'ENOENT'),
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        output: out.toString('utf8').trim(),
        timedOut: false,
        missing: false,
      });
    });
  });
}

function interpretAuthProbe(engine, {
  code,
  output = '',
  timedOut = false,
  missing = false,
} = {}) {
  if (missing) return { authenticated: false, authStatus: 'missing' };
  if (timedOut) return { authenticated: false, authStatus: 'unknown' };
  const text = String(output || '').trim();
  if (code !== 0) return { authenticated: false, authStatus: 'missing' };

  let authenticated = false;
  if (engine === 'codex') {
    authenticated = /logged in|authenticated/i.test(text)
      && !/not logged|unauthenticated/i.test(text);
  } else if (engine === 'claude') {
    try {
      const parsed = JSON.parse(text);
      authenticated = parsed?.loggedIn === true || parsed?.authenticated === true;
    } catch {
      authenticated = /logged.?in|authenticated/i.test(text)
        && !/not logged|unauthenticated/i.test(text);
    }
  } else if (engine === 'grok') {
    authenticated = Boolean(text)
      && !/not logged|unauthenticated|login required|sign in/i.test(text);
  } else if (engine === 'hermes') {
    authenticated = /Provider:\s*\S+/i.test(text)
      && /(✓|\[ok\]).*(logged in|configured)|logged in.*(✓|\[ok\])/i.test(text);
  }

  return {
    authenticated,
    authStatus: authenticated ? 'authenticated' : 'missing',
  };
}

async function spawnProbe({
  engine,
  command,
  args,
  authArgs = [],
  timeoutMs = 2500,
  maxOutputBytes = 4096,
}) {
  const versionResult = await runBoundedCommand({
    command,
    args,
    timeoutMs,
    maxOutputBytes,
  });
  if (versionResult.missing) {
    return {
      installed: false,
      available: false,
      status: 'unavailable',
      version: null,
      authStatus: 'missing',
      message: `${command} not found on PATH. Install it on the Runner host.`,
    };
  }
  const versionMatch = versionResult.output.match(/v?\d+\.\d+(\.\d+)?/);
  const version = versionMatch
    ? versionMatch[0]
    : (versionResult.output.slice(0, 40) || null);
  if (versionResult.timedOut || versionResult.code !== 0) {
    return {
      installed: !versionResult.missing,
      available: false,
      status: 'unavailable',
      version,
      authStatus: 'unknown',
      message: versionResult.timedOut
        ? `${command} version probe timed out.`
        : `${command} version probe failed.`,
    };
  }

  assertSafeArgs(authArgs);
  const authResult = await runBoundedCommand({
    command,
    args: authArgs,
    timeoutMs: Math.max(timeoutMs, engine === 'grok' ? 10_000 : 5_000),
    maxOutputBytes,
  });
  const auth = interpretAuthProbe(engine, authResult);
  return {
    installed: true,
    available: auth.authenticated,
    status: auth.authenticated ? 'available' : 'auth_required',
    version,
    authStatus: auth.authStatus,
    message: auth.authenticated
      ? 'CLI installed and authentication verified on this Runner host.'
      : 'CLI installed, but authentication was not verified. Sign in on this Runner host.',
  };
}

/**
 * @param {{ probeRunner?: Function }} options
 */
async function probeAllEngines(options = {}) {
  const probeRunner = typeof options.probeRunner === 'function'
    ? options.probeRunner
    : spawnProbe;

  const engines = {};
  for (const [name, spec] of Object.entries(DEFAULT_PROBES)) {
    assertSafeArgs(spec.args);
    // eslint-disable-next-line no-await-in-loop
    engines[name] = await probeRunner({
      engine: name,
      command: spec.command,
      args: [...spec.args],
      authArgs: [...spec.authArgs],
      timeoutMs: options.timeoutMs || 2500,
    });
  }

  // Merge honest adapter capability contracts (streaming schema honesty for Grok/Hermes).
  try {
    const grok = require('./engines/grok');
    const hermes = require('./engines/hermes');
    const codex = require('./engines/codex');
    const claude = require('./engines/claude');
    const merge = (name, adapter) => {
      if (!engines[name] || typeof adapter.capabilityContract !== 'function') return;
      const contract = adapter.capabilityContract();
      engines[name] = {
        ...engines[name],
        ...contract,
        // If probe said available but contract is limited, surface limited status honestly.
        status: engines[name].available
          ? (contract.status || engines[name].status)
          : engines[name].status,
        message: engines[name].available
          ? (contract.message || engines[name].message)
          : engines[name].message,
        streaming: contract.streaming,
        streamingSchema: contract.streamingSchema,
      };
    };
    merge('grok', grok);
    merge('hermes', hermes);
    merge('codex', codex);
    merge('claude', claude);
  } catch {
    /* adapters optional during partial loads */
  }

  if (process.env.AGENT_CALENDAR_ALLOW_FAKE_ENGINE === '1') {
    engines.fake = {
      available: true,
      status: 'available',
      version: 'fake-1',
      authStatus: 'ok',
      message: 'Test-only Fake Engine Adapter',
      streaming: true,
      streamingSchema: 'fake-checkpoints',
    };
  }
  return {
    engines,
    reportedAt: new Date().toISOString(),
  };
}

module.exports = {
  BANNED_ARGS,
  DEFAULT_PROBES,
  assertSafeArgs,
  interpretAuthProbe,
  spawnProbe,
  probeAllEngines,
};
