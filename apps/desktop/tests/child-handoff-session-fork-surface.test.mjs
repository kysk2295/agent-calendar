import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const desktopRoot = new URL('../', import.meta.url);
const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(desktopRoot),
  server: { middlewareMode: true, hmr: false },
});
const apiModule = await vite.ssrLoadModule('/src/api/hermesApi.ts');

after(async () => {
  await vite.close();
});

const fixture = {
  ok: true,
  work: {
    id: 'mission-task12',
    templateId: 'general-agent-work',
    title: 'Bounded work',
    objective: 'Keep one root agent',
    status: 'active',
    agentId: 'root-agent',
    assignmentReason: 'explicit:root-agent',
    executionEngine: 'codex',
    activeExecutionEngine: 'codex',
    deliverable: { kind: 'file', format: 'auto' },
    missionThreadId: 'conversation-task12',
    workConversationId: 'conversation-task12',
    revisionCounter: 0,
    pendingRevisionId: '',
    currentResultReportId: 'report-b',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:01:00.000Z',
  },
  conversation: {
    id: 'conversation-task12',
    missionId: 'mission-task12',
    taskId: '',
    type: 'mission-thread',
    title: 'Bounded work',
    status: 'planning',
    pendingInstructions: [],
    executionEngine: 'codex',
    deliverable: { kind: 'file', format: 'auto' },
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:01:00.000Z',
  },
  channels: [],
  checkpoints: [],
  handoffGraph: {
    rootMissionId: 'mission-task12',
    rootAgentId: 'root-agent',
    maxDepth: 3,
    maxFanOut: 3,
    handoffs: [{
      id: 'handoff-a',
      clientRequestId: 'request-a',
      parentMissionId: 'mission-task12',
      parentHandoffId: '',
      parentTaskId: 'task-parent',
      rootAgentId: 'root-agent',
      delegatorAgentId: 'root-agent',
      receiverAgentId: 'child-agent',
      depth: 1,
      lineage: ['root-agent', 'child-agent'],
      effectiveGrants: {
        allow: ['tool:workspace.read'],
        deny: ['tool:mail.send'],
      },
      effectiveBudget: {
        maxRuns: 2,
        maxMinutes: 30,
        maxCostUsd: 3,
      },
      status: 'accepted',
      resultProjection: {},
      cancellationRequested: false,
      cancellationReason: '',
      executionJobId: 'job-child-a',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      terminalAt: null,
    }],
  },
  providerSessions: [{
    id: 'psess-current',
    workspaceId: 'workspace-a',
    agentId: 'root-agent',
    runnerId: 'runner-a',
    workConversationId: 'conversation-task12',
    provider: 'codex',
    engine: 'codex',
    externalSessionId: 'external-a',
    status: 'active',
    title: 'Current session',
    parentProviderSessionId: '',
    generation: 0,
    lineage: ['psess-current'],
    transitionAction: 'existing',
  }],
  providerSessionTransitions: [],
  comparison: {
    currentResultReportId: 'report-b',
    outcomes: [
      {
        reportId: 'report-a',
        jobId: 'job-a',
        executionEngine: 'codex',
        requestedModel: 'gpt-5.6',
        summary: 'A',
        durationMs: 120000,
        costUsd: 1.25,
        evidenceCount: 2,
        turnIndex: 2,
        turnTargetIndex: 0,
      },
      {
        reportId: 'report-b',
        jobId: 'job-b',
        executionEngine: 'claude',
        requestedModel: '',
        summary: 'B',
        durationMs: 90000,
        costUsd: 2.5,
        evidenceCount: 1,
        turnIndex: 2,
        turnTargetIndex: 1,
      },
    ],
    adoptions: [{
      id: 'adoption-b',
      reportId: 'report-b',
      previousReportId: '',
      selectionVersion: 1,
      outcome: {
        reportId: 'report-b',
        durationMs: 90000,
        costUsd: 2.5,
        evidenceCount: 1,
      },
      createdAt: '2026-07-26T00:01:00.000Z',
    }],
  },
  effectiveConfiguration: { current: null, history: [] },
  nextCursor: null,
};

async function listenJson(calls) {
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : null;
    calls.push({ method: request.method, url: request.url, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      handoff: fixture.handoffGraph.handoffs[0],
      transition: {
        id: 'transition-a',
        action: body?.action || 'rebind',
        targetProviderSessionId: 'psess-current',
      },
      session: fixture.providerSessions[0],
      job: { id: 'job-new', status: 'accepted', turnIndex: 3 },
      currentResultReportId: body?.reportId || 'report-b',
      adoption: fixture.comparison.adoptions[0],
      idempotentReplay: false,
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve(),
    )),
  };
}

test('Work Conversation parser preserves bounded handoff, session lineage, and comparison outcomes', () => {
  const parsed = apiModule.parseAgentWorkConversationPage(fixture);
  assert.equal(parsed.handoffGraph.rootAgentId, 'root-agent');
  assert.deepEqual(parsed.handoffGraph.handoffs[0].lineage, [
    'root-agent',
    'child-agent',
  ]);
  assert.deepEqual(parsed.handoffGraph.handoffs[0].effectiveGrants.allow, [
    'tool:workspace.read',
  ]);
  assert.equal(parsed.providerSessions[0].lineage[0], 'psess-current');
  assert.equal(parsed.comparison.outcomes[0].durationMs, 120000);
  assert.equal(parsed.comparison.outcomes[0].costUsd, 1.25);
  assert.equal(parsed.comparison.outcomes[0].evidenceCount, 2);
  assert.equal(parsed.comparison.currentResultReportId, 'report-b');
});

test('Desktop API exposes only explicit handoff, cancel, session transition, and adoption routes', async () => {
  const api = apiModule.hermesApi;
  for (const method of [
    'createAgentWorkHandoff',
    'cancelAgentWorkHandoff',
    'transitionAgentWorkProviderSession',
    'adoptAgentWorkComparisonResult',
  ]) {
    assert.equal(typeof api[method], 'function', `${method} must be implemented`);
  }
  const calls = [];
  const server = await listenJson(calls);
  apiModule.setApiBaseUrl(server.baseUrl);
  try {
    await api.createAgentWorkHandoff('mission / task12', {
      clientRequestId: 'handoff-request',
      delegatorAgentId: 'root-agent',
      receiverAgentId: 'child-agent',
      goal: 'bounded goal',
    });
    await api.cancelAgentWorkHandoff(
      'mission / task12',
      'handoff / task12',
      { reason: 'user_cancelled' },
    );
    await api.transitionAgentWorkProviderSession('mission / task12', {
      clientRequestId: 'transition-request',
      action: 'fork',
      sourceProviderSessionId: 'psess-current',
      expectedActiveProviderSessionId: 'psess-current',
      text: 'fork explicitly',
    });
    await api.adoptAgentWorkComparisonResult('mission / task12', {
      selectionId: 'selection-request',
      reportId: 'report-b',
      expectedCurrentResultReportId: 'report-a',
    });
  } finally {
    await server.close();
  }
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST /api/agent-operations/work/mission%20%2F%20task12/handoffs',
    'POST /api/agent-operations/work/mission%20%2F%20task12/handoffs/handoff%20%2F%20task12/cancel',
    'POST /api/agent-operations/work/mission%20%2F%20task12/provider-session-transitions',
    'POST /api/agent-operations/work/mission%20%2F%20task12/comparison/adopt',
  ]);
});

test('Work Conversation renders one live bounded handoff/session/comparison control', async () => {
  const conversationSource = await readFile(
    new URL('src/features/agent-operations/AgentWorkConversationView.tsx', desktopRoot),
    'utf8',
  );
  assert.match(conversationSource, /AgentWorkDelegationPanel/);
  assert.match(conversationSource, /handoffGraph/);
  assert.match(conversationSource, /providerSessions/);
  assert.match(conversationSource, /comparison/);
});
