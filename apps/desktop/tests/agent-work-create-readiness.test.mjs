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
