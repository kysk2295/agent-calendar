export type WorkspaceInferenceMode = 'runner' | 'agent_calendar_cloud';
export type WorkspaceInferenceEngine = 'auto' | 'codex' | 'claude' | 'grok' | 'hermes';

export type WorkspaceInferencePolicy = Readonly<{
  mode: WorkspaceInferenceMode;
  defaultEngine: WorkspaceInferenceEngine;
}>;

export const DEFAULT_WORKSPACE_INFERENCE_POLICY: WorkspaceInferencePolicy = Object.freeze({
  mode: 'runner',
  defaultEngine: 'auto',
});

export const WORKSPACE_INFERENCE_ENGINES: ReadonlyArray<Readonly<{
  id: WorkspaceInferenceEngine;
  label: string;
}>> = Object.freeze([
  { id: 'auto', label: '자동 선택' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok' },
  { id: 'hermes', label: 'Hermes' },
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function policyRecord(value: unknown): Record<string, unknown> {
  const envelope = record(value);
  const direct = record(envelope.inferencePolicy);
  if (Object.keys(direct).length) return direct;
  return record(record(envelope.settings).inferencePolicy);
}

export function readWorkspaceInferencePolicy(value: unknown): WorkspaceInferencePolicy {
  const policy = policyRecord(value);
  const mode = policy.mode === 'agent_calendar_cloud'
    ? 'agent_calendar_cloud'
    : 'runner';
  const requestedEngine = String(policy.defaultEngine || '').toLowerCase();
  const defaultEngine = WORKSPACE_INFERENCE_ENGINES.some(
    (engine) => engine.id === requestedEngine,
  )
    ? requestedEngine as WorkspaceInferenceEngine
    : 'auto';
  return { mode, defaultEngine };
}

export function workspaceInferencePolicyPayload(
  value: Record<string, unknown> | WorkspaceInferencePolicy,
) {
  const normalized = readWorkspaceInferencePolicy({ inferencePolicy: value });
  return {
    inferencePolicy: {
      mode: normalized.mode,
      defaultEngine: normalized.defaultEngine,
    },
  };
}
