import { itemId, itemTitle, text } from './knowledgePresentation';

type Item = Record<string, unknown>;

export function NotesScreen({ docs, activeNoteId, setActiveNoteId, newNote }: { docs: Item[]; activeNoteId: string; setActiveNoteId: (id: string) => void; newNote: () => void }) {
  const active = docs.find((doc, index) => itemId(doc, `note-${index}`) === activeNoteId) || docs[0];
  return <div className="notes-editor screen-in">
    <aside className="note-list">
      <header><strong>📝 생각노트</strong><span>{docs.length}</span><button onClick={newNote}>+ 메모</button></header>
      <div>{docs.map((doc, index) => {
        const id = itemId(doc, `note-${index}`);
        return <button className="note-item" data-active={id === itemId(active || {}, '')} key={id} onClick={() => setActiveNoteId(id)}>
          <span><i>📄</i><b>{itemTitle(doc, '노트')}</b></span>
          <em>{text(doc.body || doc.summary || doc.extract || doc.excerpt, '내용 없음')}</em>
        </button>;
      })}</div>
    </aside>
    <section className="note-editor">
      {active ? <div><input value={itemTitle(active, '')} readOnly placeholder="제목 없음" /><small>{text(active.date || active.updated || active.tag, '방금 수정')}</small><textarea value={text(active.body || active.summary || active.extract || active.excerpt)} readOnly placeholder="백엔드에 저장된 노트를 선택하세요" /></div> : <p>메모를 선택하세요</p>}
    </section>
  </div>;
}
