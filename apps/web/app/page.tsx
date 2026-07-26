/* eslint-disable @next/next/no-img-element */
import { resolveHandoff } from "@/lib/handoff-policy.mjs";

const engines = ["Codex", "Claude Code", "Grok", "Hermes"];

function ActionLink({
  available,
  href,
  label,
}: {
  available: boolean;
  href: string | null;
  label: string;
}) {
  const className = `action${available ? "" : " action--disabled"}`;

  if (!available || !href) {
    return (
      <span className={className} aria-disabled="true">
        {label}
      </span>
    );
  }

  return (
    <a className={className} href={href} rel="noreferrer">
      {label}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export default function Home() {
  const handoff = resolveHandoff({
    signupUrl: process.env.NEXT_PUBLIC_SIGNUP_URL,
    downloadUrl: process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL,
    downloadVersion: process.env.NEXT_PUBLIC_DESKTOP_VERSION,
    downloadSha256: process.env.NEXT_PUBLIC_DESKTOP_SHA256,
    downloadVerified: process.env.NEXT_PUBLIC_DESKTOP_VERIFIED,
  });

  return (
    <>
      <a className="skip-link" href="#content">본문으로 건너뛰기</a>
      <header className="site-header">
        <a className="brand" href="#" aria-label="Agent Calendar 홈">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>AGENT CALENDAR</span>
        </a>
        <nav aria-label="주요 메뉴">
          <a href="#product">제품</a>
          <a href="#runner">러너</a>
          <a href="#trust">신뢰</a>
        </nav>
        <span className="header-note">macOS desktop</span>
      </header>

      <main id="content">
        <section className="hero">
          <div className="hero-copy-column">
            <p className="hero-label">Calendar-first agent operations</p>
            <h1>
              <span>일정에서 맡기고,</span>
              <span>결과까지 확인하세요.</span>
            </h1>
            <p className="hero-copy">
              일정이 흐르는 곳에서 캘린더, 에이전트 작업, 자동화를 한 흐름으로 관리합니다.
            </p>
            <div className="hero-action">
              <ActionLink
                available={handoff.signup.available}
                href={handoff.signup.href}
                label={handoff.signup.label}
              />
            </div>
          </div>
          <figure className="hero-product">
            <img
              src="/product-calendar.png"
              alt="외부 일정과 에이전트 작업을 함께 보여주는 Agent Calendar 통합 캘린더"
              width={1320}
              height={824}
              fetchPriority="high"
            />
            <figcaption>통합 캘린더 · 실제 Desktop 화면</figcaption>
          </figure>
        </section>

        <section className="product-intro" id="product">
          <h2>캘린더가 작업의 시작점이 됩니다.</h2>
          <div className="product-intro-copy">
            <p>
              일정과 자동화를 따로 확인하고 다시 AI 앱을 여는 대신, 계획한 시간에서 바로
              작업을 맡기고 진행과 결과를 이어서 봅니다.
            </p>
            <dl>
              <div>
                <dt>통합 캘린더</dt>
                <dd>사람 일정과 독립적으로 실행되는 에이전트 작업을 같은 시간축에 둡니다.</dd>
              </div>
              <div>
                <dt>캘린더 AI</dt>
                <dd>허용한 일정과 지식을 바탕으로 답하고 명확한 요청을 실제 작업으로 연결합니다.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="feature-story feature-story--agent">
          <figure className="product-frame">
            <img
              src="/product-agents.png"
              alt="Codex 세션처럼 대화와 작업 체크포인트가 이어지는 Agent Calendar 에이전트 화면"
              width={1280}
              height={900}
              loading="lazy"
            />
          </figure>
          <div className="feature-copy">
            <h2>앱을 옮겨 다니지 않고<br />같은 세션에서 계속 일합니다.</h2>
            <p>
              에이전트마다 Codex, Claude, Grok, Hermes와 Runner를 정하고, 기존 세션을
              가져오거나 새 세션을 시작합니다. 후속 지시도 같은 대화와 실행 이력에 남습니다.
            </p>
            <ul>
              <li>계획, 도구 실행, 승인 요청, 오류를 한 대화에서 확인</li>
              <li>체크포인트, 파일, 결과, 수정 차수를 재접속 뒤에도 복구</li>
              <li>완료와 재작업 상태를 통합 캘린더에 연결</li>
            </ul>
          </div>
        </section>

        <section className="runner-section" id="runner">
          <div className="runner-copy">
            <p className="feature-kicker">Customer-controlled Runner</p>
            <h2>로그인은 내 Runner에,<br />작업은 내 Workspace에.</h2>
            <p>
              Agent Calendar 로그인과 Google Calendar 권한은 실행 엔진 권한이 아닙니다.
              모델 계정의 자격 증명은 사용자 환경에 남고 Runner가 자신의 Workspace 작업만
              받아 실행합니다.
            </p>
          </div>
          <div className="engine-list" aria-label="Runner 연결 실행 엔진">
            {engines.map((engine) => (
              <div key={engine}>
                <strong>{engine}</strong>
                <span>Runner에서 인증</span>
              </div>
            ))}
          </div>
        </section>

        <section className="feature-story feature-story--knowledge">
          <div className="feature-copy">
            <h2>일정과 지식을 함께 아는<br />대화형 AI.</h2>
            <p>
              Wiki AI는 현재 Workspace에서 허용한 문서를 찾고 출처를 확인한 뒤 답합니다.
              캘린더 AI는 모든 일정을 대화 맥락으로 이해하면서 일정 변경, 위임 작업,
              연결 자동화를 정확한 도구 경로로 실행합니다.
            </p>
          </div>
          <figure className="product-frame product-frame--wiki">
            <img
              src="/product-wiki.png"
              alt="Workspace 문서 관계와 출처를 보여주는 Agent Calendar Wiki 화면"
              width={1320}
              height={824}
              loading="lazy"
            />
          </figure>
        </section>

        <section className="trust-section" id="trust">
          <div>
            <h2>보이는 경계 안에서<br />끝까지 책임집니다.</h2>
          </div>
          <dl>
            <div>
              <dt>Workspace isolation</dt>
              <dd>캘린더, Wiki, 작업, 에이전트, Runner 상태는 다른 Workspace와 섞이지 않습니다.</dd>
            </div>
            <div>
              <dt>Explicit approval</dt>
              <dd>새 권한, 추가 비용, 외부 전달이 필요한 변경은 승인 뒤에만 실행합니다.</dd>
            </div>
            <div>
              <dt>Useful checkpoints</dt>
              <dd>원시 로그 대신 판단에 필요한 계획, 진행, 막힘, 결과를 남깁니다.</dd>
            </div>
          </dl>
        </section>

        <section className="release">
          <div>
            <h2>내 일정에서 시작하는<br />에이전트 작업 공간.</h2>
          </div>
          <div className="release-copy">
            <ActionLink
              available={handoff.download.available}
              href={handoff.download.href}
              label={handoff.download.label}
            />
            <p>
              공개 다운로드 전 서명과 체크섬을 검증합니다. 검증되지 않은 빌드 링크는
              제공하지 않습니다.
            </p>
          </div>
        </section>
      </main>

      <footer>
        <a className="brand brand--footer" href="#">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>AGENT CALENDAR</span>
        </a>
        <nav aria-label="정책과 지원">
          <a href="/privacy">개인정보</a>
          <a href="/terms">이용정책</a>
          <a href="/support">지원</a>
        </nav>
        <p>© 2026 Agent Calendar</p>
      </footer>
    </>
  );
}
