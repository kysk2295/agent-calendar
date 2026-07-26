import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const domain = await vite.ssrLoadModule('/src/domains/knowledge/knowledge.ts');

test('Knowledge resolves persisted identity from document create responses', () => {
  const nested = { title: '새 문서', path: 'wiki/new.md' };

  assert.equal(domain.docIdentity({ title: '제목만' }), '제목만');
  assert.equal(domain.persistedDocumentIdentity({ title: '제목만' }), '');
  assert.equal(domain.createdDocumentFrom({ data: { document: nested } }), nested);
  assert.deepEqual(domain.createdDocumentFrom({ document: { title: '임시' }, id: 'created-1' }), {
    document: { title: '임시' },
    id: 'created-1',
  });
});

test('Knowledge identifies, merges, and renders journal documents', () => {
  const journal = {
    path: '4_Journal/2026-07-23.md',
    title: '목요일 기록',
    content: '---\r\ndate: 2026-07-23\r\nmood: good\r\n---\r\n오늘의 기록',
  };
  const titleJournal = { id: 'diary-title', title: '여행 일기', summary: '짧은 기록' };
  const duplicate = { path: journal.path, title: '중복' };

  assert.equal(domain.isJournalDoc(journal), true);
  assert.equal(domain.isJournalDoc(titleJournal), true);
  assert.deepEqual(domain.mergeDocsByIdentity([journal], [duplicate, titleJournal]), [journal, titleJournal]);
  assert.equal(domain.journalBody(journal), '오늘의 기록');
  assert.equal(domain.journalDateKey(journal), '2026-07-23');
  assert.equal(domain.journalTime(journal), Date.parse('2026-07-23T00:00:00'));
  assert.equal(domain.hasWikiFullBody(titleJournal), false);
});

test('Knowledge gathers journal documents from nested wiki payloads', () => {
  const nestedJournal = { id: 'journal-1', kind: 'journal', body: 'entry' };
  const ordinary = { id: 'note-1', kind: 'note' };
  const payload = {
    wikiIndex: {
      notes: [nestedJournal, ordinary],
      selectedNote: nestedJournal,
    },
  };

  assert.equal(domain.wikiDetail(payload), nestedJournal);
  assert.deepEqual(domain.wikiList(payload), [nestedJournal, ordinary]);
  assert.deepEqual(domain.wikiJournalDocs(payload), [nestedJournal]);
});

test('Knowledge fallback graph resolves aliases and deduplicates undirected edges', () => {
  const nodes = [
    {
      path: 'notes/Alpha.md',
      title: 'Alpha',
      content: '[[Beta Alias]]\n[Beta](Beta.md)\n[[https://example.com]]',
    },
    {
      path: 'notes/Beta.md',
      title: 'Beta Alias',
      content: '[[Alpha]]',
    },
    {
      path: 'notes/Image.md',
      content: '[asset](asset.png)',
    },
  ];

  assert.deepEqual(domain.buildWikiGraphFallbackEdges(nodes), [{
    id: 'fallback-notes/Alpha.md::notes/Beta.md',
    from: 'notes/Alpha.md',
    to: 'notes/Beta.md',
  }]);
});

test('Knowledge graph layout is deterministic and finite', () => {
  const nodes = [
    { path: 'Alpha.md', title: 'Alpha', group: 'notes' },
    { path: 'Beta.md', title: 'Beta', group: 'notes' },
    { path: 'Loose.md', title: 'Loose' },
  ];
  const edges = [{ from: 'Alpha.md', to: 'Beta', id: 'edge-1' }];

  const first = domain.buildWikiGraphLayout(nodes, [], edges, {
    centerForce: 1.1,
    repelForce: 0.9,
    linkDistance: 1.2,
  });
  const second = domain.buildWikiGraphLayout(nodes, [], edges, {
    centerForce: 1.1,
    repelForce: 0.9,
    linkDistance: 1.2,
  });

  assert.deepEqual(first, second);
  assert.equal(first.edges[0].to, 'Beta.md');
  assert.equal(first.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)), true);
});

test('Knowledge applies wiki SSE delta, done, sources, and metadata blocks', () => {
  const initial = {
    answer: '앞',
    sources: [{ id: 'old-source' }],
    meta: {
      provider: 'railway-hermes',
      agent: 'wikicurator',
      model: 'wikicurator',
      source: 'stream',
      gatewayFallback: false,
    },
  };
  const delta = domain.applyWikiStreamBlock(
    initial,
    'event: delta\r\ndata: {"text":"첫째","sources":[{"id":"source-1"}],"gatewayFallback":true,\r\ndata: "source":"gateway","run":{"model":"model-1","agent":"agent-1"},"llm":{"provider":"provider-1"},"retrieval":{"embeddingModel":"embed-1"}}',
  );
  const done = domain.applyWikiStreamBlock(delta, 'event: done\ndata: {"text":"완료"}');

  assert.deepEqual(delta, {
    answer: '앞첫째',
    sources: [{ id: 'source-1' }],
    meta: {
      provider: 'provider-1',
      agent: 'agent-1',
      model: 'model-1',
      source: 'gateway',
      gatewayFallback: true,
      embeddingModel: 'embed-1',
    },
  });
  assert.equal(done.answer, '완료');
  assert.deepEqual(done.sources, delta.sources);
  assert.deepEqual(done.meta, delta.meta);
});

test('Knowledge throws wiki SSE errors without mutating prior state', () => {
  const state = { answer: '기존', sources: [], meta: {} };

  assert.throws(
    () => domain.applyWikiStreamBlock(state, 'event: error\r\ndata: {"error":"검색 실패"}'),
    /검색 실패/,
  );
  assert.deepEqual(state, { answer: '기존', sources: [], meta: {} });
});
