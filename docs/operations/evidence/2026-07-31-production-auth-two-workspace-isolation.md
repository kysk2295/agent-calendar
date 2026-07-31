# Production-auth two-Workspace isolation evidence

- Date: 2026-07-31
- Result: Pass
- Plan: `docs/plans/2026-07-31-production-auth-two-workspace-isolation.md`
- Surface: production-mode backend HTTP gateway + ephemeral PostgreSQL

## Release gate command

Run from the repository root:

```sh
npm run verify:production-workspace-isolation
```

The script sets `WORKSPACE_AUTH_MODE=production` and executes the existing hostile
cutover matrix in `apps/backend/tests/phase1-full-gateway-workspace-cutover.test.cjs`.
The harness initializes real PostgreSQL, runs the production migrations, starts the real
gateway on a loopback port, and removes the temporary cluster after the test.

If PostgreSQL binaries cannot be discovered, the command fails closed. Install PostgreSQL
17+ or rerun with `PHASE0_PG_BIN` set to its `bin` directory; do not replace this gate with
an in-memory store.

## Observed isolation proof

1. Fixture A and fixture B each received a server-issued access token bound to a distinct
   active Workspace membership.
2. The gateway ran with `WORKSPACE_AUTH_MODE=production`; anonymous and legacy global
   bearer access to the task list remained unauthorized.
3. Workspace A created `task-production-isolation-a` over `POST /api/tasks`. Even though
   the hostile request body claimed Workspace B, the persisted row and response belonged
   to Workspace A.
4. Workspace A listed tasks over `GET /api/tasks` and received the marker.
5. Workspace B listed tasks over the same endpoint and received neither the marker ID nor
   its unique title.

## Verification results

- `npm run verify:production-workspace-isolation`: 3 passed, 0 failed.
- `npm run backend:check`: pass.
- `git diff --check`: pass.

## Scope and residual risk

This is deterministic product isolation evidence using injected verified subjects and real
production session issuance, gateway dispatch, migrations, and PostgreSQL. It does not prove
live WorkOS tenant redirect/provider configuration or exercise two human Google accounts; the
existing `npm run verify:multi-user-ete` remains the broader Electron/Runner golden path.
