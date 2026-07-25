import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const hydration = await vite.ssrLoadModule('/src/features/connectivity/workspaceHydrationCoordinator.ts');
const writes = await vite.ssrLoadModule('/electron/workspaceSnapshotWriteGate.ts');

after(async () => {
  await vite.close();
});

test('newer hydration wins even when an older request completes last', () => {
  const coordinator = hydration.createWorkspaceHydrationCoordinator();
  const session = coordinator.activateSession('session-a');
  const older = coordinator.beginHydration(session);
  const newer = coordinator.beginHydration(session);
  let rendered = '';

  assert.ok(older);
  assert.ok(newer);
  assert.equal(coordinator.isCurrent(older), false);
  assert.equal(coordinator.isCurrent(newer), true);
  assert.equal(coordinator.commitIfCurrent(older, () => { rendered = 'older'; }), false);
  assert.equal(coordinator.commitIfCurrent(newer, () => { rendered = 'newer'; }), true);
  assert.equal(rendered, 'newer');
});

test('switching sessions invalidates every in-flight hydration from the previous Workspace', () => {
  const coordinator = hydration.createWorkspaceHydrationCoordinator();
  const sessionA = coordinator.activateSession('session-a');
  const hydrationA = coordinator.beginHydration(sessionA);
  const sessionB = coordinator.activateSession('session-b');
  const hydrationB = coordinator.beginHydration(sessionB);
  let rendered = '';

  assert.ok(hydrationA);
  assert.ok(hydrationB);
  assert.equal(coordinator.isCurrent(hydrationA), false);
  assert.equal(coordinator.beginHydration(sessionA), null);
  assert.equal(coordinator.isCurrent(hydrationB), true);
  assert.equal(coordinator.commitIfCurrent(hydrationA, () => { rendered = 'workspace-a'; }), false);
  assert.equal(coordinator.commitIfCurrent(hydrationB, () => { rendered = 'workspace-b'; }), true);
  assert.equal(rendered, 'workspace-b');
});

test('snapshot write gate rejects another session and an older hydrate generation', () => {
  const gate = writes.createWorkspaceSnapshotWriteGate();

  assert.equal(gate.authorize('session-a', { sessionId: 'session-a', generation: 2 }), true);
  assert.equal(gate.authorize('session-b', { sessionId: 'session-a', generation: 3 }), false);
  assert.equal(gate.authorize('session-a', { sessionId: 'session-a', generation: 1 }), false);
  assert.equal(gate.authorize('session-a', { sessionId: 'session-a', generation: 2 }), true);
  assert.equal(gate.authorize('session-a', { sessionId: 'session-a', generation: 3 }), true);
});

test('re-resolving the same secure session keeps hydrate generations monotonic', () => {
  const coordinator = hydration.createWorkspaceHydrationCoordinator();
  const firstSession = coordinator.activateSession('session-a');
  const first = coordinator.beginHydration(firstSession);

  coordinator.beginSessionTransition();
  const restoredSession = coordinator.activateSession('session-a');
  const second = coordinator.beginHydration(restoredSession);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
});
