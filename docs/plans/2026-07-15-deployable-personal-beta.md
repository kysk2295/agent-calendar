# Plan: Deployable Personal Beta

- Date: 2026-07-15
- Owner: Codex
- Work size: Large / Boundary
- Status: Release candidate verified; external Telegram gate pending

## Goal

Agent Calendar를 제품 기획의 `Weekly Opportunity Brief` 흐름과 Agent Work
Control Space 용어에 맞는 개인용 배포 가능 베타로 만든다. 사용자는 production
renderer가 포함된 macOS 앱을 설치해 Railway control plane과 Mac mini Hermes
execution plane을 통해 작업을 위임하고, 개입하고, 복구하고, 근거가 있는 보고서를
받을 수 있어야 한다.

완료는 코드가 존재하는지가 아니라 아래 세 가지 증거로 판단한다.

1. 자동화된 계약·UI·빌드 검증이 깨끗하게 반복된다.
2. 현재 소스가 Railway와 Mac mini의 실제 무해한 작업 흐름에서 사실대로 동작한다.
3. macOS 배포 산출물을 설치·실행할 수 있고 배포 및 롤백 절차가 재현 가능하다.

## Non-Goals

- 멀티 사용자 계정, 공개 가입, 결제, 조직 권한을 추가하지 않는다.
- hosted execution engine이나 임의의 사용자 설치형 runtime을 만들지 않는다.
- 이메일·게시·구매·거래 같은 외부 쓰기를 자동 승인하지 않는다.
- 베타 준비와 무관한 전체 UI 재설계나 전면 프레임워크 교체를 하지 않는다.
- 실제 유용성을 관찰해야 하는 2주 dogfood 결과를 개발 완료로 가장하지 않는다.
- Developer ID Application 인증서와 Apple 공증 자격 증명이 없는 상태에서 외부
  배포 공증을 완료했다고 주장하지 않는다.

## Work Size And Boundaries

Large / Boundary 작업이다. backend, desktop, Electron packaging, Railway 운영,
Mac mini runtime, Telegram delivery 계약을 함께 검증하며 일부는 실제 배포 상태를
변경한다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/**`
- DB/migrations: 기존 schema의 재시작·동시성 계약 검증; 의미 변경 시 별도 migration
- Electron bridge: `apps/desktop/electron/**`
- React UI: `apps/desktop/src/**`
- Packaging: `apps/desktop/package.json`, entitlements, release scripts
- CI: `.github/workflows/**`
- Tests: `apps/backend/tests/**`, `apps/desktop/tests/**`
- Operations: Railway gateway, outbound Mac mini relay, Telegram summary delivery
- Docs: `docs/plans/**`, `docs/evidence/**`, release and rollback runbooks

## Beta Outcomes And Metrics

| Outcome | Evidence | Target |
| --- | --- | --- |
| Safe repeatable change | CI and local verification | backend/desktop contracts, typecheck, build all pass |
| Installable personal beta | signed or locally valid hardened macOS artifact | DMG and ZIP build; installed app launches production renderer |
| Truthful delegated work | live Railway → Mac mini run | correct profile and engine provenance; no fake completion |
| Recoverable operation | offline/restart/intervention checks | blocked state persists and allowed recovery succeeds |
| Useful report loop | report and feedback flow | structured evidence, usefulness decision, follow-up decision persist |
| Minimal notification | Telegram contract and live owner delivery | minimized summary and deep link arrive without private evidence |
| Operable release | release/rollback record | deploy, smoke, rollback commands and observed version recorded |

The product North Star remains “owner-opened weekly reports marked useful.” Beta
readiness does not substitute run count for usefulness.

## Product Acceptance Matrix

The authoritative source is
`docs/superpowers/specs/2026-07-13-personal-agent-operations-calendar-design.md`.

| # | Acceptance condition | Current evidence | Beta closure |
| --- | --- | --- | --- |
| 1 | Create and activate Weekly Opportunity Brief | backend, mission browser flow, and live report mission | verified |
| 2 | Bounded plan with reasons and outputs | parser, budget, planning API, and harmless live plan | verified |
| 3 | Proposed work distinct on calendar | contract and browser coverage | verified |
| 4 | First-week approval; trusted class auto-schedule | policy, scheduler, and production-like approval flow | verified |
| 5 | Correct Mac mini Hermes profile | current Railway relay and live profile provenance | verified |
| 6 | Persistent ordered Task Session | ordering, restart, stale-write repair, and live reload | verified |
| 7 | Message/approve/pause/resume/cancel/retry persist | contracts, live intervention, cancellation, and reload | verified |
| 8 | Secrets, paths, reasoning, raw logs redacted | release blockers, runtime safety, and live UI smoke | verified |
| 9 | Calendar and persisted states agree after reload | contracts and browser reload coverage | verified |
| 10 | Structured Friday report with evidence and links | live ready report with structured evidence and decisions | verified |
| 11 | Telegram minimized summary and deep link | unit/contract coverage; credentials absent | configure owner bot/chat and observe one safe delivery |
| 12 | Useful feedback and follow-up decision | persistence verified with synthetic non-owner feedback and rejected follow-up | owner usefulness remains a dogfood metric |
| 13 | Offline/restart/budget/evidence failure recoverable | offline 503/recovery, process-tree stop, restart, and scheduler tests | verified |
| 14 | Mission policy and forbidden actions enforced | final-safety and release-blocker tests | verified |

## Success Criteria

- [ ] Every acceptance condition above has current automated and, where specified,
  live evidence against the same releasable source revision.
- [x] CI runs install, syntax, type, backend, desktop, and production build gates on
  a clean checkout without using production secrets.
- [x] The macOS arm64 DMG and ZIP are reproducibly built with hardened runtime enabled;
  the app bundle passes `codesign --verify` and launches the production renderer.
- [x] The current backend revision is deployed to Railway with a healthy daemon and
  online relay, and its version or deployment identifier is recorded.
- [x] A harmless delegated task runs through the selected Mac mini profile, retains
  canonical engine/profile provenance, persists its Work Conversation, and survives reload.
- [x] A safe offline or interrupted execution becomes visibly blocked without false
  completion and remains recoverable through the allowed user control.
- [ ] Telegram sends one minimized owner-only report summary with a deep link; the
  evidence bundle, credentials, private paths, and raw runtime metadata are absent.
- [x] A release runbook names configuration prerequisites, smoke checks, artifact
  locations, rollback steps, and known limitations.
- [x] Oversized modules touched by beta fixes are not made more coupled; stable seams
  needed by release work are extracted under characterization tests.
- [x] No credentials, raw prompts, auth headers, private evidence, or local secret paths
  are committed to source or verification evidence.

## Edge Cases

- Mac mini or relay offline: do not enqueue fake work; persist a truthful blocked state.
- Responsible profile stopped/disabled: another ready profile must not mask unavailability.
- Runtime timeout with unconfirmed cancellation: do not retry concurrently or mark complete.
- Runtime timeout with a surviving child process: terminate the complete command process tree,
  confirm termination before reporting `stopped`, and never allow a late `done` transition.
- App restart during a run: reload persisted state and ordered public checkpoints.
- Partial Railway or Telegram outage: completed work remains completed; delivery state is
  separately failed or not configured.
- A stored report can use the full report-field length budget: the minimized Telegram summary
  must remain within the Bot API's 4,096-character boundary and retain its session deep link.
- A forged webhook body can claim an allowlisted chat ID: Telegram ingress must also prove the
  derived webhook secret registered with Bot API before it records or executes the update.
- Missing Telegram configuration: report `not_configured`; never leave ambiguous pending state.
- Missing Apple notarization credentials: build and verify the personal beta locally, but
  classify public internet distribution as not notarized.
- Stale or duplicate request: idempotency keeps one work/session and one applied intervention.
- A direct Work Conversation can become active before it has subordinate tasks: pausing and
  resuming that active work must not require a plan, while activating a new draft still does.
- Sensitive runtime output: redact before persistence and projection, not only in the UI.
- Dirty worktree: preserve pre-existing changes and record the exact release diff.

## Test Plan

For every behavioral correction, use the repository TDD loop.

- RED:
  - [x] Add the narrowest contract or workflow test that fails for the observed beta gap.
  - [x] Confirm the failure reason is the intended missing behavior, not setup noise.
- GREEN:
  - [x] Implement the smallest boundary-preserving change.
  - [x] Run the same focused test until it passes.
- REFACTOR:
  - [x] Extract only stable responsibilities while focused tests stay green.
  - [x] Re-run the owning subsystem gate after each extraction.

Configuration, documentation, generated packaging output, and CI workflow changes are
verified through schema/tool execution instead of artificial unit tests.

## Acceptance Gates

- [x] `npm ci` from a clean checkout-equivalent dependency state
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Relevant Agent Work and mission Playwright workflows
- [x] `npm --workspace apps/desktop run dist:mac`
- [x] `codesign --verify --deep --strict --verbose=2 <app>`
- [x] Launch packaged app and verify production renderer, Railway hydration, and core flow
  - The packaged production bundle and deep-link cold/running launch passed; the same built
    renderer/proxy source passed the authenticated live core flow.
- [x] Railway health/daemon/relay smoke against the deployed revision
- [x] Real harmless Mac mini profile execution, persistence, intervention, and reload
- [x] Real offline/restart recovery scenario
- [ ] Real minimized Telegram summary delivery
- [x] `git diff --check`

Skipped gates must include the exact missing prerequisite and must not be reported as
passed. Public notarization additionally requires a Developer ID Application identity and
Apple notarization credentials; the current machine only exposes an Apple Development
identity.

## Implementation Checklist

### Phase 0 — Baseline And Traceability

- [x] Freeze the authoritative personal MVP scope and 14 acceptance conditions.
- [x] Record the starting automated baseline: backend 219/219 and desktop 130/130 pass.
- [x] Confirm the current gaps: no CI workflow, hardened runtime disabled, Telegram
  production variables absent, and no Developer ID Application identity available.
- [x] Reconcile superseded/stale plan checkboxes with current evidence without rewriting history.

### Phase 1 — Repeatable Release Verification

- [x] Add a single local beta verification command with fail-fast subsystem gates.
- [x] Add GitHub Actions CI for dependency install, backend syntax/tests, desktop
  type/tests/build, and artifact retention where safe.
- [x] Ensure CI needs no Railway, Telegram, Mac mini, or Apple secrets for contract gates.
- [x] Prove workflow syntax and commands locally.

### Phase 2 — macOS Packaging And Rollback

- [x] Enable hardened runtime and add the minimum Electron entitlements supported by the app.
- [x] Make signing behavior explicit for personal/local and Developer ID release modes.
- [x] Build DMG and ZIP, verify signature/bundle contents, mount or install, and launch.
- [x] Add release and rollback runbooks with version, artifact hash, config prerequisites,
  database compatibility, and last-known-good recovery.

### Phase 3 — Product And Runtime Acceptance

- [x] Run focused Playwright flows for mission, calendar distinction, Work Conversation,
  intervention controls, report feedback, and reload persistence.
- [x] Deploy the releasable backend revision to Railway and record deployment evidence.
- [x] Verify daemon and relay readiness without exposing credentials.
- [x] Run one harmless selected-profile task and verify engine/profile provenance.
- [x] Exercise offline/interrupted recovery and confirm no false completion.
- [x] Verify current Mac mini runtime enforces safe toolsets and approval boundaries;
  remove or block any effective `--yolo` path before beta.
- [x] Reproduce the observed long-running profile timeout, add failing process-tree and
  stop-contract tests, deploy the runtime cancellation fix, and prove no child process or
  late completion survives the timeout boundary.
- [x] Preserve pause/resume for an active direct Work Conversation with no subordinate tasks,
  while retaining the plan gate for taskless draft work.

### Phase 4 — Notification And Feedback Closure

- [x] Bound the minimized report summary to Telegram's 4,096-character message contract while
  preserving the sanitized session deep link.
- [x] Register and verify a derived Telegram webhook secret so an allowlisted chat ID alone
  cannot authenticate a public webhook request.
- [ ] Validate Telegram configuration without logging token or chat identifiers.
- [ ] Send one safe minimized report summary to the owner's allowed chat.
- [x] Verify deep link, delivery state, usefulness feedback, and follow-up decision persistence.

### Phase 5 — Targeted Refactoring

- [x] Split beta-touched runtime safety coverage into a focused test file so failures remain diagnosable.
- [x] Extract stable command-runner, deep-link, scheduler acceptance, and persistence seams.
- [x] Keep behavior pinned by characterization tests and rerun the owning gate after each move.

### Phase 6 — Release Candidate Evidence

- [ ] Run all automated and live acceptance gates against one revision.
- [x] Record artifact names, SHA-256 hashes, signature assessment, deployment ID, smoke
  outcomes, skipped external gates, and rollback result in `docs/evidence/`.
- [x] Perform a final architecture, security, and UX regression review.
- [ ] Mark this plan Verified only when every personal beta gate has direct evidence.

## Rollback And Fallback

- Backend: retain the last-known-good Railway deployment ID and redeploy/rollback to it if
  health, migration compatibility, daemon, or relay smoke fails.
- Desktop: retain the prior DMG/ZIP and user data location; do not migrate persisted meaning
  without a backward-compatible migration and tested rollback story.
- Runtime: if safe profile execution cannot be enforced, disable task execution and expose
  blocked/unavailable state rather than falling back to another profile or provider.
- Telegram: unset delivery variables or disable delivery if minimization or allowlist checks
  fail; report generation remains successful with a separate delivery failure state.
- Code: revert only the beta patch set; preserve unrelated pre-existing worktree changes.

## Dependencies

- Railway CLI login and project linkage for deployment and read-only state checks.
- Online Mac mini bridge and an enabled safe profile for live execution.
- Owner-provided Telegram bot token and allowed chat ID for acceptance gate 11.
- Apple Development identity for current-machine signing; Developer ID Application identity
  and notarization credentials only for public external distribution.

## Verification Notes

- Command: `npm run test:backend`
  - Result: baseline 219/219 passed after replacing one timing-based test wait with an
    observed persistence completion latch.
- Command: `npm --workspace apps/desktop run test`
  - Result: baseline 130/130 passed; Vite HMR port warning is non-fatal test noise.
- Command: `npm test`
  - Result: baseline backend 219/219 and desktop 130/130 passed.
- Command: environment readiness inspection
  - Result: Railway daemon/interval/DB variables exist; Telegram variables are absent;
    one Apple Development identity exists and no Developer ID readiness was found.
- Command: `npm run verify:beta`
  - Result: backend syntax, typecheck, backend 231/231, desktop 133/133, and production
    desktop build passed in one fail-fast command.
- Command: `npm --workspace apps/desktop run dist:mac`
  - Result: hardened arm64 app, DMG, and ZIP built successfully with code signing forced;
    notarization was truthfully skipped because credentials are absent.
- Command: `codesign --verify --deep --strict --verbose=2 <app>`
  - Result: valid on disk, designated requirement satisfied, hardened runtime flag `0x10000`,
    and only JIT/unsigned executable memory entitlements present.
- Command: packaged app launch with isolated user data
  - Result: production Electron bundle stayed running and rendered the real login surface;
    no development server was involved and the smoke process exited cleanly.
- Command: `spctl --assess --type execute --verbose=4 <app>`
  - Result: rejected for public distribution as expected for the available Apple Development
    identity without Developer ID notarization; this is not represented as a public artifact.
- Command: live configured-runtime desktop browser workflow
  - Result: Hermes Work Conversation, 21 progressive answer frames, follow-up, reload,
    responsive layout, and console streaming passed with 92 API responses and no console errors;
    a live pause/resume/reload cycle exposed and then verified the taskless-resume correction,
    and the synthetic work was cancelled after verification.
- Command: live asynchronous report execution
  - Result: `run-now` returned HTTP 202 in 735ms, then completed independently with a ready
    structured report, five evidence rows, persisted feedback, and no external follow-up action.
- Command: live Mac mini stop smoke
  - Result: stop was confirmed in 209ms; the complete process group was gone, persisted state
    remained `stopped`, and no late completion occurred.
- Command: final deployment and relay smoke
  - Result: Railway deployment `c9648f94-5086-450f-b24c-4f1f684bb430` is `SUCCESS`
    with image `sha256:5fa8cbc9a64d0bad3a48d15240a64e57a858de1e91726183a3204a2edc1bec0a`;
    effective runtime access is online through the relay with zero pending or active relay jobs,
    and the public Telegram webhook returned HTTP 401 for an unsigned synthetic request.
- Command: packaged deep-link smoke
  - Result: cold launch, already-running app routing, and invalid URL rejection all passed.
- Command: `node apps/desktop/tests/playwright-agent-work-live.cjs`
  - Result: 213 ordered checkpoints, keyboard-only delegation and approval, responsive
    scroll ownership, and single-flight aggregate/conversation refresh all passed.
- Command: `node apps/desktop/tests/playwright-agent-work-gateway-e2e.cjs`
  - Result: real local gateway SSE, persisted file-store restart recovery, responsive layout,
    and 81 successful API responses passed.
- Command: CI workflow source and action-reference verification
  - Result: YAML parsing, production-bundle path presence, 14-day artifact retention, and all
    three full-length action SHAs resolved against their official GitHub repositories.
- Command: focused Telegram boundary contracts
  - Result: an 8,641-character pre-fix summary failed RED; the bounded summary, intact session
    deep link, outbound raw-token redaction, and central persistence redaction passed GREEN.
    A forged allowlisted update then failed RED because registration had no secret; derived
    webhook registration, missing/wrong-secret HTTP 401 rejection, and exact-secret acceptance
    passed GREEN without storing a token fixture.

## Remaining Risks

- Risk: Telegram credentials require owner coordination and a real external message.
  - Mitigation: finish all independent gates first; revoke every exposed token and configure
    only fresh values directly through the deployment environment without echoing or persisting them.
- Risk: the installed Mac mini runtime is not source-controlled with this repository.
  - Mitigation: capture its effective version/capability contract and fail closed when it
    cannot enforce safe execution; document a reproducible runtime update path.
- Risk: gateway and desktop entry modules are oversized and costly to review.
  - Mitigation: extract only beta-touched stable seams behind passing characterization tests;
    track broader decomposition separately from the release critical path.
- Risk: Apple Development signing is not equivalent to Developer ID notarized distribution.
  - Mitigation: call the artifact a personal beta; add the notarization path and keep public
    distribution explicitly blocked until the required Apple credentials exist.
- Risk: the deployed source is an uncommitted working-tree snapshot rooted at
  `6b0397434e73788424d99e6deb3f87e14912873d`.
  - Mitigation: record the backend diff digest and deployment image digest; create a reviewed
    release commit before sharing or advancing the beta.
- Risk: two-week usefulness cannot be compressed into an implementation session.
  - Mitigation: ship instrumentation and a dogfood checklist, then evaluate the North Star
    after two consecutive weekly cycles without representing that rollout result as preknown.
