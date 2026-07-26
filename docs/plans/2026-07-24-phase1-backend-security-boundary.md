# Plan: Phase 1 Backend Security Boundary — RLS, Sessions, Scoped Gateway Surface

- Date: 2026-07-24
- Owner: Grok
- Work size: Large / Boundary
- Status: Verified — backend security boundary slice (not full Phase 1 / no Desktop WorkOS)
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Prior slice (historical evidence): `docs/plans/2026-07-24-phase1-identity-workspace-foundation.md`
- Related ADRs: `docs/adr/0008-bind-runners-to-authenticated-workspaces.md`, `docs/adr/0009-provider-auth-calendar-signing-distribution.md`

## Goal

Make two authenticated Workspaces unable to cross-read or cross-mutate product data on a real ephemeral PostgreSQL cluster by completing remaining ownership migrations, FORCE RLS under a non-BYPASSRLS app role, hashed rotating sessions from already-verified provider subjects, and a fail-closed Phase 1 authenticated route group that exercises scoped list/direct-ID, Wiki search, agent-work SSE, and schedule embedding cache with Workspace-keyed isolation.

## Non-Goals

- Desktop login UI / Electron secure storage cutover.
- Live WorkOS network integration or real provider JWT verification (accept already-verified provider subject at the Adapter boundary only).
- Full rewrite of every legacy gateway handler into scoped form.
- Claiming disabled legacy routes are “complete.”
- RLS on Runner enrollment (Phase 2), external calendar connectors (Phase 4), or Mobile.
- Stage, commit, spawn agents, or edit unrelated dirty worktree files.

## Work Size

Large / Boundary: migrations 0010–0012, auth session protocol, request Workspace context, RLS app role, partial gateway cutover, multi-path isolation tests.

## Touched Boundaries

- Backend gateway: minimal mount of Phase 1 auth routes + production-auth fail-closed gate in `railway-gateway-server.js`
- Backend library: session service, request context, scoped product services (store/search/SSE/cache), workspace-scope (reuse)
- DB/migrations: `0010`, `0011`, `0012`
- Electron / React: none
- Tests: `apps/backend/tests/phase1-backend-security-boundary.test.cjs`
- Docs: this plan; evidence under `docs/operations/evidence/`; roadmap Phase 1 status

## Success Criteria

- [x] Child plan exists; first-slice plan left as historical evidence.
- [x] RED path defined (missing 0010–0012 / session / RLS / phase1 routes); GREEN observed on full suite after implementation.
- [x] Migrations expand/backfill every remaining persisted product table to legacy workspace; row counts preserved.
- [x] Auth sessions + rotating refresh (hashed) + audit/idempotency tables exist.
- [x] FORCE RLS + non-BYPASSRLS app role; hostile SQL under app role fails across workspaces.
- [x] Session service maps provider subject → User/membership; issues/rotates/revokes tokens; rejects body workspace authority, inactive membership, expiry, refresh replay.
- [x] Phase 1 authenticated routes prove isolation for tasks/calendar list+direct, wiki search, SSE, schedule cache keys.
- [x] Production workspace-auth mode fails closed on unscoped legacy product routes; legacy mode flag documented.
- [x] Manual QA evidence redaction-safe; cluster stopped.
- [x] `npm run backend:check` and `npm run test:backend` pass.
- [x] Roadmap updated truthfully with remaining surfaces listed.

## Edge Cases

- Identical display titles across workspaces; distinct primary keys (global PK remains).
- Known foreign IDs in path/query → empty/404 for wrong workspace, never leak payload.
- Inactive user/workspace/membership; revoked session; expired access; refresh replay → forbidden.
- Cache key collision without workspace prefix → must not cross-serve.
- SSE subscription for other workspace mission/session → rejected.
- Direct SQL as app role with forged `app.workspace_id` only if SET ROLE allows — policies must bind to transaction setting set by server only in tests after authenticated path; forged setting without membership still cannot read rows of other workspace if setting is wrong… actually RLS uses setting: attacker SET LOCAL app.workspace_id = victim would work if they can SET ROLE app. **Server must only set config after session validation; app role should not be granted to untrusted clients.** Test proves: with setting = A, cannot read B rows; with setting = B without membership, still only B rows exist that B owns — the protection is row filter by setting, membership is app-layer. Both layers required.
- Compatibility: `WORKSPACE_AUTH_MODE=legacy` keeps global bearer behavior for Phase 0 envelopes; `production` fails closed.

## Test Plan

### RED

- [x] Declared hostile suite requires migrations 0010–0012, session service, RLS app role, Phase 1 routes, workspace-keyed cache/SSE (absent before this slice).

### GREEN

- [x] Smallest migrations + services + Phase 1 route group pass hostile real-PG suite.
- [x] Manual QA CLI writes evidence and stops cluster.

### REFACTOR

- [x] Keep first-slice calendar repository working; Phase 0 rehearsal still filters 0001–0007.

## Acceptance Gates

- [x] Narrow: `node --test apps/backend/tests/phase1-backend-security-boundary.test.cjs`
- [x] Manual QA + evidence + cluster stopped
- [x] `npm run backend:check`
- [x] `npm run test:backend`

Skipped: Desktop typecheck/Playwright (no UI in this slice).

## Implementation Checklist

- [x] Write this plan
- [x] RED tests
- [x] Migration 0010 remaining tables ownership
- [x] Migration 0011 sessions/audit/idempotency
- [x] Migration 0012 RLS + app role
- [x] Session service + request context
- [x] Scoped wiki/SSE/cache helpers + Phase 1 route group
- [x] Gateway production-auth fail-closed + mount
- [x] GREEN + QA + full backend
- [x] Roadmap truthful update

## Rollback / Fallback

- `WORKSPACE_AUTH_MODE=legacy` (default for personal beta) preserves prior global bearer access.
- New migrations are expand-style + idempotent; app role grants are additive.
- If RLS blocks operations, set mode to legacy and use superuser migrations only for ops (document; not silent).

## Legacy routes under production auth mode

**Disabled / fail-closed** (not complete): unscoped product handlers that still rely on global `HERMES_REMOTE_AUTH_TOKEN` alone without Workspace session — calendar CRUD, wiki, agent-work, chat, scheduler mutations via legacy `/api/*` paths outside `/api/phase1/*`, unless explicitly allow-listed (health, telegram webhook, relay with separate device token).

**Enabled Phase 1 public surface (migrations through 0014):**

| Route | Behavior |
| --- | --- |
| `POST /api/phase1/auth/session\|refresh\|logout` | Session issue (trusted `identityVerifier` only), refresh, logout |
| `GET /api/phase1/tasks`, `/tasks/:id` | Workspace-scoped list/direct |
| `GET /api/phase1/calendar-events`, `/calendar-events/:id` | Workspace-scoped list/direct |
| `GET /api/phase1/wiki/search` | Keyword default; `mode=vector` is pgvector (malformed vector → **400** `VECTOR_LENGTH_INVALID`) |
| `GET /api/phase1/agent-work/:sessionId/events` | **JSON snapshot only** (not SSE) |
| `GET /api/phase1/agent-work/:sessionId/stream` | **SSE** `text/event-stream` with connected comment frame + workspace-keyed events |

**Not public / not claimed:**

- `POST /api/phase1/agent-work/*/publish` — **removed** (404); checkpoint producers must use injected internal `runtime.sseHub` (future RunnerControl), never user HTTP.
- `POST /api/phase1/schedule/embed-probe` — **410 removed**; schedule-assistant `recordEmbeddingCacheKey` is workspace-keyed, but **no Calendar AI production HTTP route** is claimed.
- Health / relay / telegram remain separate allow-lists under production auth mode.

## Verification Notes

### RED (historical honesty)

- The initial Phase 1 security-boundary green was **not** captured as a real observed RED→GREEN TDD loop for all claimed paths. Do not describe that work as verified TDD.

### RED (security hardening 2026-07-24 — observed)

- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-backend-security-hardening.test.cjs` against pre-hardening code
  - Result: **fail 6 / pass 1** — concrete failures included:
    1. `POST /api/phase1/auth/session` returned **200** with body `providerSubject` (no trusted verifier)
    2. missing `auth_sessions_access_token_hash_key` UNIQUE
    3. no real `text/event-stream` route (`404` on `/stream`)
    4. `recordEmbeddingCacheKey` not exported / no workspaceId
    5. `searchWikiVector` missing
    6. missing `wiki_artifacts_workspace_run_fkey` (and related composites)
  - Evidence log: session capture `/tmp/phase1-hard-red2.txt` (local)

### GREEN (security hardening 2026-07-24)

- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-backend-security-hardening.test.cjs`
  - Result: **7/7 pass**
- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-backend-security-boundary.test.cjs`
  - Result: pass after verifier injection + probe removal
- Command: manual QA tool + evidence rewrite (schemaVersion 2)
- Command: `npm run backend:check` → **pass**
- Command: `npm run test:backend` → **336/336 pass**
- Hardening additions: migration `0013_security_hardening_constraints.sql`; trusted `identityVerifier`; atomic refresh with committed family revoke; real SSE `/stream`; schedule-assistant `workspaceId` cache keys; `searchWikiVector`; fail-closed composite FKs; production error redaction

### Final acceptance hardening (observed RED → GREEN)

- RED (`phase1-backend-security-hardening.test.cjs` before final edits; **2 fail / 7 pass**):
  - wiki_artifacts FK def was bare `ON DELETE SET NULL` (not `(run_id)`)
  - mismatched auth_refresh_tokens inserts were accepted (missing composite session identity FK)
  - (suite also asserts winner accessToken unusable after concurrent refresh; RLS FORCE+SELECT; 16-table legacy backfill; vector length 256)
- GREEN after (**9/9 hardening**, **14/14** phase1 narrow suite, QA **19/19** checks):
  - `0010`/`0013` drop+recreate `wiki_artifacts_workspace_run_fkey` with `ON DELETE SET NULL (run_id)` (replay corrects old def)
  - `0014_auth_refresh_session_integrity.sql` composite UNIQUE/FK session identity
  - `searchWikiVector` rejects non-256 vectors with `VECTOR_LENGTH_INVALID`
  - concurrent refresh: winner `accessToken` rejected by `authenticateAccessToken` after family revoke
  - RLS FORCE + foreign SELECT isolation for product + auth/audit/idempotency tables
  - all 16 legacy tables retain `legacy-personal-workspace` rows
  - evidence schemaVersion 2 expanded checks include `wikiFkColumnListSetNull`, `artifactDeleteKeepsWorkspace`, `refreshIdentityFk`, `all16LegacyWorkspace`, `rlsForceAll`

## Remaining Risks

- Risk: Full gateway still huge; many legacy handlers unscoped.
  - Mitigation: Explicit production fail-closed; route inventory in this plan.
- Risk: RLS uses `current_setting`; mis-set config is dangerous if app role is shared.
  - Mitigation: Only server sets config after session validation; never trust body workspaceId.
- Risk: Global primary keys still prevent true per-workspace ID reuse.
  - Mitigation: Documented; isolation by workspace_id + RLS.
- Risk: No real WorkOS verification yet.
  - Mitigation: Adapter boundary only accepts already-verified subject; network IdP is later story.
