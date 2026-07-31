# Plan: Railway staging preflight dry run

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Give operators an explicit offline command that validates the Railway staging
preflight arguments and evidence documents without contacting Railway. Live
Live Railway commands must stop with an actionable error before making a request
when Railway credentials are absent or ambiguous.

## Non-Goals

- Deploying to or rolling back a live Railway environment.
- Creating staging resources or changing Railway environment variables.
- Storing tokens, connection strings, or user/workspace data in documentation or evidence.
- Replacing the existing release-gate evaluator or release workflow.

## Touched Boundaries

- Backend gateway: None.
- Backend library: No contract change expected; reuse the existing release-gate evaluator.
- DB/migrations: None.
- Electron bridge: None.
- React UI: None.
- Tests: `apps/backend/tests/phase10-release-rollback.test.cjs`.
- Docs: this plan and `docs/operations/production-release-rollback.md`.
- Operator CLI: `scripts/railway-release-gate.cjs`.

## Success Criteria

- [x] `dry-run` accepts only the documented local evidence inputs and performs no Railway call.
- [x] A valid evidence package exits zero and emits the existing bounded preflight result.
- [x] Invalid/missing/unsupported dry-run arguments or evidence exit non-zero with a clear error.
- [x] Live Railway snapshot and rollback commands reject missing or conflicting token inputs before API/CLI access.
- [x] The runbook explains staging preflight and rollback rehearsal without exposing secrets.

## Edge Cases

- Both `RAILWAY_API_TOKEN` and `RAILWAY_PROJECT_TOKEN` are set: fail closed because authentication intent is ambiguous.
- Neither token is set for a live Railway operation: fail before reading response data, calling `fetch`, or spawning the Railway CLI.
- Offline evidence is missing, malformed JSON, stale, future-dated, or bound to another candidate: return non-zero.
- An unsupported flag is supplied: reject it instead of silently ignoring it.

## Test Plan

Product code changes follow the CLI tests.

- RED:
  - [x] Add a CLI test proving `dry-run` succeeds with valid local evidence and no Railway credentials.
  - [x] Add CLI tests proving malformed dry-run arguments and missing-token live commands fail closed.
- GREEN:
  - [x] Reuse `evaluateRailwayPreflight` behind strict shared argument parsing.
  - [x] Add an explicit credential guard for live snapshot and rollback commands.
- REFACTOR:
  - [x] Share preflight input loading between `preflight` and `dry-run` while preserving output schema.

## Acceptance Gates

- [x] `node --test apps/backend/tests/phase10-release-rollback.test.cjs`
- [x] `npm run backend:check`
- [x] `npm run test:backend`

Skipped gates:

- Desktop typecheck/tests/build: no Desktop boundary is touched.
- Full repository test suite: backend suite is the broad relevant gate; other worktree changes are out of scope.
- Live Railway verification: explicitly excluded because this package must not deploy, roll back, or require credentials.

## Implementation Checklist

- [x] Step 1: Capture dry-run and fail-closed live-token behavior in tests.
- [x] Step 2: Implement strict offline input validation and credential guards in the existing CLI.
- [x] Step 3: Document secret-safe staging preflight and rollback rehearsal steps.
- [x] Step 4: Run targeted and backend verification, then record results and residual risk.

## Verification Notes

- Command: `node --test apps/backend/tests/phase10-release-rollback.test.cjs`
  - Result: 19/19 tests passed, including offline success, invalid evidence, strict flags, and missing-token no-spawn coverage.
- Command: `npm run backend:check`
  - Result: Passed, including syntax validation of `scripts/railway-release-gate.cjs`.
- Command: `npm run test:backend`
  - Result: 532/532 backend tests passed.
- Manual CLI check: tokenless `dry-run` rejected the first missing evidence argument without asking for credentials; tokenless isolation snapshot and ambiguous-token deployment snapshot named both accepted token variables and confirmed no Railway call was made.

## Remaining Risks

- The dry run proves local contract validity only; it cannot prove credentials, Railway reachability, retained deployment state, or the current staging environment.
- The credential guards prove an explicit token was selected, but only a credentialed staging preflight can prove its Railway scope and permissions.
