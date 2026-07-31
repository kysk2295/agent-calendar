import { useCallback, useEffect, useState } from 'react';
import {
  confirmEnrollment,
  engineAuthenticationPresentation,
  engineList,
  getEnrollment,
  getReleaseManifest,
  listRunners,
  rejectEnrollment,
  revokeRunner,
  startEnrollment,
  testRunner,
  type EnrollmentSnapshot,
  type PublicRunner,
  type ReleaseArtifact,
  type RunnerEnrollment,
} from './runnerApi';
import { emptyQrSvgPlaceholder, renderEnrollmentQrSvg } from './qrEnrollment';
import {
  connectionTestPresentation,
  isRunnerCurrentlyReady,
  normalizeConnectionState,
  RECONNECT_REQUIRED_COPY,
  RECONNECT_REQUIRED_DETAIL,
  shouldShowReadyCard,
  shouldShowReconnectRequired,
} from './runnerConnectionPresentation';
import { ProviderAccountsPanel } from './ProviderAccountsPanel';
import './provider-accounts.css';
type SetupStep =
  | 'workspace'
  | 'install'
  | 'challenge'
  | 'pending'
  | 'active'
  | 'ready'
  | 'revoked';

type Props = {
  workspaceLabel?: string;
  controlPlaneBaseUrl?: string;
  onReadyCalendar?: () => void;
  onRunnersChange?: (runners: readonly PublicRunner[]) => void;
};

export function RunnerSetupPanel({
  workspaceLabel = '현재 작업공간',
  controlPlaneBaseUrl = '',
  onReadyCalendar,
  onRunnersChange,
}: Props) {
  const [step, setStep] = useState<SetupStep>('workspace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manifest, setManifest] = useState<ReleaseArtifact | null>(null);
  const [runners, setRunners] = useState<PublicRunner[]>([]);
  const [enrollment, setEnrollment] = useState<RunnerEnrollment | null>(null);
  const [snapshot, setSnapshot] = useState<EnrollmentSnapshot | null>(null);
  const [selectedRunner, setSelectedRunner] = useState<PublicRunner | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const [qrSvg, setQrSvg] = useState('');
  const [lastRevoked, setLastRevoked] = useState<PublicRunner | null>(null);
  const [providerNotice, setProviderNotice] = useState('');

  const refreshRunners = useCallback(async () => {
    const list = await listRunners();
    setRunners(list);
    onRunnersChange?.(list);
    return list;
  }, [onRunnersChange]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, list] = await Promise.all([getReleaseManifest(), refreshRunners()]);
        if (cancelled) return;
        setManifest(m);
        const active = list.find((r) => r.status === 'active') || null;
        if (active) {
          setSelectedRunner(active);
          if (isRunnerCurrentlyReady(active)) setStep('ready');
          else setStep('active');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [refreshRunners]);

  // Poll enrollment while waiting for device present / claim.
  useEffect(() => {
    if (!enrollment?.id || (step !== 'challenge' && step !== 'pending')) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getEnrollment(enrollment.id);
          if (cancelled) return;
          setSnapshot(next);
          if (next.pendingDevice?.fingerprint) setStep('pending');
          if (next.runner && next.runner.status === 'active') {
            setSelectedRunner(next.runner);
            setStep('active');
            await refreshRunners();
          }
        } catch {
          // keep polling
        }
      })();
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enrollment?.id, step, refreshRunners]);

  // While managing an active runner, poll for connection_state (disconnect/reconnect).
  useEffect(() => {
    if (step !== 'active' && step !== 'ready') return undefined;
    const runnerId = selectedRunner?.id;
    if (!runnerId) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const list = await refreshRunners();
          if (cancelled) return;
          const current = list.find((r) => r.id === runnerId) || null;
          if (!current) return;
          setSelectedRunner(current);
          if (current.status === 'revoked') {
            setLastRevoked(current);
            setStep('revoked');
            return;
          }
          // Never keep the ready step while the transport is not connected.
          if (isRunnerCurrentlyReady(current)) setStep('ready');
          else if (step === 'ready') setStep('active');
        } catch {
          // ignore poll errors
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [step, selectedRunner?.id, refreshRunners]);

  // Standards-compliant QR render when enrollment payload changes.
  useEffect(() => {
    let cancelled = false;
    if (!enrollment?.qrPayload) {
      setQrSvg('');
      return undefined;
    }
    setQrSvg(emptyQrSvgPlaceholder());
    void renderEnrollmentQrSvg(enrollment.qrPayload, { width: 256 }).then((svg) => {
      if (!cancelled) setQrSvg(svg);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [enrollment?.qrPayload]);

  async function beginInstall() {
    setError('');
    setStep('install');
    try {
      const m = await getReleaseManifest();
      setManifest(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function issueChallenge() {
    setBusy(true);
    setError('');
    try {
      const enr = await startEnrollment(controlPlaneBaseUrl || undefined);
      setEnrollment(enr);
      setSnapshot(null);
      setStep('challenge');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!enrollment?.id) return;
    setBusy(true);
    setError('');
    try {
      await confirmEnrollment(enrollment.id);
      setStep('pending');
      const next = await getEnrollment(enrollment.id);
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!enrollment?.id) return;
    setBusy(true);
    setError('');
    try {
      await rejectEnrollment(enrollment.id);
      setEnrollment(null);
      setSnapshot(null);
      setStep('workspace');
      await refreshRunners();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    const id = selectedRunner?.id;
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const result = await testRunner(id);
      setTestMessage(result.message);
      const nextRunner = result.runner || selectedRunner;
      if (result.runner) setSelectedRunner(result.runner);
      const list = await refreshRunners();
      const fresh = list.find((r) => r.id === id) || nextRunner;
      if (fresh) setSelectedRunner(fresh);
      if (result.passed && isRunnerCurrentlyReady(fresh)) setStep('ready');
      else setStep('active');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setBusy(true);
    setError('');
    try {
      const revoked = await revokeRunner(id);
      setLastRevoked(revoked);
      setSelectedRunner(revoked);
      setTestMessage('');
      setEnrollment(null);
      setStep('revoked');
      await refreshRunners();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const engines = engineList(selectedRunner);
  const connectionState = normalizeConnectionState(selectedRunner);
  const connectionLabel = connectionState === 'connected'
    ? 'Connected'
    : connectionState === 'reconnecting'
      ? 'Reconnecting'
      : selectedRunner?.status === 'revoked' || connectionState === 'revoked'
        ? 'Revoked'
        : 'Disconnected';
  const showReady = shouldShowReadyCard(step, selectedRunner);
  const showReconnectRequired = shouldShowReconnectRequired(selectedRunner);
  const testPresentation = connectionTestPresentation(selectedRunner, testMessage);

  return (
    <div className="runner-setup" data-testid="runner-setup" data-step={step}>
      <header className="runner-setup-head">
        <div>
          <p className="runner-kicker">작업공간 · Runner</p>
          <h2>Runner 설정</h2>
          <p className="runner-lede">
            Codex, Claude, Grok, Hermes를 실행할 호스트를 연결합니다.
            소유자 확인에는 일회용 코드가 사용되며 제공자 자격 증명은 호스트에만 남습니다.
          </p>
        </div>
        <div className="runner-workspace-chip" data-testid="runner-workspace-label">
          <span>Workspace</span>
          <strong>{workspaceLabel}</strong>
        </div>
      </header>

      {error && (
        <div className="runner-error" role="alert" data-testid="runner-setup-error">{error}</div>
      )}

      {step === 'workspace' && (
        <section className="runner-card" data-testid="runner-step-workspace">
          <h3>1. 작업공간 확인</h3>
          <p>등록된 Runner가 없으면 아래 Runner 추가를 누르세요. 설치/열기와 일회용 코드 발급 순서로 안내합니다.</p>
          {runners.length > 0 && (
            <ul className="runner-list" data-testid="runner-list">
              {runners.map((r) => (
                <li key={r.id} data-status={r.status} data-connection={r.connectionState}>
                  <div>
                    <strong>{r.hostMetadata && typeof r.hostMetadata === 'object' && 'hostName' in r.hostMetadata
                      ? String((r.hostMetadata as { hostName?: string }).hostName || r.id)
                      : r.id}</strong>
                    <small>{r.status} · {r.connectionState || 'disconnected'}</small>
                    {r.fingerprint && <code className="runner-fp">{r.fingerprint}</code>}
                  </div>
                  <div className="runner-list-actions">
                    {(r.status === 'active' || r.status === 'revoked') && (
                      <button
                        type="button"
                        data-testid={`runner-manage-${r.id}`}
                        onClick={() => {
                          setSelectedRunner(r);
                          if (r.status === 'revoked') {
                            setLastRevoked(r);
                            setStep('revoked');
                          } else {
                            setStep('active');
                          }
                        }}
                      >
                        관리
                      </button>
                    )}
                    {(r.status === 'active' || r.status === 'pending') && (
                      <button type="button" className="danger" disabled={busy} onClick={() => void onRevoke(r.id)}>취소/폐기</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="primary" data-testid="runner-begin-setup" onClick={() => void beginInstall()}>
            Runner 추가
          </button>
        </section>
      )}

      {step === 'install' && (
        <section className="runner-card" data-testid="runner-step-install">
          <h3>2. Runner 설치 / 열기</h3>
          <p className="runner-deviation">
            이 호스트에서 사용할 수 있는 설치 파일 상태를 확인합니다.
          </p>
          <div className="runner-manifest" data-testid="runner-manifest" data-status={manifest?.status || 'unknown'}>
            <strong>
              {manifest?.status === 'verified_signed'
                ? '검증된 서명 다운로드'
                : manifest?.status === 'local_development'
                  ? '로컬 개발 빌드'
                  : '설치 파일 없음'}
            </strong>
            <p>{manifest?.notes || 'apps/runner를 이 호스트에서 실행하세요.'}</p>
            {manifest?.version && <small>version {manifest.version} · {manifest.platform}</small>}
            {manifest?.downloadUrl ? (
              <a href={manifest.downloadUrl} data-testid="runner-download-link">다운로드</a>
            ) : (
              <code data-testid="runner-open-command">npx --workspace apps/runner agent-calendar-runner daemon --base-url …</code>
            )}
          </div>
          <div className="runner-actions">
            <button type="button" onClick={() => setStep('workspace')}>뒤로</button>
            <button type="button" className="primary" data-testid="runner-issue-challenge" disabled={busy} onClick={() => void issueChallenge()}>
              일회용 코드 발급
            </button>
          </div>
        </section>
      )}

      {step === 'challenge' && enrollment && (
        <section className="runner-card" data-testid="runner-step-challenge">
          <h3>3. 일회용 코드 · QR</h3>
          <p>코드는 한 번만 사용할 수 있습니다. 호스트가 연결되면 장치 지문을 확인합니다.</p>
          <div className="runner-code-block">
            <code data-testid="runner-human-code" className="runner-human-code">{enrollment.humanCode}</code>
            <div
              className="runner-qr"
              data-testid="runner-qr"
              data-qr-payload={enrollment.qrPayload || ''}
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          </div>
          <p className="runner-hint">호스트에서: <code>agent-calendar-runner daemon --base-url … --challenge-id {enrollment.id} --code {enrollment.humanCode} --once</code></p>
          {snapshot?.pendingDevice?.fingerprint && (
            <p data-testid="runner-device-arrived">장치가 대기 중입니다… 지문 확인으로 이동</p>
          )}
        </section>
      )}

      {(step === 'pending' || (step === 'challenge' && snapshot?.pendingDevice)) && snapshot?.pendingDevice && (
        <section className="runner-card" data-testid="runner-step-pending">
          <h3>4. 장치 지문 확인</h3>
          <p>아래 지문을 호스트 화면과 비교하세요. 확인 전에는 자격 증명이 발급되지 않습니다.</p>
          <div className="runner-fingerprint" data-testid="runner-fingerprint">
            {snapshot.pendingDevice.fingerprint}
          </div>
          <dl className="runner-meta">
            <div><dt>Host</dt><dd data-testid="runner-pending-host">{String((snapshot.pendingDevice.hostMetadata as { hostName?: string } | undefined)?.hostName || '-')}</dd></div>
            <div><dt>OS</dt><dd>{String((snapshot.pendingDevice.hostMetadata as { hostOs?: string } | undefined)?.hostOs || '-')}</dd></div>
            <div><dt>Runner</dt><dd>{snapshot.pendingDevice.runnerVersion || '-'}</dd></div>
          </dl>
          <div className="runner-actions">
            <button type="button" className="danger" data-testid="runner-reject" disabled={busy} onClick={() => void onReject()}>거부</button>
            <button type="button" className="primary" data-testid="runner-confirm" disabled={busy} onClick={() => void onConfirm()}>확인</button>
          </div>
        </section>
      )}

      {(step === 'active' || step === 'ready') && selectedRunner && (
        <section className="runner-card" data-testid="runner-step-active">
          <h3>5. 연결 · 엔진 능력</h3>
          <p
            data-testid="runner-connection-state"
            data-state={connectionState === 'connected' ? 'connected' : connectionState === 'revoked' ? 'revoked' : connectionState === 'reconnecting' ? 'reconnecting' : 'disconnected'}
          >
            상태: <strong data-testid="runner-connection-label">{connectionLabel}</strong>
          </p>
          {selectedRunner.fingerprint && (
            <code className="runner-fp" data-testid="runner-active-fingerprint">{selectedRunner.fingerprint}</code>
          )}
          <ul className="runner-engines" data-testid="runner-engines" hidden>
            {engines.map(({ name, cap }) => {
              const presentation = engineAuthenticationPresentation(cap);
              return (
                <li
                  key={name}
                  data-engine={name}
                  data-available={presentation.ready}
                  data-auth-state={presentation.state}
                >
                  <strong>{name}</strong>
                  <span>{presentation.availabilityLabel}</span>
                  <small className="runner-engine-auth">{presentation.authLabel}</small>
                </li>
              );
            })}
          </ul>
          <ProviderAccountsPanel
            engines={engines}
            hostLabel={
              selectedRunner.hostMetadata && typeof selectedRunner.hostMetadata === 'object' && 'hostName' in selectedRunner.hostMetadata
                ? String((selectedRunner.hostMetadata as { hostName?: string }).hostName || '실행 컴퓨터')
                : '실행 컴퓨터'
            }
            busy={busy}
            onRefresh={() => {
              void refreshRunners().then((list) => {
                const current = list.find((r) => r.id === selectedRunner.id);
                if (current) {
                  setSelectedRunner(current);
                  if (isRunnerCurrentlyReady(current)) setStep('ready');
                  else setStep('active');
                }
                setProviderNotice('Runner 엔진 로그인 상태를 새로고침했습니다.');
              });
            }}
            onAddAccount={(providerId) => {
              setProviderNotice(
                `${providerId} 계정 추가는 Runner 호스트에서 해당 CLI로 로그인하세요. 자격 증명은 이 앱으로 복사되지 않습니다.`,
              );
            }}
            onReauth={(providerId) => {
              setProviderNotice(`${providerId} 재인증은 Runner 호스트에서 다시 로그인하면 반영됩니다.`);
            }}
            onRemove={(providerId) => {
              setProviderNotice(`${providerId} 계정 제거는 Runner 호스트의 로컬 로그인 관리에서 처리하세요.`);
            }}
          />
          {providerNotice && (
            <p className="runner-test-message" data-testid="provider-accounts-notice" role="status">
              {providerNotice}
            </p>
          )}
          <div className="runner-actions">
            <button type="button" data-testid="runner-connection-test" className="primary" disabled={busy} onClick={() => void onTest()}>
              연결 테스트
            </button>
            <button type="button" className="danger" data-testid="runner-revoke" disabled={busy} onClick={() => void onRevoke(selectedRunner.id)}>
              폐기
            </button>
            <button type="button" data-testid="runner-refresh-state" disabled={busy} onClick={() => void refreshRunners().then((list) => {
              const current = list.find((r) => r.id === selectedRunner.id);
              if (current) {
                setSelectedRunner(current);
                if (isRunnerCurrentlyReady(current)) setStep('ready');
                else setStep('active');
              }
            })}>
              상태 새로고침
            </button>
          </div>
          {showReconnectRequired && (
            <div
              className="runner-reconnect-required"
              data-testid="runner-reconnect-required"
              role="status"
            >
              <strong>{RECONNECT_REQUIRED_COPY}</strong>
              <p>{RECONNECT_REQUIRED_DETAIL}</p>
            </div>
          )}
          {testPresentation.kind !== 'none' && (
            <p
              className={
                testPresentation.kind === 'current_pass'
                  ? 'runner-test-message'
                  : testPresentation.kind === 'historical_pass'
                    ? 'runner-test-message runner-test-message-historical'
                    : 'runner-test-message runner-test-message-fail'
              }
              data-testid="runner-test-message"
              data-kind={testPresentation.kind}
              data-passed={testPresentation.kind === 'current_pass' ? 'true' : 'false'}
            >
              {testPresentation.text}
            </p>
          )}
        </section>
      )}

      {showReady && (
        <section className="runner-card runner-ready" data-testid="runner-step-ready">
          <h3>준비 완료</h3>
          <p data-testid="runner-ready-copy">
            Runner와 실행 엔진 확인이 완료되었습니다. 캘린더에서 위임 작업을 시작할 수 있습니다.
          </p>
          <button
            type="button"
            className="primary"
            data-testid="runner-return-calendar"
            onClick={() => onReadyCalendar?.()}
          >
            캘린더로 돌아가기
          </button>
        </section>
      )}

      {step === 'revoked' && (
        <section className="runner-card runner-revoked" data-testid="runner-step-revoked">
          <h3>연결 폐기됨</h3>
          <p data-testid="runner-revoked-banner">
            이 Runner 자격 증명은 폐기되었습니다. 이전 자격 증명으로 연결·heartbeat·capability 보고가 즉시 거부됩니다.
          </p>
          <p data-testid="runner-connection-state" data-state="revoked">
            상태: <strong data-testid="runner-connection-label">Revoked</strong>
          </p>
          {(lastRevoked || selectedRunner)?.fingerprint && (
            <code className="runner-fp" data-testid="runner-revoked-fingerprint">
              {(lastRevoked || selectedRunner)?.fingerprint}
            </code>
          )}
          <div className="runner-actions">
            <button type="button" data-testid="runner-after-revoke-workspace" onClick={() => setStep('workspace')}>
              Runner 목록
            </button>
            <button type="button" className="primary" data-testid="runner-return-calendar-after-revoke" onClick={() => onReadyCalendar?.()}>
              캘린더로 돌아가기
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

export default RunnerSetupPanel;
