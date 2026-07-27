'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BANNED_FLAGS,
  assertSafeArgv,
  normalizeModelId,
} = require('../lib/engines/contract');
const codex = require('../lib/engines/codex');
const claude = require('../lib/engines/claude');
const hermes = require('../lib/engines/hermes');
const grok = require('../lib/engines/grok');
const fake = require('../lib/engines/fake');
const { spawnSafe } = require('../lib/engines/spawn-safe');
const {
  DEFAULT_PROBES,
  extractConfiguredModel,
  interpretAuthProbe,
  probeAllEngines,
} = require('../lib/capabilities');
const { getEngineAdapter } = require('../lib/engines');

test('banned flags rejected for all adapters argv builders', () => {
  assert.throws(() => assertSafeArgv(['--yolo']), /banned/);
  assert.throws(() => assertSafeArgv(['--dangerously-bypass-approvals-and-sandbox']), /banned/);
  assert.throws(() => assertSafeArgv(['--dangerously-skip-permissions']), /banned/);
  assert.throws(() => assertSafeArgv(['--full-auto']), /banned/);
  assert.ok(BANNED_FLAGS.length >= 4);
});

test('codex argv is safe sandbox workspace-write', () => {
  const args = codex.buildArgv({ cwd: '/tmp/work' });
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('workspace-write'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args.includes('--yolo'), false);
  assertSafeArgv(args);
});

test('Codex adapter reports only a bounded configured default model', () => {
  const model = codex.configuredCodexModel();
  assert.match(model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$|^$/);
});

test('claude argv uses stream-json with safe permission mode', () => {
  const args = claude.buildArgv();
  assertSafeArgv(args);
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('default'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('provider adapters explicitly resume the exact bound provider session', () => {
  const codexArgs = codex.buildArgv({ cwd: '/tmp/work', sessionId: 'codex-session-1' });
  assert.deepEqual(codexArgs.slice(-3), ['resume', 'codex-session-1', '-']);
  assert.ok(codexArgs.indexOf('--sandbox') < codexArgs.indexOf('resume'));
  assert.ok(codexArgs.includes('-'));
  assert.ok(codexArgs.includes('--json'));

  const claudeArgs = claude.buildArgv({ sessionId: '00000000-0000-4000-8000-000000000001' });
  assert.ok(claudeArgs.includes('--resume'));
  assert.ok(claudeArgs.includes('00000000-0000-4000-8000-000000000001'));

  const grokArgs = grok.buildArgv({
    promptFile: '/tmp/runner-prompt.txt',
    sessionId: '00000000-0000-4000-8000-000000000002',
  });
  assert.ok(grokArgs.includes('--resume'));
  assert.ok(grokArgs.includes('00000000-0000-4000-8000-000000000002'));

  const hermesArgs = hermes.buildArgv({ sessionId: 'hermes-session-1' });
  assert.ok(hermesArgs.includes('--resume'));
  assert.ok(hermesArgs.includes('hermes-session-1'));
});

test('provider adapters bind the exact requested model without treating it as argv', () => {
  assert.equal(normalizeModelId('gpt-5.6-codex'), 'gpt-5.6-codex');
  assert.equal(normalizeModelId('anthropic/claude-sonnet-4-6'), 'anthropic/claude-sonnet-4-6');
  assert.throws(() => normalizeModelId('--dangerously-skip-permissions'), /model/i);
  assert.throws(() => normalizeModelId('gpt-5; rm -rf work'), /model/i);
  assert.throws(() => normalizeModelId('sk-secret-token-value'), /model/i);

  const codexArgs = codex.buildArgv({ cwd: '/tmp/work', model: 'gpt-5.6-codex' });
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf('--model'), codexArgs.indexOf('--model') + 2), [
    '--model',
    'gpt-5.6-codex',
  ]);

  const claudeArgs = claude.buildArgv({ model: 'claude-sonnet-4-6' });
  assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf('--model'), claudeArgs.indexOf('--model') + 2), [
    '--model',
    'claude-sonnet-4-6',
  ]);

  const grokArgs = grok.buildArgv({
    promptFile: '/tmp/runner-prompt.txt',
    model: 'grok-code-fast-1',
  });
  assert.deepEqual(grokArgs.slice(grokArgs.indexOf('--model'), grokArgs.indexOf('--model') + 2), [
    '--model',
    'grok-code-fast-1',
  ]);

  const hermesArgs = hermes.buildArgv({ model: 'openai/gpt-5.5' });
  assert.deepEqual(hermesArgs.slice(hermesArgs.indexOf('--model'), hermesArgs.indexOf('--model') + 2), [
    '--model',
    'openai/gpt-5.5',
  ]);
});

test('installed engine probes require an explicit authenticated signal', () => {
  assert.deepEqual(DEFAULT_PROBES.codex.authArgs, ['login', 'status']);
  assert.deepEqual(DEFAULT_PROBES.claude.authArgs, ['auth', 'status']);
  assert.deepEqual(DEFAULT_PROBES.grok.authArgs, ['models']);
  assert.deepEqual(DEFAULT_PROBES.hermes.authArgs, ['status']);

  assert.equal(interpretAuthProbe('codex', { code: 0, output: 'Logged in using ChatGPT' }).authenticated, true);
  assert.equal(interpretAuthProbe('codex', { code: 0, output: 'Not logged in' }).authenticated, false);
  assert.equal(interpretAuthProbe('claude', { code: 0, output: '{"loggedIn":true}' }).authenticated, true);
  assert.equal(interpretAuthProbe('claude', { code: 0, output: '{"loggedIn":false}' }).authenticated, false);
  assert.equal(interpretAuthProbe('grok', { code: 0, output: 'grok-4\\ngrok-code-fast-1' }).authenticated, true);
  assert.equal(interpretAuthProbe('grok', { code: 1, output: 'Login required' }).authenticated, false);
  assert.equal(
    interpretAuthProbe('hermes', {
      code: 0,
      output: 'Provider: OpenAI Codex\\nOpenAI Codex  ✓ logged in',
    }).authenticated,
    true,
  );
  assert.equal(
    interpretAuthProbe('hermes', {
      code: 0,
      output: 'Provider: OpenAI Codex\\nOpenAI Codex  ✗ not logged in',
    }).authenticated,
    false,
  );
});

test('Runner publishes only a bounded public model id from local Codex configuration', () => {
  assert.equal(extractConfiguredModel('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"'), 'gpt-5.6-sol');
  assert.equal(extractConfiguredModel('model = "unsafe value --flag"'), '');
  assert.equal(extractConfiguredModel('OPENAI_API_KEY = "secret"'), '');
});

test('current Grok and Hermes argv use supported safe non-interactive forms', () => {
  const grokArgs = grok.buildArgv({ promptFile: '/tmp/runner-prompt.txt' });
  assertSafeArgv(grokArgs);
  assert.ok(grokArgs.includes('--prompt-file'));
  assert.ok(grokArgs.includes('--output-format'));
  assert.ok(grokArgs.includes('json'));
  assert.ok(grokArgs.includes('--no-subagents'));
  assert.equal(grokArgs.includes('--prompt'), false);
  assert.equal(grokArgs.includes('--always-approve'), false);

  const hermesArgs = hermes.buildArgv();
  assertSafeArgv(hermesArgs);
  assert.ok(hermesArgs.includes('--cli'));
  assert.ok(hermesArgs.includes('safe'));
  assert.equal(hermesArgs.includes('--source'), false);
  assert.equal(hermesArgs.includes('--yolo'), false);
});

test('Grok live failures distinguish exhausted usage from retryable CLI exits', () => {
  assert.deepEqual(
    grok.classifyExitFailure('API error (status 402 Payment Required): Grok Build usage balance exhausted'),
    {
      errorCode: 'quota_exhausted',
      errorMessage: 'Grok usage balance is exhausted on this Runner host. Add usage balance and retry.',
      retryable: false,
    },
  );
  assert.deepEqual(
    grok.classifyExitFailure('temporary upstream error'),
    {
      errorCode: 'grok_exit',
      errorMessage: 'Grok CLI exited before producing a result.',
      retryable: true,
    },
  );
});

test('codex real-schema fixtures: thread.started, item.completed nested, turn.completed usage', () => {
  const started = codex.parseCodexJsonlLine(JSON.stringify({
    type: 'thread.started',
    thread_id: 'thr_real_1',
  }));
  assert.equal(started.kind, 'plan');
  assert.equal(started.threadId, 'thr_real_1');

  const item = codex.parseCodexJsonlLine(JSON.stringify({
    type: 'item.completed',
    thread_id: 'thr_real_1',
    item: { type: 'agent_message', text: 'assistant says hello sk-abcdefghijklmnopqrstuvwxyz123456' },
  }));
  assert.equal(item.kind, 'progress');
  assert.match(item.assistantText || item.text, /hello/);
  assert.doesNotMatch(item.text, /sk-abcdefghijklmnopqrstuvwxyz/);

  const tool = codex.parseCodexJsonlLine(JSON.stringify({
    type: 'item.completed',
    thread_id: 'thr_real_1',
    item: {
      type: 'command_execution',
      command: 'cat /Users/alice/private/token.txt',
      aggregated_output: 'sk-must-not-leak',
      exit_code: 0,
    },
  }));
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.threadId, 'thr_real_1');
  assert.match(tool.text, /명령 실행/);
  assert.doesNotMatch(tool.text, /cat|Users|alice|token|sk-/i);

  const turn = codex.parseCodexJsonlLine(JSON.stringify({
    type: 'turn.completed',
    thread_id: 'thr_real_1',
    usage: { input_tokens: 10, output_tokens: 20 },
    summary: 'final answer',
  }));
  assert.equal(turn.kind, 'result');
  assert.equal(turn.usage.input_tokens, 10);
  assert.equal(turn.threadId, 'thr_real_1');

  assert.equal(codex.parseCodexJsonlLine(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'error',
      message: 'Ignoring malformed agent role definition at /Users/alice/private/agent.toml',
    },
  })), null);
  assert.equal(codex.parseCodexJsonlLine(JSON.stringify({
    type: 'turn.started',
  })), null);

  assert.equal(codex.parseCodexJsonlLine('{bad').kind, 'malformed');
});

test('Engine checkpoint and artifact text never exposes a host user path', () => {
  const codexItem = codex.parseCodexJsonlLine(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Could not read /Users/alice/private/project/config.json',
    },
  }));
  assert.doesNotMatch(codexItem.text, /Users|alice|private\/project/);

  const claudeItem = claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Could not read /home/bob/private/project/config.json' }],
    },
  }));
  assert.doesNotMatch(claudeItem.text, /home|bob|private\/project/);
});

test('public completion checkpoints omit provider thread and session identifiers', () => {
  assert.equal(codex.completionCheckpointText('thread-private-123'), 'Codex execution completed');
  assert.equal(claude.completionCheckpointText('session-private-456'), 'Claude execution completed');
});

test('Claude final text does not duplicate the same assistant content repeated by the result event', () => {
  assert.equal(claude.appendNonDuplicateText('', 'COMPARISON_OK'), 'COMPARISON_OK');
  assert.equal(claude.appendNonDuplicateText('COMPARISON_OK', 'COMPARISON_OK'), 'COMPARISON_OK');
  assert.equal(claude.appendNonDuplicateText('first ', 'second'), 'first second');
});

test('claude real-schema fixtures: system, assistant, content_block_delta, result', () => {
  assert.equal(claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'c-sess',
  })).kind, 'plan');
  assert.equal(claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'system',
    subtype: 'hook_started',
    session_id: 'c-sess',
  })), null);
  assert.equal(claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'rate_limit_event',
    session_id: 'c-sess',
  })), null);

  const asst = claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'assistant',
    session_id: 'c-sess',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hi ANTHROPIC_API_KEY=supersecret' }],
    },
  }));
  assert.equal(asst.kind, 'progress');
  assert.equal(asst.model, 'claude-sonnet-4-6');
  assert.doesNotMatch(asst.text, /supersecret/);

  const tool = claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'assistant',
    session_id: 'c-sess',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/Users/alice/private/token.txt' },
      }],
    },
  }));
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.sessionId, 'c-sess');
  assert.equal(tool.text, 'Claude 도구 · Read');
  assert.doesNotMatch(tool.text, /Users|alice|private|token/i);

  const delta = claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'content_block_delta',
    session_id: 'c-sess',
    delta: { text: ' world' },
  }));
  assert.equal(delta.kind, 'progress');

  const result = claude.parseClaudeStreamJsonLine(JSON.stringify({
    type: 'result',
    session_id: 'c-sess',
    result: 'done',
  }));
  assert.equal(result.kind, 'result');
  assert.equal(claude.parseClaudeStreamJsonLine('not-json').kind, 'malformed');
});

test('spawnSafe awaits ordered async callbacks and drains before resolve', async () => {
  const order = [];
  const result = await spawnSafe({
    command: process.execPath,
    args: ['-e', "process.stdout.write('a\\nb\\n')"],
    timeoutMs: 5000,
    onStdoutLine: async (line) => {
      order.push(`start:${line}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end:${line}`);
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('spawnSafe propagates callback rejection and aborts', async () => {
  await assert.rejects(
    () => spawnSafe({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x\\n'); setTimeout(()=>{}, 500)"],
      timeoutMs: 5000,
      onStdoutLine: async () => {
        throw Object.assign(new Error('cb fail'), { code: 'CB_FAIL' });
      },
    }),
    (err) => err && err.message === 'cb fail',
  );
});

test('grok and hermes publish honest limited capability contracts merged into probes', async () => {
  const g = grok.capabilityContract();
  assert.equal(g.streaming, false);
  assert.equal(g.streamingSchema, null);
  const h = hermes.capabilityContract();
  assert.equal(h.streaming, false);

  const probed = await probeAllEngines({
    probeRunner: async ({ engine }) => ({
      available: true,
      status: 'available',
      version: '1',
      authStatus: 'ok',
      message: 'probe ok',
      engine,
    }),
  });
  assert.equal(probed.engines.grok.streaming, false);
  assert.equal(probed.engines.grok.streamingSchema, null);
  assert.equal(probed.engines.hermes.streaming, false);
  assert.match(String(probed.engines.grok.message || ''), /no stable/i);
  assert.equal(probed.engines.codex.modelSelection, 'identifier');
  assert.deepEqual(probed.engines.codex.models, []);
  assert.equal(probed.engines.grok.modelSelection, 'catalog');
});

test('adapter metadata never hides an unavailable engine authentication failure', async () => {
  const probed = await probeAllEngines({
    probeRunner: async ({ engine }) => ({
      installed: true,
      available: engine === 'codex',
      status: engine === 'codex' ? 'available' : 'auth_required',
      version: '1',
      authStatus: engine === 'codex' ? 'authenticated' : 'missing',
      message: engine === 'codex'
        ? 'authenticated'
        : 'CLI installed, but authentication was not verified. Sign in on this Runner host.',
    }),
  });
  assert.equal(probed.engines.grok.available, false);
  assert.equal(probed.engines.grok.status, 'auth_required');
  assert.match(probed.engines.grok.message, /Sign in/);
  assert.equal(probed.engines.hermes.available, false);
  assert.equal(probed.engines.hermes.status, 'auth_required');
  assert.match(probed.engines.hermes.message, /Sign in/);
});

test('fake engine long-run respects abort for cancellation', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(
    () => fake.run({
      goal: 'long',
      stepDelayMs: 0,
      longRunMs: 5000,
      signal: controller.signal,
    }),
    (err) => err && err.code === 'CANCELLED',
  );
});

test('fake engine emits plan progress artifact result', async () => {
  const phases = [];
  const result = await fake.run({
    goal: 'test goal',
    stepDelayMs: 0,
    onCheckpoint: async (e) => { phases.push(e.phase); },
  });
  assert.equal(result.ok, true);
  assert.ok(phases.includes('plan'));
  assert.ok(phases.includes('result'));
});

test('fake engine forbidden outside exact test policy', () => {
  assert.throws(
    () => getEngineAdapter('fake', { env: { NODE_ENV: 'production', AGENT_CALENDAR_ALLOW_FAKE_ENGINE: '1' } }),
    /fake engine not allowed/,
  );
});
