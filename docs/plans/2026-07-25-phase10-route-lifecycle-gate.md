# Plan: Phase 10 route lifecycle and legacy-removal gate

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Make every production HTTP route accountable to a supported client, an internal protocol, a
time-bounded compatibility window, or an intentional security tombstone. Prevent route removal
from source inspection alone and expose the exact blockers that still prevent Mobile entry.

## Non-Goals

- Do not start Mobile implementation.
- Do not delete a route using only repository search; real zero-traffic evidence and a rollback
  observation window are required.
- Do not treat a production-disabled route still called by Desktop as “cleaned up.”
- Do not remove security tombstones whose explicit fail-closed response is itself a safety
  contract.
- Do not broaden Mail, TickTick, or schedule-image functionality in this slice.

## Work Size

Large / Boundary. This adds a release-facing route lifecycle contract across the Backend route
registry, Desktop inventory, Runner protocol, client-v1 manifest, tests, and operations evidence.

## Touched Boundaries

- Backend gateway: production route registry, syntax gate
- Backend library: new route lifecycle Module
- Desktop client: read-only inventory input; no user-visible change
- Runner: read-only protocol inventory input; no Runner behavior change
- Tests: lifecycle classification, drift, removal safety, CLI evidence
- Docs: plan, Phase 10 roadmap and evidence
- DB/migrations: none

## Success Criteria

- [x] Every registered production route has exactly one lifecycle classification.
- [x] Stable Desktop, `client-v1`, Runner, provider, and operations routes cannot be removed by
      the cleanup gate.
- [x] Every compatibility route has an explicit replacement and removal date.
- [x] Security tombstones are distinguished from compatibility routes.
- [x] Desktop calls to production-disabled routes appear as release blockers, not as cleanup.
- [x] A removal candidate requires both its removal date and at least 28 days of observed
      zero traffic.
- [x] A bounded CLI report can be attached to release evidence without customer data or secrets.
- [x] The report truthfully keeps Mobile entry closed while blockers remain.

## Edge Cases

- A newly registered route with no lifecycle owner fails classification.
- A lifecycle entry whose route was already removed is reported as stale.
- Dynamic `:id` path patterns are compared as registry patterns, never customer URLs.
- Future-dated removals remain forbidden even with zero-traffic evidence.
- Stable routes and security tombstones remain forbidden to remove regardless of traffic.
- Invalid dates and observation intervals fail closed.
- Desktop paths that are also in `client-v1` receive the stronger `stable-v1` classification.

## Test Plan

### RED

- [x] Add a Backend test that fails because the lifecycle Module and report CLI do not exist.
- [x] Assert current Desktop-to-production-disabled mismatches are visible as exact blockers.

### GREEN

- [x] Add the lifecycle manifest, classification report, drift assertion, Mobile-entry
      assertion, and removal-safety assertion.
- [x] Add a bounded CLI report with optional strict Mobile-entry exit status.
- [x] Add syntax coverage for the new Module and CLI.

### REFACTOR

- [x] Keep registry, Desktop inventory, and client-v1 as existing sources of truth.
- [x] Keep explicit lists only for compatibility/control-plane policy decisions that cannot be
      inferred safely.

## Acceptance Gates

- [x] Focused route lifecycle tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Manual CLI report inspection

## Step-by-Step Checklist

- [x] Audit production registry against Desktop, client-v1, Runner, and direct main-process paths.
- [x] Add expected-failure lifecycle tests.
- [x] Implement lifecycle classification and removal gate.
- [x] Produce and inspect bounded evidence.
- [x] Record exact remaining blockers and next remediation order.

## Verification Notes

- Focused route lifecycle test: 6 passed.
- Backend syntax gate: passed.
- Full root suite: Backend 450, Desktop 258, Runner 23 passed.
- Desktop typecheck and production build: passed.
- Manual CLI: 157/157 classified, no stale entries, strict Mobile entry correctly blocked.
- Evidence:
  `docs/operations/evidence/2026-07-25-phase10-route-lifecycle.md`

## Rollback / Fallback

Remove the new lifecycle Module, CLI, syntax entry, tests, and evidence. No route behavior,
persistence, auth contract, or client request changes are made in this slice.

## Remaining Risks

- Repository consumer evidence cannot prove that an old external client has stopped sending
  traffic; production telemetry is still required before deletion.
- Current Desktop production-disabled calls remain product gaps and will keep Mobile entry closed.
- Removal dates are policy targets, not proof that a route may be deleted on that date.
