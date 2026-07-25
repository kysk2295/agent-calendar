# Plan: Orca flat workbench visual pass

- Date: 2026-07-25
- Owner: Codex
- Work size: Large
- Status: Complete

## Goal

Agent Calendar Desktop의 로그인, 시작 가이드, 설정을 실제 Orca 제품처럼 조용한
작업 도구 표면으로 정리한다. 기존 IA, 인증, Workspace 준비 상태와 모든 동작은
유지하면서 중앙 카드 템플릿, 중복 브랜드 장식, 큰 제목, warm legacy 스타일을
제거한다.

## Non-Goals

- Backend, DB, 인증 계약, Runner 또는 Calendar AI 동작을 바꾸지 않는다.
- Calendar, Agent Work, Wiki의 정보 구조를 다시 설계하지 않는다.
- Orca의 브랜드, 로고, 터미널 전용 구조를 복제하지 않는다.
- Web landing과 Mobile UI를 변경하지 않는다.

## Work Size

Large. 공통 Desktop 로그인 스타일, 온보딩 React/CSS, 설정 표면, 디자인 계약,
실제 Electron QA를 함께 변경한다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 동작 변경 없음
- React UI: `apps/desktop/src/features/onboarding/OnboardingGuide.tsx`
- Styling: `apps/desktop/src/styles.css`,
  `apps/desktop/src/features/onboarding/onboarding.css`,
  `apps/desktop/src/features/onboarding/onboarding-controls.css`
- Tests: Orca 디자인 계약, onboarding readiness, 실제 Electron 화면
- Docs: 이 계획과 시각 검증 증거

## Design Contract

- Mode: 기존 브랜드와 IA를 보존하는 Desktop product redesign
- Reference: Orca의 compact workspace rail, flat pane hierarchy, neutral action
- Design variance: 4
- Motion intensity: 2
- Visual density: 7
- Shape: 행은 radius 0, 선택 행과 컨트롤만 6px
- Elevation: shadow와 glass 없이 surface 차이와 1px line만 사용

## Success Criteria

- [x] 로그인은 bordered center card가 아니라 borderless account entry로 보인다.
- [x] 사용하지 않는 warm login splash, orbit, social form CSS가 제거된다.
- [x] 시작 가이드는 global shell 안에서 단계 rail과 단일 detail pane으로 보인다.
- [x] 시작 가이드의 로고, 제품명, 단계 제목, 설명이 중복되지 않는다.
- [x] 설정 계정은 rounded card가 아니라 scan 가능한 flat row로 보인다.
- [x] light/dark 1320px와 768px에서 overflow, 잘림, 저대비가 없다.
- [x] 인증, 단계 선택, Calendar/Runner/Wiki/Calendar AI 이동, dismiss/complete가 회귀하지 않는다.

## Edge Cases

- 768px 창에서도 네 단계 제목과 상태가 읽히고 상세 행동이 잘리지 않는다.
- 긴 Workspace 이름과 단계 상태는 한 줄 말줄임 또는 자연스러운 줄바꿈을 사용한다.
- 오류와 진행 상태는 현재 작업면 안에서 보이고 layout shift를 최소화한다.
- dark theme에서도 selected row, disabled button, focus ring 대비를 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] borderless login, flat settings row, visible onboarding step rail 계약을 추가한다.
- GREEN:
  - [x] 기존 callback과 test selector를 유지하는 최소 JSX/CSS 변경을 적용한다.
- REFACTOR:
  - [x] 사용되지 않는 legacy login CSS를 삭제하고 중복 selector를 남기지 않는다.

## Acceptance Gates

- [x] focused Orca design contracts
- [x] onboarding readiness tests
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] actual Electron light QA
- [x] actual Electron dark QA
- [x] `git diff --check`

건너뛴 gate:

- Backend/full monorepo:
  - React/CSS 전용 변경이므로 Desktop gate 이후 현재 제품 goal의 다음 boundary
    단계에서 전체 gate를 다시 실행한다.
- Lighthouse:
  - 인증된 Electron `file://` 표면이라 실제 Electron overflow, contrast, keyboard
    검증으로 대체한다.

## Implementation Checklist

- [x] 현재 화면과 Orca 공식 화면을 비교하고 시각 부채를 식별한다.
- [x] RED 디자인 계약을 추가하고 예상한 이유로 실패시킨다.
- [x] 로그인 legacy 스타일을 제거하고 borderless entry를 구현한다.
- [x] 시작 가이드를 step rail과 detail pane으로 재구성한다.
- [x] 설정 account surface를 flat row로 정리한다.
- [x] light/dark Electron에서 실제 흐름을 확인한다.

## Rollback

React/CSS와 디자인 계약 변경만 되돌리면 이전 표면으로 복귀한다. API, DB 또는
persisted meaning을 바꾸지 않으므로 데이터 rollback은 필요 없다.

## Verification Notes

- Baseline focused contracts:
  - 29 passed, 0 failed.
- Baseline Electron shell:
  - login, calendar, restart restore passed.
- RED design contracts:
  - 16 passed, 5 failed for the expected login, onboarding, and settings reasons.
- Focused final contracts:
  - 25 passed, 0 failed.
- Desktop gates:
  - typecheck passed.
  - 260 passed, 0 failed.
  - production Desktop build passed.
- Electron QA:
  - Orca shell/calendar/auth restart scenario passed.
  - first-run session truth passed in light and dark themes.
  - 1320px and 768px guide captures had no horizontal overflow.
- Evidence:
  - `docs/operations/evidence/2026-07-25-orca-flat-workbench-pass.md`
- Pre-existing unrelated manual script failure:
  - `playwright-agent-work-workspace.cjs`가 현재 화면의 focusable control 목록을
    빈 배열로 기대해 실패했다. 이번 변경 전에 재현됐으며 이 패스의 동작 lock에는
    사용하지 않는다.

## Remaining Risks

- `styles.css`는 기존 9,160줄의 단일 파일이다. 이번 패스는 실제 사용 중인 로그인과
  설정 selector 및 확인된 legacy login 블록으로 범위를 제한한다.
- 로컬 Mac이 잠겨 있어 실행 중 Orca 창의 직접 캡처는 못 했고, 공식 최신 제품
  이미지와 로컬 Orca CLI 상태를 사용했다. 잠금이 풀리면 마지막 대조를 추가한다.
