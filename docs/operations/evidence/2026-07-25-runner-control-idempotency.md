# Runner Control Idempotency and client-v1 Evidence

- Captured: 2026-07-25
- Scope: Workspace-owned Runner Control, `client-v1`, production Gateway idempotency,
  PostgreSQL A/B isolation, Electron Runner Setup
- Result: PASS
- Production mutation: none

## Closed production gap

Desktop already sent `x-client-request-id` and `idempotency-key` on Runner mutations, but the
production route registry marked enrollment start/confirm/reject, connection test, and revoke as
non-idempotent. The Gateway ignored the keys, and `client-v1` did not describe Runner Setup.
Response loss or network retry could therefore execute the same control mutation more than once.

The five mutations are now idempotent production routes. The existing deep
`WorkspaceIdempotencyStore` Module owns execution, conflict, concurrent wait, and exact response
replay at the Gateway composition seam. No handler-specific replay implementation was added.

`client-v1` now contains 65 operations in eight families, including Runner Control:

- Runner list and signed release manifest;
- enrollment start and get;
- enrollment confirm and reject;
- connection test;
- revoke.

Explicit `client-v1` Runner mutations without `idempotency-key` fail with
`client_idempotency_key_required` before the Runner Control handler runs. Unversioned requests
retain their compatibility behavior.

## TDD evidence

Expected RED:

- client-v1 contract: 3/5 pass; Runner family and required-key assertions failed.
- Phase 2 focused: 0/2 pass; five routes were non-idempotent and missing-key HTTP returned 200.

GREEN:

- client-v1 contract: 5/5 pass.
- Phase 2 focused: 2/2 pass.
- Full Phase 2 hostile Runner matrix: 5/5 pass.
- Route lifecycle: 9/9 pass.
- Current route audit: 167/167 classified, no stale/unclassified entries.

Real PostgreSQL + loopback production HTTP observed:

- Workspace A first enrollment returned 200;
- same Workspace, key, path, and body replayed the exact enrollment id, code, and QR response;
- only one Workspace A challenge row existed;
- the same key with a different body returned `idempotency_key_conflict` 409;
- Workspace B used the same key and created an independent Workspace B challenge;
- confirm, reject, connection test, and revoke handlers were each instrumented and called exactly
  once across two same-key HTTP requests;
- no response contained a device credential, claim token, credential hash, challenge hash, or
  session token.

## Actual Electron Runner Setup surface

Command:

`AGENT_CALENDAR_E2E_TIMEOUT_MS=240000 node apps/desktop/tests/playwright-phase2-runner-enrollment-e2e.cjs`

Observed result:

- `ok: true`;
- duration: 13,760 ms;
- 10 screenshots;
- AuthKit test login and Workspace-owned enrollment;
- human code and QR payload decode matched;
- pending device fingerprint displayed;
- confirm, claim, connect, capability/authentication state, and connection test passed;
- disconnect and reconnect passed;
- credential rotation denied the old credential and accepted the new credential;
- revoke denied subsequent device connection;
- Calendar remained usable after revocation.

Manual inspection of
`apps/desktop/test-results/phase2-runner-enrollment/capabilities-ready.png`
confirmed the restrained production Runner Setup surface, Connected state, exact fingerprint,
engine installation/authentication distinction, and ready-to-return-to-Calendar action.

## Broad verification

- `npm run backend:check`: pass.
- `npm test`: pass.
  - Desktop: 274/274.
  - Runner: 46/46.
  - Backend: pass.
- Electron ETE build:
  - Desktop typecheck: pass.
  - Desktop production build: pass.
- `git diff --check`: pass.

## Honest boundary

- This slice verifies transport retry safety. Two deliberate clicks that generate different
  request keys remain separate commands and are governed by UI state and Runner Control
  transitions.
- Production WorkOS, public Runner distribution, WAN fault injection, and Railway staging remain
  separate release gates.
- No provider credential moved to the Gateway.
- Mobile was not started.
