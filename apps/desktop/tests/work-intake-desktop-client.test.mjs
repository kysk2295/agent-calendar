import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const clientModule = await vite.ssrLoadModule(
  '/src/features/agent-operations/workConversationClient.ts',
);
const apiSource = readFileSync(fileURLToPath(new URL('../src/api/hermesApi.ts', import.meta.url)), 'utf8');

after(async () => vite.close());

function containsRawLocalPath(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    /^(?:path|cwd|root|wikiRoot|localPath|absolutePath)$/i.test(key)
    || containsRawLocalPath(child)
  ));
}

test('Desktop create previews then starts Work Intake and never posts a raw local path', async () => {
  assert.match(apiSource, /previewAgentWork:[\s\S]*\/api\/work-intake\/preview/);
  assert.match(apiSource, /startAgentWork:[\s\S]*\/api\/work-intake\/start/);
  assert.match(apiSource, /createAgentWork:[\s\S]*\/api\/agent-operations\/work/);

  const calls = [];
  const response = {
    work: { id: 'mission-work-intake' },
    conversation: { id: 'conversation-work-intake' },
    message: { id: 'message-work-intake' },
    idempotentReplay: false,
  };
  const client = clientModule.createAgentWorkClient({
    createId: () => 'request-work-intake',
    transport: {
      createAgentWork: async () => {
        throw new Error('legacy create must not be used when Work Intake is available');
      },
      previewAgentWork: async (request) => {
        calls.push({ kind: 'preview', request: structuredClone(request) });
        return { snapshotId: 'wip-preview-a' };
      },
      startAgentWork: async (request) => {
        calls.push({ kind: 'start', request: structuredClone(request) });
        return response;
      },
      sendAgentWorkMessage: async () => {
        throw new Error('not used');
      },
    },
  });

  assert.equal(await client.create({
    title: 'Evidence brief',
    objective: 'Prepare the cited evidence brief.',
    initialMessage: 'Start with the active sources.',
    executionEngine: 'auto',
    deliverable: { kind: 'report', format: 'markdown' },
  }), response);

  assert.deepEqual(calls.map(({ kind }) => kind), ['preview', 'start']);
  assert.equal(calls[0].request.goal, 'Prepare the cited evidence brief.');
  assert.equal(Object.hasOwn(calls[0].request, 'objective'), false);
  assert.deepEqual(calls[0].request.workingContext, { kind: 'workspace_general' });
  assert.equal(calls[1].request.previewSnapshotId, 'wip-preview-a');
  assert.deepEqual(calls[1].request.workingContext, { kind: 'workspace_general' });
  assert.equal(containsRawLocalPath(calls), false);
});
