# Plan: Phase 1 Vertical Slice — Identity, Workspace Foundation, and Scoped Calendar Domain

- Date: 2026-07-24
- Owner: Grok
- Work size: Large / Boundary
- Status: Verified — first vertical slice only (not full Phase 1); security follow-up 2026-07-24 applied
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Related ADRs: `docs/adr/0008-bind-runners-to-authenticated-workspaces.md`, `docs/adr/0009-provider-auth-calendar-signing-distribution.md`
- Roadmap story: Phase 1 first vertical slice only — hostile two-Workspace isolation for one calendar-first domain (not full Phase 1)

## Goal

Prove on a real ephemeral PostgreSQL cluster that User, Workspace, WorkspaceMembership, and a server-derived immutable WorkspaceScope can isolate `tasks` and `calendar_events` so same-scope list/direct-ID reads succeed and cross-scope list/direct-ID reads return no other Workspace data, after deterministic legacy ownership backfill preserves existing row counts.

## Non-Goals

- Do not implement RLS policies or a non-bypass app role (later Phase 1 story).
- Do not implement WorkOS AuthKit login, sessions, refresh rotation, or Desktop login UI.
- Do not scope SSE, search, cache, Wiki, Agent Work, scheduler, or every repository.
- Do not claim Phase 1 exit gate complete.
- Do not trust `workspaceId` / `userId` from request payload or model output as authorization.
- Do not change public API envelope field names for existing unscoped Desktop clients in this slice (legacy global store path remains; new repository requires scope).
- Do not stage, commit, spawn agents, or edit unrelated dirty worktree files.

## Work Size

Large / Boundary: migrations, ownership columns, identity tables, repository Interface, and integration tests on real PostgreSQL.

## Touched Boundaries

- Backend gateway: none required for this slice (repository-level proof first)
- Backend library: `apps/backend/app/lib/workspace-scope.js`, `apps/backend/app/lib/workspace-scoped-calendar-repository.js`; minimal compatibility writes in `apps/backend/app/lib/postgres-store.js` only if required for NOT NULL defaults
- DB/migrations: `apps/backend/app/db/migrations/0008_*.sql`, `0009_*.sql` (identity + tasks/calendar_events ownership)
- Electron bridge: none
- React UI: none
- Tests: `apps/backend/tests/phase1-workspace-isolation.test.cjs`
- Docs: this plan; redacted evidence under `docs/operations/evidence/`; parent roadmap Phase 1 status for this slice only

## Success Criteria

- [x] Plan exists with required sections including rollback/fallback.
- [x] Hostile two-Workspace PostgreSQL integration test fails RED for missing schema/repository before implementation.
- [x] Migrations create `users`, `workspaces`, `workspace_memberships` (and minimal related identity foundation as needed) with deterministic legacy owner/workspace/membership.
- [x] `tasks` and `calendar_events` gain `workspace_id` with FK, backfill to legacy workspace, NOT NULL, and indexes; all pre-migration row counts preserved.
- [x] Immutable server-side WorkspaceScope cannot be forged from bare payload ids without membership.
- [x] Same-scope list + direct-ID for tasks and calendar_events succeed; cross-scope returns empty/null; invalid/non-member scope rejected.
- [x] Ephemeral PG 17+pgvector manual QA recorded redaction-safe; cluster stopped.
- [x] `npm run backend:check` and `npm run test:backend` pass after GREEN.
- [x] Roadmap Phase 1 updated only for this slice; full Phase 1 remains incomplete.

## Edge Cases

- Legacy rows without workspace columns before migration → backfill to `legacy-personal-workspace`.
- Intentionally similar titles/owners across two Workspaces with distinct primary keys → isolation by `workspace_id`, not display text.
- Direct ID lookup with foreign workspace id → no row (not error leak of existence beyond empty).
- Scope missing membership → rejected before query results.
- Scope object mutated after create → immutable (frozen); mutations ignored/throw in strict mode.
- Re-running migrations (current migrate.js replays all SQL) → idempotent.
- Inserts through legacy `PostgresHermesStore` after NOT NULL → default workspace_id keeps personal beta path alive.

## Test Plan

### RED

- [x] `node --test apps/backend/tests/phase1-workspace-isolation.test.cjs` fails because identity tables / scoped repository / workspace columns are missing (expected reason captured in Verification Notes).

### GREEN

- [x] Smallest migrations + WorkspaceScope + WorkspaceScopedCalendarRepository make isolation test pass on real ephemeral PostgreSQL.
- [x] Row-count preservation assertions for tables present before/after 0008–0009.

### REFACTOR

- [x] Keep helpers pure; do not expand to RLS or WorkOS. Phase 0 rehearsal pinned to migrations `0001`–`0007` via `runMigrations({ fileFilter })`.

## Acceptance Gates

- [x] Narrow: `node --test apps/backend/tests/phase1-workspace-isolation.test.cjs`
- [x] Manual QA: fresh ephemeral DB invocation + redacted evidence JSON; no leftover postgres
- [x] `npm run backend:check`
- [x] `npm run test:backend`

Skipped gates:

- Gate: Desktop typecheck / Playwright / full monorepo `npm test`
  - Reason: no Desktop surface in this repository-level slice

## Implementation Checklist

- [x] Write this plan
- [x] Add failing hostile two-Workspace integration test + ephemeral PG harness
- [x] Capture RED output
- [x] Migration 0008: users, workspaces, workspace_memberships, legacy seed
- [x] Migration 0009: tasks + calendar_events workspace_id expand/backfill/NOT NULL/FK/indexes
- [x] `workspace-scope.js` + scoped calendar/tasks repository
- [x] Compatibility for legacy store inserts (DEFAULT workspace_id)
- [x] GREEN narrow test
- [x] Manual QA + evidence
- [x] backend:check + full backend tests
- [x] Update roadmap Phase 1 status for this slice only
- [x] Security follow-up: private scope issuance (WeakSet), membership-derived role, inactive user/workspace rejection
- [x] Security follow-up: same-workspace composite FK calendar_events (workspace_id, task_id) → tasks; drop legacy global task_id FK
- [x] Security follow-up hostile tests RED then GREEN; re-run QA/evidence and full backend
- [x] Composite FK uses `ON DELETE SET NULL (task_id)` so workspace_id stays NOT NULL; deletion assertion covers task delete

## Rollback / Fallback

- Migrations are expand-style and idempotent; if application cutover is wrong, stop using the scoped repository and leave legacy global store reads (still defaulted to legacy workspace for new writes).
- Do not drop `workspace_id` in emergency rollback without a dedicated reverse migration story.
- Ephemeral QA clusters are disposable; always `pg_ctl stop` / kill verified stopped.
- Feature is behind new repository entry points only — no forced gateway cutover in this slice.

## Verification Notes

### RED (initial slice)

- Command: `PHASE0_PG_BIN=/opt/homebrew/opt/postgresql@17/bin node --test apps/backend/tests/phase1-workspace-isolation.test.cjs`
  - Result: **fail** — `MODULE_NOT_FOUND` for `../app/lib/workspace-scope` (expected missing schema/repository modules before implementation). Exit 1.

### GREEN (initial slice)

- Command: same narrow test after implementation
  - Result: **pass** — immutable WorkspaceScope unit + hostile two-Workspace PostgreSQL isolation.

### RED (security follow-up 2026-07-24)

- Command: narrow isolation test with hostile cases for role elevation, hand-built scope, inactive user/workspace, cross-workspace event→task FK
  - Result: **fail** — `createWorkspaceScope` still exported; forged same-workspace `role=owner` was accepted (`Missing expected rejection` at assertActiveMembership). Exit 1.

### GREEN (security follow-up 2026-07-24)

- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-workspace-isolation.test.cjs`
  - Result: **pass** — 3/3 (public constructor ban; resolve-only immutability; isolation + security hostiles on real PG). Exit 0.
- Command: `npm run backend:check`
  - Result: **pass**
- Command: `npm run test:backend`
  - Result: **pass** — 325/325
- Manual QA: `PHASE0_PG_BIN=... node apps/backend/tools/phase1-workspace-isolation-qa.cjs`
  - Result: `ok=true`, `clusterStopped=true`, pre/post counts `{tasks:1, calendar_events:1, agents:1}` preserved; checks include `handBuiltScopeRejected`, `roleElevationRejected`, `memberRolePreserved`, `inactiveUserRejected`, `inactiveWorkspaceRejected`, `crossWorkspaceTaskLinkRejected`; evidence rewritten at `docs/operations/evidence/2026-07-24-phase1-workspace-isolation.json`; no leftover postgres processes

### Composite FK column-list SET NULL (2026-07-24)

- Migration `0009` uses `ON DELETE SET NULL (task_id)` (PostgreSQL 15+/17 column-list form), not bare `SET NULL`, so deleting a task cannot null `workspace_id` under NOT NULL.
- Constraint is dropped and recreated for idempotent correction of any prior bare `SET NULL` definition.
- Assertion: delete `task-collide-a` → `event-same-ws.workspace_id` stays `ws-a`, `task_id` becomes null; event remains listable in scope. QA check `taskDeleteNullsTaskIdOnly=true`.

## Remaining Risks

- Risk: Other tables remain unscoped; gateway still serves global lists.
  - Mitigation: Explicit Non-Goals; later Phase 1 stories expand domain coverage and RLS.
- Risk: Global `id` primary keys still prevent true per-workspace ID reuse.
  - Mitigation: Accept for API compatibility; isolation proven by workspace_id predicates, not colliding PKs.
- Risk: migrate.js replays all SQL every boot — non-idempotent SQL would break.
  - Mitigation: `IF NOT EXISTS` / exception-safe constraints / ON CONFLICT DO NOTHING; composite FK drop/add is name-safe.
- Risk: Defaulting legacy writes to personal workspace can hide missing scope at the gateway.
  - Mitigation: New repository requires scope; gateway cutover is a later story.
- Risk: Callers might still attempt hand-built scopes if `createWorkspaceScope` is re-exported later.
  - Mitigation: Private `issueWorkspaceScope` + `WeakSet` issuance marker; repository revalidation requires server-issued object and membership-derived role; unit test bans public constructor export.
- Risk: Other child tables may still use global FKs without same-workspace composites.
  - Mitigation: Only calendar_events→tasks composite is in this slice; expand in later migrations.
