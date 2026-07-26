# Phase 10 clean-account evidence correction

- Date: 2026-07-25
- Result: local product ETE pass; production release eligibility revoked
- Production mutation: none

## Correction

이전에 local Phase 3 Golden ETE가 만든 schema 1 `clean_account_ete` 문서는 실제 Codex
Runner 경로를 사용했지만 로그인은 injected AuthKit test adapter였다. 따라서 실제
WorkOS tenant 로그인 증거가 아니며 production release evidence로 사용할 수 없다.

기존 로컬 문서는 역사적 제품 ETE 기록으로 보존하되 다음 상태를 명시한다.

- `releaseEligible: false`
- provider: `workos_authkit_test_adapter`
- live tenant: false
- injected adapter: true

## Hardened contract

production release용 clean-account evidence는 schema 2이며 아래 세 조건을 모두
만족해야 한다.

- `identity.provider = workos_authkit`
- `identity.liveTenant = true`
- `identity.injectedAdapter = false`

Railway preflight도 같은 identity provenance를 검증한다. schema 1 문서, identity가
없는 문서, fake/injected adapter 문서는 exact candidate binding과 실제 Engine 성공이
있어도 `candidate_smoke_evidence_invalid`로 거부한다.

로컬 Phase 3 ETE는 계속 로그인→Runner→Engine→작업→체크포인트→Calendar→재접속의
제품 회귀를 검증하지만 production release evidence 출력 환경변수를 받으면 실행 전에
실패한다.

## Verification

- focused clean-account/release/deploy tests: 26/26 pass.
- fake/injected AuthKit rejection: pass.
- schema 1 smoke evidence rejection: pass.
- local ETE source contract: injected identity provenance와 release-output 금지 확인.
- production mutation: none.

## Remaining external gate

실제 Railway staging candidate에서 real WorkOS AuthKit tenant와 test account로 동일한
사용자 여정을 수행한 schema 2 evidence가 필요하다.
