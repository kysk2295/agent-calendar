/**
 * Phase 0 boundary characterization.
 *
 * Freezes the current pre-multi-tenant public envelopes for:
 * - Unified Calendar (calendar event CRUD)
 * - Calendar AI / chat
 * - Wiki
 * - Automation (scheduler jobs)
 * - Agent Work
 *
 * Parent plan: docs/plans/2026-07-24-phase0-boundary-characterization.md
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');

const { AgentOperationsService } = require('../app/lib/agent-operations-service');
const { HermesStore } = require('../app/lib/store');
const { createRailwayGatewayServer } = require('../app/railway-gateway-server');

const FIXED_NOW = '2026-07-24T09:00:00.000Z';
const clock = () => new Date(FIXED_NOW);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withGateway(run, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'phase0-boundary-'));
  const store = new HermesStore({ dataDir, clock });
  const agentOperationsService = new AgentOperationsService({ store, clock });
  const server = createRailwayGatewayServer({
    env: {
      DATABASE_URL: '',
      HERMES_RUNTIME_URL: '',
      ...(options.env || {}),
    },
    gatewayStore: store,
    agentOperationsService,
    fetchImpl: async () => {
      throw new Error('phase0 characterization keeps runtime offline');
    },
  });
  const baseUrl = await listen(server);
  try {
    return await run({ baseUrl, store, dataDir });
  } finally {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
    if (options.extraCleanupPaths) {
      for (const cleanupPath of options.extraCleanupPaths) {
        await rm(cleanupPath, { recursive: true, force: true });
      }
    }
  }
}

async function json(baseUrl, resourcePath, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${resourcePath}`, { ...init, headers });
  const body = await response.json();
  return { response, body };
}

function assertNoTenantOwnership(payload, label) {
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /"workspaceId"\s*:/, `${label} must not expose workspaceId before multi-tenant migration`);
  assert.doesNotMatch(serialized, /"userId"\s*:/, `${label} must not expose userId before multi-tenant migration`);
  assert.doesNotMatch(serialized, /"tenantId"\s*:/, `${label} must not expose tenantId before multi-tenant migration`);
}

function assertHasKeys(record, keys, label) {
  for (const key of keys) {
    assert.equal(Object.hasOwn(record, key), true, `${label} missing key: ${key}`);
  }
}

test('Phase 0 calendar freezes event CRUD fields, event≠task separation, and global identity', async () => {
  await withGateway(async ({ baseUrl }) => {
    const created = await json(baseUrl, '/api/calendar/events', {
      method: 'POST',
      body: JSON.stringify({
        title: '투자자 미팅',
        date: '2026-07-24',
        time: '15:00',
        endTime: '16:00',
        allDay: false,
        recurrence: 'weekly',
        notes: '보드룸',
      }),
    });

    assert.equal(created.response.status, 200);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.gatewayFallback, true);
    assertHasKeys(created.body, ['ok', 'data', 'event', 'events', 'state', 'gatewayFallback'], 'calendar create envelope');
    assertHasKeys(created.body.event, [
      'id', 'title', 'date', 'startDate', 'time', 'endTime', 'allDay',
      'recurrence', 'repeat', 'notes', 'owner', 'status', 'source', 'kind', 'type',
    ], 'calendar event');
    assert.equal(created.body.event.title, '투자자 미팅');
    assert.equal(created.body.event.date, '2026-07-24');
    assert.equal(created.body.event.time, '15:00');
    assert.equal(created.body.event.endTime, '16:00');
    assert.equal(created.body.event.allDay, false);
    assert.equal(created.body.event.recurrence, 'weekly');
    assert.equal(created.body.event.repeat, 'weekly');
    assert.equal(created.body.event.kind, 'calendar-event');
    assert.equal(created.body.event.type, 'calendar-event');
    assert.equal(created.body.event.source, 'desktop-calendar-event');
    assert.equal(created.body.event.owner, 'Me');
    assert.equal(created.body.event.status, 'Planned');
    assert.match(String(created.body.event.id), /^calendar-/);
    assertNoTenantOwnership(created.body.event, 'created calendar event');

    const listed = await json(baseUrl, '/api/calendar/events');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.ok, true);
    assertHasKeys(listed.body, ['ok', 'events', 'gatewayFallback'], 'calendar list envelope');
    assert.equal(Object.hasOwn(listed.body, 'state'), false, 'calendar list must stay compact');
    assert.equal(listed.body.events.length, 1);
    assert.equal(listed.body.events[0].id, created.body.event.id);

    const tasks = await json(baseUrl, '/api/tasks');
    assert.equal(tasks.response.status, 200);
    assert.equal(Array.isArray(tasks.body.tasks), true);
    assert.equal(
      tasks.body.tasks.some((task) => task.id === created.body.event.id || task.title === '투자자 미팅'),
      false,
      'calendar events must not leak into task list',
    );

    const patched = await json(baseUrl, `/api/calendar/events/${encodeURIComponent(created.body.event.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: '투자자 미팅(수정)',
        allDay: true,
        endTime: '',
      }),
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.body.event.title, '투자자 미팅(수정)');
    assert.equal(patched.body.event.allDay, true);
    assert.equal(patched.body.event.endTime, '');
    assert.equal(patched.body.event.kind, 'calendar-event');
    assert.equal(patched.body.event.type, 'calendar-event');
    assert.equal(patched.body.event.recurrence, 'weekly');

    const missing = await json(baseUrl, '/api/calendar/events/no-such-event', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'missing' }),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.error, 'Calendar event not found in gateway Postgres state');
    assert.equal(missing.body.gatewayFallback, true);

    const deleted = await json(baseUrl, `/api/calendar/events/${encodeURIComponent(created.body.event.id)}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.ok, true);
    assert.equal(deleted.body.event.id, created.body.event.id);
    assert.equal(deleted.body.events.length, 0);

    const afterDelete = await json(baseUrl, '/api/calendar/events');
    assert.equal(afterDelete.body.events.length, 0);
  });
});

test('Phase 0 Calendar AI freezes assistant ask envelope and calendar chat history shape', async () => {
  await withGateway(async ({ baseUrl }) => {
    await json(baseUrl, '/api/calendar/events', {
      method: 'POST',
      body: JSON.stringify({
        title: '팀 주간회의',
        date: '2026-07-24',
        time: '14:30',
        endTime: '15:30',
      }),
    });

    const ask = await json(baseUrl, '/api/assistant/ask', {
      method: 'POST',
      body: JSON.stringify({ question: '오늘 일정 알려줘' }),
    });

    assert.equal(ask.response.status, 200);
    assertHasKeys(ask.body, ['ok', 'answer', 'answerMode', 'sources', 'computed', 'search', 'llm', 'gatewayFallback'], 'assistant ask envelope');
    assert.equal(typeof ask.body.answer, 'string');
    assert.ok(ask.body.answer.length > 0);
    assert.equal(ask.body.search.strategy, 'backend-calendar-ai-rag');
    assertHasKeys(ask.body.search, [
      'strategy', 'intent', 'embeddingModel', 'candidateCount',
      'scheduleCandidateCount', 'sourceCount', 'constraints',
    ], 'assistant search metadata');
    assert.equal(Array.isArray(ask.body.sources), true);
    assertNoTenantOwnership(ask.body, 'assistant ask');

    const streamResponse = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '오늘 일정 있어?',
        view: 'calendar',
      }),
    });
    const streamBody = await streamResponse.text();
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(streamBody, /event: delta|event: final|backend-calendar-ai-rag/);

    const history = await json(baseUrl, '/api/chat/messages');
    assert.equal(history.response.status, 200);
    assertHasKeys(history.body, ['messages', 'state', 'gatewayFallback'], 'chat history envelope');
    assert.ok(history.body.messages.length >= 2, 'calendar chat must persist user and assistant turns');
    assert.equal(history.body.messages.every((message) => message.target === 'calendar'), true);
    assertHasKeys(history.body.messages[0], [
      'id', 'role', 'text', 'runId', 'wikiPath', 'agent', 'model', 'source', 'target', 'createdAt',
    ], 'chat message record');
    assert.equal(history.body.messages[0].role, 'user');
    assert.equal(history.body.messages[0].text, '오늘 일정 있어?');
    assert.equal(history.body.messages[0].source, 'schedule-assistant');
    assertNoTenantOwnership(history.body.messages, 'chat messages');
  });
});

test('Phase 0 Wiki freezes public index envelope without tenant ownership fields', async () => {
  const wikiRoot = await mkdtemp(path.join(os.tmpdir(), 'phase0-wiki-root-'));
  await mkdir(path.join(wikiRoot, '2_wiki'), { recursive: true });
  await writeFile(
    path.join(wikiRoot, '2_wiki', '운영-원칙.md'),
    [
      '# 운영 원칙',
      '',
      '백업 후 배포한다. 위키 답변은 제공된 청크에만 근거한다.',
    ].join('\n'),
    'utf8',
  );

  await withGateway(async ({ baseUrl }) => {
    const wiki = await json(baseUrl, '/api/wiki');
    assert.equal(wiki.response.status, 200);
    assertHasKeys(wiki.body, [
      'ok', 'wikiRoot', 'wikiIndex', 'tree', 'notes', 'selectedNote',
      'backlinks', 'graph', 'state', 'gatewayFallback',
    ], 'wiki envelope');
    assert.equal(wiki.body.ok, true);
    assert.equal(wiki.body.wikiRoot, '', 'public wikiRoot must stay redacted');
    assert.equal(wiki.body.wikiIndex.wikiRoot, '', 'public wikiIndex.wikiRoot must stay redacted');
    assertHasKeys(wiki.body.wikiIndex, [
      'vaultName', 'wikiRoot', 'generatedAt', 'totalNotes', 'totalAssets',
      'topFolders', 'tree', 'notes', 'recent', 'selectedNote', 'backlinks',
      'unresolvedLinks', 'searchResults', 'graph', 'gatewayFallback',
      'runtimeReachable', 'fallbackReason',
    ], 'wikiIndex');
    assert.equal(Array.isArray(wiki.body.notes), true);
    assert.equal(Array.isArray(wiki.body.tree), true);
    assert.equal(typeof wiki.body.wikiIndex.totalNotes, 'number');
    assert.ok(wiki.body.wikiIndex.totalNotes >= 1);
    assert.ok(
      wiki.body.notes.some((note) => (
        String(note.title || '').includes('운영')
        || String(note.path || '').includes('운영-원칙')
      )),
      'controlled local wiki root note must appear in public notes',
    );
    assertHasKeys(wiki.body.notes[0], ['path', 'title', 'folder', 'updatedAt', 'createdAt', 'bytes', 'excerpt'], 'wiki note summary');
    assert.equal(wiki.body.wikiIndex.fallbackReason, 'local-wiki-root');
    assert.equal(wiki.body.wikiIndex.runtimeReachable, false);
    assert.doesNotMatch(JSON.stringify(wiki.body), /Library\/Mobile Documents|CloudDocs|\/Users\//);
    assertNoTenantOwnership(wiki.body.wikiIndex, 'wiki index');
    assertNoTenantOwnership(wiki.body.notes, 'wiki notes');
  }, {
    env: { HERMES_WIKI_ROOT: wikiRoot },
    extraCleanupPaths: [wikiRoot],
  });
});

test('Phase 0 automation freezes scheduler job create/list public shape', async () => {
  await withGateway(async ({ baseUrl }) => {
    const created = await json(baseUrl, '/api/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify({
        name: '아침 브리프',
        goal: '일정 요약',
        agent: 'bizconsultant',
        schedule: '0 8 * * *',
        secret: 'must-not-leak',
        profileRoot: '/Users/private/hermes',
      }),
    });

    assert.equal(created.response.status, 200);
    assertHasKeys(created.body, ['job', 'jobs', 'state', 'gatewayFallback'], 'scheduler create envelope');
    assertHasKeys(created.body.job, [
      'id', 'name', 'goal', 'model', 'agent', 'intervalMinutes',
      'enabled', 'runCount', 'createdAt', 'source',
    ], 'scheduler job');
    assert.equal(created.body.job.name, '아침 브리프');
    assert.equal(created.body.job.goal, '일정 요약');
    assert.equal(created.body.job.agent, 'bizconsultant');
    assert.equal(created.body.job.enabled, true);
    assert.equal(created.body.job.source, 'scheduler');
    assert.match(String(created.body.job.id), /^job-/);
    assert.doesNotMatch(JSON.stringify(created.body.job), /must-not-leak|\/Users\/private|profileRoot|"secret"/);
    assertNoTenantOwnership(created.body.job, 'scheduler job');

    const listed = await json(baseUrl, '/api/scheduler/jobs');
    assert.equal(listed.response.status, 200);
    assertHasKeys(listed.body, ['ok', 'jobs', 'gatewayFallback'], 'scheduler list envelope');
    assert.equal(Object.hasOwn(listed.body, 'state'), false, 'scheduler list must stay compact');
    assert.equal(listed.body.jobs.length, 1);
    assert.equal(listed.body.jobs[0].id, created.body.job.id);
    assert.equal(listed.body.jobs[0].name, '아침 브리프');
  });
});

test('Phase 0 Agent Work freezes create and conversation public envelopes', async () => {
  await withGateway(async ({ baseUrl }) => {
    const created = await json(baseUrl, '/api/agent-operations/work', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'phase0-work-1',
        templateId: 'general-agent-work',
        title: '경계 특성화',
        objective: '현재 공개 계약 키를 고정한다.',
        initialMessage: '특성화 테스트를 위한 위임 작업',
        executionEngine: 'auto',
        deliverable: { kind: 'report', format: 'markdown' },
      }),
    });

    assert.equal(created.response.status, 201);
    assertHasKeys(created.body, ['ok', 'work', 'conversation', 'message', 'idempotentReplay'], 'agent work create envelope');
    assert.equal(created.body.ok, true);
    assert.equal(created.body.idempotentReplay, false);
    assertHasKeys(created.body.work, [
      'id', 'templateId', 'missionThreadId', 'workConversationId', 'title', 'objective',
      'status', 'timezone', 'assignmentReason', 'agentId', 'executionEngine',
      'deliverable', 'successCriteria', 'sources', 'policy', 'budget', 'createdAt', 'updatedAt',
    ], 'delegated work');
    assert.equal(created.body.work.title, '경계 특성화');
    assert.equal(created.body.work.objective, '현재 공개 계약 키를 고정한다.');
    assert.equal(created.body.work.status, 'draft');
    assert.equal(created.body.work.executionEngine, 'auto');
    assert.equal(created.body.work.templateId, 'general-agent-work');
    assert.equal(created.body.work.missionThreadId, created.body.conversation.id);
    assert.equal(created.body.work.workConversationId, created.body.conversation.id);
    assertHasKeys(created.body.conversation, [
      'id', 'missionId', 'type', 'title', 'status', 'pendingInstructions',
      'createdAt', 'updatedAt', 'lastEventAt',
    ], 'work conversation');
    assert.equal(created.body.conversation.type, 'mission-thread');
    assert.equal(created.body.conversation.missionId, created.body.work.id);
    assertHasKeys(created.body.message, [
      'id', 'sessionId', 'kind', 'text', 'sequence', 'createdAt', 'metadata',
    ], 'initial work message');
    assert.equal(created.body.message.kind, 'user_message');
    assert.equal(created.body.message.text, '특성화 테스트를 위한 위임 작업');
    assert.equal(created.body.message.sessionId, created.body.conversation.id);
    assertNoTenantOwnership(created.body, 'agent work create');

    const conversation = await json(
      baseUrl,
      `/api/agent-operations/work/${encodeURIComponent(created.body.work.id)}/conversation?limit=50`,
    );
    assert.equal(conversation.response.status, 200);
    assertHasKeys(conversation.body, ['ok', 'work', 'conversation', 'checkpoints', 'nextCursor'], 'work conversation page');
    assert.equal(conversation.body.ok, true);
    assert.equal(conversation.body.work.id, created.body.work.id);
    assert.equal(conversation.body.conversation.id, created.body.conversation.id);
    assert.equal(Array.isArray(conversation.body.checkpoints), true);
    assert.ok(conversation.body.checkpoints.length >= 1);
    assertNoTenantOwnership(conversation.body, 'work conversation page');

    const replay = await json(baseUrl, '/api/agent-operations/work', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'phase0-work-1',
        templateId: 'general-agent-work',
        title: '경계 특성화',
        objective: '현재 공개 계약 키를 고정한다.',
        initialMessage: '특성화 테스트를 위한 위임 작업',
        executionEngine: 'auto',
        deliverable: { kind: 'report', format: 'markdown' },
      }),
    });
    // Current gateway returns 200 on idempotent replay of an existing clientRequestId.
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.work.id, created.body.work.id);
    assert.equal(replay.body.conversation.id, created.body.conversation.id);
  });
});
