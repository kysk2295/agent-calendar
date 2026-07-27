# Plan: Signed Web signup/download/support handoff

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / security boundary
- Status: Verified (repository-local boundary only)

## Goal

Bind the Web signup and Desktop download controls to one cryptographically verified,
fresh release receipt whose version, full source commit, public artifact bytes,
SHA-256, notarization, staple, attestation, and operational ownership agree.
Removing or invalidating that receipt must close signup/download while `/support`
remains reachable.

## Non-Goals

- Do not deploy, publish, change Sites access, contact external URLs, use release
  credentials, create WorkOS accounts, sign/notarize artifacts, or claim a local
  fixture is production release evidence.
- Do not change Runner/Desktop trust implementations or the Todo 13/14 release
  workflow currently owned by other worktree participants.
- Do not mark Todo 16 complete; staging/public access and real external journeys
  remain separately authorized operational gates.

## Work Size

Large. This changes the release-evidence-to-Web configuration security boundary,
the React landing controls, release tooling, automated contracts, and production
build browser QA.

## Touched Boundaries

- Backend gateway: none
- Backend library: none
- DB/migrations: none
- Electron bridge: none
- React UI: `apps/web/app/page.tsx`
- Web release policy/tooling: `apps/web/lib/**`, `apps/web/tools/**`
- Tests: `apps/web/tests/**`
- Docs: this plan and task-scoped evidence/DoneClaim

## Success Criteria

- [x] `NEXT_PUBLIC_DESKTOP_VERIFIED=true` and manual URLs/version/hash alone leave
  both signup and download closed.
- [x] The producer reads actual artifact bytes, recomputes SHA-256 and size, and
  requires exact stable version, 40-character source commit, signed/notarized/
  stapled candidate evidence, fresh attestation binding, and a trusted Ed25519
  signature before atomically emitting bounded deployment values.
- [x] Tampered bytes, wrong SHA/version/commit, stale or missing notary/staple/
  attestation, malformed input, and absent support/security/status/rollback
  ownership fail closed without a partial output.
- [x] Web re-verifies the signed receipt and only exposes its signed signup/download
  destinations. The shipped page has no local trust-selection branch; an explicit
  QA-only composition verifies and injects loopback controls outside the production
  bundle with a visible non-production marker.
- [x] `/support` remains HTTP 200 and linked in closed, locally-open, and rollback
  states.
- [x] Production build browser QA clicks rendered signup/download/support controls,
  verifies downloaded task-owned bytes by SHA-256, captures screenshots/statuses,
  and proves cleanup.

## Edge Cases

- Receipt or candidate JSON is malformed, oversized, has extra/unknown semantics,
  or contains non-stable version/full commit/digest values.
- Signed receipt is expired, issued too far in the future, binds another candidate
  evidence file, or disagrees with public artifact bytes.
- Release booleans or operational ownership are missing/false, even if the legacy
  verified flag is true.
- Untrusted release/support text contains markup or instructions; it is never
  rendered or executed.
- Producer/server is interrupted; atomic output and task-owned processes/ports must
  not survive.

## Test Plan

Product behavior is changed only after PIN and RED are captured.

- PIN:
  - [x] Characterize the unchanged policy: an HTTPS signup opens independently and
    the legacy verified flag plus URL/version/hash opens download.
- RED:
  - [x] Desired policy rejects the legacy flag without a signed receipt.
  - [x] Real producer tests reject tamper, mismatch, stale/missing trust evidence,
    and missing operational owners; valid local cryptographic fixture passes.
- GREEN:
  - [x] Implement canonical signed receipt verification, atomic producer output,
    and async fail-closed Web policy.
- REFACTOR:
  - [x] Share validation/canonicalization without weakening behavioral assertions.

## Acceptance Gates

- [x] `node --test apps/web/tests/handoff-characterization.test.mjs`
- [x] `node --test apps/web/tests/signed-handoff-producer.test.mjs apps/web/tests/handoff-policy.test.mjs`
- [x] Repeat the narrow critical gate three times
- [x] `npm run lint:web`
- [x] `npm run build:web`
- [x] `npm run test:web`
- [x] `node apps/web/tools/local-signed-handoff-qa.mjs --evidence-dir .omo/evidence/production-readiness-completion/task-16/repository-handoff/manual-qa`

Skipped non-Web gates:

- Backend/Desktop/Runner/widget gates:
  - Reason: no files or contracts in those product boundaries are changed.

## Acceptance Gates and Fallback

The only open state is a valid signed receipt. Rollback removes the receipt
deployment values and restarts/redeploys the same Web build; support and trust
routes remain available. Any parse, crypto, freshness, byte, ownership, or runtime
failure selects the closed state.

## Implementation Checklist

- [x] Step 1: capture scoped dirty-worktree fingerprints and PIN.
- [x] Step 2: add and capture failing producer/policy security tests.
- [x] Step 3: implement signed receipt primitives and evidence producer.
- [x] Step 4: bind landing controls to the verified receipt with stable selectors.
- [x] Step 5: pass narrow and full Web gates.
- [x] Step 6: run production-build browser QA and all nine adversarial classes.
- [x] Step 7: record hashes, cleanup receipt, external gaps, and DoneClaim.

## Verification Notes

- Command:
  - Result: PIN 1/1 passed before product change; expected RED exited 1.
- Command: narrow signed handoff suite
  - Result: 22/22 passed, repeated three times with exit code 0.
- Command: `npm run lint:web`
  - Result: exit code 0, no warnings or errors.
- Command: `npm run build:web`
  - Result: exit code 0, four routes built.
- Command: `npm run test:web`
  - Result: exit code 0, 29/29 passed with build included.
- Command: required local browser QA invocation
  - Result: closed/open/rollback and support 200 in all states; downloaded 45-byte
    fixture SHA-256 matched; three styled screenshots; zero external requests.
- Command: interruption QA
  - Result: three producer SIGTERM attempts left no output, resume parsed and
    succeeded, normal production server rejected the local receipt, and SIGTERM
    closed its ephemeral listener.

## Remaining Risks

- A real signed/notarized public Desktop artifact, protected release signer, WorkOS
  signup, support/security owners, public deployment, exact public-byte download,
  and access rollback cannot be proven locally and remain blocking external gates.
- The repository-pinned Web release public key has no private key in this
  repository. Provisioning the authorized release signer requires a reviewed
  trust-root rotation, signed receipt, and rollback rehearsal before public use.
