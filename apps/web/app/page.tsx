/* eslint-disable @next/next/no-img-element */
import { resolveHandoff } from "@/lib/handoff-policy.mjs";
import { PRODUCTION_HANDOFF_TRUSTED_PUBLIC_KEY } from "@/lib/signed-handoff.mjs";

const engines = ["Codex", "Claude Code", "Grok", "Hermes"];

function ActionLink({
  available,
  href,
  label,
  testId,
  download = false,
}: {
  available: boolean;
  href: string | null;
  label: string;
  testId: string;
  download?: boolean;
}) {
  const className = `action${available ? "" : " action--disabled"}`;

  if (!available || !href) {
    return (
      <span className={className} aria-disabled="true" data-testid={testId}>
        {label}
      </span>
    );
  }

  return (
    <a
      className={className}
      href={href}
      rel="noreferrer"
      data-testid={testId}
      download={download}
    >
      {label}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export default async function Home() {
  const handoff = await resolveHandoff({
    receipt: process.env.WEB_HANDOFF_RELEASE_RECEIPT,
    signature: process.env.WEB_HANDOFF_RELEASE_SIGNATURE,
    trustedPublicKey: PRODUCTION_HANDOFF_TRUSTED_PUBLIC_KEY,
    localQa: false,
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
          <a href="#why">왜 만들었나</a>
          <a href="#product">제품</a>
          <a href="#trust">신뢰</a>
        </nav>
        <span className="header-note">macOS desktop</span>
      </header>

      <main id="content">
        <section className="hero">
          <div className="hero-copy-column">
            <p className="hero-label">A calendar that knows your work</p>
            <h1>
              <span>나를 이해하고,</span>
              <span>일을 이어가는 캘린더.</span>
            </h1>
            <p className="hero-copy">
              사용자가 허용한 일정, 메일, 파일과 기록을 이해해 지금 중요한 일을 알려주고,
              필요한 작업을 같은 맥락으로 이어갑니다.
            </p>
            <div className="hero-action">
              <ActionLink
                available={handoff.signup.available}
                href={handoff.signup.href}
                label={handoff.signup.label}
                testId="signup-control"
              />
              {handoff.marker ? (
                <p data-testid="local-qa-marker">{handoff.marker}</p>
              ) : null}
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

        <section className="why-section" id="why">
          <div className="why-heading">
            <p className="feature-kicker">Why Agent Calendar</p>
            <h2>AI를 열 때마다<br />나를 다시 설명하지 않도록.</h2>
          </div>
          <div className="why-copy">
            <p>
              AI를 자주 쓰는 1인 운영자의 일정, 메일, 메모와 AI 대화는 여러 도구에
              흩어집니다. 작업을 맡길 때마다 배경을 다시 설명하고, 결과와 후속 일은
              사람이 직접 기억해야 합니다.
            </p>
            <ol className="why-list">
              <li>
                <span>01</span>
                <div>
                  <strong>허용한 기록에서 나와 내 일을 이해합니다.</strong>
                  <p>사람, 프로젝트, 목표, 선호와 진행 중인 일을 원본 출처와 함께 연결합니다.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>캘린더에서 다음 행동과 작업을 이어갑니다.</strong>
                  <p>지금 중요한 일을 알려주고 같은 맥락으로 조사, 정리와 문서 작업을 시작합니다.</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>한 번의 결과가 다음 판단의 맥락이 됩니다.</strong>
                  <p>원본과 출처를 보존하고 결과를 다시 캘린더와 Wiki에 남깁니다.</p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="product-intro" id="product">
          <h2>나를 이해한 맥락이 캘린더에서 바로 일로 이어집니다.</h2>
          <div className="product-intro-copy">
            <p>
              Second Brain과 LLM Wiki는 별도 대시보드가 아니라 캘린더가 사용자를 이해하기
              위한 기억 계층입니다. 일정에서 파악하고, 대화에서 계획하고, 작업 결과를 다시
              기억하는 하나의 흐름을 만듭니다.
            </p>
            <dl>
              <div>
                <dt>통합 캘린더</dt>
                <dd>일정, 열린 일, 에이전트 작업과 완료 보고를 같은 시간축에서 확인합니다.</dd>
              </div>
              <div>
                <dt>Calendar AI</dt>
                <dd>허용한 일정과 기록을 바탕으로 답하고 요청을 일정, 작업 또는 Wiki 기록으로 연결합니다.</dd>
              </div>
              <div>
                <dt>LLM Wiki</dt>
                <dd>원본을 보존하며 사람, 프로젝트, 결정, 작업과 결과를 출처와 함께 연결합니다.</dd>
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
            <h2>한 번 설명한 맥락으로<br />같은 작업을 계속합니다.</h2>
            <p>
              Calendar AI에서 시작한 부탁은 기존 에이전트 화면의 작업 대화로 이어집니다.
              폴더 없는 리서치부터 명시적으로 연결한 로컬 폴더 작업까지, 진행 중에도
              추가 지시하고 중단하거나 다시 시도할 수 있습니다.
            </p>
            <ul>
              <li>계획, 의미 있는 진행, 승인 요청과 막힘을 한 작업 대화에서 확인</li>
              <li>전체 답변, 파일, 결과와 수정 차수를 재접속 뒤에도 복구</li>
              <li>여러 작업을 독립적으로 실행하고 완료 보고를 캘린더에 연결</li>
            </ul>
          </div>
        </section>

        <section className="runner-section" id="runner">
          <div className="runner-copy">
            <p className="feature-kicker">Your data, your execution</p>
            <h2>내 데이터와 실행 환경은<br />내가 통제합니다.</h2>
            <p>
              Agent Calendar 로그인과 Google Calendar 권한은 실행 엔진 권한이 아닙니다.
              모델 계정의 자격 증명은 사용자 환경의 Runner에 남고, 사용자가 허용한
              Workspace 작업만 받아 실행합니다.
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
            <h2>기록과 결과가 다시 연결되는<br />LLM Wiki.</h2>
            <p>
              파일, 일정, 메일, 작업 대화와 결과의 원본을 구분해 보존합니다. Calendar AI와
              에이전트는 현재 허용된 기록만 사용하고, 사용자는 답의 출처를 확인하거나
              잘못된 기억을 수정하고 제외할 수 있습니다.
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
            <h2>나를 이해하는 캘린더에서<br />오늘의 일을 시작하세요.</h2>
          </div>
          <div className="release-copy">
            <ActionLink
              available={handoff.download.available}
              href={handoff.download.href}
              label={handoff.download.label}
              testId="download-control"
              download
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
          <a href="/support" data-testid="support-link">지원</a>
        </nav>
        <p>© 2026 Agent Calendar</p>
      </footer>
    </>
  );
}
