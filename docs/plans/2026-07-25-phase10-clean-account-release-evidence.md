# Plan: Phase 10 clean-account release evidence

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified
- Parent: `docs/plans/2026-07-25-phase10-evidence-bound-release-gate.md`

## Goal

기존 Phase 3 Golden ETE가 실제 Electron 표면에서 관찰한 로그인→Runner 등록→실행 엔진
인증→위임 작업→실시간 체크포인트→Calendar 결과→재접속을 release gate가 소비하는
candidate-bound `clean_account_ete` JSON으로 산출한다.

## Non-Goals

- Railway staging을 생성하거나 production을 배포하지 않는다.
- Fake Engine이나 실패 ETE를 성공한 release evidence로 승격하지 않는다.
- 실제 WorkOS tenant 로그인을 로컬 injected AuthKit adapter로 대체했다고 주장하지 않는다.
- ETE 보고서에 사용자, Workspace, token, 로컬 경로를 기록하지 않는다.
- Mobile을 시작하지 않는다.

## Touched Boundaries

- Backend library: clean-account ETE report → bounded release evidence
- Backend check/tests: evidence contract
- Desktop ETE: observed journey report and optional evidence output
- DB/migrations: unchanged
- Electron bridge: unchanged
- React UI: unchanged
- Docs: release runbook and local evidence

## Success Criteria

- [x] 성공한 실제 Engine ETE만 `clean_account_ete` evidence를 만들 수 있다.
- [x] Fake Engine, 실패 attempt, 누락된 Calendar projection, 로그인 replay, 누락된
      checkpoint/reconnect, 중복/잘못된 screenshot hash는 fail closed 한다.
- [x] evidence binding은 full commit SHA와 deployment/environment/service ID를 요구하고
      raw ETE report의 사용자·경로·오류 문자열을 반사하지 않는다.
- [x] Phase 3 Golden ETE가 실제 관찰한 일곱 필수 check를 명시적으로 보고한다.
- [x] local Codex ETE는 injected AuthKit provenance를 명시하고 production release
      evidence 생성을 거부한다.
- [x] production evidence는 live WorkOS AuthKit tenant와 non-injected adapter를
      요구하는 schema 2로 제한한다.

## Edge Cases

- Grok quota failure처럼 truthful failure ETE가 끝난 경우:
  - failure-path 증거로는 유지하되 release 성공 evidence 생성은 거부한다.
- Fake Engine deterministic ETE가 성공한 경우:
  - 제품 회귀 증거로 유지하되 release 성공 evidence 생성은 거부한다.
- artifact hash가 동일하거나 64자리 SHA-256이 아닌 경우:
  - 화면 상태가 실제로 달랐다는 증거가 부족하므로 거부한다.
- candidate binding commit이 short SHA이거나 identifier가 빈 경우:
  - 다른 배포본으로 결속될 수 있으므로 거부한다.
- output path가 없을 때:
  - 기존 ETE 동작과 stdout report는 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] valid live report가 builder 부재로 실패한다.
  - [x] Fake/failure/incomplete/replayed/duplicate-artifact 보고서가 거부된다.
- GREEN:
  - [x] bounded builder와 Phase 3 optional evidence output을 구현한다.
- REFACTOR:
  - [x] public evidence는 release gate가 요구하는 schema만 포함한다.

## Acceptance Gates

- [x] focused evidence tests
- [x] deterministic Phase 3 Golden ETE regression
- [x] live Codex Phase 3 Golden ETE with candidate-bound evidence
- [x] generated evidence through Railway release gate validator
- [x] `npm run backend:check`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- Live Railway staging ETE:
  - staging 환경이 아직 없으므로 이번에는 `local-ephemeral` candidate binding으로 producer를
    검증한다. 이 binding은 Railway staging과 일치하지 않아 production gate를 통과할 수 없다.
- Live WorkOS tenant:
  - 외부 tenant와 test account 준비가 필요한 후속 staging gate다.

## Implementation Checklist

- [x] Step 1: RED report-to-evidence boundary
- [x] Step 2: bounded builder and ETE report GREEN
- [x] Step 3: deterministic and live Engine actual-surface runs
- [x] Step 4: release validator, regression, evidence, runbook

## Rollback

새 builder와 ETE optional output만 제거하면 기존 Golden ETE 동작으로 복귀한다. Gateway,
Runner credential, Railway environment에는 변경이 없다.

## Verification Notes

- `node --test apps/backend/tests/phase10-clean-account-release-evidence.test.cjs
  apps/backend/tests/phase10-release-rollback.test.cjs`
  - 14/14 passed.
- deterministic Fake Engine Phase 3 Golden ETE
  - passed in 28.1 seconds with one login, one attempt, one Calendar result, restart/reconnect, and
    five distinct screenshots; release evidence was not written.
- live Codex Phase 3 Golden ETE
  - passed as product-surface evidence, but its injected AuthKit login is now explicitly
    release-ineligible.
- release preflight
  - schema 1 or injected/fake identity evidence is rejected even when Engine and journey checks pass.
- `npm run backend:check`
  - passed.
- Phase 3 ETE Desktop build
  - TypeScript checks and production build passed.
- `npm test`
  - Backend, Desktop 262/262, Runner 29/29 passed.
- `git diff --check`
  - passed.

## Remaining Risks

- 실제 staging candidate binding과 WorkOS tenant 로그인을 사용한 schema 2 evidence가 남는다.
- Railway Public API의 `canRollback` snapshot 자동화가 다음 운영 slice로 남는다.
