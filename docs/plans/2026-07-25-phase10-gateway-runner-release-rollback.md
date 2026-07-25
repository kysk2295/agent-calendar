# Plan: Phase 10 Gateway and Runner release rollback

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified local safety slice; live Railway and public Runner release remain external gates
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`

## Goal

Gateway 배포가 현재 readiness 계약과 Railway zero-downtime teardown 설정을 사용하고,
배포 전 last-known-good deployment를 고정하며, 명시적으로 선택한 이전 deployment로만
rollback할 수 있게 한다. Runner는 서명된 release manifest와 checksum을 검증한 뒤 새
release를 원자적으로 전환하고, 승격 후 health check가 실패하면 기존 release와 device
state를 보존한 채 자동 복귀한다.

## Non-Goals

- dirty/uncommitted worktree를 production에 배포하지 않는다.
- 이번 로컬 리허설에서 Railway production deployment를 변경하거나 rollback하지 않는다.
- staging과 production이 같은 PostgreSQL 또는 secret을 공유하도록 환경을 복제하지 않는다.
- Apple Developer ID, notarization credential, Railway API token 값을 만들거나 저장하지 않는다.
- Desktop updater, DB migration, Mobile을 변경하지 않는다.

## Touched Boundaries

- Backend gateway: Railway deployment config only
- Backend library: Railway release gate and redacted release evidence
- Backend tools: fixed-selector preflight/rollback CLI
- Runner: signed manifest verification, atomic install/current pointer, rollback
- Runner packaging: local release fixture/finalizer and separate release workflow contract
- DB/migrations: unchanged
- Electron bridge: unchanged
- React UI: unchanged
- Tests: Gateway deployment and Runner release rollback contracts
- Docs: this plan, operations runbook, redacted evidence, roadmap progress

## Success Criteria

- [x] root and backend Railway config use `/api/health`, bounded health timeout, overlap, draining,
      and bounded restart policy.
- [x] release preflight refuses missing staging, wrong source repo, commit drift, missing
      last-known-good deployment, or invalid readiness evidence.
- [x] Railway rollback accepts only an exact previously listed `canRollback` deployment ID and
      requires an API token without printing it.
- [x] Runner release manifest has stable semver, full commit SHA, exact artifact size/SHA-256,
      protocol/state compatibility, and a valid Ed25519 signature from a pinned public key.
- [x] archive path traversal, unsigned/tampered artifacts, version downgrade, and incompatible
      protocol/state schema fail closed.
- [x] Runner promotion uses an atomic current pointer and never edits the external Runner state
      directory.
- [x] post-promotion health failure restores the prior release and records a bounded redacted
      rollback result.
- [x] local rehearsal observes v1 running, v2 promotion failure, v1 restored, device fingerprint
      and credential state unchanged.

## Edge Cases

- Railway has production only and no isolated staging:
  - preflight must report `staging_environment_missing`; it must not duplicate production.
- Railway previous image is outside plan retention:
  - rollback is unavailable and release promotion must stop.
- candidate reaches `SUCCESS` but `/api/ready` is 503:
  - do not promote or remove last-known-good.
- Runner artifact manifest is valid but archive contains `../` or absolute paths:
  - reject before extraction.
- Runner process health passes before promotion but fails after current-pointer switch:
  - restore previous pointer before returning failure.
- first Runner install has no previous release:
  - failed post-promotion health leaves no `current` pointer.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Railway config/preflight/rollback contracts fail before the release gate exists.
  - [x] Runner signed manifest, tamper, traversal, atomic promotion, and rollback contracts fail
        before the release manager exists.
- GREEN:
  - [x] fixed-selector Railway gate and signed atomic Runner release manager pass.
- REFACTOR:
  - [x] keep external I/O injected and evidence redacted; no production secret values enter tests.

## Acceptance Gates

- [x] focused Gateway deployment tests
- [x] focused Runner release tests
- [x] actual local Runner install/promote/fail/rollback rehearsal
- [x] read-only Railway production/staging audit
- [x] `npm run backend:check`
- [x] `npm run runner:check`
- [x] `npm run test:backend`
- [x] `npm run test:runner`
- [x] `git diff --check`

건너뛴 gate:

- Production Railway deploy/rollback:
  - current worktree is dirty and not a reviewed synchronized `main`; staging is absent.
- Developer ID/notarization:
  - required credentials are external and unavailable in this local environment.

## Implementation Checklist

- [x] Step 1: current Railway and Runner release/update truth audit
- [x] Step 2: Gateway/Runner rollback RED contracts
- [x] Step 3: Railway config and release gate GREEN
- [x] Step 4: signed Runner release manager and local rehearsal GREEN
- [x] Step 5: full regression, runbook, evidence, roadmap update

## Rollback

- Railway config and gate are additive; revert the config/tool files without touching deployment
  state.
- Runner installer stores immutable version directories. Rollback switches only the `current`
  symlink and never rewrites device identity, credential, knowledge source, or Workspace state.
- Promoted public versions are not overwritten. A remote stable-channel rollback still publishes a
  higher patch from the known-good commit, while the host-local pointer can immediately return to
  the already verified release.

## Verification Notes

- Railway CLI 5.26.4 read-only audit:
  - project has only `production`; isolated `staging` is absent.
  - Agent Calendar service is sourced from `kysk2295/agent-calendar`.
  - active deployment is `8ac25199-857d-49a1-9e8b-d301dca8c44f`,
    commit `16d59256801d822e3430cdd30eaa7b56d58ecab9`.
  - active config still uses `/api/gateway-status`, timeout 300, restart max 10, with no explicit
    overlap or draining.
- Official Railway documentation confirms rollback selects a retained `canRollback` deployment,
  and config-as-code supports `overlapSeconds` and `drainingSeconds`.
- Runner package is `0.1.0-dev` and currently has no release finalizer or updater/rollback manager.
- Runner package now reports stable `0.1.0`; signed current-package install and
  `0.1.0 → failed 0.1.1 → 0.1.0` automatic rollback were observed locally.
- Live Railway check:
  - `/api/health` returned 200 from the legacy deployment shape.
  - `/api/ready` returned 401, proving the current readiness contract is not deployed.
  - no production mutation was performed.
- Evidence-bound release gate:
  - staging candidate now comes from the staging service `latestDeployment`; production deployment
    history is reserved for last-known-good rollback selection.
  - readiness and clean-account ETE evidence must match the exact candidate deployment, commit,
    environment, and service and remain within a 30-minute freshness window.
  - production deploy rejects missing, mismatched, future, or expired schema-v2 preflight files.
- Railway rollback snapshot:
  - official Public API query now obtains `canRollback` using fixed production selectors and
    projects only bounded deployment provenance.
  - Account and Project Token headers are mutually exclusive; no configured token was available
    for a live snapshot, so retained rollback truth remains an external gate.

## Remaining Risks

- Railway environment and production mutation remain external operational gates.
- Live Public API rollback snapshot needs one secret-manager-injected Account or Project Token.
- Signed/notarized Runner public artifacts require Apple and GitHub release credentials.
- Current production is materially behind the worktree and cannot be promoted until a reviewed
  release commit is pushed.
