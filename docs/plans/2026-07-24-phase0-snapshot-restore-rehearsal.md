# Plan: Phase 0 Story 3 — Sanitized Snapshot and Restore Rehearsal

- Date: 2026-07-24
- Owner: Grok
- Work size: Large / Boundary
- Status: Verified
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Roadmap story: Phase 0 committed story 3 — create a sanitized production-like snapshot and perform one restore

## Goal

Prove that the current Phase 0 schema (migrations `0001`–`0007`) and representative global/unowned row shapes can be dumped and restored with matching table set, row counts, and content digests using only an ephemeral local PostgreSQL cluster and synthetic data.

## Non-Goals

- Do not connect to Railway, production, or any remote database.
- Do not read, accept, or derive a production `DATABASE_URL`.
- Do not mutate a real/shared database.
- Do not print environment values, secrets, absolute user paths, or row contents.
- Do not implement Workspace/RLS/ownership columns (Phase 1).
- Do not stage or commit raw dump archives.
- Do not change product gateway behavior except optional pure tooling under tests/tools/lib.

## Touched Boundaries

- Backend gateway: none
- Backend library: `apps/backend/app/lib/phase0-snapshot-restore.js` (pure safety + seed + verify helpers)
- Backend tools: `apps/backend/tools/phase0-snapshot-restore-rehearsal.cjs`
- DB/migrations: read-only use of `apps/backend/app/db/migrate.js` and `apps/backend/app/db/migrations/0001`–`0007`
- Electron bridge: none
- React UI: none
- Tests: `apps/backend/tests/phase0-snapshot-restore-rehearsal.test.cjs`
- Docs: this plan, `docs/operations/phase0-snapshot-restore-rehearsal.md`, optional redacted evidence under `docs/operations/evidence/`

## Safety and Rollback

### Hard safety rules

1. Work directory must be an empty path created by `mktemp` (or equivalent) for this run.
2. Ephemeral cluster binds only to a Unix socket under the work directory and a free localhost port; no remote listen.
3. Connection strings are constructed only from the work directory socket/port and fixed local role/db names (`rehearsal` / `phase0_source` / `phase0_restore`).
4. Reject any CLI flag or env override that supplies an external `DATABASE_URL`.
5. Fail closed if the work directory is nonempty before start (except re-entry after failed run requires a new empty dir).
6. Fail closed if restore target database already has user tables.
7. Reports never include row payloads, secret-shaped strings, or absolute `/Users/...` paths (paths rendered as `$WORK_DIR/...`).
8. `pg_ctl stop` (or process kill fallback) always runs in `finally` for the cluster started by this tool.

### Rollback

- Aborting the tool leaves at most a local work directory; delete it with `rm -rf "$WORK_DIR"`.
- No production schema, data, or Railway state is touched.
- Redacted evidence JSON is the only durable artifact; raw dumps stay inside the disposable work directory.

## Success Criteria

- [x] Plan exists with required sections and explicit safety/rollback.
- [x] Pure tests cover safety rejects, expected table inventory, seed coverage, digest stability, and redaction.
- [x] CLI creates ephemeral source DB, applies real migrations `0001`–`0007`, seeds every current persisted table with FK-safe synthetic rows.
- [x] CLI produces a `pg_dump -Fc` archive and restores it into a separate empty database.
- [x] Verification proves matching table set, row counts, content digests, and ownership state `global_unowned_pre_phase1`.
- [x] Redacted evidence report written under `docs/operations/evidence/` when `--write-evidence` is used.
- [x] `npm run backend:check` and `npm run test:backend` pass.
- [x] No stage/commit; no unrelated file edits.

## Edge Cases

- PostgreSQL client/server binaries missing → skip/fail with explicit prerequisite code, no hang.
- `vector` extension unavailable for the selected server → fail with prerequisite message (pgvector required for migration `0004`).
- Work directory not empty → fail closed before initdb.
- External `DATABASE_URL` provided → fail closed without connecting.
- Restore target already has tables → fail closed.
- Seed must keep FK order: missions → sessions/events/reports; tasks → calendar_events; runs → logs/artifacts; documents → wiki_chunks.

## Test Plan

### RED

- [x] Safety helpers reject external URLs and unsafe work dirs.
- [x] Expected table list equals migration-derived inventory.
- [x] Seed SQL references every expected table.
- [x] Digest helper is deterministic for fixed synthetic rows.
- [x] Report redaction strips absolute user paths.

### GREEN

- [x] Implement pure helpers + CLI orchestration.
- [x] Integration test runs full dump/restore when binaries + vector are available.

### REFACTOR

- [x] Keep production `migrate.js` unchanged; pass an explicit local pool only.

## Acceptance Gates

- [x] Narrow: `node --test apps/backend/tests/phase0-snapshot-restore-rehearsal.test.cjs`
- [x] Manual CLI in new `mktemp` work directory with observed restore success
- [x] `npm run backend:check`
- [x] `npm run test:backend`

건너뛴 gate:

- Gate: Railway/production restore
  - Reason: Story 3 forbids remote databases; ephemeral local cluster only.
- Gate: Desktop typecheck/build/Playwright
  - Reason: DB tooling only.

## Implementation Checklist

- [x] Write this plan.
- [x] Add pure helpers and failing tests.
- [x] Implement CLI with always-finally cluster stop.
- [x] Add runbook + optional redacted evidence write.
- [x] Run verification gates; update verification notes.

## Verification Notes

- Command: `node --test apps/backend/tests/phase0-snapshot-restore-rehearsal.test.cjs`
  - Result: passed; 10/10 (exact table-set compare, migration-derived inventory, no evidence write from tests, stop-before-ok, sequence integrity)
- Command: manual CLI in `mktemp` work dir with `--write-evidence`
  - Result: ok=true; clusterStopped=true; 16 tables; matching digests + `run_logs_id_seq`; ownership `global_unowned_pre_phase1`; `pg_ctl status` → no server running
- Command: `npm run backend:check`
  - Result: passed
- Command: `npm run test:backend`
  - Result: passed; 319/319

## Remaining Risks

- Risk: Host PostgreSQL major version may lack `vector` until a matching pgvector build is present.
  - Mitigation: resolve a server binary that can `CREATE EXTENSION vector`; fail with a clear prerequisite otherwise.
- Risk: Digests can drift if seed uses non-deterministic timestamps.
  - Mitigation: fixed ISO timestamps and ordered aggregation in digest SQL.
- Risk: Operators might point the tool at a real data directory.
  - Mitigation: empty-work-dir requirement, no external DATABASE_URL, local socket-only cluster.
