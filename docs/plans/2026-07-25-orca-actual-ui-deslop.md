# Plan: Orca 실제 제품 UI 기준 디슬롭

- Date: 2026-07-25
- Owner: Codex
- Work size: Large
- Status: Verified

## Goal

Desktop의 기존 기능과 정보 구조는 유지하면서 실제 Orca 제품의 중립 색상, 조밀한 타입,
평평한 작업 표면, 제한된 장식 규칙으로 시각 체계를 정리한다. 사용자는 Calendar,
Agent Work, Runner, Wiki, Settings, 시작 가이드에서 장식용 카드보다 실제 상태와 다음
행동을 먼저 읽을 수 있어야 한다.

## Non-Goals

- Calendar, Runner, Wiki, Automation의 제품 동작이나 API 계약을 바꾸지 않는다.
- 모바일 앱이나 Web 랜딩 페이지를 이번 변경에 포함하지 않는다.
- Orca의 코드 편집기·터미널 구조를 Calendar 제품에 그대로 복제하지 않는다.
- 기존 6,000줄대 전역 스타일을 이번 변경에서 전면 분해하지 않는다.

## Work Size

Large. Desktop React 전역 셸과 여러 기능 화면의 공통 시각 계약 및 Playwright 표면을
함께 건드린다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: 없음
- DB/migrations: 없음
- Electron bridge: 없음
- React UI:
  - `apps/desktop/src/main.tsx`
  - `apps/desktop/src/orca-product-polish.css`
  - 필요한 경우 장식 문구를 제거하는 최소 React 변경
- Tests:
  - `apps/desktop/tests/orca-product-surfaces-design.test.mjs`
  - 관련 Desktop Playwright 시나리오
- Docs:
  - 이 계획
  - 검증 증거

## Success Criteria

- [x] light는 `#fff / #fafafa / #f5f5f5`, dark는 `#0a0a0a / #171717 / #262626`
      계열로 한정하고 제품 강조색은 행동과 실제 상태에만 사용한다.
- [x] 시작 가이드, Runner, Wiki, Settings에서 중첩 카드·과한 라운드·큰 그림자를
      제거하고 행, 구분선, 여백으로 계층을 만든다.
- [x] 앱 셸은 220px 사이드바, 40px 상단바, 30px 컨트롤 높이와 11-14px 작업형
      타입 스케일을 일관되게 사용한다.
- [x] Calendar와 Agent Work의 기존 정보 구조, 키보드 접근성, light/dark 테마가
      유지된다.
- [x] 1320×768 light/dark 실제 Electron 화면에서 잘림, 겹침, 대비 실패가 없다.

## Edge Cases

- 768px 너비에서도 시작 가이드의 단계 rail과 detail pane이 수평 오버플로를 만들지
  않아야 한다.
- QR은 디슬롭 이후에도 최소 256px 디코드 가능 크기를 유지해야 한다.
- dark 테마의 border는 밝아지지 않고 `rgba(255,255,255,.07)` 계층을 유지해야 한다.
- 상태색을 제거해도 오류, 성공, 연결 끊김은 텍스트와 아이콘으로 구분되어야 한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 최종 polish 레이어 import와 Orca 토큰·평면화 규칙을 요구하는 디자인 회귀
        테스트를 추가하고 예상된 실패를 확인한다.
- GREEN:
  - [x] 250 pure LOC 이하의 `orca-product-polish.css` 한 파일로 공통 최종 레이어를
        구현한다.
- REFACTOR:
  - [x] 중복 selector와 불필요한 `!important`를 제거하되 테스트가 계속 green인지
        확인한다.

## Acceptance Gates

- [x] `npm --workspace apps/desktop run test`
- [x] `npm run typecheck`
- [x] `npm run build:desktop`
- [x] 관련 Playwright light/dark 실제 화면
- [x] `git diff --check`

건너뛴 gate:

- Backend gates:
  - Reason: Backend·DB·API 동작을 변경하지 않는 Desktop 시각 전용 변경이다.
- Static/security scan:
  - Reason: 저장소에 별도 정적 보안 스캐너가 구성되어 있지 않다.

## Implementation Checklist

- [x] 실제 Orca 제품 이미지와 공개 디자인 토큰을 현재 화면과 비교한다.
- [x] 기존 Desktop 디자인 회귀 테스트 260개 green 기준을 확보한다.
- [x] 최종 polish 레이어 계약을 RED 테스트로 고정한다.
- [x] 앱 셸·공통 컨트롤을 정리한다.
- [x] 시작 가이드·Runner·Wiki·Settings를 평평한 작업 표면으로 정리한다.
- [x] light/dark 실제 화면을 확인하고 시각 결함을 수정한다.
- [x] 전체 Desktop gate와 빌드를 통과한다.

## Verification Notes

- Command: `npm --workspace apps/desktop run test -- --test-name-pattern='orca|onboarding'`
  - Result: PASS, 260 tests. 현재 runner가 인자를 전 테스트에 전달해 전체 Desktop
    테스트가 실행되었다.
- Reference:
  - Orca light tokens: `#fff`, `#fafafa`, `#f5f5f5`, `#e5e5e5`, `#171717`.
  - Orca dark tokens: `#0a0a0a`, `#171717`, `#262626`,
    `rgb(255 255 255 / .07)`.
- Command: 디자인 회귀 테스트
  - Result: RED에서 polish import 부재를 확인한 뒤 GREEN 11/11.
- Command: `npm run build:desktop`
  - Result: PASS. typecheck, renderer build, Electron build 포함.
- Command: 관련 Electron Playwright 시나리오
  - Result: PASS. Orca shell light/dark, Google onboarding light/dark, Runner
    enrollment, Knowledge v2.
- Command: `npm --workspace apps/desktop run test`
  - Result: PASS, 261/261.
- Command: `git diff --check`
  - Result: PASS.
- Manual QA:
  - Calendar, onboarding, Runner, Wiki, Settings를 실제 Electron 화면에서 확인했다.
  - 768px onboarding에서도 수평 잘림이나 겹침이 없었다.
  - 증거: `docs/operations/evidence/2026-07-25-orca-actual-ui-deslop.md`

## Remaining Risks

- 전역 `styles.css`에는 과거 화면용 규칙이 많이 남아 있다. 이번에는 기존 동작을
  보존하기 위해 최종 시각 레이어로 격리하고, 전체 CSS 모듈 분리는 별도 구조 작업으로
  남긴다.
- Vite renderer chunk 598.66kB가 500kB 경고 기준을 넘는다. 빌드는 성공했으며
  이번 CSS 변경과 무관하지만 후속 번들 분리가 필요하다.
