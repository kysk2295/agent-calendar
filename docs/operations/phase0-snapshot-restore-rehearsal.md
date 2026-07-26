# Phase 0 Snapshot / Restore Rehearsal Runbook

- Date: 2026-07-24
- Plan: `docs/plans/2026-07-24-phase0-snapshot-restore-rehearsal.md`
- Scope: ephemeral local PostgreSQL only; synthetic sanitized data; migrations `0001`–`0007`

## Safety

- Never pass a production or Railway `DATABASE_URL`.
- Use a fresh empty work directory from `mktemp` for every run.
- The tool binds PostgreSQL to `localhost` plus a Unix socket under `$WORK_DIR/socket`.
- Reports and evidence never include row contents, secrets, or absolute user home paths.
- The tool stops the cluster it started and only reports `ok: true` after `pg_ctl status` shows no server (or an equivalent verified stop).
- If stop fails, outcome is `ok: false` / nonzero; optional SIGTERM fallback is limited to the postmaster pid from this workDir cluster.
- Raw dump files remain inside the disposable work directory and must not be committed.
- Automated tests never write `docs/operations/evidence/`; use `--write-evidence` only for intentional operator runs.

## Prerequisites

- PostgreSQL server/client binaries including `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_restore`, `pg_isready`
- Matching `vector` extension (pgvector) for the selected major version
- Prefer PostgreSQL 17 on Homebrew when pgvector is installed for that major:

```bash
# Optional: force a binary directory
export PHASE0_PG_BIN=/opt/homebrew/opt/postgresql@17/bin
```

## Run

```bash
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/phase0-snapshot-XXXXXX")"
node apps/backend/tools/phase0-snapshot-restore-rehearsal.cjs \
  --work-dir "$WORK_DIR" \
  --write-evidence
echo "exit=$?"
# Inspect only the redacted JSON on stdout / docs/operations/evidence/
rm -rf "$WORK_DIR"
```

## Expected success shape (redacted)

- `ok: true`
- `clusterStopped: true`
- `ownershipState: "global_unowned_pre_phase1"`
- `restore.matchesSource: true`
- `source.tables` and `restore.tables` equal the CREATE TABLE inventory from migrations `0001`–`0007`
- every expected table has `rowCounts > 0` and matching source/restore digests
- matching `sequences.run_logs_id_seq` so the next bigserial insert cannot collide
- `archive: "$WORK_DIR/phase0-sanitized.dump"`
- optional `evidencePath` only when `--write-evidence` is used by an operator

## Verification commands

```bash
node --test apps/backend/tests/phase0-snapshot-restore-rehearsal.test.cjs
npm run backend:check
npm run test:backend
```

## Ownership note

Current migrations have no `workspace_id` / `user_id` ownership columns. The rehearsal records ownership state as `global_unowned_pre_phase1` so Phase 1 can compare against Workspace-scoped inventories later.
