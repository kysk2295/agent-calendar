import Link from "next/link";

export type TrustSection = {
  title: string;
  paragraphs?: string[];
  items?: string[];
};

export function TrustPage({
  eyebrow,
  title,
  summary,
  sections,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  sections: TrustSection[];
}) {
  return (
    <>
      <a className="skip-link" href="#content">본문으로 건너뛰기</a>
      <header className="trust-header">
        <Link className="brand" href="/" aria-label="Agent Calendar 홈">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>AGENT CALENDAR</span>
        </Link>
        <Link className="trust-home-link" href="/">홈으로</Link>
      </header>

      <main className="trust-main" id="content">
        <header className="trust-intro">
          <p className="eyebrow"><span />{eyebrow}</p>
          <h1>{title}</h1>
          <p>{summary}</p>
          <dl className="trust-meta">
            <div><dt>기준일</dt><dd>2026년 7월 25일</dd></div>
            <div><dt>적용 상태</dt><dd>Private beta</dd></div>
          </dl>
        </header>

        <div className="trust-sections">
          {sections.map((section, index) => (
            <section key={section.title}>
              <span className="trust-section-number">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{section.title}</h2>
                {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.items && (
                  <ul>
                    {section.items.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
              </div>
            </section>
          ))}
        </div>

        <aside className="trust-beta-note" aria-label="공개 출시 전 안내">
          <strong>공개 출시 전 안내</strong>
          <p>
            이 문서는 현재 private beta의 제품 동작을 설명합니다. 공개 가입을 열기 전에
            실제 운영 주체·연락처·보존 기간을 포함한 최종 법률 검토본으로 갱신합니다.
          </p>
        </aside>
      </main>

      <footer className="trust-footer">
        <Link className="brand brand--footer" href="/">AGENT CALENDAR</Link>
        <nav aria-label="정책과 지원">
          <Link href="/privacy">개인정보</Link>
          <Link href="/terms">이용정책</Link>
          <Link href="/support">지원</Link>
        </nav>
        <p>© 2026 Agent Calendar</p>
      </footer>
    </>
  );
}
