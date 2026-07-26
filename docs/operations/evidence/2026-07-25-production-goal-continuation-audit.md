# Production goal continuation audit

- Captured: 2026-07-25 KST
- Branch: `codex/production-multiuser-rc`
- Commit: `943dd4aeb22d2faf4bbf3d6b93dd4804f6a3190b`
- Production mutation performed: no
- Result: local product gates pass; external release gates remain closed

## What is working on the current commit

- Full repository regression passes.
  - Desktop: 281/281
  - Runner: 52/52
- Two-account local Electron ETE passes with two isolated Workspaces and one isolated Runner per
  Workspace.
  - each Workspace completed three durable jobs and two inference jobs;
  - Calendar and Wiki markers remained isolated;
  - Account A restored after Desktop and Gateway restart;
  - screenshot hashes were distinct across the observed states.
- Live Codex Electron ETE passes.
  - provider agent and provider session import;
  - same provider session follow-up;
  - streaming checkpoint and Calendar result;
  - Desktop and Gateway restart;
  - provider session restoration and archive.
- Live Claude Electron ETE passes through Runner enrollment, execution, checkpoint, Calendar
  projection, restart, and reconnect.
- Live Hermes Electron ETE passes through the same durable execution journey.
- Live Grok failure ETE truthfully returns `quota_exhausted`, restores the failed state after
  restart, and does not project a false completed Calendar result.

These Electron journeys use the injected WorkOS AuthKit test adapter. They are product regression
evidence and are deliberately not eligible production release evidence.

## Current Runner engine truth

The current host capability probe reports:

| Engine | Installed | Authentication | Runtime contract |
| --- | --- | --- | --- |
| Codex | yes | authenticated | streaming |
| Claude | yes | authenticated | streaming |
| Grok | yes | authenticated | limited; quota-exhausted failure observed |
| Hermes | yes | authenticated | limited batch schema |

No provider credential, account identifier, cookie, token, or provider home was written to this
evidence.

## Current Railway truth

The fixed Agent Calendar Railway selectors still resolve to project
`b64a9c8f-101e-4e08-9a7f-68fea0a4de9a`, whose visible project name is `hermes-os`, and service
`b7bd75ff-cc24-4a6d-9387-1628fcaff9d6`, sourced from `kysk2295/agent-calendar`.

- only the `production` environment exists;
- no isolated `staging` environment or staging database exists;
- all listed Agent Calendar deployments are currently `REMOVED`;
- the previous release candidate `8ac25199-857d-49a1-9e8b-d301dca8c44f` is removed;
- the public service domain returns HTTP 404 for `/api/health`, `/api/ready`, and
  `/api/gateway-status`;
- only `DATABASE_URL` is present among the required production keys inspected;
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, public base URL, and OAuth redirect configuration are
  absent;
- no Railway Public API token is available in the current process, so retained
  `canRollback` truth cannot be collected.

The public Gateway is therefore not a running production Agent Calendar surface on this capture.

## Exact remaining release gates

1. Create an isolated Railway staging environment and distinct PostgreSQL instance.
2. Provision a real WorkOS AuthKit application and two clean test accounts, then configure the
   exact staging callback and public origin.
3. Push and review the current 11-commit release branch, deploy that exact commit to staging, and
   collect candidate-bound readiness evidence.
4. Run the real WorkOS clean-account ETE against staging.
5. Run hostile two-account provider ETE with two independently owned provider credentials and
   Runner homes.
6. Provide exactly one Railway Public API token through a secret manager and prove a retained
   `canRollback` target.
7. Promote only after the evidence-bound preflight passes, then repeat readiness and clean-account
   ETE on production.
8. Sign and notarize the Desktop and Runner artifacts before publishing a stable channel.

Mobile remains blocked by the roadmap rule until these Desktop/Web production gates pass.
