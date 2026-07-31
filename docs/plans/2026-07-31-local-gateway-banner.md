# Plan: Local gateway fallback banner classification

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Keep a signed-in empty Workspace from presenting an expected local gateway fallback as a Railway production outage, while preserving the existing warning for genuine API failures.

## Non-Goals

- Restore the Mac mini Hermes runtime.
- Change the production Railway deployment or backend response contracts.
- Change authentication, Workspace tenancy, or persisted data.

## Touched Boundaries

- Backend gateway: none.
- Backend library: none.
- DB/migrations: none.
- Electron bridge: none.
- React UI: global API banner classification in `apps/desktop/src/App.tsx` and a pure connectivity helper.
- Tests: focused helper coverage under `apps/desktop/tests/`.
- Docs: this implementation plan.

## Success Criteria

- [x] `gatewayFallback: true` with `runtimeReachable: false` is classified as expected local fallback and does not show the Railway-outage banner.
- [x] A non-fallback API error still shows the existing global Railway warning when no higher-priority connectivity notice is active.
- [x] Desktop tests cover both classifications and desktop typecheck passes.

## Edge Cases

- No API error: never show the global warning.
- Agent screen or offline/reconnecting connectivity: preserve the existing suppression in favor of the dedicated surface.
- Runtime offline without an explicit gateway fallback: do not assume the API error is expected; retain the warning.

## Test Plan

Product code follows a focused red-green loop at the pure banner-classification seam.

- RED:
  - [x] Add a test requiring expected local fallback to suppress the Railway warning and run it to observe the missing helper failure.
- GREEN:
  - [x] Add the smallest pure classifier and use it from `App.tsx`.
- REFACTOR:
  - [x] Keep signal names explicit; make no unrelated banner or hydrate changes.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/global-api-banner.test.mjs`
- [x] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`

Skipped gates:

- Backend gates: no backend code or contract changes.
- Desktop build: typecheck plus focused/full desktop tests cover this pure classification and its import wiring; run the build only if typecheck exposes integration uncertainty.
- Playwright UI: no dedicated local fallback fixture exists; the classifier test directly covers the behavioral gate without needing runtime orchestration.

## Implementation Checklist

- [x] Add the focused failing classification test.
- [x] Implement the pure global banner classifier.
- [x] Wire `App.tsx` to the classifier without changing hydrate behavior.
- [x] Run focused and broad desktop verification.

## Verification Notes

- Command: `node --test apps/desktop/tests/global-api-banner.test.mjs apps/desktop/tests/railway-data-contract.test.mjs`
  - Result: passed, 42 tests.
- Command: `npm run typecheck`
  - Result: passed.
- Command: `npm --workspace apps/desktop run test`
  - Result: new banner tests passed; suite remained red on the unrelated pre-existing Agent Work copy assertion expecting `목표만으로 위임` in `agent-work-create-readiness.test.mjs` while concurrent work had changed that surface.
- Manual UI: signed-in browser fixture with `gatewayFallback: true`, `runtimeReachable: false`, and a failed `/api/usage` request.
  - Result: zero `.api-banner` elements; no `Railway API 확인 필요` copy; screenshot at `/tmp/agent-calendar-local-gateway-banner.png`.

## Remaining Risks

- Risk: future gateways may encode expected local fallback with different fields.
  - Mitigation: suppress only the explicit `gatewayFallback === true && runtimeReachable === false` combination; unknown shapes remain warnings.

## Rollback

Remove the helper import and restore the inline `showGlobalApiBanner` expression; no data or contract rollback is needed.
