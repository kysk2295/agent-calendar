import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type {
  OnboardingActionKind,
  OnboardingReadiness,
  OnboardingStepId,
} from './onboardingReadiness';
import './onboarding.css';
import './onboarding-controls.css';

type Props = Readonly<{
  readiness: OnboardingReadiness;
  busy?: boolean;
  message?: string;
  onConnectCalendar: () => Promise<void>;
  onSyncCalendar: () => Promise<void>;
  onOpenRunner: () => void;
  onOpenWiki: () => void;
  onOpenCalendarAi: () => void;
  onAddKnowledgeFile: (file: File) => Promise<void>;
  onDismiss: () => Promise<void>;
  onComplete: () => Promise<void>;
}>;

export function OnboardingGuide({
  readiness,
  busy = false,
  message = '',
  onConnectCalendar,
  onSyncCalendar,
  onOpenRunner,
  onOpenWiki,
  onOpenCalendarAi,
  onAddKnowledgeFile,
  onDismiss,
  onComplete,
}: Props) {
  const [activeStepId, setActiveStepId] = useState<OnboardingStepId>(readiness.nextStepId);
  const [cloudConsent, setCloudConsent] = useState(false);

  useEffect(() => {
    const current = readiness.steps.find((step) => step.id === activeStepId);
    if (current?.ready && !readiness.allReady) setActiveStepId(readiness.nextStepId);
  }, [activeStepId, readiness]);

  const activeStep = readiness.steps.find((step) => step.id === activeStepId) || readiness.steps[0];
  async function runAction(actionKind: OnboardingActionKind) {
    if (actionKind === 'calendar_sync') {
      await onSyncCalendar();
      return;
    }
    if (actionKind === 'calendar_connect') {
      await onConnectCalendar();
      return;
    }
    if (actionKind === 'runner_open') onOpenRunner();
    if (actionKind === 'wiki_open') onOpenWiki();
    if (actionKind === 'calendar_ai_open') onOpenCalendarAi();
  }

  return (
    <div className="onboarding-guide screen-in" data-testid="onboarding-guide">
      <header className="onboarding-head">
        <div>
          <strong>작업공간 준비</strong>
          <span>캘린더와 Wiki를 연결하면 바로 시작할 수 있습니다. Runner는 에이전트 작업을 맡길 때 연결하세요.</span>
        </div>
        <span>
          {readiness.steps.filter((step) => step.ready && step.optional !== true).length}
          /{readiness.steps.filter((step) => step.optional !== true).length} 준비
        </span>
      </header>

      <div className="onboarding-layout">
        <nav className="onboarding-steps" aria-label="시작 설정 단계">
          {readiness.steps.map((step, index) => (
            <button
              type="button"
              className="onboarding-progress-step"
              key={step.id}
              data-active={activeStep.id === step.id}
              data-ready={step.ready}
              data-optional={step.optional === true}
              aria-current={activeStep.id === step.id ? 'step' : undefined}
              onClick={() => setActiveStepId(step.id)}
            >
              <span className="onboarding-step-index" aria-hidden="true">
                {step.ready ? <Check size={12} weight="bold" /> : index + 1}
              </span>
              <span className="onboarding-step-copy">
                <strong>{step.title}</strong>
                <small className="onboarding-step-state">
                  {step.ready ? '준비됨' : step.optional ? `선택 · ${step.statusLabel}` : step.statusLabel}
                </small>
              </span>
            </button>
          ))}
        </nav>

        <div className="onboarding-workspace">
          {message && <p className="onboarding-message" role="status">{message}</p>}

          <section className="onboarding-detail" aria-labelledby={`onboarding-title-${activeStep.id}`}>
            <div className="onboarding-detail-copy">
              <h3 id={`onboarding-title-${activeStep.id}`}>{activeStep.title}</h3>
              <p>{activeStep.description}</p>
            </div>

            {activeStep.id === 'wiki' && !activeStep.ready ? (
              <div className="onboarding-wiki-upload">
                <label>
                  <input
                    type="checkbox"
                    checked={cloudConsent}
                    onChange={(event) => setCloudConsent(event.target.checked)}
                  />
                  선택한 파일을 현재 Workspace의 암호화 색인에 저장하는 데 동의
                </label>
                <label className="onboarding-file-action" data-disabled={!cloudConsent || busy}>
                  {busy ? '파일을 추가하는 중' : '지식 파일 추가'}
                  <input
                    type="file"
                    accept=".md,.mdx,.txt,.json,.csv,.html,.js,.jsx,.ts,.tsx,.py,.yaml,.yml"
                    disabled={!cloudConsent || busy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) void onAddKnowledgeFile(file);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
            ) : null}

            {activeStep.id === 'runner' ? (
              <dl className="onboarding-auth-boundaries" data-testid="onboarding-auth-boundaries">
                <div>
                  <dt>작업공간 로그인</dt>
                  <dd>현재 사용자와 Workspace를 확인합니다.</dd>
                </div>
                <div>
                  <dt>캘린더 OAuth</dt>
                  <dd>이 사용자의 Google 일정 권한만 연결합니다.</dd>
                </div>
                <div>
                  <dt>실행 엔진 인증</dt>
                  <dd>Codex·Claude·Grok·Hermes 자격 증명은 사용자 소유 Runner에만 남습니다.</dd>
                </div>
              </dl>
            ) : null}

            <div className="onboarding-detail-actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => { void runAction(activeStep.actionKind); }}
              >
                {activeStep.actionLabel}
              </button>
              {activeStep.id === 'wiki' && (
                <button type="button" disabled={busy} onClick={onOpenWiki}>Wiki 전체 설정</button>
              )}
            </div>
          </section>

          <footer className="onboarding-footer">
            <button type="button" disabled={busy} onClick={() => { void onDismiss(); }}>나중에 하기</button>
            <button
              type="button"
              className="primary"
              disabled={busy || !readiness.allReady}
              onClick={() => { void onComplete(); }}
            >
              설정 완료
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
