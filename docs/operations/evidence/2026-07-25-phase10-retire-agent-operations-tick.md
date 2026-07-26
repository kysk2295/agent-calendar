# Phase 10 global Agent Operations tick retirement evidence

- Date: 2026-07-25
- Scope: Desktop Agent Work API, server scheduler ownership, route lifecycle
- Result: verified

## Outcome

The Desktop no longer exposes `tickAgentOperations` or calls
`POST /api/agent-operations/tick`. Production automatic execution remains owned by the
server-side `SchedulerDaemon`, while an explicit user action runs exactly one Workspace-scoped
Agent Task through `POST /api/agent-operations/tasks/:id/run-now`.

The old route remains fail-closed as `production_disabled`. It is a dated
`removal-candidate` with the per-task route as its replacement and cannot be physically removed
before 2026-10-31 plus 28 observed zero-traffic days.

## Route Audit

- total/classified routes: 157/157;
- supported-client-disabled: 4;
- removal-candidate: 8;
- unclassified routes: 0;
- stale policy entries: 0.

## TDD Evidence

RED was observed:

- the Desktop source contract found the global tick method;
- lifecycle still classified the route as supported-client-disabled.

GREEN:

- focused Desktop contract: 38 passed;
- focused lifecycle contract: 8 passed.

## Manual QA

The authenticated Agent Work flow passed in Chromium:

1. the user opened Agent Work and delegated a mission;
2. the plan created three tasks;
3. plan activation exposed three individual `지금 실행` controls;
4. the first control called only
   `POST /api/agent-operations/tasks/task-scan/run-now`;
5. the task became completed and mission pause/cancel controls remained operational;
6. no request to `POST /api/agent-operations/tick` occurred.

The QA fixture was updated to enter through the current signed-in Desktop and completed onboarding
boundary before testing the product surface.

## Verification

- `npm run backend:check`: passed.
- `npm run test:backend`: 456 passed.
- `npm run typecheck`: passed.
- `npm --workspace apps/desktop run test`: 259 passed.
- `npm run build:desktop`: passed.
- `npm test`: Backend 456, Desktop 259, Runner 23 passed.
- `npm --workspace apps/backend run audit:routes -- --as-of=2026-07-25`: passed.
- `node apps/desktop/tests/playwright-agent-operations-mission.cjs`: passed.

The existing Vite chunk-size warning and Desktop test WebSocket port warnings remain unchanged.

## Remaining Risk

Production traffic evidence is not yet available, so the server tombstone remains required.
