# Closed client-v1 Desktop Surface Evidence

- Captured: 2026-07-25
- Scope: Desktop route inventory, provider agent/session management, client-v1 negotiation,
  route lifecycle, actual Electron Codex surface
- Result: INTERNAL CONTRACT PASS; final two-account production identity/provider gate remains open

## Corrected boundary

Desktop declared `client-v1` on every request, but the manifest described only 65 operations.
Thirty-seven registered Desktop product routes were outside the manifest, and ten provider
agent/session management routes used by Desktop were absent from the Desktop inventory. An
explicit `client-v1` request could therefore use a registered scoped product route that was not
part of the advertised contract.

The closed interface now has:

- 112 immutable operations in 10 families;
- 80 inventoried Desktop routes;
- zero `stable-desktop` scoped/auth product routes;
- explicit provider agent create/update/archive/restore, catalog request/import, session
  list/update/catalog request/import operations;
- reverse Desktop-inventory-to-manifest drift detection;
- `406 client_route_not_in_contract` for an explicit client-v1 request to an unlisted scoped/auth
  product route;
- required retry-stable idempotency keys for every listed idempotent mutation.

Public infrastructure, Runner device, and provider webhook protocols remain independent. Ordinary
unversioned compatibility requests retain their previous behavior.

## TDD

Expected RED:

- 37 Desktop scoped product routes were reported outside the manifest.
- 10 provider agent/session routes were reported missing from Desktop inventory.
- settings and provider catalog mutations passed contract validation without an idempotency key.
- an explicit client-v1 compatibility product route passed instead of returning 406.
- route lifecycle reported 37 scoped product routes as `stable-desktop`.

GREEN:

- focused client-v1 and lifecycle tests: 15/15.
- contract assertion: 112/112 operations.
- scoped/auth `stable-desktop`: 0.

## Broad verification

- `npm run backend:check`: pass.
- `npm run typecheck`: pass.
- Desktop tests: 274/274.
- Runner tests: 46/46.
- Backend tests: 506/506.
- Desktop production build: pass as part of the Electron ETE.
- `git diff --check`: pass.

The existing non-blocking Vite chunk-size warning is unchanged.

## Actual Electron + real Codex Runner

Command:

`AGENT_CALENDAR_E2E_LIVE_ENGINE=codex AGENT_CALENDAR_E2E_TIMEOUT_MS=900000 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed:

- duration: 101,338ms;
- actual local Codex CLI authenticated;
- Workspace Runner enrolled and reconnected;
- provider agent catalog queried and one agent imported;
- existing provider session imported;
- follow-up delivered to the same external provider session;
- realtime and curated tool checkpoints observed;
- artifact and Unified Calendar result observed;
- Gateway and Electron restarted;
- same provider session, Work Conversation, artifact, and Calendar result restored;
- completed attempts: 2; failed attempts: 0.

Manual surface inspection:

- `apps/desktop/test-results/phase3-golden-ete-codex/provider-session-continued.png`
- `apps/desktop/test-results/phase3-golden-ete-codex/provider-session-rehydrated.png`

The inspected surface showed the connected Codex agent, provider session rail, same Work
Conversation title and timeline, agent/engine/Runner details, composer, and restored session after
restart.

## Open final gate

This does not make the whole Agent feature complete.

- The Electron identity was `workos_authkit_test_adapter`, not production WorkOS.
- The current Railway production services do not have WorkOS credentials configured.
- Two separately authenticated Runner provider homes were not available in this environment.
- Therefore the required production WorkOS clean-account and strict two-account provider ETE was
  not run and remains unchecked in
  `docs/plans/2026-07-25-provider-native-agent-session-bridge.md`.
- No Mobile work was started.
