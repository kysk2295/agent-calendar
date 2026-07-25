# Plan: Phase 10 staging database isolation evidence

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete
- Parent: `docs/plans/2026-07-25-phase10-evidence-bound-release-gate.md`

## Goal

Railway production 승격 전에 staging이 production PostgreSQL endpoint를 재사용하지
않음을 실제 Railway topology와 양쪽 `DATABASE_URL`의 비밀 없는 fingerprint로
증명한다. 단순히 `staging`이라는 환경과 서비스가 존재한다는 이유만으로 release
gate가 통과하지 않게 한다.

## Non-goals

- staging 환경이나 데이터베이스를 자동 생성하지 않는다.
- Railway 변수 원문, DB hostname, username, password 또는 connection string을
  evidence/log/response에 남기지 않는다.
- production 또는 staging deployment를 변경하지 않는다.
- Mobile을 시작하지 않는다.

## Work size

Large / Boundary. Railway preflight 입력 schema와 production deploy consumer가 함께
변경된다.

## Touched boundaries

- Backend release library: staging database topology/fingerprint evidence
- Release CLI: Railway CLI를 통한 bounded evidence producer
- Production deploy script: 새 preflight schema 요구
- Tests: evidence mismatch, shared endpoint, secret non-reflection, CLI contract
- Docs/evidence: live read-only audit

## Success criteria

- [x] production/staging DB service instance가 Railway status에 각각 존재해야 한다.
- [x] 양쪽 `DATABASE_URL`은 메모리에서만 파싱하고 endpoint fingerprint만 반환한다.
- [x] 같은 endpoint fingerprint면 release가 중단된다.
- [x] evidence는 exact staging candidate/environment/service에 결속되고 30분 내여야 한다.
- [x] 누락·오래됨·binding mismatch·shared endpoint evidence는 fail closed한다.
- [x] preflight/deploy output에 DB URL, hostname, credential이 나타나지 않는다.
- [x] 현재 production-only Railway에서 producer가 안전하게 staging missing을 보고한다.

## Edge cases

- 같은 project-level Postgres service가 환경별 instance를 가짐:
  - base service ID가 아니라 environment-scoped service instance와 endpoint를 비교한다.
- hostname은 같지만 database name이 다름:
  - hostname, port, database name을 포함한 fingerprint가 달라야 한다.
- URL이 비어 있거나 PostgreSQL URL이 아님:
  - invalid evidence로 중단한다.
- Railway CLI 실패 또는 JSON drift:
  - bounded generic error만 반환하고 raw stdout/stderr를 반사하지 않는다.

## Test plan

1. 공유 DB endpoint인데 기존 gate가 통과하는 RED를 추가한다.
2. bounded isolation evidence projector/collector와 preflight validation을 구현한다.
3. CLI와 deploy schema를 함께 올리고 focused/full regression을 실행한다.

## Acceptance gates

- [x] focused Phase 10 release tests
- [x] deploy script tests
- [x] current Railway read-only producer audit
- [x] `npm run backend:check`
- [x] `npm test`
- [x] `git diff --check`

## Step-by-step checklist

- [x] Step 1: shared endpoint RED
- [x] Step 2: isolation evidence producer GREEN
- [x] Step 3: preflight/deploy schema migration
- [x] Step 4: live read-only audit and full regression

## Rollback / fallback

schema 3 gate와 isolation evidence 입력을 되돌리면 schema 2로 복귀한다. 외부 Railway
상태를 변경하지 않으므로 code rollback 외 데이터 복구는 없다.

## Remaining risks

- 실제 staging DB 생성과 candidate ETE는 외부 Railway 변경 승인 후에만 가능하다.

## Verification notes

- shared endpoint RED:
  - isolation evidence가 없거나 같은 fingerprint를 제출해도 기존 schema 2 gate가
    통과하는 실패를 관찰했다.
- focused:
  - Phase 10 release/deploy 20/20 pass.
- full:
  - Backend 500/500, Desktop 274/274, Runner 41/41 pass.
- current Railway read-only producer:
  - exit 1, bounded `staging_environment_missing`.
  - DB URL, host, credential-shaped output 0건.
- production mutation:
  - 수행하지 않음.
