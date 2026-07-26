# Plan: Phase 10 production observability and readiness

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified slice; external collector and live-production readiness remain Phase 10 gates
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`

## Goal

프로덕션 Gateway가 단순 프로세스 생존과 실제 서비스 준비 상태를 구분한다. 모든 요청은
tenant 정보를 노출하지 않는 상관 ID와 집계 지표를 남기고, 운영자만 인증된 상태·SLO
스냅샷을 읽을 수 있어 장애 중인 서비스를 정상으로 표시하지 않는다.

## Non-Goals

- 이번 슬라이스에서 외부 APM, PagerDuty, Grafana 계정을 생성하지 않는다.
- 사용자·Workspace·Runner ID를 metrics label이나 요청 로그에 넣지 않는다.
- DB backup/PITR, beta load test, incident dashboard 전체를 한 번에 구현하지 않는다.
- live WorkOS, Mac mini, Google credential을 대신 발급하거나 준비됐다고 가정하지 않는다.

## Touched Boundaries

- Backend gateway: 요청 계측, request ID 응답, readiness/operations routes
- Backend library: redaction-safe monitor, readiness probe, operator authentication
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 없음
- Tests: observability unit/route/real-server contracts
- Docs: 운영 runbook, Phase 10 evidence, roadmap progress

## Success Criteria

- [x] `/api/health`는 프로세스 생존만 답하고 DB/인증 준비 완료를 주장하지 않는다.
- [x] `/api/ready`는 production auth, DB, product runtime, AuthKit, operations token, 안전한
      request logging이 모두 준비됐을 때만 200을 반환한다.
- [x] `/api/operations/status`는 별도의 constant-time bearer 인증 뒤에만 component 상태,
      request counters, latency, availability SLO를 반환한다.
- [x] 응답의 `x-request-id`는 opaque UUID/hex caller ID만 보존하고 나머지는 새 ID로 교체한다.
- [x] 집계·로그에는 URL resource ID, Workspace ID, 사용자 ID, bearer, cookie, body가 없다.
- [x] status class, route template, active request, p95 latency, availability와 SLO 판정이
      restart 시점부터 집계된다.
- [x] 실제 HTTP 서버에서 ready fail/pass, operations 401/200, redacted log를 관찰한다.

## Edge Cases

- DB query timeout/failure: public readiness는 503이며 raw DB 오류는 반환하지 않는다.
- AuthKit 또는 operations token 미설정: liveness는 200, readiness는 503이다.
- 잘못된/누락된 operations bearer: 동일한 safe 401/503 계약으로 닫힌다.
- 동적 resource path: route template으로만 집계해 ID가 metric label에 남지 않는다.
- 응답이 두 번 종료되거나 connection error가 발생해도 한 요청을 두 번 집계하지 않는다.
- 표본이 적을 때 SLO는 성공으로 단정하지 않고 `insufficient_data`다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] readiness, token auth, request-ID, route-template redaction 테스트가 모듈 부재로 실패한다.
  - [x] registry에 ready/operations routes가 없어 계약 테스트가 실패한다.
- GREEN:
  - [x] redaction-safe in-memory monitor와 readiness probe를 구현한다.
  - [x] production dispatcher와 실제 Gateway request lifecycle에 연결한다.
- REFACTOR:
  - [x] readiness/metrics 계산을 Gateway 대형 파일 밖에 유지한다.

## Acceptance Gates

- [x] Phase 10 narrow tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`
- [x] real HTTP manual QA with redacted evidence
- [x] `git diff --check`

건너뛴 gate:

- External alert delivery:
  - Reason: PagerDuty/Grafana/Railway notification destination은 외부 운영자 선택과 credential이
    필요하다. 이 슬라이스는 machine-readable SLO/ready source와 runbook을 제공한다.
- Live production readiness pass:
  - Reason: live WorkOS와 운영 bearer는 외부 gate다. fixture server에서 pass를 증명하고,
    실제 환경은 누락 시 fail closed해야 한다.

## Implementation Checklist

- [x] Step 1: monitor/readiness/token contract RED
- [x] Step 2: production observability module GREEN
- [x] Step 3: route registry/dispatcher/server lifecycle integration
- [x] Step 4: narrow/full gates and real HTTP QA
- [x] Step 5: operations runbook, evidence, roadmap update

## Rollback

- 새 ready/operations route와 request lifecycle hook만 이전 Gateway build로 되돌린다.
- `/api/health` liveness 계약은 유지되어 플랫폼이 rollback 중 프로세스를 재시작할 수 있다.
- monitor는 메모리 집계만 사용하므로 rollback에 DB migration이나 tenant data 복구가 없다.

## Verification Notes

- RED: `node --test tests/phase10-production-observability.test.cjs`
  - Result: expected `MODULE_NOT_FOUND` before implementation.
- Narrow: same command after implementation
  - Result: 5/5 passed.
- `npm run backend:check`
  - Result: passed, including `production-observability.js`.
- `npm run test:backend`
  - Result: 415/415 passed.
- `npm test`
  - Result: Backend 415/415, Desktop 243/243, Runner 19/19 passed.
- Manual HTTP QA:
  - Result: liveness 200/`alive`; truthful readiness 503/`not_ready` without DB/AuthKit;
    operations 401 without bearer and 200 with bearer; no secret or tenant value in status/logs.
- Evidence:
  - `docs/operations/evidence/2026-07-25-phase10-production-observability.json`

## Remaining Risks

- bounded single-run alert collector는
  `docs/plans/2026-07-25-phase10-operations-alert-collector.md`에서 구현·검증됐다.
- collector의 외부 scheduler 배포, long-term metrics retention, dashboard와 실제 on-call
  alert delivery는 아직 연결되지 않는다.
- in-memory window는 프로세스 재시작 시 초기화된다. 외부 collector가 장기 보존을 소유해야 한다.
- production environment가 `/api/ready=200`인 것은 live WorkOS/DB/운영 secret 설정 후 별도
  증명해야 한다.
