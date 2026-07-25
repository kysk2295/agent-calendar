import { useEffect, useMemo, useRef, useState } from 'react';

import {
  hermesAutomationLastStatusLabel,
  hermesAutomationStatusLabel,
} from './hermesAutomation';
import type { PublicRunner } from '../runner/runnerApi';
import type {
  AgentRosterEntry,
  ConnectedAutomationSource,
  HermesAutomationJob,
  HermesAutomationUpdateInput,
} from './types';

type AutomationBusyState = 'refresh' | 'connect' | 'sync' | 'create' | 'save' | 'toggle' | 'run' | 'approve' | '';
type AutomationPanel = 'connect' | 'create' | '';
type AutomationMutationOutcome = { readonly approvalId?: string };

type AutomationSourceConnectInput = {
  readonly runnerId: string;
  readonly adapterKind: string;
  readonly displayName: string;
};

type AutomationCreateInput = HermesAutomationUpdateInput & {
  readonly sourceId: string;
};

type HermesAutomationDashboardProps = {
  readonly sources: readonly ConnectedAutomationSource[];
  readonly runners: readonly PublicRunner[];
  readonly jobs: readonly HermesAutomationJob[];
  readonly agents: readonly AgentRosterEntry[];
  readonly onRefresh: () => Promise<void>;
  readonly onConnect: (input: AutomationSourceConnectInput) => Promise<void>;
  readonly onSync: (sourceId: string) => Promise<void>;
  readonly onCreate: (input: AutomationCreateInput) => Promise<AutomationMutationOutcome>;
  readonly onUpdate: (job: HermesAutomationJob, input: HermesAutomationUpdateInput) => Promise<AutomationMutationOutcome>;
  readonly onSetEnabled: (job: HermesAutomationJob, enabled: boolean) => Promise<AutomationMutationOutcome>;
  readonly onRun: (job: HermesAutomationJob) => Promise<AutomationMutationOutcome>;
  readonly onApprove: (changeId: string) => Promise<void>;
};

function formatRunAt(value: string): string {
  if (!value) return '확인 필요';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function sourceStatusLabel(source: ConnectedAutomationSource): string {
  if (source.status === 'connected') return '연결됨';
  if (source.status === 'stale') return '동기화 필요';
  if (source.status === 'disconnected') return '연결 끊김';
  return '오류';
}

function sourceFreshnessLabel(source: ConnectedAutomationSource): string {
  if (!source.lastSyncedAt) return '아직 동기화하지 않음';
  const staleAt = new Date(source.staleAfter).getTime();
  if (Number.isFinite(staleAt) && staleAt < Date.now()) return `마지막 동기화 ${formatRunAt(source.lastSyncedAt)}`;
  return `최신 상태 ${formatRunAt(source.lastSyncedAt)}`;
}

function receiptStatusLabel(job: HermesAutomationJob): string {
  if (!job.lastReceipt) return '아직 변경 영수증이 없습니다.';
  if (job.lastReceipt.status === 'succeeded') return '출처 확인 완료';
  if (job.lastReceipt.status === 'unknown') return '출처 응답 확인 필요';
  if (job.lastReceipt.status === 'conflict') return '출처 버전 충돌';
  return '출처 적용 실패';
}

function runnerLabel(runner: PublicRunner): string {
  const metadata = runner.hostMetadata || {};
  const hostname = typeof metadata.hostname === 'string'
    ? metadata.hostname
    : typeof metadata.name === 'string'
      ? metadata.name
      : '';
  return hostname || runner.id;
}

function runnerAutomationKinds(runner: PublicRunner | undefined): readonly string[] {
  const capabilities = runner?.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return [];
  const value = capabilities.automationSources;
  return Array.isArray(value)
    ? value.filter((kind): kind is string => typeof kind === 'string' && Boolean(kind.trim()))
    : [];
}

export function HermesAutomationDashboard(props: HermesAutomationDashboardProps) {
  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [panel, setPanel] = useState<AutomationPanel>('');
  const [draft, setDraft] = useState<HermesAutomationUpdateInput>({ name: '', goal: '', agentId: '', schedule: '' });
  const [createDraft, setCreateDraft] = useState<AutomationCreateInput>({
    sourceId: '',
    name: '',
    goal: '',
    agentId: '',
    schedule: '',
  });
  const [connectDraft, setConnectDraft] = useState({ runnerId: '', displayName: '' });
  const [draftSyncVersion, setDraftSyncVersion] = useState(0);
  const dirtyDraftFieldsRef = useRef<Partial<Record<keyof HermesAutomationUpdateInput, boolean>>>({});
  const draftJobIdRef = useRef('');
  const initialRefreshRef = useRef(false);
  const [busy, setBusy] = useState<AutomationBusyState>('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [pendingApprovalId, setPendingApprovalId] = useState('');
  const selectedSource = props.sources.find((source) => source.id === selectedSourceId)
    || props.sources[0];
  const visibleJobs = useMemo(
    () => selectedSource ? props.jobs.filter((job) => job.sourceId === selectedSource.id) : props.jobs,
    [props.jobs, selectedSource],
  );
  const selectedJob = visibleJobs.find((job) => job.id === selectedJobId)
    || visibleJobs.find((job) => Boolean(job.lastReceipt))
    || visibleJobs[0];
  const selectedRunner = props.runners.find((runner) => runner.id === connectDraft.runnerId);
  const adapterKind = runnerAutomationKinds(selectedRunner)[0] || 'hermes';
  const updateDraftField = (field: keyof HermesAutomationUpdateInput, value: string) => {
    if (selectedJob) draftJobIdRef.current = selectedJob.id;
    dirtyDraftFieldsRef.current = { ...dirtyDraftFieldsRef.current, [field]: true };
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const resetDraftSync = () => {
    dirtyDraftFieldsRef.current = {};
    setDraftSyncVersion((current) => current + 1);
  };

  useEffect(() => {
    if (initialRefreshRef.current) return;
    initialRefreshRef.current = true;
    void props.onRefresh().catch((refreshError: unknown) => {
      setError(refreshError instanceof Error ? refreshError.message : '자동화 상태를 불러오지 못했습니다.');
    });
  }, [props.onRefresh]);

  useEffect(() => {
    if (!selectedSource) {
      setSelectedSourceId('');
      return;
    }
    setSelectedSourceId(selectedSource.id);
    setCreateDraft((current) => current.sourceId ? current : { ...current, sourceId: selectedSource.id });
  }, [selectedSource?.id]);

  useEffect(() => {
    if (connectDraft.runnerId || !props.runners.length) return;
    setConnectDraft((current) => ({ ...current, runnerId: props.runners[0].id }));
  }, [connectDraft.runnerId, props.runners]);

  useEffect(() => {
    if (!selectedJob) {
      setSelectedJobId('');
      setDraft({ name: '', goal: '', agentId: '', schedule: '' });
      dirtyDraftFieldsRef.current = {};
      draftJobIdRef.current = '';
      return;
    }
    const sameDraftJob = selectedJob.id === draftJobIdRef.current;
    const dirtyFields = sameDraftJob ? dirtyDraftFieldsRef.current : {};
    setSelectedJobId(selectedJob.id);
    draftJobIdRef.current = selectedJob.id;
    if (!sameDraftJob) dirtyDraftFieldsRef.current = {};
    setDraft((current) => ({
      name: dirtyFields.name ? current.name : selectedJob.name,
      goal: dirtyFields.goal ? current.goal : selectedJob.description,
      agentId: dirtyFields.agentId ? current.agentId : selectedJob.agentId === '확인 필요' ? '' : selectedJob.agentId,
      schedule: dirtyFields.schedule ? current.schedule : selectedJob.schedule === '일정 확인 필요' ? '' : selectedJob.schedule,
    }));
  }, [draftSyncVersion, selectedJob?.agentId, selectedJob?.description, selectedJob?.id, selectedJob?.name, selectedJob?.schedule, selectedJobId]);

  const runMutation = async (
    action: () => Promise<void | AutomationMutationOutcome>,
    successMessage: string,
  ): Promise<boolean> => {
    let accepted = false;
    setError('');
    setNotice('');
    try {
      const outcome = await action();
      accepted = true;
      await props.onRefresh();
      if (outcome && outcome.approvalId) {
        setPendingApprovalId(outcome.approvalId);
        setNotice('이 변경은 승인 후 출처에 적용됩니다.');
        return false;
      }
      setNotice(successMessage);
      return true;
    } catch (mutationError) {
      if (!(mutationError instanceof Error)) throw mutationError;
      setError(accepted
        ? '요청은 처리됐지만 최신 자동화 목록을 불러오지 못했습니다. 새로고침해 주세요.'
        : mutationError.message);
      return false;
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setError('');
    setNotice('');
    try {
      await props.onRefresh();
      setNotice('최신 자동화 목록을 불러왔습니다.');
    } catch (refreshError) {
      if (!(refreshError instanceof Error)) throw refreshError;
      setError(refreshError.message);
    } finally {
      setBusy('');
    }
  };

  const connect = async () => {
    if (!connectDraft.runnerId || !connectDraft.displayName.trim()) return;
    setBusy('connect');
    const succeeded = await runMutation(
      () => props.onConnect({
        runnerId: connectDraft.runnerId,
        adapterKind,
        displayName: connectDraft.displayName.trim(),
      }),
      '소스를 연결하고 자동화를 동기화했습니다.',
    );
    if (succeeded) {
      setPanel('');
      setConnectDraft((current) => ({ ...current, displayName: '' }));
    }
    setBusy('');
  };

  const sync = async (sourceId: string) => {
    setBusy('sync');
    await runMutation(
      () => props.onSync(sourceId),
      '출처의 최신 자동화를 동기화했습니다.',
    );
    setBusy('');
  };

  const create = async () => {
    if (!createDraft.sourceId || !createDraft.name.trim() || !createDraft.schedule.trim()) return;
    setBusy('create');
    const succeeded = await runMutation(
      () => props.onCreate({
        sourceId: createDraft.sourceId,
        name: createDraft.name.trim(),
        goal: createDraft.goal.trim(),
        agentId: createDraft.agentId.trim(),
        schedule: createDraft.schedule.trim(),
      }),
      '자동화를 만들었습니다. 안전을 위해 일시정지 상태로 시작합니다.',
    );
    if (succeeded) {
      setPanel('');
      setCreateDraft((current) => ({
        sourceId: current.sourceId,
        name: '',
        goal: '',
        agentId: '',
        schedule: '',
      }));
    }
    setBusy('');
  };

  const approvePending = async () => {
    if (!pendingApprovalId) return;
    setBusy('approve');
    const succeeded = await runMutation(
      () => props.onApprove(pendingApprovalId),
      '승인한 변경을 출처에서 확인했습니다.',
    );
    if (succeeded) {
      setPendingApprovalId('');
      setPanel('');
      setCreateDraft((current) => ({
        sourceId: current.sourceId,
        name: '',
        goal: '',
        agentId: '',
        schedule: '',
      }));
      resetDraftSync();
    }
    setBusy('');
  };

  const approvalGate = pendingApprovalId ? (
    <section className="automation-approval-gate" aria-label="자동화 변경 승인">
      <div>
        <strong>승인이 필요한 변경입니다.</strong>
        <p>새 권한, 추가 비용, 외부 전달이 포함된 변경은 사용자가 직접 승인해야 합니다.</p>
      </div>
      <button type="button" disabled={Boolean(busy)} onClick={() => void approvePending()}>
        {busy === 'approve' ? '적용 중' : '승인하고 적용'}
      </button>
    </section>
  ) : null;

  const save = async () => {
    if (!selectedJob || !draft.name.trim() || !draft.schedule.trim()) return;
    setBusy('save');
    const succeeded = await runMutation(
      () => props.onUpdate(selectedJob, {
        name: draft.name.trim(),
        goal: draft.goal.trim(),
        agentId: draft.agentId.trim(),
        schedule: draft.schedule.trim(),
      }),
      '출처에서 변경을 확인했습니다.',
    );
    if (succeeded) resetDraftSync();
    setBusy('');
  };

  const toggle = async () => {
    if (!selectedJob || selectedJob.enabled === null) return;
    const enabled = !selectedJob.enabled;
    setBusy('toggle');
    await runMutation(
      () => props.onSetEnabled(selectedJob, enabled),
      enabled ? '자동화를 다시 활성화했습니다.' : '자동화를 일시정지했습니다.',
    );
    setBusy('');
  };

  const runNow = async () => {
    if (!selectedJob) return;
    setBusy('run');
    await runMutation(
      () => props.onRun(selectedJob),
      '출처에서 실행 요청을 확인했습니다.',
    );
    setBusy('');
  };

  return (
    <div className="connected-automations-layout screen-in">
      <aside className="automation-source-rail" aria-label="자동화 소스">
        <header>
          <div>
            <strong>자동화 소스</strong>
            <span>내 Runner에서 실행됩니다</span>
          </div>
          <b>{props.sources.length}</b>
        </header>

        <div className="automation-source-list">
          {props.sources.map((source) => (
            <section className="automation-source-card" data-active={selectedSource?.id === source.id} key={source.id}>
              <button type="button" onClick={() => {
                setSelectedSourceId(source.id);
                setSelectedJobId('');
                setPanel('');
              }}>
                <span>
                  <strong>{`${source.displayName} ${sourceStatusLabel(source)}`}</strong>
                  <small>{source.adapterKind} · {sourceFreshnessLabel(source)}</small>
                </span>
                <i data-status={source.status} aria-hidden="true" />
              </button>
              <footer>
                <span>{source.runnerId}</span>
                <button type="button" disabled={Boolean(busy)} onClick={() => void sync(source.id)}>
                  {busy === 'sync' && selectedSource?.id === source.id ? '동기화 중' : '동기화'}
                </button>
              </footer>
            </section>
          ))}
        </div>

        {!props.sources.length && (
          <div className="automation-source-empty">
            <strong>연결된 소스가 없습니다.</strong>
            <p>계정에 등록된 Runner를 선택해 기존 자동화를 가져오세요.</p>
          </div>
        )}

        {panel === 'connect' && (
          <form className="automation-inline-form source-connect-form" onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}>
            <header>
              <strong>Runner에 소스 연결</strong>
              <button type="button" onClick={() => setPanel('')}>닫기</button>
            </header>
            <label>
              <span>연결할 Runner</span>
              <select aria-label="연결할 Runner" value={connectDraft.runnerId} onChange={(event) => setConnectDraft((current) => ({ ...current, runnerId: event.target.value }))} required>
                <option value="">Runner 선택</option>
                {props.runners.map((runner) => <option value={runner.id} key={runner.id}>{runnerLabel(runner)}</option>)}
              </select>
            </label>
            <label>
              <span>소스 이름</span>
              <input aria-label="소스 이름" value={connectDraft.displayName} onChange={(event) => setConnectDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="예: 내 Hermes Runner" required />
            </label>
            <small>{connectDraft.runnerId ? `${adapterKind} 연결을 사용합니다.` : '먼저 계정에 Runner를 등록해 주세요.'}</small>
            <button className="primary" type="submit" disabled={Boolean(busy) || !connectDraft.runnerId || !connectDraft.displayName.trim()}>
              {busy === 'connect' ? '연결 중' : '연결하고 동기화'}
            </button>
          </form>
        )}

        <button className="automation-source-connect" type="button" disabled={panel === 'connect'} onClick={() => {
          setNotice('');
          setError('');
          setPanel('connect');
        }}>자동화 소스 연결</button>
      </aside>

      <section className="automation-queue" aria-label="연결된 자동화">
        <header>
          <div>
            <strong>연결된 자동화</strong>
            <span>{selectedSource?.displayName || '모든 소스'}</span>
          </div>
          <div>
            <button type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>{busy === 'refresh' ? '불러오는 중' : '새로고침'}</button>
            <button className="primary" type="button" disabled={!props.sources.some((source) => source.capabilities.create) || panel === 'create'} onClick={() => {
              const source = selectedSource?.capabilities.create
                ? selectedSource
                : props.sources.find((candidate) => candidate.capabilities.create);
              setCreateDraft((current) => ({ ...current, sourceId: source?.id || '' }));
              setNotice('');
              setError('');
              setPanel('create');
            }}>새 자동화</button>
          </div>
        </header>

        <div className="automation-queue-list">
          {visibleJobs.map((job) => (
            <button className="hermes-automation-row" type="button" aria-label={`${job.name} 자동화 열기`} data-active={selectedJob?.id === job.id && panel !== 'create'} key={job.id} onClick={() => {
              dirtyDraftFieldsRef.current = {};
              draftJobIdRef.current = job.id;
              setSelectedJobId(job.id);
              setPanel('');
              setDraftSyncVersion((current) => current + 1);
            }}>
              <i data-status={job.status} aria-hidden="true" />
              <span>
                <strong>{job.name}</strong>
                <small>{job.schedule}</small>
                <small>{job.source} · 다음 {formatRunAt(job.nextRunAt)}</small>
              </span>
              <b>{hermesAutomationStatusLabel(job.status)}</b>
            </button>
          ))}
        </div>

        {!visibleJobs.length && <div className="agent-operation-empty">연결된 자동화가 없습니다.</div>}
      </section>

      {panel === 'create' ? (
        <section className="hermes-automation-inspector automation-create-inspector" aria-labelledby="automation-create-title">
          <header>
            <div>
              <span>새 연결 자동화</span>
              <h2 id="automation-create-title">출처에 자동화 만들기</h2>
              <p>새 자동화는 검토할 수 있도록 일시정지 상태로 시작합니다.</p>
            </div>
            <button type="button" onClick={() => setPanel('')}>닫기</button>
          </header>

          {(notice || error) && <div className="hermes-automation-feedback" data-error={Boolean(error)} role={error ? 'alert' : 'status'}>{error || notice}</div>}
          {approvalGate}

          <form className="hermes-automation-form" onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}>
            <label>
              <span>자동화 소스</span>
              <select aria-label="자동화 소스" value={createDraft.sourceId} onChange={(event) => setCreateDraft((current) => ({ ...current, sourceId: event.target.value }))} required>
                {props.sources.filter((source) => source.capabilities.create).map((source) => <option value={source.id} key={source.id}>{source.displayName}</option>)}
              </select>
            </label>
            <label><span>이름</span><input aria-label="자동화 이름" value={createDraft.name} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} required /></label>
            <label><span>담당 프로필</span><input aria-label="담당 프로필" list="connected-automation-agent-profiles" value={createDraft.agentId} onChange={(event) => setCreateDraft((current) => ({ ...current, agentId: event.target.value }))} /><datalist id="connected-automation-agent-profiles">{props.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</datalist></label>
            <label className="wide"><span>목표</span><textarea aria-label="자동화 목표" value={createDraft.goal} onChange={(event) => setCreateDraft((current) => ({ ...current, goal: event.target.value }))} rows={4} /></label>
            <label className="wide"><span>실행 일정</span><input aria-label="실행 일정" value={createDraft.schedule} onChange={(event) => setCreateDraft((current) => ({ ...current, schedule: event.target.value }))} placeholder="예: 0 9 * * 1 또는 every 6h" required /></label>
            <footer><button className="primary" type="submit" disabled={Boolean(busy) || !createDraft.sourceId || !createDraft.name.trim() || !createDraft.schedule.trim()}>{busy === 'create' ? '만드는 중' : '자동화 만들기'}</button></footer>
          </form>
        </section>
      ) : selectedJob ? (
        <section className="hermes-automation-inspector" aria-labelledby="hermes-automation-title">
          <header>
            <div>
              <span>{selectedJob.source}</span>
              <h2 id="hermes-automation-title">{selectedJob.name}</h2>
              <p>{selectedJob.description || '이 자동화의 목적 설명이 아직 없습니다.'}</p>
            </div>
            <strong data-status={selectedJob.status}>{hermesAutomationStatusLabel(selectedJob.status)}</strong>
          </header>

          {(notice || error) && <div className="hermes-automation-feedback" data-error={Boolean(error)} role={error ? 'alert' : 'status'}>{error || notice}</div>}
          {approvalGate}

          <div className="automation-receipt" data-status={selectedJob.lastReceipt?.status || 'none'}>
            <div>
              <span>최근 출처 영수증</span>
              <strong>{receiptStatusLabel(selectedJob)}</strong>
            </div>
            <small>{selectedJob.lastReceipt ? `${selectedJob.lastReceipt.operation} · ${formatRunAt(selectedJob.lastReceipt.createdAt)}` : '변경하거나 실행하면 출처의 결과가 여기에 남습니다.'}</small>
          </div>

          <div className="hermes-automation-facts">
            <section><span>마지막 실행</span><strong>{formatRunAt(selectedJob.lastRunAt)}</strong><small>{hermesAutomationLastStatusLabel(selectedJob.lastStatus)}</small></section>
            <section><span>다음 실행</span><strong>{formatRunAt(selectedJob.nextRunAt)}</strong><small>{selectedJob.enabled === true ? '자동 실행 예정' : selectedJob.enabled === false ? '현재 일시정지' : '활성 여부 확인 필요'}</small></section>
            <section><span>출처 상태</span><strong>{selectedJob.sourceStatus || '확인 필요'}</strong><small>{selectedJob.lastSyncedAt ? formatRunAt(selectedJob.lastSyncedAt) : '동기화 기록 없음'}</small></section>
            <section><span>출처 버전</span><strong>{selectedJob.sourceRevision || '확인 필요'}</strong><small>출처와 충돌을 막는 기준</small></section>
          </div>

          <form className="hermes-automation-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label><span>이름</span><input aria-label="자동화 이름" value={draft.name} onChange={(event) => updateDraftField('name', event.target.value)} disabled={!selectedJob.capabilities.update} required /></label>
            <label><span>담당 프로필</span><input aria-label="담당 프로필" list="hermes-agent-profiles" value={draft.agentId} onChange={(event) => updateDraftField('agentId', event.target.value)} /><datalist id="hermes-agent-profiles">{props.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</datalist></label>
            <label className="wide"><span>목표</span><textarea aria-label="자동화 목표" value={draft.goal} onChange={(event) => updateDraftField('goal', event.target.value)} disabled={!selectedJob.capabilities.update} rows={4} /></label>
            <label className="wide"><span>실행 일정</span><input aria-label="실행 일정" value={draft.schedule} onChange={(event) => updateDraftField('schedule', event.target.value)} disabled={!selectedJob.capabilities.update} placeholder="예: 0 9 * * 1 또는 every 6h" required /></label>
            <footer><button className="primary" type="submit" disabled={Boolean(busy) || !selectedJob.capabilities.update || !draft.name.trim() || !draft.schedule.trim()}>{busy === 'save' ? '저장 중' : '변경사항 저장'}</button></footer>
          </form>

          <section className="hermes-automation-actions" aria-label="자동화 실행 제어">
            <div><span>출처 실행 제어</span><p>실행과 일정은 연결된 출처가 담당하고, 결과는 영수증으로 확인합니다.</p></div>
            <button type="button" disabled={Boolean(busy) || !selectedJob.capabilities.run} onClick={() => void runNow()}>{busy === 'run' ? '요청 중' : '지금 실행'}</button>
            {selectedJob.enabled === null
              ? <button type="button" disabled>상태 확인 필요</button>
              : <button type="button" disabled={Boolean(busy) || (selectedJob.enabled ? !selectedJob.capabilities.pause : !selectedJob.capabilities.resume)} onClick={() => void toggle()}>{selectedJob.enabled ? '일시정지' : '다시 활성화'}</button>}
          </section>
        </section>
      ) : (
        <section className="automation-inspector-empty">
          <strong>자동화를 선택하세요.</strong>
          <p>연결된 자동화의 일정, 실행 상태, 출처 영수증을 여기에서 확인할 수 있습니다.</p>
        </section>
      )}
    </div>
  );
}
