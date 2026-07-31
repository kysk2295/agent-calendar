# Plan: Production auth mode cutover

- Date: 2026-07-31
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Make the local WorkOS dogfood startup path select `WORKSPACE_AUTH_MODE=production`
when its database-backed auth environment is loaded, so all product `/api/*`
requests use the production route registry and Workspace-scoped handlers.

Prove that anonymous product reads fail closed, while a negotiated `client-v1`
request with a valid Bearer Workspace session can hydrate product data, including
an empty agents list.

## Non-Goals

- Deploying or changing Railway configuration.
- Changing WorkOS tenant configuration outside this repository.
- Changing mobile clients.
- Removing the explicit legacy mode used by isolated unit tests and local compatibility checks.

## Touched Boundaries

- Backend gateway: production-mode dispatch and startup composition only as required.
- Backend library: auth-mode selection and production route isolation.
- DB/migrations: none; existing Workspace session and scoped product schemas are reused.
- Electron bridge: none.
- React UI: none.
- Tests: backend production dispatch and dogfood environment regression coverage.
- Docs: local WorkOS startup instructions and this plan.

## Success Criteria

- [x] Loading the repository-managed WorkOS dogfood environment selects production auth mode by default when `DATABASE_URL` is present.
- [x] Anonymous `GET /api/agents`, `GET /api/state`, and another representative product read return `401 workspace_auth_required` without reaching gateway fallback data.
- [x] A valid Bearer Workspace session using `client-v1` can call `GET /api/agents` and `GET /api/state`; an empty agents collection is a successful response.
- [x] Production product dispatch never falls through to legacy unscoped handlers.
- [x] Tests can still opt into legacy behavior with `WORKSPACE_AUTH_MODE=legacy`.

## Edge Cases

- Missing WorkOS credentials: startup instructions must not imply that login is configured.
- Missing `DATABASE_URL`: the dogfood helper must fail clearly instead of starting a production mode with no scoped persistence runtime.
- Explicit `WORKSPACE_AUTH_MODE=legacy`: tests and compatibility workflows must retain legacy composition.
- Empty Workspace agent roster: authenticated list hydration returns `200` with `agents: []`, not synthetic Hermes agents or a failure.
- Invalid or absent Bearer token: every registered scoped product path returns the same fail-closed `401` envelope.

## Test Plan

Product behavior changes follow RED → GREEN.

- RED:
  - [x] Add focused startup/environment tests that fail until the WorkOS dogfood path exports production mode and validates the database prerequisite.
  - [x] Add focused HTTP assertions for anonymous representative product reads and authenticated `client-v1` empty-agent/state hydration.
  - [x] Add an explicit legacy-mode regression assertion.
- GREEN:
  - [x] Make the smallest environment/startup change that selects production mode for WorkOS dogfood without changing the library default used by unit tests.
  - [x] Tighten production dispatch only if the new HTTP test exposes a legacy fallthrough or runtime gap. No dispatcher change was required because the new HTTP matrix confirmed the existing registry path is already fail-closed.
- REFACTOR:
  - [x] Keep mode selection in one documented startup path and avoid implicit test-process environment mutation.

## Acceptance Gates

- [x] Focused production auth cutover test command
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] Manual HTTP QA against an ephemeral PostgreSQL-backed gateway test surface
- [x] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run build:desktop`
- [ ] `npm test`

Skipped gates will be recorded with a reason in Verification Notes.

## Implementation Checklist

- [x] Step 1: Merge the requested `kysk2295/agent-control-p0-wave1` source branch into the child worktree without overwriting unrelated local runner edits.
- [x] Step 2: Add failing tests for dogfood production-mode selection, production dispatch isolation, authenticated empty-agent hydration, and explicit legacy mode.
- [x] Step 3: Implement and document the safe WorkOS + database production startup path.
- [x] Step 4: Run focused tests, backend gates, and manual HTTP QA; then broaden verification in proportion to the touched boundaries.
- [x] Step 5: Record verification evidence, skipped gates, rollback guidance, and remaining risks.

## Rollback / Fallback

- Operators can set `WORKSPACE_AUTH_MODE=legacy` explicitly to restore the pre-cutover local gateway composition while investigating a dogfood regression.
- Revert the startup-helper change to stop defaulting the WorkOS dogfood path to production; no data migration or persisted-data rollback is required.
- Do not use legacy mode as a production workaround because it restores unscoped product handlers and synthetic gateway fallback behavior.

## Verification Notes

- RED: `node --test apps/backend/tests/production-auth-mode-cutover.test.cjs`
  - Result: failed as expected because the generated WorkOS environment did not select production mode and the guarded startup script did not exist.
- Focused: `node --test apps/backend/tests/production-auth-mode-cutover.test.cjs apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs`
  - Result: 5 passed, 0 failed. The real PostgreSQL-backed Gateway returned `401 workspace_auth_required` for anonymous `/api/tasks`, `/api/agents`, and `/api/state`; authenticated `client-v1` hydration returned `200` with an empty Workspace agent roster.
- Merge regression: `node --test apps/backend/tests/google-oauth-adapter.test.cjs apps/backend/tests/phase1-workos-desktop-login.test.cjs`
  - Result: 13 passed, 0 failed after retaining the wave1 WorkOS state hardening and restoring adapter-owned Google redirect selection lost during the requested branch merge.
- Syntax: `npm run backend:check`
  - Result: passed.
- Backend: `npm run test:backend`
  - Result: 673 passed, 0 failed.
- Desktop type safety: `npm run typecheck`
  - Result: passed.
- Desktop tests: `npm --workspace apps/desktop run test`
  - Result: 364 passed, 6 failed. The failures are merge-base debt from resolving requested wave1 conflicts over divergent origin/main-only Desktop surfaces: builder horizontal bounds, Control Home advanced assignment copy, focused Work Conversation layout, effective configuration details, child handoff control, and QA secure-storage composition. The coordinator explicitly kept this repair outside the auth cutover because the parent integration worktree is already based on wave1.
- `npm run build:desktop`
  - Not run: no Desktop product change belongs to the auth cutover, Desktop typecheck passed, and the coordinator declined expanding into unrelated divergent Desktop conflict repair.
- `npm test`
  - Not run: the backend suite was run directly and passed; the aggregate would repeat it before reaching the six documented out-of-scope Desktop merge-base failures.

## Remaining Risks

- Live WorkOS login still depends on valid local credentials and callback configuration that automated repository tests cannot provision.
- Full Railway deployment is outside this task; repository changes only establish and verify the intended dogfood startup contract.
- This divergent child worktree retains six Desktop test failures introduced by merging the requested wave1 base into origin/main-only surfaces. The auth files are intended to be integrated into the coordinator's wave1 parent, where that Desktop divergence is absent.
