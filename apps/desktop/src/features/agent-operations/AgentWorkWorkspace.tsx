import { useEffect, useMemo, useState } from 'react';

import { isAgentSelectable } from '../../domains/agent-work/agentRoster';
import { engineModels, type PublicRunner } from '../runner/runnerApi';
import { compareAgentTasksBySchedule } from './agentOperations';
import { AgentControlRoomBoard } from './AgentControlRoomBoard';
import { AgentDirectoryPanel } from './AgentDirectoryPanel';
import { AgentWorkConversationView } from './AgentWorkConversationView';
import { useAgentWorkConversation } from './useAgentWorkConversation';
import { useAgentWorkLiveTurn } from './useAgentWorkLiveTurn';
import type {
  AgentCatalogRequest,
  AgentCreatedWork,
  AgentDirectoryMutationInput,
  AgentExecutionEngine,
  AgentMission,
  AgentMissionCreateInput,
  AgentOperationsState,
  AgentRosterEntry,
  AgentTaskAction,
  HermesAutomationJob,
  ProviderAgentSession,
  ProviderSessionCatalogRequest,
  ProviderSessionImportResult,
} from './types';
import type { AgentWorkDelivery } from './workConversationTypes';

type AgentWorkWorkspaceProps = {
  readonly state: AgentOperationsState;
  readonly agents: readonly AgentRosterEntry[];
  readonly runners: readonly PublicRunner[];
  readonly automationJobs: readonly HermesAutomationJob[];
  readonly controlPlaneBaseUrl: string;
  readonly aggregateStale: boolean;
  readonly busy: string;
  readonly onCreateAgent: (input: AgentDirectoryMutationInput) => Promise<boolean>;
  readonly onUpdateAgent: (agentId: string, input: AgentDirectoryMutationInput) => Promise<boolean>;
  readonly onRequestAgentCatalog: (input: Readonly<{ runnerId: string; provider: string; consent: true }>) => Promise<AgentCatalogRequest | null>;
  readonly onGetAgentCatalogRequest: (requestId: string) => Promise<AgentCatalogRequest | null>;
  readonly onImportAgentCatalogEntry: (requestId: string, input: Readonly<{ externalAgentId: string; defaultExecutionEngine: AgentExecutionEngine }>) => Promise<boolean>;
  readonly onListProviderAgentSessions: (agentId: string, search: string, archived: boolean) => Promise<readonly ProviderAgentSession[]>;
  readonly onRequestProviderSessionCatalog: (agentId: string, input: Readonly<{ runnerId: string; consent: true }>) => Promise<ProviderSessionCatalogRequest | null>;
  readonly onImportProviderSessionCatalogEntry: (agentId: string, requestId: string, externalSessionId: string) => Promise<ProviderSessionImportResult | null>;
  readonly onUpdateProviderAgentSession: (sessionId: string, patch: Readonly<{ title?: string; archived?: boolean }>) => Promise<ProviderAgentSession | null>;
  readonly onCreateMission: (input: AgentMissionCreateInput) => Promise<AgentCreatedWork | null>;
  readonly onRefreshAgentOperations: () => Promise<boolean>;
  readonly onPlanMission: (missionId: string) => Promise<void>;
  readonly onApprovePlan: (missionId: string) => Promise<void>;
  readonly onMissionWorkAction: (missionId: string, action: 'activate' | 'pause' | 'cancel') => Promise<void>;
  readonly onTaskAction: (taskId: string, action: AgentTaskAction) => Promise<boolean>;
  readonly onRunTaskNow: (taskId: string) => Promise<void>;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onContinueSession: (sessionId: string, message: string) => Promise<boolean>;
  readonly onReportFeedback: (reportId: string, useful: boolean) => Promise<void>;
  readonly onFollowUpDecision: (reportId: string, index: number, decision: 'approved' | 'rejected') => Promise<void>;
};

const ENGINE_OPTIONS: readonly Readonly<{ value: AgentExecutionEngine; label: string }>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'grok', label: 'Grok' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'local_llm', label: '로컬 LLM' },
];

export function titleFromRequest(request: string): string {
  const firstLine = request.split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() || '새 작업';
  if (firstLine.length <= 300) return firstLine;
  let prefix = '';
  for (const character of firstLine) {
    if (prefix.length + character.length > 297) break;
    prefix += character;
  }
  return `${prefix}...`;
}

function fullTitleFromRequest(request: string): string {
  return request.split(/\r?\n/)[0]?.replace(/\s+/g, ' ').trim() || '새 작업';
}

export function displayMissionTitle(title: string, objective: string): string {
  const truncatedSuffix = title.match(/(?:…|\.{3})$/)?.[0];
  if (!truncatedSuffix) return title;
  const completeTitle = fullTitleFromRequest(objective);
  return completeTitle.startsWith(title.slice(0, -truncatedSuffix.length)) ? completeTitle : title;
}

function executionEngine(value: string): AgentExecutionEngine {
  switch (value) {
    case 'hermes':
    case 'local_llm':
    case 'codex':
    case 'claude':
    case 'grok':
    case 'auto':
      return value;
    default: return 'auto';
  }
}

export function AgentWorkWorkspace(props: AgentWorkWorkspaceProps) {
  const [request, setRequest] = useState('');
  const [agentId, setAgentId] = useState('');
  const [engine, setEngine] = useState<AgentExecutionEngine>('auto');
  const [requestedModel, setRequestedModel] = useState('');
  const [selectedMissionId, setSelectedMissionId] = useState('');
  const [provisionalMission, setProvisionalMission] = useState<AgentMission | null>(null);
  const [returnFocusTarget, setReturnFocusTarget] = useState('');
  const [pendingInitialWorkId, setPendingInitialWorkId] = useState('');
  const [providerSessions, setProviderSessions] = useState<readonly ProviderAgentSession[]>([]);
  const [providerSessionSearch, setProviderSessionSearch] = useState('');
  const [showArchivedProviderSessions, setShowArchivedProviderSessions] = useState(false);
  const [providerSessionsLoading, setProviderSessionsLoading] = useState(false);
  const { conversation, loading: conversationLoading, error: conversationError, refresh: refreshConversation, refreshAfterMutation } = useAgentWorkConversation(selectedMissionId, props.onRefreshAgentOperations);
  const { state: liveTurn, send: sendLiveTurn, startInitial } = useAgentWorkLiveTurn(selectedMissionId, refreshAfterMutation);
  const orderedMissions = useMemo(() => [...props.state.missions].sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)), [props.state.missions]);
  const aggregateMission = orderedMissions.find((mission) => mission.id === selectedMissionId);
  const selectedConversation = conversation?.work.id === selectedMissionId ? conversation : null;
  const rawSelectedBaseMission = aggregateMission || (provisionalMission?.id === selectedMissionId ? provisionalMission : undefined);
  const selectedBaseMission = rawSelectedBaseMission ? {
    ...rawSelectedBaseMission,
    title: displayMissionTitle(rawSelectedBaseMission.title, rawSelectedBaseMission.objective),
  } : undefined;
  const selectedMission = selectedBaseMission && selectedConversation ? {
    ...selectedBaseMission,
    id: selectedConversation.work.id,
    templateId: selectedConversation.work.templateId,
    title: displayMissionTitle(selectedConversation.work.title, selectedConversation.work.objective),
    objective: selectedConversation.work.objective,
    status: selectedBaseMission.status,
    agentId: selectedConversation.work.agentId,
    executionEngine: selectedConversation.work.executionEngine,
    deliverable: selectedConversation.work.deliverable,
    missionThreadId: selectedConversation.work.missionThreadId,
    createdAt: selectedConversation.work.createdAt,
    updatedAt: selectedConversation.work.updatedAt,
  } : selectedBaseMission;
  const selectedTasks = selectedMission ? props.state.tasks.filter((task) => task.missionId === selectedMission.id).sort(compareAgentTasksBySchedule) : [];
  const selectedReports = selectedMission ? props.state.reports.filter((report) => report.missionId === selectedMission.id) : [];
  const runnerConnected = props.state.runner?.connected === true || props.state.runner?.status === 'connected';
  const directoryAgent = props.agents.find((agent) => agent.id === agentId);
  const effectiveAgentId = directoryAgent && isAgentSelectable(
    directoryAgent as unknown as Record<string, unknown>,
    { runnerConnected },
  ) ? directoryAgent.id : '';
  const filteredMissionIds = useMemo(() => new Set(
    props.state.missions
      .filter((mission) => !agentId || mission.agentId === agentId)
      .map((mission) => mission.id),
  ), [agentId, props.state.missions]);
  const directoryState = useMemo<AgentOperationsState>(() => ({
    ...props.state,
    missions: props.state.missions.filter((mission) => filteredMissionIds.has(mission.id)),
    tasks: props.state.tasks.filter((task) => filteredMissionIds.has(task.missionId)),
    sessions: props.state.sessions.filter((session) => filteredMissionIds.has(session.missionId)),
    reports: props.state.reports.filter((report) => filteredMissionIds.has(report.missionId)),
  }), [filteredMissionIds, props.state]);
  const completedCount = directoryState.tasks.filter((task) => task.status === 'completed').length;
  const runningCount = directoryState.tasks.filter((task) => task.status === 'running').length;
  const attentionCount = directoryState.tasks.filter((task) => ['proposed', 'blocked', 'failed'].includes(task.status)).length;
  const activeAutomationCount = props.automationJobs.filter((job) => job.status === 'active').length;
  const creationModels = engineModels(props.runners, engine);
  const controlHomeState = useMemo(() => ({
    ...directoryState,
    missions: directoryState.missions.map((mission) => ({ ...mission, title: displayMissionTitle(mission.title, mission.objective) })),
  }), [directoryState]);

  useEffect(() => {
    if (selectedMissionId || !returnFocusTarget) return;
    const target = returnFocusTarget === 'delegate'
      ? document.querySelector<HTMLElement>('[aria-label="에이전트에게 작업 지시"]')
      : document.querySelector<HTMLElement>(`[data-work-origin="${CSS.escape(returnFocusTarget)}"]`);
    (target || document.querySelector<HTMLElement>('[data-work-focus-fallback]'))?.focus();
    setReturnFocusTarget('');
  }, [returnFocusTarget, selectedMissionId]);

  useEffect(() => {
    if (!pendingInitialWorkId || pendingInitialWorkId !== selectedMissionId || !selectedConversation || conversationLoading) return;
    setPendingInitialWorkId('');
    void startInitial().catch(() => undefined);
  }, [conversationLoading, pendingInitialWorkId, selectedConversation, selectedMissionId, startInitial]);

  useEffect(() => {
    let cancelled = false;
    if (!agentId) {
      setProviderSessions([]);
      return () => {
        cancelled = true;
      };
    }
    setProviderSessionsLoading(true);
    void props.onListProviderAgentSessions(agentId, providerSessionSearch, showArchivedProviderSessions)
      .then((sessions) => {
        if (!cancelled) setProviderSessions(sessions);
      })
      .finally(() => {
        if (!cancelled) setProviderSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, providerSessionSearch, showArchivedProviderSessions]);

  const openMission = (missionId: string, originKey: string) => { setProvisionalMission(null); setReturnFocusTarget(originKey); setSelectedMissionId(missionId); };
  const closeMission = () => {
    setProvisionalMission(null);
    setSelectedMissionId('');
  };
  const selectDirectoryAgent = (nextAgentId: string) => {
    setProvisionalMission(null);
    setSelectedMissionId('');
    setAgentId(nextAgentId);
  };
  const refreshProviderSessions = async () => {
    if (!agentId) return;
    setProviderSessionsLoading(true);
    try {
      setProviderSessions(await props.onListProviderAgentSessions(
        agentId,
        providerSessionSearch,
        showArchivedProviderSessions,
      ));
    } finally {
      setProviderSessionsLoading(false);
    }
  };
  const openProviderSession = (session: ProviderAgentSession) => {
    setProvisionalMission(null);
    setSelectedMissionId(session.missionId);
  };
  const startNewProviderSession = () => {
    setProvisionalMission(null);
    setSelectedMissionId('');
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="에이전트에게 작업 지시"]')?.focus());
  };
  const renameProviderSession = async (sessionId: string, title: string) => {
    const updated = await props.onUpdateProviderAgentSession(sessionId, { title });
    if (updated) await refreshProviderSessions();
  };
  const archiveProviderSession = async (sessionId: string) => {
    const updated = await props.onUpdateProviderAgentSession(sessionId, { archived: true });
    if (updated) {
      if (selectedMissionId === updated.workConversationId) setSelectedMissionId('');
      await refreshProviderSessions();
    }
  };
  const openImportedProviderSession = (result: ProviderSessionImportResult) => {
    setProvisionalMission(null);
    setSelectedMissionId(result.missionId);
    void refreshProviderSessions();
  };
  const submit = async () => {
    const objective = request.trim();
    if (!objective || props.busy === 'create') return;
    const created = await props.onCreateMission({
      templateId: 'general-agent-work',
      title: titleFromRequest(objective),
      objective,
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      executionEngine: engine,
      ...(requestedModel ? { requestedModel } : {}),
      deliverable: { kind: 'file', format: 'auto' },
    });
    if (created) {
      setProvisionalMission({
        id: created.id, templateId: 'general-agent-work', title: fullTitleFromRequest(objective), objective,
        successCriteria: [], agentId: effectiveAgentId || '확인 중', executionEngine: engine,
        deliverable: { kind: 'file', format: 'auto' }, status: 'draft', timezone: '', sources: [],
        reportSchedule: { weekday: 0, hour: 0, minute: 0 },
        policy: { maxRunsPerWeek: 0, maxRuntimeMinutesPerWeek: 0, forbiddenActions: [] },
        budget: { usedRuns: 0, usedMinutes: 0, weekStartedAt: '' }, missionThreadId: created.conversationId,
        planSummary: '', plannedAt: '', createdAt: '', updatedAt: '',
      });
      setReturnFocusTarget('delegate');
      setRequest('');
      setPendingInitialWorkId(created.id);
      setSelectedMissionId(created.id);
    }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  if (selectedMission) {
    return (
      <div className="agent-control-shell">
        <AgentDirectoryPanel
          agents={props.agents}
          runners={props.runners}
          selectedAgentId={selectedMission.agentId}
          sessionsOnly
          runnerConnected={runnerConnected}
          busy={Boolean(props.busy)}
          onSelect={selectDirectoryAgent}
          onCreate={props.onCreateAgent}
          onUpdate={props.onUpdateAgent}
          onRequestAgentCatalog={props.onRequestAgentCatalog}
          onGetAgentCatalogRequest={props.onGetAgentCatalogRequest}
          onImportAgentCatalogEntry={props.onImportAgentCatalogEntry}
          onRequestProviderSessionCatalog={props.onRequestProviderSessionCatalog}
          onImportProviderSessionCatalogEntry={props.onImportProviderSessionCatalogEntry}
          onImportedProviderSession={openImportedProviderSession}
          providerSessions={providerSessions}
          providerSessionsLoading={providerSessionsLoading}
          providerSessionSearch={providerSessionSearch}
          showArchivedProviderSessions={showArchivedProviderSessions}
          onProviderSessionSearch={setProviderSessionSearch}
          onShowArchivedProviderSessions={setShowArchivedProviderSessions}
          onOpenProviderSession={openProviderSession}
          onNewProviderSession={startNewProviderSession}
          onRenameProviderSession={renameProviderSession}
          onArchiveProviderSession={archiveProviderSession}
        />
        <div className="agent-control-room agent-control-room-selected">
          <AgentWorkConversationView
            mission={selectedMission}
            tasks={selectedTasks}
            reports={selectedReports}
            responsibleAgentName={props.agents.find((agent) => agent.id === selectedMission.agentId)?.displayName || selectedMission.agentId}
            provisional={!selectedConversation && provisionalMission?.id === selectedMission.id}
            conversation={selectedConversation}
            loading={conversationLoading}
            error={conversationError}
            aggregateStale={props.aggregateStale}
            busy={props.busy}
            onBack={closeMission}
            onRefresh={refreshConversation}
            onSendMessage={(text, executionEngine, requestedModel, comparisonTargets): Promise<AgentWorkDelivery> => sendLiveTurn(text, executionEngine, requestedModel, comparisonTargets)}
            onPlanMission={props.onPlanMission}
            onApprovePlan={props.onApprovePlan}
            onMissionWorkAction={props.onMissionWorkAction}
            onTaskAction={props.onTaskAction}
            onRunTaskNow={props.onRunTaskNow}
            onOpenSession={props.onOpenSession}
            onReportFeedback={props.onReportFeedback}
            onFollowUpDecision={props.onFollowUpDecision}
            liveTurn={liveTurn}
            runners={props.runners}
            controlPlaneBaseUrl={props.controlPlaneBaseUrl}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="agent-control-shell">
      <AgentDirectoryPanel
        agents={props.agents}
        runners={props.runners}
        selectedAgentId={agentId}
        sessionsOnly={false}
        runnerConnected={runnerConnected}
        busy={Boolean(props.busy)}
        onSelect={selectDirectoryAgent}
        onCreate={props.onCreateAgent}
        onUpdate={props.onUpdateAgent}
        onRequestAgentCatalog={props.onRequestAgentCatalog}
        onGetAgentCatalogRequest={props.onGetAgentCatalogRequest}
        onImportAgentCatalogEntry={props.onImportAgentCatalogEntry}
        onRequestProviderSessionCatalog={props.onRequestProviderSessionCatalog}
        onImportProviderSessionCatalogEntry={props.onImportProviderSessionCatalogEntry}
        onImportedProviderSession={openImportedProviderSession}
        providerSessions={providerSessions}
        providerSessionsLoading={providerSessionsLoading}
        providerSessionSearch={providerSessionSearch}
        showArchivedProviderSessions={showArchivedProviderSessions}
        onProviderSessionSearch={setProviderSessionSearch}
        onShowArchivedProviderSessions={setShowArchivedProviderSessions}
        onOpenProviderSession={openProviderSession}
        onNewProviderSession={startNewProviderSession}
        onRenameProviderSession={renameProviderSession}
        onArchiveProviderSession={archiveProviderSession}
      />
      <div className="agent-control-room">
        <header className="agent-control-head"><div><h1 tabIndex={-1}>{directoryAgent ? directoryAgent.displayName : '에이전트'}</h1><span className="agent-control-summary">{directoryAgent ? `${directoryAgent.role || '역할 미설정'} · ` : ''}완료 {completedCount} · 진행 {runningCount} · 확인 필요 {attentionCount}</span></div><span className="agent-control-live" data-running={props.state.daemon.running || props.state.runner?.connected === true} data-runner-required={!runnerConnected && (props.state.runner?.status === 'runner_required' || props.state.daemon.mode === 'runner_required')} data-runner-connected={runnerConnected} data-testid="agent-runner-live"><i />{
          runnerConnected
            ? 'Runner 연결됨 · Workspace 실행 준비'
            : (props.state.runner?.status === 'runner_required' || props.state.daemon.mode === 'runner_required')
              ? 'Runner 미연결 · 실행은 Workspace Runner 필요'
              : props.state.daemon.running
                ? `Hermes 스케줄러 온라인 · 활성 자동화 ${activeAutomationCount}개`
                : 'Hermes 스케줄러 확인 필요'
        }</span></header>

        <div className="agent-delegate-bar">
          <textarea aria-label="에이전트에게 작업 지시" rows={1} value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={keyDown} placeholder={directoryAgent ? `${directoryAgent.displayName}에게 작업을 지시하세요` : '작업을 설명하세요. 예: 경쟁사 3곳을 조사해서 문서로 정리해줘'} />
          <button className="agent-delegate-send" type="button" aria-label="위임" disabled={!request.trim() || props.busy === 'create' || Boolean(directoryAgent && !effectiveAgentId)} onClick={() => void submit()}><span>위임</span></button>
        </div>
        <details className="agent-delegate-advanced"><summary>고급 설정</summary><div><label><span>담당 에이전트</span><select aria-label="담당 에이전트" value={effectiveAgentId} onChange={(event) => setAgentId(event.target.value)}><option value="">자동 배정</option>{props.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</select></label><label><span>실행 엔진</span><select aria-label="실행 엔진" value={engine} onChange={(event) => { setEngine(executionEngine(event.target.value)); setRequestedModel(''); }}>{ENGINE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>{['codex', 'claude', 'grok', 'hermes'].includes(engine) && <label><span>실행 모델</span>{creationModels.models.length ? <select aria-label="실행 모델" value={requestedModel} onChange={(event) => setRequestedModel(event.target.value)}><option value="">Runner 기본 모델</option>{creationModels.models.map((model) => <option value={model} key={model}>{model}</option>)}</select> : <input aria-label="실행 모델" value={requestedModel} onChange={(event) => setRequestedModel(event.target.value)} placeholder="예: gpt-5.6-codex" />}</label>}</div></details>

        <AgentControlRoomBoard state={controlHomeState} agents={directoryAgent ? [directoryAgent] : props.agents} automationJobs={props.automationJobs} readOnly={props.aggregateStale} busy={props.busy} onOpenMission={openMission} onTaskAction={props.onTaskAction} />
      </div>
    </div>
  );
}
