# Plan: Phase 10 operations alert collector

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified locally; external deployment gate remains open
- Parent: `docs/plans/2026-07-25-phase10-production-observability.md`

## Goal

별도 운영 프로세스가 production Gateway의 public readiness와 protected operations
snapshot을 1회 수집하고, 연속 실패·SLO·오류율·지연·admission 압력 규칙을 이전 상태와
비교해 민감정보 없는 alert transition JSON으로 만든다. 스케줄러와 외부 alert
destination은 이 단일 실행 명령을 분당 호출하고 출력/종료 코드를 소비할 수 있다.

## Non-Goals

- PagerDuty, Grafana, Slack 또는 Railway 계정을 생성하거나 외부 메시지를 전송하지 않는다.
- Gateway의 in-memory metrics를 장기 시계열 데이터베이스로 대체하지 않는다.
- 사용자, Workspace, Runner, URL, operations token, response body를 collector 상태나
  출력에 저장하지 않는다.
- production 또는 staging deployment를 변경하지 않는다.

## Touched Boundaries

- Backend library: bounded operations probe, alert-window evaluator, collector state contract
- Backend tools: single-run operations collector CLI
- Backend gateway: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge / React UI / Runner: 변경 없음
- Tests: pure alert rules, state safety, real local Gateway collection, CLI contract
- Docs: observability runbook, evidence, roadmap

## Success Criteria

- [x] operator CLI는 HTTPS root origin, 32–512자 operations token, 명시적 state path를
      요구한다.
- [x] collector는 redirect 없이 `/api/ready`와 `/api/operations/status`만 조회하고
      response를 64KiB로 제한한다.
- [x] readiness, SLO, 5xx ratio, p95 latency, collector auth, capacity rejection, rate-limit
      rejection 규칙이 문서의 연속 window 기준을 정확히 적용한다.
- [x] cumulative counter restart/decrease는 음수 delta나 거짓 해결/경보를 만들지 않는다.
- [x] state는 bounded schema만 0600 atomic file로 저장하며 corrupt/oversized state는
      조용히 초기화하지 않고 실패한다.
- [x] stdout에는 시각, bounded aggregate, active alerts, raised/resolved transition만 있고
      URL, token, raw body, tenant identifier가 없다.
- [x] active P1이 있으면 process exit 2, 그 외에는 0이다.
- [x] 실제 local production-mode Gateway에서 healthy window와 연속 failure transition을
      관찰한다.

## Edge Cases

- network error 또는 timeout:
  - bounded `gateway_unreachable` condition으로 계산하고 raw error를 반사하지 않는다.
- operations endpoint 401/403/503:
  - component body를 신뢰하지 않고 `collector_auth` P1 condition으로 계산한다.
- Gateway process restart:
  - cumulative counters의 reset을 인식하고 현재 window를 새 baseline으로 사용한다.
- 첫 window:
  - delta 기반 5xx/admission 규칙은 baseline만 저장하고 경보하지 않는다.
- state path가 symlink이거나 owner-only가 아님:
  - secret은 없지만 tampering 방지를 위해 fail closed한다.
- state 또는 response가 oversized/non-JSON:
  - bounded collector 오류로 중단한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] alert threshold/transition/reset pure contract
  - [x] exact probe paths, auth, response bound, redaction
  - [x] missing/corrupt/oversized/symlink state contract
  - [x] CLI required argument and exit-code contract
- GREEN:
  - [x] operations alert collector library
  - [x] single-run CLI
  - [x] real local Gateway integration
- REFACTOR:
  - [x] rule vocabulary and persisted state stay bounded/versioned

## Acceptance Gates

- [x] focused collector tests
- [x] real local Gateway manual QA
- [x] `npm run backend:check`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- Live external alert delivery:
  - Reason: destination account, routing policy, and credential require an operator decision.
    This slice produces the deployable single-run collector and machine-readable transitions.
- Live production collection:
  - Reason: operations token is intentionally unavailable in the current process environment.

## Implementation Checklist

- [x] Step 1: plan and RED contracts
- [x] Step 2: evaluator, probe, and state GREEN
- [x] Step 3: CLI and real local Gateway QA
- [x] Step 4: regression, runbook, evidence

## Rollback

collector library/tool과 scheduler 호출만 제거한다. Gateway route, DB, user session, Runner
state를 변경하지 않으므로 product rollback이나 data migration은 없다.

## Verification Notes

- RED: focused collector test failed with `MODULE_NOT_FOUND`.
- `node --test apps/backend/tests/phase10-production-observability.test.cjs
  apps/backend/tests/phase10-operations-alert-collector.test.cjs`
  - 14/14 passed.
- Real local production-mode Gateway:
  - healthy readiness/operations window produced no alert and exit 0;
  - two consecutive truthful not-ready windows raised `deployment_readiness` P1 and exit 2.
- Current production CLI without injected operations token:
  - exited 1 with `operations collector token is invalid`;
  - made no authenticated request and created no state file.
- `npm run backend:check`
  - passed, including the collector library and CLI.
- `npm test`
  - root suite exited 0; Desktop 262/262 and Runner 29/29 passed.
  - repeated Desktop HMR WebSocket port warnings were non-fatal.
- `git diff --check`
  - passed for tracked changes and the new collector files.

## Remaining Risks

- 실제 long-term metrics retention, alert destination delivery, on-call routing은 collector를
  별도 서비스/스케줄러에 배포한 뒤에만 관찰할 수 있다.
