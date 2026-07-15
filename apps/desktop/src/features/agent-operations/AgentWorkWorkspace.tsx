import { useEffect, useMemo, useState } from 'react';

import { compareAgentTasksBySchedule } from './agentOperations';
import { AgentControlRoomBoard } from './AgentControlRoomBoard';
import { AgentWorkConversationView } from './AgentWorkConversationView';
import { useAgentWorkConversation } from './useAgentWorkConversation';
import { useAgentWorkLiveTurn } from './useAgentWorkLiveTurn';
import type {
  AgentCreatedWork,
  AgentExecutionEngine,
  AgentMission,
  AgentMissionCreateInput,
  AgentOperationsState,
  AgentRosterEntry,
  AgentTaskAction,
  HermesAutomationJob,
} from './types';
import type { AgentWorkDelivery } from './workConversationTypes';

type AgentWorkWorkspaceProps = {
  readonly state: AgentOperationsState;
  readonly agents: readonly AgentRosterEntry[];
  readonly automationJobs: readonly HermesAutomationJob[];
  readonly aggregateStale: boolean;
  readonly busy: string;
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
  { value: 'auto', label: '자동 엔진' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'local_llm', label: '로컬 LLM' },
  { value: 'codex', label: 'Codex' },
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
    case 'codex': return value;
    default: return 'auto';
  }
}

export function AgentWorkWorkspace(props: AgentWorkWorkspaceProps) {
  const [request, setRequest] = useState('');
  const [agentId, setAgentId] = useState('');
  const [engine, setEngine] = useState<AgentExecutionEngine>('auto');
  const [selectedMissionId, setSelectedMissionId] = useState('');
  const [provisionalMission, setProvisionalMission] = useState<AgentMission | null>(null);
  const [returnFocusTarget, setReturnFocusTarget] = useState('');
  const [pendingInitialWorkId, setPendingInitialWorkId] = useState('');
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
  const effectiveAgentId = props.agents.some((agent) => agent.id === agentId) ? agentId : '';
  const completedCount = props.state.tasks.filter((task) => task.status === 'completed').length;
  const runningCount = props.state.tasks.filter((task) => task.status === 'running').length;
  const attentionCount = props.state.tasks.filter((task) => ['proposed', 'blocked', 'failed'].includes(task.status)).length;
  const activeAutomationCount = props.automationJobs.filter((job) => job.status === 'active').length;
  const controlHomeState = useMemo(() => ({
    ...props.state,
    missions: props.state.missions.map((mission) => ({ ...mission, title: displayMissionTitle(mission.title, mission.objective) })),
  }), [props.state]);

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

  const openMission = (missionId: string, originKey: string) => { setProvisionalMission(null); setReturnFocusTarget(originKey); setSelectedMissionId(missionId); };
  const closeMission = () => {
    setProvisionalMission(null);
    setSelectedMissionId('');
  };
  const submit = async () => {
    const objective = request.trim();
    if (!objective || props.busy === 'create') return;
    const created = await props.onCreateMission({ templateId: 'general-agent-work', title: titleFromRequest(objective), objective, ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}), executionEngine: engine, deliverable: { kind: 'file', format: 'auto' } });
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
          onSendMessage={(text): Promise<AgentWorkDelivery> => sendLiveTurn(text)}
          onPlanMission={props.onPlanMission}
          onApprovePlan={props.onApprovePlan}
          onMissionWorkAction={props.onMissionWorkAction}
          onTaskAction={props.onTaskAction}
          onRunTaskNow={props.onRunTaskNow}
          onOpenSession={props.onOpenSession}
          onReportFeedback={props.onReportFeedback}
          onFollowUpDecision={props.onFollowUpDecision}
          liveTurn={liveTurn}
        />
      </div>
    );
  }

  return (
    <div className="agent-control-room">
      <header className="agent-control-head"><div><h1 tabIndex={-1}>에이전트</h1><span className="agent-control-summary">완료 {completedCount} · 진행 {runningCount} · 확인 필요 {attentionCount}</span></div><span className="agent-control-live" data-running={props.state.daemon.running}><i />{props.state.daemon.running ? `Hermes 스케줄러 온라인 · 활성 자동화 ${activeAutomationCount}개` : 'Hermes 스케줄러 확인 필요'}</span></header>

      <div className="agent-delegate-bar">
        <textarea aria-label="에이전트에게 작업 지시" rows={1} value={request} onChange={(event) => setRequest(event.target.value)} onKeyDown={keyDown} placeholder="일 시키기 — 예: 과제 3 경쟁사 리서치 정리해서 문서로 만들어줘" />
        <button className="agent-delegate-send" type="button" aria-label="위임" disabled={!request.trim() || props.busy === 'create'} onClick={() => void submit()}><span>위임</span></button>
      </div>
      <details className="agent-delegate-advanced"><summary>고급 설정</summary><div><label><span>담당 에이전트</span><select aria-label="담당 에이전트" value={effectiveAgentId} onChange={(event) => setAgentId(event.target.value)}><option value="">자동 배정</option>{props.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</select></label><label><span>실행 엔진</span><select aria-label="실행 엔진" value={engine} onChange={(event) => setEngine(executionEngine(event.target.value))}>{ENGINE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div></details>
      <p className="agent-delegate-hint">캘린더 채팅이나 텔레그램에서 시작한 작업도 이 관제 화면에 함께 쌓입니다.</p>

      <AgentControlRoomBoard state={controlHomeState} agents={props.agents} automationJobs={props.automationJobs} readOnly={props.aggregateStale} busy={props.busy} onOpenMission={openMission} onTaskAction={props.onTaskAction} />
    </div>
  );
}
