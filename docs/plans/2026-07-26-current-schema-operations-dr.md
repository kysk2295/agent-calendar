# Plan: Current-schema operations and disaster-recovery repository proof

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified (repository-local scope only)

## Goal

Add a fail-closed, repository-local proof that binds the exact current migration
inventory to one source SHA and bounded observation window; validates Web,
download, Runner heartbeat, and Runner update-failure probe streams; records a
durable non-production synthetic P1 raised/delivered/acknowledged/resolved
lifecycle; and composes existing local PostgreSQL DR and Gateway/Runner rollback
rehearsals without contacting external systems.

## Non-Goals

- Do not claim or configure production monitoring, on-call routing, Railway
  backups, managed PITR, public Web probes, or real Runner delivery.
- Do not add a production fault route or modify Web, Runner, Desktop, migrations,
  the parent plan, Boulder, or the completion ledger.
- Do not contact Railway, WorkOS, alert providers, public hosts, or real
  databases.
- Do not mark Todo 17 complete. External one-minute collection/on-call delivery,
  24-hour continuity, staging P1 injection, managed snapshot/PITR restore,
  externally measured RPO/RTO, and approved temporary restore cleanup remain
  mandatory.

## Touched Boundaries

- Backend library: a narrow repository evidence evaluator for current-schema,
  probe, alert-receipt, restored-domain, and rollback-readiness contracts.
- Backend tools: one loopback/socket-only local QA composition script.
- DB/migrations: read and apply all repository migrations dynamically; no schema
  changes.
- Tests: focused characterization, fail-closed evaluator, HTTP/local-owner-sink,
  and cleanup tests.
- Docs: operations contracts and this plan.

## Success Criteria

- [x] The expected migration inventory is discovered from disk, includes the
  actual latest migration, and stale/missing/mismatched migration evidence fails.
- [x] Evidence is bound to the exact 40-hex source SHA and a bounded timestamp
  window; stale SHA/time/probe streams fail closed.
- [x] Web availability, download, Runner heartbeat, and Runner update-failure
  probes each have bounded, schema-valid receipts.
- [x] A synthetic P1 has durable, ordered raised, loopback-owner-delivered,
  acknowledged, and resolved receipts; logs alone are insufficient.
- [x] Restored-domain receipts prove two Workspace fingerprints remain isolated
  and Calendar, Delegated Work, Automation, and Runner sentinels survived.
- [x] Gateway and Runner rollback receipts prove readiness was restored.
- [x] Body and cleanup failures aggregate; cleanup verifies exact PIDs, closed
  ports, and removed task-owned temporary roots.
- [x] The exact requested manual-QA command exits 0 and records repository-local,
  redacted artifacts.

## Edge Cases

- Migration evidence ending at `0024`, omitting the actual latest file, adding an
  unknown file, or changing a migration digest.
- Missing, duplicated, out-of-order, stale, oversized, or hostile-text probe and
  alert receipts.
- A delivery claimed only by evaluator output with no process-owned owner-sink
  receipt.
- Restore evidence with a shared/cross-Workspace fingerprint, missing critical
  domain sentinel, or raw identity fields.
- Gateway or Runner rollback that does not restore the known-good ready/version
  state.
- Interrupted backup/restore/collector phases and simultaneous scenario/cleanup
  failures.

## Test Plan

Product code follows focused characterization and RED evidence.

- PIN:
  - [x] Capture the current evaluator/collector behavior and exact migration
    fixture/input/assertion before production edits.
- RED:
  - [x] Stale migration and missing latest migration are rejected.
  - [x] Missing Web/download/Runner heartbeat/update probe is rejected.
  - [x] Missing delivery, acknowledgement, or resolution receipt is rejected.
  - [x] Workspace isolation/domain/rollback loss is rejected.
  - [x] Body and cleanup failures are aggregated.
- GREEN:
  - [x] Implement the smallest repository evidence producer/evaluator and local
    QA composition that makes all focused cases pass.
- REFACTOR:
  - [x] Keep documents bounded and redacted; avoid product-route changes.

## Acceptance Gates

- [x] Focused current-schema operations/DR tests.
- [x] Existing Phase 10 operations alert collector tests.
- [x] Existing Phase 10 production observability tests.
- [x] Existing Phase 10 disaster-recovery tests.
- [x] Existing Phase 10 release-rollback tests.
- [x] `npm run backend:check`
- [x] Smallest broader Backend test gate justified by changed boundaries.
- [x] Exact manual-QA command and three repeats of timing-sensitive gates.

Skipped gates:

- Desktop/typecheck/build/full shared suite: out of owned boundaries; only run if
  the Backend gate exposes a direct dependency.
- External production/staging checks: forbidden and incomplete by design.

## Implementation Checklist

- [x] Record baseline hashes, current dirty-worktree scope, PIN, and RED logs.
- [x] Add the fail-closed current-schema/probe/P1/restore/rollback evaluator.
- [x] Add the local loopback QA producer and durable owner-sink receipts.
- [x] Compose the real current-migration PostgreSQL DR and rollback rehearsals.
- [x] Add all nine adversarial classes and cleanup/resource receipts.
- [x] Run narrow, Phase 10, syntax, broader Backend, and exact manual QA gates.
- [x] Record DoneClaim and explicitly preserve the external Todo 17 gaps.

## Verification Notes

- `node --test` over the new gate plus Phase 10 alert, observability, DR, and
  rollback suites: 48 passed, 0 failed.
- Exact local QA: 3 consecutive passes. Each applied 34 migrations through
  `0034_child_handoff_session_fork.sql`, inventoried 83 tables, recorded four
  probes and four alert receipts, restored two exact postmaster PIDs, then proved
  those PIDs gone, both ports refused, servers stopped, and the temp root removed.
- `npm run backend:check`: exit 0.
- Owned-file explicit `node --check`: exit 0.

## Rollback / Fallback

The new evaluator and QA tool are additive. Rollback consists of removing only
their new files and documentation additions. Existing production routes,
migrations, release tools, and external state are unchanged. If PostgreSQL or
pgvector prerequisites are absent, the gate fails with a prerequisite receipt; it
must not infer success.

## Remaining Risks

- Local logical/WAL restore cannot establish managed Railway backup retention,
  restore authorization, regional recovery, or production RPO/RTO.
- A loopback owner sink proves only receipt semantics, not real on-call delivery.
- Repository probe fixtures prove contracts, not 24-hour public availability.
