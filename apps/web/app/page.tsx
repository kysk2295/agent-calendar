import { resolveHandoff } from "@/lib/handoff-policy.mjs";

const schedule = [
  {
    day: "월",
    date: "27",
    events: [
      { time: "09:30", title: "제품 주간 회의", kind: "human" },
      { time: "14:00", title: "리서치 정리", kind: "agent", agent: "Claude" },
    ],
  },
  {
    day: "화",
    date: "28",
    events: [
      { time: "10:00", title: "디자인 리뷰", kind: "human" },
      { time: "10:00", title: "경쟁사 분석", kind: "agent", agent: "Codex" },
      { time: "16:30", title: "위키 업데이트", kind: "automation", agent: "Hermes" },
    ],
  },
  {
    day: "수",
    date: "29",
    events: [
      { time: "11:00", title: "파트너 미팅", kind: "human" },
      { time: "13:00", title: "온보딩 QA", kind: "agent", agent: "Grok" },
    ],
  },
  {
    day: "목",
    date: "30",
    events: [
      { time: "09:00", title: "운영 지표 확인", kind: "automation", agent: "자동화" },
      { time: "15:00", title: "출시 결정", kind: "human" },
    ],
  },
  {
    day: "금",
    date: "31",
    events: [
      { time: "10:30", title: "주간 결과 요약", kind: "agent", agent: "Calendar AI" },
    ],
  },
];

const productRows = [
  {
    number: "01",
    title: "모든 일정을 아는 캘린더 AI",
    body: "허용한 캘린더와 위키를 바탕으로 자연스럽게 답하고, 명확한 요청은 일정 변경이나 위임 작업으로 이어집니다.",
  },
  {
    number: "02",
    title: "내 컴퓨터에서 움직이는 러너",
    body: "러너는 하나의 작업공간에만 연결됩니다. Codex, Claude, Grok, Hermes의 로그인과 자격 증명은 사용자 환경에 남습니다.",
  },
  {
    number: "03",
    title: "결과까지 이어지는 작업 대화",
    body: "상태 로그를 쏟아내지 않습니다. 계획, 승인 요청, 중요한 진행, 막힘, 결과만 하나의 작업 대화에 남깁니다.",
  },
];

function ActionLink({
  available,
  href,
  label,
  tone = "dark",
}: {
  available: boolean;
  href: string | null;
  label: string;
  tone?: "dark" | "light";
}) {
  const className = `action action--${tone}${available ? "" : " action--disabled"}`;

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

function WeekBoard() {
  return (
    <div className="calendar-scene" aria-label="사람 일정과 에이전트 작업이 함께 표시된 주간 캘린더 예시">
      <div className="scene-toolbar">
        <div>
          <span className="scene-kicker">통합 캘린더</span>
          <strong>7월 27일 – 31일</strong>
        </div>
        <div className="scene-legend" aria-label="일정 종류">
          <span><i className="legend-dot legend-dot--human" />내 일정</span>
          <span><i className="legend-dot legend-dot--agent" />에이전트 작업</span>
          <span><i className="legend-dot legend-dot--automation" />자동화</span>
        </div>
      </div>

      <div className="week-board" aria-hidden="true">
        {schedule.map((column) => (
          <div className="day-column" key={column.day}>
            <div className="day-heading">
              <span>{column.day}</span>
              <strong>{column.date}</strong>
            </div>
            <div className="day-track">
              {column.events.map((event, index) => (
                <div
                  className={`calendar-event calendar-event--${event.kind}`}
                  key={`${column.day}-${event.title}`}
                  style={{ "--event-index": index } as React.CSSProperties}
                >
                  <time>{event.time}</time>
                  <strong>{event.title}</strong>
                  {event.agent && <span>{event.agent}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mobile-agenda">
        {schedule.slice(0, 3).map((column) => (
          <div className="agenda-day" key={column.day}>
            <div className="agenda-date">
              <span>{column.day}</span>
              <strong>{column.date}</strong>
            </div>
            <div>
              {column.events.map((event) => (
                <div className="agenda-event" key={event.title}>
                  <i className={`legend-dot legend-dot--${event.kind}`} />
                  <time>{event.time}</time>
                  <span>{event.title}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="scene-note">
        사람의 시간과 에이전트의 실행 시간은 겹칠 수 있습니다. 캘린더는 둘을 숨기지 않고
        한 흐름으로 보여줍니다.
      </p>
    </div>
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
          <a href="#principles">원칙</a>
        </nav>
        <ActionLink
          available={handoff.signup.available}
          href={handoff.signup.href}
          label={handoff.signup.label}
        />
      </header>

      <main id="content">
        <section className="hero">
          <p className="eyebrow"><span />Calendar-first agent operations</p>
          <h1>
            일정이 흐르는 곳에서,
            <br />
            에이전트 일도 끝나게.
          </h1>
          <p className="hero-copy">
            Agent Calendar는 내 일정, 자동화, 위임한 에이전트 작업을 하나의 캘린더에서
            계획하고 관찰하는 작업 관제 공간입니다.
          </p>
          <div className="hero-actions">
            <ActionLink
              available={handoff.signup.available}
              href={handoff.signup.href}
              label={handoff.signup.label}
            />
            <a className="text-link" href="#product">
              제품 살펴보기 <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className="availability">
            <span className="status-dot" aria-hidden="true" />
            macOS Desktop private beta를 준비하고 있습니다.
          </p>
        </section>

        <section className="scene-wrap">
          <WeekBoard />
        </section>

        <section className="statement" id="product">
          <p className="section-label">하나의 운영 흐름</p>
          <h2>
            캘린더는 약속만 담는 곳이 아니라,
            <br />
            사람이 맡기고 에이전트가 끝내는 일을 담는 곳입니다.
          </h2>
        </section>

        <section className="product-list" aria-label="핵심 제품 기능">
          {productRows.map((row) => (
            <article className="product-row" key={row.number}>
              <span className="row-number">{row.number}</span>
              <h3>{row.title}</h3>
              <p>{row.body}</p>
            </article>
          ))}
        </section>

        <section className="runner-section" id="runner">
          <div className="runner-copy">
            <p className="section-label section-label--dark">사용자가 소유하는 실행 환경</p>
            <h2>구독은 그대로.<br />러너만 연결하세요.</h2>
            <p>
              Agent Calendar가 모델 계정을 대신 보관하지 않습니다. 각 작업공간의 러너가
              사용자가 이미 로그인한 실행 엔진을 연결하고, 해당 작업공간의 일만 받습니다.
            </p>
          </div>
          <div className="engine-list" aria-label="지원 예정 실행 엔진">
            {["Codex", "Claude Code", "Grok", "Hermes"].map((engine, index) => (
              <div key={engine}>
                <span>0{index + 1}</span>
                <strong>{engine}</strong>
                <small>Runner 연결</small>
              </div>
            ))}
          </div>
        </section>

        <section className="principles" id="principles">
          <div>
            <p className="section-label">제품 원칙</p>
            <h2>보여줄 것은 보여주고,<br />맡기지 않은 것은 하지 않습니다.</h2>
          </div>
          <dl>
            <div>
              <dt>Workspace isolation</dt>
              <dd>캘린더, 위키, 작업, 러너는 작업공간 밖으로 섞이지 않습니다.</dd>
            </div>
            <div>
              <dt>Explicit approval</dt>
              <dd>새 권한, 추가 비용, 외부 전달이 필요한 변경은 반드시 승인을 거칩니다.</dd>
            </div>
            <div>
              <dt>Useful checkpoints</dt>
              <dd>생각 과정이나 도구 로그 대신 사용자가 판단할 수 있는 변화만 남깁니다.</dd>
            </div>
          </dl>
        </section>

        <section className="closing">
          <p className="section-label">Private beta</p>
          <h2>당신의 다음 주를,<br />일하는 에이전트와 함께.</h2>
          <div className="closing-actions">
            <ActionLink
              available={handoff.signup.available}
              href={handoff.signup.href}
              label={handoff.signup.label}
            />
            <ActionLink
              available={handoff.download.available}
              href={handoff.download.href}
              label={handoff.download.label}
              tone="light"
            />
          </div>
          <p className="release-note">
            공개 다운로드 전 서명과 체크섬을 검증합니다. 준비된 척하는 링크는 제공하지
            않습니다.
          </p>
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
