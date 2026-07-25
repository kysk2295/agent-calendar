# Plan: Phase 7 Automation Federation

- Date: 2026-07-25
- Owner: root
- Work size: Large | Boundary
- Status: Complete

## Goal

Replace the Workspace-scoped `scheduler_jobs` projection with source-owned Connected Automations.
An authenticated Workspace owner can connect a capable automation source, shadow-sync existing
Hermes automations, create and edit supported automations, pause/resume/run them, and observe
source-confirmed receipts and Unified Calendar occurrences without Agent Calendar double-running
the source schedule.

## Non-Goals

- Copying source automations into an Agent Calendar scheduler
- Claiming provider capabilities that the connected source did not report
- Storing provider credentials in Agent Calendar
- Irreversible automation deletion in the first federation release
- Provider-native integrations without a supported stable control surface
- Phase 8 Desktop-wide production migration, Web landing, or Mobile

## Work Size

HEAVY. The change adds a DB migration, Workspace/RLS-owned domain records, a source Adapter
boundary, reconciliation and policy semantics, authenticated routes, Unified Calendar projection,
Calendar AI Action Draft support, and a new Desktop connection and management workflow.

## Touched Boundaries

- Backend gateway: authenticated automation source, sync, change, receipt, and occurrence routes
- Backend library: `AutomationFederation`, Hermes shadow Adapter, policy and reconciliation
- DB/migrations: source, projection, change, receipt, occurrence, and cursor tables with FORCE RLS
- Runner: source capability and source-operation transport where supported
- Unified Calendar: deduplicated automation occurrence projection
- Calendar AI: typed AutomationChange draft and source-confirmed approval receipt
- React UI: source connection, create, edit, pause/resume, run, receipts, stale/unknown states
- Tests: backend PostgreSQL hostile matrix, Desktop contracts, two-account Electron ETE
- Docs/evidence: this plan and Phase 7 evidence JSON

## Success Criteria

- [x] A Workspace owner can connect a same-Workspace Runner automation source without sending
      provider credentials to Agent Calendar; source capabilities are probed and persisted.
- [x] Shadow synchronization mirrors existing Hermes definitions and occurrences once, preserves
      source authority, and does not enqueue or execute a duplicate scheduled run.
- [x] Create, update, pause, resume, and run fail closed when unsupported and store a
      source-confirmed receipt when supported.
- [x] A source timeout remains `unknown` until reconciliation; revision conflicts expose the
      source revision without overwriting it.
- [x] New permission, added cost, or new external delivery produces an Approval Gate; low-risk
      changes can apply directly under Workspace policy.
- [x] Connected Automations and occurrences are isolated by FORCE RLS and are unique by
      `(workspace_id, source_id, external_id)` and source occurrence identity.
- [x] Unified Calendar shows automation occurrences with source and freshness without treating
      overlapping human/agent work as a conflict.
- [x] Calendar AI can prepare and approve a typed AutomationChange and receives the same
      source-confirmed receipt as the direct UI.
- [x] The real Desktop surface supports source connection, existing automation sync, create,
      edit, pause/resume, run, receipt visibility, restart restoration, and a clean second
      Workspace with no cross-Workspace records.

## Edge Cases

- Duplicate source list pages or webhook delivery
- Empty source and capability changes after connection
- Malformed schedules and unsupported operations
- Stale source, offline Runner, and command timeout
- Same external automation ID in two Workspaces
- Concurrent update against an old source revision
- Replayed create/run idempotency key
- Source reports a run after the local request timed out
- Calendar occurrence already projected from a prior reconciliation
- Prompt injection embedded in an automation goal

## Test Plan

Products tests are written and observed RED before product code.

- RED:
  - [x] `node --test apps/backend/tests/phase7-automation-federation.test.cjs`
        fails on missing migration/service/routes and proves RLS, deduplication, capability,
        timeout, policy, receipt, Calendar projection, and Calendar AI boundaries.
  - [x] Desktop unit tests fail on missing Connected Automation/source/receipt presentation.
  - [x] `node apps/desktop/tests/playwright-phase7-automation-federation.cjs`
        fails before the source-connection and creation controls exist.
- GREEN:
  - [x] Implement the smallest source-authoritative service and route contract.
  - [x] Implement the Desktop workflow against only the new federation contract.
- REFACTOR:
  - [x] Retire the legacy Desktop scheduler mutation path only after shadow parity is green.

## Manual QA Scenarios

1. Backend hostile scenario:
   `node --test apps/backend/tests/phase7-automation-federation.test.cjs`
   with a real temporary PostgreSQL cluster. PASS means every test exits 0 and the evidence JSON
   records isolated Workspace counts, one source definition, one occurrence, and no duplicate
   execution.
2. Desktop clean-account scenario:
   `node apps/desktop/tests/playwright-phase7-automation-federation.cjs`.
   Account A logs in, connects a Hermes test source through its enrolled Runner, synchronizes an
   existing definition, creates and edits one automation, pauses/resumes/runs it, then restarts.
   Account B logs in and sees zero sources/automations. PASS means visible receipt/source/freshness
   text is present, A restores after restart, B remains empty, and screenshots are captured.
3. Calendar scenario inside the same Electron ETE:
   open Calendar after source reconciliation. PASS means exactly one expected occurrence with an
   automation source badge is visible and no duplicate occurrence is rendered.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Phase 7 Electron ETE
- [x] Manual screenshot QA
- [x] No orphan server, Runner, Electron, browser, or PostgreSQL process

## Implementation Checklist

- [x] Migration and RLS
- [x] Adapter contract and Hermes shadow implementation
- [x] Reconciliation, deduplication, freshness, and failure truth
- [x] Change policy, approval, idempotency, and receipts
- [x] Authenticated federation routes
- [x] Unified Calendar occurrence projection
- [x] Calendar AI AutomationChange
- [x] Desktop source and automation workflow
- [x] Hostile tests, ETE, full gates, evidence, and cleanup

## Rollback and Fallback

- `AUTOMATION_FEDERATION_ENABLED=0` returns the Desktop to the legacy read-only projection.
- `AUTOMATION_WRITES_ENABLED=0` preserves sync/read/calendar projection and disables changes.
- A source can be marked disconnected without deleting its last projection.
- The source scheduler remains authoritative and continues running throughout rollback.

## Verification Notes

- Backend Phase 7 hostile test: 4/4 passed.
- Desktop Connected Automation contracts: 3/3 passed.
- Two-account Electron ETE passed with five full-window screenshots and verified DB counts:
  Workspace A `1 source / 2 automations / 2 occurrences`, Workspace B `0 / 0 / 0`.
- Manual screenshot QA confirmed the Orca-inspired three-part information hierarchy remains inside
  the existing Agent Calendar warm token system with visible source, schedule, receipt, empty, and
  restart states.
- Desktop policy regression confirms `pending_approval` remains behind the visible
  `승인하고 적용` user decision instead of being approved automatically.
- Full repository gate passed: backend 410 tests, Desktop 186 tests, Runner 19 tests, Desktop
  typecheck, backend syntax, and production Desktop build.
- Final `git diff --check` and cleanup checks passed with no legacy scheduler mutation reference,
  orphan Phase 7 process, or temporary Phase 7 data directory.
- Evidence: `docs/operations/evidence/2026-07-25-phase7-automation-federation.json`.

## Remaining Risks

- Live Hermes/Codex/Claude/Grok automation command syntax depends on the installed Runner adapters;
  only capability-probed operations may be shown.
- A live external source may need environment-specific release checks even after the fake Adapter,
  Hermes shadow parity, Runner transport, and Desktop ETE pass.
