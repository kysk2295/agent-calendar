# Plan: Remove fake Google connection from the production route composition

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Remove the fake Google Calendar connector from the production HTTP registry and dispatcher while
preserving Phase 4 isolation and Desktop ETE coverage through an explicitly injected test service.

## Non-goals

- Do not change real Google OAuth behavior.
- Do not expose a replacement test HTTP route.
- Do not remove the fake provider implementation used by isolated tests.
- Do not start Mobile implementation.

## Work size

Large / Boundary. The change crosses the Backend production registry and dispatcher, Phase 4
Backend tests, the packaged Desktop ETE, lifecycle policy, and release evidence.

## Touched boundaries

- Backend route registry and product dispatcher
- Unified Calendar test composition
- Backend route and hostile-isolation contracts
- Desktop Phase 4 ETE
- Phase 10 route lifecycle evidence

## Success criteria

- `POST /api/calendar/sources/google/fake-connect` is absent from the production route registry.
- Production requests to that path return `production_route_unregistered`.
- Fake Google setup occurs only by direct test-service composition with a server-issued
  `WorkspaceScope`.
- Existing Phase 4 two-Workspace isolation, webhook, external mutation, restart, and Desktop
  workflows remain green.
- Route lifecycle reports zero `testOnlyRoutes`.

## Edge cases

- An environment flag alone must never re-register a production HTTP route.
- Test setup must not construct Workspace authority from request bodies.
- Real Google OAuth authorize/callback routes remain registered.
- Fake provider tokens and credential references remain private.

## Test plan

1. RED: production route contract rejects the still-registered fake connector.
2. RED: lifecycle report requires `testOnlyRoutes=[]`.
3. GREEN: remove the route and action handler.
4. Replace HTTP test seeding with direct `connectFakeGoogle` calls using resolved Workspace scope.
5. Run focused Phase 4 and lifecycle contracts.
6. Run the real Desktop Phase 4 ETE and inspect its screenshots.
7. Run Backend syntax, Desktop build, and full regression.

## Acceptance gates

- [x] Route lifecycle and Phase 4 registration contracts
- [x] Phase 4 Backend hostile matrix and root audits
- [x] Phase 4 Desktop ETE
- [x] Backend syntax
- [x] Desktop build
- [x] Full regression suite
- [x] Updated bounded operations evidence

## Step-by-step checklist

- [x] Audit every fake-connect HTTP caller.
- [x] Add expected-failure production-route contracts.
- [x] Remove production registration and dispatcher action.
- [x] Move all fixtures to direct scoped service composition.
- [x] Pass focused and real-surface verification.
- [x] Update lifecycle evidence and roadmap.

## Verification notes

- RED: fake-connect still matched a production route and lifecycle exposed one test-only route.
- GREEN: production fake-connect returns `production_route_unregistered`; `testOnlyRoutes=[]`.
- Phase 4 Backend hostile matrix and root audits: 33 passed.
- Desktop Phase 4 ETE: six distinct screenshots, synchronized Unified Calendar, external create,
  Backend restart, Desktop restart, and cross-Workspace isolation passed.
- `npm run backend:check`: passed.
- `npm test`: Backend 457, Desktop 260, Runner 29 passed.
- `git diff --check`: passed.

## Remaining risks

- Compatibility and dated removal-candidate routes still require production traffic evidence
  before Mobile entry.
- Live Google OAuth still requires operator-owned Google Cloud configuration.

## Rollback / fallback

Restore only the test fixtures to direct service setup if a fixture fails. Never restore the fake
connector to the production HTTP registry; real OAuth remains the sole production connection path.
