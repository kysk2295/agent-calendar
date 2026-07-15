const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SAFE_PROFILE_ID_RE = /^(?:default|[a-z0-9][a-z0-9_-]*)$/;
const SAFE_HERMES_PROFILE_COMMAND_RE = /^(?:hermes|[^\s'";&|`]+\/hermes|'[^'\r\n]*\/hermes'|"[^"\r\n]*\/hermes")(?: -p [a-z0-9][a-z0-9_-]*)? chat -q "\$HERMES_GOAL" -Q -t safe --source tool$/;

function isHermesProfileRun(run = {}) {
  return run.agentIdentity?.kind === 'mac-mini-hermes-profile'
    || run.agentSource === 'hermes-cli'
    || run.executionBackend?.id === 'hermes-cli'
    || run.runtimeBinding?.executionBackendId === 'hermes-cli';
}

function isSafeHermesProfileCommand(command = '') {
  return SAFE_HERMES_PROFILE_COMMAND_RE.test(String(command || '').trim());
}

function hasApprovalBypassingRunnerCommand(command = '') {
  const text = String(command || '').trim();
  if (/(?:^|\s)--yolo(?:\s|$)/.test(text)) return true;
  if (/(?:^|\s)--dangerously-skip-permissions(?:\s|$)/.test(text)) return true;
  const invokesHermes = /^(?:hermes|[^\s'";&|`]+\/hermes|'[^'\r\n]*\/hermes'|"[^"\r\n]*\/hermes")(?:\s|$)/.test(text);
  return invokesHermes && /(?:^|\s)(?:-z|--oneshot)(?:\s|$)/.test(text);
}

function commandHasExplicitHermesProfile(command = '', agentKey = '') {
  if (!agentKey || !SAFE_PROFILE_ID_RE.test(agentKey)) return false;
  const escaped = agentKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)-p\\s+${escaped}(?:\\s|$)`).test(String(command || ''));
}

function hermesProfileMentionGoal(run = {}, { command = '' } = {}) {
  const goal = String(run.goal || '');
  const agentKey = String(
    run.runtimeBinding?.agentKey
      || run.agentIdentity?.id
      || run.agentId
      || '',
  ).trim();
  if (!isHermesProfileRun(run) || !agentKey || agentKey === 'default' || !SAFE_PROFILE_ID_RE.test(agentKey)) return goal;
  if (commandHasExplicitHermesProfile(command, agentKey)) return goal;
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
      HERMES_GOAL: hermesProfileMentionGoal(run, { command }),
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

function processTreeAlive(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function signalProcessTree(child, signal) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + Math.max(10, Number(timeoutMs) || 0);
  while (processTreeAlive(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processTreeAlive(child);
}

async function terminateProcessTree(child, graceMs = DEFAULT_TERMINATION_GRACE_MS) {
  if (!processTreeAlive(child)) return true;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForProcessTreeExit(child, graceMs)) return true;
  signalProcessTree(child, 'SIGKILL');
  return waitForProcessTreeExit(child, graceMs);
}

class LocalCommandRunner {
  constructor({
    allowShellCommands = false,
    command = '',
    cwd = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  } = {}) {
    this.allowShellCommands = Boolean(allowShellCommands);
    this.command = command;
    this.cwd = cwd || process.cwd();
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.terminationGraceMs = Math.max(10, Number(terminationGraceMs) || DEFAULT_TERMINATION_GRACE_MS);
    this.activeExecutions = new Map();
  }

  execute(run, { onLog } = {}) {
    if (!this.allowShellCommands) {
      return Promise.reject(new Error('Shell command execution is disabled'));
    }
    if (!String(this.command || '').trim()) {
      return Promise.reject(new Error('Runner command is not configured'));
    }
    if (hasApprovalBypassingRunnerCommand(this.command)) {
      return Promise.reject(new Error('An approval-bypassing runner command is blocked'));
    }
    if (isHermesProfileRun(run) && !isSafeHermesProfileCommand(this.command)) {
      return Promise.reject(new Error('A safe Hermes profile runner command is required'));
    }

    const rendered = renderCommandTemplate(this.command, { run });
    const runId = String(run.id || '').trim();
    if (runId && this.activeExecutions.has(runId)) {
      return Promise.reject(new Error(`Runner command is already active for ${runId}`));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(rendered.command, {
        cwd: this.cwd,
        shell: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          ...rendered.env,
        },
      });
      if (child.stdin) child.stdin.end();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let terminationPromise = null;
      let streamedLogs = false;
      const buffers = { stdout: '', stderr: '' };
      let timeout = null;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (runId && this.activeExecutions.get(runId)?.child === child) {
          this.activeExecutions.delete(runId);
        }
      };

      const finishWithTermination = (error) => {
        if (terminationPromise) return terminationPromise;
        if (settled) return Promise.resolve(!processTreeAlive(child));
        settled = true;
        if (timeout) clearTimeout(timeout);
        terminationPromise = terminateProcessTree(child, this.terminationGraceMs)
          .catch(() => false)
          .then((confirmed) => {
            cleanup();
            reject(error);
            return confirmed;
          });
        return terminationPromise;
      };

      if (runId) {
        this.activeExecutions.set(runId, {
          child,
          terminate: (error) => finishWithTermination(error),
        });
      }

      timeout = setTimeout(() => {
        void finishWithTermination(new Error(`Runner command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      function handleData(stream, chunk) {
        const text = Buffer.from(chunk).toString('utf8');
        if (stream === 'stdout') stdout += text;
        if (stream === 'stderr') stderr += text;
        if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
          if (!settled) {
            void finishWithTermination(
              new Error(`Runner command output exceeded ${MAX_BUFFER_BYTES} bytes`),
            );
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
          cleanup();
          reject(error);
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        flushBufferedLogs();
        settled = true;
        cleanup();
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

  async stop(runId) {
    const key = String(runId || '').trim();
    const execution = key ? this.activeExecutions.get(key) : null;
    if (!execution) return false;
    return execution.terminate(new Error(`Runner command stopped for ${key}`));
  }
}

module.exports = {
  LocalCommandRunner,
  commandHasExplicitHermesProfile,
  hasApprovalBypassingRunnerCommand,
  isSafeHermesProfileCommand,
  renderCommandTemplate,
  terminateProcessTree,
};
