# Plan: Production live dogfood operator checklist

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Give an operator one ordered, secret-free manual runbook for the production-auth
path that local fixtures cannot prove: real-tenant WorkOS login, real Google
Calendar consent and sync, Runner QR enrollment, an honest empty Workspace, and a
first Mode A Delegated Work while `WORKSPACE_AUTH_MODE=production`.

## Non-Goals

- Performing OAuth, enrolling a physical Runner, or changing Railway state in this task.
- Replacing the automated injected first-user journey or Railway release preflight.
- Claiming public, mobile, or multi-tenant launch readiness from one dogfood account.
- Logging secret values, OAuth callbacks, QR payloads, one-time codes, session data,
  user identity, calendar content, or provider credentials.

## Work Size

Medium. The change is documentation-only and touches several operational records,
but does not change an API, schema, Electron bridge, database meaning, or product
behavior.

## Touched Boundaries

- Backend gateway: none.
- Backend library: none.
- DB/migrations: none.
- Electron bridge: none.
- React UI: none.
- Tests: documentation/link and whitespace checks only.
- Docs: live dogfood runbook, local WorkOS handoff, and production-readiness
  residual gates.

## Success Criteria

- [x] The runbook orders candidate binding, anonymous fail-closed proof, live
  WorkOS login, empty Workspace inspection, Google Calendar connect/sync, Runner
  enrollment, Mode A execution, and restart/reconnect checks.
- [x] Every step names expected UI, stop/fail signals, and secret-free evidence.
- [x] QR rendering, QR scanner transport, and the repository CLI fallback are
  distinguished so a CLI enrollment cannot be reported as a QR-scan pass.
- [x] The evidence template records bounded booleans and candidate identifiers,
  not account, Workspace, OAuth, calendar, Runner credential, or prompt/result data.
- [x] Local WorkOS and production-launch-readiness documents link to the runbook
  and continue to describe live external gates as pending until an operator runs it.

## Edge Cases

- WorkOS or Google consent is cancelled, times out, or returns to the wrong Desktop
  instance: stop that gate, close stale browser tabs, and retry from a fresh in-app action.
- A new Workspace returns zero agents: treat it as the expected honest state; any
  synthetic official-profile roster is a failure.
- The Runner challenge expires or its host fingerprint differs: reject it and issue
  a new challenge; never confirm a mismatch.
- The Runner enrolls but is disconnected or its execution engine is unauthenticated:
  Runner setup is incomplete and Mode A must not be attempted.
- Mode A creates a Work Conversation but no checkpoint, terminal result, or Calendar
  projection appears: record a failed live gate rather than inferring success.
- A screenshot would contain account identity, calendar text, QR/code, fingerprint,
  prompt, or output: crop/redact before retention or use a boolean observation instead.

## Test Plan

This is documentation-only, so product-code TDD is not applicable.

- RED:
  - [x] Confirm the production live runbook does not yet exist and the current
    launch checklist leaves the manual path distributed across residual bullets.
- GREEN:
  - [x] Add the ordered runbook, evidence template, and both cross-links.
- REFACTOR:
  - [x] Review terminology against current UI and remove any claim not supported by
    the live operator observations requested by the runbook.

## Acceptance Gates

- [x] `test -f docs/operations/production-live-dogfood.md`
- [x] `rg -n "production-live-dogfood.md" docs/operations/local-workos-dogfood.md docs/plans/2026-07-31-production-launch-readiness.md`
- [x] `rg -n "QR payload|one-time code|access token|refresh token" docs/operations/production-live-dogfood.md` (manual secret-handling review)
- [x] whitespace check for all four untracked/modified documentation files via
      `git diff --no-index --check /dev/null <file>`

Skipped gates:

- Backend, Desktop, Runner, build, and full test suites: no product code or executable
  configuration changes.
- Live OAuth/Runner/Mode A execution: requires operator-owned accounts, consent,
  a physical Runner host, and an approved candidate; explicitly outside this task.

## Implementation Checklist

- [x] Step 1: document prerequisites, stop rules, and candidate binding.
- [x] Step 2: document live WorkOS, empty Workspace, Google, and Runner observations.
- [x] Step 3: document safe Mode A goal, expected checkpoints/result, and restart proof.
- [x] Step 4: add the secret-free evidence template and pass/fail rules.
- [x] Step 5: add local WorkOS and launch-readiness cross-links.
- [x] Step 6: run the documentation acceptance gates and mark the plan verified.

## Verification Notes

- File/link presence:
  - Result: the runbook exists; local WorkOS and both staging/production residual
    launch gates link to it.
- Relative-link check:
  - Command: a bounded Node check resolved every relative Markdown target in the
    four owned files.
  - Result: `relative links ok: 4 files`.
- Structure and secret review:
  - Result: all seven ordered steps contain expected observations, fail signals,
    and evidence instructions. Sensitive terms appear only in explicit prohibitions
    or placeholder-only commands; no credential value was added.
- Whitespace:
  - Command: `git diff --no-index --check /dev/null <file>` for each owned file.
  - Result: passed for all four files.
- No helper script was added: the existing guarded startup command plus the manual
  presence checks cover this documentation task without creating another secret-
  handling surface.

## Remaining Risks

- The live external journey remains unverified until an operator executes the runbook
  against an approved staging candidate and then the exact production candidate.
- The repository Runner CLI consumes the challenge fields shown beside the QR; it
  does not scan an image. QR rendering plus CLI enrollment is not QR-scanner evidence.
- One successful Workspace dogfood does not prove hostile cross-Workspace isolation,
  public distribution, penetration-test closure, or general availability.
