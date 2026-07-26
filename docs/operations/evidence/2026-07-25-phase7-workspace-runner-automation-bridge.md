# Phase 7 Workspace Runner automation bridge evidence

- Date: 2026-07-25
- Scope: Hermes Automation Federation execution ownership
- Result: local implementation, isolation, persistence, and HTTP surface verified

## Closed production gap

Automation records were Workspace-scoped, but the production Gateway constructed actual Hermes
requests with the server-global `HERMES_RELAY_RUNNER_ID`. The implementation now sends each
capability, list, create, update, pause, resume, and run request only to the Runner named by that
Workspace's source connection.

Production composition no longer constructs the global Hermes relay Adapter. The old composition
remains available only in explicit non-production legacy mode as a rollback path.

## Credential locality

The Hermes endpoint and bearer token are read only by the customer-owned Runner from:

- `AGENT_CALENDAR_HERMES_AUTOMATION_URL`
- `AGENT_CALENDAR_HERMES_AUTOMATION_TOKEN`

The endpoint must be loopback HTTP(S). The Gateway request, connector queue, database response,
public result, and evidence contain neither credential. Secret/private response keys, host paths,
secret-shaped values, oversized payloads, and over-deep payloads fail closed before persistence.

## TDD evidence

Expected RED:

- Runner connector loop rejected automation request kinds.
- Runner-local Hermes automation connector did not exist.
- Production Gateway composed the global Hermes relay Adapter.
- Real PostgreSQL automation capabilities/list/pause could not complete through the exact
  Workspace Runner.

Focused GREEN:

- Runner provider connector tests: 11/11 passed.
- Backend Phase 7 tests: 6/6 passed.

Broad GREEN:

- Backend syntax: passed.
- Runner syntax: passed.
- Desktop typecheck: passed.
- Desktop production build: passed.
- Full suite: Backend 504/504, Desktop 274/274, Runner 43/43 passed.
- The existing Vite large-chunk and occupied HMR-port warnings remained non-failing.

## Workspace A/B and durable queue evidence

The real PostgreSQL test enrolled Runner A and Runner B into different Workspaces. A capabilities
request created for Workspace A was visible only to Runner A. Runner B received no request and
could not complete the copied request ID. Runner A then completed capabilities, synchronized the
Hermes list, and paused the automation. The resulting receipt succeeded and the projected
automation status became `paused`.

Every persisted connector row remained bound to Workspace A and Runner A. Inspected request and
response JSON contained no token, credential, cookie, API key, or private connector configuration.

## Actual local HTTP surface

An actual loopback HTTP server observed:

- `GET /api/cron/jobs`
- `POST /api/cron/jobs/morning-brief/pause`

The Runner attached local Authorization to both requests, returned one public automation and one
occurrence, and projected the pause result as `paused`. The local token was not reflected in the
result.

## External release gates

The installed live Hermes application was not exercised because no approved Runner-local Hermes
endpoint/auth configuration was provided for this environment. Claude, Codex, and Grok automation
connectors remain explicitly unavailable until a real public or provider-local automation
interface is verified. These are release gates; the implementation does not invent equivalent
provider capabilities or silently fall back to a shared server credential.
