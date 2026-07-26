const ADAPTER_TEMPLATES = [
  {
    id: 'codex-cli',
    label: 'Codex CLI',
    kind: 'model-runner',
    recommendedFor: ['research-day', 'remote-ops', 'product-build'],
    commandTemplate: 'codex exec --full-auto "$HERMES_GOAL"',
    readiness: 'Install/configure Codex CLI on the Runner host and set it as the local runner command when ready.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'model-runner',
    recommendedFor: ['wiki-maintenance', 'content-pipeline'],
    commandTemplate: 'claude --dangerously-skip-permissions "$HERMES_GOAL"',
    readiness: 'Install/configure Claude Code on the Runner host and point Hermes runner at the command.',
  },
  {
    id: 'grok-cli',
    label: 'Grok',
    kind: 'model-runner',
    recommendedFor: ['content-pipeline', 'research-day'],
    commandTemplate: 'grok "$HERMES_GOAL"',
    readiness: 'Configure a Grok-capable CLI or wrapper command before enabling this adapter.',
  },
  {
    id: 'local-command',
    label: 'Local command',
    kind: 'shell-runner',
    recommendedFor: ['remote-ops', 'product-build', 'wiki-maintenance', 'research-day', 'content-pipeline'],
    commandTemplate: '',
    readiness: 'Switch runner mode to local-command, allow shell execution, and save a command template.',
  },
];

const MIN_MODEL_RUNNER_TIMEOUT_MS = 600_000;

function isLocalCommandReady(runner = {}) {
  return Boolean(runner.mode === 'local-command' && runner.allowShellCommands && String(runner.command || '').trim());
}

function getAdapterTemplate(adapterId) {
  const adapter = ADAPTER_TEMPLATES.find((item) => item.id === adapterId);
  if (!adapter) {
    throw new Error(`Unknown runner adapter: ${adapterId || 'missing'}`);
  }
  return adapter;
}

function buildRunnerAdapterCatalog({ settings = {} } = {}) {
  const runner = settings.runner || {};
  const adapters = ADAPTER_TEMPLATES.map((adapter) => {
    if (adapter.id !== 'local-command') {
      return {
        ...adapter,
        ready: false,
        status: 'template',
      };
    }
    const ready = isLocalCommandReady(runner);
    return {
      ...adapter,
      ready,
      status: ready ? 'ready' : 'missing',
      commandTemplate: adapter.commandTemplate,
      commandConfigured: Boolean(String(runner.command || '').trim()),
      cwd: runner.cwd || '',
      timeoutMs: Number(runner.timeoutMs) || 300000,
    };
  });

  const readyCount = adapters.filter((adapter) => adapter.ready).length;
  return {
    summary: {
      readyCount,
      total: adapters.length,
      primaryReady: readyCount > 0,
    },
    adapters,
  };
}

function applyRunnerAdapterPreset({ adapterId, settings = {}, command = '', cwd = '', timeoutMs } = {}) {
  const adapter = getAdapterTemplate(adapterId);
  const runner = settings.runner || {};
  const commandTemplate = String(command || adapter.commandTemplate || runner.command || '').trim();
  if (!commandTemplate) {
    throw new Error(`Runner adapter ${adapter.id} requires a command template`);
  }
  const resolvedCwd = cwd || runner.cwd || process.cwd();
  const requestedTimeoutMs = Number(timeoutMs || runner.timeoutMs) || 300000;
  const resolvedTimeoutMs = adapter.kind === 'model-runner'
    ? Math.max(requestedTimeoutMs, MIN_MODEL_RUNNER_TIMEOUT_MS)
    : requestedTimeoutMs;
  return {
    adapter,
    patch: {
      runner: {
        mode: 'local-command',
        allowShellCommands: true,
        command: commandTemplate,
        cwd: resolvedCwd,
        timeoutMs: resolvedTimeoutMs,
      },
    },
    warning: 'This preset enables shell execution for no-approval Hermes runs. Keep destructive action guards active.',
  };
}

module.exports = {
  ADAPTER_TEMPLATES,
  applyRunnerAdapterPreset,
  buildRunnerAdapterCatalog,
};
