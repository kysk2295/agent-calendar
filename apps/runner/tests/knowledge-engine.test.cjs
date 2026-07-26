'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getEngineAdapter } = require('../lib/engines');
const {
  listKnowledgeSources,
  registerKnowledgeSource,
  removeKnowledgeSource,
} = require('../lib/store');

test('knowledge engine searches only requested local sources and returns path-free evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-calendar-knowledge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceA = path.join(root, 'source-a');
  const sourceB = path.join(root, 'source-b');
  fs.mkdirSync(sourceA);
  fs.mkdirSync(sourceB);
  fs.writeFileSync(path.join(sourceA, 'memo.md'), 'alpha-only local planning evidence');
  fs.writeFileSync(path.join(sourceB, 'other.md'), 'alpha-only unauthorized evidence');

  registerKnowledgeSource(root, {
    sourceId: 'source-a',
    path: sourceA,
    label: 'Local A',
  });
  registerKnowledgeSource(root, {
    sourceId: 'source-b',
    path: sourceB,
    label: 'Local B',
  });

  const adapter = getEngineAdapter('knowledge');
  const result = await adapter.run({
    jobPayload: {
      kind: 'knowledge_search',
      query: 'alpha-only',
      sourceIds: ['source-a'],
    },
    knowledgeSources: listKnowledgeSources(root),
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);
  const payload = JSON.parse(result.artifacts[0].content);
  assert.equal(payload.kind, 'knowledge_search_evidence');
  assert.ok(payload.hits.length >= 1);
  assert.ok(payload.hits.every((hit) => hit.sourceId === 'source-a'));
  assert.match(payload.hits[0].excerpt, /alpha-only/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.equal(removeKnowledgeSource(root, 'source-a'), true);
  assert.deepEqual(listKnowledgeSources(root).map((source) => source.sourceId), ['source-b']);
});

test('knowledge engine rejects non-knowledge jobs', async () => {
  const adapter = getEngineAdapter('knowledge');
  const result = await adapter.run({
    jobPayload: { kind: 'general_agent_work', query: 'anything', sourceIds: [] },
    knowledgeSources: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'KNOWLEDGE_JOB_INVALID');
  assert.equal(result.retryable, false);
});
