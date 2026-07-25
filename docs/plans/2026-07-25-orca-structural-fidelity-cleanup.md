# Plan: Orca structural fidelity cleanup

- Date: 2026-07-25
- Owner: Codex
- Work size: Large
- Status: Verified

## Goal

Agent Calendar Desktop의 설정과 시작 가이드를 최신 Orca 제품 구조처럼 한 번에 하나의
작업에 집중하는 화면으로 정리한다. 기존 기능과 정보 구조는 유지하면서 겹친 셸, 카드형
구획, 장식적인 강조색과 반복 설명을 줄인다.

## Non-Goals

- Backend, DB, Workspace 격리, Runner 실행 또는 Calendar AI 계약을 바꾸지 않는다.
- 캘린더, Agent Work, Wiki의 기능 구조를 다시 설계하지 않는다.
- Orca 로고, 제품명, 개발 도구 용어를 복제하지 않는다.
- Web landing과 Mobile UI를 변경하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/App.tsx`, `OnboardingGuide.tsx`
- Tests: Orca 제품 디자인 계약, 실제 Electron AuthKit 흐름
- Docs: 이 계획, `docs/DESIGN.md`

## Success Criteria

- [x] 시작 가이드는 기존 앱 사이드바와 상단 바를 숨기고 하나의 전체 화면 설정 흐름으로 보인다.
- [x] 시작 가이드는 세로 카드 레일 대신 Orca식 상단 진행 표시와 한 개의 현재 단계만 강조한다.
- [x] 설정은 둥근 팝업이 아니라 전체 화면 2-pane 작업면이며 선택한 설정 pane 하나만 보인다.
- [x] 기본 실행 버튼은 중립 전경색을 사용하고 terracotta는 캘린더 의미와 제한된 강조에만 남는다.
- [x] 기존 시작 가이드, 설정, 테마, Runner 진입 동작과 테스트 식별자가 유지된다.
- [x] light/dark 실제 Electron에서 잘림, 수평 overflow, 겹친 셸이 없다.

## Edge Cases

- 작은 창: 설정 sidebar는 축소되고 시작 가이드는 단일 열로 유지한다.
- 긴 계정 이름: 설정 sidebar와 계정 행에서 말줄임 처리한다.
- 시작 설정 미완료: 진행 표시와 완료 버튼 disabled 상태가 레이아웃을 바꾸지 않는다.
- 직접 설정 진입: 마지막 선택 pane과 무관하게 계정 pane에서 시작한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 전체 화면 settings pane, 중립 action token, 단일 onboarding flow 계약을 먼저 실패시킨다.
- GREEN:
  - [x] 기존 동작과 selector를 보존한 최소 React/CSS 변경을 적용한다.
- REFACTOR:
  - [x] 이전 settings/onboarding 카드 규칙과 중복 설명을 제거한다.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/orca-product-surfaces-design.test.mjs`
- [x] `npm --workspace apps/desktop run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 Electron light onboarding/settings QA
- [x] 실제 Electron dark onboarding/settings QA
- [x] `git diff --check`

건너뛴 gate:

- Backend gates:
  - Desktop 표시 구조만 변경하므로 backend 계약 테스트는 실행하지 않는다.
- `npm test`:
  - Desktop 범위의 전체 gate와 실제 Electron QA를 우선하며, 사용자 작업이 많은 전체
    저장소의 장시간 gate는 이번 시각 범위에서 생략한다.

## Implementation Checklist

- [x] Step 1: 현재 제품 화면과 최신 Orca 공개 소스의 설정/온보딩 구조를 비교한다.
- [x] Step 2: 변경 전 실패하는 디자인 계약을 고정한다.
- [x] Step 3: 전체 화면 설정과 단일 onboarding flow를 구현한다.
- [x] Step 4: Desktop 회귀와 실제 light/dark 화면을 검증한다.
- [x] Step 5: 디자인 문서와 검증 증거를 갱신한다.

## Verification Notes

- Reference:
  - `https://github.com/stablyai/orca`
  - `src/renderer/src/components/settings/SettingsSidebar.tsx`
  - `src/renderer/src/components/onboarding/OnboardingFlow.tsx`
- RED evidence:
  - 디자인 계약 최초 실행에서 7 passed / 3 failed로 전체 화면 settings, 중립 action,
    단일 onboarding flow가 구현 전 실패하는 것을 확인했다.
- GREEN evidence:
  - 디자인 계약 10/10 통과.
  - Desktop 전체 테스트 244/244 통과.
  - Desktop typecheck와 production build 통과.
  - Electron light/dark에서 onboarding, settings, AuthKit session restore,
    safeStorage, update/recovery 흐름을 실제 실행해 통과했다.
- Non-blocking observations:
  - Vite build는 renderer chunk가 500 kB를 넘는 기존 경고를 출력한다.
  - Desktop 전체 테스트 중 Vite dependency scan 재시작과 이미 사용 중인 테스트 포트
    경고가 출력되지만 최종 결과는 244 passed / 0 failed이다.

## Remaining Risks

- `App.tsx`와 `styles.css`가 큰 단일 파일이라는 구조적 부채는 남아 있다.
- Renderer bundle size 경고는 이번 시각 범위 밖이며 별도 성능 작업으로 다룬다.
