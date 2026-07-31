# Plan: Production-auth two-Workspace isolation evidence

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Provide a focused, repeatable release gate proving that two authenticated Workspace
sessions remain isolated through the production-mode HTTP gateway backed by real
PostgreSQL. A task written through Workspace A's access token must remain absent from
Workspace B's task list.

## Non-Goals

- Live login with two human Google or WorkOS accounts.
- Penetration testing or a general authorization audit.
- API, authentication, database schema, or persisted-data contract changes.
- Replacing the broader two-account Electron golden ETE.

## Touched Boundaries

- Backend gateway: no product-code change planned; exercise the existing production dispatch.
- Backend library: no change planned.
- DB/migrations: no change planned; run all existing migrations in ephemeral PostgreSQL.
- Electron bridge: not touched.
- React UI: not touched.
- Tests: `apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs`.
- Docs/config: root release-gate script and this rerun plan.

## Success Criteria

- [x] The gateway runs with `WORKSPACE_AUTH_MODE=production` against real PostgreSQL.
- [x] Two fixtures receive independently scoped Workspace access tokens.
- [x] Workspace A creates a task over HTTP and can list it.
- [x] Workspace B lists tasks over HTTP and cannot see the task created by Workspace A.
- [x] A focused root command reruns the evidence without requiring Electron or live accounts.

## Edge Cases

- A request body attempts to claim Workspace B while authenticated as Workspace A: token scope wins.
- A legacy global bearer is supplied in production mode: request remains unauthorized.
- PostgreSQL binaries are missing: the gate fails closed with the existing `PG_BIN_MISSING`
  error; set `PHASE0_PG_BIN` to a PostgreSQL 17+ bin directory and rerun.

## Test Plan

- RED:
  - [x] Run the intended `npm run verify:production-workspace-isolation` gate and confirm
    it is unavailable before the script is added.
- GREEN:
  - [x] Extend the existing production cutover HTTP matrix with explicit A-write/A-read/B-absent assertions.
  - [x] Add the focused root release command and run it against ephemeral PostgreSQL.
- REFACTOR:
  - [x] Keep the existing harness and production code unchanged; only clarify evidence naming and assertions.

## Acceptance Gates

- [x] `npm run verify:production-workspace-isolation`
- [x] `npm run backend:check`
- [x] `node --test apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs`
  (invoked by the focused root command with production auth mode set)
- [x] `git diff --check`

Skipped gates:

- `npm test`, Desktop typecheck/tests/build, Playwright:
  - Reason: this is a backend test/config/docs-only change and the focused production gateway
    matrix is the smallest relevant boundary gate. The existing two-account Playwright golden
    remains available through `npm run verify:multi-user-ete`.

## Implementation Checklist

- [x] Step 1: establish the missing focused-command RED.
- [x] Step 2: make the two-Workspace task write/list isolation evidence explicit in the existing test.
- [x] Step 3: add and run the focused production-auth release command.
- [x] Step 4: record results, skipped checks, and residual risks in this plan.

## Rollback / Fallback

Remove the root script and the added assertions to return to the prior broad backend suite.
No product runtime, database, or external environment state is changed. If local PostgreSQL is
unavailable, the gate must remain failed rather than substituting an in-memory database.

## Verification Notes

- Required base merge:
  - `HEAD`, local Wave 1, and origin Wave 1 all resolved to `c4cfa8d`; the directed merge
    completed as already up to date with no conflicts.
- RED: `npm run verify:production-workspace-isolation`
  - Result: exit 1, missing script before implementation.
- GREEN: `npm run verify:production-workspace-isolation`
  - Result: 3 tests passed, 0 failed; the real ephemeral PostgreSQL matrix completed in 1.71s.
- Backend syntax: `npm run backend:check`
  - Result: pass.
- Hygiene: `git diff --check`
  - Result: pass across the shared dirty worktree.
- Release evidence: `docs/operations/evidence/2026-07-31-production-auth-two-workspace-isolation.md`.

## Remaining Risks

- Injected test identities prove account-derived Workspace session isolation inside the product,
  not live WorkOS tenant redirect/provider configuration.
- This focused gate covers task list isolation; the broader cutover matrix and Phase 3 golden ETE
  retain wider agent, Runner, Calendar, and Electron coverage.
