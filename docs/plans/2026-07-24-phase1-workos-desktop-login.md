# Plan: Phase 1 WorkOS AuthKit + Desktop Login

- Date: 2026-07-24
- Owner: Grok
- Work size: Large / Boundary
- Status: Verified — WorkOS AuthKit Desktop login (SDK installed; restart restore proven completeCount=1; live credentials/dashboard gate open only)
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Prior slices: `docs/plans/2026-07-24-phase1-identity-workspace-foundation.md`,
  `docs/plans/2026-07-24-phase1-backend-security-boundary.md`
- Related ADR: `docs/adr/0009-provider-auth-calendar-signing-distribution.md`

## Goal

Desktop signs in through WorkOS AuthKit (system browser, Google + email magic link on the
hosted UI). The Railway backend owns AuthKit PKCE, maps a verified WorkOS subject to
User/Workspace membership, and issues Agent Calendar access/refresh sessions. Tokens never
reach the renderer; Electron stores them only in safeStorage-backed encrypted storage and
attaches them via the local proxy.

## Non-Goals

- Runner enrollment or RunnerControl (Phase 2).
- Full legacy gateway cutover beyond auth + proxy session attachment.
- Live external WorkOS network in CI (fake AuthKit adapter in tests).
- Multi-workspace product UI beyond selection safety.
- Mobile / Web AuthKit.
- Stage, commit, spawn agents, or edit unrelated dirty worktree files.

## Work Size

Large / Boundary: migration 0015, backend AuthKit adapter + desktop login routes, bootstrap,
Electron secure session + deep-link callback, React login UI, proxy Authorization, Playwright
Electron E2E.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js` (Phase 1 runtime may receive
  AuthKit adapter; no broad legacy rewrite)
- Backend library: new WorkOS AuthKit adapter + desktop login service; extend
  `phase1-auth-routes.js`, `workspace-auth-session.js` (bootstrap helper)
- DB/migrations: `0015_desktop_login_transactions.sql`
- Electron bridge: `auth.ts`, `deepLink.ts`, `deepLinkMain.ts`, `main.ts`, `proxy.ts`,
  `settings.ts`, `preload.ts` / `preload.cts`, new secure session module
- React UI: `apps/desktop/src/App.tsx` (login/settings auth surface), types in `vite-env.d.ts`
- Tests: backend Phase 1 WorkOS desktop login suite; desktop unit + Electron Playwright E2E
- Docs: this plan; roadmap Phase 1 story 3 status only if needed

## Architecture Decisions

### AuthKit ownership (backend)

- Production adapter wraps `@workos-inc/node`:
  - `userManagement.getAuthorizationUrlWithPKCE({ clientId, redirectUri, provider: "authkit", state, screenHint })` → `{ url, codeVerifier }`
  - `userManagement.authenticateWithCodeAndVerifier({ clientId, code, codeVerifier })` (adapter
    name; production may map to SDK `authenticateWithCode` + `codeVerifier` if SDK naming differs)
- App session refresh/logout remain `workspace-auth-session` (never WorkOS tokens as product auth).
- Missing `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` (or injected adapter config) → **503** redacted
  fail-closed. Never fake auth.

### Desktop login transactions (migration 0015)

Durable one-use rows:

| Column | Rule |
| --- | --- |
| `id` | Opaque transaction id |
| `state_hash` | SHA-256 of public OAuth `state` (unique while pending) |
| `verifier_hash` | SHA-256 of PKCE verifier (never store plaintext) |
| `redirect_uri` | Fixed allowlisted `agent-calendar://auth/callback` |
| `status` | `pending` → atomic `completed` \| `failed` \| expired cleanup |
| `expires_at` | Short TTL (e.g. 10 minutes) |
| No authorization `code` column | Codes are one-shot request inputs only |

Complete: hash-check state + supplied verifier, `UPDATE … WHERE status='pending' AND expires_at>now()`
must affect exactly one row, then WorkOS exchange. Exchange failure marks failed; never issues session.

### Clean account bootstrap

- Verified WorkOS user `id` is the provider subject (`provider = 'workos'`).
- Email is profile data in `users.payload` / identity payload — **not** authorization authority.
- First login: atomically upsert `users` + `auth_identities`, create **exactly one** personal
  Workspace + `owner` membership.
- Repeat login: reuse identity → user → existing membership(s).

### Workspace binding decision (documented)

**Current release: single personal Workspace per operator.**

- Bootstrap always creates one personal workspace on first login.
- When the user has exactly one active membership, complete issues a session for that workspace.
- When multiple active memberships exist (edge / future), complete **does not** auto-pick and
  **does not** accept body `workspaceId` as authority. It returns only authorized workspace
  choices plus a server-issued opaque **selection transaction**; a follow-up
  `POST /api/phase1/auth/desktop/select-workspace` completes session issuance after membership
  check. Cross-workspace theft via forged workspace id is impossible.
- Never return WorkOS access/refresh tokens to Desktop or renderer.

### Public HTTP surface

| Route | Public? | Behavior |
| --- | --- | --- |
| `POST /api/phase1/auth/desktop/start` | Yes | Begin PKCE; return `authorizationUrl`, `state`, `codeVerifier`, `transactionId` |
| `POST /api/phase1/auth/desktop/complete` | Yes | Validate state/tx/verifier/redirect/expiry/one-use; exchange; bootstrap; app session |
| `POST /api/phase1/auth/desktop/select-workspace` | Yes (gated by selection tx) | Multi-membership only |
| `POST /api/phase1/auth/session` | **Trusted-internal only** | Still requires injected `identityVerifier`; not a Desktop public login path |
| `POST /api/phase1/auth/refresh` \| `logout` | Session-bearing | Existing app session layer |

### Electron

- System browser: `shell.openExternal(authorizationUrl)`.
- Deep link: `agent-calendar://auth/callback` separate from `agent-calendar://sessions/...`.
  Strict parse: exact scheme/host/path, only `code` + `state`, reject credentials/port/hash/
  duplicates/unknown params.
- Protocol registered for packaged app; dev path tested via argv / open-url / second-instance.
- Secure session manager: after `app.ready`, Electron `safeStorage` encrypt-at-rest + atomic
  `0600` file replacement. Tokens never in `settings.json` or renderer.
- First-run scrub: remove plaintext `apiToken` / provider tokens from settings public path;
  force re-login. Do not delete user files destructively; leave unread legacy `auth-users.json`
  if present (password auth disabled for production path).
- Proxy: Authorization from secure session manager; single-flight refresh before expiry/401;
  never global `apiToken` for production authenticated routes.
- Renderer: proxy credential + public profile/workspace/session status only.
- Logout: revoke app session if possible, clear secure store, show login.

### UI

- Replace password fields and direct Google OAuth with one calm AuthKit sign-in action
  (hosted Google + magic link).
- Keep warm neutral/editorial control-room system — not a generic gradient auth card.
- Settings account surface uses the same action. Loading / error / callback states explicit
  and accessible.

## Success Criteria

- [x] Plan exists with architecture decisions above.
- [x] RED backend tests fail for missing 0015 / routes / bootstrap before implementation.
- [x] GREEN backend: start/complete security matrix + bootstrap + isolation on real PG.
- [x] Desktop deep-link auth parse, secure store, proxy session, AuthKit login UI green.
- [x] Electron Playwright E2E: clean userData → login → callback → calendar → relaunch restore
  → logout; forged/reused callback rejected; screenshot captured.
- [x] `backend:check`, `test:backend`, desktop typecheck/tests/build pass.
- [x] Live WorkOS credential gate documented if env unavailable (no false claim of live IdP).

## Edge Cases

- Forged state / wrong verifier / expired transaction / concurrent complete / callback replay.
- Body `providerSubject` / email as identity → ignored; only AuthKit exchange subject counts.
- Missing WorkOS config → 503 redacted.
- Unverified WorkOS user (if adapter reports) → reject.
- Legacy settings with plaintext tokens → scrub, force re-login.
- Packaged vs dev deep-link registration.
- Refresh single-flight under concurrent proxy 401.

## Test Plan

### RED

- [x] `apps/backend/tests/phase1-workos-desktop-login.test.cjs` fails (missing migration/routes).
- [x] Desktop unit tests for auth deep link + secure session fail until modules exist.

### GREEN

- [x] Backend hostile suite pass on ephemeral PostgreSQL.
- [x] Desktop unit + typecheck + build.
- [x] Electron Playwright E2E with injected fake AuthKit/backend only (no production bypass).

### REFACTOR

- [x] Deterministic Electron close/relaunch (force-kill PID + wait) only while tests green.

## Acceptance Gates

- [x] Narrow backend: `node --test apps/backend/tests/phase1-workos-desktop-login.test.cjs`
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] Desktop: `npm run typecheck` / `npm --workspace apps/desktop run test` / `npm run build:desktop`
- [x] Electron Playwright E2E + screenshot artifact path

Skipped:

- Gate: Live WorkOS cloud login
  - Reason: requires operator-provisioned `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` and AuthKit
    redirect allowlist for `agent-calendar://auth/callback` (manual final gate).

## Implementation Checklist

- [x] Write this plan
- [x] RED backend tests
- [x] Migration 0015
- [x] AuthKit adapter + desktop login service + routes
- [x] Bootstrap + session issue wiring
- [x] GREEN backend
- [x] Desktop deep link auth + secure session + proxy + main IPC
- [x] React AuthKit login UI
- [x] Desktop unit RED→GREEN
- [x] Electron Playwright E2E + screenshot
- [x] Roadmap touch only if claims need honesty update
- [x] Full verification gates

## Rollback / Fallback

- Desktop login routes fail closed without WorkOS config (503).
- `WORKSPACE_AUTH_MODE=legacy` still allows personal-beta global bearer for unscoped paths;
  production mode continues to require Phase 1 sessions for product routes.
- Migration 0015 is additive; drop of login transaction table is a separate reverse story if needed.
- Legacy password/Google modules disabled for production path but files not mass-deleted mid-slice
  beyond scrubbing secrets from settings.

## Verification Notes

### RED (backend, historical)

- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-workos-desktop-login.test.cjs`
  - Result: **fail** — `MODULE_NOT_FOUND` for `desktop-login-service` (expected before implementation).

### GREEN (backend, gap correction 2026-07-24)

- Installed production dependency `@workos-inc/node@10.8.0` via npm (root lockfile updated).
- Verified SDK surface: `getAuthorizationUrlWithPKCE` + `authenticateWithCodeAndVerifier` both present.
- Command: `node --test apps/backend/tests/workos-authkit-adapter.test.cjs` → **4/4**
- Command: `PHASE0_PG_BIN=... node --test apps/backend/tests/phase1-workos-desktop-login.test.cjs` → **3/3**
- Command: `npm run backend:check` → **pass**
- Command: `npm run test:backend` → **344/344 pass**

### GREEN (desktop, gap correction)

- Root-cause fix: `scrubLegacyPlaintextAuthSettings` no longer treats public AuthKit profiles as
  secrets (previously wiped secure session on every restart).
- Production Settings UI: Railway Bearer Token editor removed; session-auth note only.
- Command: `npm run typecheck` → **pass**
- Command: `npm --workspace apps/desktop run test` → **167/167 pass**
- Command: `npm run build:desktop` → **pass**

### Electron Playwright E2E (one foreground run; hard timeout cleared on success)

- Command: `AGENT_CALENDAR_E2E_TIMEOUT_MS=90000 node apps/desktop/tests/playwright-workos-authkit-login-e2e.cjs`
  - Result: **ok=true**, exit 0, **`completeCount=1`**, **`restartRestore=true`**, **`safeStorage=true`**
  - No re-login fallback; relaunch same userData restores session without second complete.
  - Asserted: `settings.json` has no access/refresh/API/provider tokens; `app-session.enc`
    is non-plaintext; `safeStorage.isEncryptionAvailable()===true` on real macOS Electron.
  - Screenshots (visually inspected):
    - `apps/desktop/test-results/workos-authkit-login/login-before-auth.png` — AuthKit login
    - `apps/desktop/test-results/workos-authkit-login/calendar-after-login.png` — calendar + E2E Operator
  - Orphan E2E/Electron/ephemeral PG after run: **none**
  - Hard timeout: `clearTimeout` in `finally` so success exits immediately (no 90s linger).

### Live WorkOS credential/dashboard gate (still manual; SDK is NOT)

Not claimed as live cloud login. Remaining ops only:

1. Set Railway/env secrets: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`
2. AuthKit dashboard redirect allowlist exactly: `agent-calendar://auth/callback`
3. Enable hosted Google OAuth + email magic link in AuthKit
4. Smoke one real Desktop login against live WorkOS

**Not required as a manual gate:** installing `@workos-inc/node` (already a backend dependency).

## Remaining Risks

- Risk: Live WorkOS credentials/redirect not configured in this environment.
  - Mitigation: Documented ops gate; CI uses injected fake AuthKit adapter only.
- Risk: Protocol registration differs in dev vs packaged.
  - Mitigation: Explicit tests for argv/open-url/second-instance; package.json schemes retained.
- Risk: Many legacy gateway product routes still unscoped under production auth mode.
  - Mitigation: Out of this slice; production mode fails closed on unscoped `/api/*`.
- Risk: Headless Linux CI without safeStorage.
  - Mitigation: macOS Desktop is the production path; E2E hard-requires safeStorage on this host.
