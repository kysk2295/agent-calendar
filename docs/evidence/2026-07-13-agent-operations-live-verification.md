# Agent Operations Live Verification

- Date: 2026-07-13 (Asia/Seoul)
- Railway service: `hermes-os`
- Verified deployment: `72ca034a-bf0e-4a78-9b7a-f80c7fd99bc5`
- Scope: personal single-user Agent Operations with the remote Mac mini Hermes Relay

## Sanitized Runtime Evidence

### Control plane

- Railway deployment status: `SUCCESS`
- Agent Operations daemon: `running=true`, interval `60000ms`, last error `null`
- Mac mini Relay: online
- Preserved QA mission: `paused`
- A paused-mission tick started, completed, blocked, and failed zero tasks.

### Real Hermes work

- Profile: `bizconsultant`
- Planning: one invalid 255-minute proposal was rejected; the bounded retry created research 45, analysis 45, and report 30 minute tasks.
- Research task: completed on attempt 2 after a user Task Session message and resume.
- Research Task Session: 28 strictly ordered events, persisted user message, agent output, artifact, and completion.
- Report task: completed on attempt 1 through the Railway daemon.
- Report: status `ready`, five findings, five evidence rows, five limitations, and four follow-up proposals.
- Follow-up: index 0 recorded as `approved` and remained visible after reload.
- Mission was paused again after verification.

### Security probes

- Unauthenticated `GET /api/relay/snapshot`: HTTP `401`.
- Authenticated profile chat: HTTP `200`, no error event, agent `bizconsultant`, terminal status `completed`.
- Runtime-reported model: `Codex`; the gateway no longer invents `hermes-agent`.
- Synthetic profile output containing a token assignment and a private macOS path: neither value appeared in `delta` or `done.text`; redaction markers were present.
- Backend tests cover direct `run.output` redaction, report redaction, private-path error redaction, constant-time Relay-token comparison, and authenticated snapshot access.

## Local Verification

- Verified deployment `72ca034a-bf0e-4a78-9b7a-f80c7fd99bc5`: 101 backend tests and 74 desktop tests passed at that historical checkpoint.
- Current hardened branch: 122 backend tests and 75 desktop tests passed after projection, concurrency, cancellation, and route hardening.
- `npm run build:desktop`: passed.
- `playwright-agent-operations-mission.cjs`: passed with seven focused Agent Operations refreshes.
- `playwright-agent-task-session.cjs`: passed with four persisted session reads.
- Live Reports UI: report, evidence, approved follow-up, and scheduler-online state rendered with zero console errors.

## Open External Configuration

These are verified facts, not inferred failures:

- Railway `HERMES_TELEGRAM_BOT_TOKEN`: not configured.
- Railway `HERMES_TELEGRAM_ALLOWED_CHAT_IDS`: not configured.
- Consequently the already-created live report has work `status=ready` while its Telegram `deliveryStatus=pending`; new reports on the hardened build use `deliveryStatus=not_configured` instead of remaining ambiguous.
- The Mac mini `bizconsultant` command snapshot still includes `--yolo` and exposes broad toolsets. The gateway now requests `toolsets: [safe]`, `yolo: false`, a six-minute deadline, and sends a remote stop request on timeout. The Mac mini runtime must be updated/configured to enforce that contract before accepting untrusted users or web-derived instructions.

No credentials, auth headers, private paths, raw prompts, or Telegram identifiers are included in this evidence.
