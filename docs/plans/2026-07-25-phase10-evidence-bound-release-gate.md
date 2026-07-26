# Plan: Phase 10 evidence-bound Railway release gate

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified
- Parent: `docs/plans/2026-07-25-phase10-gateway-runner-release-rollback.md`

## Goal

Railway staging의 readiness와 clean-account ETE 결과가 승격하려는 정확한 deployment,
commit, environment, service에 결속된 구조화 증거일 때만 production 승격을 허용한다.
운영자가 입력한 독립적인 boolean 값만으로는 release gate를 통과할 수 없게 한다.

## Non-Goals

- Railway staging 생성, production deploy, rollback을 실행하지 않는다.
- Railway token, provider credential, 사용자 또는 Workspace 데이터를 증거에 저장하지 않는다.
- clean-account ETE 실행기 자체를 이번 단계에서 새로 만들지 않는다.
- 서명된 CI attestation 또는 공급망 provenance까지 확장하지 않는다.

## Touched Boundaries

- Backend library: Railway release evidence validation
- Backend tools: release preflight CLI input contract and production deploy consumer
- DB/migrations: unchanged
- Electron bridge: unchanged
- React UI: unchanged
- Tests: release gate and local Gateway rollback rehearsal
- Docs: release runbook, redacted evidence, parent plan

## Success Criteria

- [x] readiness evidence가 candidate deployment ID, full commit SHA, staging environment/service,
      `/api/ready`, HTTP 200, `ok=true`에 결속된다.
- [x] clean-account ETE evidence가 같은 candidate와 필수 사용자 여정 전부에 결속된다.
- [x] 두 증거는 유효한 ISO 시각이며 preflight 기준 30분보다 오래되면 거부된다.
- [x] staging DB isolation evidence가 production/staging service instance와 비밀 없는
      endpoint fingerprint를 비교하며 같은 endpoint 승격을 거부한다.
- [x] clean-account evidence는 실제 WorkOS AuthKit tenant와 non-injected adapter를
      증명하는 schema 2만 허용한다.
- [x] preflight 출력에는 만료 시각이 있고 production deploy consumer가 만료된 파일을 거부한다.
- [x] 기존 `--candidate-ready`, `--smoke-passed` boolean CLI 입력을 제거한다.
- [x] gate 출력은 bounded identifier와 failure code만 포함하고 credential/사용자 데이터를
      반사하지 않는다.

## Edge Cases

- readiness는 성공했지만 다른 deployment 또는 commit에서 수집됨:
  - `candidate_readiness_evidence_mismatch`로 중단한다.
- ETE 일부 단계만 성공했거나 다른 staging service에서 실행됨:
  - `candidate_smoke_evidence_invalid` 또는 mismatch로 중단한다.
- 두 증거가 모두 성공이지만 30분을 넘김:
  - stale failure로 중단한다.
- 시스템 시각보다 과도하게 미래인 증거:
  - invalid timestamp로 중단한다.
- staging 자체가 없음:
  - 증거가 있어도 `staging_environment_missing`으로 중단한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 구조화 증거 없이 boolean만 전달하면 gate가 실패한다.
  - [x] candidate binding mismatch, stale evidence, incomplete ETE가 실패한다.
  - [x] 정확히 결속된 최신 증거만 통과한다.
- GREEN:
  - [x] pure evidence validator와 CLI JSON 입력을 구현한다.
  - [x] local Gateway rehearsal은 clean-account 증거를 위조하지 않고 rollback만 실제 관찰한다.
- REFACTOR:
  - [x] failure code를 bounded vocabulary로 유지하고 raw evidence를 출력하지 않는다.

## Acceptance Gates

- [x] focused release rollback tests
- [x] actual local Gateway rollback rehearsal
- [x] current Railway fixtures against preflight evaluator
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- Production Railway deploy/rollback:
  - staging이 없고 현재 worktree가 reviewed clean release commit이 아니므로 외부 변경을 하지 않는다.

## Implementation Checklist

- [x] Step 1: RED evidence-binding contract
- [x] Step 2: evidence validator and CLI GREEN
- [x] Step 3: rehearsal and runbook migration
- [x] Step 4: live read-only audit and regression evidence

## Rollback

새 evidence JSON 인자와 validator를 되돌리면 기존 boolean preflight로 복귀한다. Railway
환경이나 deployment를 변경하지 않으므로 코드 rollback 외의 복구 작업은 없다.

## Verification Notes

- `node --test apps/backend/tests/phase10-release-rollback.test.cjs
  apps/backend/tests/railway-deploy-script.test.cjs`
  - 13/13 passed.
- `npm run backend:check`
  - passed.
- `npm run runner:check`
  - passed.
- `npm test`
  - Backend, Desktop 262/262, Runner 29/29 passed.
- read-only Railway evaluator audit
  - production만 존재하며 새 gate가 `stop_release`와 staging/evidence/rollback blocker를 반환했다.
  - production mutation은 실행하지 않았다.
- `bash -n scripts/deploy-railway-main.sh`
  - passed.
- `git diff --check`
  - passed.

## Remaining Risks

- Evidence file 생성 주체는 후속 CI hardening 전까지 로컬 ETE harness와 운영 절차이다.
- Live staging이 생긴 뒤에만 실제 candidate-bound 증거를 수집할 수 있다.

## Isolation hardening follow-up

- `docs/plans/2026-07-25-phase10-staging-database-isolation-evidence.md`
  - preflight schema 3은 readiness와 clean-account ETE 외에
    `staging_database_isolation` evidence를 필수로 요구한다.
  - producer는 Railway CLI로 양쪽 `DATABASE_URL`을 메모리에서만 읽고 hostname,
    database name, credential을 출력하지 않는 endpoint fingerprint만 저장한다.
  - 현재 production-only project에서는 bounded `staging_environment_missing`으로
    fail closed함을 다시 관찰했다.

## Identity hardening follow-up

- `docs/plans/2026-07-25-phase10-live-workos-release-evidence.md`
  - 실제 Engine을 사용한 local ETE라도 injected AuthKit이면 release evidence로
    승격하지 않는다.
  - schema 2 clean-account evidence는 `workos_authkit`, live tenant,
    non-injected adapter를 모두 요구한다.

## Follow-up Evidence Producer

- `docs/plans/2026-07-25-phase10-clean-account-release-evidence.md`
  - live Codex actual-surface ETE가 bounded `clean_account_ete` JSON을 생성한다.
  - local unreleased binding은 contract simulation에서만 통과하며 actual Railway에서는
    `stop_release`로 차단됨을 관찰했다.
- `docs/plans/2026-07-25-phase10-candidate-readiness-evidence.md`
  - public Gateway의 provenance, health, readiness를 exact candidate binding에 결속한
    bounded `gateway_readiness` JSON producer를 구현했다.
  - local real Gateway 성공과 current production `/api/ready=401` fail-closed를 관찰했다.
