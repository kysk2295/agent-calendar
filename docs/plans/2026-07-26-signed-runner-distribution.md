# Plan: Signed Runner distribution and verified update path

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Trusted-manifest remediation verified locally; external signing/publication gates blocked

## Goal

Produce a reproducible Runner archive containing only the intended `bin/` and
`lib/` runtime plus package metadata, bind it to an Ed25519-signed manifest and
supply-chain evidence, and install it through a fail-closed, atomic
N-1-to-N-to-rollback flow that preserves enrolled Runner identity and device
state. Expose only structurally valid, signed release metadata as
`verified_signed` through Backend and Desktop.

## Non-Goals

- Do not publish a release, contact external release services, or access signing
  credentials.
- Do not claim Developer ID signing, notarization, stapling, or clean-host
  validation without credentialed external evidence.
- Do not change Desktop packaging, widget integration, DB schemas, enrollment
  meaning, or Runner device-state storage.
- Do not install a package system-wide or modify an existing user Runner
  installation.

## Touched Boundaries

- Backend gateway: validated Runner release-manifest projection in
  `apps/backend/app/lib/runner-control.js`.
- Backend library: release metadata validation only; no route/schema widening.
- DB/migrations: none.
- Electron bridge: none.
- React UI: strict release-artifact parsing in
  `apps/desktop/src/features/runner/runnerApi.ts`; narrowly related truthful
  presentation only if required by tests.
- Runner update boundary: deterministic artifact production, pinned Ed25519
  trust, archive verification/extraction, atomic promotion, health-check
  rollback, bootstrap `.pkg` production and signing/notary preflight.
- Tests: focused Runner release artifact/manager/rollback tests, Backend
  manifest mapping tests, Desktop Runner API/presentation tests.
- Docs: this plan, release workflow notes, and task evidence.

## Success Criteria

- [x] Two clean builds from identical scoped inputs produce byte-identical
  deterministic Runner archives containing only `package/package.json`,
  `package/bin/**`, and `package/lib/**`.
- [x] The release command emits an Ed25519-signed canonical manifest with a
  pinned key identifier, `SHA256SUMS`, CycloneDX SBOM, and provenance whose
  hashes match the archive and source fingerprint.
- [x] Unknown signer, bad signature, digest/size/name mismatch, stale or
  downgraded version, invalid protocol/state compatibility, path traversal,
  links, malformed archive, and prompt-injection-shaped metadata fail closed.
- [x] Install uses task-owned paths and atomic pointers; interruption never
  leaves a partial `current`, and forced post-promote failure visibly returns
  `current` to N-1 while preserving device-state bytes.
- [x] A deterministic macOS bootstrap `.pkg` can be produced locally; Developer
  ID signing, notarization, stapling, and draft publication preflights fail
  closed when credentials/authority are missing or invalid.
- [x] Backend emits `verified_signed` only for a complete, internally consistent
  release record; malformed/unverified input becomes `unavailable`.
- [x] Desktop independently maps `verified_signed` only from a complete valid
  artifact and otherwise presents it as `unavailable`.
- [x] The manual rehearsal records N-1 identity digest, accepted signed N,
  reconnection observable, forced rollback, unchanged device-state digest,
  tamper/downgrade/traversal rejection, and cleanup with no surviving process,
  temp root, fixture private key, symlink, or port.
- [x] All local evidence records exact commands, binary observables, scoped
  source/artifact fingerprints, and explicit external-boundary limitations.

## Edge Cases

- Unknown or rotated key ID not present in the trusted keyring.
- Duplicate JSON fields, invalid base64, extra unsigned metadata, future/stale
  generated time, same-version reinstall, downgrade, or incompatible protocol
  and state schema.
- Absolute paths, `..`, backslashes, hard links, symlinks, devices, and files
  outside the allowed archive tree.
- Cancellation/interruption during verify, extract, promote, and post-promote
  health check; hung subprocess bounded by timeout.
- Dirty shared worktree: source fingerprint is scoped to release inputs and does
  not include unrelated changes.
- No previous release exists when the first install health check fails.

## Test Plan

Product tests are written and observed failing before implementation.

- RED:
  - [x] Deterministic package test builds twice from clean copied inputs and
    requires equal archive SHA-256.
  - [x] Release artifacts tests require manifest/key ID, sums, SBOM,
    provenance, bootstrap `.pkg`, and credential-gated preflight receipts.
  - [x] Release manager tests reject unknown key, tamper, mismatch, stale
    version, incompatibility, traversal/link entries, interrupted promotion,
    and post-promote failure without identity mutation.
  - [x] Backend tests reject malformed/unverified release input instead of
    relabeling it.
  - [x] Desktop tests prevent malformed payloads from becoming
    `verified_signed`.
- GREEN:
  - [x] Add the smallest deterministic packager and evidence emitters.
  - [x] Tighten manifest validation and atomic update transaction.
  - [x] Add strict Backend and Desktop boundary parsers.
  - [x] Extend the task-owned rollback rehearsal with cleanup assertions.
- REFACTOR:
  - [x] Share canonical validation helpers only where doing so does not widen a
    runtime boundary; keep tests green.

## Acceptance Gates

- [x] `npm --workspace apps/runner run check`
- [x] focused `node --test` Runner release manager/artifact tests
- [x] focused Runner artifact test command documented below
- [x] focused Backend Runner manifest test
- [x] focused Desktop Runner API/presentation test
- [x] `npm run backend:check`
- [x] `npm run typecheck`
- [x] `npm run build:desktop` because a Desktop build input changed
- [x] deterministic two-build SHA-256 comparison
- [x] `EVIDENCE_DIR=.omo/evidence/production-readiness-completion/task-13/manual node apps/runner/tools/phase10-runner-rollback-rehearsal.cjs`
- [x] repeat update/rollback rehearsal at least three times

Deterministic package command:

`node apps/runner/tools/runner-release-artifacts.cjs build --source apps/runner --output-dir <task-owned-output> --version 0.1.0 --commit-sha <40-lowercase-hex>`

Credential-gated local bootstrap command:

`node apps/runner/tools/runner-release-artifacts.cjs bootstrap-pkg --archive <archive> --output <task-owned.pkg> --identifier com.agentcalendar.runner --version 0.1.0`

Skipped gates:

- `npm test`: shared/full suite must not run concurrently and is broader than
  the owned boundary; focused gates plus syntax/typecheck are required.
- Developer ID/notary/staple/draft publish: blocked at missing credentials and
  external clean-host/publication authority; only fail-closed preflight is
  locally verifiable.
- System `.pkg` install/UI: never install system-wide without explicit
  authority; inspect only task-owned unsigned output if a local UI inspection is
  useful.

## Acceptance Gates Detail

- Archive hash gate: two isolated output roots, exact archive digest equality,
  allowed-entry listing, and no leaked private key.
- Signature gate: pinned trusted key ID and public key verification; unknown key
  and tamper return non-zero/error.
- Atomicity gate: filesystem `current` resolves wholly to N or N-1, never an
  intermediate path.
- Identity gate: SHA-256 of test-authorized enrolled device-state files is
  unchanged before and after rollback.
- Boundary gate: Backend and Desktop independently refuse misleading
  `verified_signed`.
- Cleanup gate: registered task temp roots and key fixtures are absent,
  processes terminated, and registered ports closed.

## Implementation Checklist

- [x] Step 1: Capture PIN behavior and scoped source fingerprints.
- [x] Step 2: Add RED tests and capture expected failing observables.
- [x] Step 3: Implement deterministic archive, supply-chain outputs, trusted key
  ID, bootstrap package, and credential preflight.
- [x] Step 4: Harden verification, extraction, promotion, interruption, health
  rollback, and receipts.
- [x] Step 5: Harden Backend-to-Desktop verified manifest mapping.
- [x] Step 6: Run focused GREEN gates, deterministic comparison, and three
  manual rollback rehearsals.
- [x] Step 7: Record hashes, rollback/external-boundary receipts, cleanup proof,
  remaining external blockers, and DoneClaim.

## Verification Notes

- Command: focused gates in
  `.omo/evidence/production-readiness-completion/task-13/green/final-focused-gates.log`.
  - Result: Runner syntax 0; final Runner release tests 12/12 (see
    `green/final-runner-release-tests.log`); Backend mapping 1/1; Desktop
    mapping/presentation 6/6.
- Command: Backend check, Desktop typecheck, and Desktop build in
  `.omo/evidence/production-readiness-completion/task-13/green/broad-gates.log`.
  - Result: all exited 0; Vite emitted only the pre-existing large-chunk
    advisory.
- Command: final Backend mapping and syntax gate after nested signed-manifest
  projection support in
  `.omo/evidence/production-readiness-completion/task-13/green/final-backend-gates.log`.
  - Result: mapping test and Backend syntax exited 0.
- Command: deterministic builds recorded in
  `.omo/evidence/production-readiness-completion/task-13/artifacts/reproducibility-receipt.json`.
  - Result: archive SHA-256 equality true; scoped source SHA-256 equality true.
- Command: three final manual rehearsals under
  `.omo/evidence/production-readiness-completion/task-13/manual/`.
  - Result: all report rollback observed, identity preserved, and cleanup true.

## Remaining Risks

- Developer ID certificate access, Apple notarization/stapling, draft release
  upload, and external clean-host validation remain external authority gates.
  The implementation must expose these as explicit blockers, never as success.
- macOS package production depends on `/usr/bin/pkgbuild`; tests must report an
  explicit environment limitation if unavailable.
- Shared worktree changes are preserved; completion evidence uses scoped hashes
  rather than asserting a clean repository.

## Independent-review trusted-manifest remediation

The independent gate found that Backend/Desktop format checks could label
caller-asserted verification and arbitrary 64-byte signature data as
`verified_signed`. This is a local blocking defect and supersedes the earlier
local completion claim.

### Remediation success criteria

- [x] PIN the current path where syntactically plausible arbitrary signature
  bytes become `verified_signed`.
- [x] RED proves self-asserted verification, unknown/wrong key ID, wrong trusted
  key, signed-field tamper, stale manifest, and malformed signature all become
  unavailable.
- [x] Backend verifies the canonical manifest with Ed25519 against a
  server-owned trusted key map and derives the public verification receipt
  itself. Caller-provided `status`/`verification` never supplies authority.
- [x] Backend composition loads release manifest and public trust roots only
  from explicit server configuration and fails closed on invalid configuration.
- [x] Desktop accepts only the Backend-derived verification receipt with exact
  manifest/artifact/key binding; the prior self-asserted payload is unavailable.
- [x] Focused Backend/Desktop/Runner tests, Backend check, Desktop typecheck and
  build, deterministic two-build comparison, one rollback rehearsal, manual
  valid/tamper data scenario, and cleanup all pass.
- [x] External receipt remains explicit: no Developer ID signing,
  notarization/stapling, draft publication, or clean-host claim.

### Remediation TDD checklist

- [x] Capture current PIN and scoped source hashes.
- [x] Add and capture genuine cryptographic RED tests before product edits.
- [x] Implement the smallest Backend trusted-manifest verifier/composition and
  Desktop receipt parser.
- [x] Run GREEN, manual data-path QA, adversarial repetitions, and cleanup.
- [x] Record the remediation DoneClaim and updated external-boundary receipt.
