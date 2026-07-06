const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SAFE_PROFILE_ID_RE = /^(?:default|[a-z0-9][a-z0-9_-]*)$/;

function hermesProfileMentionGoal(run = {}) {
  const goal = String(run.goal || '');
  const agentKey = String(
    run.runtimeBinding?.agentKey
      || run.agentIdentity?.id
      || run.agentId
      || '',
  ).trim();
  const isHermesProfile = run.agentIdentity?.kind === 'mac-mini-hermes-profile'
    || run.agentSource === 'hermes-cli'
    || run.executionBackend?.id === 'hermes-cli'
    || run.runtimeBinding?.executionBackendId === 'hermes-cli';
  if (!isHermesProfile || !agentKey || agentKey === 'default' || !SAFE_PROFILE_ID_RE.test(agentKey)) return goal;
  const mention = `@${agentKey}`;
  if (new RegExp(`(^|\\s)${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(goal)) return goal;
  return `${mention} ${goal}`.trim();
}

function renderCommandTemplate(command, { run = {}, env = {} } = {}) {
  const executionBackendId = String(
    run.executionBackend?.id
      || run.runtimeBinding?.executionBackendId
      || run.runnerAdapter?.id
      || run.runtimeBinding?.adapterId
      || '',
  );
  const executionBackendLabel = String(
    run.executionBackend?.label
      || run.runnerAdapter?.label
      || executionBackendId
      || '',
  );
  return {
    command: String(command || ''),
    env: {
      ...env,
      HERMES_RUN_ID: String(run.id || ''),
      HERMES_GOAL: hermesProfileMentionGoal(run),
      HERMES_RUN_FILE: String(run.file || ''),
      HERMES_AGENT_ID: String(run.agentId || ''),
      HERMES_AGENT_NAME: String(run.agent || run.agentName || ''),
      HERMES_AGENT_MODEL: String(run.model || ''),
      HERMES_EXECUTION_BACKEND_ID: executionBackendId,
      HERMES_EXECUTION_BACKEND_LABEL: executionBackendLabel,
      HERMES_AGENT_ADAPTER_ID: executionBackendId,
      HERMES_AGENT_SOURCE: String(run.agentSource || ''),
    },
  };
}

class LocalCommandRunner {
  constructor({
    allowShellCommands = false,
    command = '',
    cwd = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.allowShellCommands = Boolean(allowShellCommands);
    this.command = command;
    this.cwd = cwd || process.cwd();
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  }

  execute(run, { onLog } = {}) {
    if (!this.allowShellCommands) {
      return Promise.reject(new Error('Shell command execution is disabled'));
    }
    if (!String(this.command || '').trim()) {
      return Promise.reject(new Error('Runner command is not configured'));
    }

    const rendered = renderCommandTemplate(this.command, { run });
    return new Promise((resolve, reject) => {
      const child = spawn(rendered.command, {
        cwd: this.cwd,
        shell: true,
        env: {
          ...process.env,
          ...rendered.env,
        },
      });
      if (child.stdin) child.stdin.end();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let streamedLogs = false;
      const buffers = { stdout: '', stderr: '' };
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`Runner command timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      function handleData(stream, chunk) {
        const text = Buffer.from(chunk).toString('utf8');
        if (stream === 'stdout') stdout += text;
        if (stream === 'stderr') stderr += text;
        if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            child.kill('SIGTERM');
            reject(new Error(`Runner command output exceeded ${MAX_BUFFER_BYTES} bytes`));
          }
          return;
        }
        if (typeof onLog !== 'function') return;
        buffers[stream] += text;
        const lines = buffers[stream].split(/\r?\n/);
        buffers[stream] = lines.pop() || '';
        lines
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            streamedLogs = true;
            onLog({ stream, line });
          });
      }

      function flushBufferedLogs() {
        if (typeof onLog !== 'function') return;
        for (const stream of ['stdout', 'stderr']) {
          const line = buffers[stream].trim();
          if (line) {
            streamedLogs = true;
            onLog({ stream, line });
          }
          buffers[stream] = '';
        }
      }

      child.stdout.on('data', (chunk) => handleData('stdout', chunk));
      child.stderr.on('data', (chunk) => handleData('stderr', chunk));
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        flushBufferedLogs();
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode: typeof code === 'number' ? code : 0,
          stdout,
          stderr,
          cwd: this.cwd,
          command: rendered.command,
          streamedLogs,
        });
      });
    });
  }
}

module.exports = {
  LocalCommandRunner,
  renderCommandTemplate,
};
