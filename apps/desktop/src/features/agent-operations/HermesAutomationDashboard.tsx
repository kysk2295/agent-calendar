import { useEffect, useRef, useState } from 'react';

import {
  hermesAutomationLastStatusLabel,
  hermesAutomationRuntimeLabel,
  hermesAutomationStatusLabel,
} from './hermesAutomation';
import type {
  AgentRosterEntry,
  HermesAutomationJob,
  HermesAutomationUpdateInput,
} from './types';

type AutomationBusyState = 'refresh' | 'save' | 'toggle' | 'delete' | '';

type HermesAutomationDashboardProps = {
  readonly jobs: readonly HermesAutomationJob[];
  readonly agents: readonly AgentRosterEntry[];
  readonly onRefresh: () => Promise<void>;
  readonly onUpdate: (jobId: string, input: HermesAutomationUpdateInput) => Promise<void>;
  readonly onSetEnabled: (jobId: string, enabled: boolean) => Promise<void>;
  readonly onDelete: (jobId: string) => Promise<void>;
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

export function HermesAutomationDashboard(props: HermesAutomationDashboardProps) {
  const [selectedJobId, setSelectedJobId] = useState('');
  const [draft, setDraft] = useState<HermesAutomationUpdateInput>({ name: '', goal: '', agentId: '', schedule: '' });
  const [draftSyncVersion, setDraftSyncVersion] = useState(0);
  const dirtyDraftFieldsRef = useRef<Partial<Record<keyof HermesAutomationUpdateInput, boolean>>>({});
  const draftJobIdRef = useRef('');
  const [busy, setBusy] = useState<AutomationBusyState>('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const selectedJob = props.jobs.find((job) => job.id === selectedJobId) || props.jobs[0];
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
    setDeleteConfirm(false);
  }, [draftSyncVersion, selectedJob?.agentId, selectedJob?.description, selectedJob?.id, selectedJob?.name, selectedJob?.schedule, selectedJobId]);

  const runMutation = async (action: () => Promise<void>, successMessage: string): Promise<boolean> => {
    let accepted = false;
    setError('');
    setNotice('');
    try {
      await action();
      accepted = true;
      await props.onRefresh();
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

  const save = async () => {
    if (!selectedJob || !draft.name.trim() || !draft.schedule.trim()) return;
    setBusy('save');
    const succeeded = await runMutation(
      () => props.onUpdate(selectedJob.id, {
        name: draft.name.trim(),
        goal: draft.goal.trim(),
        agentId: draft.agentId.trim(),
        schedule: draft.schedule.trim(),
      }),
      '변경사항을 저장했습니다.',
    );
    if (succeeded) resetDraftSync();
    setBusy('');
  };

  const toggle = async () => {
    if (!selectedJob || selectedJob.enabled === null) return;
    const enabled = !selectedJob.enabled;
    setBusy('toggle');
    await runMutation(
      () => props.onSetEnabled(selectedJob.id, enabled),
      enabled ? '자동화를 다시 활성화했습니다.' : '자동화를 일시정지했습니다.',
    );
    setBusy('');
  };

  const remove = async () => {
    if (!selectedJob) return;
    setBusy('delete');
    const succeeded = await runMutation(
      () => props.onDelete(selectedJob.id),
      '자동화를 삭제했습니다.',
    );
    if (succeeded) setDeleteConfirm(false);
    setBusy('');
  };

  return (
    <div className="hermes-automations-layout screen-in">
      <aside className="hermes-automation-list" aria-label="Hermes 자동화 목록">
        <header><div><strong>Hermes 자동화</strong><span>연결된 반복 작업</span></div><b>{props.jobs.length}</b></header>
        {props.jobs.map((job) => (
          <button className="hermes-automation-row" type="button" aria-label={`${job.name} 자동화 열기`} data-active={selectedJob?.id === job.id} key={job.id} onClick={() => { dirtyDraftFieldsRef.current = {}; draftJobIdRef.current = job.id; setSelectedJobId(job.id); setDraftSyncVersion((current) => current + 1); }}>
            <i data-status={job.status} /><span><strong>{job.name}</strong><small>{job.agentId} · {job.schedule}</small><small>다음 실행 {formatRunAt(job.nextRunAt)}</small></span><b>{hermesAutomationStatusLabel(job.status)}</b>
          </button>
        ))}
        {!props.jobs.length && <div className="agent-operation-empty">연결된 Hermes 자동화가 없습니다.</div>}
        <button className="hermes-automation-refresh" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>{busy === 'refresh' ? '불러오는 중' : '목록 새로고침'}</button>
      </aside>

      {selectedJob ? (
        <section className="hermes-automation-inspector" aria-labelledby="hermes-automation-title">
          <header><div><span>Hermes cron job</span><h2 id="hermes-automation-title">{selectedJob.name}</h2><p>{selectedJob.description || '이 자동화의 목적 설명이 아직 없습니다.'}</p></div><strong data-status={selectedJob.status}>{hermesAutomationStatusLabel(selectedJob.status)}</strong></header>

          {(notice || error) && <div className="hermes-automation-feedback" data-error={Boolean(error)} role={error ? 'alert' : 'status'}>{error || notice}</div>}

          <div className="hermes-automation-runtime"><span>실행 위치</span><strong>{hermesAutomationRuntimeLabel(selectedJob.source)}</strong><small>{selectedJob.source}</small></div>
          <div className="hermes-automation-facts">
            <section><span>마지막 실행</span><strong>{formatRunAt(selectedJob.lastRunAt)}</strong><small>{hermesAutomationLastStatusLabel(selectedJob.lastStatus)}</small></section>
            <section><span>다음 실행</span><strong>{formatRunAt(selectedJob.nextRunAt)}</strong><small>{selectedJob.enabled === true ? '자동 실행 예정' : selectedJob.enabled === false ? '현재 일시정지' : '활성 여부 확인 필요'}</small></section>
          </div>

          <form className="hermes-automation-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label><span>이름</span><input aria-label="자동화 이름" value={draft.name} onChange={(event) => updateDraftField('name', event.target.value)} required /></label>
            <label><span>담당 프로필</span><input aria-label="담당 프로필" list="hermes-agent-profiles" value={draft.agentId} onChange={(event) => updateDraftField('agentId', event.target.value)} /><datalist id="hermes-agent-profiles">{props.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</datalist></label>
            <label className="wide"><span>목표</span><textarea aria-label="자동화 목표" value={draft.goal} onChange={(event) => updateDraftField('goal', event.target.value)} rows={4} /></label>
            <label className="wide"><span>실행 일정</span><input aria-label="실행 일정" value={draft.schedule} onChange={(event) => updateDraftField('schedule', event.target.value)} placeholder="예: 0 9 * * 1 또는 every 6h" required /></label>
            <footer><button className="primary" type="submit" disabled={Boolean(busy) || !draft.name.trim() || !draft.schedule.trim()}>{busy === 'save' ? '저장 중' : '변경사항 저장'}</button></footer>
          </form>

          <section className="hermes-automation-actions" aria-label="자동화 상태와 삭제">
            <div><span>자동 실행</span><p>중지하면 설정은 유지되고 다음 실행부터 시작되지 않습니다.</p></div>
            {selectedJob.enabled === null
              ? <button type="button" disabled>상태 확인 필요</button>
              : <button type="button" disabled={Boolean(busy)} onClick={() => void toggle()}>{selectedJob.enabled ? '일시정지' : '다시 활성화'}</button>}
            {!deleteConfirm
              ? <button className="danger" type="button" disabled={Boolean(busy)} onClick={() => { setNotice(''); setError(''); setDeleteConfirm(true); }}>자동화 삭제</button>
              : <div className="hermes-automation-delete-confirm" role="group" aria-label="자동화 삭제 확인"><span>삭제하면 복구할 수 없습니다.</span><button type="button" onClick={() => setDeleteConfirm(false)}>취소</button><button className="danger" type="button" disabled={busy === 'delete'} onClick={() => void remove()}>{busy === 'delete' ? '삭제 중' : '삭제 확인'}</button></div>}
          </section>
        </section>
      ) : <div className="agent-operation-empty large">자동화를 연결하면 여기에서 설정과 상태를 관리할 수 있습니다.</div>}
    </div>
  );
}
