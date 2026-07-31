# Plan: Empty-workspace Google Calendar connect guide

- Date: 2026-07-31
- Owner: Orca worker `task_f25497f09387`
- Work size: Large
- Status: Verified

## Goal

Make the first-run, empty-Workspace calendar step clearly start the separate Google Calendar OAuth flow, show honest progress and configuration failures, and advance from 0/4 as soon as the completed desktop flow returns synchronized source truth.

## Non-Goals

- Multi-calendar federation or provider selection.
- Runner enrollment, Wiki binding, or Calendar AI behavior.
- Backend OAuth endpoint, response schema, preload API, or persisted source semantics changes.
- Claiming live Google consent success without a configured Google Cloud OAuth client.

## Touched Boundaries

- Backend gateway: Read-only existing authorize/callback/sync contract; no changes planned.
- Backend library: None.
- DB/migrations: None.
- Electron bridge: Existing `calendarOAuth` and `agent-calendar://calendar/google/callback` flow traced and regression-tested; no contract change planned.
- React UI: `App.tsx` and the onboarding guide presentation.
- Tests: Desktop readiness unit tests and the existing AuthKit/Google Calendar Playwright path.
- Docs: This plan and verification/manual-live notes.

## Success Criteria

- [x] An empty Workspace opens on the calendar step with a clear `Google Calendar 연결` CTA and copy that distinguishes Calendar OAuth from Workspace login.
- [x] While desktop OAuth is pending, the guide exposes a visible and accessible browser-approval progress state rather than leaving `연결 필요` unchanged.
- [x] `GOOGLE_OAUTH_NOT_CONFIGURED` remains a truthful, actionable configuration error and a retry starts a fresh OAuth attempt.
- [x] A successful callback/sync immediately applies the sanitized returned Google source, then rehydrates server truth; the guide advances to 1/4 and marks Calendar ready.
- [x] If first sync fails, the guide stays honest at `동기화 필요` with a `지금 동기화` action.
- [x] Targeted unit, typecheck/build, and existing Playwright OAuth regression checks pass.

## Edge Cases

- No secure Workspace session: Electron rejects before opening the browser and the guide shows the login-required error.
- Google OAuth client missing: authorize returns `GOOGLE_OAUTH_NOT_CONFIGURED`; browser is not opened and the guide shows administrator-action copy.
- Forged or stale callback state: callback is rejected without finalizing, while the valid pending callback can still complete.
- Successful grant but failed first sync: source is connected but not ready; the next action is manual sync.
- Hydration latency after callback: the sanitized main-process result updates readiness immediately, while a background hydrate remains the authoritative reconciliation.

## Test Plan

Product behavior tests are changed before product code.

- RED:
  - [x] Extend onboarding readiness coverage for separate-OAuth copy and connected-without-sync recovery.
  - [x] Extend the existing Playwright first-user OAuth path to require pending browser-approval copy and a 1/4 ready state; confirm it fails before implementation.
- GREEN:
  - [x] Add the smallest pending-action presentation and optimistic sanitized-source reconciliation needed to satisfy the tests.
- REFACTOR:
  - [x] Keep OAuth/network policy in Electron and readiness truth in the existing readiness builder; avoid new cross-boundary contracts.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/onboarding-readiness.test.mjs apps/desktop/tests/google-calendar-oauth.test.mjs apps/desktop/tests/agent-calendar-deep-link.test.mjs`
- [x] `npm run typecheck`
- [x] `npm run build:desktop`
- [x] `AGENT_CALENDAR_E2E_TIMEOUT_MS=120000 node apps/desktop/tests/playwright-phase8-google-calendar-oauth.cjs`

Skipped gates:

- Gate: Backend tests / full `npm test`
  - Reason: No backend or shared contract changes; targeted desktop boundary and real Electron Playwright coverage are the proportionate gates.
- Gate: Live Google account consent
  - Reason: Requires a human browser session and configured Google Cloud client; exact manual steps are documented after automated verification.

## Implementation Checklist

- [x] Step 1: Trace the guide readiness, CTA dispatch, Electron OAuth coordinator, callback deep-link routing, IPC exposure, and existing regression tests.
- [x] Step 2: Add failing assertions for clear separate-OAuth copy, pending progress, honest config failure, and 1/4 success readiness.
- [x] Step 3: Implement pending guide presentation and immediate sanitized Google source reconciliation.
- [x] Step 4: Run targeted tests, typecheck/build, and the existing Electron Playwright OAuth flow.
- [x] Step 5: Record verification results, manual live steps, fallback, and remaining risks.

## Acceptance Gates and Fallback

- The change is accepted only if the missing-config retry, forged-state rejection, valid callback, first sync, and 1/4 guide update are observed in the Electron Playwright path.
- If optimistic reconciliation proves inconsistent with server truth, remove only the local source merge; the existing post-callback `hydrate({ blocking: false })` remains the safe fallback.
- No protocol registration, OAuth state validation, token handling, or backend response shape will be loosened.

## Verification Notes

- RED: `node --test apps/desktop/tests/onboarding-readiness.test.mjs`
  - Result: 5 passed / 2 failed for the intended missing separate-OAuth copy and missing `mergeCalendarSourceTruth` behavior.
- GREEN: `node --test apps/desktop/tests/onboarding-readiness.test.mjs`
  - Result: 7 passed / 0 failed.
- Command: `node --test apps/desktop/tests/google-calendar-oauth.test.mjs apps/desktop/tests/agent-calendar-deep-link.test.mjs`
  - Result: 9 passed / 0 failed; strict callback namespace, forged-state rejection, fail-closed configuration, callback, sync, and sanitized public result remain green.
- Command: `npm run typecheck`
  - Result: Passed for renderer and Electron TypeScript projects.
- Command: `npm run build:desktop`
  - Result: Passed; renderer and Electron artifacts built. Vite retained the pre-existing large-chunk warning.
- Command: `AGENT_CALENDAR_E2E_TIMEOUT_MS=120000 node apps/desktop/tests/playwright-phase8-google-calendar-oauth.cjs`
  - Result: `ok: true`, `completeCount: 1`, `googleCalendarOAuth: true`, `restartRestore: true`. The run observed 0/4 empty state, configuration error with zero finalize, retry, forged-state rejection, valid callback, one sync, and 1/4 ready state.
- Visual evidence:
  - `apps/desktop/test-results/phase8-google-calendar-oauth/02-first-run-guide.png`
  - `apps/desktop/test-results/phase8-google-calendar-oauth/03-google-config-error.png`
  - `apps/desktop/test-results/phase8-google-calendar-oauth/04-google-synced-guide.png`

## Live Manual Gate

1. Configure the Google Calendar OAuth client and Calendar API in the target environment, including `agent-calendar://calendar/google/callback` as the desktop redirect expected by the backend contract.
2. Install/run the packaged desktop app so macOS owns the `agent-calendar` scheme; close other development copies that could claim the protocol.
3. Sign in to a new Workspace with AuthKit, confirm the guide starts at 0/4, and click `Google Calendar 연결`.
4. Confirm the CTA changes to browser-approval waiting, approve Calendar access in the browser, and verify focus returns to the desktop app.
5. Confirm the guide shows the successful sync message, Calendar `준비됨`, and 1/4 progress; restart the app and confirm the source remains ready.

## Remaining Risks

- Risk: Live Google consent and redirect ownership depend on external Google Cloud settings and macOS protocol registration.
  - Mitigation: Preserve the strict deep-link parser and document a live manual gate without claiming it was automated.
- Risk: A server may briefly return stale source data after callback.
  - Mitigation: Show the sanitized completed source immediately, then reconcile with the authoritative hydrate request.
