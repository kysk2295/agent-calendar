# Phase 10 client-v1 contract freeze evidence

- Date: 2026-07-25
- Scope: production Gateway, Desktop renderer/main process, local Electron proxy
- Result: verified contract-freeze slice; Mobile implementation remains blocked by the other
  Phase 10 entry criteria

## Frozen Interface

`client-v1` exposes one tenant-free manifest at `GET /api/contracts/client-v1`.

The manifest now contains 112 supported operations across exactly these ten families:

1. identity
2. workspace-core
3. unified-calendar
4. calendar-ai
5. agent-control
6. agent-work
7. runner-control
8. automation
9. knowledge
10. notifications

The additive closures after the original freeze are the Workspace-scoped Google Calendar OAuth
start/callback routes and eight Runner Control operations. Runner list, release manifest,
enrollment start/get/confirm/reject, connection test, and revoke now use the same supported
interface as Desktop. The five Runner mutations advertise a required idempotency key. The final
Desktop closure adds all Workspace core, legacy Desktop adapter, Agent Control/provider catalog,
provider session, scheduler, and Agent Work routes. No scoped/auth Desktop product route remains
outside the manifest.

The compatibility rule is additive-only within `client-v1`. A breaking change requires a new
major contract identifier. The production route assertion fails startup/tests if a frozen
route's method, path pattern, action, class, persistence kind, role, or idempotency meaning
changes.

## Negotiation and Retry Safety

- JSON negotiation:
  `Accept: application/vnd.agent-calendar.client-v1+json, application/json`
- JSON/SSE request identity:
  `x-agent-calendar-contract: client-v1`
- Negotiated response identity:
  `x-agent-calendar-contract: client-v1`
- Product mutation identity:
  `x-client-request-id`
- Retry-stable mutation identity:
  `idempotency-key`

An explicitly requested unsupported Agent Calendar contract returns `406` with the supported
contract identifiers before authentication or Workspace access. An explicit `client-v1` request
for a registered scoped/auth product route outside the manifest returns
`client_route_not_in_contract`. Ordinary unversioned JSON requests retain their existing behavior.

Desktop renderer JSON/SSE requests, main-process login/refresh/logout, and the Electron proxy
now preserve this contract identity. The proxy CORS allowlist and upstream forwarding policy
include only the three new bounded headers; the local process credential is still never
forwarded upstream.

## TDD Evidence

Expected RED:

- Backend test failed because `client-v1-contract` did not exist.
- Desktop client test failed because renderer contract constants and mutation identity were
  absent.
- Electron proxy test failed because contract/request/idempotency headers were neither allowed
  by preflight nor forwarded upstream.
- Main-process contract test failed because the shared Electron contract module did not exist.
- Follow-up Google Calendar test failed because main-process OAuth requests did not yet send the
  contract/request/idempotency headers and the manifest omitted authorize/callback.

GREEN:

- Focused Backend client-v1/lifecycle: 15 passed.
- Focused Desktop client/proxy/secure-session contract: 21 passed.

## Broad Verification

- `npm run backend:check`: passed.
- Current full regression: passed.
  - Backend: 506 passed.
  - Desktop: 274 passed.
  - Runner: 46 passed.
- `npm run typecheck`: passed.
- `npm run build:desktop`: passed.

The existing non-blocking Vite large-bundle warning remains unchanged.

## Manual QA Gate

### Closed Desktop/provider surface

An actual Electron run with the real local Codex CLI passed after the 112-operation closure:

- provider agent catalog query/import;
- existing provider session import;
- two messages delivered to the same external provider session;
- streaming checkpoint, curated tool checkpoint, and artifact;
- Gateway and Desktop restart;
- same Work Conversation, provider session, artifact, and Calendar result restored.

The run completed in 101,338ms with two completed attempts and no failed attempt. It used the
injected AuthKit adapter, so it is product-surface regression evidence rather than production
identity release evidence. The final two-account provider gate remains open.

Evidence:
`docs/operations/evidence/2026-07-25-client-v1-closed-desktop-surface.md`.

### Current Runner Control additive closure

The production Electron Runner Setup journey passed with the then-current 65-operation manifest:

- login and Workspace-owned enrollment;
- QR decode and pending fingerprint;
- confirm, device claim, connect, capability/authentication presentation, connection test;
- disconnect/reconnect, credential rotation, revoke, and Calendar return.

Actual PostgreSQL/HTTP verification also observed exact same-key replay with one challenge row,
changed-payload conflict, and independent same-key execution in Workspace A/B.

Evidence:
`docs/operations/evidence/2026-07-25-runner-control-idempotency.md`.

### Original contract-freeze observation

The built Electron proxy was connected to a real local production-mode Gateway process. No
fake upstream response was used for this gate.

Observed:

```json
{
  "preflight": {
    "status": 204,
    "allowHeadersContainAll": true
  },
  "discovery": {
    "status": 200,
    "contractHeader": "client-v1",
    "contractId": "client-v1",
    "families": [
      "identity",
      "unified-calendar",
      "calendar-ai",
      "agent-work",
      "automation",
      "knowledge",
      "notifications"
    ],
    "operationCount": 55
  },
  "negotiatedRead": {
    "status": 200,
    "contractHeader": "client-v1"
  },
  "negotiatedMutation": {
    "status": 503,
    "passedContractValidation": true,
    "downstreamState": "phase1_pool_unavailable"
  },
  "unsupported": {
    "status": 406,
    "error": "client_contract_not_acceptable",
    "supportedContracts": [
      "client-v1"
    ]
  }
}
```

The mutation intentionally used a local Gateway without PostgreSQL. Reaching the truthful
`phase1_pool_unavailable` response proves the contract and idempotency headers survived the
real Electron proxy; otherwise the Gateway would have rejected the request at contract
validation with `client_idempotency_key_required`.

## Remaining Phase 10 Gates

This evidence does not authorize Mobile implementation. The roadmap still requires:

- two consecutive signed Desktop release candidates;
- four weeks of private beta without unresolved P0/P1;
- observed live backup/PITR/deployment/Runner rollback evidence;
- external Calendar and selected Engine Adapter support SLO evidence;
- live Web signup/support/security/privacy/distribution paths;
- supported-client usage evidence, explicit removal dates, and eligible legacy cleanup.
