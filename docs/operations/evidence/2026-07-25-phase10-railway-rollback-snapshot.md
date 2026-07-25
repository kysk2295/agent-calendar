# Phase 10 Railway rollback snapshot evidence

- Date: 2026-07-25
- Result: implementation and fixture pass; live Public API token gate open
- Railway mutation: none

## Official contract

Railway Public API exposes `canRollback` on a deployment. Deployment listing accepts exact
project, environment, and service selectors. Authentication differs by token type:

- Account, Workspace, or OAuth token: `Authorization: Bearer`
- Project Token: `Project-Access-Token`

The implementation never attempts to recover a token from Railway CLI credential storage.

## Implemented boundary

`snapshot-deployments` performs one read-only GraphQL query against the fixed Agent Calendar
production project, environment, and service and requests at most 20 deployments.

The returned document contains only:

- deployment ID;
- bounded status;
- normalized creation time;
- `canRollback`;
- full commit SHA;
- exact source repository.

Raw metadata, URLs, image digests, commit messages, upstream errors, and token values are not
projected.

The request fails before network I/O when:

- neither token is present;
- both token types are present;
- fetch is unavailable.

The response fails closed when:

- HTTP or GraphQL reports failure;
- deployment edges are malformed or exceed the bound;
- IDs are duplicated;
- `canRollback` is missing;
- status/time/repository/full commit provenance is invalid.

## Verification

Focused tests observed:

- fixed production selector variables and `first=20`;
- Account Token bearer header with no Project Token header;
- Project Token header with no bearer header;
- two bounded deployment records with private metadata removed;
- retained snapshot record accepted by the exact rollback target validator;
- missing/ambiguous token and malformed response rejection;
- Project Token support on the rollback mutation without token reflection;
- actual local Gateway readiness failure and rollback rehearsal.

Result: 15/15 focused release tests passed.

Manual CLI without explicit token:

`node scripts/railway-release-gate.cjs snapshot-deployments`

Observed bounded failure:

`exactly one Railway Public API token is required`

Current environment state:

- `RAILWAY_API_TOKEN`: not configured
- `RAILWAY_PROJECT_TOKEN`: not configured
- live GraphQL request: not performed
- Railway mutation: not performed

## Remaining external gate

Inject one read-only-capable Account or production-scoped Project Token from a secret manager and
capture the live sanitized snapshot. A retained `canRollback=true` deployment with full commit
provenance must exist before staging promotion can proceed.
