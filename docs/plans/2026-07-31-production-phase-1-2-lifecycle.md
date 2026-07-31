# Plan: Production Phase 1.2 — Plan → Approve → Run lifecycle

- Date: 2026-07-31
- Owner: Codex (orchestrated)
- Work size: Large / Boundary
- Status: Complete
- Depends on: Wave1 plan CTA + Wave2 worker strip (branch `kysk2295/agent-control-p0-wave1`)

## Goal

Make delegated work lifecycle **usable without faking success**:

1. Planning works when Hermes/runtime planCompletion is unavailable via a **deterministic fallback plan** (explicitly labeled in checkpoints).
2. Desktop after create can **auto-start plan** (or keep CTA) and always **refresh** agent-operations state after plan/approve/run.
3. Approve-all proposed tasks + activate mission remains the happy path from Work Conversation.
4. Runner offline / runtime issues surface honest Korean errors on plan CTA.

## Non-Goals

- Full Mode A/B product split
- Memory constellation graph
- Wiki auto-archive
- Real multi-provider interrupt
- Public multi-tenant hardening

## Touched Boundaries

- Backend: `agent-operations-planner.js`, `agent-operations-service.js`, tests
- Desktop: `App.tsx` (minimal), `AgentWorkWorkspace.tsx`, maybe conversation view
- Tests: backend agent-operations + desktop unit/playwright narrow

## Success Criteria

- [x] `planMission` succeeds with fallback when `planCompletion` missing/fails runtime_unavailable; plan checkpoint or session event notes fallback.
- [x] Fallback plan: 2–5 tasks, exactly one report task, no external forbidden actions, minutes within policy.
- [x] Desktop plan/approve paths refresh operations snapshot so UI shows proposed/scheduled tasks.
- [x] After successful `createAgentWork` / open conversation, invoke plan once and retain an enabled plan retry CTA with an honest error.
- [x] Tests cover fallback planner + existing plan path regression.
- [x] backend:check + targeted tests green; typecheck if desktop changed.

## Implementation Checklist

- [x] Backend fallback plan builder + service wiring
- [x] Tests RED then GREEN for fallback
- [x] Desktop refresh after plan/approve; auto-plan after create
- [x] Verification notes in plan file

## Verification Notes

- `npm run backend:check` — passed.
- `node --test apps/backend/tests/agent-operations*.cjs` — passed, 111 tests.
- `npm run typecheck` — passed for renderer and Electron TypeScript projects.
- `node --test apps/desktop/tests/agent-work-conversation.test.mjs apps/desktop/tests/agent-work-live-stream.test.mjs` — passed, 35 tests.
- `playwright-agent-work-workspace.cjs` observed one automatic plan POST after create/open and rendered the Work Conversation; its longer unrelated retry scenario later timed out on a disabled composer, so the complete script did not pass.

## Remaining Risks

- Execution still needs Runner online for real runs; plan-only unblocks review UX.
- Fallback quality is deterministic not LLM — copy must say so.
- The broader workspace Playwright script still has a later live-message retry timeout outside this lifecycle change.
