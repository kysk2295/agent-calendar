# Plan: Staging WorkOS clean-account evidence harness

- Date: 2026-07-26
- Owner: Codex
- Work size: Boundary
- Status: Verified locally; live staging authority remains external

## Goal

Provide a repository-side, non-mutating harness that fails closed unless a
secret-manager-delivered configuration identifies a non-local staging candidate.
The harness must produce only bounded deployment/commit/environment/service
binding data and must reject local, injected, or fake identity paths.

## Non-Goals

- Do not create WorkOS users or accounts.
- Do not deploy, promote, roll back, or mutate Railway state.
- Do not run the delegated-work journey without separately supplied live staging
  authority.
- Do not persist credentials, URLs, account identifiers, cookies, tokens, or PII.

## Touched Boundaries

- Backend gateway: unchanged.
- Backend library: staging candidate validation and bounded preflight result.
- DB/migrations: unchanged.
- Electron bridge: unchanged.
- React UI: unchanged.
- Tests: backend contract and CLI subprocess tests.
- Docs: this plan and the production release runbook.

## Success Criteria

- [x] Current candidate-readiness evidence behavior is pinned before changes.
- [x] Local/loopback endpoints, fake engines, injected AuthKit, inline secrets,
      malformed input, and prompt-like override fields are rejected before fetch.
- [x] Live mode accepts configuration only through an explicit
      secret-manager-delivery environment contract.
- [x] Missing external authority produces a nonzero, machine-readable blocked
      result containing only capability categories.
- [x] Candidate output binds deployment, full commit, environment, and service
      without URL, identity, credential, or arbitrary input fields.
- [x] A hostile CLI run is bounded, repeatable, redaction-safe, and leaves no
      subprocess behind.

## Edge Cases

- Malformed/oversized JSON: bounded rejection without reflecting input.
- Localhost, loopback IP, private/link-local IP, or credentialed URL: reject.
- Dirty worktree: binding records the requested commit only; it does not infer or
  claim the current checkout is clean.
- Stale capture/binding: reject report capture outside the bounded freshness
  window.
- Cancellation or timeout: the synchronous preflight performs no spawn/network
  action; interrupted invocations leave no child process.

## Test Plan

- RED:
  - [x] Characterize the current candidate readiness producer.
  - [x] Add failing library/CLI tests for hostile identity and redacted binding.
- GREEN:
  - [x] Add the smallest validator, candidate-binding producer, and CLI.
  - [x] Emit bounded `blocked` preflight output when authority is unavailable.
- REFACTOR:
  - [x] Keep public errors/category output allowlisted and JSON size bounded.

## Acceptance Gates

- [x] Focused staging harness tests.
- [x] Existing candidate and clean-account release-evidence tests.
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] Relevant syntax and CLI manual QA.
- [x] Secret scan of owned source and evidence.

Skipped gate:

- Live staging clean-account journey:
  - Requires user-provided secret-manager authority and a real staging identity;
    this task may only record a bounded blocked preflight.
- Desktop typecheck/build:
  - No TypeScript, Electron, React, or built Desktop code changes.

## Implementation Checklist

- [x] Step 1: PIN existing candidate evidence.
- [x] Step 2: RED hostile input and bounded-output tests.
- [x] Step 3: GREEN library and CLI.
- [x] Step 4: Run manual hostile/repetition/malformed/timeout probes.
- [x] Step 5: Record evidence, cleanup receipt, secret scan, and DoneClaim.

## Rollback

Remove the new harness library, CLI, tests, and package script. Existing candidate
and clean-account evidence contracts remain unchanged.

## Verification Notes

- Command: `node --test apps/backend/tests/phase10-candidate-readiness-evidence.test.cjs`
  - Result: PIN passed 4/4 before product changes.
- Command: focused staging/candidate/clean-account tests
  - Result: passed 19/19.
- Command: `npm run backend:check`
  - Result: passed, including the new library and CLI syntax checks.
- Command: `npm run test:backend`
  - Result: passed 550/550.
- Command: hostile CLI preflight, repeated five times
  - Result: exit 2, exact 121-byte bounded rejection every run; five runs
    completed in 546 ms with no remaining process.
- Command: live preflight with staging delivery variables absent
  - Result: exit 1 with only four non-sensitive missing capability categories.

## Remaining Risks

- A repository preflight cannot prove external account ownership or secret-manager
  policy by itself. It deliberately stops before the live journey when those
  capabilities are absent.
