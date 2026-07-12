import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalWikiGraph } from '../dist-electron/localWikiAsk.js';

test('local wiki graph resolves Obsidian-style links by path, basename, title, embed, and markdown link', () => {
  const notes = [
    {
      id: '2_wiki/Hub.md',
      path: '2_wiki/Hub.md',
      wikiPath: '2_wiki/Hub.md',
      folder: '2_wiki',
      kind: '2_wiki',
      title: 'Hub',
      body: [
        '[[2_wiki/Project Alpha.md]]',
        '[[Project Beta]]',
        '![[Assets Diagram]]',
        '[Gamma reference](3_output/Gamma.md)',
      ].join('\n'),
      excerpt: '',
      tags: [],
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    {
      id: '2_wiki/Project Alpha.md',
      path: '2_wiki/Project Alpha.md',
      wikiPath: '2_wiki/Project Alpha.md',
      folder: '2_wiki',
      kind: '2_wiki',
      title: 'Alpha renamed',
      body: '',
      excerpt: '',
      tags: [],
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    {
      id: '2_wiki/project-beta-note.md',
      path: '2_wiki/project-beta-note.md',
      wikiPath: '2_wiki/project-beta-note.md',
      folder: '2_wiki',
      kind: '2_wiki',
      title: 'Project Beta',
      body: '',
      excerpt: '',
      tags: [],
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    {
      id: '1_raw/Assets Diagram.md',
      path: '1_raw/Assets Diagram.md',
      wikiPath: '1_raw/Assets Diagram.md',
      folder: '1_raw',
      kind: '1_raw',
      title: 'Assets Diagram',
      body: '',
      excerpt: '',
      tags: [],
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    {
      id: '3_output/Gamma.md',
      path: '3_output/Gamma.md',
      wikiPath: '3_output/Gamma.md',
      folder: '3_output',
      kind: '3_output',
      title: 'Gamma',
      body: '',
      excerpt: '',
      tags: [],
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
  ];

  const graph = buildLocalWikiGraph(notes);
  const edgePairs = graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort();

  assert.deepEqual(edgePairs, [
    '2_wiki/Hub.md->1_raw/Assets Diagram.md',
    '2_wiki/Hub.md->2_wiki/Project Alpha.md',
    '2_wiki/Hub.md->2_wiki/project-beta-note.md',
    '2_wiki/Hub.md->3_output/Gamma.md',
  ]);
  assert.deepEqual(graph.groups, ['1_raw', '2_wiki', '3_output']);
});

test('local wiki graph prefers source-relative markdown targets and deduplicates reciprocal edges', () => {
  const notes = [
    {
      id: 'folder/source.md',
      path: 'folder/source.md',
      folder: 'folder',
      kind: 'folder',
      title: 'Source',
      body: '[local](sub/note.md)',
      updatedAt: '',
    },
    {
      id: 'folder/sub/note.md',
      path: 'folder/sub/note.md',
      folder: 'folder',
      kind: 'folder',
      title: 'Local note',
      body: '[[folder/source.md]]',
      updatedAt: '',
    },
    {
      id: 'sub/note.md',
      path: 'sub/note.md',
      folder: 'sub',
      kind: 'sub',
      title: 'Root note',
      body: '',
      updatedAt: '',
    },
  ];

  const graph = buildLocalWikiGraph(notes);

  assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to]), [
    ['folder/source.md', 'folder/sub/note.md'],
  ]);
});
