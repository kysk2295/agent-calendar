# Plan: Phase 10 Mobile entry gate

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / security and release boundary
- Status: In progress — atomic bundle v2 remediation

## Goal

Replace the unsafe multi-file directory snapshot with one bounded
`phase10-mobile-entry-bundle/v2` file. The evaluator must open that file exactly
once with `O_RDONLY | O_NOFOLLOW`, read one buffer from that descriptor, and
evaluate only the captured bytes. Production authority must sign the exact
canonical bundle digest plus all existing source, deployment, candidate,
artifact, receipt, environment, time, private-beta, and legacy bindings.

The legacy v1 directory evaluator must fail closed with
`legacy_directory_snapshot_unsupported`; it may not reconstruct, fall back to,
or evaluate the old directory snapshot.

## Non-Goals

- Do not create or modify `apps/mobile`.
- Do not select or request a Mobile platform, minimum OS, store, or device matrix.
- Do not deploy, contact external services, sign production evidence, or alter
  upstream Todo 9/13-19 evidence producers.
- Do not mark Todo 20 complete or edit the parent readiness plan/ledger.

## Touched Boundaries

- Backend library: the Phase 10 Mobile entry parser/evaluator and pinned public
  trust root under `apps/backend/app/lib/`, migrated to an atomic bundle reader.
- Tests: focused Node tests under `apps/backend/tests/`.
- Tools: one bounded evaluator CLI and one data-shaped manual-QA CLI under
  `apps/backend/tools/`.
- Docs: this plan, an operations contract/schema, and task-owned evidence.
- Mobile, Desktop, Electron, Web, Runner, Widget, DB/migrations: untouched.

## Success Criteria

- [ ] Nine exact criteria cover signed candidates, private beta, WorkOS/live
  readiness, hostile isolation, Telegram continuity, signed Web handoff,
  observability/SLO, managed DR/rollback, and legacy lifecycle.
- [ ] Every criterion is schema-, digest-, source-, deployment-, artifact-,
  environment-, time-, and authority-bound with deterministic reason codes.
- [ ] One bounded regular v2 file is opened once with
  `O_RDONLY | O_NOFOLLOW`, read once from the same descriptor, and evaluated
  only from captured bytes.
- [ ] A complete local fixture reports `contractComplete=true` while
  `mobileEntryReady=false` and `platformDecisionEligible=false`.
- [ ] Only an unexpired final envelope signed by the repository-pinned Ed25519
  production root can authorize both production flags.
- [ ] The v1 directory evaluator always reports
  `legacy_directory_snapshot_unsupported` and performs no reconstruction.
- [ ] No caller key, argument, environment value, narrative, callback, or manual boolean
  can override the gate.
- [ ] Manual QA emits per-case `inputDigest`, `capturedBundleDigest`,
  `exitCode`, all four gate booleans, and reason codes for the happy path and
  every required filesystem, authority, criterion, temporal, override, and
  interruption adversary.

## Edge Cases

- Malformed, oversized, or truncated bundle; duplicate, unknown, or missing
  criterion; non-regular input; terminal or parent symlink; partial write.
- Former hard-link root replacement, immediate pathname replacement after open,
  and same-size mutation of the opened inode during read.
- Stale/future/expired evidence and mismatched source, deployment, candidate,
  artifact, environment, receipt digest, private-beta reset, or legacy decision.
- Local-only upstream outputs, forged caller keys, self-signed/tampered/expired
  envelopes, manual success flags, and prompt-injection narrative.

## Test Plan

- RED:
  - [ ] Pin current client-v1/route behavior and capture the historical v1
    complete-local observation separately from the new expected behavior.
  - [ ] Retain the real hard-link replacement exploit as the architectural RED.
  - [ ] Add behavioral RED tests for mandatory v1 rejection and v2 descriptor
    capture; a missing-module assertion alone is insufficient.
- GREEN:
  - [ ] Implement the one-open/one-read bundle parser, deterministic evaluator,
    pinned authority verification, atomic CLI output, and manual-QA matrices.
- REFACTOR:
  - [ ] Keep canonical serialization and fixture helpers small while tests stay green.

## Acceptance Gates

- [ ] Focused new Node test, including descriptor-race adversaries.
- [ ] Focused Phase 10 client-v1, route lifecycle, private-beta, release/evidence suites.
- [ ] `npm run backend:check`
- [ ] Schema/CLI syntax checks and three repeated critical matrix runs.

Skipped gates:

- Desktop/Runner/Web/Mobile/full-suite gates: outside the narrow ownership and
  explicitly excluded by this task.

## Implementation Checklist

- [ ] Pin current behavior and historical v1 local-complete observation.
- [ ] Capture behavioral RED for v1 rejection and atomic v2 descriptor semantics.
- [ ] Implement bundle v2 schema/evaluator/CLI and unconditional v1 rejection.
- [ ] Run GREEN and focused regression gates.
- [ ] Run the exact manual-QA command and independent evidence audits.
- [ ] Record scoped hashes/diff, cleanup, no-Mobile-write audit, and DoneClaim.

## Verification Notes

- The v1 directory implementation passed its prior suites but an independent
  same-path hard-link replacement bypass remained reproducible. Those reports
  are historical evidence only and do not satisfy the v2 gate.

## Remaining Risks

- Real external authority evidence is intentionally unavailable, so this task
  cannot make the production gate green or complete Todo 20.
- The pinned production public root requires an independently controlled signer;
  its private key is not present in this repository or generated by local QA.
- POSIX descriptor semantics are required for `O_NOFOLLOW`; unsupported hosts
  must fail closed rather than silently weaken the open.

## Rollback / Fallback

Keep the v1 evaluator in unconditional fail-closed mode and remove only the v2
reader/evaluator, focused tests/tools, schema/runbook changes, and task-owned
evidence. No runtime route is modified, and false remains the safe result for
missing or unsupported evidence.
