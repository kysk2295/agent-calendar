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
const apiModule = await vite.ssrLoadModule('/src/api/hermesApi.ts');

after(async () => {
  await vite.close();
});

function conversationFixture(status) {
  return {
    ok: true,
    work: {
      id: 'status-work',
      title: '상태 계약',
      agentId: 'default',
      missionThreadId: 'status-thread',
    },
    conversation: {
      id: 'status-thread',
      missionId: 'status-work',
      type: 'mission-thread',
      title: '상태 계약',
      status,
    },
    checkpoints: [],
    nextCursor: null,
  };
}

test('conversation parser accepts mission-thread statuses and rejects task-session future or scalar states', () => {
  // Given
  const statuses = ['draft', 'planning', 'waiting_for_approval'];
  const rejectedStatuses = ['proposed', 'scheduled', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'future_state', 7];

  // When / Then
  for (const status of statuses) {
    assert.equal(apiModule.parseAgentWorkConversationPage(conversationFixture(status)).conversation.status, status);
  }
  for (const status of rejectedStatuses) {
    assert.throws(
      () => apiModule.parseAgentWorkConversationPage(conversationFixture(status)),
      (error) => error?.name === 'AgentWorkParseError',
    );
  }
});

test('unused mission composer consumes the shared created-work identity contract', () => {
  // Given / When
  const source = readFileSync(new URL('../src/features/agent-operations/AgentMissionComposer.tsx', import.meta.url), 'utf8');

  // Then
  assert.match(source, /Promise<AgentCreatedWork \| null>/);
  assert.match(source, /const created = await props\.onCreate\(input\)/);
  assert.match(source, /if \(created\) props\.onClose\(\)/);
  assert.doesNotMatch(source, /Promise<boolean>/);
});
