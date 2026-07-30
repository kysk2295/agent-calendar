'use strict';

const { resolveEngine } = require('./durable-execution');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');
const { engineAuthStatus, engineReportsAvailability } = require('./engine-capability-auth');
const { assertWorkspaceScope } = require('./workspace-scope');

const POLICY_MODES = Object.freeze(['runner', 'agent_calendar_cloud']);
const POLICY_ENGINES = Object.freeze(['auto', 'codex', 'claude', 'grok', 'hermes']);

function inferenceError(code, message, statusHint = 503) {
  const error = new Error(message || code);
  error.code = code;
  error.statusHint = statusHint;
  return error;
}

function normalizeInferencePolicy(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Calendar AI and Wiki AI must answer from a phone, so they cannot require the user's
  // computer to be awake. Agent Work keeps its own Runner-only path (durable-execution).
  const mode = POLICY_MODES.includes(String(input.mode || '').toLowerCase())
    ? String(input.mode).toLowerCase()
    : 'agent_calendar_cloud';
  const defaultEngine = POLICY_ENGINES.includes(String(input.defaultEngine || '').toLowerCase())
    ? String(input.defaultEngine).toLowerCase()
    : 'auto';
  return { mode, defaultEngine };
}

function engineValues(capabilities = {}) {
  const engines = capabilities && typeof capabilities.engines === 'object'
    ? capabilities.engines
    : capabilities;
  return engines && typeof engines === 'object' ? engines : {};
}

function quotaExhausted(value) {
  if (!value || typeof value !== 'object') return false;
  const state = [
    value.errorCode,
    value.code,
    value.status,
    value.authStatus,
    value.message,
  ].map((item) => String(item || '').toLowerCase()).join(' ');
  return /quota[_ -]?exhausted|rate[_ -]?limit|insufficient[_ -]?quota/.test(state);
}

function runnerFailureCode(runners, requestedEngine) {
  if (!runners.length) return 'INFERENCE_RUNNER_UNAVAILABLE';
  const connected = runners.filter((runner) => runner.connection_state === 'connected');
  if (!connected.length) return 'RUNNER_OFFLINE';
  const requested = String(requestedEngine || 'auto').toLowerCase();
  for (const runner of connected) {
    const engines = engineValues(runner.capabilities || {});
    const candidates = requested === 'auto'
      ? ['codex', 'claude', 'grok', 'hermes'].map((name) => engines[name])
      : [engines[requested]];
    if (candidates.some(quotaExhausted)) return 'ENGINE_QUOTA_EXHAUSTED';
  }
  if (requested !== 'auto') {
    const reportsAvailable = connected.some((runner) => {
      const value = engineValues(runner.capabilities || {})[requested];
      return engineReportsAvailability(value) && ![
        'authenticated', 'ok', 'ready', 'active',
      ].includes(engineAuthStatus(value));
    });
    if (reportsAvailable) return 'ENGINE_AUTH_REQUIRED';
  } else {
    const anyInstalled = connected.some((runner) => Object.values(
      engineValues(runner.capabilities || {}),
    ).some(engineReportsAvailability));
    if (anyInstalled) return 'ENGINE_AUTH_REQUIRED';
  }
  return 'INFERENCE_ENGINE_UNAVAILABLE';
}

class WorkspaceInferenceBroker {
  constructor({
    pool,
    runnerComplete = null,
    cloudComplete = null,
    env = process.env,
  } = {}) {
    if (!pool) throw new Error('WorkspaceInferenceBroker requires pool');
    this.pool = pool;
    this.runnerComplete = runnerComplete;
    this.cloudComplete = cloudComplete;
    this.env = env;
  }

  async getPolicy(scope) {
    assertWorkspaceScope(scope);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select payload
         from state_meta
         where workspace_id = $1 and key = 'workspace_settings'
         limit 1`,
        [valid.workspaceId],
      );
      const settings = result.rowCount && result.rows[0].payload
        && typeof result.rows[0].payload === 'object'
        ? result.rows[0].payload
        : {};
      return normalizeInferencePolicy(settings.inferencePolicy);
    });
  }

  async #runnerCandidates(scope) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select id, workspace_id, connection_state, capabilities, last_seen_at
         from runners
         where workspace_id = $1 and status = 'active'
         order by last_seen_at desc nulls last`,
        [valid.workspaceId],
      );
      return result.rows;
    });
  }

  async complete(input = {}) {
    const scope = input.scope;
    assertWorkspaceScope(scope);
    const policy = await this.getPolicy(scope);

    if (policy.mode === 'agent_calendar_cloud') {
      if (typeof this.cloudComplete !== 'function') {
        throw inferenceError(
          'AGENT_CALENDAR_CLOUD_AI_UNAVAILABLE',
          'Agent Calendar Cloud AI is not configured',
        );
      }
      try {
        const result = await this.cloudComplete({ ...input, policy });
        const text = String(result?.text || '').trim();
        if (!text) {
          throw inferenceError(
            'AGENT_CALENDAR_CLOUD_AI_EMPTY',
            'Agent Calendar Cloud AI returned an empty answer',
          );
        }
        return {
          text,
          provider: 'agent-calendar-cloud',
          model: String(result.model || 'platform'),
        };
      } catch (cloudError) {
        // A single self-hosted inference host is a single point of failure. When it is down,
        // a connected Runner can still answer; when neither can, the original failure is
        // surfaced rather than a fabricated answer.
        try {
          return await this.#completeOnRunner(scope, input, policy);
        } catch {
          throw cloudError;
        }
      }
    }

    return this.#completeOnRunner(scope, input, policy);
  }

  async #completeOnRunner(scope, input, policy) {
    const runners = await this.#runnerCandidates(scope);
    const eligible = runners
      .filter((runner) => runner.connection_state === 'connected')
      .map((runner) => ({
        runner,
        resolved: resolveEngine(policy.defaultEngine, runner.capabilities || {}, this.env),
      }))
      .find((candidate) => candidate.resolved.resolved);
    if (!eligible) {
      const code = runnerFailureCode(runners, policy.defaultEngine);
      throw inferenceError(code, code.replaceAll('_', ' ').toLowerCase());
    }
    if (typeof this.runnerComplete !== 'function') {
      throw inferenceError(
        'INFERENCE_RUNNER_UNAVAILABLE',
        'Workspace Runner inference transport is unavailable',
      );
    }

    const result = await this.runnerComplete({
      ...input,
      policy,
      runner: {
        id: eligible.runner.id,
        workspaceId: scope.workspaceId,
      },
      engine: eligible.resolved.resolved,
      requestedEngine: policy.defaultEngine,
    });
    const text = String(result?.text || '').trim();
    if (!text) {
      throw inferenceError(
        result?.code || 'INFERENCE_RUNNER_FAILED',
        result?.message || 'Workspace Runner inference failed',
      );
    }
    return {
      text,
      provider: 'workspace-runner',
      model: String(result.engine || eligible.resolved.resolved),
    };
  }
}

module.exports = {
  POLICY_ENGINES,
  POLICY_MODES,
  WorkspaceInferenceBroker,
  inferenceError,
  normalizeInferencePolicy,
  runnerFailureCode,
};
