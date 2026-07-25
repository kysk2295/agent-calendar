# Phase 10 client-v1 contract freeze evidence

- Date: 2026-07-25
- Scope: production Gateway, Desktop renderer/main process, local Electron proxy
- Result: verified contract-freeze slice; Mobile implementation remains blocked by the other
  Phase 10 entry criteria

## Frozen Interface

`client-v1` exposes one tenant-free manifest at `GET /api/contracts/client-v1`.

The manifest contains 55 supported operations across exactly these seven families:

1. identity
2. unified-calendar
3. calendar-ai
4. agent-work
5. automation
6. knowledge
7. notifications

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
contract identifiers before authentication or Workspace access. Ordinary unversioned JSON
requests retain their existing behavior.

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

GREEN:

- Focused Backend contract: 5 passed.
- Focused Desktop client/proxy/secure-session contract: 21 passed.

## Broad Verification

- `npm run backend:check`: passed.
- `npm test`: passed.
  - Backend: 454 passed.
  - Desktop: 258 passed.
  - Runner: 23 passed.
- `npm run typecheck`: passed.
- `npm run build:desktop`: passed.

The existing non-blocking Vite large-bundle warning remains unchanged.

## Manual QA Gate

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
