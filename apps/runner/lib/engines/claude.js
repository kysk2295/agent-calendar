'use strict';

/**
 * Claude Engine Adapter — non-interactive stream-json with explicit safe permissions.
 * Real schema fixtures: system / assistant / content_block_delta / result.
 * Never expose raw stream-json as artifacts. Never bypass permissions.
 */

const { assertSafeArgv, redactPrivatePaths } = require('./contract');
const { spawnSafe } = require('./spawn-safe');

const SECRET_RE = /sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+|ANTHROPIC_API_KEY\s*=\s*\S+/gi;

function buildClaudeArgv({ sessionId } = {}) {
  const args = [
    '-p',
    ...(sessionId ? ['--resume', String(sessionId)] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
  ];
  assertSafeArgv(args);
  return args;
}

function redactLine(line) {
  return redactPrivatePaths(
    String(line || '').replace(SECRET_RE, '[redacted]'),
  ).slice(0, 800);
}

function completionCheckpointText() {
  return 'Claude execution completed';
}

function extractText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.text === 'string') return obj.text;
  if (obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
  if (obj.message && Array.isArray(obj.message.content)) {
    return obj.message.content.map((c) => (c && c.text) || '').join('');
  }
  if (typeof obj.result === 'string') return obj.result;
  if (typeof obj.content === 'string') return obj.content;
  return '';
}

/**
 * Parse Claude stream-json line (system, assistant, content_block_delta, result).
 */
function parseClaudeStreamJsonLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: 'malformed', text: 'Claude stream line skipped (malformed JSON)' };
  }
  if (obj == null || typeof obj !== 'object') return null;

  const type = String(obj.type || obj.event || '').toLowerCase();
  const subtype = String(obj.subtype || '').toLowerCase();
  const sessionId = obj.session_id || obj.sessionId || null;
  const text = redactLine(extractText(obj));
  const toolUse = Array.isArray(obj.message?.content)
    ? obj.message.content.find((content) => ['tool_use', 'server_tool_use'].includes(String(content?.type || '')))
    : null;

  if (type === 'error' || obj.is_error) {
    return { kind: 'error', text: redactLine(obj.error || obj.message || 'Claude error'), sessionId };
  }
  if (type === 'init' || (type === 'system' && subtype === 'init')) {
    return { kind: 'plan', text: text || 'Claude session initialized', sessionId };
  }
  if (type === 'system') return null;
  if (toolUse) {
    const rawName = String(toolUse.name || 'tool');
    const name = /^[A-Za-z0-9_.:-]{1,80}$/.test(rawName) ? rawName : 'tool';
    return { kind: 'tool', text: `Claude 도구 · ${name}`, sessionId };
  }
  if (type === 'assistant') {
    return { kind: 'progress', text: text || 'Claude assistant message', sessionId, assistantText: text || null };
  }
  if (type === 'content_block_delta' || type.includes('delta')) {
    return { kind: 'progress', text: text || 'Claude delta', sessionId, assistantText: text || null };
  }
  if (type === 'result' || type === 'message_stop') {
    return { kind: 'result', text: text || 'Claude result', sessionId, assistantText: text || null };
  }
  return text ? { kind: 'progress', text, sessionId } : null;
}

async function runClaude(input = {}) {
  const { goal, cwd, onCheckpoint, signal, timeoutMs = 180_000, providerSession } = input;
  const boundSessionId = providerSession?.externalSessionId || '';
  const args = buildClaudeArgv({ sessionId: boundSessionId });
  let resumeSessionId = boundSessionId || null;
  let progressCount = 0;
  let curatedFinalText = '';

  if (typeof onCheckpoint === 'function') {
    await onCheckpoint({
      phase: 'plan',
      text: 'Claude plan: stream-json noninteractive, permission-mode default',
      kind: 'checkpoint',
    });
  }

  const handleLine = async (line) => {
    const parsed = parseClaudeStreamJsonLine(line);
    if (!parsed) return;
    if (parsed.sessionId) resumeSessionId = parsed.sessionId;
    const providerSession = parsed.sessionId
      ? { externalSessionId: String(parsed.sessionId) }
      : undefined;
    if (parsed.assistantText) {
      curatedFinalText = `${curatedFinalText}${parsed.assistantText}`.slice(0, 4000);
    }
    if (typeof onCheckpoint !== 'function') return;
    if (parsed.kind === 'plan') {
      await onCheckpoint({
        phase: 'plan',
        text: parsed.text,
        kind: 'checkpoint',
        ...(providerSession ? { providerSession } : {}),
      });
      return;
    }
    if (parsed.kind === 'progress' || parsed.kind === 'malformed' || parsed.kind === 'error') {
      progressCount += 1;
      if (progressCount <= 40) {
        await onCheckpoint({
          phase: 'progress',
          text: parsed.text,
          kind: 'checkpoint',
          ...(providerSession ? { providerSession } : {}),
        });
      }
    }
    if (parsed.kind === 'tool') {
      await onCheckpoint({
        phase: 'tool',
        text: parsed.text,
        kind: 'tool',
        ...(providerSession ? { providerSession } : {}),
      });
    }
    if (parsed.kind === 'result') {
      await onCheckpoint({
        phase: 'progress',
        text: parsed.text,
        kind: 'checkpoint',
        ...(providerSession ? { providerSession } : {}),
      });
    }
  };

  try {
    const result = await spawnSafe({
      command: 'claude',
      args,
      cwd,
      stdin: String(goal || ''),
      timeoutMs,
      signal,
      onStdoutLine: handleLine,
    });
    if (result.code !== 0) {
      return {
        ok: false,
        errorCode: 'claude_exit',
        errorMessage: `claude exited ${result.code}`,
        retryable: true,
        resume: resumeSessionId ? { sessionId: resumeSessionId } : undefined,
      };
    }
    if (typeof onCheckpoint === 'function') {
      await onCheckpoint({
        phase: 'result',
        text: completionCheckpointText(),
        kind: 'checkpoint',
      });
    }
    const artifacts = curatedFinalText
      ? [{ name: 'claude-result.txt', content: redactLine(curatedFinalText), contentType: 'text/plain' }]
      : [];
    return {
      ok: true,
      summary: curatedFinalText
        ? `Claude: ${curatedFinalText.slice(0, 200)}`
        : 'Claude execution completed',
      resume: resumeSessionId ? { sessionId: resumeSessionId } : undefined,
      artifacts,
    };
  } catch (error) {
    if (error && error.code === 'ENGINE_UNAVAILABLE') {
      return { ok: false, errorCode: 'unavailable', errorMessage: 'claude not installed', retryable: false };
    }
    if (error && error.code === 'CANCELLED') {
      return {
        ok: false,
        errorCode: 'cancelled',
        errorMessage: 'cancelled',
        retryable: false,
        resume: resumeSessionId ? { sessionId: resumeSessionId } : undefined,
      };
    }
    return {
      ok: false,
      errorCode: error.code || 'claude_error',
      errorMessage: String(error.message || error).slice(0, 300),
      retryable: error.code === 'TIMEOUT',
      resume: resumeSessionId ? { sessionId: resumeSessionId } : undefined,
    };
  }
}

module.exports = {
  id: 'claude',
  buildArgv: buildClaudeArgv,
  completionCheckpointText,
  parseClaudeStreamJsonLine,
  capabilityContract: () => ({
    id: 'claude',
    streaming: true,
    streamingSchema: 'claude-stream-json',
    status: 'available',
  }),
  run: runClaude,
};
