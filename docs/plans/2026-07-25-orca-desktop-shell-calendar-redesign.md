# Plan: Orca-inspired Desktop shell and Calendar redesign

- Date: 2026-07-25
- Owner: Codex
- Work size: Large
- Status: Verified

## Goal

Agent Calendar의 Desktop 셸과 Unified Calendar를 Orca의 실제 제품 화면처럼 조용하고
촘촘한 작업 도구로 정리한다. 기존의 따뜻한 색과 캘린더 중심 정보 구조는 유지하되,
이모지 메뉴, 과장된 원형 AI 버튼, 반복 카드와 불필요한 설명을 제거한다.

## Non-Goals

- Backend, Workspace 격리, Runner 또는 Calendar API 계약을 바꾸지 않는다.
- Orca의 로고, 브랜드 색, 문구, 터미널 중심 IA를 복제하지 않는다.
- 이번 단계에서 Agent Work, Wiki, Automation 내부 화면 전체를 재설계하지 않는다.
- Desktop을 모바일 내비게이션 셸로 바꾸지 않는다.

## Work Size

Large. Desktop React 셸, Calendar 화면, 전역 CSS, 실제 Electron 화면, 디자인 계약과
테스트를 함께 변경한다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 동작 변경 없음
- React UI: `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`
- Tests: Desktop 구조 계약, 실제 Electron 라이트/다크 QA
- Docs: `docs/DESIGN.md`, 디자인 상태와 검증 증거

## Reference Audit

- Orca에서 채택:
  - 고정된 얇은 사이드바와 한 줄짜리 상단 작업 바
  - 선택 항목의 조용한 톤 차이와 최소한의 상태 표시
  - 그림자보다 경계와 간격으로 만드는 계층
  - 작업 목록과 상태를 한눈에 훑을 수 있는 촘촘한 밀도
- Agent Calendar에서 유지:
  - 따뜻한 중립 팔레트와 terracotta accent
  - Unified Calendar가 첫 화면인 제품 구조
  - 화면 이름, 내비게이션 순서, 모든 동작 및 `data-testid`
- 제거:
  - 메뉴 이모지
  - gradient와 큰 shadow가 있는 원형 Calendar AI 버튼
  - 반복되는 작은 대문자 그룹 제목
  - Calendar source를 별도 카드처럼 보이게 하는 과도한 수직 공간

## Success Criteria

- [x] 사이드바에 이모지 메뉴가 없고 하나의 16px 선형 아이콘 체계를 사용한다.
- [x] Calendar AI는 상단 작업 바의 조용한 텍스트/아이콘 버튼이며 기존 열기 동작과
      `.chat-fab` 테스트 계약을 유지한다.
- [x] 선택 메뉴는 그림자나 accent 박스가 아니라 중립 surface와 얇은 leading marker로
      표시된다.
- [x] Unified Calendar는 source 상태, 담당자 필터, view 전환, 날짜 이동을 두 개의
      촘촘한 행 안에서 제공하고 Calendar grid가 화면의 주 영역을 차지한다.
- [x] 라이트와 다크 Electron 화면에서 잘림, 겹침, 수평 스크롤, 저대비 텍스트가 없다.
- [x] 375px, 768px, 1320px에서 기존 Desktop sidebar 모델과 모든 화면 내 조작이 유지된다.
- [x] 기존 Calendar AI, navigation, Google Calendar, offline/reconnect 동작이 회귀하지 않는다.

## Edge Cases

- 긴 한국어 Workspace 이름과 동적 list/tag 이름은 한 줄 말줄임 처리한다.
- onboarding 복귀 버튼과 Calendar AI가 동시에 있어도 top bar가 넘치지 않는다.
- Google source가 없거나 여러 개이거나 읽기 전용이어도 source row가 깨지지 않는다.
- dark theme에서도 선택 marker와 Calendar event가 텍스트 없이 색만으로 상태를 전달하지 않는다.
- reduced motion에서는 screen entry 이동이 제거된다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Desktop 구조 계약 테스트가 emoji navigation, floating gradient FAB, 넓은 shell
        token 때문에 실패한다.
- GREEN:
  - [x] 디자인 계약, Phosphor icon 사용, compact shell/calendar CSS를 최소 구현한다.
- REFACTOR:
  - [x] 동작 계약과 test selector는 유지하면서 반복 style만 semantic token으로 정리한다.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/orca-shell-calendar-design.test.mjs`
- [x] 실제 Electron AuthKit Calendar light QA
- [x] 실제 Electron AuthKit Calendar dark QA
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`

건너뛴 gate:

- Lighthouse:
  - Electron의 인증된 `file://` 제품 표면은 현재 저장소에 real-Chrome Lighthouse harness가
    없고 기존 디자인 상태가 외부 audit tooling 설치를 명시적으로 보류한다. 실제 Electron
    Playwright, typecheck, build, contrast/layout audit로 대체하고 이 제한을 증거에 남긴다.
- `playwright-theme-layout-audit.cjs`:
  - 현재 browser-preview harness는 로그인 화면에 머물러 인증된 `.chat-fab` 셸에 도달하지
    못한다. 같은 검사를 실제 AuthKit Electron에 넣어 light/dark, 1320/768/375px,
    horizontal overflow, top-bar containment, Calendar AI keyboard open/close를 검증했다.

## Implementation Checklist

- [x] Step 1: 디자인 계약과 RED 구조 테스트를 고정한다.
- [x] Step 2: Desktop shell navigation, top bar, Calendar AI entry를 재구성한다.
- [x] Step 3: Calendar toolbar/source row/grid 밀도를 정리한다.
- [x] Step 4: 라이트/다크 실제 Electron 화면과 keyboard/overflow를 검증한다.
- [x] Step 5: 전체 Desktop gate와 독립 리뷰를 통과하고 증거를 기록한다.

## Rollback

CSS/JSX 변경만 되돌리면 기존 shell과 Calendar 표시로 즉시 복귀한다. Backend, DB,
session, Electron IPC 계약을 건드리지 않으므로 데이터 migration rollback은 없다.

## Verification Notes

- `node --test apps/desktop/tests/orca-shell-calendar-design.test.mjs`
  - RED 0/3을 확인한 뒤 GREEN 3/3.
- `AGENT_CALENDAR_E2E_TIMEOUT_MS=90000 node apps/desktop/tests/playwright-orca-shell-calendar.cjs`
  - PASS. AuthKit 로그인, safeStorage, 재시작 복원, 1320/768/375px 레이아웃,
    Calendar AI keyboard open/close.
- `AGENT_CALENDAR_E2E_THEME=dark AGENT_CALENDAR_E2E_TIMEOUT_MS=90000 node apps/desktop/tests/playwright-orca-shell-calendar.cjs`
  - PASS. 동일한 dark-theme 실기기 검증.
- `AGENT_CALENDAR_E2E_TIMEOUT_MS=90000 node apps/desktop/tests/playwright-phase8-offline-reconnect.cjs`
  - PASS. 일정 유지, offline, reconnect, restart.
- `AGENT_CALENDAR_E2E_THEME=dark AGENT_CALENDAR_E2E_TIMEOUT_MS=90000 node apps/desktop/tests/playwright-phase8-offline-reconnect.cjs`
  - PASS. 일정이 채워진 dark Calendar의 semantic event tokens, offline, reconnect, restart.
- `npm --workspace apps/desktop run test`
  - PASS, 203/203.
- `npm run build:desktop`
  - PASS. TypeScript, renderer, Electron build.
- `npm test`
  - PASS. Backend, Desktop, Runner 전체 suite.
- Independent design-system/fidelity review:
  - 첫 검토에서 Calendar semantic color의 literal 사용을 차단했고 token/dark evidence로
    수정한 뒤 재검토 PASS. Critical/High/Medium/Low finding 없음.

## Remaining Risks

- 이번 단계는 공통 shell과 Calendar에 집중한다. Agent Work, Wiki, Automation 내부의
  오래된 card-heavy 화면은 후속 화면별 리디자인이 필요할 수 있다.
- `App.tsx`와 `styles.css`가 큰 단일 파일인 기존 구조는 이번 시각 작업에서 분리하지 않는다.
- Renderer bundle은 500kB를 넘는 기존 Vite 경고가 남아 있다. 이번 시각 변경 범위에서는
  code splitting을 추가하지 않는다.
