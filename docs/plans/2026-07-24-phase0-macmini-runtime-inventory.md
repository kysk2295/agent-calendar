# Plan: Phase 0 Story 2 — Mac mini / Relay Runtime Inventory

- Date: 2026-07-24
- Owner: Grok
- Work size: Medium
- Status: Verified — inventory + redaction-safe checker complete
- Parent design: `docs/plans/2026-07-24-production-agent-calendar-platform.md`
- Parent roadmap: `docs/plans/2026-07-24-production-development-roadmap.md`
- Prior Phase 0 slice: `docs/plans/2026-07-24-phase0-boundary-characterization.md`
- Roadmap story: Phase 0 committed story 2 — inventory the out-of-repository Mac mini runtime, profiles, versions, and deployment inputs

## Goal

Produce a redaction-safe, reproducible inventory and reconstruction runbook for the current Mac mini / Relay / Hermes runtime so Phase 1+ multi-tenant and Runner migration work does not depend on undocumented out-of-repo knowledge.

## Non-Goals

- Do not dump environment values, tokens, cookies, credential files, private keys, or customer content.
- Do not install, restart, deploy, mutate remote state, stage, or commit.
- Do not implement Workspace/RLS, Runner enrollment, or product behavior changes.
- Do not complete Phase 0 stories 1 remainder, 3 (snapshot/restore), or 4 (provider/Orca decisions).
- Do not invent Mac mini host facts when live probe evidence is incomplete.

## Touched Boundaries

- Backend gateway: none (read-only local probes only)
- Backend library: `apps/backend/app/lib/macmini-runtime-inventory.js` (validation only)
- Backend tools: `apps/backend/tools/macmini-runtime-inventory-check.cjs`
- DB/migrations: none
- Electron bridge: none
- React UI: none
- Tests: `apps/backend/tests/macmini-runtime-inventory-check.test.cjs`
- Docs: this plan, `docs/operations/macmini-runtime-inventory.md`, fixture under `docs/operations/fixtures/`

## Success Criteria

- [x] Phase 0 Story 2 child plan exists with required headings.
- [x] Durable inventory/runbook records host roles, ports, LaunchAgents, profiles, secret names/locations, deploy inputs, and reconstruction commands.
- [x] Automated checker validates inventory shape and redaction rules against sanitized fixtures.
- [x] Live probe evidence is recorded as non-secret status only; unreachable expected Mac mini surfaces become concrete blockers.
- [x] No secret values appear in new docs, fixtures, checker output, or tests.
- [x] Dirty worktree preserved; nothing staged or committed.

## Edge Cases

- This development host is a MacBook Pro with a partial local Hermes OS Runtime, not the full production execution-host layout.
- Expected curator/calendar gateway ports and Railway relay bridge may be absent while port 64369 still answers health.
- Profile directories may be only a subset of official Agent Calendar profiles.
- Connector scripts may still mention unsafe historical defaults; inventory records them as risks, not as product policy.
- Fixture validation must fail closed if a secret-shaped value appears.

## Test Plan

### RED

- [x] Write checker tests that fail when required inventory sections are missing or secret-shaped values are present.

### GREEN

- [x] Implement pure validation + fixture pass path.
- [x] Add durable inventory document and sanitized fixture that the checker accepts.
- [x] Run narrow checker tests and broader backend gate.

### REFACTOR

- [x] Keep validation pure and free of network side effects unless an optional probe mode is explicitly invoked.

## Acceptance Gates

- [x] Narrow: `node --test apps/backend/tests/macmini-runtime-inventory-check.test.cjs`
- [x] Broader backend: `npm run test:backend`
- [x] Optional local fixture CLI: `node apps/backend/tools/macmini-runtime-inventory-check.cjs --fixture docs/operations/fixtures/macmini-runtime-inventory.fixture.json`
- [x] Optional read-only probe: `node apps/backend/tools/macmini-runtime-inventory-check.cjs --probe` (non-secret status only)

건너뛴 gate:

- Gate: Railway authenticated status / production Mac mini SSH
  - Reason: no production mutation; authenticated remote Mac mini access not available from this session without secrets.
- Gate: `npm run typecheck`, desktop build/tests, full monorepo `npm test`
  - Reason: backend inventory/docs/tools only.
- Gate: Phase 0 stories 3–4
  - Reason: out of scope for this slice.

## Implementation Checklist

- [x] Read roadmap Story 2 and prior Phase 0 characterization plan.
- [x] Collect redaction-safe facts from repo docs, scripts, and read-only local probes.
- [x] Write Story 2 child plan.
- [x] Write inventory/runbook + sanitized fixture.
- [x] Implement validation library, CLI, and tests.
- [x] Run narrow + broader backend verification.
- [x] Record probe blockers and remaining Phase 0 gaps; stop without commit/stage.

## Verification Notes

- Command: `node --test apps/backend/tests/macmini-runtime-inventory-check.test.cjs`
  - Result: passed; 13/13
- Command: `node apps/backend/tools/macmini-runtime-inventory-check.cjs --fixture docs/operations/fixtures/macmini-runtime-inventory.fixture.json`
  - Result: passed; ok=true, 5 official profiles, 12 secret names, 1 documented blocker; fixture path is repo-relative
- Command: `node apps/backend/tools/macmini-runtime-inventory-check.cjs --probe`
  - Result: exit 2 by design; blockers include `P0-S2-MACMINI-HOST-UNREACHABLE`, `P0-S2-RELAY-BRIDGE-SCRIPT-MISSING`, `P0-S2-OFFICIAL-PROFILES-INCOMPLETE`, and `P0-S2-UNSAFE-RUNTIME-CAPABILITY` when health advertises `no-approval-runner`; capability list preserved as evidence; runtime not mutated; no secret values, absolute user paths, or host identity strings printed
- Command: `npm run test:backend`
  - Result: passed; 308/308

## Remaining Risks

- Risk: Full production Mac mini execution host remains out-of-repository and was not fully reachable as the documented path-template layout.
  - Mitigation: inventory lists expected paths/commands and records live blockers; Story 2 exit remains conditional on a later authenticated Mac mini probe.
- Risk: Live runtime health can advertise `no-approval-runner` or other approval-bypass / yolo-style capabilities, conflicting with the production ban on approval bypasses.
  - Mitigation: checker classifies these as `P0-S2-UNSAFE-RUNTIME-CAPABILITY`, keeps the redacted capability list as evidence, and never mutates the runtime in Story 2.
- Risk: Local connector defaults historically include unsafe runner command templates.
  - Mitigation: inventory marks them as reconstruction risks; product code continues to reject unsafe Hermes profile commands.
- Risk: Live health responses can include private paths.
  - Mitigation: checker and probe redaction strip local absolute paths and secret-shaped fields.
