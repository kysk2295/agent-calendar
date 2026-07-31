const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const statePath = path.resolve(process.argv[2]);
const requestedPort = Number(process.argv[3] || 0);
const now = '2026-07-26T06:00:00.000Z';

function initialState() {
  return {
    restartCount: 0,
    rootMission: {
      id: 'mission-task12',
      templateId: 'general-agent-work',
      title: 'Production readiness delegation audit',
      objective: 'Verify bounded child work without changing root ownership.',
      successCriteria: ['Bounded delegation remains attributable'],
      agentId: 'root-agent',
      executionEngine: 'codex',
      deliverable: { kind: 'file', format: 'auto' },
      status: 'active',
      timezone: 'Asia/Seoul',
      sources: [],
      reportSchedule: { weekday: 0, hour: 9, minute: 0 },
      policy: { maxRunsPerWeek: 20, maxRuntimeMinutesPerWeek: 240, forbiddenActions: [] },
      budget: { usedRuns: 1, usedMinutes: 4, weekStartedAt: now },
      missionThreadId: 'conversation-task12',
      planSummary: 'Keep root ownership and compare bounded results.',
      plannedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    handoffs: [],
    activeProviderSessionId: 'psess-current',
    providerSessions: [
      {
        id: 'psess-current',
        workspaceId: 'workspace-task12',
        agentId: 'root-agent',
        runnerId: 'runner-task12',
        workConversationId: 'conversation-task12',
        provider: 'codex',
        engine: 'codex',
        externalSessionId: 'external-current',
        status: 'active',
        title: 'Current Codex session',
        parentProviderSessionId: '',
        generation: 0,
        lineage: ['psess-current'],
        transitionAction: 'existing',
      },
      {
        id: 'psess-ready',
        workspaceId: 'workspace-task12',
        agentId: 'root-agent',
        runnerId: 'runner-task12',
        workConversationId: 'conversation-task12',
        provider: 'codex',
        engine: 'codex',
        externalSessionId: 'external-ready',
        status: 'active',
        title: 'Ready Codex session',
        parentProviderSessionId: '',
        generation: 1,
        lineage: ['psess-ready'],
        transitionAction: 'existing',
      },
    ],
    transitions: [],
    jobs: [],
    comparison: {
      currentResultReportId: 'report-claude',
      outcomes: [
        {
          reportId: 'report-codex',
          jobId: 'job-codex',
          executionEngine: 'codex',
          requestedModel: 'gpt-5.6',
          summary: 'Fast result with two supporting artifacts.',
          durationMs: 72000,
          costUsd: 1.25,
          evidenceCount: 2,
          turnIndex: 2,
          turnTargetIndex: 0,
        },
        {
          reportId: 'report-claude',
          jobId: 'job-claude',
          executionEngine: 'claude',
          requestedModel: 'sonnet',
          summary: 'Current result with one supporting artifact.',
          durationMs: 95000,
          costUsd: 2.4,
          evidenceCount: 1,
          turnIndex: 2,
          turnTargetIndex: 1,
        },
      ],
      adoptions: [],
    },
    counters: { handoff: 0, transition: 0, session: 1, adoption: 0 },
  };
}

let state;
if (fs.existsSync(statePath)) {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.restartCount += 1;
} else {
  state = initialState();
}

function persist() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function respond(response, status, payload) {
  response.writeHead(status, {
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-origin': '*',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(payload));
}

function workConversation() {
  const mission = state.rootMission;
  return {
    ok: true,
    work: {
      id: mission.id,
      templateId: mission.templateId,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      agentId: mission.agentId,
      assignmentReason: 'explicit:root-agent',
      executionEngine: mission.executionEngine,
      activeExecutionEngine: mission.executionEngine,
      resolvedExecutionEngine: 'codex',
      activeExecutionModel: 'gpt-5.6',
      resolvedExecutionModel: 'gpt-5.6',
      deliverable: mission.deliverable,
      missionThreadId: mission.missionThreadId,
      workConversationId: mission.missionThreadId,
      revisionCounter: 0,
      pendingRevisionId: '',
      currentResultReportId: state.comparison.currentResultReportId,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    },
    conversation: {
      id: mission.missionThreadId,
      missionId: mission.id,
      taskId: '',
      type: 'mission-thread',
      title: mission.title,
      status: 'planning',
      pendingInstructions: [],
      executionEngine: mission.executionEngine,
      deliverable: mission.deliverable,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    },
    channels: [],
    checkpoints: [{
      id: 'checkpoint-root',
      sessionId: mission.missionThreadId,
      sequence: 1,
      kind: 'user_message',
      text: mission.objective,
      origin: 'user',
      metadata: {
        deliveryStatus: 'accepted',
        applicationMode: 'mission_context',
        acceptedAt: now,
      },
      createdAt: now,
    }],
    handoffGraph: {
      rootMissionId: mission.id,
      rootAgentId: mission.agentId,
      maxDepth: 3,
      maxFanOut: 3,
      handoffs: state.handoffs,
    },
    activeProviderSessionId: state.activeProviderSessionId,
    providerSessions: state.providerSessions,
    providerSessionTransitions: state.transitions,
    comparison: state.comparison,
    effectiveConfiguration: { current: null, history: [] },
    nextCursor: null,
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    respond(response, 204, {});
    return;
  }
  const requestUrl = new URL(request.url, 'http://fixture.test');
  const route = requestUrl.pathname;
  const input = await body(request);
  if (request.method === 'GET' && route === '/api/agent-operations') {
    const mission = state.rootMission;
    respond(response, 200, {
      ok: true,
      missions: [mission],
      tasks: [{
        id: 'task-root',
        missionId: mission.id,
        sessionId: 'session-root',
        title: 'Root ownership audit',
        status: 'scheduled',
        scheduledAt: now,
        dueAt: now,
        agent: mission.agentId,
        origin: 'agent',
        reason: 'Verify bounded delegation.',
        expectedOutput: 'Audit receipt',
        estimatedMinutes: 10,
        actionClass: 'research',
        sourceRefs: [],
        executionEngine: mission.executionEngine,
        deliverable: mission.deliverable,
      }],
      sessions: [],
      reports: [],
      daemon: { running: true, lastRun: now, lastError: null },
      runner: { connected: true, status: 'connected' },
    });
    return;
  }
  if (request.method === 'GET' && route === '/api/agents') {
    respond(response, 200, {
      ok: true,
      agents: [
        { id: 'root-agent', displayName: 'Root Agent', status: 'ready', enabled: true, role: 'owner', provider: 'codex', trustLevel: 'bounded', allowedTaskClasses: ['research'] },
        { id: 'child-agent', displayName: 'Child Agent', status: 'ready', enabled: true, role: 'researcher', provider: 'codex', trustLevel: 'bounded', allowedTaskClasses: ['research'] },
      ],
    });
    return;
  }
  if (request.method === 'GET' && route === '/api/runners') {
    respond(response, 200, { ok: true, runners: [] });
    return;
  }
  if (request.method === 'GET' && route === '/api/scheduler/jobs') {
    respond(response, 200, { ok: true, jobs: [] });
    return;
  }
  if (request.method === 'GET' && route === '/api/agent-operations/work/mission-task12/conversation') {
    respond(response, 200, workConversation());
    return;
  }
  if (request.method === 'POST' && route === '/api/agent-operations/work/mission-task12/handoffs') {
    if (input.receiverAgentId === 'root-agent') {
      respond(response, 409, { ok: false, error: 'handoff_cycle', message: 'Child handoff would create a cycle' });
      return;
    }
    if (input.receiverAgentId === 'quota-agent') {
      respond(response, 409, { ok: false, error: 'handoff_fanout_exceeded', message: 'Child handoff fan-out limit exceeded' });
      return;
    }
    state.counters.handoff += 1;
    const handoff = {
      id: `handoff-${state.counters.handoff}`,
      clientRequestId: input.clientRequestId,
      parentMissionId: state.rootMission.id,
      parentHandoffId: input.parentHandoffId || '',
      parentTaskId: '',
      rootAgentId: state.rootMission.agentId,
      delegatorAgentId: input.delegatorAgentId,
      receiverAgentId: input.receiverAgentId,
      depth: input.parentHandoffId ? 2 : 1,
      lineage: input.parentHandoffId
        ? ['root-agent', 'child-agent', input.receiverAgentId]
        : ['root-agent', input.receiverAgentId],
      effectiveGrants: {
        allow: (input.requestedGrants?.allow || []).filter((entry) => entry === 'tool:workspace.read'),
        deny: [...new Set(['tool:mail.send', ...(input.requestedGrants?.deny || [])])],
      },
      effectiveBudget: {
        maxRuns: Math.min(Number(input.requestedBudget?.maxRuns || 2), 2),
        maxMinutes: Math.min(Number(input.requestedBudget?.maxMinutes || 30), 30),
        maxCostUsd: Math.min(Number(input.requestedBudget?.maxCostUsd || 5), 5),
      },
      status: 'accepted',
      resultProjection: {},
      cancellationRequested: false,
      cancellationReason: '',
      executionJobId: `job-handoff-${state.counters.handoff}`,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
    };
    state.handoffs.push(handoff);
    state.jobs.push({ id: handoff.executionJobId, kind: 'handoff', handoffId: handoff.id });
    persist();
    respond(response, 201, { ok: true, handoff, job: state.jobs.at(-1), idempotentReplay: false });
    return;
  }
  const cancelMatch = route.match(/^\/api\/agent-operations\/work\/mission-task12\/handoffs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const handoff = state.handoffs.find((item) => item.id === decodeURIComponent(cancelMatch[1]));
    if (!handoff) {
      respond(response, 404, { ok: false, error: 'handoff_not_found', message: 'Child handoff was not found' });
      return;
    }
    handoff.status = 'cancelled';
    handoff.cancellationRequested = true;
    handoff.cancellationReason = input.reason || 'user_cancelled';
    handoff.resultProjection = { status: 'cancelled', reason: handoff.cancellationReason };
    handoff.terminalAt = now;
    persist();
    respond(response, 200, { ok: true, handoff, idempotentReplay: false });
    return;
  }
  if (request.method === 'POST' && route === '/api/agent-operations/work/mission-task12/provider-session-transitions') {
    const selectedId = input.action === 'rebind'
      ? input.targetProviderSessionId
      : input.sourceProviderSessionId || state.activeProviderSessionId;
    const selected = state.providerSessions.find((session) => session.id === selectedId);
    if (!selected) {
      respond(response, 404, { ok: false, error: 'provider_session_not_found', message: 'Provider session was not found in this Workspace' });
      return;
    }
    if (input.expectedActiveProviderSessionId !== state.activeProviderSessionId) {
      respond(response, 409, { ok: false, error: 'provider_session_selection_stale', message: 'Provider session selection is stale' });
      return;
    }
    let target = selected;
    if (input.action !== 'rebind') {
      state.counters.session += 1;
      target = {
        ...selected,
        id: `psess-${state.counters.session}`,
        title: input.action === 'fork' ? `Fork of ${selected.title}` : 'New provider session',
        parentProviderSessionId: input.action === 'fork' ? selected.id : '',
        generation: state.counters.session,
        lineage: input.action === 'fork' ? [...selected.lineage, `psess-${state.counters.session}`] : [`psess-${state.counters.session}`],
        transitionAction: input.action,
        status: 'pending',
      };
      state.providerSessions.push(target);
    }
    state.counters.transition += 1;
    const transition = {
      id: `transition-${state.counters.transition}`,
      action: input.action,
      sourceProviderSessionId: input.action === 'rebind' ? state.activeProviderSessionId : selected.id,
      targetProviderSessionId: target.id,
      executionJobId: `job-transition-${state.counters.transition}`,
      clientRequestId: input.clientRequestId,
      createdAt: now,
    };
    state.transitions.push(transition);
    state.jobs.push({ id: transition.executionJobId, kind: 'provider_transition', action: input.action });
    state.activeProviderSessionId = target.id;
    persist();
    respond(response, 201, { ok: true, transition, session: target, job: state.jobs.at(-1), idempotentReplay: false });
    return;
  }
  if (request.method === 'POST' && route === '/api/agent-operations/work/mission-task12/comparison/adopt') {
    if (input.expectedCurrentResultReportId !== state.comparison.currentResultReportId) {
      respond(response, 409, { ok: false, error: 'comparison_selection_stale', message: 'Comparison current-result selection is stale' });
      return;
    }
    const outcome = state.comparison.outcomes.find((item) => item.reportId === input.reportId);
    if (!outcome) {
      respond(response, 404, { ok: false, error: 'comparison_result_not_found', message: 'Comparison result was not found' });
      return;
    }
    state.counters.adoption += 1;
    const adoption = {
      id: input.selectionId,
      reportId: input.reportId,
      previousReportId: state.comparison.currentResultReportId,
      selectionVersion: state.counters.adoption,
      outcome,
      createdAt: now,
    };
    state.comparison.currentResultReportId = input.reportId;
    state.comparison.adoptions.push(adoption);
    persist();
    respond(response, 200, { ok: true, currentResultReportId: input.reportId, adoption, idempotentReplay: false });
    return;
  }
  respond(response, 200, {
    ok: true,
    tasks: [],
    events: [],
    agents: [],
    runs: [],
    documents: [],
    notes: [],
    graph: { nodes: [], edges: [] },
    items: [],
    commands: [],
    jobs: [],
    messages: [],
    channels: [],
    tools: [],
    onboarding: { version: 1, status: 'completed' },
    settings: { uiPreferences: {} },
    uiPreferences: {},
  });
});

persist();
server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port, pid: process.pid })}\n`);
});

function close() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', close);
process.on('SIGINT', close);
