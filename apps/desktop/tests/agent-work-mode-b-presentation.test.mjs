import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = readFileSync(
  new URL('../src/features/agent-operations/AgentWorkWorkspace.tsx', import.meta.url),
  'utf8',
);
const conversation = readFileSync(
  new URL('../src/features/agent-operations/AgentWorkConversationView.tsx', import.meta.url),
  'utf8',
);
const service = readFileSync(
  new URL('../../backend/app/lib/agent-operations-service.js', import.meta.url),
  'utf8',
);
const publicRecords = readFileSync(
  new URL('../../backend/app/lib/public-agent-records.js', import.meta.url),
  'utf8',
);

test('Control Home exposes Mode A and Mode B delegation controls', () => {
  assert.match(workspace, /Mode A · 목표만/);
  assert.match(workspace, /Mode B · 역할 지정/);
  assert.match(workspace, /delegationMode === 'mode_b'/);
  assert.match(workspace, /Mode B 담당 에이전트/);
});

test('conversation surfaces delegation mode badge when present', () => {
  assert.match(conversation, /agent-work-delegation-mode/);
  assert.match(conversation, /Mode B · 역할 지정/);
});

test('backend stamps and projects delegationMode for explicit agent selection', () => {
  assert.match(service, /delegationMode: explicitAgent \? 'mode_b' : 'mode_a'/);
  assert.match(publicRecords, /delegationMode === 'mode_a' \|\| delegationMode === 'mode_b'/);
});
