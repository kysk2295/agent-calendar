'use strict';

/**
 * Codex Engine Adapter — safe baseline only.
 * codex exec -C <cwd> --json --sandbox workspace-write  (prompt on stdin)
 * Parses JSONL for curated plan/progress/result; captures resumable thread/session id.
 * Never expose raw JSONL as artifacts. Never --full-auto / --yolo.
 */

const { assertSafeArgv, normalizeModelId, redactPrivatePaths } = require('./contract');
const { spawnSafe } = require('./spawn-safe');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET_RE = /sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+|OPENAI_API_KEY\s*=\s*\S+/gi;

function buildCodexArgv({
  cwd, sessionId, model, disposableNoTools = false,
} = {}) {
  const requestedModel = normalizeModelId(model);
  const disposableArgs = disposableNoTools
    ? [
      '--sandbox', 'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--disable', 'web_search',
    ]
    : ['--sandbox', 'workspace-write'];
  const resumableSessionId = disposableNoTools ? '' : sessionId;
  const args = resumableSessionId
    ? [
      'exec',
      '-C', cwd || process.cwd(),
      '--skip-git-repo-check',
      '--json',
      ...disposableArgs,
      ...(requestedModel ? ['--model', requestedModel] : []),
      'resume', String(resumableSessionId), '-',
    ]
    : [
      'exec',
      '-C', cwd || process.cwd(),
      '--skip-git-repo-check',
      '--json',
      ...disposableArgs,
      ...(requestedModel ? ['--model', requestedModel] : []),
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

function configuredCodexModel() {
  try {
    const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const match = fs.readFileSync(configPath, 'utf8').match(/^model\s*=\s*['"]([^'"]+)['"]/m);
    return normalizeModelId(match?.[1] || '');
  } catch {
    return '';
  }
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
  const itemType = String(item?.type || '').toLowerCase();
  if (item && itemType === 'error') {
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
  if (type === 'item.completed' && [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
  ].includes(itemType)) {
    const toolLabel = {
      command_execution: '명령 실행',
      file_change: '파일 변경',
      mcp_tool_call: '연결 도구',
      web_search: '웹 검색',
    }[itemType];
    const exitCode = Number.isInteger(item?.exit_code) ? ` · 종료 ${item.exit_code}` : '';
    return {
      kind: 'tool',
      text: `Codex 도구 · ${toolLabel}${exitCode}`,
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
  const {
    goal, cwd, model, onCheckpoint, signal, timeoutMs = 180_000, providerSession,
    executionPolicy,
  } = input;
  const requestedModel = normalizeModelId(model);
  const boundSessionId = providerSession?.externalSessionId || '';
  const disposableNoTools = executionPolicy?.disposable === true
    && executionPolicy?.defaultDeny === true;
  const args = buildCodexArgv({
    cwd,
    sessionId: boundSessionId,
    model: requestedModel,
    disposableNoTools,
  });
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
    const providerSession = parsed.threadId
      ? { externalSessionId: String(parsed.threadId) }
      : undefined;
    if (parsed.assistantText) curatedFinalText = String(parsed.assistantText).slice(0, 4000);
    if (parsed.kind === 'malformed' || parsed.kind === 'error') {
      if (typeof onCheckpoint === 'function') {
        await onCheckpoint({
          phase: 'progress',
          text: parsed.text,
          kind: 'checkpoint',
          ...(providerSession ? { providerSession } : {}),
        });
      }
      return;
    }
    if (parsed.kind === 'plan' && typeof onCheckpoint === 'function') {
      if (!planEmitted) {
        planEmitted = true;
        await onCheckpoint({
          phase: 'plan',
          text: parsed.text,
          kind: 'checkpoint',
          ...(providerSession ? { providerSession } : {}),
        });
      } else {
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
      return;
    }
    if (parsed.kind === 'progress' && typeof onCheckpoint === 'function') {
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
    if (parsed.kind === 'tool' && typeof onCheckpoint === 'function') {
      await onCheckpoint({
        phase: 'tool',
        text: parsed.text,
        kind: 'tool',
        ...(providerSession ? { providerSession } : {}),
      });
    }
    if (parsed.kind === 'result' && typeof onCheckpoint === 'function') {
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
    const resolvedModel = requestedModel || configuredCodexModel();
    return {
      ok: true,
      summary: curatedFinalText
        ? `Codex: ${curatedFinalText.slice(0, 200)}`
        : 'Codex execution completed',
      ...(resolvedModel ? { model: resolvedModel } : {}),
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
  configuredCodexModel,
  parseCodexJsonlLine,
  capabilityContract: () => ({
    id: 'codex',
    streaming: true,
    streamingSchema: 'codex-exec-jsonl',
    status: 'available',
    modelSelection: 'identifier',
    models: [],
    defaultModel: null,
  }),
  run: runCodex,
};
