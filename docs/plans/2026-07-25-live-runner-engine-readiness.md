# Plan: Live Runner Engine readiness

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Implementation verified; release-host distribution and Grok successful-generation
  gates open

## Goal

Make Runner capability reporting distinguish an installed CLI from an authenticated,
actually usable execution engine, align Grok and Hermes launch arguments with the
installed current CLIs, produce redaction-safe live execution evidence on a
customer-controlled host, and project terminal Engine failures truthfully without creating
successful Calendar results.

## Non-goals

- Treating any operator-owned Mac mini or other shared machine as a product dependency.
- Printing or moving provider tokens, credential files, account emails, or private prompts.
- Bypassing provider approvals, sandboxing, tool confirmation, or usage limits.
- Marking unavailable providers ready through fallback to another Engine.

## Work size

Large and Boundary. Capability meaning crosses Runner probes, backend readiness,
Desktop onboarding, Engine adapter execution, tests, and live host evidence.

## Touched boundaries

- Runner capability probe and Engine adapters
- Runner unit and live smoke tests
- Desktop Runner readiness presentation
- Phase 3 live-engine verification evidence

## Success criteria

- [x] Version-only success reports `installed`, never authenticated readiness.
- [x] Codex and Claude use their explicit authentication status commands.
- [x] Grok verifies authenticated model discovery without exposing output; generation is
      currently blocked by an explicit `quota_exhausted` result.
- [x] Hermes verifies a configured provider and usable credential without exposing labels.
- [x] Missing authentication cannot satisfy onboarding or backend Runner readiness.
- [x] Grok uses the installed CLI's supported non-interactive arguments.
- [x] Hermes uses a supported safe stdin-based invocation and no bypass flags.
- [x] Codex, Claude, and Hermes complete bounded live smokes and the full clean-account product
      ETE.
- [x] Grok's real `quota_exhausted` terminal updates Delegated Work and Work Conversation,
      survives restart/reconnect, and creates no Calendar result.

## Edge cases

- Binary installed but logged out.
- Auth command exits zero while reporting unauthenticated state.
- Auth output includes PII or credential labels.
- Provider quota is exhausted after authentication succeeds.
- CLI version changes its non-interactive arguments.
- Prompt text appears in the process list or persistent world-readable file.

## Test plan

- RED: pure auth-result interpretation for authenticated, logged-out, missing, and timeout cases.
- RED: current Grok/Hermes argv contracts reject retired arguments.
- GREEN: two-stage version/auth probe with redacted public messages.
- GREEN: current safe adapter argv and protected temporary prompt file where needed.
- Live: run bounded no-tool prompts only for engines reported authenticated.
- REFACTOR: keep provider-specific interpretation beside the probe contract.

## Acceptance gates

- [x] Runner focused tests and check
- [x] Desktop onboarding readiness tests
- [x] Backend Runner matrix
- [x] Full Runner/Desktop/Backend regression
- [x] Live host capability report
- [x] Bounded real Engine smoke
- [x] Real Grok quota-failure product ETE
- [x] `git diff --check`

## Step-by-step checklist

- [x] Confirm host class and installed CLI versions.
- [x] Inspect installed CLI authentication and non-interactive help.
- [x] Add failing capability/argv tests.
- [x] Implement authenticated readiness and current adapters.
- [x] Run live Engine smoke and record outcomes.
- [x] Extend the clean-account Electron ETE to select a real Engine and pass it with Codex.
- [x] Extend the ETE with an expected-failure contract and pass the real Grok quota path.
- [x] Re-run product gates and document external blockers.

## Rollback

Revert the Runner capability and adapter changes. Existing enrolled Runner identity,
credentials, jobs, and product data are not migrated or deleted.

## Remaining risks

- Release distribution still needs a fresh ordinary user-owned Runner host rehearsal.
- Provider quotas and service availability can change after a successful auth probe.
- Grok Build currently returns HTTP 402 because its usage balance is exhausted. This is surfaced
  as `quota_exhausted`; Grok generation readiness is not claimed.
- Live provider execution is environment-specific and cannot replace deterministic Fake
  Engine coverage.
- Grok successful generation cannot pass until its usage balance is restored; its full
  clean-account terminal-failure ETE already passes.
