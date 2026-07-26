# Phase 10 Workspace schedule ingest evidence

- Date: 2026-07-25
- Scope: production Gateway, Workspace calendar isolation, client-v1, Desktop review workflow
- Result: verified; one supported Desktop production blocker removed

## Outcome

`POST /api/assistant/ingest` is now a Workspace-scoped, review-only Calendar operation.

- The production dispatcher reads a bounded raw request body and accepts JSON text, plain text,
  or multipart form data.
- Multipart accepts one PNG, JPEG, HEIC, or HEIF image. Invalid boundaries, unsupported media,
  and multiple files fail closed.
- Workspace identity comes only from the authenticated server-issued `WorkspaceScope`; request
  fields such as `workspaceId` are ignored.
- Internal and external human calendar entries from that Workspace are used for conflict
  detection. Agent work and automation occurrences are intentionally not treated as competing
  human time.
- The ingest call returns drafts, warnings, conflict evidence, and coverage. It does not create a
  task or calendar event.
- The existing Desktop review card creates the selected item through the normal Calendar or Task
  API only after the user presses `선택 항목 등록`.
- The operation is frozen in `client-v1` as `calendar.schedule-ingest`.

## Workspace Isolation and Persistence Gate

The hostile production HTTP matrix uses real ephemeral PostgreSQL with Workspace A and Workspace
B holding same-time schedules.

Observed for a Workspace A session:

- response `workspaceId=ws-a`;
- Workspace A's event appeared as the only conflict;
- no Workspace B event or identifier appeared in the response;
- a forged multipart `workspaceId=ws-b` field had no authority;
- total `calendar_events` and `tasks` counts were identical before and after ingest.

## Desktop Manual QA Gate

Command:

```text
node apps/desktop/tests/playwright-wiring.cjs
```

Observed at 1320×824:

1. authenticated Desktop opened Calendar AI;
2. one image attachment and text produced one review draft;
3. `선택 항목 등록` issued exactly one `POST /api/calendar/events`;
4. the drawer reported `1건 등록했어요`;
5. after closing Calendar AI, `OO정형외과 예약` was visible as a Calendar event;
6. no Calendar create occurred before the explicit review action.

## Contract and Lifecycle Gate

Route audit after the change:

- total routes: 157;
- stable-v1: 55;
- supported-client-disabled: 3;
- unclassified routes: 0;
- stale policy entries: 0.

The remaining supported-client-disabled routes are:

```text
POST /api/mail/accounts
POST /api/mail/messages/:id/:action
POST /api/mail/sync
```

Mobile entry remains blocked by these routes and the other documented Phase 10 criteria.

## Verification

- focused Backend contracts: 18 passed;
- real PostgreSQL hostile Workspace cutover: passed;
- Backend syntax gate: passed;
- final full Backend suite: 454 passed;
- Desktop tests: 258 passed;
- Runner tests: 23 passed;
- Desktop typecheck: passed;
- Desktop production build: passed;
- Desktop Playwright draft-review-to-calendar workflow: passed.

The first full parallel Backend run passed 453 of 454 tests and hit the existing
disaster-recovery PITR parallel rehearsal race. The failed rehearsal passed all 8 tests when run
alone immediately afterward. The unchanged final `npm test` run passed Backend 454, Desktop 258,
and Runner 23; no product code was changed to mask the transient rehearsal failure.

The existing non-blocking Vite chunk-size warning and Desktop test WebSocket port warnings remain
unchanged.

## Remaining Risks

- Image OCR and LLM extraction still depend on a reachable configured local endpoint or
  customer-controlled Runner relay. If neither is available, the API returns zero drafts with an
  explicit warning instead of fabricating success.
- Conflict evidence reflects the latest synchronized calendar projection. Stale external source
  coverage remains visible through the Unified Calendar contract.
