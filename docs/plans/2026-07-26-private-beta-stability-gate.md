# Plan: Phase 10 private-beta stability evidence gate

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified (repository-local contract only; external gate remains open)

## Goal

Provide a repository-local collector and evaluator for a strict, redaction-safe
28-consecutive-24-hour UTC private-beta evidence window bound to one named-by-digest
cohort/operator, one source/candidate set, and two distinct signed Desktop+Runner
candidates installed through verified update receipts.

The repository contract may be exercised with explicitly labelled
`local_contract_only` receipt chains. It must not claim that the actual private-beta
clock has started or that Todo 19 is complete.

## Non-Goals

- Do not install, sign, publish, deploy, promote, roll back, or offer a release.
- Do not contact alerting, support, backup, update, signing, or identity providers.
- Do not schedule collection or start the real 28-day clock.
- Do not store cohort identities, operator identities, incident/support content,
  credentials, URLs, tokens, or customer data.
- Do not modify Desktop, Runner, Web, Mobile, the parent production plan, Todo
  checkbox, Boulder, or completion ledger.

## Touched Boundaries

- Backend gateway: unchanged
- Backend library: private-beta receipt normalization, integrity chain, and evaluator
- DB/migrations: unchanged
- Electron bridge: unchanged
- React UI: unchanged
- Tests: focused Node tests for the collector/evaluator contract and CLI
- Docs: this plan and the private-beta evidence operations contract
- Tools: repository-local collector/evaluator CLI and manual QA producer

## Success Criteria

- [x] Every receipt is schema-bound, digest-bound, redaction-safe, and written atomically.
- [x] Readiness requires exactly 28 contiguous 24-hour UTC windows after the latest
      qualifying P0/P1 incident or rollback reset.
- [x] Readiness requires two distinct candidate installs, each binding exact Desktop
      and Runner release IDs, source SHA, signed-artifact receipts, and verified-update
      receipts.
- [x] Daily alert/support/backup/Runner/update evidence and covering weekly reviews are
      complete and bound to the exact cohort/operator/source/candidate set.
- [x] Missing, duplicate, overlapping, partial, future, stale, mismatched, unsigned,
      manual, narrative, unresolved P0/P1, and reset cases fail closed with bounded
      reason codes.
- [x] A reset closes signup and update offers until a new complete post-reset window passes.
- [x] The manual QA runs the real filesystem collector/evaluator and retains parsed,
      independently recomputed, redaction-checked artifacts.
- [x] Documentation and DoneClaim state that full Todo 19 is incomplete and the real
      28-day clock has not started.

## Edge Cases

- 27 windows, a missing middle window, duplicate start, or overlap:
  - fail with exact bounded window reason codes.
- Local-time or DST-shaped timestamps:
  - only canonical UTC `Z` timestamps and exact 86,400,000 ms windows are accepted.
- Same candidate twice, missing signed/update receipt, or manual install:
  - fail candidate eligibility.
- A resolved P0/P1:
  - still resets the clock at incident open time; unresolved incidents also block readiness.
- A rollback or incident after a previously green output:
  - prior days remain retained but do not count; signup and update offers close.
- Interrupted collector write:
  - temporary/partial output is never accepted and is reported as a partial write.

## Test Plan

Product code follows the tests.

- RED:
  - [x] Characterize the current Phase 10 documentation/tool behavior first and capture PIN.
  - [x] Add failing tests for the complete adversarial matrix before the module/tool exists.
- GREEN:
  - [x] Implement strict receipt projection, SHA-256 chain validation, atomic collection,
        and pure evaluation.
  - [x] Implement bounded CLI and manual QA using actual receipt files.
- REFACTOR:
  - [x] Keep reason codes, public output, and receipt fields allowlisted and deterministic.

## Acceptance Gates

- [x] Focused private-beta collector/evaluator tests
- [x] Critical evaluator matrix repeated three times
- [x] Smallest affected Phase 10 release/operations/private-beta suites
- [x] `npm run backend:check`
- [x] `node --check` for each changed tool
- [x] Required manual QA command and parsed artifacts
- [x] Whitespace and JSON parse checks on owned files

Skipped gates:

- Desktop/Runner/Web/Mobile suites:
  - No product code in those boundaries changes.
- External/private-beta execution:
  - Required signed installed candidates, named cohort/operator, provider evidence, and
    elapsed incident-free time are absent and external mutation is prohibited.

## Implementation Checklist

- [x] Step 1: Capture current behavior PIN and genuine RED.
- [x] Step 2: Implement receipt collector and evaluator GREEN.
- [x] Step 3: Add repository CLI, operations contract, and manual QA.
- [x] Step 4: Run focused regressions, three repeats, adversarial probes, and cleanup checks.
- [x] Step 5: Record task evidence and an honest DoneClaim.

## Rollback / Fallback

The new module, tools, tests, operations document, plan, and task-local evidence are
standalone. Removing only those new files returns the repository to its prior behavior.
No external state, release state, or clock needs recovery.

## Verification Notes

- `node --test apps/backend/tests/phase10-private-beta-stability.test.cjs`
  - 28/28 passed on each of three consecutive runs after authority remediation.
- Focused Phase 10 candidate readiness, clean-account release evidence, operations
  collector, and release rollback suites
  - 36/36 passed.
- `npm run backend:check`
  - exited 0.
- `node --check` for the library and both tools
  - all three exited 0.
- Required local manual QA command
  - exited 0; complete fixture counted 28/672 hours, eleven adversarial cases failed
    closed, post-reset resume counted only 28 new windows, independent recomputation
    matched, partial collection/output resumed, and cleanup was true.
- Evidence root:
  - `.omo/evidence/production-readiness-completion/task-19/repository-private-beta/`

External gate result:

- Full Todo 19 is incomplete.
- The actual 28-day private-beta clock has not started.
- Actual signed installed candidates, named cohort/operator, independent daily
  evidence, and elapsed incident-free time are absent.

## Remaining Risks

- Repository-local simulated receipts validate only the contract and cannot substitute
  for externally signed installed candidates or 28 days of elapsed evidence.
- The eventual production collector needs independently operated retention, delivery,
  and the private-key authority issuer; this repository slice pins only the verifier
  public key and never contains or selects the signing private key.

## Authority remediation

Independent verification found that caller-authored `authorityMode` previously
controlled `actualClockStarted`/`publicationEligible`, duplicate weekly reviews were
accepted, and the original prose PIN/module-missing RED did not prove behavioral TDD.

The remediation:

- replaces caller authority with a strict Ed25519 envelope verified only against a
  repository-pinned production public key whose private key is unavailable locally;
- binds the envelope to the authority-free manifest, full receipt-chain root, exact
  candidate/install identities, cohort/operator digests, window/reset/count state,
  schema, source ID/SHA, and expiry;
- provides no environment, argv, callback, key, or trust-root override;
- makes every local external-authority request without the valid envelope fail with a
  bounded `production_authority_*` reason while both authority flags remain false;
- requires exactly one weekly review per expected interval;
- validates manifest and receipt uid ownership when `process.getuid()` is available;
- replaces the prose characterization with a real filesystem local-contract PIN and
  captures genuine behavioral REDs for the authority forgery and duplicate weekly
  review before remediation code.

Remediation evidence:

- `.omo/evidence/production-readiness-completion/task-19/repository-private-beta/authority-remediation/`

Full Todo 19 remains incomplete and the actual 28-day clock has not started.
