# Phase 10 direct Workboard conversion retirement evidence

- Date: 2026-07-25
- Scope: Desktop API, Agent Work replacement, route lifecycle
- Result: verified

## Outcome

The Desktop no longer exposes `convertWorkboard` or calls
`POST /api/workboard/convert`. The legacy implementation could create a Task or Run directly from
a note, bypassing the current Delegated Work plan and approval flow.

The supported replacement is now `POST /api/agent-operations/work`, followed by visible planning,
approval, and per-task execution. The old server route remains fail-closed as
`production_disabled` and is a dated `removal-candidate`.

## Route Audit

- total/classified routes: 157/157;
- supported-client-disabled: 3, all Mail mutations;
- removal-candidate: 9;
- unclassified routes: 0;
- stale policy entries: 0.

Physical deletion remains forbidden before 2026-10-31 plus 28 observed zero-traffic days.

## TDD Evidence

RED was observed:

- Desktop source still exposed `convertWorkboard`;
- lifecycle still classified the route as supported-client-disabled.

GREEN:

- focused Desktop contract: 39 passed;
- focused lifecycle contract: 9 passed.

## Manual QA

The authenticated Desktop Agent Work flow passed:

1. the user delegated one outcome through `POST /api/agent-operations/work`;
2. the Work Conversation displayed the proposed plan;
3. approval created three visible Agent Tasks;
4. an individual `지금 실행` completed one task;
5. pause, resume, and cancellation remained operational;
6. no `POST /api/workboard/convert` request occurred.

## Verification

- `npm run backend:check`: passed.
- `npm run typecheck`: passed.
- `npm run test:backend`: final full suite passed.
- `npm --workspace apps/desktop run test`: 260 passed.
- `npm run build:desktop`: passed.
- `npm test`: Backend 458, Desktop 260, Runner 23 passed.
- `npm --workspace apps/backend run audit:routes -- --as-of=2026-07-25`: passed.
- `node apps/desktop/tests/playwright-agent-operations-mission.cjs`: passed.

One concurrent Backend/Desktop gate saw the PostgreSQL security test file exit at file level
without an assertion. Its 10 cases passed when run alone, and the later full `npm test` run passed.

The existing Vite chunk-size warning and Desktop test WebSocket port warnings remain unchanged.

## Remaining Risk

Production traffic evidence is not yet available, so the server tombstone remains required.
