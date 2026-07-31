# Plan: Production Phase 1.4 — Wiki auto-archive on completion

- Date: 2026-07-31
- Owner: Grok (orchestrated continuation)
- Work size: Large / Boundary
- Status: Verified
- Depends on: Phase 1.2 lifecycle, Phase 1.3 terminalization, Mode A queue interventions
- Branch: `kysk2295/agent-control-p0-wave1`

## Goal

When Delegated Work reaches a terminal **completed** state with a ready current result, automatically archive an honest markdown note into the Workspace LLM-Wiki (when configured) and surface the archive outcome on the Work Conversation timeline. Also propose short **user-managed agent memory pin candidates** from the result — never auto-write memories without user confirmation.

## Non-Goals

- Auto-promote long-term agent memory without user action
- Merge agent memory with Calendar AI Personal Memory or provider-native sessions
- Full agent memory constellation graph UI
- Real mid-run interrupt API
- Public multi-tenant / multi-wiki tenancy
- Mode B role wizard
- Forcing archive when `HERMES_WIKI_ROOT` is missing (honest skip instead)

## Touched Boundaries

- Backend library:
  - new `apps/backend/app/lib/agent-work-wiki-archive.js`
  - `apps/backend/app/lib/wiki.js` (export helpers if needed)
  - `apps/backend/app/lib/agent-operations-scheduler-support.js` (`terminalizeAgentMission`)
  - `apps/backend/app/lib/agent-task-executor.js` / scheduler (pass `wikiRoot`)
  - `apps/backend/app/lib/public-agent-records.js` (public wikiArchive + metadata keys)
  - `apps/backend/app/lib/agent-operations-scheduler.js` (optional wikiRoot)
  - gateway composition wiring for `wikiRoot`
- Desktop:
  - types / conversation presentation / timeline or details for archive + memory candidates
  - optional confirm-pin API reuse of agent update memories
- Tests: backend agent-operations + wiki archive unit; desktop presentation unit if UI changes
- Docs: this plan

## Success Criteria

- [x] Pure archive builder produces markdown with goal, status, report title/findings, task list, agent id, no secrets/absolute paths.
- [x] When wiki root is available, completed terminalization writes under `5_conversation/agent-runs/` and sets mission `wikiArchive.status = 'written'`.
- [x] When wiki root is missing/unwritable, mission `wikiArchive.status = 'skipped_no_wiki'` (or `failed`) with honest Korean conversation text — no fake success.
- [x] Idempotent: second terminalize does not rewrite if already archived for same report id.
- [x] Completion timeline event metadata includes archive status + relative path (public-safe).
- [x] `proposedMemoryPins` (0–3 short strings) stored on mission; not applied to agent.memories automatically.
- [x] Public mission projection exposes wikiArchive (status, relativePath, archivedAt) without absolute paths.
- [x] Targeted backend tests green; `backend:check`; typecheck if desktop changed.

## Edge Cases

- Mission cancelled / failed: do not auto-write success archive (optional failure note deferred).
- No ready report: terminalize already refuses complete without report.
- Wiki root exists but write throws: status `failed`, error code only, conversation event honest.
- Report findings empty: archive still includes objective + task titles.
- Dangerous path / secret-like report text: reuse existing sanitizers before write.

## Test Plan

- RED:
  - [x] Unit: build/write archive markdown + memory pin proposals
  - [x] Integration: terminalize completed mission archives when wikiRoot set
  - [x] Integration: missing wikiRoot → skipped_no_wiki, no throw
  - [x] Idempotency for same report
- GREEN: minimal implementation
- REFACTOR: keep archive logic out of executor if possible

## Acceptance Gates

- [x] `node --test` targeted wiki-archive + agent-operations tests
- [x] `npm run backend:check`
- [x] `npm run typecheck` if desktop changed
- [x] desktop unit for presentation if added

## Implementation Checklist

- [x] Plan file
- [x] Archive module + tests RED
- [x] Wire terminalize + wikiRoot from scheduler/gateway
- [x] Public fields + conversation metadata
- [x] Desktop surface
- [x] Verify + commit

## Verification Notes

- `node --test apps/backend/tests/agent-work-wiki-archive.test.cjs` — 8/8 pass
- `node --test apps/backend/tests/agent-operations.test.cjs` — 112/112 pass
- `npm run backend:check` — pass
- `node --test apps/desktop/tests/agent-work-wiki-archive-presentation.test.mjs apps/desktop/tests/agent-work-conversation.test.mjs` — 23/23 pass
- `npm run typecheck` — pass

## Remaining Risks

- Railway-hosted gateway may not mount personal LLM-Wiki; skip is correct until Runner write-back exists.
- Archive quality depends on report content quality.
- Memory pins are heuristic; user confirms via pin buttons (or agent profile editor).
