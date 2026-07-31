# Plan: Bounded child handoff, provider-session transitions, and comparison adoption

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

Keep one immutable root Responsible Agent while allowing that Work Conversation to
create bounded child-agent executions with persisted lineage, strictly intersected
grants and budgets, durable cancellation, and child-only result projection.

Make provider-session continuation an explicit choice (`rebind`, `new_session`, or
`fork`) with immutable lineage and exactly-once execution, and let a user adopt one
comparison outcome by changing only the Work Conversation's selected current-result
pointer while preserving every outcome and prior selection record.

## Non-Goals

- Do not change Agent Directory policy, team-label ACLs, or Agent Directory UI.
- Do not contact a live provider, staging, or production data.
- Do not add silent provider/Runner fallback or infer a session transition from an
  execution-engine selector.
- Do not rewrite ADR 0005 revision/follow-up semantics: same-goal revisions remain
  in one Work Conversation and materially new goals still require explicit new work.
- Do not run the shared/full `npm test` suite.

## Touched Boundaries

- Backend gateway: focused scoped routes for handoff, handoff cancellation,
  provider-session transition, and comparison-result adoption.
- Backend library: `workspace-scoped-product-service.js` and the child terminal projection seam in
  `durable-execution.js`.
- DB/migrations: a new migration for handoff graph rows, provider-session lineage
  and transition receipts, and current-result pointer/adoption history.
- Electron bridge: none.
- React UI: Work Conversation-only controls and projections; no Agent Directory
  panel changes.
- Tests: focused real-PostgreSQL Backend tests, focused Desktop contract tests, and
  `playwright-child-handoff-session-fork.cjs`.
- Docs: this plan and task-owned evidence only.

## Success Criteria

- [x] Creating a valid child handoff preserves the root mission's `agent_id`,
      persists parent work/task, delegator, receiver, lineage, depth, fan-out,
      effective grants/budget, cancellation, and result projection across a real
      process/service restart.
- [x] Foreign Workspace IDs, malformed lineage input, cycles, depth overflow, and
      fan-out overflow fail closed before an `execution_jobs` row is created.
      Requested grant or budget expansion is server-narrowed to the effective
      parent/receiver intersection and inherited bounded minimum before the one
      valid child job is created.
- [x] A failed/cancelled child updates only its handoff/result projection and cannot
      complete or fail the root mission.
- [x] Missing, stale, blocked, or foreign provider-session IDs fail closed. Explicit
      `rebind`, `new_session`, and `fork` each create exactly one intended execution;
      retries are idempotent and lineage is immutable.
- [x] A comparison exposes all outcomes with duration/cost/evidence summary.
      Adoption changes exactly one selected current-result pointer and appends an
      immutable adoption record without mutating reports, jobs, root agent, or Work
      Conversation history.
- [x] The real dark-theme Desktop flow uses `page.click` and `page.fill` to inspect
      lineage/intersections, see quota/cycle/session failures, cancel/reload,
      rebind/fork, compare, and adopt; DOM and PostgreSQL observables agree.

## Edge Cases

- Malformed/foreign IDs and caller-supplied lineage/root-agent/limit fields are
  rejected as untrusted; no job/audit row appears. Requested grants and budget
  remain untrusted input and are narrowed to server-owned effective bounds.
- Prompt-injection text is persisted only as inert goal text and cannot change
  depth, fan-out, cycle, grant, or budget enforcement.
- Cancel/retry/restart around a pending or terminal child remains idempotent.
- Provider session is missing, archived, auth-required, stale relative to the
  expected active pointer, or belongs to another Workspace.
- Repeated/concurrent identical transition and adoption requests (at least three)
  yield one execution/selection; competing stale selections fail with conflict.
- A child/provider execution hangs or is interrupted around terminal commit; the
  bounded transaction leaves either the old state or one committed new state.

## Test Plan

Product code follows tests.

- RED:
  - [x] Add PIN characterization for root Responsible Agent, comparison fan-out,
        provider-session selection, and ADR 0005 revision/follow-up semantics.
  - [x] Add real-PostgreSQL child graph tests for restart persistence, cycle/depth/
        fan-out/foreign rejection with zero jobs, strict grant/budget intersection,
        child failure isolation, and cancel/restart stability.
  - [x] Add real-PostgreSQL provider-session tests for missing/stale/foreign
        fail-closed behavior and exactly-one rebind/new-session/fork execution.
  - [x] Add real-PostgreSQL comparison adoption tests for pointer-only mutation,
        restart persistence, stale selection, and concurrent selection.
  - [x] Add Desktop focused contract tests before rendering controls.
- GREEN:
  - [x] Add the smallest migration, scoped service methods, routes, types, API
        bindings, and Work Conversation UI required to satisfy the RED tests.
  - [x] Add child terminal projection in durable execution without root mission
        terminal propagation.
- REFACTOR:
  - [x] Only extract validation/projection helpers when they eliminate duplication
        introduced by the GREEN implementation; keep focused tests green.

## Acceptance Gates

- [x] Focused Backend graph/session/comparison tests.
- [x] Migration application and schema/count assertions on ephemeral PostgreSQL.
- [x] `npm run backend:check`
- [x] Focused Desktop tests.
- [x] `npm run typecheck`
- [x] Exact real surface:
      `EVIDENCE_DIR=.omo/evidence/production-readiness-completion/task-12/playwright AGENT_CALENDAR_E2E_THEME=dark node apps/desktop/tests/playwright-child-handoff-session-fork.cjs`
- [x] Fresh screenshot inspection and independent UI/HEAVY review.
- [x] Cleanup receipt proves no task-owned PostgreSQL, Vite, browser, Electron,
      Runner, PID, port, pool, temp, or userData survivor.

Skipped gates:

- Gate: `npm test`
  - Reason: the task explicitly forbids the shared/full suite.
- Gate: external provider/staging execution
  - Reason: the task explicitly forbids credentials, external providers, staging,
    and production/user-data mutation; deterministic local Runner/provider fixtures
    are the faithful safe channel.

## Implementation Checklist

- [x] PIN immutable current contracts and record hashes.
- [x] Add migration and real-PostgreSQL RED tests for child graph.
- [x] Implement child graph create/list/cancel and child terminal projection.
- [x] Add RED tests and implement explicit session transition receipts/lineage.
- [x] Add RED tests and implement comparison outcome/adoption pointer transaction.
- [x] Project graph/session/comparison state in Work Conversation response.
- [x] Add Desktop API/types and focused RED/GREEN surface tests.
- [x] Add and run deterministic Playwright workflow.
- [x] Run restart, malformed/foreign, prompt-injection, interruption, and three-way
      race selections; record exact counts/statuses/hashes.
- [x] Run gates, visual/HEAVY review, hashes, cleanup, and DoneClaim.

## Verification Notes

- Command: `node --test apps/backend/tests/child-handoff-session-fork.test.cjs`
  - Result: 7/7 pass against ephemeral PostgreSQL.
- Command: focused Desktop tests.
  - Result: 34/34 pass across Todo12, Work Conversation, and provider-session
    surface contracts.
- Command: `npm run backend:check`
  - Result: pass.
- Command: `npm run build:desktop`
  - Result: pass, including typecheck, renderer build, and Electron build.
- Command: exact dark-theme Playwright command from Acceptance Gates.
  - Result: pass with 10 screenshots, one real fixture-process restart, matching
    DOM/backend state, two transitions, and one pointer-only adoption.

## Remaining Risks

- Risk: this shared worktree already contains Todo10/Keychain/Todo11 changes in
  service, route, Desktop, and test files.
  - Mitigation: preserve current on-disk content, limit edits to task-owned seams,
    inspect targeted diffs before each edit, and never revert unrelated hunks.
- Risk: provider-session lineage changes an existing uniqueness boundary.
  - Mitigation: migrate existing rows to generation zero, replace only the
    conversation/engine/Runner uniqueness index with a generation-aware index, and
    verify imports and comparisons still pass focused tests.
- Risk: durable terminal projection currently updates the root mission.
  - Mitigation: branch only for jobs carrying a valid persisted `handoffId`; update
    the handoff row and leave root mission/session untouched.
- Residual risk: the Playwright lifecycle uses a deterministic persisted local
  backend fixture rather than credentials or a live provider. Real PostgreSQL
  storage and concurrency are verified separately by the focused Backend test.
