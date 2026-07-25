# Phase 10 dormant Calendar draft retirement evidence

- Date: 2026-07-25
- Scope: Desktop API contract, production route lifecycle, Calendar AI review flow
- Result: verified

## Outcome

The Desktop no longer exposes the unused `draftCalendarWork` method or calls
`POST /api/calendar/draft`. The production route itself remains fail-closed as
`production_disabled`; it is now a dated `removal-candidate` with
`POST /api/assistant/ingest` as its supported replacement. Physical removal is
still forbidden until 2026-10-31 and 28 observed zero-traffic days have both
elapsed.

The route audit remains complete at 157/157 routes:

- supported-client-disabled: 5;
- removal-candidate: 7;
- unclassified: 0;
- stale policy entries: 0.

## TDD Evidence

RED was observed on both boundaries:

- Desktop source contract found the dormant API method;
- route lifecycle still classified the path as supported-client-disabled.

After the minimal retirement change:

- focused Desktop contract: 4 passed;
- focused route lifecycle contract: 7 passed.

## Manual QA

The real Desktop wiring flow passed in Chromium:

1. one image attachment and text produced a review-only schedule draft;
2. no Calendar event was created before review;
3. the explicit registration action called `POST /api/calendar/events`;
4. the new event became visible in Calendar;
5. no request to `POST /api/calendar/draft` occurred.

## Verification

- `npm run backend:check`: passed.
- `npm run test:backend`: 455 passed.
- `npm run typecheck`: passed.
- `npm --workspace apps/desktop run test`: 259 passed.
- `npm run build:desktop`: passed.
- `npm test`: Backend 455, Desktop 259, Runner 23 passed.
- `npm --workspace apps/backend run audit:routes -- --as-of=2026-07-25`: passed.
- `node apps/desktop/tests/playwright-wiring.cjs`: passed.

The existing non-blocking Vite chunk-size warning and Desktop test WebSocket port
warnings remain unchanged.

## Remaining Risk

Real production traffic evidence does not yet exist, so the server tombstone must
remain until the dated removal policy can be proven safe.
