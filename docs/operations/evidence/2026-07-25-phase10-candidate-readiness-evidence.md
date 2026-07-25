# Phase 10 candidate readiness evidence

- Date: 2026-07-25
- Scope: read-only candidate-bound Gateway readiness producer
- External mutation: none

## Outcome

`scripts/railway-release-gate.cjs probe-readiness` now produces a
`schemaVersion=1`, `kind=gateway_readiness` document only when the exact public
Gateway deployment proves all of the following:

- `/api/gateway-status=200` exposes the exact candidate deployment ID and a 12–40 character
  prefix of the candidate full commit SHA.
- `/api/health=200` returns `ok=true`.
- `/api/ready=200` returns `ok=true`.

The producer accepts only an HTTPS root origin in operator use. It follows no redirects, probes
only those three paths, bounds each JSON response to 64KiB including chunked responses, and does
not emit the origin, response body, headers, user data, Workspace data, or network errors.

The release gate rejects the earlier readiness shape that contained only `/api/ready`.

## Product bug found and fixed

The production route dispatcher was replacing the legacy public Gateway status with a generic
payload that omitted `buildCommit` and `deploymentId`. A real local Gateway probe exposed the
missing provenance. The dispatcher now projects only the bounded commit prefix and Railway
deployment ID from deployment environment metadata; no tenant data is added.

## Actual observations

### Real local production-mode Gateway

The integration test started the actual Gateway dispatcher with production auth mode, a real
HTTP listener, a healthy dependency probe, and explicit candidate provenance. All three public
paths passed and the producer emitted bounded candidate-bound readiness evidence.

### Current Railway production

Read-only observation against `https://hermes-os-production-e174.up.railway.app`:

- `/api/gateway-status`: HTTP 200, commit prefix `16d59256801d`, deployment
  `8ac25199-857d-49a1-9e8b-d301dca8c44f`.
- `/api/health`: HTTP 200, `ok=true`.
- `/api/ready`: HTTP 401, `ok=false`.

The CLI exited 1 with only `candidate readiness probe failed` and wrote no evidence. This proves
the current production deployment cannot be reused as candidate readiness proof. No production
deploy, rollback, variable change, or other external mutation was performed.

## Verification

- Focused readiness and release tests: 19/19 passed.
- Backend syntax check: passed.
- Full repository test suite: exited 0; Desktop 262/262 and Runner 29/29 passed.
  Repeated Desktop HMR WebSocket port warnings were non-fatal.
- `git diff --check`: passed.

## Remaining release gate

An isolated Railway staging environment/service/database must exist before this producer can
create a real staging candidate artifact. That artifact and the clean-account WorkOS ETE artifact
must bind to the same exact deployment, commit, environment, and service before promotion.
