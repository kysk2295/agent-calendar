# Phase 10 Google Calendar client-v1 contract evidence

- Date: 2026-07-25
- Scope: client-v1 manifest and Electron main-process Google Calendar OAuth
- Result: focused implementation and real local HTTP surface verified

## Contract closure

The frozen Unified Calendar family now includes:

- `POST /api/calendar/sources/google/authorize`
- `POST /api/calendar/sources/google/callback`

The Electron coordinator sends the `client-v1` media type and request header on authorize,
callback, first sync, and source refresh. Mutating requests also receive a client request ID.
Only the idempotent callback and sync reuse that ID as the idempotency key; the non-idempotent
authorize request does not advertise retry safety.

## TDD evidence

Expected RED:

- Backend manifest test failed because `calendar.google-authorize` was absent.
- Desktop OAuth test failed because none of the four requests carried `client-v1`.

Focused GREEN:

- Backend + Desktop: 9/9 passed.

Broad GREEN:

- Backend syntax: passed.
- Desktop typecheck: passed.
- Desktop production build: passed.
- Full root suite: Backend 502/502, Desktop 274/274, Runner 41/41 passed.
- The existing Vite large-chunk warning remains non-blocking.

## Real HTTP surface

The actual Electron OAuth coordinator was loaded through the Desktop runtime and sent its
complete four-request flow over a local HTTP socket. The observer recorded only header presence,
bounded test request IDs, method, and path; no OAuth code, state, token, Workspace, or user
identity was written to evidence.

Observed:

- authorize: contract present, request ID present, idempotency key absent
- callback: contract present, request ID equals idempotency key
- first sync: contract present, request ID equals idempotency key
- source refresh: contract present, mutation identifiers absent
- final public result: connected source and successful first sync

## External gate

Live Google OAuth was not run because this environment has no approved production Google Cloud
OAuth credential/callback configuration. It remains a staging release gate and is not replaced
by this local protocol evidence.
