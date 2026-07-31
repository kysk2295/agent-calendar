# Plan: Implement Agent Orchestration Control UI (Wave 2)

- Date: 2026-07-31
- Owner: Codex (orchestrated)
- Work size: Large / Boundary (desktop agent-operations UI)
- Status: Implemented and verified
- Design source: `docs/plans/2026-07-31-agent-orchestration-ui-design.md`
- Prototype ref: `apps/desktop/prototypes/agent-orchestration-control.html` (density only)

## Goal

Ship the designed orchestration control UX into React:

1. **Subordinate worker strip** under Work Conversation header (parallel A/B/C text statuses).
2. **Execution detail** secondary panel/drawer opened from a worker row (session-like transcript reuse if possible).
3. Align remaining layout density with the design: secondary details rail, delivery labels already present stay truthful.
4. Keep engine/comparison advanced (Wave 1); do not re-primary engines.

## Non-Goals

- Full Mode B agent memory constellation graph.
- Wiki auto-archive.
- Real multi-engine cancel/interrupt backend if not already possible — UI must use honest queue labels when interrupt is not available.
- App.tsx shell rewrite, automation, calendar AI.
- Pixel-perfect clone of HTML prototype markup.

## Touched Boundaries

- Desktop: `apps/desktop/src/features/agent-operations/**`
- Desktop tests: `apps/desktop/tests/**`
- CSS: `agent-workspace.css` / `agent-operations.css`
- Backend: only if a minimal read shape already exists for parallel workers; prefer client-side projection from comparison/plan/task data first

## Success Criteria

- [x] `AgentWorkerStrip` (or equivalent) renders between header and timeline when work has parallel/comparison/subordinate execution rows; always at least one truthful row if only single engine.
- [x] Each row: label + **text status** (not color-only) + action to open execution detail.
- [x] Execution detail is secondary (drawer/panel), not replacing Work Conversation.
- [x] Composer primary path remains message-first (Wave 1 advanced engine stays).
- [x] Unit tests for strip presentation + detail open contract (TDD).
- [x] typecheck + focused desktop tests green.

## Edge Cases

- No parallel plan: single worker/agent row or strip hidden only if design says always-one — **prefer always show one row** per design open Q1 recommendation.
- Missing engine evidence: `확인 필요` / unknown, never invent.
- Interrupt unavailable: do not show fake stop; use queue copy if only queue exists.

## Test Plan

- RED: presentation tests for worker strip rows and secondary detail mount.
- GREEN: minimal React + CSS.
- REFACTOR: only while green.

## Acceptance Gates

- [x] Focused `node --test` on new/changed mjs tests
- [x] `npm --workspace apps/desktop run typecheck` or root typecheck
- [x] Full desktop test suite green

## Implementation Checklist

- [x] Step 1: TDD tests for strip + detail
- [x] Step 2: `AgentWorkerStrip.tsx` + types from conversation/comparison/tasks
- [x] Step 3: Mount in `AgentWorkConversationView.tsx`
- [x] Step 4: Execution detail secondary surface (reuse TaskSession or transcript)
- [x] Step 5: CSS tokens from DESIGN.md / existing agent-workspace
- [x] Step 6: Verify gates; worker_done uncommitted unless green

## Remaining Risks

- Parallel data may be incomplete until Phase 1.2 backend lifecycle is solid — strip must degrade honestly.
- The full pre-existing Playwright workflow reached the Wave 2 surface checks but later timed out on an unrelated disabled composer after a live-turn retry. The focused conversation-surface Playwright gate passed at desktop, tablet, and mobile widths.

## Verification Results

- `node --test apps/desktop/tests/agent-worker-strip.test.mjs apps/desktop/tests/agent-work-live-stream.test.mjs apps/desktop/tests/agent-work-design-system.test.mjs` — 29 passed.
- `npm --workspace apps/desktop run test` — 300 passed.
- `npm --workspace apps/desktop run typecheck` — passed.
- `npm --workspace apps/desktop run build:renderer` — passed (existing chunk-size warning only).
- `AGENT_CALENDAR_E2E_CONVERSATION_SURFACE_ONLY=1 EVIDENCE_DIR=.omo/evidence/agent-orchestration-wave2 node apps/desktop/tests/playwright-agent-work-workspace.cjs` — passed; detail drawer screenshot captured.
