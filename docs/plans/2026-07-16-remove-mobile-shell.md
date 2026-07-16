# Plan: 데스크톱 전용 앱 셸 복원

- Date: 2026-07-16
- Owner: Codex
- Work size: Large
- Status: Verified

## Goal

Agent Calendar 데스크톱 앱에서 모바일 전용 하단 내비게이션과 전역 모바일 셸 전환을 제거한다. 창 확대 상태에서도 기본 사이드바와 데스크톱 작업 영역이 유지되어야 한다.

## Non-Goals

- 백엔드, DB, 인증, Railway 계약은 변경하지 않는다.
- 에이전트 작업 화면 내부의 200% 확대 접근성 리플로우는 제거하지 않는다.
- 기존 데스크톱 디자인 토큰이나 화면 기능을 재설계하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 메인 창 로드 시 저장된 Chromium 확대 배율을 100%로 초기화
- React UI: 모바일 내비게이션과 전역 모바일 셸 제거
- Tests: 데스크톱 전용 셸 계약 및 실제 브라우저 회귀 검증
- Docs: 데스크톱 전용 지원 범위 기록

## Success Criteria

- [x] 앱 셸에 모바일 하단 내비게이션이 렌더링되지 않는다.
- [x] 760px 이하 CSS 뷰포트에서도 기본 사이드바가 숨겨지지 않는다.
- [x] 데스크톱 타입체크, 테스트, 빌드가 통과한다.
- [x] 실제 Electron 창에서 데스크톱 셸이 보인다.
- [x] 앱 재실행 후 저장된 확대 배율이 100%로 복원된다.

## Edge Cases

- 확대/축소: 확대 때문에 CSS 뷰포트가 좁아져도 모바일 셸로 전환하지 않는다.
- 저장된 확대값: Chromium이 개발 주소에 보존한 확대값은 새 메인 창 로드 완료 시 기본값으로 복원한다.
- 위젯 오버레이: 별도 오버레이 쿼리와 스타일은 유지한다.
- 에이전트 작업 화면: 대화 우선 리플로우와 200% 확대 접근성 계약은 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 모바일 셸 import와 렌더링이 남아 있으면 실패하는 데스크톱 셸 계약 테스트
  - [x] 좁은 CSS 뷰포트에서 모바일 내비게이션이 보이거나 사이드바가 숨으면 실패하는 Playwright 시나리오
- GREEN:
  - [x] 모바일 전용 컴포넌트, 스타일 import, 전역 760px 셸 규칙을 제거한다.
- REFACTOR:
  - [x] 제거 후 남은 사용되지 않는 계산과 import만 정리한다.

## Rollback / Fallback Story

- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm --workspace apps/desktop run build:electron`
- [x] `node apps/desktop/tests/playwright-desktop-shell-layout.cjs`

건너뛴 gate:

- Gate: 백엔드 검사와 테스트
  - Reason: 백엔드 코드를 변경하지 않는다.
- Gate: 전체 `npm test`
  - Reason: 데스크톱 패키지 전체 테스트와 빌드가 더 직접적인 경계 검증이다.

## Acceptance Gates

- [x] 앱을 실제 Electron 개발 모드로 재실행한다.
- [x] 사이드바와 데스크톱 콘텐츠가 표시되고 모바일 하단 내비게이션이 없는지 확인한다.
- [x] 실패 시 모바일 파일 제거 커밋을 되돌리면 기존 동작으로 복구할 수 있다.

## Implementation Checklist

- [x] Step 1: RED 계약 및 Playwright 테스트를 추가한다.
- [x] Step 2: 모바일 내비게이션과 전역 모바일 스타일을 제거한다.
- [x] Step 3: 모바일 전용 테스트를 데스크톱 셸 테스트로 교체한다.
- [x] Step 4: 검증 결과와 남은 위험을 기록한다.
- [x] Step 5: Electron 로드 시 확대 배율 초기화를 잠근다.

## Verification Notes

- Command: `node --test apps/desktop/tests/desktop-shell-contract.test.mjs`
  - Result: 2/2 통과. 모바일 셸 제거와 Electron 로드 완료 시 배율 1 복원 계약을 검증했다.
- Command: `npm run typecheck`
  - Result: 통과.
- Command: `npm --workspace apps/desktop run test`
  - Result: 137/137 통과.
- Command: `npm run build:desktop`
  - Result: renderer 및 Electron 빌드 통과.
- Command: `node apps/desktop/tests/playwright-desktop-shell-layout.cjs`
  - Result: 640x824 CSS 뷰포트에서도 데스크톱 셸과 7열 달력이 유지됨을 확인했다.
- Manual QA: Electron 개발 앱을 완전히 재시작한 뒤 1320x824 창에서 사이드바, 7개 요일 열, 모바일 내비게이션 부재와 정상 배율을 확인했다.

## Remaining Risks

- Risk: 매우 좁은 브라우저 미리보기는 가로 공간이 부족할 수 있다.
  - Mitigation: 네이티브 Electron 창은 `minWidth: 980`을 유지하며, 모바일 브라우저는 지원 대상에서 제외한다.
