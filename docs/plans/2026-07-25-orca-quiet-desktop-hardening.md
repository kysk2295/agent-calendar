# Plan: Orca quiet Desktop hardening

- Date: 2026-07-25
- Owner: Codex
- Work size: Large
- Status: Complete

## Goal

Agent Calendar Desktop의 공통 셸, 로그인, 시작 가이드, 설정, 위젯, 에이전트 작업,
상세 모달을 실제 Orca 제품처럼 조용하고 조밀한 작업 도구로 정리한다. 기능과 정보
구조는 유지하되 큰 빈 캔버스, 중앙 카드 템플릿, 과한 그림자, 반복 설명, 장식성 상태
표현을 제거한다.

## Non-goals

- Backend, DB, Workspace 격리, Runner 실행 또는 Calendar AI 계약을 변경하지 않는다.
- 화면 이름, 내비게이션 구조, 인증 방식 또는 기존 `data-testid`를 바꾸지 않는다.
- Orca의 로고, 브랜드명, 터미널 중심 정보 구조를 복제하지 않는다.
- Web landing 또는 Mobile UI를 이번 단계에서 구현하지 않는다.
- 각 도메인 화면의 기능 레이아웃과 작업 흐름을 다시 설계하지 않는다.

## Work size

Large. 공통 Desktop 토큰과 셸, 인증, 시작 가이드, 설정, 위젯, 에이전트 작업,
상세 모달 표면, 구조 계약 테스트, 실제 Electron light/dark 검증을 함께 변경한다.

## Touched boundaries

- Backend gateway: 변경 없음
- Backend libraries and DB: 변경 없음
- Electron bridge: 동작 변경 없음, 실제 빌드 검증만 수행
- Desktop React: `apps/desktop/src/App.tsx`,
  `apps/desktop/src/features/onboarding/OnboardingGuide.tsx`
- Desktop styles: `apps/desktop/src/styles.css`,
  `apps/desktop/src/features/onboarding/onboarding.css`
- Tests: Desktop 디자인 계약과 실제 Electron first-run, 위젯, 상세 모달 흐름
- Docs: 이 계획과 시각 검증 증거

## Design contract

- Mode: 기존 IA와 Agent Calendar 브랜드를 보존하는 제품 리디자인
- Reference: Orca Desktop의 중성 셸, 조밀한 행, 얇은 경계, 작은 컨트롤
- Design variance: 4
- Motion intensity: 2
- Visual density: 6
- Color: neutral light/dark surfaces + terracotta 한 가지 의미 강조
- Shape: control 6px, large surface 10px, 데이터 행 0px
- Elevation: 제품 내부와 overlay 모두 shadow/glass 없이 border와 surface로 구분

## Success criteria

- [x] 로그인, 시작 가이드, 설정, Unified Calendar가 동일한 타입·간격·반경 규칙을 쓴다.
- [x] 로그인은 제품 설명을 반복하는 카드가 아니라 계정 진입과 보안 경계만 보여준다.
- [x] 시작 가이드는 4단계를 유지하면서 760px 안쪽의 조밀한 작업면으로 보이고,
      현재 작업 아래에 불필요한 대형 빈 영역을 남기지 않는다.
- [x] 시작 가이드는 단계 제목을 4번 반복하거나 상태 배지를 남발하지 않는다.
- [x] 설정은 한 번에 한 pane만 보여주고 설명 문구와 중첩 카드가 최소화된다.
- [x] 공통 셸의 선택 상태, 버튼, 검색, 배너는 gradient, glow, 과장된 shadow를 쓰지 않는다.
- [x] light/dark 1320px와 compact 768px에서 overflow, 잘림, 저대비가 없다.
- [x] 로그인, 인증, Google Calendar 연결, 가이드 열기/닫기, 설정, Calendar AI 동작이 회귀하지 않는다.

## Edge cases

- 768px 이하에서 시작 가이드가 전체 높이 단일 열로 전환된다.
- 긴 한국어 단계명과 Workspace 이름은 자연스럽게 말줄임 또는 줄바꿈된다.
- 오류 메시지는 레이아웃을 밀어내지 않고 현재 작업 안에서 읽힌다.
- 모든 단계가 준비되지 않아도 `나중에 하기`는 접근 가능하고 `설정 완료` 상태는 명확하다.
- reduced motion에서 화면 진입과 상태 전환이 즉시 적용된다.

## Test plan

1. 디자인 계약을 먼저 추가하고 기존 코드에서 예상한 이유로 실패시킨다.
2. 공통 토큰과 네 개 핵심 표면을 최소 변경으로 구현한다.
3. focused 디자인 계약, onboarding readiness, Desktop 전체 테스트를 실행한다.
4. typecheck와 production Desktop build를 실행한다.
5. 실제 Electron light/dark에서 로그인, onboarding, calendar, settings를 캡처한다.
6. fresh capture와 현재 소스를 독립 visual QA에 제출한다.

## Acceptance gates

- [x] focused Orca quiet UI design contract
- [x] onboarding readiness tests
- [x] Desktop typecheck
- [x] Desktop tests
- [x] Desktop production build
- [x] fresh Electron light screenshots
- [x] fresh Electron dark screenshots
- [x] independent design-system and visual/CJK review
- [x] `git diff --check`

## Step-by-step checklist

- [x] 현재 제품 화면과 Orca 공개 제품 화면·소스를 비교한다.
- [x] RED 디자인 계약으로 크기, 그림자, 반복 copy, 공통 density를 고정한다.
- [x] 로그인과 시작 가이드를 조밀한 계정/설정 surface로 정리한다.
- [x] 설정과 공통 셸의 중첩 surface 및 장식 style을 정리한다.
- [x] 위젯, 에이전트 작업, 상세 모달과 날짜 팝오버를 동일한 토큰으로 정리한다.
- [x] light/dark 실제 Electron과 전체 Desktop 회귀를 검증한다.
- [x] fresh evidence에 대한 독립 검토를 통과한다.

## Rollback

React/CSS와 디자인 계약 변경만 되돌리면 기존 화면으로 돌아간다. API, DB,
persisted meaning을 바꾸지 않으므로 데이터 rollback은 필요 없다.

## Remaining risks

- `App.tsx`와 `styles.css`가 큰 단일 파일인 구조적 유지보수 위험은 남아 있다. 이번
  변경 표면은 토큰과 디자인 계약 테스트로 보호한다.
- renderer production bundle은 약 596.8 kB로 Vite의 500 kB 경고를 유지한다.
- Google Calendar E2E는 현재 성공 후 `동기화 완료` 문구를 찾지 못하는 기존 불일치가
  관찰됐다. 이번 시각 변경과 구분해 원인을 확인하되 테스트를 약화하지 않는다.
