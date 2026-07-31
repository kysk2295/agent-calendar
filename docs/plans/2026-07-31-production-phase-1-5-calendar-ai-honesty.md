# Plan: Production Phase 1.5 — Calendar AI coverage honesty

- Date: 2026-07-31
- Work size: Medium
- Status: Verified
- Branch: `kysk2295/agent-control-p0-wave1`

## Goal

When schedule answers append grounded completion titles after the LLM (`ensureCompletionAnswerCoverage`), expose that post-process honestly via `coverageAugmented` and `answerMode: 'llm-augmented'` (or keep fallback modes unchanged). Surface a small honesty label in Calendar AI chat when present.

## Non-Goals

- Full FAB re-route of every message to `/api/assistant/ask` (Phase 6 conversation/memory path remains)
- Wiki session-turn grounding rewrite
- Embedding cache durability

## Success Criteria

- [x] Coverage helper returns structured `{ answer, coverageAugmented }`
- [x] Call sites set `coverageAugmented` and use `llm-augmented` when base mode was `llm`/`llm-retry`
- [x] Golden allowlist includes `llm-augmented`
- [x] ChatDrawer shows honesty chip when mode/answerMode indicates augmentation
- [x] Targeted tests green

## Acceptance Gates

- [x] `node --test apps/backend/tests/schedule-assistant.test.cjs` — 35 pass
- [x] `npm run typecheck` — pass

## Remaining Risks

- FAB still uses calendar chat stream product path (Phase 6 memory/actions); pure `/api/assistant/ask` remains the golden contract path.
- Wiki session-turn grounding is still deferred.
