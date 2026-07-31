# Plan: Workspace-owned agent roster only

- Date: 2026-07-31
- Work size: Medium / Boundary
- Status: Verified

## Goal

Empty / new workspaces no longer show five synthetic Hermes official profiles as if they were connected agents. The product agent list is **workspace-owned agents only**.

## Non-goals

- Removing Hermes official profile names used for execution routing, Telegram bots, or inventory checks
- Building a full agent marketplace UI
- Requiring WORKSPACE_AUTH_MODE=production for local dogfood (separate follow-up)

## Touched boundaries

- Backend gateway: `railway-gateway-server.js` agent list / snapshot projection
- Backend library: `agent-registry.js` if needed
- Tests: gateway empty roster + release-blockers expectations if broken
- Docs: first-user dogfood plan note

## Success criteria

- [x] Unauthenticated / empty-gateway `GET /api/agents` returns `agents: []` (not 5 Unavailable profiles)
- [x] Empty Hermes snapshot does **not** invent `official-profile-fallback` roster members
- [x] Workspace `listAgents` still returns only DB rows for that workspace
- [x] Targeted tests green (`workspace-owned-agent-roster`, `release-blockers`)

## Edge cases

- Live relay snapshot with real profiles: keep live agents when present (real machine inventory), do not invent when empty
- Deleted agent IDs filter still works
- Run profile resolution when agents empty: keep fail-closed / default stub only for internal resolve, not for product list

## Test plan

1. Failing test: gateway empty state agents length 0 and no `official-profile-fallback` sources
2. Implementation
3. Re-run test + phase1 workos desktop login tests
4. Manual curl `GET /api/agents` → count 0

## Step-by-step

1. Write failing unit/integration assertion for empty roster
2. Stop `fallbackOfficialProfileAgents()` from filling product lists
3. Adjust `agentSourceStatus` reason without fabricating profileCount agents
4. Verify

## Remaining risks

- UI may assume non-empty agent grid; need honest empty copy if missing
- Local Hermes dogfood that relied on automatic 5-profile roster must create/import workspace agents
