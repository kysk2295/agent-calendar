# Plan: Default-deny grants and effective configuration

- Date: 2026-07-26
- Owner: Codex (production-readiness Todo 10)
- Work size: Large / Boundary
- Status: Complete — Runner lease authenticity remediated

## Goal

Make tool and skill execution default-deny. The Backend owns one Workspace-scoped
resolver used for both previews and immutable execution snapshots, while the Runner
independently verifies that snapshot before invoking an engine. Desktop shows the
redacted current preview and persisted historical snapshots.

The Runner must also authenticate the complete lease binding. A deterministic
snapshot hash is only an identity; it is not proof that the Backend authorized the
grant decision. Lease integrity therefore derives from the existing high-entropy
device credential trust root and covers the complete lease before any adapter or
tool resolution.

## Non-Goals

- Do not redesign profile memory, provider sessions, channels, or the agent builder.
- Do not store or expose credentials, host paths, raw provider settings, or cross-Workspace IDs.
- Do not add silent fallback grants or make an Approval Gate invent unsupported capability.

## Touched Boundaries

- Backend gateway: Workspace-scoped agent effective-configuration preview route.
- Backend library: grant normalization, versioned catalog normalization, resolver, update approval gate, execution snapshot.
- DB/migrations: JSONB-backed agent/job fields only; no new table or destructive migration.
- Runner: stable catalog report and pre-adapter snapshot enforcement.
- React UI: current and historical redacted configuration in Agent Work details.
- Tests: focused Backend resolver/API/durable lease tests, Runner enforcement tests, Desktop parser/design/Playwright.
- Docs: this plan and redaction-safe evidence.

## Success Criteria

- [x] Workspace B cannot enumerate Workspace A catalog or grants.
- [x] Deny overrides allow and an ungranted capability never leases or executes.
- [x] A grant expansion or external-delivery grant is persisted only as a pending Approval Gate.
- [x] Preview and execution use the same resolver and have the same snapshot identity.
- [x] Profile, grants, or Runner catalog mutation makes a supplied preview identity stale.
- [x] The job keeps an immutable redacted effective-configuration snapshot.
- [x] Desktop shows current preview and historical snapshots after a Backend restart.
- [x] A recomputed unkeyed snapshot forgery cannot reach adapter resolution.
- [x] Lease integrity covers grant state, snapshot, job, Workspace, Runner, credential
  version, expiry, and replay state.
- [x] A valid Backend-issued lease verifies after Runner process restart.

## Edge Cases

- Legacy agents have empty allow/deny lists and therefore grant nothing.
- Missing, malformed, foreign, or changed Runner catalogs fail closed.
- Missing, malformed, stale, replayed, wrong-Runner, wrong-Workspace, or
  wrong-credential-version lease authorizations fail closed.
- A denied capability remains denied even when also allowed.
- Catalog entries use bounded stable IDs and positive versions; duplicates are rejected.
- Secret-like fields are discarded before hashing, persistence, API projection, or evidence.

## Test Plan

- RED:
  - [x] Resolver tests for default deny, deny-over-allow, catalog versioning, stale preview, and redaction.
  - [x] Service/durable tests for Workspace isolation, Approval Gate, immutable snapshot, and lease denial.
  - [x] Runner test proving denied capability never reaches the adapter.
  - [x] Desktop parser/design/Playwright test for current and historical configuration.
- GREEN:
  - [x] Add one pure resolver and call it from preview and job creation/lease.
  - [x] Persist compatible JSONB grant and snapshot fields.
  - [x] Add Runner catalog reporting/enforcement and minimal Desktop projection.
- REFACTOR:
  - [x] Keep catalog/grant normalization centralized and rerun all focused gates.

## Acceptance Gates

- [x] `node --test apps/backend/tests/workspace-agent-directory.test.cjs`
- [x] focused durable/API hostile tests
- [x] focused Runner enforcement tests
- [x] focused Desktop parser/design tests and Playwright
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run test:runner`
- [x] `npm run build:desktop`
- [x] `npm test`

## Rollback / Fallback

The new fields live in existing JSONB payloads. Rolling back code leaves old agents
default-deny and old jobs immutable. Runner enforcement fails closed when a snapshot
is malformed or requires capabilities, so rollback never broadens authority.

## Implementation Checklist

- [x] Step 1: lock the pure resolver and grant-update semantics with failing tests.
- [x] Step 2: integrate preview, approval gating, and execution snapshots in Backend paths.
- [x] Step 3: enforce the snapshot in offer/lease and Runner execution.
- [x] Step 4: project current/history to Desktop and verify restart behavior.
- [x] Step 5: run adversarial, regression, manual QA, cleanup, and record DoneClaim evidence.
- [x] Step 6: add recomputed-forgery and complete lease-tamper RED tests.
- [x] Step 7: authenticate the complete lease with the existing device-credential trust root.
- [x] Step 8: rerun current focused/full gates and replace the DoneClaim evidence.

## Verification Notes

- `node --test apps/backend/tests/workspace-agent-directory.test.cjs apps/backend/tests/phase3-durable-execution.test.cjs`
  - Result: 24/24 pass.
- `npm --workspace apps/desktop run test`
  - Result: 309/309 pass.
- `npm test`
  - Result: Backend 541/541, Desktop 316/316, Runner 92/92 pass.
- Playwright Argo Agent Control:
  - Result: exit 0; current and historical effective configuration visually inspected.
- `node --test apps/runner/tests/runtime-policy.test.cjs apps/backend/tests/workspace-agent-directory.test.cjs apps/backend/tests/phase3-durable-execution.test.cjs`
  - Result: 35/35 pass, including recomputed forgery, full lease-field tamper,
    wrong scope/version, stale/replay, and valid restart scenarios.

## Remaining Risks

- No known Todo 10 correctness risk remains. The Runner now verifies a keyed,
  complete lease binding derived from its existing random device credential before
  adapter resolution. The Backend retains only the credential hash, and authorization
  replay/expiry state survives Runner restart.
