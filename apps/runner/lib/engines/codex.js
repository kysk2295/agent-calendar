'use strict';

/**
 * Codex Engine Adapter — safe baseline only.
 * codex exec -C <cwd> --json --sandbox workspace-write  (prompt on stdin)
 * Parses JSONL for curated plan/progress/result; captures resumable thread/session id.
 * Never expose raw JSONL as artifacts. Never --full-auto / --yolo.
 */

const { assertSafeArgv, redactPrivatePaths } = require('./contract');
const { spawnSafe } = require('./spawn-safe');

const SECRET_RE = /sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+|OPENAI_API_KEY\s*=\s*\S+/gi;

function buildCodexArgv({ cwd, sessionId } = {}) {
  const args = sessionId
    ? [
      'exec',
      '-C', cwd || process.cwd(),
      '--skip-git-repo-check',
      '--json',
      '--sandbox', 'workspace-write',
      'resume', String(sessionId), '-',
    ]
    : [
      'exec',
      '-C', cwd || process.cwd(),
      '--skip-git-repo-check',
      '--json',
      '--sandbox', 'workspace-write',
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
  return 'Codex execution completed';
}

/**
 * Curate one Codex --json JSONL line (real schema: thread.started, item.completed, turn.completed).
 */
function parseCodexJsonlLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: 'malformed', text: 'Codex output line skipped (malformed JSON)' };
  }
  if (obj == null || typeof obj !== 'object') return null;

  const type = String(obj.type || obj.event || obj.kind || '').toLowerCase();
  const threadId = obj.thread_id || obj.threadId || obj.session_id || obj.sessionId
    || (obj.thread && (obj.thread.id || obj.thread.thread_id))
    || null;

  // Nested item fields (item.completed)
  const item = obj.item && typeof obj.item === 'object' ? obj.item : null;
  if (item && String(item.type || '').toLowerCase() === 'error') {
    return null;
  }
  const nestedText = item
    ? (item.text || item.content || item.summary || item.message || '')
    : '';
  const message = redactLine(
    obj.message || obj.text || obj.content || obj.summary || obj.delta || nestedText || '',
  );

  if (type === 'thread.started' || type === 'thread_started') {
    return {
      kind: 'plan',
      text: message || 'Codex thread started',
      threadId: threadId || (obj.thread_id || null),
    };
  }
  if (type === 'turn.started' || type === 'turn_started') {
    return null;
  }
  if (type.includes('error') || obj.error) {
    return {
      kind: 'error',
      text: redactLine(obj.error?.message || obj.message || 'Codex error'),
      threadId,
    };
  }
  if (type === 'item.completed' || type.includes('item')) {
    return {
      kind: 'progress',
      text: message || 'Codex item completed',
      threadId,
      assistantText: message || null,
    };
  }
  if (type === 'turn.completed' || type === 'turn_completed') {
    const usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
    return {
      kind: 'result',
      text: message || 'Codex turn completed',
      threadId,
      usage,
      assistantText: message || null,
    };
  }
  if (type.includes('plan') || (type === 'agent_reasoning' && /plan/i.test(message))) {
    return { kind: 'plan', text: message || 'Codex plan update', threadId };
  }
  if (type.includes('delta') || type.includes('progress') || type.includes('message')) {
    return { kind: 'progress', text: message || 'Codex progress', threadId, assistantText: message || null };
  }
  if (threadId) {
    return { kind: 'progress', text: message || 'Codex event', threadId };
  }
  return message ? { kind: 'progress', text: message, threadId: null } : null;
}

async function runCodex(input = {}) {
  const { goal, cwd, onCheckpoint, signal, timeoutMs = 180_000, providerSession } = input;
  const boundSessionId = providerSession?.externalSessionId || '';
  const args = buildCodexArgv({ cwd, sessionId: boundSessionId });
  let resumeThreadId = boundSessionId || null;
  let planEmitted = false;
  let progressCount = 0;
  let curatedFinalText = '';

  if (typeof onCheckpoint === 'function') {
    await onCheckpoint({
      phase: 'plan',
      text: 'Codex plan: workspace-write sandbox exec (JSONL curated)',
      kind: 'checkpoint',
    });
    planEmitted = true;
  }

  const handleLine = async (line) => {
    const parsed = parseCodexJsonlLine(line);
    if (!parsed) return;
    if (parsed.threadId) resumeThreadId = parsed.threadId;
    if (parsed.assistantText) curatedFinalText = String(parsed.assistantText).slice(0, 4000);
    if (parsed.kind === 'malformed' || parsed.kind === 'error') {
      if (typeof onCheckpoint === 'function') {
        await onCheckpoint({ phase: 'progress', text: parsed.text, kind: 'checkpoint' });
      }
      return;
    }
    if (parsed.kind === 'plan' && typeof onCheckpoint === 'function') {
      if (!planEmitted) {
        planEmitted = true;
        await onCheckpoint({ phase: 'plan', text: parsed.text, kind: 'checkpoint' });
      } else {
        progressCount += 1;
        if (progressCount <= 40) {
          await onCheckpoint({ phase: 'progress', text: parsed.text, kind: 'checkpoint' });
        }
      }
      return;
    }
    if (parsed.kind === 'progress' && typeof onCheckpoint === 'function') {
      progressCount += 1;
      if (progressCount <= 40) {
        await onCheckpoint({ phase: 'progress', text: parsed.text, kind: 'checkpoint' });
      }
    }
    if (parsed.kind === 'result' && typeof onCheckpoint === 'function') {
      await onCheckpoint({ phase: 'progress', text: parsed.text, kind: 'checkpoint' });
    }
  };

  try {
    const result = await spawnSafe({
      command: 'codex',
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
        errorCode: 'codex_exit',
        errorMessage: `codex exited ${result.code}`,
        retryable: true,
        resume: resumeThreadId ? { threadId: resumeThreadId } : undefined,
      };
    }
    if (typeof onCheckpoint === 'function') {
      await onCheckpoint({
        phase: 'result',
        text: completionCheckpointText(),
        kind: 'checkpoint',
      });
    }
    // Only curated assistant/result text — never raw JSONL dump.
    const artifacts = curatedFinalText
      ? [{ name: 'codex-result.txt', content: redactLine(curatedFinalText), contentType: 'text/plain' }]
      : [];
    return {
      ok: true,
      summary: curatedFinalText
        ? `Codex: ${curatedFinalText.slice(0, 200)}`
        : 'Codex execution completed',
      resume: resumeThreadId ? { threadId: resumeThreadId } : undefined,
      artifacts,
    };
  } catch (error) {
    if (error && error.code === 'ENGINE_UNAVAILABLE') {
      return { ok: false, errorCode: 'unavailable', errorMessage: 'codex not installed', retryable: false };
    }
    if (error && error.code === 'CANCELLED') {
      return {
        ok: false,
        errorCode: 'cancelled',
        errorMessage: 'cancelled',
        retryable: false,
        resume: resumeThreadId ? { threadId: resumeThreadId } : undefined,
      };
    }
    return {
      ok: false,
      errorCode: error.code || 'codex_error',
      errorMessage: String(error.message || error).slice(0, 300),
      retryable: error.code === 'TIMEOUT' || error.code === 'FORCED_CRASH',
      resume: resumeThreadId ? { threadId: resumeThreadId } : undefined,
    };
  }
}

module.exports = {
  id: 'codex',
  buildArgv: buildCodexArgv,
  completionCheckpointText,
  parseCodexJsonlLine,
  capabilityContract: () => ({
    id: 'codex',
    streaming: true,
    streamingSchema: 'codex-exec-jsonl',
    status: 'available',
  }),
  run: runCodex,
};
