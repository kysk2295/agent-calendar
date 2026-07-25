import { useMemo, useState } from 'react';
import {
  Archive,
  ChatsCircle,
  DownloadSimple,
  LinkSimple,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  X,
} from '@phosphor-icons/react';

import {
  agentConnectionLabel,
  agentSourceLabel,
  groupAgentDirectory,
  isAgentSelectable,
} from '../../domains/agent-work/agentRoster';
import type { PublicRunner } from '../runner/runnerApi';
import type {
  AgentCatalogRequest,
  AgentDirectoryMutationInput,
  AgentExecutionEngine,
  AgentRosterEntry,
  ProviderAgentSession,
  ProviderSessionCatalogRequest,
  ProviderSessionImportResult,
} from './types';

type AgentDirectoryPanelProps = {
  readonly agents: readonly AgentRosterEntry[];
  readonly runners: readonly PublicRunner[];
  readonly selectedAgentId: string;
  readonly runnerConnected: boolean;
  readonly busy: boolean;
  readonly onSelect: (agentId: string) => void;
  readonly onCreate: (input: AgentDirectoryMutationInput) => Promise<boolean>;
  readonly onUpdate: (agentId: string, input: AgentDirectoryMutationInput) => Promise<boolean>;
  readonly onRequestAgentCatalog: (input: Readonly<{ runnerId: string; provider: string; consent: true }>) => Promise<AgentCatalogRequest | null>;
  readonly onGetAgentCatalogRequest: (requestId: string) => Promise<AgentCatalogRequest | null>;
  readonly onImportAgentCatalogEntry: (requestId: string, input: Readonly<{ externalAgentId: string; defaultExecutionEngine: AgentExecutionEngine }>) => Promise<boolean>;
  readonly onRequestProviderSessionCatalog: (agentId: string, input: Readonly<{ runnerId: string; consent: true }>) => Promise<ProviderSessionCatalogRequest | null>;
  readonly onImportProviderSessionCatalogEntry: (agentId: string, requestId: string, externalSessionId: string) => Promise<ProviderSessionImportResult | null>;
  readonly onImportedProviderSession: (result: ProviderSessionImportResult) => void;
  readonly providerSessions: readonly ProviderAgentSession[];
  readonly providerSessionsLoading: boolean;
  readonly providerSessionSearch: string;
  readonly showArchivedProviderSessions: boolean;
  readonly onProviderSessionSearch: (value: string) => void;
  readonly onShowArchivedProviderSessions: (value: boolean) => void;
  readonly onOpenProviderSession: (session: ProviderAgentSession) => void;
  readonly onNewProviderSession: () => void;
  readonly onRenameProviderSession: (sessionId: string, title: string) => Promise<void>;
  readonly onArchiveProviderSession: (sessionId: string) => Promise<void>;
};

type EditorMode = '' | 'create' | 'import' | 'sessions' | 'connect' | 'edit';

type AgentFormState = {
  readonly displayName: string;
  readonly role: string;
  readonly responsibility: string;
  readonly instructions: string;
  readonly specialties: string;
  readonly provider: string;
  readonly externalAgentId: string;
  readonly defaultExecutionEngine: AgentExecutionEngine;
  readonly defaultRunnerId: string;
};

const EMPTY_FORM: AgentFormState = {
  displayName: '',
  role: '',
  responsibility: '',
  instructions: '',
  specialties: '',
  provider: 'hermes',
  externalAgentId: '',
  defaultExecutionEngine: 'auto',
  defaultRunnerId: '',
};

const ENGINE_OPTIONS: readonly Readonly<{ value: AgentExecutionEngine; label: string }>[] = [
  { value: 'auto', label: '자동' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'grok', label: 'Grok' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'local_llm', label: '로컬 LLM' },
];

function recordValue(agent: AgentRosterEntry) {
  return agent as unknown as Record<string, unknown>;
}

function formFromAgent(agent: AgentRosterEntry): AgentFormState {
  return {
    displayName: agent.displayName,
    role: agent.role,
    responsibility: agent.responsibility || '',
    instructions: agent.instructions || '',
    specialties: (agent.specialties || agent.allowedTaskClasses).join(', '),
    provider: agent.provider || 'external',
    externalAgentId: agent.externalAgentId || '',
    defaultExecutionEngine: agent.defaultExecutionEngine || 'auto',
    defaultRunnerId: agent.defaultRunnerId || '',
  };
}

function mutationInput(form: AgentFormState, sourceKind: 'native' | 'connected'): AgentDirectoryMutationInput {
  return {
    displayName: form.displayName.trim(),
    role: form.role.trim(),
    responsibility: form.responsibility.trim(),
    instructions: form.instructions.trim(),
    specialties: form.specialties.split(',').map((value) => value.trim()).filter(Boolean),
    sourceKind,
    provider: sourceKind === 'native' ? 'agent-calendar' : form.provider.trim().toLowerCase(),
    externalAgentId: sourceKind === 'native' ? '' : form.externalAgentId.trim(),
    defaultExecutionEngine: form.defaultExecutionEngine,
    defaultRunnerId: form.defaultRunnerId,
  };
}

function runnerLabel(runner: PublicRunner): string {
  const host = runner.hostMetadata && typeof runner.hostMetadata.hostname === 'string'
    ? runner.hostMetadata.hostname
    : '';
  return host || runner.id;
}

function providerSessionState(session: ProviderAgentSession): Readonly<{
  label: string;
  detail: string;
  resumable: boolean;
}> {
  switch (session.status) {
    case 'active':
    case 'pending':
      return { label: session.status === 'active' ? '연결됨' : '시작 대기', detail: '', resumable: true };
    case 'auth_required':
      return { label: '인증 필요', detail: 'Runner의 provider 인증이 만료되었습니다. 인증 후 다시 열거나 새 세션을 시작할 수 있습니다.', resumable: false };
    case 'missing':
    case 'deleted':
      return { label: '세션 없음', detail: 'provider 세션을 찾을 수 없습니다. 기존 대화는 보존되며 새 세션을 시작할 수 있습니다.', resumable: false };
    case 'quota_exhausted':
      return { label: '한도 도달', detail: 'provider 사용량 한도에 도달했습니다. 한도 복구 후 다시 열거나 새 세션을 시작할 수 있습니다.', resumable: false };
    case 'archived':
      return { label: '보관됨', detail: '보관된 세션입니다. 기존 대화는 읽을 수 있지만 provider 실행은 재개하지 않습니다.', resumable: false };
    default:
      return { label: '연결 확인 필요', detail: 'Runner 또는 provider 상태를 확인한 뒤 다시 시도하거나 새 세션을 시작할 수 있습니다.', resumable: false };
  }
}

function AgentSessionRail(props: Pick<
  AgentDirectoryPanelProps,
  | 'providerSessions'
  | 'providerSessionsLoading'
  | 'providerSessionSearch'
  | 'showArchivedProviderSessions'
  | 'onProviderSessionSearch'
  | 'onShowArchivedProviderSessions'
  | 'onOpenProviderSession'
  | 'onNewProviderSession'
  | 'onRenameProviderSession'
  | 'onArchiveProviderSession'
> & {
  readonly onImportExistingSession: () => void;
}) {
  const [renamingId, setRenamingId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [expandedStatusId, setExpandedStatusId] = useState('');
  const saveRename = async (session: ProviderAgentSession) => {
    const title = renameValue.trim();
    if (!title || title === session.title) {
      setRenamingId('');
      return;
    }
    await props.onRenameProviderSession(session.id, title);
    setRenamingId('');
  };
  return (
    <section className="agent-session-rail" aria-label="에이전트 세션">
      <header>
        <strong>세션</strong>
        <button type="button" onClick={props.onImportExistingSession}>
          <DownloadSimple size={12} aria-hidden="true" />
          기존 세션
        </button>
        <button type="button" onClick={props.onNewProviderSession}>
          <Plus size={12} weight="bold" aria-hidden="true" />
          새 세션
        </button>
      </header>
      <label className="agent-session-search">
        <MagnifyingGlass size={13} aria-hidden="true" />
        <input
          aria-label="세션 검색"
          value={props.providerSessionSearch}
          onChange={(event) => props.onProviderSessionSearch(event.target.value)}
          placeholder="세션 검색"
        />
      </label>
      <label className="agent-session-archived-toggle">
        <input
          type="checkbox"
          checked={props.showArchivedProviderSessions}
          onChange={(event) => props.onShowArchivedProviderSessions(event.target.checked)}
        />
        보관된 세션 포함
      </label>
      <div className="agent-session-list">
        {props.providerSessionsLoading && <p>세션을 확인하고 있습니다.</p>}
        {!props.providerSessionsLoading && !props.providerSessions.length && <p>이 에이전트의 세션이 없습니다.</p>}
        {props.providerSessions.map((session) => {
          const state = providerSessionState(session);
          const expanded = expandedStatusId === session.id;
          return (
            <article className="agent-session-row" data-resumable={state.resumable} key={session.id}>
              {renamingId === session.id ? (
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void saveRename(session);
                }}>
                  <input
                    aria-label="세션 이름"
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                  <button type="submit">저장</button>
                </form>
              ) : (
                <button
                  className="agent-session-open"
                  type="button"
                  disabled={!state.resumable}
                  onClick={() => props.onOpenProviderSession(session)}
                >
                  <ChatsCircle size={14} aria-hidden="true" />
                  <span>
                    <strong>{session.title || '제목 없는 세션'}</strong>
                    <small>{session.engine} / {state.label}</small>
                  </span>
                </button>
              )}
              <div className="agent-session-actions">
                {!state.resumable && (
                  <button
                    type="button"
                    aria-label="세션 상태"
                    onClick={() => setExpandedStatusId(expanded ? '' : session.id)}
                  >
                    상태
                  </button>
                )}
                <button
                  type="button"
                  aria-label="이름 변경"
                  onClick={() => {
                    setRenameValue(session.title);
                    setRenamingId(session.id);
                  }}
                >
                  <PencilSimple size={12} aria-hidden="true" />
                </button>
                {session.status !== 'archived' && (
                  <button type="button" aria-label="보관" onClick={() => void props.onArchiveProviderSession(session.id)}>
                    <Archive size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
              {expanded && state.detail && <p className="agent-session-state-detail">{state.detail}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AgentDirectoryRow({
  agent,
  selected,
  runnerConnected,
  onSelect,
}: {
  readonly agent: AgentRosterEntry;
  readonly selected: boolean;
  readonly runnerConnected: boolean;
  readonly onSelect: () => void;
}) {
  const record = recordValue(agent);
  const status = agentConnectionLabel(record, { runnerConnected });
  const available = isAgentSelectable(record, { runnerConnected });
  return (
    <button
      className="agent-directory-row"
      data-selected={selected}
      data-available={available}
      type="button"
      onClick={onSelect}
    >
      <span className="agent-directory-avatar" aria-hidden="true">{agent.emoji || agent.displayName.slice(0, 1).toUpperCase()}</span>
      <span>
        <strong>{agent.displayName}</strong>
        <small>{agent.role || '역할 미설정'}</small>
      </span>
      <i title={status} aria-label={status} />
    </button>
  );
}

export function AgentDirectoryPanel(props: AgentDirectoryPanelProps) {
  const [editorMode, setEditorMode] = useState<EditorMode>('');
  const [form, setForm] = useState<AgentFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [catalogConsent, setCatalogConsent] = useState(false);
  const [catalog, setCatalog] = useState<AgentCatalogRequest | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [sessionCatalogConsent, setSessionCatalogConsent] = useState(false);
  const [sessionCatalog, setSessionCatalog] = useState<ProviderSessionCatalogRequest | null>(null);
  const [sessionCatalogBusy, setSessionCatalogBusy] = useState(false);
  const [sessionCatalogError, setSessionCatalogError] = useState('');
  const groups = useMemo(
    () => groupAgentDirectory(props.agents.map((agent) => recordValue(agent))),
    [props.agents],
  );
  const nativeIds = new Set(groups.native.map((agent) => String(agent.id || '')));
  const connectedIds = new Set(groups.connected.map((agent) => String(agent.id || '')));
  const native = props.agents.filter((agent) => nativeIds.has(agent.id));
  const connected = props.agents.filter((agent) => connectedIds.has(agent.id));
  const selectedAgent = props.agents.find((agent) => agent.id === props.selectedAgentId);
  const selectedSourceKind = selectedAgent?.sourceKind === 'connected' ? 'connected' : 'native';

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setEditorMode('create');
  };
  const openConnect = () => {
    const defaultRunnerId = props.runners.find((runner) => runner.connectionState === 'connected')?.id
      || props.runners[0]?.id
      || '';
    setForm({ ...EMPTY_FORM, defaultRunnerId });
    setCatalogConsent(false);
    setCatalog(null);
    setCatalogError('');
    setEditorMode('import');
  };
  const openManualConnect = () => {
    setCatalog(null);
    setCatalogError('');
    setEditorMode('connect');
  };
  const openEdit = () => {
    if (!selectedAgent) return;
    setForm(formFromAgent(selectedAgent));
    setEditorMode('edit');
  };
  const openSessionImport = () => {
    if (!selectedAgent) return;
    setSessionCatalogConsent(false);
    setSessionCatalog(null);
    setSessionCatalogError('');
    setEditorMode('sessions');
  };
  const closeEditor = () => {
    setEditorMode('');
    setCatalog(null);
    setCatalogError('');
    setSessionCatalog(null);
    setSessionCatalogError('');
  };
  const sourceKind = editorMode === 'connect'
    ? 'connected'
    : editorMode === 'edit'
      ? selectedSourceKind
      : 'native';
  const canSubmit = Boolean(
    form.displayName.trim()
    && (sourceKind === 'native' || (form.provider.trim() && form.externalAgentId.trim())),
  );
  const discoverCatalog = async () => {
    if (!catalogConsent || !form.defaultRunnerId || catalogBusy) return;
    setCatalogBusy(true);
    setCatalogError('');
    try {
      const requested = await props.onRequestAgentCatalog({
        runnerId: form.defaultRunnerId,
        provider: form.provider,
        consent: true,
      });
      if (!requested) {
        setCatalogError('Runner에 목록 요청을 전달하지 못했습니다.');
        return;
      }
      setCatalog(requested);
      let current = requested;
      for (let attempt = 0; attempt < 18 && ['pending', 'running'].includes(current.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const refreshed = await props.onGetAgentCatalogRequest(current.id);
        if (!refreshed) break;
        current = refreshed;
        setCatalog(current);
      }
      if (['pending', 'running'].includes(current.status)) {
        setCatalogError('Runner 응답을 기다리고 있습니다. 잠시 후 다시 확인해 주세요.');
      } else if (current.status === 'failed') {
        setCatalogError(current.errorMessage || 'Runner에서 에이전트 목록을 읽지 못했습니다.');
      }
    } finally {
      setCatalogBusy(false);
    }
  };
  const discoverProviderSessions = async () => {
    if (!selectedAgent || !sessionCatalogConsent || sessionCatalogBusy) return;
    const runnerId = selectedAgent.defaultRunnerId
      || props.runners.find((runner) => runner.connectionState === 'connected')?.id
      || '';
    if (!runnerId) {
      setSessionCatalogError('먼저 이 에이전트의 기본 Runner를 설정해 주세요.');
      return;
    }
    setSessionCatalogBusy(true);
    setSessionCatalogError('');
    try {
      const requested = await props.onRequestProviderSessionCatalog(selectedAgent.id, {
        runnerId,
        consent: true,
      });
      if (!requested) {
        setSessionCatalogError('Runner에 기존 세션 목록 요청을 전달하지 못했습니다.');
        return;
      }
      setSessionCatalog(requested);
      let current = requested;
      for (let attempt = 0; attempt < 18 && ['pending', 'running'].includes(current.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const refreshed = await props.onGetAgentCatalogRequest(current.id);
        if (!refreshed) break;
        current = refreshed as unknown as ProviderSessionCatalogRequest;
        setSessionCatalog(current);
      }
      if (['pending', 'running'].includes(current.status)) {
        setSessionCatalogError('Runner 응답을 기다리고 있습니다. 잠시 후 다시 확인해 주세요.');
      } else if (current.status === 'failed') {
        setSessionCatalogError(current.errorMessage || 'Runner에서 기존 세션 목록을 읽지 못했습니다.');
      }
    } finally {
      setSessionCatalogBusy(false);
    }
  };
  const importProviderSession = async (externalSessionId: string) => {
    if (!selectedAgent || !sessionCatalog || saving) return;
    setSaving(true);
    try {
      const result = await props.onImportProviderSessionCatalogEntry(
        selectedAgent.id,
        sessionCatalog.id,
        externalSessionId,
      );
      if (result) {
        closeEditor();
        props.onImportedProviderSession(result);
      }
    } finally {
      setSaving(false);
    }
  };
  const importCatalogEntry = async (externalAgentId: string, provider: string) => {
    if (!catalog || saving) return;
    setSaving(true);
    try {
      const succeeded = await props.onImportAgentCatalogEntry(catalog.id, {
        externalAgentId,
        defaultExecutionEngine: provider as AgentExecutionEngine,
      });
      if (succeeded) closeEditor();
    } finally {
      setSaving(false);
    }
  };
  const submit = async () => {
    if (!canSubmit || props.busy || saving) return;
    const input = mutationInput(form, sourceKind);
    setSaving(true);
    try {
      const succeeded = editorMode === 'edit' && selectedAgent
        ? await props.onUpdate(selectedAgent.id, input)
        : await props.onCreate(input);
      if (succeeded) closeEditor();
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="agent-directory-panel" aria-label="담당 에이전트 디렉터리">
      <header>
        <span>
          <strong>담당 에이전트</strong>
          <small>{props.agents.length}명</small>
        </span>
        <button type="button" aria-label="에이전트 만들기" onClick={openCreate}>
          <Plus size={15} weight="bold" aria-hidden="true" />
        </button>
      </header>

      <nav aria-label="에이전트 선택">
        <button
          className="agent-directory-all"
          data-selected={!props.selectedAgentId}
          type="button"
          onClick={() => props.onSelect('')}
        >
          전체 작업
        </button>
        <section>
          <h2>내 에이전트</h2>
          {native.map((agent) => (
            <AgentDirectoryRow
              agent={agent}
              selected={props.selectedAgentId === agent.id}
              runnerConnected={props.runnerConnected}
              onSelect={() => props.onSelect(agent.id)}
              key={agent.id}
            />
          ))}
          {!native.length && <p>직접 만든 에이전트가 없습니다.</p>}
        </section>
        <section>
          <h2>연결된 에이전트</h2>
          {connected.map((agent) => (
            <AgentDirectoryRow
              agent={agent}
              selected={props.selectedAgentId === agent.id}
              runnerConnected={props.runnerConnected}
              onSelect={() => props.onSelect(agent.id)}
              key={agent.id}
            />
          ))}
          {!connected.length && <p>외부에서 연결한 에이전트가 없습니다.</p>}
        </section>
      </nav>

      {selectedAgent && (
        <section className="agent-directory-card" aria-label="선택한 에이전트 카드">
          <header>
            <span>
              <strong>{selectedAgent.displayName}</strong>
              <small>{selectedAgent.role || '역할 미설정'}</small>
            </span>
            <button type="button" aria-label="에이전트 편집" onClick={openEdit}>
              <PencilSimple size={14} aria-hidden="true" />
            </button>
          </header>
          <dl>
            <div><dt>책임</dt><dd>{selectedAgent.responsibility || '위임 요청에 맞춰 수행'}</dd></div>
            <div><dt>출처</dt><dd>{agentSourceLabel(recordValue(selectedAgent))}</dd></div>
            <div><dt>상태</dt><dd>{agentConnectionLabel(recordValue(selectedAgent), { runnerConnected: props.runnerConnected })}</dd></div>
            <div><dt>실행 엔진</dt><dd>{selectedAgent.defaultExecutionEngine === 'auto' || !selectedAgent.defaultExecutionEngine ? '자동' : selectedAgent.defaultExecutionEngine}</dd></div>
            <div><dt>Runner</dt><dd>{props.runners.find((runner) => runner.id === selectedAgent.defaultRunnerId) ? runnerLabel(props.runners.find((runner) => runner.id === selectedAgent.defaultRunnerId)!) : '자동 선택'}</dd></div>
          </dl>
          {!!selectedAgent.specialties?.length && (
            <ul aria-label="전문 분야">
              {selectedAgent.specialties.slice(0, 4).map((specialty) => <li key={specialty}>{specialty}</li>)}
            </ul>
          )}
        </section>
      )}

      {selectedAgent && (
        <AgentSessionRail
          providerSessions={props.providerSessions}
          providerSessionsLoading={props.providerSessionsLoading}
          providerSessionSearch={props.providerSessionSearch}
          showArchivedProviderSessions={props.showArchivedProviderSessions}
          onProviderSessionSearch={props.onProviderSessionSearch}
          onShowArchivedProviderSessions={props.onShowArchivedProviderSessions}
          onOpenProviderSession={props.onOpenProviderSession}
          onNewProviderSession={props.onNewProviderSession}
          onRenameProviderSession={props.onRenameProviderSession}
          onArchiveProviderSession={props.onArchiveProviderSession}
          onImportExistingSession={openSessionImport}
        />
      )}

      <footer>
        <button type="button" onClick={openCreate}>
          <Plus size={14} weight="bold" aria-hidden="true" />
          에이전트 만들기
        </button>
        <button type="button" onClick={openConnect}>
          <DownloadSimple size={14} aria-hidden="true" />
          Runner에서 가져오기
        </button>
      </footer>

      {editorMode && (
        <div className="agent-directory-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
          <section className="agent-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-directory-dialog-title">
            <header>
              <span>
                <small>{sourceKind === 'connected' || ['import', 'sessions'].includes(editorMode) ? 'Workspace Runner' : 'Workspace agent'}</small>
                <h2 id="agent-directory-dialog-title">{
                  editorMode === 'edit'
                    ? '에이전트 카드 편집'
                    : editorMode === 'import'
                      ? 'Runner에서 에이전트 가져오기'
                    : editorMode === 'sessions'
                      ? '기존 provider 세션 가져오기'
                    : sourceKind === 'connected'
                      ? '외부 에이전트 연결'
                      : '에이전트 만들기'
                }</h2>
              </span>
              <button type="button" aria-label="닫기" onClick={closeEditor}><X size={17} aria-hidden="true" /></button>
            </header>
            {(sourceKind === 'connected' || ['import', 'sessions'].includes(editorMode)) && (
              <p className="agent-directory-connection-note">
                Runner에 인증된 계정의 공개 프로필 정보만 읽습니다. provider 로그인 정보는 Runner 밖으로 나오지 않습니다.
              </p>
            )}
            {editorMode === 'sessions' ? (
              <div className="agent-catalog-import">
                <p className="agent-session-import-summary">
                  {selectedAgent?.displayName}의 {selectedAgent?.provider} 세션을 같은 Workspace Runner에서 찾습니다.
                </p>
                <label className="agent-catalog-consent">
                  <input
                    type="checkbox"
                    checked={sessionCatalogConsent}
                    onChange={(event) => setSessionCatalogConsent(event.target.checked)}
                  />
                  Runner가 로컬 세션 메타데이터를 읽는 데 동의합니다.
                </label>
                <button
                  className="agent-catalog-discover"
                  type="button"
                  disabled={!sessionCatalogConsent || sessionCatalogBusy}
                  onClick={() => void discoverProviderSessions()}
                >
                  <MagnifyingGlass size={14} aria-hidden="true" />
                  {sessionCatalogBusy ? '세션을 확인하는 중' : '기존 세션 찾기'}
                </button>
                {sessionCatalogError && <p className="agent-catalog-error" role="alert">{sessionCatalogError}</p>}
                {sessionCatalog?.status === 'completed' && (
                  <div className="agent-catalog-results">
                    <header><strong>재개할 세션</strong><span>{sessionCatalog.entries.length}개</span></header>
                    {!sessionCatalog.entries.length && <p>이 provider에서 재개할 수 있는 세션을 찾지 못했습니다.</p>}
                    {sessionCatalog.entries.map((entry) => (
                      <article key={`${entry.provider}:${entry.externalSessionId}`}>
                        <span>
                          <strong>{entry.title}</strong>
                          <small>{entry.externalSessionId}</small>
                        </span>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void importProviderSession(entry.externalSessionId)}
                        >
                          연결
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            ) : editorMode === 'import' ? (
              <div className="agent-catalog-import">
                <div className="agent-directory-source-fields">
                  <label>
                    <span>제공자</span>
                    <select value={form.provider} onChange={(event) => {
                      setCatalog(null);
                      setForm({ ...form, provider: event.target.value });
                    }}>
                      <option value="hermes">Hermes</option>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="grok">Grok</option>
                    </select>
                  </label>
                  <label>
                    <span>Runner</span>
                    <select value={form.defaultRunnerId} onChange={(event) => {
                      setCatalog(null);
                      setForm({ ...form, defaultRunnerId: event.target.value });
                    }}>
                      <option value="">Runner 선택</option>
                      {props.runners.map((runner) => (
                        <option value={runner.id} key={runner.id} disabled={runner.connectionState !== 'connected'}>
                          {runnerLabel(runner)}{runner.connectionState === 'connected' ? '' : ' (오프라인)'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="agent-catalog-consent">
                  <input type="checkbox" checked={catalogConsent} onChange={(event) => setCatalogConsent(event.target.checked)} />
                  Runner가 로컬 프로필 정보를 읽는 데 동의합니다.
                </label>
                <button
                  className="agent-catalog-discover"
                  type="button"
                  disabled={!catalogConsent || !form.defaultRunnerId || catalogBusy}
                  onClick={() => void discoverCatalog()}
                >
                  <MagnifyingGlass size={14} aria-hidden="true" />
                  {catalogBusy ? '가져오는 중' : '에이전트 찾기'}
                </button>
                {catalogError && <p className="agent-catalog-error" role="alert">{catalogError}</p>}
                {catalog?.status === 'completed' && (
                  <div className="agent-catalog-results">
                    <header><strong>가져올 에이전트</strong><span>{catalog.entries.length}개</span></header>
                    {!catalog.entries.length && <p>이 provider에서 가져올 수 있는 에이전트를 찾지 못했습니다.</p>}
                    {catalog.entries.map((entry) => (
                      <article key={`${entry.provider}:${entry.externalAgentId}`}>
                        <span>
                          <strong>{entry.displayName}</strong>
                          <small>{entry.description || entry.externalAgentId}</small>
                        </span>
                        <button type="button" disabled={saving} onClick={() => void importCatalogEntry(entry.externalAgentId, entry.provider)}>
                          가져오기
                        </button>
                      </article>
                    ))}
                  </div>
                )}
                <button className="agent-catalog-manual" type="button" onClick={openManualConnect}>
                  <LinkSimple size={13} aria-hidden="true" />
                  목록을 읽을 수 없으면 ID로 직접 연결
                </button>
              </div>
            ) : (
            <div className="agent-directory-form">
              <label>
                <span>이름</span>
                <input
                  autoFocus
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                  placeholder={sourceKind === 'connected' ? '예: Hermes 리서처' : '예: 시장 리서치 파트너'}
                />
              </label>
              <label>
                <span>역할</span>
                <input value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} placeholder="예: 시장 리서처" />
              </label>
              {sourceKind === 'connected' && (
                <div className="agent-directory-source-fields">
                  <label>
                    <span>제공자</span>
                    <select value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })}>
                      <option value="hermes">Hermes</option>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="grok">Grok</option>
                      <option value="external">기타</option>
                    </select>
                  </label>
                  <label>
                    <span>외부 에이전트 ID</span>
                    <input value={form.externalAgentId} onChange={(event) => setForm({ ...form, externalAgentId: event.target.value })} placeholder="예: researcher" />
                  </label>
                </div>
              )}
              <label>
                <span>책임</span>
                <textarea value={form.responsibility} onChange={(event) => setForm({ ...form, responsibility: event.target.value })} placeholder="이 에이전트가 책임질 결과를 한 문장으로 적으세요." />
              </label>
              <label>
                <span>작업 지침</span>
                <textarea value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} placeholder="결과 형식, 금지 사항, 검증 원칙을 적으세요." />
              </label>
              <label>
                <span>전문 분야</span>
                <input value={form.specialties} onChange={(event) => setForm({ ...form, specialties: event.target.value })} placeholder="쉼표로 구분 · 시장 조사, 출처 검증" />
              </label>
              <details>
                <summary>고급 설정</summary>
                <label>
                  <span>기본 실행 엔진</span>
                  <select
                    value={form.defaultExecutionEngine}
                    onChange={(event) => setForm({ ...form, defaultExecutionEngine: event.target.value as AgentExecutionEngine })}
                  >
                    {ENGINE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label>
                  <span>기본 Runner</span>
                  <select
                    value={form.defaultRunnerId}
                    onChange={(event) => setForm({ ...form, defaultRunnerId: event.target.value })}
                  >
                    <option value="">자동 선택</option>
                    {props.runners.map((runner) => <option value={runner.id} key={runner.id}>{runnerLabel(runner)}</option>)}
                  </select>
                </label>
                <p>실제 엔진은 같은 Workspace의 Runner가 보유한 능력과 인증 상태를 통과해야 합니다.</p>
              </details>
            </div>
            )}
            <footer>
              <button type="button" onClick={closeEditor}>취소</button>
              {!['import', 'sessions'].includes(editorMode) && <button className="primary" type="button" disabled={!canSubmit || props.busy || saving} onClick={() => void submit()}>
                {editorMode === 'edit' ? '저장' : sourceKind === 'connected' ? '연결' : '만들기'}
              </button>}
            </footer>
          </section>
        </div>
      )}
    </aside>
  );
}
