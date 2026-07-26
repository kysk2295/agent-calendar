import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import React from 'react';
import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const liveStream = await vite.ssrLoadModule('/src/features/agent-operations/agentWorkLiveStream.ts');
const timelineModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkTimeline.tsx');
const controlHomeModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentControlRoomBoard.tsx');
const conversationModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkConversationView.tsx');
const composerModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkComposer.tsx');
const presentationModule = await vite.ssrLoadModule('/src/features/agent-operations/workConversationPresentation.ts');
const workspaceModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkWorkspace.tsx');

after(async () => {
  await vite.close();
});

test('live Work SSE parser preserves accepted, delta, checkpoint, error, and done order without accepting unknown events', async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([
        'event: accepted\n',
        'data: {"delivery":{"status":"accepted","applicationMode":"mission_context","acceptedAt":"2026-07-15T00:00:00.000Z"},"idempotentReplay":false}\n\n',
        'event: delta\n',
        'data: {"text":"실시간 "}\n\n',
        'event: ignored\n',
        'data: {"secret":"must not reach the UI"}\n\n',
        'event: checkpoint\n',
        'data: {"checkpoint":{"id":"session-event-live","sessionId":"mission-thread-live","sequence":2,"kind":"agent_message","text":"실시간 응답입니다.","metadata":{},"createdAt":"2026-07-15T00:00:01.000Z"}}\n\n',
        'event: error\n',
        'data: {"code":"runtime_unavailable","message":"실시간 작업 응답을 시작하지 못했습니다."}\n\n',
        'event: done\n',
        'data: {"idempotentReplay":false}\n\n',
      ].join('')));
      controller.close();
    },
  }));
  const events = [];

  await liveStream.consumeAgentWorkLiveSse(response, async (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), ['accepted', 'delta', 'checkpoint', 'error', 'done']);
  assert.equal(events[0].delivery.status, 'accepted');
  assert.equal(events[1].text, '실시간 ');
  assert.equal(events[2].checkpoint.text, '실시간 응답입니다.');
  assert.equal(events[3].code, 'runtime_unavailable');
});

test('delegated work titles use the backend title boundary instead of the old UI-only 72-character truncation', () => {
  const request = '가'.repeat(90);

  assert.equal(workspaceModule.titleFromRequest(request), request);
  assert.equal(workspaceModule.titleFromRequest('나'.repeat(310)).length, 300);
  const emojiTitle = workspaceModule.titleFromRequest('😀'.repeat(151));
  assert.equal(emojiTitle.length <= 300, true);
  assert.equal(/^[\s\S]*[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiTitle), false);
  assert.equal(workspaceModule.displayMissionTitle(`${request.slice(0, 72)}...`, request), request);
});

test('stored deliverable values and Korean closing phrases have readable presentation labels', () => {
  assert.equal(presentationModule.deliverableKindLabel('file'), '파일');
  assert.equal(presentationModule.deliverableFormatLabel('auto'), '자동');
  assert.match(presentationModule.preserveWorkClosingPhrase('한 문장으로 확인해 주세요.'), /문장으로\u00a0확인해\u00a0주세요\./);
  assert.match(presentationModule.preserveWorkClosingPhrase('응답· 검증되는지 확인하는 것입니다.'), /응답·\u00a0검증되는지/);
  assert.match(presentationModule.preserveWorkClosingPhrase('이 작업의 목적을 한 문장으로 확인해 주세요.'), /이\u00a0작업의\u00a0목적을/);
});

test('the Work Conversation composer exposes one active response engine without forking the conversation', () => {
  const html = renderToStaticMarkup(React.createElement(composerModule.AgentWorkComposer, {
    onSend: async () => ({ status: 'accepted', applicationMode: 'mission_context', acceptedAt: '2026-07-26T00:00:00.000Z' }),
    streaming: false,
    refreshError: '',
    activeEngine: 'claude',
    activeModel: '',
    modelCapabilities: {
      claude: {
        models: ['claude-sonnet-4-6', 'claude-opus-4-1'],
        defaultModel: '',
        modelSelection: 'catalog',
      },
    },
    availableEngines: ['codex', 'claude'],
  }));

  assert.match(html, /aria-label="이 메시지의 실행 엔진"/);
  assert.match(html, /aria-label="이 메시지의 실행 모델"/);
  assert.match(html, /Runner 기본 모델/);
  assert.match(html, /claude-sonnet-4-6/);
  assert.match(html, /<option value="codex">Codex<\/option>/);
  assert.match(html, /<option value="claude" selected="">Claude<\/option>/);
  assert.match(html, /같은 작업 대화 · 한 엔진만 응답/);
  assert.match(html, /aria-label="여러 실행 엔진 비교"/);
  assert.deepEqual(
    composerModule.comparisonTargetsForEngines(['codex', 'claude', 'codex']),
    [{ executionEngine: 'codex' }, { executionEngine: 'claude' }],
  );
});

test('a partial live response keeps its transport error visible instead of presenting it as an agent answer', () => {
  const html = renderToStaticMarkup(timelineModule.AgentWorkTimeline({
    checkpoints: [],
    loading: false,
    error: '',
    readOnly: false,
    tasks: [],
    reports: [],
    currentResultReportId: '',
    responsibleAgentName: '비즈니스 컨설턴트',
    busy: '',
    onTaskAction: async () => false,
    onOpenSession: () => {},
    onReportFeedback: async () => {},
    onFollowUpDecision: async () => {},
    onRefresh: async () => {},
    onRetry: async () => {},
    liveTurn: { active: false, text: '부분 응답입니다.', error: '실시간 연결이 끊겼습니다.' },
  }));

  assert.match(html, />오류</);
  assert.match(html, /부분 응답/);
  assert.match(html, /실시간 연결이 끊겼습니다/);
  assert.doesNotMatch(html, />담당 에이전트<\/span><time>연결 확인 필요/);
});

test('comparison results show the exact execution engine and resolved model origin', () => {
  const html = renderToStaticMarkup(timelineModule.AgentWorkTimeline({
    checkpoints: [{
      id: 'comparison-result-codex',
      sessionId: 'mission-thread-live',
      sequence: 8,
      kind: 'completion',
      text: 'Codex comparison result',
      metadata: {
        applicationMode: 'checkpoint_result',
        resolvedExecutionEngine: 'codex',
        requestedExecutionModel: 'gpt-5.6-codex',
        resolvedExecutionModel: 'gpt-5.6-sol',
        turnIndex: 2,
        turnTargetIndex: 0,
        turnMode: 'comparison',
      },
      createdAt: '2026-07-26T00:00:00.000Z',
    }],
    loading: false,
    error: '',
    readOnly: false,
    tasks: [],
    reports: [],
    currentResultReportId: '',
    responsibleAgentName: '비교 담당 에이전트',
    busy: '',
    onTaskAction: async () => false,
    onOpenSession: () => {},
    onReportFeedback: async () => {},
    onFollowUpDecision: async () => {},
    onRefresh: async () => {},
    onRetry: async () => {},
    liveTurn: { active: false, text: '', error: '' },
  }));

  assert.match(html, /Codex · gpt-5\.6-sol/);
  assert.match(html, /Codex comparison result/);
});

test('runtime command placeholders stay out of the operator Work Conversation', () => {
  const html = renderToStaticMarkup(timelineModule.AgentWorkTimeline({
    checkpoints: [
      { id: 'runtime-placeholder', sessionId: 'mission-thread-live', sequence: 1, kind: 'progress', text: '[redacted-command]', metadata: {}, createdAt: '2026-07-15T00:00:00.000Z' },
      { id: 'runtime-placeholder-error', sessionId: 'mission-thread-live', sequence: 1.5, kind: 'error', text: '[redacted-command]', metadata: {}, createdAt: '2026-07-15T00:00:00.500Z' },
      { id: 'runtime-plan', sessionId: 'mission-thread-live', sequence: 2, kind: 'plan', text: 'Planning mission: internal task graph', metadata: {}, createdAt: '2026-07-15T00:00:01.000Z' },
      { id: 'runtime-pause', sessionId: 'mission-thread-live', sequence: 3, kind: 'approval_response', text: 'pause: scheduled → blocked', metadata: {}, createdAt: '2026-07-15T00:00:02.000Z' },
      { id: 'structured-agent-result', sessionId: 'mission-thread-live', sequence: 4, kind: 'agent_message', text: '{"summary":"검토 범위를 정리했습니다.","tasks":[{"title":"근거 확인"}]}', metadata: {}, createdAt: '2026-07-15T00:00:03.000Z' },
      { id: 'operator-progress', sessionId: 'mission-thread-live', sequence: 5, kind: 'progress', text: '승인된 자료를 검토하고 있습니다.', metadata: { progress: 40 }, createdAt: '2026-07-15T00:00:04.000Z' },
    ],
    loading: false,
    error: '',
    readOnly: false,
    tasks: [],
    reports: [],
    currentResultReportId: '',
    responsibleAgentName: '비즈니스 컨설턴트',
    busy: '',
    onTaskAction: async () => false,
    onOpenSession: () => {},
    onReportFeedback: async () => {},
    onFollowUpDecision: async () => {},
    onRefresh: async () => {},
    onRetry: async () => {},
    liveTurn: { active: false, text: '', error: '' },
  }));

  assert.doesNotMatch(html, /redacted-command/);
  assert.doesNotMatch(html, /Planning mission|pause: scheduled/);
  assert.doesNotMatch(html, /&quot;tasks&quot;|"tasks"/);
  assert.match(html, /검토\s범위를\s정리했습니다/);
  assert.match(html, /승인된\s자료를\s검토하고\s있습니다/);
});

test('a blocked task overrides the active mission badge with an attention state', () => {
  const mission = { id: 'blocked-work', templateId: 'general-agent-work', title: '검토 작업', objective: '검토 작업', status: 'active', agentId: 'default', executionEngine: 'auto', deliverable: { kind: 'file', format: 'auto' }, missionThreadId: 'thread-blocked', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' };
  const html = renderToStaticMarkup(React.createElement(conversationModule.AgentWorkConversationView, {
    mission,
    tasks: [{ id: 'blocked-task', missionId: mission.id, agent: 'default', status: 'blocked', title: '근거 확인', reason: '실행 연결 확인 필요', expectedOutput: '근거 목록', scheduledAt: mission.createdAt }],
    reports: [], responsibleAgentName: '기본 에이전트', provisional: false,
    conversation: { work: { ...mission, assignment: { kind: 'default', agentId: 'default' }, resolvedExecutionEngine: null, workConversationId: 'conversation-blocked', revision: { revisionCounter: 0, pendingRevisionId: '', currentResultReportId: '' } }, conversation: { id: 'conversation-blocked', missionId: mission.id, taskId: '', type: 'mission-thread', title: mission.title, status: 'planning', pendingInstructions: [], executionEngine: 'auto', deliverable: mission.deliverable, createdAt: mission.createdAt, updatedAt: mission.updatedAt }, checkpoints: [], nextCursor: null },
    loading: false, error: '', aggregateStale: true, busy: '', onBack: () => {}, onRefresh: async () => true,
    onSendMessage: async () => ({ status: 'accepted', applicationMode: 'mission_context', acceptedAt: mission.createdAt }), onPlanMission: async () => {}, onApprovePlan: async () => {}, onMissionWorkAction: async () => {}, onTaskAction: async () => false, onRunTaskNow: async () => {}, onOpenSession: () => {}, onReportFeedback: async () => {}, onFollowUpDecision: async () => {}, liveTurn: { active: false, text: '', error: '' },
  }));

  assert.match(html, /data-status="blocked">확인 필요/);
  assert.doesNotMatch(html, />운영 중</);
});

test('a disabled responsible agent is labeled as stopped instead of ready', () => {
  const html = renderToStaticMarkup(controlHomeModule.AgentControlRoomBoard({
    state: { tasks: [], reports: [], missions: [] },
    agents: [{ id: 'stopped-agent', displayName: '중지 에이전트', status: 'ready', enabled: false }],
    automationJobs: [],
    readOnly: false,
    busy: '',
    onOpenMission: () => {},
    onTaskAction: async () => false,
  }));

  assert.match(html, /중지됨/);
  assert.doesNotMatch(html, /준비됨/);
});

test('Control Home reports missing scheduler and proposal estimates without inventing values', () => {
  const html = renderToStaticMarkup(controlHomeModule.AgentControlRoomBoard({
    state: {
      reports: [],
      missions: [{ id: 'work-proposed', title: '검토 작업', status: 'draft', agentId: 'default', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' }],
      tasks: [{ id: 'proposal-without-estimate', missionId: 'work-proposed', agent: 'default', status: 'proposed', title: '근거 확인', reason: '승인 후 진행', expectedOutput: '', scheduledAt: '2026-07-15T00:00:00.000Z' }],
    },
    agents: [],
    automationJobs: [{ id: 'job-without-next-run', name: '원격 상태 확인', status: 'active', enabled: true, schedule: 'every 5m', nextRunAt: '', lastRunAt: '', lastStatus: '' }],
    readOnly: false,
    busy: '',
    onOpenMission: () => {},
    onTaskAction: async () => false,
  }));

  assert.match(html, /다음 실행 확인 필요/);
  assert.match(html, /활성 자동화 <b>1개/);
  assert.match(html, /결과 형식 확인 필요/);
  assert.match(html, /예상 시간 미정/);
  assert.doesNotMatch(html, /예상 30분/);
});

test('Control Home does not count unknown automation state as active', () => {
  const html = renderToStaticMarkup(controlHomeModule.AgentControlRoomBoard({
    state: { tasks: [], reports: [], missions: [] }, agents: [],
    automationJobs: [{ id: 'unknown-job', name: '연결 확인', description: '', agentId: '', enabled: null, status: 'unknown', schedule: 'every 5m', nextRunAt: '2026-07-15T01:00:00.000Z', lastRunAt: '', lastStatus: '', source: '' }],
    readOnly: false, busy: '', onOpenMission: () => {}, onTaskAction: async () => false,
  }));

  assert.match(html, /활성 여부 확인 필요/);
  assert.doesNotMatch(html, /활성 자동화 <b>1개/);
});

test('Control Home keeps existing automations as truthful read-only summary cards', () => {
  const html = renderToStaticMarkup(controlHomeModule.AgentControlRoomBoard({
    state: { tasks: [], reports: [], missions: [] }, agents: [],
    automationJobs: [
      { id: 'morning-brief', name: '아침 브리핑', description: '', agentId: 'wikicurator', enabled: true, status: 'active', schedule: '매일 09:00', nextRunAt: '2026-07-16T00:00:00.000Z', lastRunAt: '2026-07-15T00:00:00.000Z', lastStatus: 'completed', source: 'hermes' },
      { id: 'weekly-review', name: '주간 검토', description: '', agentId: '', enabled: null, status: 'unknown', schedule: '', nextRunAt: '', lastRunAt: '', lastStatus: '', source: 'hermes' },
    ],
    readOnly: false, busy: '', onOpenMission: () => {}, onTaskAction: async () => false,
  }));

  assert.match(html, /기존 자동화/);
  assert.match(html, /아침 브리핑/);
  assert.match(html, /wikicurator/);
  assert.match(html, /매일 09:00/);
  assert.match(html, /주간 검토/);
  assert.match(html, /활성 여부 확인 필요/);
  assert.match(html, /일정 확인 필요/);
  assert.doesNotMatch(html, /자동화[^<]*실행|자동화[^<]*삭제/);
});

test('automation summaries translate simple cadence and fail closed for invalid runtime timestamps', () => {
  const html = renderToStaticMarkup(controlHomeModule.AgentControlRoomBoard({
    state: { tasks: [], reports: [], missions: [] }, agents: [],
    automationJobs: [{ id: 'invalid-runtime', name: '연결 점검', description: '', agentId: 'default', enabled: true, status: 'active', schedule: 'every 5m', nextRunAt: 'not-a-date', lastRunAt: 'not-a-date', lastStatus: 'scheduled', source: 'hermes' }],
    readOnly: false, busy: '', onOpenMission: () => {}, onTaskAction: async () => false,
  }));

  assert.match(html, /5분마다/);
  assert.match(html, /최근 실행 확인 필요/);
  assert.match(html, /다음 실행 확인 필요/);
  assert.doesNotMatch(html, /every 5m|최근 예정|다음 예정|· scheduled/);
});

test('the primary Work action keeps readable text on the contrast-safe accent shade', () => {
  const css = fs.readFileSync(fileURLToPath(new URL('../src/features/agent-operations/agent-workspace.css', import.meta.url)), 'utf8');
  const primaryAction = css.match(/\.agent-work-primary-action\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(primaryAction, /background:\s*var\(--accent-dark\)\s*!important/);
  assert.doesNotMatch(primaryAction, /background:\s*var\(--accent\)\s*!important/);
});
