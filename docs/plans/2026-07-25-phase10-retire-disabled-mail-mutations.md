# Plan: Retire disabled Desktop Mail mutations

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Remove the Desktop calls to Mail routes that production intentionally rejects. Keep the truthful
Workspace-scoped Mail read surface and the supported path that delegates selected Mail content to
Agent Work.

## Non-goals

- Do not add a Gmail connector or store provider credentials.
- Do not implement archive, star, or message mutation without an account-bound OAuth connector.
- Do not remove compatibility routes without production zero-traffic evidence.
- Do not start Mobile implementation.

## Work size

Large / Boundary. The change crosses Desktop UI and API contracts and changes the supported-client
classification of three Backend production routes.

## Touched boundaries

- Desktop app: Mail UI and orchestration in `apps/desktop/src/**`
- Desktop contract tests: `apps/desktop/tests/**`
- Backend lifecycle gate: `apps/backend/app/lib/route-lifecycle.js`
- Backend contracts: `apps/backend/tests/phase10-route-lifecycle.test.cjs`
- Operations evidence: `docs/operations/evidence/**`

## Success criteria

- Desktop no longer sends `POST /api/mail/accounts`, `POST /api/mail/sync`, or
  `POST /api/mail/messages/:id/:action`.
- Mail never asks for a Gmail app password.
- Mail remains readable through `GET /api/mail/messages`.
- A selected Mail item can still be delegated through the supported Agent Work flow.
- The lifecycle report lists no `supported-client-disabled` routes.
- Existing Backend and Desktop contracts remain green.

## Edge cases

- Empty and unavailable Mail state remain explicit and do not display chat/command data.
- Existing Mail records remain readable; no persistence migration or deletion occurs.
- A user cannot mistake unsupported star/archive controls for working provider actions.
- Compatibility and removal-candidate routes remain blocked until their separate safety gates pass.

## Test plan

1. RED: assert the Desktop Mail client exposes only the read boundary and no mutation methods.
2. RED: assert the lifecycle report has no supported-client-disabled consumer mismatch.
3. GREEN: remove the obsolete API methods and their App/UI call sites.
4. GREEN: preserve Mail read, reload, and Agent Work delegation behavior.
5. Run focused contracts, Desktop typecheck/build, Backend syntax/tests, and root regression.
6. Manually drive the Mail surface and observe no disabled POST requests.

## Acceptance gates

- [x] Focused Desktop Mail API contract
- [x] Focused Backend route lifecycle contract
- [x] Desktop typecheck
- [x] Desktop production build
- [x] Backend syntax and tests
- [x] Root regression suite
- [x] Playwright Mail surface QA with request inspection

## Step-by-step checklist

- [x] Audit all Desktop callers of the three disabled routes.
- [x] Add failing contracts for the supported read-only boundary.
- [x] Remove Gmail app-password setup and Mail mutation controls.
- [x] Remove obsolete Desktop API methods and orchestration.
- [x] Re-run lifecycle audit and record exact remaining Mobile-entry blockers.
- [x] Complete manual Desktop QA and regression gates.

## Verification notes

- RED: Desktop Mail API contract exposed obsolete mutation methods; lifecycle report returned three
  supported-client-disabled dependencies.
- GREEN: Desktop Mail/Communication contracts 7 passed; lifecycle contracts 9 passed.
- `npm run backend:check`: passed.
- `npm run build:desktop`: passed.
- `npm test`: Backend 457, Desktop 260, Runner 29 passed.
- Playwright Mail QA: three Mail reads, one `POST /api/tasks`, zero disabled Mail mutations.
- Visual artifacts: `apps/desktop/test-results/phase10-mail-read-only/`.

## Remaining risks

- A future Mail connector needs a separate account-bound OAuth design, scopes, revocation, and
  Workspace isolation review.
- Mobile entry remains blocked by dated compatibility/removal candidates and the test-only Google
  connection route until their own evidence-backed cleanup gates pass.

## Rollback / fallback

Restore the removed Desktop methods and controls only behind a production-supported,
Workspace-scoped OAuth connector. No database rollback is required because this slice does not
change or delete persisted Mail data.
