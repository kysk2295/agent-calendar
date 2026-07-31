# Plan: Production launch readiness package

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified locally; external production gates pending
- Branch: `kysk2295/agent-control-p0-wave1`

## Goal

Provide one repeatable local command that checks backend syntax, the critical
Workspace isolation/AuthKit boundary, the production auth-mode cutover, production
multi-Workspace isolation, desktop types, and the injected first-user journey. The
command must end with a secret-free JSON result while keeping live Railway,
real-tenant, signing, security, and public packaging work visibly blocked until
operators produce external evidence.

## Non-Goals

- Deploying or rolling back Railway without operator-provided credentials and a
  reviewed candidate.
- Treating the injected AuthKit/Google journey as live WorkOS or live Google
  Calendar evidence.
- Building the mobile client or public web landing site.
- Producing, signing, notarizing, or publishing desktop and Runner artifacts.

## Touched Boundaries

- Backend gateway: none; the package runs the existing syntax gate.
- Backend library: none.
- DB/migrations: none; live PostgreSQL readiness remains an environment gate.
- Electron bridge: none.
- React UI: none; the package runs existing type and injected Playwright gates.
- Tests: root readiness-summary unit contract and selected existing backend/desktop tests.
- Docs: this launch checklist and residual-gate record.
- Root tooling: readiness runner, shell entrypoint, and npm scripts.

## Success Criteria

- [x] `npm run verify:production-readiness` runs all six local gate groups and
      exits non-zero if any group fails.
- [x] The final stdout line is a versioned JSON summary containing only fixed
      check identifiers, status, exit code, and timing; command output and
      environment values are excluded.
- [x] The summary distinguishes local injected readiness from production launch
      readiness and lists every residual external gate as pending.
- [x] Operators can follow one checklist from personal beta through staging and
      production, including required environment variable names and rollback.

## Edge Cases

- A local check cannot start: record a failed check with a bounded exit status,
  continue the remaining checks, print the summary, and exit non-zero.
- A check writes arbitrary output: route it outside the machine-readable stdout
  summary and never copy it into JSON.
- Injected first-user journey passes: report local readiness only; do not infer a
  live WorkOS, Google, Railway, signed-desktop, or Runner-package pass.
- Local repository contains unrelated in-progress edits: do not overwrite them;
  readiness reflects the working tree actually tested.

## Test Plan

- RED:
  - [x] Add a unit contract for summary shape, failure aggregation, and exclusion
        of injected secret/output fields; confirm it fails before the helper exists.
  - [x] Extend the fixed-check contract with the production auth-mode cutover and
        production Workspace-isolation gates; confirm it fails for the two missing
        definitions.
- GREEN:
  - [x] Implement the fixed-check runner and shell/npm entrypoints.
  - [x] Add the fast auth-cutover npm script and both local-gate definitions.
  - [x] Confirm the three unit contracts and both new component gates pass.
- REFACTOR:
  - [x] Keep command definitions and external-gate identifiers declarative and
        keep child output out of stdout.

## Acceptance Gates

- [x] `node --test scripts/production-readiness.test.cjs`
- [x] `npm run backend:check` (through the packaged command)
- [x] `npm run test:backend:critical` (through the packaged command)
- [x] `npm run test:production-auth-mode-cutover`
- [x] `npm run verify:production-workspace-isolation`
- [x] `npm run typecheck` (through the packaged command)
- [x] `npm run verify:first-user-journey:injected` (through the packaged command)
- [x] `npm run verify:production-readiness`
- [x] `git diff --check`

Skipped gates:

- `npm test`: the new command deliberately exercises the narrower launch-critical
  test set; the full repository suite is outside this packaging change.
- `npm run build:desktop`: no desktop product/build configuration changes; the
  first-user Playwright journey builds the surfaces it exercises.
- Live Railway release/rollback: requires Railway credentials, isolated staging,
  candidate binding, and operator authorization.

## Implementation Checklist

- [x] Step 1: lock the secret-free readiness summary contract with a failing test.
- [x] Step 2: implement the runner, shell entrypoint, and root npm scripts.
- [x] Step 3: lock and implement the expanded six-check list with production auth
      cutover and multi-Workspace isolation.
- [x] Step 4: run the narrow unit test and all component gates.
- [x] Step 5: run the one-command package and capture the resulting local status.
- [x] Step 6: finalize the personal-beta, staging, production, rollback, and
      residual-gate runbook below.

## Launch Checklist

### Required environment names

Store values in the environment's secret manager; never commit values or paste
them into readiness evidence.

| Area | Required names | Production rule |
| --- | --- | --- |
| Workspace auth | `WORKSPACE_AUTH_MODE` | Must equal `production`; `legacy` is personal-beta fallback only. |
| WorkOS AuthKit | `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | Use the environment's tenant/client; configure the exact desktop redirect/deep-link in WorkOS. |
| Google Calendar OAuth | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | Use separate staging/production OAuth clients and registered redirect URIs. |
| PostgreSQL | `DATABASE_URL` | Staging and production must be separate services; apply reviewed migrations before traffic. |
| Operations readiness | `AGENT_CALENDAR_OPERATIONS_TOKEN`, `AGENT_CALENDAR_OBSERVABILITY_LOGS` | Use an independent random operations token and set logging to `1`; follow `docs/operations/production-observability.md` for limits. |

### Personal beta exit gate

- [x] `npm run verify:production-readiness` exits 0 and its JSON reports
      `localReadiness=pass` and `productionReadiness=external_gates_pending`.
- [x] No secret values appear in the JSON artifact.
- [x] Known personal-beta fallback is explicit: `WORKSPACE_AUTH_MODE=legacy` is
      not production evidence.
- [ ] Candidate commit and owner for each external gate are recorded.

### Staging exit gate

- [ ] Deploy the reviewed commit to an isolated Railway staging service and
      separate staging PostgreSQL database.
- [ ] Configure staging WorkOS AuthKit and Google Calendar OAuth credentials and
      registered redirects; verify `WORKSPACE_AUTH_MODE=production`.
- [ ] Produce candidate-bound `/api/gateway-status`, `/api/health`, and
      `/api/ready` evidence with `scripts/railway-release-gate.cjs`.
- [ ] Complete a clean-account journey using the live WorkOS tenant and real
      Google Calendar OAuth; injected adapters are rejected as staging evidence.
- [ ] Execute [`production-live-dogfood.md`](../operations/production-live-dogfood.md)
      against the exact staging candidate, including empty Workspace honesty,
      Runner enrollment transport, and a completed Mode A Delegated Work. Record the
      QR scanner gate as pending when the displayed-challenge CLI fallback was used.
- [ ] Produce staging/production database-isolation evidence and a release
      preflight whose commit matches the reviewed candidate.
- [ ] Run the external penetration/security test plan against staging and close
      or explicitly accept every launch-blocking finding.
- [ ] Exercise a Railway rollback to the retained last-known-good deployment and
      re-check `/api/ready` plus the clean-account smoke after rollback.
- [ ] Deploy the operations alert collector on an external persistent scheduler
      and observe a test alert and recovery.

### Production exit gate

- [ ] Review the unexpired Railway preflight, candidate commit, staging evidence,
      isolation evidence, and exact rollback deployment ID.
- [ ] Build, sign, notarize, and smoke-test the macOS desktop artifact; verify the
      update metadata and deep-link behavior on a clean host.
- [ ] Build the public Runner archive and signed manifest, verify checksum and
      signature, test atomic install/rollback, and publish operator instructions.
- [ ] Promote only through `scripts/deploy-railway-main.sh` with the reviewed
      preflight file; do not treat this local readiness command as deploy authority.
- [ ] Verify production `/api/health=200`, `/api/ready=200`, live clean-account
      WorkOS/Google journey, Runner execution, reconnect, and Calendar result.
- [ ] Repeat [`production-live-dogfood.md`](../operations/production-live-dogfood.md)
      against the exact production candidate and retain only its secret-free evidence.
- [ ] Confirm the external collector is running, persistent state is healthy, and
      the on-call destination receives the production test signal.
- [ ] Retain secret-free release evidence and record final go/no-go approval.

### Rollback / fallback

- Gateway: on readiness or smoke regression, stop promotion and use the exact
  `canRollback=true` last-known-good deployment through the documented Railway
  release gate. Re-run readiness and clean-account smoke after rollback.
- Desktop: stop the rollout and retain the last signed/notarized artifact and
  update metadata; do not publish an unsigned replacement.
- Runner: use the signed manifest/updater's atomic previous-release fallback and
  preserve the Runner state directory and Workspace enrollment.
- Auth: `WORKSPACE_AUTH_MODE=legacy` is allowed only as the documented personal-beta
  fallback, never as a production rollback that weakens tenant isolation.

## Verification Notes

- RED: `node --test scripts/production-readiness.test.cjs`
  - Result: failed for the expected reason, `MODULE_NOT_FOUND` for the not-yet-created
    `production-readiness.cjs` helper.
- Expansion RED: `node --test scripts/production-readiness.test.cjs`
  - Result: the new fixed-check contract failed for the expected reason: the auth
    cutover and production Workspace-isolation definitions were missing; the two
    existing summary-contract tests remained green.
- GREEN: `npm run test:production-readiness`
  - Result: 3/3 passed, covering the fixed six-check command map, summary shape,
    failure aggregation, fixed external gates, and omission of injected
    output/environment/error secrets.
- Expanded component gates:
  - `npm run test:production-auth-mode-cutover`: 2/2 passed.
  - `npm run verify:production-workspace-isolation`: 3/3 passed, including the
    hostile production-mode two-Workspace matrix on real PostgreSQL.
- Packaged gate: `npm run verify:production-readiness`
  - Result: exit 0, `localReadiness=pass`,
    `productionReadiness=external_gates_pending`.
  - Backend syntax passed.
  - Critical backend isolation/AuthKit suite passed 12/12, including real
    PostgreSQL two-Workspace isolation and desktop login bootstrap boundaries.
  - Production auth-mode cutover passed 2/2.
  - Production Workspace isolation passed 3/3, including the hostile
    production-mode two-Workspace matrix on real PostgreSQL.
  - Desktop renderer/Electron typecheck passed.
  - Injected first-user Playwright journey passed with one completion, Google
    Calendar OAuth contract coverage, safe storage, and restart restore.
  - The secret-free JSON contained all six local check IDs and left all five
    external gates pending.
- Static checks: `sh -n scripts/production-readiness.sh`,
  `node -c scripts/production-readiness.cjs`, and `git diff --check` all passed.
- Live Railway deployment or rollback was not run: no credentialed deployment was
  authorized for this task, and the JSON correctly leaves that external gate pending.

## Remaining Risks

- Railway live release and rollback have not been run by this package.
- The external penetration test is pending.
- Signed/notarized desktop distribution is pending.
- The public signed Runner package and distribution path are pending.
- The operations collector still requires external deployment and on-call wiring.
