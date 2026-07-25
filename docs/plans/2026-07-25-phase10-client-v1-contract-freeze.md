# Plan: Phase 10 client-v1 contract freeze

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Freeze one machine-readable `client-v1` interface for the supported Desktop client and the
future compact Mobile client. The production gateway must advertise the interface, reject an
explicitly requested unsupported Agent Calendar contract, and identify negotiated responses
without exposing Workspace data.

## Non-Goals

- Do not start Mobile product implementation.
- Do not introduce a second set of Mobile-only routes or duplicate product-domain logic.
- Do not remove legacy routes in this slice; removal still requires supported-client usage
  evidence and an explicit rollback window.
- Do not change response payload meanings for existing unversioned clients.

## Work Size

Large / Boundary. This changes the production HTTP interface, route inventory, Desktop request
headers, Backend and Desktop contracts, and Phase 10 release evidence.

## Touched Boundaries

- Backend gateway:
  - `apps/backend/app/railway-gateway-server.js`
  - `apps/backend/app/lib/production-gateway-dispatch.js`
- Backend library:
  - new `apps/backend/app/lib/client-v1-contract.js`
  - `apps/backend/app/lib/production-route-registry.js`
- DB/migrations: none
- Electron bridge: none
- React UI: none
- Desktop client:
  - `apps/desktop/src/api/hermesApi.ts`
- Tests:
  - Backend manifest, drift, negotiation, and real HTTP checks
  - Desktop request-header contract
- Docs:
  - this plan, Phase 10 evidence, roadmap progress

## Module and Seam Decision

`client-v1-contract.js` is the deep Module. Its small Interface exports the immutable manifest,
route-drift assertion, and request negotiation result. The existing production route registry
remains the route source of truth; the manifest statically records only the routes and invariants
supported clients may depend on.

The seam lives at the production gateway request composition point. Desktop and future Mobile
are two real adapters of the same HTTP interface. No Mobile-specific server adapter is introduced.

## Success Criteria

- [x] `GET /api/contracts/client-v1` returns a tenant-free, deeply immutable manifest for
      identity, Unified Calendar, Calendar AI, Agent Work, Automation, Knowledge, and notifications.
- [x] The manifest fails validation if a frozen route's method, path, action, class, persistence,
      role, or idempotency meaning drifts.
- [x] Explicit `client-v1` negotiation adds `x-agent-calendar-contract: client-v1`.
- [x] An explicit unsupported Agent Calendar vendor contract returns `406` and the supported
      contract identifiers without authenticating or reading Workspace data.
- [x] Existing clients that request ordinary JSON remain backward compatible.
- [x] Desktop JSON and SSE requests identify `client-v1`; mutation requests carry a stable
      request identity/idempotency key.
- [x] Backend and Desktop verification gates pass.

## Edge Cases

- `Accept` may contain multiple media types, quality parameters, whitespace, or mixed case.
- Ordinary `application/json`, `text/event-stream`, and wildcard Accept headers do not count as
  an unsupported contract request.
- An explicit request header takes precedence over an unrelated Accept header.
- Auth mutations are intentionally non-idempotent; product mutations in the frozen contract are
  idempotent and advertise the idempotency-key policy.
- SSE retains `text/event-stream` while negotiating through the explicit contract header.
- The public manifest must never contain a Workspace ID, user identity, provider credential,
  secret, or live runtime state.

## Test Plan

Product code follows the failing tests.

### RED

- [x] A Backend test fails because the manifest/negotiation Module and public route do not exist.
- [x] A Desktop source contract fails because requests do not yet identify `client-v1`.

### GREEN

- [x] Add the immutable manifest, production-route assertion, negotiation helper, and public route.
- [x] Apply negotiation once at the production gateway composition seam.
- [x] Add Desktop JSON/SSE contract headers and mutation request identity.

### REFACTOR

- [x] Keep all negotiation parsing inside the new Module and avoid conditionals across handlers.
- [x] Keep payload handlers and existing response envelopes unchanged.

## Acceptance Gates

- [x] Focused Backend contract test
- [x] Focused Desktop contract test
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Real HTTP manifest/supported/unsupported negotiation QA

## Step-by-Step Checklist

- [x] Audit production routes, dispatch composition, Desktop JSON requests, and SSE requests.
- [x] Add failing Backend and Desktop contract tests.
- [x] Implement and register the `client-v1` Module.
- [x] Apply production request negotiation and response identification.
- [x] Connect the Desktop adapter to the frozen interface.
- [x] Run focused and broad verification.
- [x] Record observed HTTP evidence and remaining Phase 10 gates.

## Verification Notes

- Focused Backend: 5 passed.
- Focused Desktop client/proxy/secure-session: 21 passed.
- Backend syntax: passed.
- Full root suite: Backend 444, Desktop 258, Runner 23 passed.
- Desktop typecheck and production build: passed.
- Manual QA: built Electron proxy to real local production Gateway passed preflight,
  discovery, supported negotiation, mutation identity, and unsupported-version rejection.
- Evidence:
  `docs/operations/evidence/2026-07-25-phase10-client-v1-contract.md`

## Rollback / Fallback

Remove the public manifest route and negotiation call, then remove the Desktop contract headers.
No persistence or response-envelope migration is involved. Existing unversioned JSON clients
remain the fallback throughout this slice.

## Remaining Risks

- This slice freezes supported route and protocol invariants, not every field of every evolving
  response object; incompatible payload changes still require schema-specific contract tests.
- Phase 10 Mobile entry remains blocked by signed-release, private-beta stability, live connector,
  live operations, and legacy-removal evidence outside this slice.
- A future Mobile adapter must reuse client-generated idempotency keys across retries instead of
  generating a new key for each retry attempt.
