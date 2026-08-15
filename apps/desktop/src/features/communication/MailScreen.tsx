import { mailPresentation } from '../../domains/communication/communication';

type Item = Record<string, unknown>;

type MailScreenProps = {
  readonly inbox: Item[];
  readonly activeMailId: string;
  readonly setActiveMailId: (id: string) => void;
  readonly addTaskFromMail: (mail: Item) => void;
  readonly delegateMail: (mail: Item, reply?: boolean) => void;
  readonly mailLoadError: string;
  readonly reloadMail: () => void;
};

function text(value: unknown, fallback = ''): string {
  return String(value || fallback);
}

function mailAvatar(mail: Item): string {
  return text(mail.from || mail.sender || mail.sourceLabel, 'H').trim().slice(0, 1).toUpperCase();
}

export function MailScreen({ inbox, activeMailId, setActiveMailId, addTaskFromMail, delegateMail, mailLoadError, reloadMail }: MailScreenProps) {
  const items = inbox;
  const active = items.find((mail, index) => mailPresentation(mail, `mail-${index}`).id === activeMailId) || items[0];
  const activeId = mailPresentation(active || {}, '').id;
  const unread = items.filter((mail) => mail.unread !== false && !mail.read).length;
  return <div className="mail screen-in">
    <aside className="mail-list">
      <header><strong>✉️ 받은편지함</strong><em>{unread} 안 읽음</em><button aria-label="메일 새로고침" onClick={reloadMail}>⟳</button></header>
      <section className="mail-connection-note">
        <strong>Google 메일 읽기 전용</strong>
        <small>Gmail 읽기 권한은 Google Calendar 권한과 별도로 연결합니다. 메일 전송이나 삭제 권한은 요청하지 않습니다.</small>
      </section>
      <div>
        {mailLoadError && <div className="mail-list-empty mail-list-error" role="alert"><strong>메일을 불러오지 못했습니다.</strong><small>기존 메일 데이터는 변경하지 않았습니다.</small><button type="button" onClick={reloadMail}>메일 다시 불러오기</button></div>}
        {!items.length && !mailLoadError && <p className="mail-list-empty">연결된 메일이 없습니다.<small>계정별 OAuth 메일 연결은 준비 중입니다.</small></p>}
        {items.map((mail, index) => {
          const presentation = mailPresentation(mail, `mail-${index}`);
          return <button className="mail-item" data-active={presentation.id === activeId} data-unread={presentation.unread} key={presentation.id} onClick={() => setActiveMailId(presentation.id)}>
            <i />
            <span className="mail-avatar">{mailAvatar(mail)}</span>
            <span className="mail-copy">
              <span className="mail-line"><b>{presentation.from}</b><small>{presentation.starred && <mark>★</mark>}{presentation.time}</small></span>
              <strong>{presentation.subject}</strong>
              <em>{presentation.preview}</em>
            </span>
          </button>;
        })}
      </div>
    </aside>
    <article className="mail-reader">
      {active ? <div className="mail-reader-inner">
        <section className="mail-head">
          <div><h2>{text(active.subject || active.title, '메일을 선택하세요')}</h2></div>
          <footer><span className="mail-avatar large">{mailAvatar(active)}</span><span><b>{text(active.from || active.sender || active.sourceLabel, 'Agent Calendar')}</b><small>{text(active.email || active.addr || active.address, 'agents@calendar.local')}</small></span><time>{text(active.time || active.createdAt, '방금')}</time></footer>
        </section>
        <div className="action-row mail-actions">
          <button onClick={() => addTaskFromMail(active)}>⊕ 작업으로 추가</button>
          <button className="delegate" onClick={() => delegateMail(active)}>⚡ 에이전트에 위임</button>
          <button onClick={() => delegateMail(active, true)}>✦ 답장 초안 작업</button>
          {text(active.actionStatus) && <span>{text(active.actionStatus)}</span>}
        </div>
        <section className="mail-body">{text(active.body || active.preview || active.snippet, '메일 내용을 작업, 위임, 답장 초안 작업으로 전환할 수 있습니다.')}</section>
      </div> : <div className="mail-empty">메일을 연결하면 이곳에서 내용을 확인할 수 있습니다.</div>}
    </article>
  </div>;
}
