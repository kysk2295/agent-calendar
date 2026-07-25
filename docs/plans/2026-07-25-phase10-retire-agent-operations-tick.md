# Plan: Retire Desktop-wide Agent Operations tick

- Date: 2026-07-25
- Owner: Codex
- Work size: Boundary
- Status: Complete

## Goal

UI 호출자가 없는 `POST /api/agent-operations/tick`을 Desktop 지원 계약에서 제거한다.
프로덕션 실행 소유권은 Workspace-scoped 서버 스케줄러에 두고, 사용자의 즉시 실행은 이미
지원되는 개별 `POST /api/agent-operations/tasks/:id/run-now` 흐름만 사용한다.

## Non-Goals

- 서버 스케줄러의 주기나 실행 알고리즘을 변경하지 않는다.
- 개별 `지금 실행` UX를 다시 설계하지 않는다.
- 서버 tombstone을 실사용 0건 증거 없이 삭제하지 않는다.
- Mail connector 또는 Mobile 구현을 시작하지 않는다.

## Work Size

Boundary. Desktop API와 지원 경로 inventory, 서버 route lifecycle 의미가 함께 바뀐다.

## Touched Boundaries

- Desktop API: dormant global tick method
- Backend registry: Desktop supported inventory
- Backend lifecycle: dated removal candidate
- Tests: Desktop source contract, lifecycle audit, Agent Work Playwright
- Docs: Phase 10 roadmap and evidence

## Success Criteria

- [x] Desktop에서 `tickAgentOperations`와 `/api/agent-operations/tick`이 사라진다.
- [x] 서버 tombstone은 `production_disabled` 상태를 유지한다.
- [x] 제거 후보는 개별 `run-now` 대체 경로와 2026-10-31 제거 날짜를 가진다.
- [x] supported-client-disabled는 5개에서 4개로 줄어든다.
- [x] route lifecycle 157/157 분류를 유지한다.
- [x] 실제 Agent Work 화면에서 `지금 실행`이 개별 작업 경로를 호출한다.

## Edge Cases

- 구버전 Desktop의 전역 tick 요청은 계속 403으로 차단한다.
- 제거 날짜가 지나도 28일 연속 zero-traffic 증거가 없으면 tombstone을 삭제하지 않는다.
- 전역 tick이 Desktop API에 다시 추가되면 source contract가 실패한다.

## Test Plan

- RED:
  - [x] Desktop API에 global tick이 없어야 한다는 계약을 먼저 실패시킨다.
  - [x] lifecycle blocker 4개와 removal-candidate 기대를 먼저 실패시킨다.
- GREEN:
  - [x] dormant Desktop method와 supported inventory 항목을 제거한다.
  - [x] 명시적 removal policy를 추가한다.
- REFACTOR:
  - [x] 서버 스케줄러와 개별 run-now의 책임을 운영 문서에 기록한다.

## Acceptance Gates

- [x] focused Desktop contract
- [x] focused route lifecycle contract
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `node apps/desktop/tests/playwright-agent-operations-mission.cjs`

## Step-by-Step Checklist

- [x] Step 1: caller audit and failing contracts
- [x] Step 2: Desktop API and supported inventory retirement
- [x] Step 3: server removal policy
- [x] Step 4: lifecycle and roadmap evidence update
- [x] Step 5: individual run-now UI and full regression verification

## Rollback / Fallback

- 구버전 요청은 서버의 production-disabled tombstone이 계속 차단한다.
- 사용자 즉시 실행은 이미 지원되는 개별 작업 `run-now`를 사용한다.
- 자동 실행은 `AGENT_OPERATIONS_DAEMON_ENABLED`로 시작되는 서버 스케줄러가 소유한다.

## Remaining Risks

- 실제 production traffic evidence가 없으므로 서버 경로 삭제는 보류한다.

## Verification Notes

- focused Desktop contract: 38 passed.
- focused route lifecycle contract: 8 passed.
- route audit: 157/157 classified, supported-client-disabled 4, removal-candidate 8.
- full suite: Backend 456, Desktop 259, Runner 23 passed.
- authenticated Playwright: mission plan, activation, individual `지금 실행`, pause, and
  cancellation flow passed with no global tick request.
- the existing Vite chunk-size and Desktop test WebSocket port warnings remain non-blocking.
