# Plan: Retire legacy Workboard conversion

- Date: 2026-07-25
- Owner: Codex
- Work size: Boundary
- Status: Complete

## Goal

호출자가 없는 `POST /api/workboard/convert`를 Desktop 지원 계약에서 제거한다. 메모를 곧바로
Task 또는 실행으로 만드는 구형 흐름 대신, Workspace-scoped
`POST /api/agent-operations/work`를 통해 위임 작업을 만들고 계획·승인·실행하는 현재 제품
계약을 사용한다.

## Non-Goals

- Workboard 페이지 읽기 또는 legacy 데이터를 이번 단계에서 삭제하지 않는다.
- Agent Work 계획·승인 UX를 다시 설계하지 않는다.
- 서버 tombstone을 production traffic 증거 없이 물리적으로 삭제하지 않는다.
- Mail connector 또는 Mobile 개발을 시작하지 않는다.

## Touched Boundaries

- Backend gateway: production-disabled tombstone 유지
- Backend library: route lifecycle removal policy
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 기존 Agent Work 흐름 검증만 수행
- Desktop API: dormant conversion method 제거
- Tests: Desktop source contract, lifecycle audit, Agent Work Playwright
- Docs: Phase 10 roadmap and evidence

## Success Criteria

- [x] Desktop API에서 `convertWorkboard`와 `/api/workboard/convert`가 사라진다.
- [x] 서버 tombstone은 `production_disabled` 상태로 남는다.
- [x] removal-candidate가 `/api/agent-operations/work` 대체 경로와 2026-10-31 날짜를 가진다.
- [x] supported-client-disabled가 4개에서 Mail 3개로 줄어든다.
- [x] route lifecycle 157/157 분류를 유지한다.
- [x] 실제 Agent Work 화면에서 위임→계획→승인→실행이 통과한다.

## Edge Cases

- 구버전 Desktop 요청은 계속 403으로 차단한다.
- 제거 날짜가 지나도 28일 zero-traffic 증거가 없으면 tombstone을 삭제하지 않는다.
- Dormant 메서드가 다시 추가되면 Desktop source contract가 실패한다.

## Test Plan

- RED:
  - [x] Desktop API에 Workboard conversion이 없어야 한다는 계약을 먼저 실패시킨다.
  - [x] lifecycle blocker 3개와 removal-candidate 기대를 먼저 실패시킨다.
- GREEN:
  - [x] Desktop method와 supported inventory 항목을 제거한다.
  - [x] Agent Work replacement가 있는 removal policy를 추가한다.
- REFACTOR:
  - [x] 운영 문서에서 구형 direct conversion과 현재 review flow의 차이를 기록한다.

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

## Implementation Checklist

- [x] Step 1: caller audit and failing contracts
- [x] Step 2: dormant Desktop API and supported inventory removal
- [x] Step 3: dated server removal policy
- [x] Step 4: lifecycle/roadmap/evidence update
- [x] Step 5: canonical Agent Work workflow and full regression

## Rollback / Fallback

- 구버전 호출은 서버 tombstone이 차단한다.
- 사용자는 Agent Work에서 자연어로 위임 작업을 만들 수 있다.
- 단순 개인 할 일은 `/api/tasks`를 계속 사용한다.

## Verification Notes

- focused Desktop contract: 39 passed.
- focused route lifecycle contract: 9 passed.
- route audit: 157/157 classified, supported-client-disabled 3, removal-candidate 9.
- full suite: Backend 458, Desktop 260, Runner 23 passed.
- authenticated Playwright: Agent Work creation, plan, activation, per-task execution, pause,
  resume, and cancellation passed with no Workboard conversion call.
- the first concurrent Backend/Desktop gate saw one file-level PostgreSQL security test process
  fail without an assertion; that file passed all 10 cases alone and the final full suite passed.
- existing Vite chunk-size and Desktop test WebSocket port warnings remain non-blocking.

## Remaining Risks

- production traffic evidence가 없으므로 서버 tombstone 삭제는 보류한다.
