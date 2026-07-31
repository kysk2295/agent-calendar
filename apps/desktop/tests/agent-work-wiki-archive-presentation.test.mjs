import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Lightweight source contracts — full React mount is covered by Playwright later.
const conversationSource = readFileSync(
  new URL('../src/features/agent-operations/AgentWorkConversationView.tsx', import.meta.url),
  'utf8',
);
const presentationSource = readFileSync(
  new URL('../src/features/agent-operations/workConversationPresentation.ts', import.meta.url),
  'utf8',
);
const typesSource = readFileSync(
  new URL('../src/features/agent-operations/types.ts', import.meta.url),
  'utf8',
);
const parserSource = readFileSync(
  new URL('../src/features/agent-operations/agentOperations.ts', import.meta.url),
  'utf8',
);

test('desktop types expose wiki archive and memory pin fields', () => {
  assert.match(typesSource, /AgentWikiArchive/);
  assert.match(typesSource, /wikiArchive\?:/);
  assert.match(typesSource, /proposedMemoryPins\?:/);
});

test('mission parser reads wikiArchive and proposedMemoryPins', () => {
  assert.match(parserSource, /function parseWikiArchive/);
  assert.match(parserSource, /proposedMemoryPins/);
  assert.match(parserSource, /wikiArchive/);
});

test('conversation view surfaces archive panel and pin action', () => {
  assert.match(conversationSource, /agent-work-archive-panel/);
  assert.match(conversationSource, /wikiArchiveStatusLabel/);
  assert.match(conversationSource, /기억에 고정/);
  assert.match(conversationSource, /onPinAgentMemory/);
  assert.match(presentationSource, /function wikiArchiveStatusLabel/);
  assert.match(presentationSource, /위키에 보관됨/);
  assert.match(presentationSource, /위키 미설정/);
});
