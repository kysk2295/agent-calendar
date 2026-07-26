# Plan: Phase 10 live WorkOS release evidence

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete
- Parent: `docs/plans/2026-07-25-phase10-clean-account-release-evidence.md`

## Goal

production release용 clean-account ETE evidence가 실제 WorkOS AuthKit tenant를 통한
로그인만 인정하게 한다. 로컬 injected/fake AuthKit adapter로 제품 ETE가 성공해도
production 승격 증거로 변환되지 않아야 한다.

## Non-goals

- WorkOS tenant, API key, client ID 또는 test user를 생성하지 않는다.
- Railway staging을 생성하거나 production을 배포하지 않는다.
- 로컬 fake AuthKit ETE의 제품 회귀 가치를 제거하지 않는다.
- Mobile을 시작하지 않는다.

## Work size

Large / Boundary. clean-account evidence schema와 Railway preflight consumer가 함께
변경된다.

## Touched boundaries

- Backend evidence builder: identity provenance 필수화
- Railway release gate: clean-account evidence schema 2
- Desktop ETE: injected AuthKit임을 정직하게 보고하고 release evidence 생성을 금지
- Tests/docs: fake/live identity provenance와 bounded output

## Success criteria

- [x] `workos_authkit`, live tenant, non-injected adapter 세 조건을 모두 요구한다.
- [x] fake/injected AuthKit report는 live Engine을 사용해도 release evidence가 되지 않는다.
- [x] public evidence에는 provider 종류와 live/injected boolean만 포함한다.
- [x] Railway preflight는 identity provenance가 없는 schema 1 smoke evidence를 거부한다.
- [x] 현재 로컬 Phase 3 ETE는 제품 테스트로 계속 동작하되 release producer를 자처하지 않는다.

## Edge cases

- 실제 Codex + fake AuthKit:
  - 제품 ETE는 성공할 수 있지만 production release evidence는 실패한다.
- `identityProvider=workos_authkit`만 있고 live flag 없음:
  - 실패한다.
- live flag true지만 injected adapter:
  - 실패한다.
- raw tenant/user/email/token이 report에 들어옴:
  - evidence projection에서 제거한다.

## Test plan

1. 현재 valid report에서 identity provenance가 없어도 evidence가 생성되는 RED.
2. evidence schema 2와 preflight identity validation 구현.
3. local ETE의 injected provenance 표시와 release output 금지.
4. focused/full regression.

## Acceptance gates

- [x] clean-account evidence tests
- [x] release preflight tests
- [x] local ETE contract test
- [x] `npm run backend:check`
- [x] `npm test`
- [x] `git diff --check`

## Step-by-step checklist

- [x] Step 1: fake AuthKit release RED
- [x] Step 2: live WorkOS-only builder GREEN
- [x] Step 3: preflight schema migration
- [x] Step 4: regression and evidence

## Rollback / fallback

clean-account schema 2와 identity validator를 되돌리면 schema 1로 복귀한다. 외부
WorkOS/Railway 상태는 변경하지 않는다.

## Remaining risks

- 실제 WorkOS tenant login ETE는 tenant와 staging 승인 후에만 생성할 수 있다.

## Verification notes

- focused clean-account/release/deploy: 26/26 pass.
- local product ETE:
  - 28.3초, login 1회, Runner/작업/checkpoint/Calendar/restart/reconnect pass.
  - identity provider `workos_authkit_test_adapter`, live=false, injected=true.
  - release evidence written=false.
- full regression:
  - Backend 502/502, Desktop 274/274, Runner 41/41 pass.
- production mutation:
  - 수행하지 않음.
