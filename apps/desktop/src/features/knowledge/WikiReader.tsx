import { wikiBody } from '../../domains/knowledge/knowledge';
import { itemTitle, text } from './knowledgePresentation';

type Item = Record<string, unknown>;

type WikiReaderProps = {
  active: Item;
  loading: boolean;
  onClose: () => void;
};

export function WikiArticle({ content }: { content: string }) {
  return <article>{content.split('\n').map((line, index) => {
    if (!line.trim()) return <br key={index} />;
    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)?.[0].length || 1;
      const body = line.replace(/^#{1,3}\s+/, '');
      return level === 1 ? <h1 key={index}>{body}</h1> : <h2 key={index}>{body}</h2>;
    }
    if (/^[-*]\s+/.test(line)) return <p className="wiki-bullet" key={index}>{line.replace(/^[-*]\s+/, '')}</p>;
    if (/^\d+\.\s+/.test(line)) return <p className="wiki-number" key={index}>{line}</p>;
    if (/^---$/.test(line.trim())) return <hr key={index} />;
    return <p key={index}>{line}</p>;
  })}</article>;
}

export function WikiReader({ active, loading, onClose }: WikiReaderProps) {
  return <div className="wiki-reader">
    <button className="wiki-reader-close" type="button" aria-label="위키 문서 팝업 닫기" title="닫기" onClick={onClose}>×</button>
    <header>
      <div>
        <strong>{itemTitle(active, 'Wiki 문서')}</strong>
        <small>{text(active.folder || active.kind, '📄 문서')} · {text(active.updatedAt || active.date || active.tag || active.path, '위키 문서')}</small>
      </div>
    </header>
    {loading && <div className="wiki-loading">본문 불러오는 중...</div>}
    <WikiArticle content={wikiBody(active) || '선택한 위키 문서의 본문입니다. 관련 작업과 런 결과가 이곳에 누적됩니다.'} />
  </div>;
}
