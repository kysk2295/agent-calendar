import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const workerStripModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkerStrip.tsx');
const conversationModule = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkConversationView.tsx');

after(async () => {
  await vite.close();
});

const mission = {
  id: 'worker-work',
  title: '경쟁사 근거 검증',
  objective: '경쟁사 근거를 교차 검증합니다.',
  status: 'active',
  executionEngine: 'auto',
  deliverable: { kind: 'file', format: 'auto' },
};

test('worker projection renders truthful text statuses and actual engines when evidenced', () => {
  const rows = workerStripModule.projectAgentWorkerRows({
    mission,
    tasks: [
      { id: 'collect', sessionId: 'session-collect', title: '근거 수집', status: 'running', agent: 'researcher', executionEngine: 'auto' },
      { id: 'verify', sessionId: '', title: '출처 검증', status: 'blocked', agent: 'reviewer', executionEngine: 'claude' },
    ],
    checkpoints: [
      { id: 'cp-1', sessionId: 'session-collect', sequence: 1, kind: 'progress', text: '공개 자료를 수집하고 있습니다.', metadata: { taskId: 'collect', resolvedExecutionEngine: 'codex', resolvedExecutionModel: 'gpt-5.6-codex' }, createdAt: '2026-07-31T00:00:00.000Z' },
      { id: 'cp-2', sessionId: 'session-collect', sequence: 2, kind: 'completion', text: '수집 결과를 저장했습니다.', metadata: { taskId: 'collect' }, createdAt: '2026-07-31T00:00:01.000Z' },
    ],
    responsibleAgentName: '리서치 에이전트',
    resolvedExecutionEngine: null,
    resolvedExecutionModel: '',
  });

  assert.deepEqual(rows.map((row) => row.statusLabel), ['진행 중', '차단됨']);
  assert.equal(rows[0].engineLabel, 'Codex · gpt-5.6-codex');
  assert.equal(rows[1].engineLabel, '확인 필요');

  const html = renderToStaticMarkup(React.createElement(workerStripModule.AgentWorkerStrip, {
    rows,
    openWorkerId: null,
    onOpen: () => {},
    onClose: () => {},
    onOpenSession: () => {},
  }));
  assert.match(html, /aria-label="하위 작업자 상태"/);
  assert.match(html, /근거 수집/);
  assert.match(html, />진행 중</);
  assert.match(html, /출처 검증/);
  assert.match(html, />차단됨</);
  assert.match(html, /실행 상세 열기/);
});

test('single-engine work keeps one honest row and missing evidence visible', () => {
  const rows = workerStripModule.projectAgentWorkerRows({
    mission: { ...mission, status: 'draft' },
    tasks: [],
    checkpoints: [],
    responsibleAgentName: '기본 에이전트',
    resolvedExecutionEngine: null,
    resolvedExecutionModel: '',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].statusLabel, '계획 대기');
  assert.equal(rows[0].engineLabel, '확인 필요');
  assert.match(rows[0].detailLines.join(' '), /실행 근거 확인 필요/);
});

test('latest comparison evidence becomes parallel worker rows without an engine leaderboard', () => {
  const rows = workerStripModule.projectAgentWorkerRows({
    mission,
    tasks: [],
    checkpoints: [
      { id: 'codex-result', sessionId: 'thread-worker', sequence: 4, kind: 'agent_message', text: 'Codex 초안', metadata: { turnMode: 'comparison', turnIndex: 2, turnTargetIndex: 0, resolvedExecutionEngine: 'codex' }, createdAt: '2026-07-31T00:00:00.000Z' },
      { id: 'claude-result', sessionId: 'thread-worker', sequence: 5, kind: 'error', text: 'Claude 실행 오류', metadata: { turnMode: 'comparison', turnIndex: 2, turnTargetIndex: 1, resolvedExecutionEngine: 'claude' }, createdAt: '2026-07-31T00:00:01.000Z' },
    ],
    responsibleAgentName: '기본 에이전트',
    resolvedExecutionEngine: null,
    resolvedExecutionModel: '',
  });

  assert.deepEqual(rows.map((row) => row.engineLabel), ['Codex', 'Claude']);
  assert.deepEqual(rows.map((row) => row.statusLabel), ['기록 확인', '실패']);
  assert.deepEqual(rows.map((row) => row.workLabel), ['비교 실행 1', '비교 실행 2']);
});

test('execution detail opens as a secondary drawer without replacing the worker strip', () => {
  const rows = workerStripModule.projectAgentWorkerRows({
    mission,
    tasks: [{ id: 'draft', sessionId: 'session-draft', title: '초안 작성', status: 'completed', agent: 'writer', executionEngine: 'codex' }],
    checkpoints: [],
    responsibleAgentName: '작성 에이전트',
    resolvedExecutionEngine: null,
    resolvedExecutionModel: '',
  });
  const html = renderToStaticMarkup(React.createElement(workerStripModule.AgentWorkerStrip, {
    rows,
    openWorkerId: rows[0].id,
    onOpen: () => {},
    onClose: () => {},
    onOpenSession: () => {},
  }));

  assert.match(html, /class="agent-worker-strip"/);
  assert.match(html, /class="agent-worker-detail"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /role="log"/);
  assert.match(html, /Task Session 전체 기록 열기/);
});

test('Work Conversation mounts the worker strip between its header and timeline', () => {
  const html = renderToStaticMarkup(React.createElement(conversationModule.AgentWorkConversationView, {
    mission,
    tasks: [],
    reports: [],
    responsibleAgentName: '기본 에이전트',
    provisional: false,
    conversation: null,
    loading: false,
    error: '',
    aggregateStale: false,
    busy: '',
    onBack: () => {},
    onRefresh: async () => true,
    onSendMessage: async () => ({ status: 'accepted', applicationMode: 'mission_context', acceptedAt: '2026-07-31T00:00:00.000Z' }),
    onPlanMission: async () => {},
    onApprovePlan: async () => {},
    onMissionWorkAction: async () => {},
    onTaskAction: async () => true,
    onRunTaskNow: async () => {},
    onOpenSession: () => {},
    onReportFeedback: async () => {},
    onFollowUpDecision: async () => {},
    liveTurn: { active: false, text: '', error: '', refreshFailed: false },
    runners: [],
    controlPlaneBaseUrl: '',
  }));
  const headerIndex = html.indexOf('class="agent-work-header"');
  const stripIndex = html.indexOf('class="agent-worker-strip"');
  const timelineIndex = html.indexOf('class="agent-work-timeline"');

  assert.ok(headerIndex >= 0 && headerIndex < stripIndex);
  assert.ok(stripIndex < timelineIndex);
});
