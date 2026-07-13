# Plan: Hermes profile routing for Agent Operations

- Date: 2026-07-13
- Owner: Codex
- Work size: Boundary
- Status: Implemented and live-verified; external Telegram and Mac mini safety configuration pending

## Goal

Route Agent Operations and ordinary Hermes chat to the selected Mac mini Hermes profile without treating the profile ID as an LLM model name. Preserve the API server's own advertised/default model unless an explicit model override is configured.

## Non-Goals

- Do not change the Mac mini Hermes installation or profile files.
- Do not add multi-user profile ownership in this fix.
- Do not execute external messages, purchases, trades, publishing, or source deletion.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/agent-operations-planner.js`, `apps/backend/app/lib/agent-operations-scheduler.js`, `apps/backend/app/lib/relay-chat-completion.js`
- DB/migrations: `apps/backend/app/db/migrations/0006_restore_agent_task_profiles.sql`, `apps/backend/app/db/migrations/0007_restore_agent_task_sessions.sql`
- Electron bridge: none; the existing outbound Mac mini bridge forwards the corrected payload
- React UI: `apps/desktop/src/App.tsx`
- Tests: `apps/backend/tests/agent-operations.test.cjs`, `apps/backend/tests/release-blockers.test.cjs`, `apps/desktop/tests/playwright-agent-operations-mission.cjs`
- Docs: this plan and the personal live-run checklist

## Success Criteria

- [x] A selected agent is sent as `profile`, not as `model`.
- [x] No default `hermes-agent` model is injected when Railway has no explicit `HERMES_API_SERVER_MODEL`.
- [x] An explicit direct API model override is still preserved.
- [x] A real `bizconsultant` plan request returns bounded proposed tasks through the Mac mini Relay.
- [x] One invalid Hermes plan is corrected through a single bounded retry; a second invalid plan still returns `422` without tasks.
- [x] Persisted task ownership remains `bizconsultant` instead of falling back to `default`.
- [x] Task-to-session links survive concurrent Postgres upserts and a Railway restart.
- [x] Agent Operations buttons clear their pending state without waiting for unrelated wiki/mail hydration.
- [x] Hermes profile work can run for up to six minutes without being falsely blocked by the 90-second completion timeout.
- [x] Overlapping daemon ticks cannot execute the same task twice, and one tick starts at most one long-running task.
- [x] A timed-out profile run is not resumable until the remote run is confirmed terminal.
- [x] Reports cannot become ready without at least one usable HTTP(S) evidence row.
- [x] Unknown runtime models are reported as `unknown` instead of an invented model name.
- [x] Desktop requests allow the six-minute profile deadline plus remote cancellation confirmation.

## Edge Cases

- Missing profile: use the existing `default` profile.
- Live but previously unlisted profile: preserve `bizconsultant` and `wikicurator`; do not resurrect removed `marketflow`.
- Existing Agent Operations task: repair only records with `origin=agent` and a non-empty `createdByAgentId`.
- Concurrent task writes: serialize updates per task ID so an older blank `sessionId` cannot win a race.
- Slow unrelated API: refresh Agent Operations independently after its commands.
- Long profile work: use the dedicated six-minute profile timeout for Agent Operations and profile chat.
- Explicit model override: preserve it while also sending the selected profile.
- Relay error: persist a planning error and create no fake task.
- Over-budget plan: ask the same profile to correct it once with the validation reason.
- Overlapping daemon tick: return a skipped result while the active tick owns execution.
- Unconfirmed timeout cancellation: block the task and reject resume until runtime reconciliation.
- Blank or invalid report evidence: reject the report instead of persisting it as ready.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Add assertions that generic Hermes requests use the selected profile mission and omit an invented model.
  - [x] Add assertions that planner and scheduler Relay payloads use `profile` and do not use an agent ID as `model`.
  - [x] Add a failing test for one validation-aware replan after an over-budget result.
- GREEN:
  - [x] Send the corrected payload shape through both chat and Agent Operations paths.
- REFACTOR:
  - [x] Reuse one Relay profile-completion boundary for planning, execution, and ordinary profile chat.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`
- [x] Live generic chat through the Mac mini Relay
- [x] Live Agent Operations plan through `bizconsultant`

추가로 `npm run typecheck`, `npm run build:desktop`, 두 Agent Operations Playwright 시나리오도 통과했다.

## Implementation Checklist

- [x] Step 1: Lock the profile/model contract with failing tests.
- [x] Step 2: Correct generic chat, planning, execution, and Relay metadata payloads.
- [x] Step 3: Run focused and full backend gates.
- [x] Step 4: Deploy Railway and execute the real harmless plan flow.
- [x] Step 5: Add one bounded validation retry for an invalid profile plan.
- [x] Step 6: Align the static profile allowlist with the five live Mac mini profiles.
- [x] Step 7: Migrate existing Agent Operations task ownership without touching user tasks.
- [x] Step 8: Serialize task persistence and restore links from `agent_sessions`.
- [x] Step 9: Make Agent Operations command refresh independent from full app hydration.
- [x] Step 10: Separate long-running profile timeout from short chat completion timeout.
- [x] Step 11: Record runtime evidence and remaining risks.
- [x] Step 12: Serialize daemon ticks and cap each tick to one due task.
- [x] Step 13: Confirm remote cancellation and prevent unsafe resume when confirmation fails.
- [x] Step 14: Require usable report evidence and preserve an honest unknown model state.
- [ ] Step 15: Re-run full backend, desktop, build, deployment, and independent review gates.
- [x] Step 16: Recover an initial launch timeout by idempotency key before deciding cancellation status.
- [x] Step 17: Remove the final stale desktop profile ownership reference.
- [x] Step 18: Normalize direct run and mission launch safety at the Relay boundary.
- [x] Step 19: Make Postgres Agent Task claiming atomic and quarantine orphaned tasks.
- [x] Step 20: Prevent generic task mutation from bypassing Agent Operations state transitions.

## Verification Notes

- Command: live `POST /api/agent-operations/missions/:id/plan`
  - Result: `502 relay_failed`; local Hermes rejected model `bizconsultant`.
- Command: live generic Relay chat with `model=hermes-agent` and `model=gpt-5.5`
  - Result: both returned local Hermes `404 model not found`.
- Command: live `GET /api/state`
  - Result: `profileReadiness` declares `profileParam: profile`; `bizconsultant` is ready and backed by Hermes CLI.
- Command: live Hermes CLI profile run through `runtime.request`
  - Result: `bizconsultant` completed and wrote `{"profile":"bizconsultant","ready":true}` to stdout.
- Command: live Weekly Opportunity Brief plan through the Hermes CLI profile transport
  - Result: transport completed and Task Session preserved 22 ordered events, but the 255-minute plan was rejected against the 120-minute weekly budget.
- Command: validation-aware live replan through `bizconsultant`
  - Result: the second bounded proposal created three tasks totaling 120 minutes: research 45, analysis 45, report 30.
- Command: live task execution, user follow-up, resume, and second scheduler tick
  - Result: task `agent-task-20260713031825-7c8ccdc9` completed on attempt 2; its Task Session contains 28 ordered events, the persisted user message, a non-empty agent result, an artifact, and completion.
- Command: live generic `POST /api/chat/stream` after Railway deployment `b74b3247-2fd9-45f3-807b-0181107247df`
  - Result: HTTP 200, no error event, completed `bizconsultant` run, exact response `bizconsultant profile chat ready`.
- Command: live paused-mission manual tick and repeated Task Session reads
  - Result: zero tasks started; completed attempt remained 2; all 28 event IDs retained strict order and the user message plus completion remained present.
- Command: `npm test`
  - Result: 116 backend and 75 desktop tests passed after the final scheduler, cancellation, idempotency, claim, evidence, and timeout fixes.
- Command: real report task through the enabled Railway daemon
  - Result: one evidence-backed report reached `ready` with five findings and five evidence rows; its first follow-up decision persisted as `approved` and rendered in the Reports tab.
- Command: unauthenticated Relay snapshot and synthetic sensitive profile output probes
  - Result: snapshot returned `401`; the profile chat completed without leaking the synthetic token value or private path.
- Evidence: `docs/evidence/2026-07-13-agent-operations-live-verification.md`

## Remaining Risks

- Risk: Railway has neither `HERMES_TELEGRAM_BOT_TOKEN` nor `HERMES_TELEGRAM_ALLOWED_CHAT_IDS`, so live Telegram delivery cannot occur yet.
  - Mitigation: new reports record `not_configured`; configure both values, then execute a new approved report task.
- Risk: the live Mac mini profile command still includes `--yolo` even though the gateway sends `toolsets: [safe]` and `yolo: false`.
  - Mitigation: do not accept untrusted users; update the Mac mini runtime/profile to enforce the safe toolset and manual approvals before release.
