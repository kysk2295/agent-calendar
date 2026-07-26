# Plan: Phase 1 full Gateway Workspace cutover (production mode)

- Date: 2026-07-24
- Owner: Codex (single worker; no agents / no stage-commit)
- Work size: Large | Boundary
- Status: Verified
- Prior slices:
  - `docs/plans/2026-07-24-phase1-identity-workspace-foundation.md`
  - `docs/plans/2026-07-24-phase1-backend-security-boundary.md`
  - `docs/plans/2026-07-24-phase1-workos-desktop-login.md`
- Roadmap: Phase 1 stories 1–5 exit (full product-route cutover)

## Goal

When `WORKSPACE_AUTH_MODE=production`, every product-data `/api/*` route reachable by Desktop
either executes through an access-token-derived, server-issued `WorkspaceScope` + FORCE RLS
transaction, or fails closed with an explicit production-disabled / runner-required contract.
There is **no** fallthrough to global `apiToken` auth, legacy `PostgresHermesStore` in-memory
singleton, or unscoped handlers for persisted reads, writes, SSE, chat, scheduler, Wiki,
Agent Work, automations, settings, or proxy product paths.

## Non-Goals

- Runner enrollment, device proof, or RunnerControl implementation (may return explicit
  blocked/deferred / runner-required only).
- Live WorkOS cloud credentials / AuthKit dashboard configuration.
- Full Hermes remote runtime / TickTick / mail connector execution under Workspace (explicit
  production-disabled or deferred contracts instead of silent success).
- Staging or committing unrelated dirty worktree changes.
- Multi-agent / concurrent worker execution of this slice.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js` (composition point only for
  production dispatch; no legacy product fallthrough)
- Backend library:
  - `apps/backend/app/lib/production-route-registry.js` (new)
  - `apps/backend/app/lib/production-gateway-dispatch.js` (new)
  - `apps/backend/app/lib/production-product-routes.js` (new)
  - `apps/backend/app/lib/workspace-idempotency.js` (new)
  - `apps/backend/app/lib/workspace-scoped-product-service.js` (expand CRUD/aggregate)
  - `apps/backend/app/lib/phase1-auth-routes.js` (wire production dispatch)
  - `apps/backend/app/lib/workspace-request-context.js` (unchanged contract)
  - `apps/backend/app/lib/workspace-sse-hub.js` (reuse)
- DB/migrations: `0016_idempotency_request_lifecycle.sql` only if required for
  in-progress/completed/failed + route/action columns
- Electron bridge: proxy already prefers `getAccessToken`; no token to renderer
- React UI: only if envelope keys require minimal compatibility fixes
- Tests:
  - `apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs` (hostile matrix + registry)
  - `apps/desktop/tests/playwright-workos-production-cutover-e2e.cjs` (single Electron E2E)
- Docs: this plan, roadmap Phase 1, durable evidence JSON

## Success Criteria

- [x] Machine-checkable route inventory exists; Desktop call inventory is fully classified
- [x] Test fails if a production `/api/*` product path is unregistered / unguarded
- [x] `GET /api/gateway-status` does not leak tenant/global product data anonymously
- [x] Hostile two-user / two-Workspace real-Postgres matrix passes (anonymous, legacy Bearer,
      spoofed workspaceId, direct ID guess, list/search/SSE/cache/chat/scheduler/agent-work/
      automation/settings mutations, cross-Workspace idempotency keys, role enforcement)
- [x] Production never touches a foreign row or global in-memory product store
- [x] Universal idempotency for production POST/PATCH/DELETE (Workspace key + request hash +
      route/action; replay; conflict on payload mismatch; concurrent duplicate)
- [x] `WORKSPACE_AUTH_MODE=legacy` still serves personal-beta unscoped behavior
- [x] Single Electron E2E: fake AuthKit + production backend + ephemeral PG; login →
      calendar/task/wiki/agent-work/automation read+safe mutation → SSE checkpoint → restart
      restore → data only in that Workspace; second-account negatives at backend layer
- [x] Screenshots inspected; no orphan Electron/PG; full gates green; evidence updated

## Edge Cases

- Anonymous product route: 401, no store access
- Legacy global Bearer in production: 401, never scoped as identity
- Body/query/header `workspaceId` spoof: ignored; scope only from access token session
- Foreign resource ID: opaque 404 (not 403 leak)
- Member role on owner-only consequential mutation: 403
- Idempotency key reuse different payload: 409 conflict
- Concurrent same key: one winner, other waits or replays completed body
- Unimplemented external connector: explicit `production_disabled` or
  `runner_required` / deferred Workspace-owned record — never silent 200 success
- Unknown path in production: fail closed before legacy handler

## Route classification (summary; machine source of truth in registry)

| Class | Examples | Production behavior |
| --- | --- | --- |
| `public_infra` | `GET /api/health`, hardened `GET /api/gateway-status` | No product data; status is infra-only |
| `auth_public` | desktop start/complete | No session; AuthKit only |
| `auth_session` | refresh, logout, select-workspace, trusted session | Session/token rules as today |
| `scoped_product` | tasks, calendar, agents, wiki, state, agent-ops reads, scheduler jobs, settings, events SSE, chat messages, phase1 product | Access token → WorkspaceScope → RLS |
| `provider_webhook` | telegram webhook | Signature/provider path; not user product auth |
| `runner_future` | runner enrollment, device challenge | Explicit not-implemented / 404-or-501 contract |
| `production_disabled` | mail sync, ticktick import/sync that needs external secret store, unscoped hermes remote writes without runner | Explicit disabled contract |
| `legacy_only` | anything only for personal beta | Reachable only when `WORKSPACE_AUTH_MODE=legacy` |

Exact counts are recorded after GREEN in Verification Notes and evidence JSON.

## Test Plan

### RED

- [x] Observed: production Desktop `/api/tasks` previously returned only `workspace_auth_required`
      without scoped execution for valid app sessions; registry and universal idempotency were
      missing; anonymous `gateway-status` could fall through to legacy handleApi product fields.

### GREEN

- [x] Production dispatch + scoped product service + registry + idempotency make hostile matrix
      and Desktop-shaped envelopes pass.
- [x] Legacy mode regression smoke still allows unscoped bearer path composition (`handled=false`).

### REFACTOR

- [x] railway-gateway-server composition remains thin; handlers live in lib modules.
- [x] Hostile matrix asserts `globalStoreMutations === 0`.

## Acceptance Gates

- [x] Narrow RED evidence (observed fail reason)
- [x] Narrow GREEN: `node --test apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs` → **3/3**
- [x] `npm run backend:check` → pass
- [x] `npm run test:backend` → **347/347**
- [x] `npm run typecheck` → pass
- [x] `npm --workspace apps/desktop run test` → **167/167**
- [x] `npm run build:desktop` → pass
- [x] One foreground Electron E2E with hard timeout + cleanup → `completeCount=1`, `restartRestore=true`
- [x] `git diff --check` → pass
- [x] No orphan Electron / ephemeral PG processes after cleanup

Skipped gate:

- Live WorkOS credentials/dashboard smoke
  - Reason: manual operator gate; not part of this code cutover

## Implementation Checklist

- [x] Write plan (this file)
- [x] RED: registry + hostile cutover test file
- [x] Production route registry (Desktop + gateway inventory)
- [x] Production gateway dispatch at single composition point
- [x] Expand WorkspaceScopedProductService (CRUD + aggregate hydration)
- [x] Universal workspace idempotency middleware
- [x] Migration 0016 if idempotency lifecycle columns required
- [x] Wire phase1/gateway composition; harden gateway-status
- [x] Explicit production_disabled / runner_required contracts
- [x] Role enforcement (owner vs member) on consequential mutations
- [x] Desktop E2E (production mode) + dual surface screenshots
- [x] Full gates + evidence + roadmap honesty update

## Verification Notes

### RED (observed pre-implementation baseline)

- Prior production mode: any Desktop product `/api/*` returned `401 workspace_auth_required`
  even for valid Workspace access tokens (fail-closed block, not scoped cutover).
- No machine-checkable registry; no universal idempotency middleware; gateway-status not
  infra-hardened under production dispatch.

### GREEN (observed 2026-07-24)

- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs`
  - Result: **3/3 pass**
- Command: `npm run backend:check` → pass
- Command: `PHASE0_PG_BIN=... npm run test:backend` → **347/347 pass**
- Command: `npm run typecheck` → pass
- Command: `npm --workspace apps/desktop run test` → **167/167 pass**
- Command: `npm run build:desktop` → pass
- Command: `PHASE0_PG_BIN=... node apps/desktop/tests/playwright-workos-production-cutover-e2e.cjs`
  - Result: `ok=true`, `completeCount=1`, `restartRestore=true`, `secondAccountIsolation=true`
- Evidence: `docs/operations/evidence/2026-07-24-phase1-full-gateway-workspace-cutover.json`

### Route inventory totals

- Total registered routes: **92**
- public_infra: **2**
- auth_public: **2** / auth_session: **4**
- scoped_product: **62** (includes hydrate-safe `GET /api/mail/messages` empty mailbox)
- provider_webhook: **7**
- runner_future: **2**
- production_disabled: **13**
- legacy_only: **0** (legacy behavior is mode-gated fallthrough, not registered production routes)
- Desktop hermesApi paths covered: **60/60**

### Explicitly disabled production routes

- `POST /api/phase1/agent-work/:sessionId/publish` (404)
- `POST /api/phase1/schedule/embed-probe` (410)
- `POST /api/tasks/share-draft`, `POST /api/calendar/draft`
- `POST /api/scheduler/tick`, `POST /api/agent-operations/tick`
- `POST /api/assistant/ingest`, `POST /api/workboard/convert`
- Mail mutations: `POST /api/mail/*` (list is scoped empty)
- TickTick: `POST /api/ticktick/import|sync`
- Runner future: `GET /api/runner/adapters`, `POST /api/runner/enroll` → 501 runner_required

### Manual QA correction (visual surfaces)

- Diagnosed hydrate banner: `GET /api/mail/messages` was `production_disabled` → red global
  `Railway API 확인 필요` on calendar/wiki. Reclassified to scoped empty mailbox.
- Calendar events map `startsAt` → Desktop `date`/`time` for grid pills.
- Agent ops snapshot returns designed `runner_required` / `daemon.mode=runner_required`;
  UI label `Runner 미연결 · 실행은 Workspace Runner 필요` (not Hermes scheduler failure).
- E2E hard-asserts: no `.api-banner` / `production_disabled` text; seeded event/task/wiki
  visible; agent runner-required label. Screenshots re-captured and visually inspected clean.

## Remaining Risks

- Risk: Agent Work live turn / external execution still runner-dependent
  - Mitigation: explicit deferred/runner_required; no silent success; reads are scoped
- Risk: Legacy `PostgresHermesStore` still used in legacy mode and may be constructed in
  production process for non-product paths
  - Mitigation: production product dispatch never reads/writes that store; tests assert
    global store not mutated
- Risk: Desktop envelope drift
  - Mitigation: E2E + hydrate-shaped aggregate tests
- Risk: Incomplete connector surface
  - Mitigation: production_disabled inventory is honest and machine-checked
