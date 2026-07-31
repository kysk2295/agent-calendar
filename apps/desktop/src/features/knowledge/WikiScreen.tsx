import { useEffect, useState } from 'react';
import {
  hasWikiFullBody,
  knowledgeSourceKindLabel,
  knowledgeSourceStatusLabel,
  wikiBasename,
  wikiBody,
  wikiDetail,
} from '../../domains/knowledge/knowledge';
import { arr, itemId, itemTitle, obj, text, WIKI_GROUP_COLORS as colors } from './knowledgePresentation';
import { WikiGraphPanel } from './WikiGraphPanel';
import { WikiReader } from './WikiReader';

export { WikiArticle } from './WikiReader';

type Item = Record<string, unknown>;

type WikiScreenProps = {
  wiki: Item;
  docs: Item[];
  activeWikiId: string;
  setActiveWikiId: (id: string) => void;
  readerOpen: boolean;
  setReaderOpen: (value: boolean) => void;
  question: string;
  setQuestion: (value: string) => void;
  answer: string;
  sources: Item[];
  answerMeta: Item;
  includeJournal: boolean;
  setIncludeJournal: (value: boolean) => void;
  includeRaw: boolean;
  setIncludeRaw: (value: boolean) => void;
  asking: boolean;
  ask: () => void;
  dismissAnswer: () => void;
  loadDocument: (path: string) => Promise<Item>;
  knowledgeV2: boolean;
  knowledgeSources: Item[];
  sourceBusy: boolean;
  sourceMessage: string;
  addCloudFile: (file: File) => Promise<void>;
  revokeSource: (sourceId: string) => Promise<void>;
  resolveEvidence: (handle: string) => Promise<Item>;
};


export function WikiScreen({ wiki, docs, activeWikiId, setActiveWikiId, readerOpen, setReaderOpen, question, setQuestion, answer, sources, answerMeta, includeJournal, setIncludeJournal, includeRaw, setIncludeRaw, asking, ask, dismissAnswer, loadDocument, knowledgeV2, knowledgeSources, sourceBusy, sourceMessage, addCloudFile, revokeSource, resolveEvidence }: WikiScreenProps) {
  const [details, setDetails] = useState<Record<string, Item>>({});
  const [loadingPath, setLoadingPath] = useState('');
  const [graphFocusMode, setGraphFocusMode] = useState(false);
  const [treeQuery, setTreeQuery] = useState('');
  const [openTreeGroups, setOpenTreeGroups] = useState<Set<string>>(() => new Set());
  const [cloudConsent, setCloudConsent] = useState(false);
  const graph = obj(wiki, 'graph');
  const wikiNotes = arr(wiki, 'notes').length ? arr(wiki, 'notes') : (arr(wiki, 'documents').length ? arr(wiki, 'documents') : docs);
  const list = wikiNotes;
  const selectedFromApi = wikiDetail(wiki);
  const activeMatch = list.find((node, index) => itemId(node, `wiki-${index}`) === activeWikiId || text(node.path) === activeWikiId);
  const activeBase = activeMatch || (activeWikiId
    ? { id: activeWikiId, path: activeWikiId, title: wikiBasename(activeWikiId) }
    : (Object.keys(selectedFromApi).length ? selectedFromApi : list[0]));
  const activePath = text(activeBase?.path || activeBase?.id || activeWikiId);
  const active = activePath && details[activePath] ? { ...activeBase, ...details[activePath] } : activeBase;

  useEffect(() => {
    if (!readerOpen || !activePath || hasWikiFullBody(active)) return;
    let cancelled = false;
    setLoadingPath(activePath);
    loadDocument(activePath)
      .then((payload) => {
        if (cancelled) return;
        const detail = wikiDetail(payload);
        if (Object.keys(detail).length) setDetails((current) => ({ ...current, [activePath]: detail }));
      })
      .catch((error) => setDetails((current) => ({ ...current, [activePath]: { ...active, content: `본문을 불러오지 못했습니다: ${error instanceof Error ? error.message : 'unknown error'}` } })))
      .finally(() => { if (!cancelled) setLoadingPath(''); });
    return () => { cancelled = true; };
  }, [activePath, loadDocument, readerOpen]);

  const folders = Array.from(new Set(list.map((node) => text(node.folder || node.tag || node.category || node.kind, '기타')))).slice(0, 12);
  const treeNeedle = treeQuery.trim().toLowerCase();
  const matchesTreeQuery = (node: Item) => !treeNeedle || [
    itemTitle(node, ''),
    text(node.path || node.wikiPath || node.folder || node.kind),
    wikiBody(node),
  ].join(' ').toLowerCase().includes(treeNeedle);
  const docGroups = folders
    .map((tag) => ({ tag, docs: list.filter((node) => text(node.folder || node.tag || node.category || node.kind, '기타') === tag && matchesTreeQuery(node)) }))
    .filter((group) => group.docs.length);
  const toggleTreeGroup = (tag: string) => {
    setOpenTreeGroups((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };
  const engineLabel = text(answerMeta.agent || answerMeta.model || answerMeta.provider, '');
  const fallbackLabel = answerMeta.gatewayFallback === true ? '검색 fallback' : '';
  const answerStatus = text(answerMeta.answerStatus);
  return <div className="wiki screen-in" data-graph-focus={graphFocusMode}>
    <div className="askbar"><div><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(); }} placeholder="연결된 지식에 질문하기" /></div><button disabled={asking} onClick={ask}>{asking ? '답변 중' : '질문'}</button></div>
    <div className="wiki-scope">
      <label><input type="checkbox" checked={includeJournal} onChange={(event) => setIncludeJournal(event.target.checked)} /> 일기 포함</label>
      <label><input type="checkbox" checked={includeRaw} onChange={(event) => setIncludeRaw(event.target.checked)} /> raw 포함</label>
    </div>
    {knowledgeV2 && <section className="knowledge-source-panel" data-testid="knowledge-source-panel">
      <div className="knowledge-source-panel-head">
        <div><strong>내 지식 소스</strong><small>각 Workspace 안에서만 검색됩니다.</small></div>
        <label className="knowledge-cloud-consent">
          <input type="checkbox" checked={cloudConsent} onChange={(event) => setCloudConsent(event.target.checked)} />
          선택한 파일을 암호화 색인에 저장하는 데 동의
        </label>
        <label className="knowledge-file-add" data-disabled={!cloudConsent || sourceBusy}>
          {sourceBusy ? '처리 중' : '파일 추가'}
          <input
            type="file"
            accept=".md,.mdx,.txt,.json,.csv,.html,.js,.jsx,.ts,.tsx,.py,.yaml,.yml"
            disabled={!cloudConsent || sourceBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void addCloudFile(file);
              event.currentTarget.value = '';
            }}
          />
        </label>
      </div>
      <div className="knowledge-source-list">
        {knowledgeSources.length === 0 && (
          <p>
            연결된 지식 소스가 없습니다. 파일을 추가하거나 데스크톱 실행 환경의 LLM_WIKI_VAULT에
            실제 폴더 경로를 지정하세요. 경로가 없거나 오프라인이면 로컬 Wiki는 준비되지 않습니다.
          </p>
        )}
        {knowledgeSources.map((source, index) => {
          const sourceId = text(source.id, `knowledge-source-${index}`);
          const status = text(source.status);
          return <article key={sourceId} data-status={status} data-testid={`knowledge-source-${sourceId}`}>
            <div><strong>{text(source.label || source.path, '지식 소스')}</strong><small>{knowledgeSourceKindLabel(source)} · {knowledgeSourceStatusLabel(source)}</small></div>
            {status !== 'revoked' && <button type="button" disabled={sourceBusy} onClick={() => { void revokeSource(sourceId); }}>연결 해제</button>}
          </article>;
        })}
      </div>
      {sourceMessage && <p className="knowledge-source-message" role="status">{sourceMessage}</p>}
    </section>}
    {answer && <div className="wiki-answer"><p>{answer}{sources.length > 0 && <small className="wiki-answer-sources">{sources.slice(0, 3).map((source, index) => {
      const sourceTitle = text(source.title || source.path, '참조 문서');
      const evidenceHandle = text(source.handle);
      const sourceId = text(evidenceHandle || source.path || source.wikiPath || source.documentPath || source.documentId || source.id, `wiki-source-${index}`);
      const sourceContent = text(source.content || source.text || source.snippet || source.excerpt || source.extract, '검색된 근거 요약이 없습니다.');
      return <button type="button" aria-label={`출처 열기: ${sourceTitle}`} key={`${sourceId}-${index}`} onClick={() => {
        if (evidenceHandle) {
          void resolveEvidence(evidenceHandle).then((resolved) => {
            const resolvedTitle = text(resolved.title, sourceTitle);
            const resolvedContent = text(resolved.excerpt, sourceContent);
            setDetails((current) => ({ ...current, [evidenceHandle]: { ...resolved, id: evidenceHandle, path: evidenceHandle, title: resolvedTitle, content: resolvedContent } }));
            setActiveWikiId(evidenceHandle);
            setReaderOpen(true);
          }).catch((error) => {
            setDetails((current) => ({ ...current, [evidenceHandle]: { id: evidenceHandle, path: evidenceHandle, title: sourceTitle, content: `근거를 열지 못했습니다: ${error instanceof Error ? error.message : 'unknown error'}` } }));
            setActiveWikiId(evidenceHandle);
            setReaderOpen(true);
          });
          return;
        }
        setDetails((current) => ({ ...current, [sourceId]: { ...source, id: sourceId, path: sourceId, title: sourceTitle, content: sourceContent } }));
        setActiveWikiId(sourceId);
        setReaderOpen(true);
      }}>{sourceTitle}</button>;
    })}</small>}{(engineLabel || fallbackLabel || answerStatus) && <small>{[engineLabel, fallbackLabel, answerStatus === 'pending' ? 'Runner 검색 중' : answerStatus === 'runner_required' ? 'Runner 연결 필요' : ''].filter(Boolean).join(' · ')}</small>}</p><button className="wiki-answer-dismiss" aria-label="위키 답변 닫기" onClick={dismissAnswer}>✕</button></div>}
    <div className="wiki-main" data-graph-focus={graphFocusMode}>
      <WikiGraphPanel
        graph={graph}
        notes={list}
        activePath={activePath || itemId(active || {}, '')}
        focusMode={graphFocusMode}
        onFocusModeChange={setGraphFocusMode}
        onOpenDocument={(path, intent) => {
          setActiveWikiId(path);
          if (intent === 'open') setReaderOpen(true);
        }}
      >
        {readerOpen && active && <WikiReader active={active} loading={loadingPath === activePath} onClose={() => setReaderOpen(false)} />}
      </WikiGraphPanel>
      <aside className="wiki-side">
        <label><span>⌕</span><input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="위키 내용 검색" /></label>
        <div className="tree"><h3>트리 구조</h3>{docGroups.map((group) => {
          const isOpen = openTreeGroups.has(group.tag);
          return <section key={group.tag} data-open={isOpen}>
            <button className="tree-group-toggle" aria-expanded={isOpen} onClick={() => toggleTreeGroup(group.tag)}>
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <b style={{ background: colors[group.tag] || colors.기타 }} />
              <strong>{group.tag}</strong>
              <small>{group.docs.length}</small>
            </button>
            {isOpen && group.docs.map((node, index) => {
              const originalIndex = list.findIndex((entry) => entry === node || itemId(entry, '') === itemId(node, ''));
              const id = itemId(node, `wiki-${originalIndex >= 0 ? originalIndex : index}`);
              const path = text(node.path || id, id);
              return <button data-active={path === activePath || id === activePath} key={id} onClick={() => { setActiveWikiId(path); setReaderOpen(true); }}><span>{text(node.kind) === 'diary' ? '📔' : '📄'} {itemTitle(node, 'Wiki 문서')}</span><small>{text(node.updatedAt || node.updated || node.date || node.path, '최근')}</small></button>;
            })}
          </section>;
        })}</div>
      </aside>
    </div>
  </div>;
}
