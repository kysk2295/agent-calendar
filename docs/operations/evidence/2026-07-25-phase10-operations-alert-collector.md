# Phase 10 operations alert collector evidence

- Date: 2026-07-25
- Scope: external single-run readiness/SLO alert evaluator
- External mutation: none

## Outcome

`apps/backend/tools/phase10-operations-alert-collector.cjs` is a deployable one-window collector
for a separate scheduler or monitoring service. It reads exactly:

- public `/api/ready`;
- protected `/api/operations/status` with the independent operations bearer.

The collector accepts only an HTTPS root origin in operator mode, follows no redirects, limits
each JSON response to 64KiB including chunked responses, and projects only bounded aggregate
fields. Origin, token, raw response, route inventory, User, Workspace, and Runner identifiers are
not stored or emitted.

## Alert contract

The evaluator preserves versioned streak and active-alert state in an atomic 0600 file and
implements the production runbook rules:

- deployment readiness: 2 consecutive windows, P1;
- availability SLO breach: 2 consecutive windows, P1;
- server error delta ratio above 1%: 5 consecutive windows, P1;
- p95 above the reported target: 10 consecutive windows, P2;
- operations collector auth failure: immediate P1;
- new capacity rejections: 2 consecutive windows, P1;
- rate-limit rejections above the configured per-window baseline: 2 consecutive windows, P2;
- network failure: 2 consecutive windows, P1.

The output contains current aggregate metrics, counter deltas, active alerts, and sorted
`raised`/`resolved` transitions. Active P1 produces exit 2, no active P1 produces exit 0, and
collector/configuration/state contract failures produce exit 1.

Gateway counter decreases are treated as a process-reset baseline. They cannot create negative
deltas or false 5xx/admission alerts. Unavailable metrics do not falsely resolve an active alert.

## State safety

- missing state creates the first baseline;
- corrupt, oversized, non-owner-only, or symlink state fails closed;
- state is written through a 0600 temporary file, fsync, and atomic rename;
- persisted fields are limited to timestamps, cumulative counters, rule streaks, and alert IDs.

## Actual local Gateway observation

The focused suite drove the real production dispatcher over an actual loopback HTTP listener:

- a fully ready runtime returned ready/operations success, no active alert, and exit 0;
- a runtime with truthful AuthKit unready state was collected twice;
- the second window raised exactly `deployment_readiness` P1 and returned exit 2;
- no credential or tenant value appeared in the result.

The production CLI was also invoked without an injected operations token. It exited 1 with the
bounded message `operations collector token is invalid`, made no authenticated request, and
created no state file.

## Verification

- Focused collector + production observability tests: 14/14 passed.
- Backend syntax check: passed, including collector library and CLI.
- Full repository test suite: exited 0; Desktop 262/262 and Runner 29/29 passed.
  Repeated Desktop HMR WebSocket port warnings were non-fatal.
- `git diff --check`: passed for tracked changes and the new collector files.

## Remaining deployment gates

- inject the independent operations bearer into a separate persistent scheduler;
- retain collector JSON in an external metric/log backend;
- configure dashboards and an operator-approved on-call destination;
- observe one live production raised and resolved alert without customer data.
