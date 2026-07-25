import { useEffect, useState } from 'react';
import {
  DEFAULT_WORKSPACE_INFERENCE_POLICY,
  WORKSPACE_INFERENCE_ENGINES,
  readWorkspaceInferencePolicy,
  workspaceInferencePolicyPayload,
  type WorkspaceInferenceEngine,
  type WorkspaceInferenceMode,
  type WorkspaceInferencePolicy,
} from './workspaceInferencePolicy';

type WorkspaceInferencePolicyPanelProps = Readonly<{
  loadSettings: () => Promise<unknown>;
  saveSettings: (payload: Record<string, unknown>) => Promise<unknown>;
  onSaved?: () => void | Promise<void>;
  onError?: (message: string) => void;
}>;

function policyLabel(policy: WorkspaceInferencePolicy) {
  return policy.mode === 'agent_calendar_cloud'
    ? 'Agent Calendar Cloud AI'
    : '내 Workspace Runner';
}

export function WorkspaceInferencePolicyPanel({
  loadSettings,
  saveSettings,
  onSaved,
  onError,
}: WorkspaceInferencePolicyPanelProps) {
  const [draft, setDraft] = useState<WorkspaceInferencePolicy>(
    DEFAULT_WORKSPACE_INFERENCE_POLICY,
  );
  const [applied, setApplied] = useState<WorkspaceInferencePolicy>(
    DEFAULT_WORKSPACE_INFERENCE_POLICY,
  );
  const [cloudConfirmed, setCloudConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadSettings()
      .then((value) => {
        if (!active) return;
        const next = readWorkspaceInferencePolicy(value);
        setDraft(next);
        setApplied(next);
        setStatus('');
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error
          ? error.message
          : 'AI 실행 설정을 불러오지 못했습니다.';
        setStatus(message);
        onError?.(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadSettings, onError]);

  const setMode = (mode: WorkspaceInferenceMode) => {
    setDraft((current) => ({ ...current, mode }));
    setCloudConfirmed(false);
    setStatus('');
  };

  const save = async () => {
    if (saving || (draft.mode === 'agent_calendar_cloud' && !cloudConfirmed)) return;
    setSaving(true);
    setStatus('');
    try {
      await saveSettings(workspaceInferencePolicyPayload(draft));
      setApplied(draft);
      setCloudConfirmed(false);
      setStatus('저장됨');
      await onSaved?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 실행 정책 저장 실패';
      setStatus(`저장하지 못했습니다. ${message}`);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="inference-policy-panel"
      data-testid="inference-policy-panel"
      data-loading={loading}
    >
      <div className="inference-policy-applied">
        <span>현재 사용</span>
        <strong data-testid="inference-policy-applied">{policyLabel(applied)}</strong>
      </div>

      <div className="inference-policy-modes" role="group" aria-label="AI 실행 위치">
        <button
          type="button"
          data-testid="inference-mode-runner"
          data-active={draft.mode === 'runner'}
          onClick={() => setMode('runner')}
        >
          <span><strong>내 Workspace Runner</strong><small>Runner에서 인증한 엔진으로 실행합니다.</small></span>
          <i aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="inference-mode-cloud"
          data-active={draft.mode === 'agent_calendar_cloud'}
          onClick={() => setMode('agent_calendar_cloud')}
        >
          <span><strong>Agent Calendar Cloud AI</strong><small>플랫폼 AI를 명시적으로 사용합니다.</small></span>
          <i aria-hidden="true" />
        </button>
      </div>

      {draft.mode === 'runner' ? (
        <label className="inference-policy-engine">
          <span>기본 실행 엔진</span>
          <select
            data-testid="inference-default-engine"
            value={draft.defaultEngine}
            onChange={(event) => setDraft((current) => ({
              ...current,
              defaultEngine: event.target.value as WorkspaceInferenceEngine,
            }))}
          >
            {WORKSPACE_INFERENCE_ENGINES.map((engine) => (
              <option key={engine.id} value={engine.id}>{engine.label}</option>
            ))}
          </select>
          <small>제공자 로그인 정보는 Agent Calendar가 아니라 Runner에만 남습니다.</small>
        </label>
      ) : (
        <label className="inference-cloud-confirm">
          <input
            type="checkbox"
            data-testid="inference-cloud-confirm"
            checked={cloudConfirmed}
            onChange={(event) => setCloudConfirmed(event.target.checked)}
          />
          <span>
            <strong>Cloud AI 사용을 확인합니다.</strong>
            <small>Runner 장애 시 자동 전환하지 않습니다. 이 선택을 저장한 Workspace만 Cloud AI를 사용합니다.</small>
          </span>
        </label>
      )}

      <div className="inference-policy-actions">
        <p
          data-testid="inference-policy-status"
          role={status.startsWith('저장하지') ? 'alert' : 'status'}
        >
          {loading ? '설정을 확인하는 중…' : status}
        </p>
        <button
          type="button"
          className="primary"
          data-testid="inference-policy-save"
          disabled={
            loading
            || saving
            || (draft.mode === 'agent_calendar_cloud' && !cloudConfirmed)
          }
          onClick={() => void save()}
        >
          {saving ? '저장 중…' : '적용'}
        </button>
      </div>
    </div>
  );
}
