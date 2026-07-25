# Plan: Retire dormant Desktop calendar draft route

- Date: 2026-07-25
- Owner: Codex
- Work size: Boundary
- Status: Complete

## Goal

현재 UI에서 호출하지 않는 `/api/calendar/draft` 메서드를 Desktop 지원 계약에서 제거한다. 서버 경로는 즉시 삭제하지 않고 production-disabled 상태와 명시적 제거 날짜·대체 경로를 유지해, 실사용 0건 증거가 충족된 뒤에만 제거할 수 있게 한다.

## Non-Goals

- 이미 검증된 `Calendar AI/일정 인식 → 검토 초안 → Calendar API 확정` 흐름을 다시 구현하지 않는다.
- 서버 경로를 이번 단계에서 물리적으로 삭제하지 않는다.
- Calendar AI action draft 또는 일정 추출 모델을 변경하지 않는다.
- Mobile 개발을 시작하지 않는다.

## Touched Boundaries

- Backend gateway: production route registry는 차단 상태 유지
- Backend library: route lifecycle removal policy
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 없음
- Desktop API: dormant method와 supported inventory 제거
- Tests: Desktop source contract, route lifecycle
- Docs: Phase 10 roadmap와 lifecycle evidence

## Success Criteria

- [x] Desktop API에서 `draftCalendarWork`와 `/api/calendar/draft`가 사라진다.
- [x] 현재 제품의 일정 초안·확정 흐름은 그대로 통과한다.
- [x] 서버 경로는 production-disabled 상태로 유지되어 legacy fallback으로 빠지지 않는다.
- [x] 경로는 대체 경로와 제거 날짜가 있는 removal-candidate로 분류된다.
- [x] supported-client-disabled 수가 6에서 5로 줄어든다.
- [x] route lifecycle 전체 157개가 계속 분류된다.

## Edge Cases

- 구버전 Desktop이 경로를 호출하면: 기존처럼 production-disabled 403을 받는다.
- 제거 날짜가 지나도 28일 0-traffic 증거가 없으면: 삭제가 허용되지 않는다.
- 새 UI가 실수로 경로를 다시 추가하면: Desktop source 계약이 실패한다.

## Test Plan

- RED:
  - [x] Desktop API에 구형 메서드가 없어야 한다는 계약을 먼저 실패시킨다.
  - [x] lifecycle blocker 5개와 calendar draft removal-candidate 기대를 먼저 실패시킨다.
- GREEN:
  - [x] API 메서드와 Desktop supported inventory 항목을 제거한다.
  - [x] explicit removal policy를 추가한다.
- REFACTOR:
  - [x] 현재 일정 검토 흐름을 가리키는 대체 경로와 제거 사유를 문서에 한 번만 정의한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `node apps/desktop/tests/playwright-wiring.cjs`

## Implementation Checklist

- [x] Step 1: failing Desktop/lifecycle 계약 작성
- [x] Step 2: dormant Desktop API와 supported inventory 제거
- [x] Step 3: server removal policy 추가
- [x] Step 4: lifecycle/roadmap/evidence 수치 갱신
- [x] Step 5: 실제 일정 검토 흐름과 전체 회귀 검증

## Rollback / Fallback

- 구버전 Desktop 호출은 서버의 production-disabled tombstone이 계속 차단한다.
- 실제 지원 호출자가 발견되면 메서드를 되살리는 대신 현재 review-only ingest 또는 Calendar AI action 계약으로 마이그레이션한다.

## Verification Notes

- focused Desktop contract: 4 passed.
- focused route lifecycle contract: 7 passed.
- route audit: 157/157 classified, supported-client-disabled 5, removal-candidate 7.
- full suite: Backend 455, Desktop 259, Runner 23 passed.
- Playwright: attachment → review draft → explicit Calendar create → Calendar visibility passed.
- build retained the pre-existing Vite chunk-size warning only.

## Remaining Risks

- 실제 production traffic evidence가 아직 없으므로 서버 경로 삭제는 보류한다.
