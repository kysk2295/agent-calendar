# Plan: Phase 3 Durable Execution + Engine Adapters + Golden ETE

- Date: 2026-07-24
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified (root re-audit A–H closed 2026-07-24)

## Goal

A clean Desktop user completes login → account-bound Runner → explicit/auto Engine → first
Delegated Work → persisted live checkpoints/artifact/result → Calendar projection → Desktop and
backend restart → Runner reconnect with **no duplicate terminal result**, while two-Workspace
hostile matrix, fencing/cancel/retry, and all gates stay green.

## Non-Goals

- Phase 4 external calendar sync (Google/Apple)
- Live Mac mini host enrollment as product proof (record honestly if unreachable)
- Using legacy `runner-adapters.js` / `command-runner.js` shell:true paths for production
- Weakening Phase 2 enrollment/security
- Silent Engine or cross-Workspace Runner fallback
- Staging/committing unrelated dirty work

## Touched Boundaries

- Backend gateway: production registry/dispatch composition only
- Backend library: durable-execution coordinator, product create path, device execution routes
- DB/migrations: `0018_durable_execution_engines.sql`
- Runner package: `apps/runner` poll/lease/execute/adapters
- Electron bridge: minimal if proxy already attaches session
- React UI: Engine options + waiting_runner / checkpoint honesty
- Tests: phase3 matrix, adapter unit, golden ETE, evidence
- Docs: this plan, roadmap Phase 3, evidence JSON

## Success Criteria

- [x] Durable jobs/offers/attempts/events/artifacts/outbox on real PG with FORCE RLS
- [x] Accept work + mission/session checkpoint + outbox in one transaction
- [x] Runner leases only same-Workspace work via signed device protocol
- [x] Explicit Engine never silently falls back; auto is deterministic and audited
- [x] Fake Engine through real Runner daemon + signed HTTP for ETE
- [x] Production adapters: shell:false, banned flags rejected, truthful capability
- [x] Desktop: accepted/queued/waiting_runner → live checkpoints → completed → calendar event
- [x] Restart Desktop/backend: conversation/result rehydrate path; no duplicate terminal
- [x] Hostile two-Workspace matrix green
- [x] Phase 2 enrollment surfaces still operational (device auth reused)

## Edge Cases

- No eligible Runner connected: accepted `waiting_runner` (not fake terminal failure)
- Concurrent lease: SKIP LOCKED; one winner
- Offer/lease expiry: reaper requeues; lease_epoch fences stale completion
- Cancel while leased: Runner ack; terminal cancel; stale complete rejected
- Revoked Runner: immediate deny on poll/lease/event/complete
- Dead-letter after max attempts
- Provider secrets never in DB/API/events

## Feature Flags / Rollback

- `DURABLE_EXECUTION_CLAIMS_ENABLED` (default true in production mode tests): when false, stop
  new offers/claims without deleting accepted work
- `LEGACY_RELAY_COMPAT_WORKSPACE_IDS`: optional allowlist; never used for new production Workspaces
- Fallback: disable claims; keep Phase 2 enrollment; work remains queued

## Test Plan

- RED:
  - [ ] `phase3-durable-execution.test.cjs` fails before coordinator/routes exist
- GREEN:
  - [ ] Migration + coordinator + device routes + runner loop + fake engine
- REFACTOR:
  - [ ] Only while green

## Acceptance Gates

- [x] Narrow RED/GREEN Phase3 matrix (3/3)
- [x] `npm run backend:check`
- [x] `npm run test:backend` (**354/354**)
- [x] Runner check/tests (**10/10**)
- [x] Desktop tests / typecheck / build (**174/174**)
- [x] Golden ETE `playwright-phase3-golden-ete.cjs` (UI-only journey re-pass ~28s after QA fix)
- [x] `npm test` / `git diff --check` / evidence (post-QA re-verify)
- [x] Evidence JSON + roadmap update (honest after Manual QA REJECTED false-positive)

## Implementation Checklist

- [x] Plan
- [x] Migration 0018
- [x] DurableExecution coordinator + reaper
- [x] Device execution routes + registry
- [x] Replace createDeferredAgentWork with durable accept
- [x] apps/runner execution loop + Fake Engine (bounded `AGENT_CALENDAR_FAKE_ENGINE_STEP_MS`)
- [x] Engine adapters + banned-flag tests
- [x] Desktop engine options + Agent Ops runner connected from snapshot + live poll/refresh
- [x] Calendar projection date/time + UI hydrate on calendar open
- [x] Golden ETE rewritten UI-only (no acceptWork/issueSession journey-driving) + backendRestart + desktopRestart
- [x] Evidence + roadmap

## Verification Notes

- Root re-audit A–H closed:
  - A: `ON DELETE SET NULL (preferred_runner_id)`; `attempts.offer_id` → offers
  - B: cancel-ack only when `cancellation_requested`; offered cancel withdraws offers + terminals job
  - C: attempt-heartbeat route + execution-loop heartbeat/cancel-ack; long-run fake tests
  - D: spawnSafe ordered awaitable callbacks drained before resolve
  - E: curated Codex/Claude text only; real-schema fixtures; no raw JSONL artifacts
  - F: deterministic expiry/dead_letter/revoke-vs-event/cancel-ack/offered-cancel; leaseOffer expiry commits then 409
  - G: real outbox handler → Workspace SSE; not_configured without handler
  - H: capabilities merge honest limited Grok/Hermes contracts
- Phase1 concurrent 500 root cause: PG `25P02` after unique violation without SAVEPOINT — fixed
- Phase3 **10/10**; runner **17/17**; desktop **177/177**; golden ETE pass; distinct screenshot hashes
- Mac mini external enrollment: **not exercised** (honest)
- Current UI revalidation (2026-07-25): first-run guide → Runner Setup → work/checkpoint →
  Calendar → backend/Desktop restart/reconnect passed in 27.8s. Auth completion remained 1,
  terminal attempt remained 1, and agent-work Calendar projection remained 1.
- Current full gates: Backend 457/457, Desktop 260/260, Runner 23/23.
- Evidence:
  `docs/operations/evidence/2026-07-25-clean-account-runner-ete-revalidation.md`.

## Remaining Risks

- Risk: Real Mac mini unreachable
  - Mitigation: honest external gate; local golden ETE with Fake Engine is product proof for this slice
- Risk: Provider CLI argv drift
  - Mitigation: probe/help fail closed to unsupported
- Risk: Large surface area
  - Mitigation: one coordinator module; no legacy shell adapters
