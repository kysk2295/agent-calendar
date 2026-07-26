# Plan: Orca navigation focus pass

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Desktop의 기능과 화면 이름은 유지하면서 첫 화면의 선택지를 Orca처럼 핵심 작업 위주로
줄인다. 캘린더, 에이전트, 자동화를 즉시 보이게 하고 나머지 도구는 하나의 확장 영역에서
찾을 수 있게 하며, 시작 가이드의 카드형 장식과 반복 설명을 제거한다.

## Non-Goals

- 화면, API, 데이터 또는 Workspace 권한 계약을 삭제하거나 바꾸지 않는다.
- Orca의 로고, 브랜드 자산, 터미널 중심 정보 구조를 복제하지 않는다.
- Calendar, Agent Work, Wiki 내부의 기능 흐름을 다시 설계하지 않는다.
- Web landing이나 Mobile UI를 변경하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/App.tsx`, `OnboardingGuide.tsx`
- Tests: Orca 디자인 계약, 실제 renderer 시각 QA
- Docs: 이 계획과 검증 기록

## Success Criteria

- [x] 사이드바 첫 단계에는 캘린더, 에이전트, 자동화만 제품 핵심 항목으로 보인다.
- [x] 일정 보조 화면, 지식, Runner, 위젯은 한 개의 `작업공간` 확장 영역에서 접근한다.
- [x] 현재 화면이 확장 영역에 있으면 해당 영역이 자동으로 열린다.
- [x] 활성 항목은 accent 막대 없이 중립 surface와 글자 굵기로 구분한다.
- [x] 시작 가이드는 큰 외곽 카드와 중복 상태 문구 없이 단계 레일과 내용만 보여준다.
- [x] 기존 `data-testid`, 화면 전환, 키보드 focus와 light/dark 테마가 유지된다.

## Edge Cases

- 확장 영역 안의 화면으로 deep link 또는 설정에서 이동해도 현재 항목이 가려지지 않는다.
- 동적 리스트와 태그가 없어도 추가 동작은 유지된다.
- 768px 이하에서 사이드바와 시작 가이드가 수평 overflow를 만들지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 핵심 내비게이션과 하나의 확장 영역, 평평한 온보딩 구조 계약이 기존 코드에서 실패한다.
- GREEN:
  - [x] 기존 클릭 동작을 유지하는 최소 JSX/CSS 변경을 적용한다.
- REFACTOR:
  - [x] 사용하지 않는 활성 accent와 외곽 카드 규칙만 제거한다.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/orca-product-surfaces-design.test.mjs`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 renderer light/dark QA

건너뛴 gate:

- Backend gates:
  - Desktop 표시 구조만 변경하므로 backend 계약 테스트는 실행하지 않는다.
- Lighthouse:
  - Electron 제품 표면은 실제 viewport, overflow, contrast 검사로 대체한다.

## Implementation Checklist

- [x] Step 1: 현재 화면과 최신 Orca 공식 화면의 내비게이션 밀도를 비교한다.
- [x] Step 2: 변경 전 실패하는 디자인 계약을 고정한다.
- [x] Step 3: 핵심 내비게이션, 확장 영역, 평평한 시작 가이드를 구현한다.
- [x] Step 4: Desktop 회귀와 실제 light/dark 화면을 검증한다.

## Verification Notes

- Orca reference:
  - `https://github.com/stablyai/orca`
  - `https://www.onorca.dev/`
- Current finding:
  - 색상과 행 밀도는 이미 중립화됐지만 기본 사이드바가 13개 이상의 고정 기능을 동시에
    노출해 Orca의 핵심 항목 우선 구조보다 훨씬 복잡하다.
- RED:
  - `node --test apps/desktop/tests/orca-product-surfaces-design.test.mjs`
  - focused navigation definition과 200px flat onboarding 계약 2건이 예상대로 실패했다.
- Verification:
  - 디자인 계약 10/10 통과
  - Desktop 전체 테스트 244/244 통과
  - typecheck와 production Desktop build 통과
  - `git diff --check`와 변경 파일 trailing whitespace 검사 통과
- Real Electron:
  - light/dark Calendar에서 기본 핵심 항목 3개, 닫힌 `작업공간`, 수평 overflow 없음 확인
  - `작업공간`을 열어 오늘, 다음 7일, 기본함, Wiki, Runner 설정, 위젯 접근 확인
  - light/dark 첫 실행 가이드와 Google Calendar 연결 시나리오 통과
  - AuthKit 완료 1회, safeStorage, 재시작 세션 복원 유지
- Existing observations:
  - Desktop 테스트 중 기존 `Port 24678 is already in use` 경고가 출력되지만 244개 테스트는
    모두 통과한다.
  - renderer bundle은 기존 500 kB 경고가 남아 있다.

## Remaining Risks

- `App.tsx`와 `styles.css`가 큰 파일이므로 내비게이션 selector와 시작 가이드에만 변경을
  제한한다.
