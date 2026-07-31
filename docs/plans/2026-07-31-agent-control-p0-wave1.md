# Plan: Agent Control P0 Wave 1 — engine demotion + lifecycle entry

- Date: 2026-07-31
- Owner: Codex (orchestrated)
- Work size: Large / Boundary (desktop agent-operations + light backend hooks)
- Status: Verified

## Goal

Align the Agent Work Control Space UI with the refined product intent:

1. **Execution engine is secondary** (ADR 0007): demote always-visible engine/model/comparison controls from the primary Work Conversation composer and header.
2. **Delegation opens a real control lifecycle**: after natural-language create, the selected Work Conversation surfaces an explicit **plan / next-action** path (not engine bake-off).
3. **Mode A default language**: Control Home remains “goal only”; agent/engine stay under advanced options; nav/copy prefer 관제/위임 작업 over mission/chat where touched.

## Product decisions locked (from user Q&A)

- Control Home first; goal-only delegation; one timeline + sub-status for parallel (not session wall as primary).
- Capability Orca-class; surface is control/calendar.
- Mode A (direct work) default; Mode B (named role agent) later — this wave only prepares UI hierarchy, does not build full Mode B or memory graph.
- Session screens secondary/detail only.

## Non-Goals

- Full Mode A/B product split and @agent syntax.
- Agent memory constellation graph.
- Wiki auto-archive on completion.
- Automation “approve all changes” overhaul.
- Orca-like multi-terminal primary layout.
- Broad App.tsx refactor or deleting all legacy mission surfaces in one PR.
- Production WorkOS / deploy.

## Touched Boundaries

- Desktop React: `apps/desktop/src/features/agent-operations/**`
- Desktop tests: `apps/desktop/tests/**` (unit mjs + narrow playwright if already covering agent work)
- Backend (only if required for plan entry): `agent-operations-api.js`, `agent-operations-service.js`, `agent-work-*.js` — minimal hooks
- Docs: this plan + checklist updates
- Electron: none unless preload already exposes needed APIs

## Success Criteria

- [ ] Primary Work Conversation composer does **not** show always-on engine/model/comparison toolbar; those live under advanced/disclosure or secondary details.
- [ ] Work Conversation header prioritizes Responsible Agent + status + next action; engine is secondary or only when resolved evidence exists (no fake “실행” as peer accountability).
- [ ] Control Home create path: goal-only primary; advanced keeps agent/engine overrides.
- [ ] After successful create + open conversation, user sees a clear **plan or next-action** checkpoint/CTA path wired to existing plan/approve APIs **or** an honest empty/plan-needed state with working action (not a dead UI).
- [ ] User-facing strings touched in these files avoid “새 미션” where the surface is Control Home / Work Conversation (use 위임 작업 / 관제 언어).
- [ ] Tests: failing test first for engine demotion contract; green after implement.
- [ ] `npm --workspace apps/desktop run typecheck` (or project typecheck) and targeted desktop tests pass for touched area.

## Edge Cases

- Legacy conversations with only engine metadata: show resolved engine as secondary “확인됨/확인 불가”, never invent.
- Comparison mode: keep behind advanced; do not delete backend comparison contracts.
- Running work: composer still available; demotion must not break send.
- Missing plan API: fail closed with visible error, do not fake plan checkpoint.

## Test Plan

- RED:
  - [ ] Desktop unit test(s): primary composer presentation does not include default engine comparison / always-visible engine select (assert on props/render contract or pure presentation helpers).
  - [ ] Optional: workspace/header presentation test for engine secondary.
- GREEN:
  - [ ] Minimal UI + wiring changes to pass tests and manual checklist.
- REFACTOR:
  - [ ] Only while green; no drive-by App.tsx rewrite.

## Acceptance Gates

- [ ] `npm --workspace apps/desktop run typecheck` (or `npm run typecheck` from root)
- [ ] Targeted: `npm --workspace apps/desktop run test` if fast enough; else the new/changed `*.test.mjs` files via `node --test`
- [ ] `npm run backend:check` if any backend file changed
- [ ] Skip full `npm test` / build unless time allows — document skip reason

## Implementation Checklist

- [ ] Step 1: Write/extend desktop tests for engine-secondary composer/header contract (RED).
- [ ] Step 2: Demote engine/model/comparison UI in `AgentWorkComposer.tsx` / conversation header presentation.
- [ ] Step 3: Ensure Control Home advanced-only overrides remain; primary path goal-only.
- [ ] Step 4: Wire or surface plan/next-action after create (use existing `planMission` / approve hooks if present; mount CTA in timeline or header).
- [ ] Step 5: Copy pass on touched agent-operations strings (mission → 위임 작업 where user-visible).
- [ ] Step 6: Run gates; leave verification notes in worker_done.

## Mode A + intervention honesty follow-up

- Work size: Medium (desktop React + desktop tests; no API/schema changes)
- Goal: make goal-only Mode A explicit on Control Home, name the optional Responsible Agent entry as advanced Mode B setup, and keep running-work intervention copy aligned with the existing queued delivery contract.
- Non-goals: role creation wizard, backend interrupt protocol, memory graph, Wiki archive automation.
- Success criteria:
  - [x] Control Home says users can delegate with only a goal.
  - [x] Advanced copy names optional Responsible Agent role selection without implying a full Mode B workflow.
  - [x] Running/streaming work keeps the primary message path available and explains that it does not interrupt the current run.
  - [x] No immediate-interrupt button appears because no end-to-end interrupt/restart API exists.
  - [x] Goal-only create omits `agentId`, preserving backend auto-assignment.
- Edge cases: an explicitly selected directory agent still stays explicit; an in-flight live response queues a second message through the durable message endpoint; delivery receipts remain authoritative.
- RED: focused desktop tests for Mode A copy, empty auto-assignment create input, and running composer queue copy/action availability.
- GREEN: minimal helper extraction, copy, and existing REST queue-path wiring.
- Acceptance gates: focused `node --test`, desktop `typecheck`, desktop test suite, and a scoped Playwright workflow if the local fixture starts cleanly.
- Rollback: revert this follow-up commit; no persisted contracts or backend data change.

### Follow-up checklist

- [x] Add failing Mode A and intervention-honesty tests.
- [x] Implement Control Home and advanced Mode B entry copy.
- [x] Keep message send enabled while streaming and route the second message through the durable queue endpoint.
- [x] Verify focused tests, typecheck, desktop suite, and scoped UI workflow.

## Verification Notes

- 2026-07-31 Mode A/intervention follow-up:
  - RED: focused tests failed on missing Mode A create helper/copy and a disabled streaming send action.
  - `node --test tests/agent-work-create-readiness.test.mjs tests/agent-work-live-stream.test.mjs` — 21/21 passed.
  - `npm run typecheck` — passed.
  - `npm --workspace apps/desktop run test` — 309/309 passed.
  - Control Home Playwright — passed at desktop/tablet/mobile; evidence in `.omo/evidence/task_b73aa42f656f-final-control-home/`.
  - Create-to-plan Playwright — passed; request omitted `agentId`, kept `executionEngine: auto`, and opened the real plan path; evidence in `.omo/evidence/task_b73aa42f656f-final-create/`.
  - Full Work Conversation Playwright — passed, including queued/next-checkpoint delivery receipts.
  - Backend gates skipped because no backend file or contract changed; existing desktop code consumes the already-supported durable message endpoint.

- Orchestration: run `run_eb9cd722631d`, task `task_909383630cbd`, dispatch `ctx_d7edcc3c4eaf` (Codex) → `worker_done` succeeded.
- Worker reported: typecheck pass; 46 focused tests; scoped Playwright create-to-plan pass; full desktop suite 295/295; backend:check skipped (no backend changes).
- Files: AgentWorkComposer/ConversationView/Workspace + css + unit/playwright tests.
- Left uncommitted for coordinator review.

## Remaining Risks

- Plan pipeline may still not create subordinate tasks end-to-end if backend scheduler path is disconnected; wave 1 must at least make the **entry CTA honest and wired**.
- Parallel sub-status board deferred if comparison backend is the only parallel primitive — document follow-up.
- Main is behind origin/main by ~16 commits; branch may need rebase before PR.

## Orchestration

- Coordinator: Grok session
- Worker: Codex on current worktree `kysk2295/agent-control-p0-wave1`
- Read-only analysis docs already in tree:
  - `docs/plans/2026-07-31-product-intent-spec-alignment.md`
  - `docs/plans/2026-07-31-calendar-wiki-ai-pipeline-analysis.md`
  - This plan
