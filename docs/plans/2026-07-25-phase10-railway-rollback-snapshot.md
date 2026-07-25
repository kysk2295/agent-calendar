# Plan: Phase 10 Railway rollback snapshot

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified local/API-contract slice; live token observation remains external
- Parent: `docs/plans/2026-07-25-phase10-gateway-runner-release-rollback.md`

## Goal

Railway CLI가 누락하는 `canRollback`을 공식 Public API에서 고정 production
project/environment/service 범위로 읽어, release preflight와 rollback이 소비할 수 있는
redaction-safe deployment snapshot을 만든다.

## Non-Goals

- Railway deployment, redeploy, rollback, environment를 변경하지 않는다.
- 토큰을 파일, stdout, 오류, 증거 문서에 기록하지 않는다.
- 다른 Railway project/environment/service를 동적으로 조회하는 범용 도구를 만들지 않는다.
- staging 생성이나 production promotion을 수행하지 않는다.

## Touched Boundaries

- Backend library: Railway GraphQL authentication and deployment snapshot
- Release CLI: read-only `snapshot-deployments` command
- Rollback mutation: Account/Project token header parity
- Tests: exact query/header/redaction/fail-closed contract
- Docs: release runbook and evidence
- DB/migrations: unchanged
- Electron/React/Runner: unchanged

## Success Criteria

- [x] Account token은 `Authorization: Bearer`, Project Token은 `Project-Access-Token`만 사용한다.
- [x] 토큰이 없거나 둘 다 있으면 network call 전에 실패한다.
- [x] GraphQL query는 고정 production project/environment/service와 최대 20개 deployment만
      요청하고 `canRollback`을 포함한다.
- [x] 출력은 deployment ID, status, createdAt, `canRollback`, source repo, full commit SHA만
      포함하며 raw metadata/token/error를 반사하지 않는다.
- [x] 누락된 `canRollback`, 잘못된 repo/commit/status/time, GraphQL error/invalid JSON은
      전체 snapshot을 fail closed 한다.
- [x] snapshot 출력이 기존 preflight와 exact rollback target validator에서 그대로 동작한다.

## Edge Cases

- Railway CLI login은 있지만 API token 환경변수는 없음:
  - CLI가 명시적으로 token missing을 반환하며 CLI credential store를 읽지 않는다.
- Project Token과 Account Token이 동시에 주입됨:
  - 어떤 권한을 사용했는지 모호하므로 요청하지 않고 거부한다.
- 한 deployment라도 `canRollback` 필드가 누락됨:
  - false로 추정하지 않고 전체 snapshot을 거부한다.
- GraphQL response가 200이지만 `errors`가 있음:
  - bounded public error로 실패하고 upstream message를 출력하지 않는다.
- metadata에 secret-shaped 추가 필드가 있음:
  - allowlist projection에서 제거한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] exact GraphQL query/header와 bounded snapshot contract
  - [x] missing/ambiguous token, malformed node, GraphQL failure contract
  - [x] preflight/rollback consumer integration
- GREEN:
  - [x] injected fetch snapshot helper와 CLI command
  - [x] rollback mutation token header parity
- REFACTOR:
  - [x] 인증 header 생성과 response projection을 한 경계에 유지한다.

## Acceptance Gates

- [x] focused release rollback tests
- [x] CLI missing-token manual QA
- [ ] actual Public API read-only snapshot when an explicit token is available
- [x] `npm run backend:check`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- Live snapshot:
  - Account/Project API token이 환경에 없으면 fixture proof와 missing-token fail-closed만
    완료하고 외부 credential store를 읽지 않는다.
- Production rollback:
  - destructive external mutation이므로 실행하지 않는다.

## Implementation Checklist

- [x] Step 1: RED Public API snapshot contract
- [x] Step 2: snapshot helper and CLI GREEN
- [x] Step 3: preflight/rollback integration and manual QA
- [x] Step 4: regression, runbook, evidence

## Rollback

새 read-only CLI command와 helper를 제거하면 기존 수동 deployment JSON 절차로 복귀한다.
Railway state는 변경되지 않는다.

## Verification Notes

- `node --test apps/backend/tests/phase10-release-rollback.test.cjs`
  - 15/15 passed.
- `env -u RAILWAY_API_TOKEN -u RAILWAY_PROJECT_TOKEN
  node scripts/railway-release-gate.cjs snapshot-deployments`
  - exited 1 before network I/O with bounded exact-one-token error.
- token presence audit
  - Account Token false, Project Token false; live GraphQL request skipped.
- `npm run backend:check`
  - passed.
- `npm test`
  - Backend, Desktop 262/262, Runner 29/29 passed.
- `git diff --check`
  - passed.

## Remaining Risks

- 실제 Railway API token으로 현재 retained rollback window를 관찰해야 한다.
- isolated staging과 reviewed release commit이 준비되기 전에는 production promotion이
  계속 차단된다.
