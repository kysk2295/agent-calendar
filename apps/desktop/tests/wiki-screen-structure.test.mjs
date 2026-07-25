import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const featureIndexSource = readFileSync(new URL('../src/features/knowledge/index.ts', import.meta.url), 'utf8');
const wikiScreenSource = readFileSync(new URL('../src/features/knowledge/WikiScreen.tsx', import.meta.url), 'utf8');
const graphPanelUrl = new URL('../src/features/knowledge/WikiGraphPanel.tsx', import.meta.url);
const readerUrl = new URL('../src/features/knowledge/WikiReader.tsx', import.meta.url);

test('WikiScreen delegates graph ownership without public contract drift', () => {
  assert.equal(existsSync(graphPanelUrl), true, 'WikiGraphPanel must own the graph implementation');
  assert.equal(existsSync(readerUrl), true, 'WikiReader must own stateless document presentation');

  const graphPanelSource = readFileSync(graphPanelUrl, 'utf8');
  const readerSource = readFileSync(readerUrl, 'utf8');

  [
    'wiki',
    'docs',
    'activeWikiId',
    'setActiveWikiId',
    'readerOpen',
    'setReaderOpen',
    'question',
    'setQuestion',
    'answer',
    'sources',
    'answerMeta',
    'includeJournal',
    'setIncludeJournal',
    'includeRaw',
    'setIncludeRaw',
    'asking',
    'ask',
    'dismissAnswer',
    'loadDocument',
  ].forEach((propName) => {
    assert.match(wikiScreenSource, new RegExp(`\\b${propName}\\b`), `WikiScreen keeps ${propName}`);
  });
  assert.match(appSource, /screen === 'wiki' && <WikiScreen/);
  assert.match(featureIndexSource, /export \{ WikiArticle, WikiScreen \} from '\.\/WikiScreen'/);
  assert.match(wikiScreenSource, /export \{ WikiArticle \} from '\.\/WikiReader'/);

  assert.match(wikiScreenSource, /const \[graphFocusMode,\s*setGraphFocusMode\]/);
  assert.match(wikiScreenSource, /data-graph-focus=\{graphFocusMode\}/);
  assert.match(wikiScreenSource, /<WikiGraphPanel/);
  assert.match(wikiScreenSource, /<WikiReader/);
  assert.match(wikiScreenSource, /const \[details,\s*setDetails\]/);
  assert.match(wikiScreenSource, /const \[loadingPath,\s*setLoadingPath\]/);
  assert.match(wikiScreenSource, /const \[treeQuery,\s*setTreeQuery\]/);
  assert.match(wikiScreenSource, /const \[openTreeGroups,\s*setOpenTreeGroups\]/);
  assert.match(wikiScreenSource, /loadDocument\(activePath\)/);
  assert.match(wikiScreenSource, /본문을 불러오지 못했습니다:/);

  [
    'setGraphZoom',
    'setGraphPan',
    'graphCanvasRef',
    'graphDragRef',
    'graphNodeDragRef',
    'buildWikiGraphLayout',
    'buildWikiGraphFallbackEdges',
    'wiki-graph-panel',
    'wiki-graph-svg',
    'wiki-svg-node',
    'wiki-edge',
  ].forEach((token) => {
    assert.doesNotMatch(wikiScreenSource, new RegExp(token), `WikiScreen must not retain graph-local ownership: ${token}`);
  });

  const propsBlock = graphPanelSource.match(/type WikiGraphPanelProps = \{([\s\S]*?)\n\};/)?.[1] || '';
  const propNames = [...propsBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)(?:\?)?:/gm)].map((match) => match[1]);
  assert.deepEqual(propNames, [
    'graph',
    'notes',
    'activePath',
    'focusMode',
    'onFocusModeChange',
    'onOpenDocument',
    'children',
  ]);
  assert.match(graphPanelSource, /onOpenDocument: \(path: string, intent: 'select' \| 'open'\) => void/);

  [
    'graphZoom',
    'graphPan',
    'graphCanvasRef',
    'graphDragRef',
    'graphNodeDragRef',
    'buildWikiGraphLayout',
    'buildWikiGraphFallbackEdges',
    'onWheel={',
    'wiki-graph-panel',
    'wiki-graph-canvas',
    'wiki-graph-svg',
    'wiki-graph-viewport',
    'wiki-svg-node',
    'wiki-edge',
    'wiki-graph-controls',
    'wiki-graph-settings',
  ].forEach((token) => {
    assert.equal(graphPanelSource.includes(token), true, `WikiGraphPanel owns ${token}`);
  });
  assert.doesNotMatch(graphPanelSource, /treeQuery|openTreeGroups|wiki-answer|loadDocument/);

  const canvasIndex = graphPanelSource.indexOf('className="wiki-graph-canvas');
  const childrenIndex = graphPanelSource.indexOf('{children}', canvasIndex);
  const panelCloseIndex = graphPanelSource.indexOf('</section>', childrenIndex);
  assert.ok(canvasIndex >= 0 && childrenIndex > canvasIndex && panelCloseIndex > childrenIndex, 'reader children stay inside the graph canvas');

  assert.match(readerSource, /export function WikiArticle/);
  assert.match(readerSource, /export function WikiReader/);
  assert.match(readerSource, /className="wiki-reader"/);
  assert.match(readerSource, /className="wiki-reader-close"/);
  assert.doesNotMatch(readerSource, /useEffect|loadDocument|setDetails|setActiveWikiId|readerOpen/);

  assert.doesNotMatch(`${wikiScreenSource}\n${graphPanelSource}\n${readerSource}`, /createContext|Provider|ViewModel|Adapter/);
});
