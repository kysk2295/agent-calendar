# Phase 10 live WorkOS release evidence gate

- Captured: 2026-07-25 KST
- Result: PASS
- Production mutation: none

## Closed release gap

실제 Codex/Claude/Grok/Hermes 실행 성공만으로는 production 로그인 증거가 되지 않는다.
기존 local Golden ETE는 production-mode dispatch를 사용했지만 AuthKit exchange는
injected test adapter였다.

clean-account evidence schema 2는 다음 identity provenance를 필수로 한다.

- provider: `workos_authkit`
- live tenant: true
- injected adapter: false

Builder와 Railway preflight가 모두 이 값을 검증한다. public evidence는 이 세 bounded
값만 저장하며 tenant ID, user ID, email, authorization code, token은 저장하지 않는다.

## Verification

- focused clean-account/release/deploy tests: 26/26 pass.
- missing identity provider: rejected.
- fake provider: rejected.
- live tenant false: rejected.
- injected adapter true: rejected.
- legacy schema 1 smoke evidence: rejected.
- current local Phase 3 ETE:
  - product regression remains enabled.
  - reports `workos_authkit_test_adapter`, live=false, injected=true.
  - refuses production release evidence output before execution.
- actual local product ETE:
  - duration 28.3 seconds.
  - login 1회, Runner 등록, 작업, realtime checkpoint, Calendar result,
    backend/Desktop restart, reconnect pass.
  - five state screenshots had unique SHA-256 hashes.
  - `releaseEvidenceWritten=false`.
- full regression:
  - Backend 502/502 pass.
  - Desktop 274/274 pass.
  - Runner 41/41 pass.

## Current external gate

Railway production currently has no WorkOS configuration. A release-eligible schema 2 document
can only be generated after an isolated staging candidate and real WorkOS AuthKit test account
exist. No external WorkOS or Railway state was changed in this slice.
