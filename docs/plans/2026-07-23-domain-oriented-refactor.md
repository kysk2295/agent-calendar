# Plan: Domain-oriented architecture refactor

- Date: 2026-07-23
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

Preserve the current product behaviour while moving orchestration and domain rules out of the two oversized entry files into domain-owned deep modules. Make the repository navigable by business capability rather than by framework layer.

## Non-Goals

- No URL, response schema, IPC channel, database meaning, or visible workflow changes.
- No database migration or deployment topology change.
- No redesign of Control Home, Work Conversation, calendar, wiki, mail, or widgets.
- No deletion or rewriting of the user's existing Relay run-action and chat auto-scroll changes.

## Work Size

Large / Boundary. The work touches backend routing, React composition, shared contracts, tests, and architecture documentation while deliberately preserving every external seam.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: new domain modules under `apps/backend/app/domains/**`
- DB/migrations: unchanged
- Electron bridge: unchanged
- React UI: `apps/desktop/src/App.tsx`, new domain modules under `apps/desktop/src/domains/**`
- Tests: backend and desktop characterization tests plus existing suites
- Docs: context map and this plan

## Target Domain Map

- Work Management: tasks, calendar events, taxonomy, scheduling summaries
- Agent Work: Delegated Work, Work Conversation, Task Session, execution and reports
- Knowledge: wiki, documents, journal and retrieval
- Communication: calendar chat, mail and Telegram ingress/delivery
- Automation: schedules, recurring jobs and daemon ticks
- Platform: authentication, settings, deployment state, runtime and Relay adapters

## Success Criteria

- [x] Domain map and dependency direction are recorded.
- [x] Work Management rules are removed from `App.tsx` and exposed through one domain interface.
- [x] Backend run request classification is removed from the gateway entry file and exposed through an execution-domain interface.
- [x] Existing external HTTP, SSE, IPC, widget and persistence contracts remain unchanged.
- [x] User-owned uncommitted changes remain present and passing.
- [x] Narrow tests, full backend/desktop tests, typecheck, desktop build, and selected UI scenarios pass.

## Edge Cases

- Local/draft task identifiers must remain non-persistable.
- Calendar metadata embedded in notes must round-trip unchanged.
- Unsupported or malformed run action paths must never be relayed.
- Relay-backed `approve`, `stop`, and `retry` must retain exact status and fallback behaviour.
- Korean quick-entry parsing and Asia/Seoul date semantics must remain unchanged.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Add Work Management domain interface tests before the module exists.
  - [x] Add execution request-policy tests before the backend module exists.
- GREEN:
  - [x] Move the existing rules behind the new interfaces with no behaviour change.
- REFACTOR:
  - [x] Remove duplicate entry-file implementations and keep entry files as composition/orchestration code.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `node apps/desktop/tests/playwright-calendar-crud.cjs`
- [x] `node apps/desktop/tests/playwright-chat-autoscroll.cjs`
- [x] `node apps/desktop/tests/playwright-agent-work-gateway-e2e.cjs`

## Step-by-step Checklist

- [x] Record the domain context map and dependency rule.
- [x] Characterize the Work Management interface and execution request policy.
- [x] Extract Work Management rules from the React entry module.
- [x] Extract execution request classification from the backend gateway.
- [x] Re-run narrow tests and fix only contract-preserving regressions.
- [x] Run repository gates and real UI workflows.

## Verification Notes

- `npm run backend:check`: passed.
- `npm run test:backend`: passed.
- `npm run typecheck`: passed.
- `npm --workspace apps/desktop run test`: 146 passed, 0 failed.
- `npm run build:desktop`: renderer and Electron builds passed.
- `npm test`: backend 290 passed and desktop 146 passed, 0 failed.
- `node apps/desktop/tests/playwright-calendar-crud.cjs`: passed against the real desktop surface.
- `node apps/desktop/tests/playwright-chat-autoscroll.cjs`: passed against the real desktop surface.
- `node apps/desktop/tests/playwright-agent-work-gateway-e2e.cjs`: passed against the real gateway, SSE stream, restart, and persisted state. The test now waits for the actual send button to become available between streamed turns instead of checking the always-enabled textarea.

## Remaining Risks

- The first tranche does not move every screen out of `App.tsx`; subsequent tranches should extract Knowledge and Communication presentation only after their current source-inspection tests are converted to interface tests.
- The gateway still contains broad fallback routing; subsequent tranches should extract one domain router at a time behind the same `handleApi` interface.
