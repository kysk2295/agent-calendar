# Phase 10 staging database isolation evidence

- Captured: 2026-07-25 KST
- Result: PASS
- Production mutation: none

## Closed release gap

기존 Railway preflight는 `staging` environment와 Agent Calendar service만 있으면
database 격리를 증명하지 않고 다음 gate로 진행할 수 있었다. schema 3 preflight는
아래 세 번째 증거를 추가로 요구한다.

- exact candidate-bound Gateway readiness
- exact candidate-bound clean-account ETE
- exact candidate-bound staging database isolation

Isolation producer는 Railway CLI에서 production/staging topology와 양쪽
`DATABASE_URL`을 읽지만 connection string 원문은 메모리 밖으로 내보내지 않는다.
hostname, port, database name으로 만든 SHA-256 endpoint fingerprint와 environment별
database service instance만 evidence에 남긴다.

다음 조건은 모두 `stop_release`다.

- production 또는 staging PostgreSQL instance 없음
- evidence 누락, 만료, candidate binding mismatch
- production/staging service instance가 같음
- production/staging endpoint fingerprint가 같음
- PostgreSQL URL이 아니거나 URL이 비어 있음

## Verification

- focused release and deploy tests: 20/20 pass.
- Backend syntax gate: pass.
- Full regression:
  - Backend 500/500 pass.
  - Desktop 274/274 pass.
  - Runner 41/41 pass.
- Current Railway read-only producer:
  - result: `staging_environment_missing`
  - production mutation: none
  - secret/DB URL/hostname-shaped output: none
- Shell and Node syntax checks: pass.
- `git diff --check`: pass.

## Current external state

- Railway has only `production`; isolated `staging` is still absent.
- Production Gateway health is 200, but the new `/api/ready` contract is not live.
- Production has no WorkOS AuthKit configuration and remains on the legacy credential path.
- Desktop artifact has an Apple Development signature, no Developer ID Application identity,
  and no notarization ticket.
- Web landing is deployed as Sites version 2 but remains owner-only with no signup/download
  environment values.

These are external release gates, not claims of production completion.
