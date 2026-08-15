import { useEffect, useMemo, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type {
  OnboardingActionKind,
  OnboardingReadiness,
  OnboardingStepId,
} from './onboardingReadiness';
import { SecondBrainOnboarding } from '../second-brain/SecondBrainOnboarding';
import type { SecondBrainDecision, SecondBrainRun } from '../second-brain/secondBrainModel';
import './onboarding.css';
import './onboarding-controls.css';

type Props = Readonly<{
  readiness: OnboardingReadiness;
  busy?: boolean;
  message?: string;
  pendingAction?: OnboardingActionKind | null;
  onConnectCalendar: () => Promise<void>;
  onConnectMail: () => Promise<void>;
  onSyncCalendar: () => Promise<void>;
  onOpenRunner: () => void;
  onOpenWiki: () => void;
  onOpenCalendarAi: () => void;
  secondBrainRun?: SecondBrainRun | null;
  onStartSecondBrain?: () => Promise<void>;
  onReviewSecondBrain?: (decisions: readonly SecondBrainDecision[], activate: boolean) => Promise<void>;
  onAddKnowledgeFile: (file: File) => Promise<void>;
  onDismiss: () => Promise<void>;
  onComplete: () => Promise<void>;
}>;

export function OnboardingGuide({
  readiness,
  busy = false,
  message = '',
  pendingAction = null,
  onConnectCalendar,
  onConnectMail,
  onSyncCalendar,
  onOpenRunner,
  onOpenWiki,
  onOpenCalendarAi,
  secondBrainRun = null,
  onStartSecondBrain = async () => {},
  onReviewSecondBrain = async () => {},
  onAddKnowledgeFile,
  onDismiss,
  onComplete,
}: Props) {
  const [activeStepId, setActiveStepId] = useState<OnboardingStepId>(readiness.nextStepId);
  const [cloudConsent, setCloudConsent] = useState(false);
  const [skippedStepIds, setSkippedStepIds] = useState<readonly OnboardingStepId[]>([]);
  const visibleSteps = useMemo(() => readiness.steps.map((step) => (
    skippedStepIds.includes(step.id)
      ? { ...step, ready: true, skipped: true, statusLabel: step.skipLabel }
      : step
  )), [readiness.steps, skippedStepIds]);
  const allReady = visibleSteps.every((step) => step.ready || step.optional === true);
  const nextStepId = visibleSteps.find((step) => !step.ready)?.id
    || visibleSteps[visibleSteps.length - 1]?.id
    || readiness.nextStepId;

  useEffect(() => {
    const current = visibleSteps.find((step) => step.id === activeStepId);
    if (current?.ready && !allReady) setActiveStepId(nextStepId);
  }, [activeStepId, allReady, nextStepId, visibleSteps]);

  const activeStep = visibleSteps.find((step) => step.id === activeStepId) || visibleSteps[0];
  async function runAction(actionKind: OnboardingActionKind) {
    if (actionKind === 'calendar_sync') {
      await onSyncCalendar();
      return;
    }
    if (actionKind === 'calendar_connect') {
      await onConnectCalendar();
      return;
    }
    if (actionKind === 'mail_open') {
      await onConnectMail();
      return;
    }
    if (actionKind === 'second_brain_open') return;
    if (actionKind === 'runner_open') onOpenRunner();
    if (actionKind === 'wiki_open') onOpenWiki();
    if (actionKind === 'calendar_ai_open') onOpenCalendarAi();
  }

  return (
    <div className="onboarding-guide screen-in" data-testid="onboarding-guide">
      <header className="onboarding-head">
        <div>
          <strong>작업공간 준비</strong>
          <span>필요한 기록만 연결하거나 각 단계를 건너뛰고 바로 시작할 수 있습니다.</span>
        </div>
        <span>
          {visibleSteps.filter((step) => step.ready && step.optional !== true).length}
          /{visibleSteps.filter((step) => step.optional !== true).length} 준비
        </span>
      </header>

      <div className="onboarding-layout">
        <nav className="onboarding-steps" aria-label="시작 설정 단계">
          {visibleSteps.map((step, index) => (
            <button
              type="button"
              className="onboarding-progress-step"
              key={step.id}
              data-active={activeStep.id === step.id}
              data-ready={step.ready}
              data-pending={pendingAction === step.actionKind}
              data-optional={step.optional === true}
              data-skipped={step.skipped === true}
              aria-current={activeStep.id === step.id ? 'step' : undefined}
              onClick={() => setActiveStepId(step.id)}
            >
              <span className="onboarding-step-index" aria-hidden="true">
                {step.ready ? <Check size={12} weight="bold" /> : index + 1}
              </span>
              <span className="onboarding-step-copy">
                <strong>{step.title}</strong>
                <small className="onboarding-step-state">
                  {pendingAction === step.actionKind
                    ? step.actionKind === 'calendar_connect' || step.actionKind === 'mail_open'
                      ? '연결 진행 중'
                      : '동기화 진행 중'
                    : step.skipped
                      ? `건너뜀 · ${step.statusLabel}`
                      : step.ready
                      ? '준비됨'
                      : step.optional
                        ? `선택 · ${step.statusLabel}`
                        : step.statusLabel}
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
                  <dt>Runner 등록 순서</dt>
                  <dd>Runner 설정에서 Runner 추가 → 설치/열기 → 일회용 코드 발급 순서로 진행합니다.</dd>
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

            {activeStep.id === 'second_brain' ? (
              <SecondBrainOnboarding
                run={secondBrainRun}
                sourceAvailable={readiness.secondBrainSourceAvailable}
                busy={busy}
                onStart={onStartSecondBrain}
                onReview={onReviewSecondBrain}
                onConnectCalendar={onConnectCalendar}
                onOpenWiki={onOpenWiki}
              />
            ) : null}

            {activeStep.id !== 'second_brain' ? <div className="onboarding-detail-actions">
              <button
                type="button"
                className="primary"
                data-testid={`onboarding-action-${activeStep.id}`}
                disabled={busy}
                aria-busy={pendingAction === activeStep.actionKind || undefined}
                onClick={() => { void runAction(activeStep.actionKind); }}
              >
                {pendingAction === activeStep.actionKind
                  ? activeStep.actionKind === 'calendar_connect' || activeStep.actionKind === 'mail_open'
                    ? '브라우저 승인 대기 중…'
                    : activeStep.actionKind === 'calendar_sync'
                      ? '동기화 확인 중…'
                      : activeStep.actionLabel
                  : activeStep.actionLabel}
              </button>
              {!activeStep.ready && (
                <button
                  type="button"
                  data-testid={`onboarding-skip-${activeStep.id}`}
                  disabled={busy}
                  onClick={() => setSkippedStepIds((current) => [...new Set([...current, activeStep.id])])}
                >
                  {activeStep.skipLabel}
                </button>
              )}
              {activeStep.id === 'wiki' && (
                <button type="button" disabled={busy} onClick={onOpenWiki}>Wiki 전체 설정</button>
              )}
            </div> : null}
          </section>

          <footer className="onboarding-footer">
            <button type="button" disabled={busy} onClick={() => { void onDismiss(); }}>나중에 하기</button>
            <button
              type="button"
              className="primary"
              disabled={busy || !allReady}
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
