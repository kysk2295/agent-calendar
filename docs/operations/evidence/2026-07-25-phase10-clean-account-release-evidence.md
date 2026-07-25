# Phase 10 clean-account release evidence producer

- Date: 2026-07-25
- Result: local producer pass; live Railway staging gate remains open
- Production mutation: none

## Actual surface run

The existing Phase 3 Golden ETE was extended to produce the exact
`clean_account_ete` document consumed by the Railway release gate. The producer accepts only a
successful single-account live Engine report.

Observed command:

`AGENT_CALENDAR_E2E_LIVE_ENGINE=codex ... node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed through production-mode Electron, an ephemeral PostgreSQL database, the real Gateway,
and a real user-owned Runner process:

- AuthKit-shaped login completed exactly once.
- The first-run guide opened Runner enrollment using the current `Runner 연결` action.
- Owner-confirmed Runner enrollment and live Codex authentication passed.
- Delegated Work was accepted before a real Gateway restart.
- Runner reconnect, lease, live checkpoint, completion, and one Calendar result were observed.
- Desktop restarted without replaying login.
- The terminal result and resolved Codex Engine rehydrated.
- A second Runner poll stayed idle; one completed attempt and one Calendar projection remained.
- Five queued/live/completed/Calendar/rehydrated screenshots had distinct SHA-256 hashes.
- Duration: 31.3 seconds.

The generated bounded document is:

`docs/operations/evidence/2026-07-25-phase10-local-clean-account-codex.json`

It is owner-readable (`0600`) and contains only schema, capture time, bounded candidate binding,
and the seven required boolean checks. User, Workspace, provider credential, host path, raw
checkpoint text, and screenshot paths are absent.

## Binding and release-gate result

The current worktree is not a reviewed release commit and Railway has no staging environment.
The generated document is therefore deliberately bound to:

- deployment: `local-unreleased-snapshot-codex`
- environment: `local-ephemeral-dirty`
- service: `local-gateway`

A synthetic local status with that exact binding passed the schema-v2 preflight. The same evidence
was then supplied to the actual Railway read-only status:

- actual result: `stop_release`
- blockers: staging/service/candidate missing, readiness and ETE binding mismatch, retained
  rollback target unavailable
- Railway mutation: none

This proves the producer and consumer join while preventing local evidence from authorizing a
production deployment.

## Fail-closed contract

Focused tests prove evidence generation rejects:

- Fake Engine;
- expected terminal failure or zero Calendar projections;
- repeated login;
- missing Runner enrollment, engine authentication, Delegated Work, checkpoint, Calendar, or
  reconnect observation;
- invalid or duplicate screenshot hashes;
- short commit SHA, empty identifiers, or invalid capture time.

## Remaining external gates

- Create isolated Railway staging with separate PostgreSQL and secrets.
- Run the same journey against that candidate URL with a live WorkOS test account.
- Bind readiness and ETE evidence to the staging `latestDeployment`.
- Read `canRollback` from Railway Public API deployment details before promotion.
