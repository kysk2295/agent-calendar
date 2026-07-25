# Phase 10 route lifecycle and legacy-removal evidence

- Date: 2026-07-25
- Scope: production HTTP inventory, supported clients, compatibility windows, removal safety
- Result: classification gate verified; Mobile entry remains correctly blocked

## Outcome

All 156 production routes now have exactly one lifecycle owner:

| Lifecycle | Count |
| --- | ---: |
| stable-v1 | 55 |
| stable-desktop | 47 |
| stable-runner-protocol | 15 |
| stable-control-plane | 4 |
| stable-infrastructure | 3 |
| stable-provider-ingress | 2 |
| stable-main-process | 2 |
| compatibility | 14 |
| removal-candidate | 12 |
| security-tombstone | 2 |

There are no unclassified routes and no stale policy entries.

## Removal Safety

Repository source inspection is not accepted as proof that a route is safe to delete. The new
removal assertion requires:

1. the route is explicitly classified as `compatibility`, `removal-candidate`, or `test-only`;
2. its explicit removal date has elapsed;
3. production evidence shows at least 28 consecutive zero-traffic days.

Stable client/protocol routes and security tombstones can never pass this assertion. No route was
deleted in this slice because real production zero-traffic evidence does not yet exist.

## Compatibility Windows

- Phase 1 trusted session test path: target removal after 2026-09-30.
- Phase 1 product aliases: target removal after 2026-10-31.
- Legacy Mac mini Relay compatibility paths: target removal after 2026-12-31.
- Every compatibility entry names its supported replacement.

These dates are earliest policy targets, not deletion authorization.

## Current Mobile-Entry Blockers

Desktop no longer calls any route that production intentionally disables:

```text
supportedClientDisabledRoutes=[]
```

The retired Gmail app-password, sync, star, and archive controls were removed. Mail remains
Workspace-scoped and read-only through `GET /api/mail/messages`; “작업으로 추가” now uses
`POST /api/tasks`, and Mail delegation continues through Agent Work.

Additional route-lifecycle blockers:

- 14 compatibility routes remain;
- 12 removal candidates await their date plus observed zero traffic. The three disabled Mail
  mutations are now included in this group and cannot be deleted without production evidence.
  Dormant Calendar draft,
  global Agent Operations tick, and direct Workboard conversion Desktop methods are among
  them, replaced by review-only ingest, per-task `run-now`, and Agent Work respectively;
- the fake Google connector no longer exists in the production registry or dispatcher. Phase 4
  tests compose it directly with a server-issued Workspace scope.

## TDD Evidence

Expected RED:

- the Phase 4 route contract failed while fake-connect remained registered in production;
- the lifecycle contract failed while `testOnlyRoutes` still contained fake-connect;
- the Desktop Mail contract failed while obsolete mutation methods were still exposed;
- the lifecycle contract failed while all three Mail mutations were still Desktop consumers;
- the Desktop contract failed while `draftCalendarWork` still exposed the duplicate route;
- the lifecycle contract failed while the route remained `supported-client-disabled`.
- the next Desktop contract failed while `tickAgentOperations` still exposed a
  client-controlled global scheduler trigger.
- the Workboard contract failed while direct conversion could still bypass the
  current Agent Work review flow.

GREEN:

- production fake-connect requests now return `production_route_unregistered`;
- `testOnlyRoutes=[]`;
- Phase 4 Backend isolation/root audits: 33 passed;
- Phase 4 Desktop ETE passed with six distinct screenshots, restart, and cross-Workspace checks;
- Desktop Mail API and Communication contracts: 7 passed;
- focused lifecycle contracts: 9 passed;
- `supportedClientDisabledRoutes=[]`;
- actual Mail QA issued three reads and only one supported write, `POST /api/tasks`;
- registry drift creates an exact unclassified-route failure;
- stale policy creates an exact stale-policy failure;
- stable/security route removal is rejected;
- future-dated and short-observation removal is rejected;
- eligible simulated removal passes only after the date and 28-day observation window;
- strict Mobile-entry CLI exits `2` while printing the bounded blocker report.

## Automated Verification

- `npm run backend:check`: passed.
- `npm test`: passed.
  - Backend: 457 passed.
  - Desktop: 260 passed.
  - Runner: 29 passed.
- `npm run typecheck`: passed.
- `npm run build:desktop`: passed.

The existing non-blocking Vite large-bundle warning remains unchanged.

## Manual Audit Surface

Command:

```text
npm --workspace apps/backend run audit:routes -- --as-of=2026-07-25
```

Observed:

- `totalRoutes=156`
- `classifiedRoutes=156`
- `classificationComplete=true`
- `mobileEntryReady=false`
- `supportedClientDisabledRoutes=[]`
- `testOnlyRoutes=[]`
- `unclassifiedRoutes=[]`
- `stalePolicyEntries=[]`
- no user, Workspace, token, credential, request payload, or filesystem path in the report

The actual Desktop Mail workflow also passed:

- no Gmail app-password input;
- no unsupported star or archive controls;
- refresh issued only `GET /api/mail/messages`;
- “작업으로 추가” issued only `POST /api/tasks` with the source Mail identity;
- Agent Work and reply-draft delegation opened normally;
- no request reached `/api/mail/accounts`, `/api/mail/sync`, or a Mail action mutation.

Screenshots are in `apps/desktop/test-results/phase10-mail-read-only/`.

The Desktop Playwright wiring flow also passed after retirement: one image attachment produced a
review-only draft, the explicit registration action called `POST /api/calendar/events`, and the
created event became visible in Calendar. No `/api/calendar/draft` request occurred.

The authenticated Agent Work Playwright flow also passed: server-owned scheduling remained
visible, and `지금 실행` called only
`POST /api/agent-operations/tasks/task-scan/run-now`. No global Agent Operations tick request
occurred.

The same flow created Delegated Work through `POST /api/agent-operations/work`, then completed
plan, approval, and execution without any direct Workboard conversion request.

## Next Remediation Order

1. Collect route-template traffic evidence during private beta.
2. Remove compatibility/candidate routes only after their date, 28-day zero-traffic window, and
   rollback evidence.
