import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const workspace = await vite.ssrLoadModule('/src/features/agent-operations/AgentWorkWorkspace.tsx');

test('Control Home blocks create when no execution computer is currently ready', () => {
  // Given
  const runners = [{
    id: 'runner-disconnected',
    status: 'active',
    connectionState: 'disconnected',
    lastTestOk: true,
  }];

  // When
  const presentation = workspace.agentWorkCreationPresentation(runners);

  // Then
  assert.equal(presentation.canCreate, false);
  assert.match(presentation.message, /실행 컴퓨터 연결/);
  assert.doesNotMatch(presentation.message, /Runner/);
});

test('Control Home allows create when an execution computer is currently ready', () => {
  // Given
  const runners = [{
    id: 'runner-ready',
    status: 'active',
    connectionState: 'connected',
    lastTestOk: true,
  }];

  // When
  const presentation = workspace.agentWorkCreationPresentation(runners);

  // Then
  assert.equal(presentation.canCreate, true);
  assert.equal(presentation.message, '');
});

test('Mode A creates delegated work from the goal without an explicit agent override', () => {
  // Given / When
  const input = workspace.agentWorkCreateInput({
    objective: '경쟁사 세 곳의 가격을 조사해 주세요.',
    effectiveAgentId: '',
    executionEngine: 'auto',
    requestedModel: '',
  });

  // Then
  assert.equal(input.objective, '경쟁사 세 곳의 가격을 조사해 주세요.');
  assert.equal(input.title, '경쟁사 세 곳의 가격을 조사해 주세요.');
  assert.equal('agentId' in input, false);
  assert.equal(input.executionEngine, 'auto');
});

test('Control Home names goal-only Mode A and keeps role assignment optional under advanced settings', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../src/features/agent-operations/AgentWorkWorkspace.tsx', import.meta.url),
    'utf8',
  ));

  assert.match(source, /바로 시키기/);
  assert.match(source, /목표만으로 위임/);
  assert.match(source, /담당 역할 지정 \(선택\)/);
  assert.match(source, /자동 배정/);
});
