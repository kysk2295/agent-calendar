# Plan: Phase 0 Boundary Characterization — Calendar, Chat, Wiki, Automation, Agent Work

- Date: 2026-07-24
- Owner: Grok
- Work size: Medium
- Status: Verified — first characterization slice complete
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Roadmap story: Phase 0 committed story 1 — characterization tests for current calendar, chat, Wiki, automation, and Agent Work

## Goal

Freeze the current pre-multi-tenant gateway boundary behavior for Unified Calendar, Calendar AI/chat, Wiki, Connected Automation (scheduler jobs), and Agent Work so later Workspace/RLS migrations cannot silently change public envelopes, identity keys, or domain separation.

## Non-Goals

- Do not implement Workspace, User sessions, RLS, or ownership columns.
- Do not change production behavior unless a minimal testability seam is strictly required.
- Do not inventory Mac mini runtime, create production snapshots, or rotate credentials (Phase 0 stories 2–4).
- Do not rewrite existing large suites (`release-blockers`, `schedule-assistant`, `agent-work-final-safety`).
- Do not add Playwright UI coverage in this slice.
- Do not stage, commit, or touch unrelated dirty-worktree changes.

## Audit Summary (existing coverage)

| Domain | Strong existing coverage | Highest-value gap for multi-tenant freeze |
| --- | --- | --- |
| Calendar | Desktop static contracts; schedule assistant reads events; compact `/api/calendar/events` list key | No backend gateway CRUD characterization for create/list/patch/delete with duration, all-day, recurrence, and event≠task separation |
| Calendar AI / chat | `api-golden`, `schedule-assistant`, ingest, stream interruption | No single freeze of assistant ask envelope keys plus chat history list shape under offline fallback |
| Wiki | `wiki-fallback`, golden wiki search, desktop graph contracts | No compact freeze of public `/api/wiki` envelope keys without workspace identity |
| Automation | release-blocker job mutation privacy; desktop scheduler client encoding | No joint freeze of scheduler job public fields next to calendar/task domain separation |
| Agent Work | large final-safety, live-turn, operations suites | No lightweight freeze of create/conversation public keys asserting global (pre-Workspace) identity model |

## Touched Boundaries

- Backend gateway: exercised only through HTTP characterization (no production edits expected)
- Backend library: none expected
- DB/migrations: none
- Electron bridge: none
- React UI: none
- Tests: `apps/backend/tests/phase0-boundary-characterization.test.cjs` (new)
- Docs: this plan

## Success Criteria

- [x] A Phase 0 child plan exists under `docs/plans/` with required headings.
- [x] One coherent backend characterization suite freezes all five domains' primary public envelopes.
- [x] Calendar event CRUD preserves `kind`/`type` = `calendar-event`, duration/all-day/recurrence fields, and does not leak into `/api/tasks`.
- [x] Public records in the suite contain no `workspaceId` / `userId` ownership fields (documents current global model).
- [x] Calendar AI ask, chat messages list, wiki index, scheduler jobs, and Agent Work create/conversation envelopes keep their current top-level keys.
- [x] No production behavior changes unless a strictly required testability seam is needed.
- [x] Narrow tests and the relevant broader backend gate pass.
- [x] Dirty worktree remains unstaged and uncommitted for unrelated user-owned changes.

## Edge Cases

- Offline runtime: all characterization runs with `DATABASE_URL=''` / runtime offline so fallback store paths are exercised.
- Calendar events must not appear in task list after creation.
- Hostile private fields on automation/task payloads remain stripped if the suite touches those paths.
- Agent Work create requires the existing service path and returns `201` with `work` + `conversation` + `message`.
- Missing event id returns `404` with the current gateway fallback error contract.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다. Characterization slice documents current behavior; production code changes only if a test cannot observe the boundary.

### RED

- [x] Add `apps/backend/tests/phase0-boundary-characterization.test.cjs` with five domain freezes.
- [x] Run the narrow file and confirm failures only if current behavior already diverges from documented contracts (expected: pass without product edits).

### GREEN

- [x] Keep or minimally adjust assertions to match observed current public contracts.
- [x] Do not broaden into Mac mini inventory, backup, or auth redesign.

### REFACTOR

- [x] Keep helpers local to the characterization file.
- [x] Avoid reshaping existing large suites in this slice.

## Acceptance Gates

완료 전에 관련 명령을 실행한다.

- [x] Narrow: `node --test apps/backend/tests/phase0-boundary-characterization.test.cjs`
- [x] Broader backend: `npm run test:backend` (or the workspace equivalent used by this package)
- [x] `npm run backend:check` if product code changes (skip if tests-only)
- [x] Desktop typecheck/build/Playwright: skip — no desktop product or UI workflow change

건너뛴 gate:

- Gate: `npm run typecheck`, `npm run build:desktop`, full `npm test`, Playwright suites
  - Reason: this slice is backend characterization only; desktop and full monorepo suite are out of scope for the first Phase 0 story slice.
- Gate: `npm run backend:check`
  - Reason: tests and plan only; no production code changed.
- Gate: Phase 0 stories 2–4 (runtime inventory, snapshot/restore, decision record)
  - Reason: explicitly deferred; this plan covers only story 1's first coherent slice.

## Implementation Checklist

- [x] Read AGENTS.md, CONTEXT.md, production platform plan, and production roadmap.
- [x] Audit existing backend/desktop tests for the five domains and record gaps.
- [x] Write Phase 0 child plan (this document).
- [x] Add backend characterization suite covering calendar CRUD, Calendar AI/chat, Wiki, automation, Agent Work.
- [x] Run narrow test file.
- [x] Run broader backend gate.
- [x] Record verification notes and remaining Phase 0 gaps; stop without commit/stage.

## Verification Notes

방금 실행한 명령 결과 요약을 기록한다.

- Command: `node --test apps/backend/tests/phase0-boundary-characterization.test.cjs`
  - Result: passed; 5/5 tests green
- Command: `npm run test:backend`
  - Result: passed; 295/295 tests green

## Remaining Risks

- Risk: Existing suites already cover many paths; a thin characterization suite may still miss rare projection branches.
  - Mitigation: Focus on the proven gap (calendar event CRUD + joint envelope freeze) rather than retesting every assistant answer case.
- Risk: Gateway fallback envelopes intentionally include `state` on some mutation responses while list resources stay compact.
  - Mitigation: Assert the current dual shape explicitly instead of inventing a cleaner API.
- Risk: Later multi-tenant work will intentionally add `workspaceId`.
  - Mitigation: Characterization documents absence today; Phase 1 plans replace these assertions deliberately.
- Risk: Dirty worktree contains unrelated user-owned changes.
  - Mitigation: Touch only this plan and the new test file; never stage/commit/revert other files.
