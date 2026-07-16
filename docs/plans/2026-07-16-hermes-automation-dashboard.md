# Plan: Hermes 자동화 관리 대시보드

- Date: 2026-07-16
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

사이드바의 에이전트 항목 바로 아래에 `Hermes 자동화` 탭을 추가한다. 이 화면에서 연결된 자동화를 조회하고, 활성·일시정지 전환, 이름·목표·담당 프로필·실행 일정 수정, 삭제를 수행할 수 있게 한다.

## Non-Goals

- 새 자동화 생성 흐름은 이번 범위에 포함하지 않는다.
- Hermes cron 런타임이나 Railway 게이트웨이의 기존 스케줄러 계약은 변경하지 않는다.
- 자동화를 에이전트 Work Conversation으로 변환하지 않는다.

## Touched Boundaries

- Backend gateway: 기존 `PATCH /api/scheduler/jobs/:id`, `DELETE /api/scheduler/jobs/:id` 계약을 그대로 사용하며 제품 코드는 변경하지 않는다.
- Backend library: 변경 없음.
- DB/migrations: 변경 없음.
- Electron bridge: 변경 없음.
- React UI: 사이드바 탭, 자동화 목록·상세 편집·상태 전환·삭제 화면, mutation 후 목록 재조회.
- Tests: Hermes API 메서드 계약, Playwright 관리 흐름, 기존 데스크톱 회귀 테스트.
- Docs: DESIGN.md 관리 화면 계약과 이 계획의 검증 결과.

## Success Criteria

- [x] 사이드바에서 `에이전트` 바로 아래의 `Hermes 자동화` 탭으로 이동할 수 있다.
- [x] 자동화 목록에서 활성 상태와 실행 일정, 담당 프로필을 확인할 수 있다.
- [x] 활성 자동화를 일시정지하고 일시정지 자동화를 다시 활성화할 수 있다.
- [x] 이름, 목표, 담당 프로필, 실행 일정을 수정하고 저장할 수 있다.
- [x] 삭제 전 명시적 확인을 거쳐 자동화를 삭제할 수 있다.
- [x] mutation 실패 시 기존 목록과 편집값을 보존하고 오류를 표시한다.

## Edge Cases

- 자동화가 없음: 빈 상태에서 다른 화면으로 돌아갈 수 있고 잘못된 상세 패널을 표시하지 않는다.
- 선택 자동화가 삭제됨: 남은 첫 자동화를 선택하거나 빈 상태로 전환한다.
- Hermes 상태가 `unknown`: 상태 전환 버튼을 제공하지 않고 새로고침으로 확인하게 한다.
- 긴 이름·일정·목표: 목록은 이름을 줄임표 처리하고 상세 화면은 자연스럽게 줄바꿈한다.
- 원격 mutation 실패: 낙관적 삭제나 상태 변경을 하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] API 클라이언트가 scheduler PATCH/DELETE 요청을 올바른 경로와 body로 보내지 못하면 실패한다.
  - [x] Playwright에서 별도 탭, 편집 저장, 일시정지·재활성화, 삭제 확인 흐름이 없으면 실패한다.
- GREEN:
  - [x] 기존 게이트웨이 계약을 호출하는 최소 API 메서드와 별도 대시보드를 연결한다.
- REFACTOR:
  - [x] 사용되지 않던 자동화 뷰를 독립 컴포넌트로 대체하고 중복 코드를 남기지 않는다.

## Acceptance Gates

- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `node apps/desktop/tests/playwright-hermes-automation-dashboard.cjs`
- [x] 실제 Electron 화면 및 375/768/980/1280 Playwright 시각 QA

건너뛴 gate:

- Gate: backend syntax/tests 단독 실행
  - Reason: 백엔드 제품 코드를 변경하지 않으며 최종 `npm test`에서 백엔드 전체 회귀를 실행한다.

## Implementation Checklist

- [x] Step 1: API와 사용자 흐름을 RED 테스트로 고정한다.
- [x] Step 2: 사이드바 탭과 자동화 관리 대시보드를 구현한다.
- [x] Step 3: mutation 후 원격 목록 재조회와 실패 상태를 연결한다.
- [x] Step 4: 타입·테스트·빌드와 실제 앱 상호작용을 검증한다.
- [x] Step 5: 독립 시각 QA를 통과하고 결과·위험을 기록한다.

## Verification Notes

- RED: `node --test apps/desktop/tests/hermes-automation-api.test.mjs`
  - Result: `updateSchedulerJob is not a function`으로 기대한 실패를 확인했다.
- RED: `node apps/desktop/tests/playwright-hermes-automation-dashboard.cjs`
  - Result: 사이드바의 `Hermes 자동화` 탭을 찾지 못해 기대한 실패를 확인했다.
- GREEN: `node --test apps/desktop/tests/hermes-automation-api.test.mjs`
  - Result: 1/1 통과. 인코딩된 job 리소스의 PATCH/DELETE 경로와 body를 검증했다.
- GREEN: `node apps/desktop/tests/playwright-hermes-automation-dashboard.cjs`
  - Result: 편집, 일시정지, 재활성화, 삭제 확인, 실패 시 draft 보존을 모두 통과했다.
- Regression: `npm run typecheck`, `npm --workspace apps/desktop run test`, `npm run build:desktop`, `npm test`
  - Result: 모두 통과. 데스크톱 단위 테스트는 138/138 통과했다.
- Manual QA: 실제 Electron 앱
  - Result: 원격 Hermes 자동화 26개를 조회하고 탭·목록·상세 폼·상태·삭제 진입점이 표시되는 것을 확인했다. 실제 자동화 mutation은 수행하지 않았다.
- Visual QA: 375/768/980/1280 고정 데이터 캡처와 독립 검수 2건
  - Result: 실제 지원 최소 폭 980과 1280에서 클리핑 없이 통과했다. Electron은 `minWidth: 980`이므로 375/768은 모바일 셸이 다시 나타나지 않는 진단 캡처로만 사용했다.

## Remaining Risks

- Risk: Hermes CLI cron 구현이 허용하는 schedule 문자열 문법은 런타임 버전에 따라 달라질 수 있다.
  - Mitigation: 자유 입력을 그대로 기존 게이트웨이의 `buildHermesCronUpdateBody` 계약에 전달하고 원격 오류를 편집 화면에 보존해 표시한다.
