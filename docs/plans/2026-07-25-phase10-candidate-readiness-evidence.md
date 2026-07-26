# Plan: Phase 10 candidate readiness evidence

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified locally; live staging gate remains open
- Parent: `docs/plans/2026-07-25-phase10-evidence-bound-release-gate.md`

## Goal

staging candidate의 실제 public Gateway URL에서 deployment provenance, liveness, dependency
readiness를 조회하고, 세 응답이 exact candidate binding과 일치할 때만 release gate가
소비하는 `gateway_readiness` JSON을 생성한다.

## Non-Goals

- staging 또는 production deployment를 변경하지 않는다.
- 인증된 사용자/Workspace API를 호출하지 않는다.
- response body, URL, header, 사용자 데이터를 증거에 저장하지 않는다.
- clean-account ETE를 readiness probe로 대체하지 않는다.

## Touched Boundaries

- Backend release library: HTTP readiness evidence producer
- Backend production gateway: bounded commit prefix and deployment ID provenance
- Release gate: stronger readiness evidence payload
- Release CLI: read-only `probe-readiness`
- Tests: exact paths, provenance binding, timeout/error/redaction
- Docs: release runbook and observed evidence
- DB/migrations, Electron, React, Runner: unchanged

## Success Criteria

- [x] CLI는 HTTPS base URL과 full candidate binding을 요구한다.
- [x] 정확히 `/api/gateway-status`, `/api/health`, `/api/ready`만 GET한다.
- [x] gateway status는 HTTP 200, exact deployment ID, candidate full commit과 일치하는
      12–40자리 commit prefix를 요구한다.
- [x] production dispatcher의 public gateway status가 tenant data 없이 같은 bounded
      provenance를 제공한다.
- [x] health와 ready는 모두 HTTP 200 및 JSON `ok=true`를 요구한다.
- [x] evidence는 capture time, binding, 세 bounded probe 결과만 포함한다.
- [x] release gate는 legacy/manual readiness document처럼 health/provenance가 없는 입력을
      거부한다.
- [x] local real Gateway는 evidence를 생성하고 현재 live production은 ready 401로 실패한다.

## Edge Cases

- redirect, timeout, network error, non-JSON, oversized body:
  - bounded error로 실패하고 URL/body를 반사하지 않는다.
- deployment ID는 맞지만 commit prefix가 다름:
  - evidence를 생성하지 않는다.
- 12자리보다 짧은 build commit:
  - provenance가 약하므로 거부한다.
- health 200이지만 ready 401/503:
  - release candidate가 아니므로 거부한다.
- local HTTP fixture:
  - injected test option에서만 허용하며 CLI는 HTTPS만 허용한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] exact three-probe success and bounded evidence
  - [x] provenance/health/ready/URL/response failure matrix
  - [x] release gate rejects legacy readiness shape
  - [x] CLI invalid/missing argument contract
- GREEN:
  - [x] injected fetch producer and CLI
  - [x] local real Gateway integration
- REFACTOR:
  - [x] public errors and evidence remain bounded.

## Acceptance Gates

- [x] focused readiness/release tests
- [x] real local Gateway probe
- [x] actual production read-only failure observation
- [x] `npm run backend:check`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- Live staging success:
  - Railway staging이 아직 없으므로 local Gateway success와 current production failure를
    각각 관찰한다.

## Implementation Checklist

- [x] Step 1: RED readiness evidence contract
- [x] Step 2: producer and release gate GREEN
- [x] Step 3: CLI and actual HTTP observations
- [x] Step 4: regression, runbook, evidence

## Rollback

producer/CLI와 강화된 payload validator를 함께 되돌리면 기존 readiness JSON 계약으로
복귀한다. 외부 deployment state는 변경되지 않는다.

## Verification Notes

- `node --test apps/backend/tests/phase10-candidate-readiness-evidence.test.cjs
  apps/backend/tests/phase10-release-rollback.test.cjs`
  - 19/19 passed.
- Real local production-mode Gateway:
  - exact three public probes passed and emitted candidate-bound evidence.
- Current production read-only observation:
  - `/api/gateway-status=200` with deployment/commit provenance.
  - `/api/health=200`, `ok=true`.
  - `/api/ready=401`, so `probe-readiness` exited 1 with a bounded error and emitted no evidence.
- `npm run backend:check`
  - passed.
- `npm test`
  - root suite exited 0; Desktop 262/262 and Runner 29/29 passed.
  - repeated Desktop HMR WebSocket port warnings were non-fatal.
- `git diff --check`
  - passed.

## Remaining Risks

- 실제 staging candidate URL과 WorkOS clean-account ETE evidence를 같은 deployment에
  결속한 승격은 외부 환경 생성 후에만 가능하다.
